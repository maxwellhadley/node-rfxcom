var SerialPort = require("serialport"),
    rfxcom = require("./index"),
    EventEmitter = require("events").EventEmitter,
    util = require("util"),
    queue = require("queue");

function RfxCom(device, options) {
    var self = this;

    self.options = options || {};
    self.handlers = {
        0x01: "statusHandler",
        0x02: "messageHandler",
        0x10: "lighting1Handler",
        0x11: "lighting2Handler",
        0x13: "lighting4Handler",
        0x14: "lighting5Handler",
        0x15: "lighting6Handler",
        0x16: "chime1Handler",
        0x19: "blinds1Handler",
        0x20: "security1handler",
        0x4e: "bbq1handler",
        0x4f: "temprain1handler",
        0x50: "temp19Handler",
        0x51: "humidity1Handler",
        0x52: "temphumidity19Handler",
        0x54: "temphumbaro12Handler",
        0x55: "rain16Handler",
        0x56: "wind16Handler",
        0x57: "uv13Handler",
        0x59: "elec1Handler",
        0x5a: "elec23Handler",
        0x5b: "elec4Handler",
        0x5c: "elec5Handler",
        0x5d: "weightHandler",
        0x70: "rfxsensorHandler",
        0x71: "rfxmeterHandler"
    };

    // Running counter for command message sequence numbers.
    self._seqnbr = 0;

    // The transmit message queue
    self.TxQ = queue({concurrency: self.options.concurrency || 3,
                      timeout: self.options.timeout || 10000});
    self.TxQ.on("timeout", function (next, transmission) {
        if (transmission.sender._timeoutHandler.call(transmission.sender, transmission.buffer, transmission.seqnbr) === false) {
            self.debugLog("Error   : Command message " + self.dumpHex([transmission.seqnbr]) +
                ", timed out waiting for response");
            self.emit("response", "Timed out waiting for response", transmission.seqnbr, rfxcom.responseCode.TIMEOUT);
        }
        next();
    });
    // Holds the command acknowledgement callbacks for the transmit queue
    self.acknowledge = new Array(256);
    for (var idx = 0; idx < self.acknowledge.length; idx++) {
        self.acknowledge[idx] = null;
    }

    // Allow for faking out the SerialPort
    if (typeof self.options.port !== "undefined") {
        self.serialport = options.port;
    }

    // Store the device to use
    self.device = device;

    // This is a buffering parser which accumulates message bytes until it receives the number of bytes specified by the
    // first byte of the message + 1. It relies on a flushed buffer, to ensure it starts with the length byte of the
    // first message. The 'data' message emitted contains all the message bytes. Messages may be split across multiple
    // buffers, or a single buffer may contain multiple messages. If a length byte is outside the valid range (4..36)
    // it is assumed synchronisation has been lost and all received data is discarded. The parser attempts to resynchronise
    // at the start of the next buffer.
    self.rfxtrxParser = function() {
        var data = [],
            requiredBytes = 0;
        return function(emitter, buffer) {
            if (self.receiving) {
                data.push.apply(data, buffer);
                while (data.length >= requiredBytes) {
                    if (requiredBytes > 0) {
                        emitter.emit("data", data.slice(0, requiredBytes));
                        data = data.slice(requiredBytes);
                    }
                    if (data.length > 0 && data[0] >= 4 && data[0] <= 36) {
                        requiredBytes = data[0] + 1;
                    } else {
                        requiredBytes = 0;
                        data = [];
                        break;
                    }
                }
            }
        };
    };

    self.readyCallback = null;
    self.on("ready", function() {
        self.reset(function(err) {
            if (err) {
                self.close();
                self.emit("disconnect", err);
            } else {
                self.delay(500);
                self.flush(function (err) {
                    if (err) {
                        self.close();
                        self.emit("disconnect", err);
                    } else {
                        self.receiving = true;
                        self.getStatus(function (err) {
                            if (err) {
                                self.close();
                                self.emit("disconnect", err);
                            }
                        });
                    }
                });
            }
        });
    });

    // This is how long a caller must wait between initialisation attempts
    // It is long enough for the 'ready' event to have been emitted if the
    // previous call to initialise() succeeded
    self.initialiseWaitTime = 6000;
    // Initial state
    self.connected = false;
    self.initialising = false;
    self.receiving = false;
}

util.inherits(RfxCom, EventEmitter);

RfxCom.prototype.debugLog = function (message) {
    if (this.options.debug) {
        console.log("[rfxcom] on " + this.device + " - " + message);
    }

};

RfxCom.prototype.open = function () {
    var self = this;
    // If we weren't supplied a serialport in the constructor, create one
    if (typeof self.serialport === "undefined") {
        // Delay opening the serialport until after the event handlers are installed
        self.serialport = new SerialPort(self.device, {
            baudrate: 38400,
            parser: self.rfxtrxParser(),
            autoOpen: false
        });
    }
    // If the RFXTRX has just been connected, we must wait for at least 5s before any
    // attempt to communicate with it, or it will enter the flash bootloader.
    // We can't know how long it has been connected, so we must always wait!
    self.serialport.on("open", function () {
        self.connected = true;
        self.emit("connecting");
        setTimeout(function () { self.emit("ready") }, self.initialiseWaitTime - 500);
    });

    // Add data read event listener
    self.serialport.on("data", function(data) {
        self.debugLog("Received: " + self.dumpHex(data));
        self.emit("receive", data);

        var length = data[0] + 1,
            packetType = data[1],
            handler = self.handlers[packetType];
        // Avoid calling a handler with the wrong length packet
        if (data.length !== length) {
            self.debugLog("Wrong packet length: " + data.length + " bytes, should be " + length)
        } else {
            if (typeof handler !== "undefined") {
                try {
                    self[handler](data.slice(2));
                } catch (e) {
                    if (e instanceof Error) {
                        self.debugLog("Packet type " + self.dumpHex([packetType]) + " handler threw exception " + e.name + ": " + e.message);
                    }
                }
            } else {
                self.debugLog("Unhandled packet type = " + self.dumpHex([packetType]));
            }
        }
    });

    var disconnectHandler = function(msg) {
        // Either the serial port has gone away so the device no longer exists (ENXIO), or it went
        // away while the event handlers were being installed (Cannot open). In either case
        // destroy the existing serialport and emit our disconnect event so a host application can
        // attempt to reconnect (when the RFXtrx433 is plugged in again)
        self.debugLog(msg);
        var wasConnected = self.connected;
        self.close();
        if (wasConnected) {
            self.emit("disconnect", msg);
        } else {
            self.emit("connectfailed", msg);
        }
    };

    self.serialport.on("error", disconnectHandler);
    // On some platforms (Mac OS X 10.9), we get an error event when the port is disconnected

    self.serialport.on("disconnect", disconnectHandler);
    // On other plaftforms (Debian) we get a serialport disconnect event

    self.serialport.on("end", function() {
        self.debugLog("Received 'end'");
        self.emit("end");
    });

    self.serialport.on("drain", function() {
        self.debugLog("Received 'drain'");
    });

    if (typeof self.serialport.open === "function") {
        self.serialport.open();
    }
};

RfxCom.prototype.close = function () {
    var self = this;

    // Cancel all messages in the queue
    self.TxQ.end();
    self.debugLog("Cleared command message queue");
    if (self.serialport && self.serialport.fd && typeof self.serialport.close === "function") {
        self.serialport.close();
    }
    self.serialport = undefined;
    self.connected = false;
    self.initialising = false;
    self.receiving = false;
};

RfxCom.prototype.messageHandler = function (data) {
    var self = this,
        seqnbr = data[1],
        responses = {
            0: "ACK - transmit OK",
            1: "ACK - transmit delayed",
            2: "NAK - transmitter did not lock onto frequency",
            3: "NAK - AC address not allowed"
        },
        message = data[2];
    if (self.acknowledge[seqnbr] !== undefined && typeof self.acknowledge[seqnbr] === "function") {
        self.acknowledge[seqnbr]();
        self.acknowledge[seqnbr] = null;
    }
    self.debugLog("Response: Command message " + self.dumpHex([seqnbr]) + ", " + responses[message]);
    self.emit("response", responses[message], seqnbr, message);
};

RfxCom.prototype.initialise = function (callback) {
    var self = this;
    if (self.initialising === false) {
        self.initialising = true;
        self.readyCallback = callback || null;
        self.open();
    }
};


/**
 *
 * Called by the data event handler when an Interface Response Message arrives
 * from the device.
 *
 */
RfxCom.prototype.statusHandler = function (data) {
    var self = this,
        receiverTypes = {
            0x50: "310MHz",
            0x51: "315MHz",
            0x52: "433.92MHz receiver only",
            0x53: "433.92MHz transceiver",
            0x55: "868.00MHz",
            0x56: "868.00MHz FSK",
            0x57: "868.30MHz",
            0x58: "868.30MHz FSK",
            0x59: "868.35MHz",
            0x5A: "868.35MHz FSK",
            0x5B: "868.95MHz"
        },
        firmwareTypes = ["Type 1 RO", "Type 1", "Type 2", "Ext", "Ext 2"],
        subtype = data[0],
        seqnbr = data[1],
        cmnd = data[2],
        msg, receiverType, hardwareVersion, firmwareVersion, firmwareType, protocols,
        copyrightText;

    if (subtype === 0xFF) {         // Message not understood!
        if (self.acknowledge[seqnbr] !== undefined && typeof self.acknowledge[seqnbr] === "function") {
            self.acknowledge[seqnbr]();
            self.acknowledge[seqnbr] = null;
        }
        // Handle early firmware versions that don't understand command 0x07 - "start receiver"
        if (self.initialising) {
            self.initialising = false;
            self.TxQ.start();
            self.debugLog("Started command message queue");
        } else {
            self.debugLog("Response: Command message " + self.dumpHex([seqnbr]) +
                ", command unknown or not supported by this device");
            self.emit("response", "Command unknown or not supported by this device", seqnbr, rfxcom.responseCode.UNKNOWN_COMMAND);
        }
    } else if (subtype === 0x07) {  // Start receiver response (should return copyright message)
        copyrightText = String.fromCharCode.apply(String, data.slice(3, 19));
        if (copyrightText === "Copyright RFXCOM") {
            self.debugLog(copyrightText);
            self.initialising = false;
            self.TxQ.start();
            self.debugLog("Started command message queue");
        } else {
            throw new Error("[rfxcom] on " + self.device + " - Invalid response '" + copyrightText +"'");
        }
    } else if (subtype === 0x04 || subtype === 0x03) {  // Handle RFY/ASA list remotes status response
        var params = {
            remoteNumber: data[3],
            remoteType: subtype === 0x03 ? "RFY" : "ASA",
            deviceId: "0x" + self.dumpHex(data.slice(4, 7)).join("") + "/" + data[7],
            idBytes: [data[4], data[5], data[6]],
            unitCode: data[7]
        };
        self.rfyRemotesList.push(params);
    } else if (subtype === 0x01) {  // Unknown RFY remote
        if (self.acknowledge[seqnbr] !== undefined && typeof self.acknowledge[seqnbr] === "function") {
            self.acknowledge[seqnbr]();
            self.acknowledge[seqnbr] = null;
        }
        self.debugLog("Response: Command message " + self.dumpHex([seqnbr]) + ", unknown RFY remote ID");
        self.emit("response", "Unknown RFY remote ID", seqnbr, rfxcom.responseCode.UNKNOWN_REMOTE_ID);
    } else if (subtype === 0x00) {  // Mode command response
        // Firmware version decoding supplied by Bert Weijenberg
        if (data.length > 12) {
            msg = data.slice(2, 19);
            firmwareVersion = msg[2] + 1000;
            firmwareType = msg[10];
        } else {
            msg = data.slice(2, 12);
            firmwareVersion = msg[2];
            if (msg[1] === 0x52 && firmwareVersion < 162) {
                firmwareType = 0;
            } else if (msg[1] === 0x53 && firmwareVersion < 162) {
                firmwareType = 1;
            } else if (msg[1] === 0x53 && firmwareVersion >= 162 && firmwareVersion < 225) {
                firmwareType = 2;
            } else {
                firmwareType = 3;
            }
        }
        receiverType = receiverTypes[msg[1]];
        hardwareVersion = msg[7] + "." + msg[8];
        // Check which protocols are enabled
        protocols = [];
        for (var key in rfxcom.protocols) {
            if (rfxcom.protocols.hasOwnProperty(key)) {
                var value = rfxcom.protocols[key];
                if (msg[value.msg] & value.bit) {
                    protocols.push(key);
                }
            }
        }
        // Now we are ready to go
        self.emit("status", {
            subtype:          subtype,
            seqnbr:           seqnbr,
            cmnd:             cmnd,
            receiverType:     receiverType,
            hardwareVersion:  hardwareVersion,
            firmwareVersion:  firmwareVersion,
            firmwareType:     firmwareTypes[firmwareType],
            enabledProtocols: protocols
        });
        // Send the start receiver command
        self.startRx(function (err) {
            if (err) {
                self.close();
                self.emit("disconnect", err);
            } else {
                if (typeof self.readyCallback === "function") {
                    self.readyCallback();
                }
            }
        });
    }
};

/**
 *
 * Fetches a "command message sequence number" for identifying requests sent to
 * the device.
 *
 */
RfxCom.prototype.getSequenceNumber = function () {
    var self = this;

    if (self._seqnbr > 255) {
        self._seqnbr = 0;
    }
    return self._seqnbr++;
};

/*
 * Send bytes to the serialport - called either directly from sendMessage or from the transmit queue job
 * Log the transmitted bytes to console if debug enabled
 */
RfxCom.prototype.transmit = function (buffer, seqnbr, callback) {
    var self = this;
    if (self.serialport && typeof self.serialport.write === "function") {
        self.serialport.write(buffer, function (err, response) {
            self.debugLog("Sent    : " + self.dumpHex(buffer));
            if (callback && typeof callback === "function") {
                return callback(err, response, seqnbr);
            }
        });
    }
};

/*
 * External function for queueing messages for later transmission
 */
RfxCom.prototype.queueMessage = function (sender, buffer, seqnbr, callback) {
    var self = this;

    if (self.connected) {
        self.debugLog("Queued  : " + self.dumpHex(buffer));
        self.TxQ.push(function () {
                var transmission = function (cb) {
                    self.acknowledge[seqnbr] = cb;
                    self.transmit(buffer, seqnbr, callback);
                };
                transmission.buffer = buffer;
                transmission.seqnbr = seqnbr;
                transmission.sender = sender;
                return transmission;
            }()
        );
        if (self.initialising === false) {
            self.TxQ.start();
        }
    }
};

/*
 *
 * Internal function for sending messages to the device, bypassing the transmit queue
 *
 */
RfxCom.prototype.sendMessage = function (type, subtype, cmd, extra, callback) {
    var self = this,
        seqnbr = this.getSequenceNumber(),
        byteCount = extra.length + 4,
        buffer = [byteCount, type, subtype, seqnbr, cmd];
    buffer = buffer.concat(extra);
    self.transmit(buffer, seqnbr, callback);
    return seqnbr;
};


/**
 *
 * Writes the reset sequence to the RFxtrx433.
 *
 */
RfxCom.prototype.reset = function (callback) {
    var self = this;
    return self.sendMessage(0, 0, 0, [0, 0, 0, 0, 0, 0, 0, 0, 0], callback);
};

/**
 *
 * Calls flush on the underlying SerialPort.
 *
 */
RfxCom.prototype.flush = function (callback) {
    var self = this;
    if (typeof self.serialport.flush === "function") {
        self.serialport.flush(callback);
    }
};


/*
 * Sends the getstatus bytes to the interface.
 */
RfxCom.prototype.getStatus = function (callback) {
    var self = this;
    return self.sendMessage(0, 0, 2, [0, 0, 0, 0, 0, 0, 0, 0, 0], callback);
};

/*
 * Sends the start receiver bytes to the interface.
 */
RfxCom.prototype.startRx = function (callback) {
    var self = this;
    return self.sendMessage(0, 0, 7, [0, 0, 0, 0, 0, 0, 0, 0, 0], callback);
};

/*
 * Enables reception of different protocols.
 */
RfxCom.prototype.enable = function (protocols, callback) {
    var self = this,
        msg = [0x53, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];

    if (!(protocols instanceof Array)) {
        protocols = [protocols];
    }

    protocols.forEach(function(protocol) {
        if (typeof msg[protocol.msg] === "undefined") {
            msg[protocol.msg - 1] = protocol.bit;
        } else {
            msg[protocol.msg - 1] |= protocol.bit;
        }
    });

    return self.sendMessage(0, 0, 0x03, msg, callback);
};


/*
 * Save the enabled protocols of the receiver/transceiver in non-volatile memory
 *
 * Important: Do not send the save command very often because there is a 
 * maximum of 10,000 write cycles to non-volatile memory!
 */
RfxCom.prototype.save = function (callback) {
    var self = this,
        msg = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];

    return self.sendMessage(0, 0, 0x06, msg, callback);
};


/**
 *
 * Wait for at least the specified number of milliseconds.
 *
 * This may not wait precisely for that number of milliseconds due to the
 * vagaries of system scheduling, but no fewer than the specified ms.
 *
 */
// TODO - find out why this is a busy wait
RfxCom.prototype.delay = function (ms) {
    ms += +new Date();
    while (+new Date() < ms) {
        // Do nothing...
    }
};

RfxCom.prototype.dumpHex = function (buffer, prefix) {
    prefix = prefix || "";

    function dec2hex(value) {
        var hexDigits = "0123456789ABCDEF";
        return prefix + (hexDigits[value >> 4] + hexDigits[value & 15]);
    }
    return buffer.map(dec2hex);
};

/**
 *
 * Converts an array of 4 bytes to a 32bit integer.
 *
 */
RfxCom.prototype.bytesToUint32 = function (bytes) {
    return (bytes[3] + 256*(bytes[2] + 256*(bytes[1] + 256*bytes[0])));
};

/**
 *
 * Converts an array of 6 bytes to a 48bit integer.
 *
 */
RfxCom.prototype.bytesToUint48 = function (bytes) {
    return (bytes[5] + 256*(bytes[4] + 256*(bytes[3] + 256*(bytes[2] + 256*(bytes[1] + 256*bytes[0])))));
};

/**
 *
 * Converts a hexadecimal string to an array of bytes and the equivalent value.
 * The returned array is always byteCount long, padded with leading zeros if required
 *
 * e.g. stringToBytes("202020", 4) == {bytes: [0, 32, 32, 32], value: 2105376}
 *
 */
RfxCom.prototype.stringToBytes = function (str, byteCount) {
    var value, residual, result = [];
    value = parseInt(str, 16);
    residual = value;
    while (residual > 0) {
        result.push(residual % 256);
        residual = Math.floor(residual / 256);
    }
    if (byteCount !== undefined) {
        while (result.length < byteCount) {
            result.push(0);
        }
    }
    return { bytes: result.reverse(), value: value };
};

//------------------------------------------
//          DATA PACKET HANDLERS
//------------------------------------------

/**
 *
 * Called by the data event handler when data arrives from a Lighting1
 * light control device (packet type 0x10).
 *
 */
RfxCom.prototype.lighting1Handler = function (data) {
    var self = this,
        commands = {
            0: "Off",
            1: "On",
            2: "Dim",
            3: "Bright",
            5: "All Off",
            6: "All On",
            7: "Chime"
        },
        evt = {
            id: "0x" + self.dumpHex(data.slice(2, 4), false).join(""), // Redundant?
            subtype: data[0],
            seqnbr: data[1],
            housecode: String.fromCharCode(data[2]).toUpperCase(),
            unitcode: data[3],
            commandNumber: data[4],
            command: commands[data[4]] || "Unknown",
            rssi: (data[5] >> 4) & 0xf
        };

    self.emit("lighting1", evt);
};

/**
 *
 * Called by the data event handler when data arrives from a HomeEasy
 * light control device (packet type 0x11).
 *
 */
RfxCom.prototype.lighting2Handler = function (data) {
    var self = this;
    var commands, idBytes, evt;
    commands = {
        0: "Off",
        1: "On",
        2: "Set Level",
        3: "Group Off",
        4: "Group On",
        5: "Set Group Level"
    };
    idBytes = data.slice(2, 6);
    idBytes[0] &= ~0xfc; // "id1 : 2"
    evt = {
        subtype: data[0],
        seqnbr: data[1],
        id: "0x" + self.dumpHex(idBytes, false).join(""),
        unitcode: data[6],
        commandNumber: data[7],
        command: commands[data[7]] || "Unknown",
        level: data[8],
        rssi: (data[9] >> 4) & 0xf
    };

    self.emit("lighting2", evt);
};

/**
 *
 * Called by the data event handler when data arrives from a device using the PT2262 chip (paket type 0x13)
 * This always has a commandNumber of 0, corresponding to the sole supported command 'Data'
 * The actual data encoded by the chip is returned as a hex string in 'data'
 *
 */
RfxCom.prototype.lighting4Handler = function (data) {
    var self = this;
    var evt;
    evt = {
        subtype: data[0],
        seqnbr: data[1],
        data: "0x" + self.dumpHex(data.slice(2, 5), false).join(""),
        commandNumber: 0,
        command: "Data",
        pulseWidth: (256*data[5] + data[6]),
        rssi: (data[7] >> 4) & 0xf
    };
    self.emit("lighting4", evt);
};

/**
 *
 * Called by the data event handler when data arrives from a LightwaveRF/Siemens
 * light control device (packet type 0x14).
 *
 */
RfxCom.prototype.lighting5Handler = function (data) {
    var self = this,
        commands = {
            0: "Off",
            1: "On",
            2: "Group Off",
            3: "Mood1",
            4: "Mood2",
            5: "Mood3",
            6: "Mood4",
            7: "Mood5",
            10: "Unlock Socket",
            11: "Lock Socket",
            12: "All Lock",
            13: "Close",
            14: "Stop",
            15: "Open",
            16: "Set Level"
        },
        evt = {
            subtype: data[0],
            id: "0x" + self.dumpHex(data.slice(2, 5), false).join(""),
            unitcode: data[5],
            commandNumber: data[6],
            command: commands[data[6]] || "Unknown",
            seqnbr: data[1],
            level: data[7],
            rssi: (data[8] >> 4) & 0xf
        };
    self.emit("lighting5", evt);
};

/**
 *
 * Called by the data event handler when data arrives from a Blyss
 * light control device (packet type 0x15)
 *
 */
RfxCom.prototype.lighting6Handler = function (data) {
    var self = this;
    var commands, evt;
    commands = {
        0: "On",
        1: "Off",
        2: "Group On",
        3: "Group Off"
    };
    evt = {
        subtype: data[0],
        seqnbr: data[1],
        id: "0x" + self.dumpHex(data.slice(2, 4), false).join(""),
        groupcode: String.fromCharCode(data[4]).toUpperCase(),
        unitcode: data[5],
        commandNumber: data[6],
        command: commands[data[6]] || "Unknown",
        rssi: (data[9] >> 4) & 0xf
    };
    self.emit("lighting6", evt);
};

/**
 *
 * Called by the data event handler when data arrives from various doorbell pushbuttons
 * (packet type 0x16)
 *
 */
RfxCom.prototype.chime1Handler = function (data) {
    var self = this;
    var commands, evt;
    commands = {
        1: "Tubular 3 notes",
        13: "Tubular 3 notes",
        3: "Big Ben",
        14: "Big Ben",
        5: "Tubular 2 notes",
        6: "Tubular 2 notes",
        9: "Solo",
        2: "Solo"
    };
    evt = {
        subtype: data[0],
        seqnbr: data[1],
        rssi: (data[5] >> 4) & 0xf
    };
    if (evt.subtype === 0) {
        evt.id = "0x" + self.dumpHex(data.slice(3, 4), false).join("");
        evt.commandNumber = data[4];
        evt.command = commands[data[4]];
    } else if (evt.subtype === 1) {
        evt.id = (data[2] & 0x40 ? "0" : "1") + (data[2] & 0x10 ? "0" : "1") +
                 (data[2] & 0x04 ? "0" : "1") + (data[2] & 0x01 ? "0" : "1") +
                 (data[3] & 0x40 ? "0" : "1") + (data[3] & 0x10 ? "0" : "1");
    } else {
        evt.id = "0x" + self.dumpHex(data.slice(2, 5), false).join("");
    }
    self.emit("chime1", evt);
};

/**
 *
 * Called by the data event handler when data arrives from blinds1 remote controllers
 * (packet type 0x19)
 *
 */
RfxCom.prototype.blinds1Handler = function (data) {
    var self = this;
    var commands, evt, startpos;
    commands = {
        0:  "Open",
        1:  "Close",
        2:  "Stop",
        3:  "Confirm",
        4:  "Set limit",
        5:  "Set lower limit",
        6:  "Reverse",
        7:  "Delete limits",
        8:  "Left",
        9:  "Right"
    };
    evt = {
        subtype: data[0],
        seqnbr:  data[1],
        rssi:    (data[7] >> 4) & 0xf,
        commandNumber: data[6],
        command: commands[data[6]] || "Unknown"
    };
    if (evt.subtype === 0x04) {
        if (evt.commandNumber === 7) {
            evt.command = commands[6];
        } else if (evt.commandNumber === 6) {
            evt.command = commands[7];
        }
    }
    startpos = 2;
    if (evt.subtype === 0x00 || evt.subtype === 0x01) {
        startpos = 3;
        evt.unitcode = data[5];
    } else if (evt.subtype === 0x03) {
        if (data[5] === 15) {
            evt.unitcode = 0;
        } else {
            evt.unitcode = data[5] + 1;
        }
    } else {
        evt.unitcode = 1;
    }
    evt.id = "0x" + self.dumpHex(data.slice(startpos, 5), false).join("");
    self.emit("blinds1", evt);
};

/**
 *
 * Called by the data event handler when data arrives from various security
 * devices (packet type 0x20).
 *
 */
RfxCom.prototype.security1handler = function (data) {
    var self = this,
        subtype = data[0],
        seqnbr = data[1],
        id = "0x" + self.dumpHex(data.slice(2, 5), false).join(""),
        deviceStatus = data[5] & ~0x80,
        batterySignalLevel = data[6],
        evt = {
            subtype: subtype,
            id: id,
            seqnbr: seqnbr,
            deviceStatus: deviceStatus,
            batteryLevel: batterySignalLevel & 0x0f,
            rssi: (batterySignalLevel >> 4) & 0xf,
            tampered: data[5] & 0x80
        };
    self.emit("security1", evt);
};

/**
 *
 * Called by the data event handler when data arrives from BBQ temperature
 * sensing devices (packet type 0x4e).
 *
 */
RfxCom.prototype.bbq1handler = function (data) {
        var self = this;
        var evt;
        evt = {
            subtype: data[0],
            id: "0x" + self.dumpHex(data.slice(2, 4), false).join(""),
            seqnbr: data[1],
            temperature: [data[4]*256 + data[5], data[6]*256 + data[7]],
            batteryLevel: data[8] & 0x0f,
            rssi: (data[8] >> 4) & 0xf
        };
        self.emit("bbq1", evt);
};

/**
 *
 * Called by the data event handler when data arrives from temperature
 * and rain sensing devices (packet type 0x4f).
 *
 */
RfxCom.prototype.temprain1handler = function (data) {
        var self = this;
        var temperature, signbit, evt;
        temperature = ((data[4] & 0x7f) * 256 + data[5]) / 10;
        signbit = data[4] & 0x80;
        evt = {
            subtype: data[0],
            id: "0x" + self.dumpHex(data.slice(2, 4), false).join(""),
            seqnbr: data[1],
            temperature: temperature * (signbit ? -1 : 1),
            rainfall: (data[6] * 256 + data[7]) / 10,
            batteryLevel: data[8] & 0x0f,
            rssi: (data[8] >> 4) & 0xf
        };
        self.emit("temprain1", evt);
    };

/**
 *
 * Called by the data event handler when data arrives from temperature
 * sensing devices (packet type 0x50).
 *
 */
RfxCom.prototype.temp19Handler = function (data) {
    var self = this,
        temperature = ((data[4] & 0x7f) * 256 + data[5]) / 10,
        signbit = data[4] & 0x80,
        evt = {
            subtype: data[0],
            id: "0x" + self.dumpHex(data.slice(2, 4), false).join(""),
            seqnbr: data[1],
            temperature: temperature * (signbit ? -1 : 1),
            batteryLevel: data[6] & 0x0f,
            rssi: (data[6] >> 4) & 0xf
        };
    self.emit("temp" + data[0], evt);
};

/**
 *
 * Called by the data event handler when data arrives from humidity sensing
 * devices (packet type 0x51).
 *
 */
RfxCom.prototype.humidity1Handler = function (data) {
    var self = this;
    var evt;
    evt = {
        subtype: data[0],
        id: "0x" + self.dumpHex(data.slice(2, 4), false).join(""),
        seqnbr: data[1],
        humidity: data[4],
        humidityStatus: data[5],
        batteryLevel: data[6] & 0x0f,
        rssi: (data[6] >> 4) & 0xf
    };
    self.emit("humidity1", evt);
};

/**
 *
 * Called by the data event handler when data arrives from temperature & humidty sensing
 * devices (packet type 0x52).
 *
 */
RfxCom.prototype.temphumidity19Handler = function (data) {
    var self = this,
        temperature = ((data[4] & 0x7f) * 256 + data[5]) / 10,
        signbit = data[4] & 0x80,
        evt = {
            subtype: data[0],
            id: "0x" + self.dumpHex(data.slice(2, 4), false).join(""),
            seqnbr: data[1],
            temperature: temperature * (signbit ? -1 : 1),
            humidity: data[6],
            humidityStatus: data[7],
            batteryLevel: data[8] & 0x0f,
            rssi: (data[8] >> 4) & 0xf
        };

    self.emit("th" + data[0], evt);
};

/**
 *
 * Called by the data event handler when data arrives from temperature, humidity and
 * barometric pressure sensing devices (packet type 0x54)
 *
 */
RfxCom.prototype.temphumbaro12Handler = function (data) {
    var self = this,
        temperature = ((data[4] & 0x7f)*256 + data[5])/10,
        signbit = data[4] & 0x80,
        evt = {
            subtype: data[0],
            id: "0x" + self.dumpHex(data.slice(2, 4), false).join(""),
            seqnbr: data[1],
            temperature: temperature * (signbit ? -1 : 1),
            humidity: data[6],
            humidityStatus: data[7],
            barometer: ((data[8] & 0x7f)*256 + data[9]),
            forecast: data[10],
            batteryLevel: data[11] & 0x0f,
            rssi: (data[11] >> 4) & 0xf
        };
    self.emit("thb" + data[0], evt);
};

/**
 *
 * Called by the data event handler when data arrives from rainfall sensing
 * devices (packet type 0x55).
 *
 */
RfxCom.prototype.rain16Handler = function (data) {
        var self = this;
        var evt;
        evt = {
            subtype: data[0],
            id: "0x" + self.dumpHex(data.slice(2, 4), false).join(""),
            seqnbr: data[1],
            batteryLevel: data[9] & 0x0f,
            rssi: (data[9] >> 4) & 0xf
        };
        if (data[0] === 6) {
            evt.rainfallIncrement = (data[8] & 0x0f)*0.266;
        } else {
            evt.rainfall = ((data[6]*256 + data[7])*256 + data[8])/10;
        }
        if (data[0] === 1) {
            evt.rainfallRate = data[4]*256 + data[5];
        } else if (data[0] === 2) {
            evt.rainfallRate = (data[4]*256 + data[5])/100;
        }
        self.emit("rain" + data[0], evt);
    };

/**
 *
 * Called by the data event handler when data arrives from wind speed & direction
 * sensors (packet type 0x56).
 *
 */
RfxCom.prototype.wind16Handler = function (data) {
        var self = this;
        var temperature, signbit, chillFactor, evt;
        evt = {
            subtype:      data[0],
            id:           "0x" + self.dumpHex(data.slice(2, 4), false).join(""),
            seqnbr:       data[1],
            direction:    data[4]*256 + data[5],
            gustSpeed:    (data[8]*256 + data[9])/10,
            batteryLevel: data[14] & 0x0f,
            rssi:         (data[14] >> 4) & 0xf
        };
        if (data[0] !== 5) {
            evt.averageSpeed = (data[6]*256 + data[7])/10;
        }
        if (data[0] === 4) {
            temperature = ((data[10] & 0x7f)*256 + data[11])/10;
            signbit = data[10] & 0x80;
            evt.temperature = temperature*(signbit ? -1 : 1);
            chillFactor = ((data[12] & 0x7f)*256 + data[13])/10;
            signbit = data[12] & 0x80;
            evt.chillfactor = chillFactor*(signbit ? -1 : 1);
        }
        self.emit("wind" + data[0], evt);
    };

/**
 *
 * Called by the data event handler when data arrives from ultraviolet radiation
 * sensors (packet type 0x57).
 *
 */
RfxCom.prototype.uv13Handler = function (data) {
        var self = this;
        var temperature, signbit, evt;
        temperature = ((data[5] & 0x7f)*256 + data[6])/10;
        signbit = data[5] & 0x80;
        evt = {
            subtype: data[0],
            id: "0x" + self.dumpHex(data.slice(2, 4), false).join(""),
            seqnbr: data[1],
            temperature: temperature * (signbit ? -1 : 1),
            uv: data[4]/10,
            batteryLevel: data[7] & 0x0f,
            rssi: (data[7] >> 4) & 0xf
        };
        self.emit("uv" + data[0], evt);
    };

/**
 *
 * Called by the data event handler when data arrives from an OWL CM113 power measurement
 * device (packet type 0x59).
 *
 */
RfxCom.prototype.elec1Handler = function (data) {
    var self = this;
    var evt;
    evt = {
        subtype: data[0],
        seqnbr: data[1],
        id: "0x" + self.dumpHex(data.slice(2, 4), false).join(""),
        count: data[4],
        current: [(data[5]*256 + data[6])/10, (data[7]*256 + data[8])/10, (data[9]*256 + data[10])/10],
        batteryLevel: data[11] & 0x0f,
        rssi: (data[11] >> 4) & 0xf
    };
    self.emit("elec1", evt);
};

/**
 *
 * Called by the data event handler when data arrives from an OWL CM119, CM160 or CM180 power measurement
 * device (packet type 0x5a).
 *
 */
RfxCom.prototype.elec23Handler = function (data) {
    var self = this;
    var evt;
    evt = {
        subtype: data[0],
        seqnbr: data[1],
        id: "0x" + self.dumpHex(data.slice(2, 4), false).join(""),
        count: data[4],
        power: self.bytesToUint32(data.slice(5, 9)),            // units watts
        batteryLevel: data[15] & 0x0f,
        rssi: (data[15] >> 4) & 0xf
    };
    if (evt.subtype === 0x01 || (evt.subtype === 0x02 && evt.count === 0)) {
        evt.energy = self.bytesToUint48(data.slice(9, 15))/223.666;  // units watt-hours
    }
    self.emit("elec" + (data[0] + 1), evt);
};

/**
 *
 * Called by the data event handler when data arrives from an OWL CM180i power measurement
 * device (packet type 0x5b).
 *
 */
RfxCom.prototype.elec4Handler = function (data) {
    var self = this;
    var evt;
    evt = {
        subtype: data[0],
        seqnbr: data[1],
        id: "0x" + self.dumpHex(data.slice(2, 4), false).join(""),
        count: data[4],
        current: [(data[5]*256 + data[6])/10, (data[7]*256 + data[8])/10, (data[9]*256 + data[10])/10],
        batteryLevel: data[17] & 0x0f,
        rssi: (data[17] >> 4) & 0xf
    };
    if (evt.count === 0) {
        evt.energy = self.bytesToUint48(data.slice(11, 17))/223.666;  // units watt-hours
    }
    self.emit("elec4", evt);
};

/**
 *
 * Called by the data event handler when data arrives from a REVOLT power measurement
 * device (packet type 0x5c).
 *
 */
RfxCom.prototype.elec5Handler = function (data) {
    var self = this;
    var evt;
    evt = {
        subtype: data[0],
        seqnbr: data[1],
        id: "0x" + self.dumpHex(data.slice(2, 4), false).join(""),
        voltage: data[4],
        current: (data[5]*256 + data[6])/100,
        power:  (data[7]*256 + data[8])/10,
        energy:  (data[9]*256 + data[10])*10,  // units watt-hours
        powerFactor: data[11]/100,
        frequency: data[12],
        rssi: (data[13] >> 4) & 0xf
    };
    self.emit("elec5", evt);
};

/**
 *
 * Called by the data event handler when data arrives from digital
 * scales (packet type 0x5d).
 *
 */
RfxCom.prototype.weightHandler = function (data) {
    var self = this,
        id = "0x" + self.dumpHex(data.slice(2, 4), false).join(""),
        batterySignalLevel = data[6],
        evt = {
            subtype: data[0],
            id: id,
            seqnbr: data[1],
            weight: (data[4] *256 + data[5]) / 10,
            rssi: batterySignalLevel & 0x0f,
            batteryLevel: (batterySignalLevel >> 4) & 0xf
        };
    self.emit("weight" + evt.subtype, evt);
};

/**
  * Called by the data event handler when data arrives from rfxmeter
  * devices (packet type 0x70).
  *
  */
RfxCom.prototype.rfxsensorHandler = function (data) {
  var self = this,
      subtype = data[0],
      seqnbr = data[1],
      id = "0x" + self.dumpHex([data[2]], false).join(""),
      evt = {
        subtype: subtype,
        id: id,
        seqnbr: seqnbr,
        rssi: (data[5] >> 4) & 0xf
      };

    switch(evt.subtype) {
        case rfxcom.rfxsensor.TEMP:
        var signbit = data[3] & 0x80;
        evt.message =  (((data[3] & 0x7f) * 256 + data[4]) / 100) * (signbit ? -1 : 1);
        break;
        case rfxcom.rfxsensor.VOLTAGE:
        case rfxcom.rfxsensor.AD:
        evt.message = data[3] * 256 + data[4];
        break
    }
    self.emit("rfxsensor", evt);
};

/**
 *
 * Called by the data event handler when data arrives from rfxmeter
 * devices (packet type 0x71).
 *
 */
RfxCom.prototype.rfxmeterHandler = function (data) {
    var self = this,
        id = "0x" + self.dumpHex(data.slice(2, 4), false).join(""),
        counter = self.dumpHex(data.slice(4, 8), false).join(""),
        evt = {
            subtype: data[0],
            id: id,
            seqnbr: data[1],
            counter: parseInt(counter, 16)
        };
    self.emit("rfxmeter", evt);
};

module.exports = RfxCom;

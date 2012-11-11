var rfxcom = require('../lib'),
    matchers = require('./matchers'),
    FakeSerialPort = require('./helper');

  beforeEach(function (){
    this.addMatchers({
      toHaveSent: matchers.toHaveSent
    });
    fakeSerialPort = new FakeSerialPort();
    device = new rfxcom.RfxCom('/dev/ttyUSB0', {
      port: fakeSerialPort
    });
  });

describe('Lighting5 class', function(){
  var lighting5,
      fakeSerialPort,
      device;
  beforeEach(function(){
    this.addMatchers({
      toHaveSent: matchers.toHaveSent
    });
    fakeSerialPort = new FakeSerialPort();
    device = new rfxcom.RfxCom('/dev/ttyUSB0', {
      port: fakeSerialPort
    });
  });
  describe('instantiation', function () {
    it('should throw an error if no subtype is specified', function () {
      expect(function () {
        lighting5 = new rfxcom.Lighting5(device);
      }).toThrow(new Error('Must provide a subtype.'));
    });
  });
  describe('.switchOn', function(){
    beforeEach(function (){
      lighting5 = new rfxcom.Lighting5(device, rfxcom.Lighting5.LIGHTWAVERF);
    });
    it('should send the correct bytes to the serialport', function(done){
      var sentCommandId;
          lighting5.switchOn('0xF09AC8/1', function(err, response, cmdId){
            sentCommandId = cmdId;
            done();
          });
      expect(fakeSerialPort).toHaveSent([10, 20, 0, 0, 0xF0, 0x9A, 0xC8, 1, 1, 0x1f, 0]);
      expect(sentCommandId).toEqual(0);
    });
    it('should throw an exception with an invalid deviceId', function(){
      expect(function(){
        lighting5.switchOn('0xF09AC8');
      }).toThrow(new Error('Invalid deviceId format.'));
    });
    it('should handle mood lighting', function(done){
      lighting5.switchOn('0xF09AC8/1', {
        command: rfxcom.Lighting5.MOOD2
      }, function(){
        done();
      });
      expect(fakeSerialPort).toHaveSent([10, 20, 0, 0, 0xF0, 0x9A, 0xC8, 1, 4, 0x1f, 0]);
    });
    it('should throw an exception with an invalid level value', function(){
      expect(function(){
        lighting5.switchOn('0xF09AC8/1', {
          level: 32
        });
      }).toThrow(new Error('Invalid level value must be in range 1-31.'));
    });
    it('should send the level if one is specified', function(done){
      lighting5.switchOn('0xF09AC8/1', {
        level: 0x14,
      }, function(){
        done();
      });
      expect(fakeSerialPort).toHaveSent([10, 20, 0, 0, 0xF0, 0x9A, 0xC8, 1, 1, 0x14, 0]);
    });
    it('should handle no callback', function(){
      lighting5.switchOn('0xF09AC8/1', {
        level: 0x10
      });
      expect(fakeSerialPort).toHaveSent([10, 20, 0, 0, 0xF0, 0x9A, 0xC8, 1, 1, 0x10, 0]);
    });
  });
  describe('.switchOff', function(){
    beforeEach(function (){
      lighting5 = new rfxcom.Lighting5(device, rfxcom.Lighting5.EMW100);
    });
    it('should send the correct bytes to the serialport', function(done){
      var sentCommandId;
          lighting5.switchOff('0xF09AC8/1', function(err, response, cmdId){
            sentCommandId = cmdId;
            done();
          });
      expect(fakeSerialPort).toHaveSent([10, 20, 1, 0, 0xF0, 0x9A, 0xC8, 1, 0, 0x1f, 0]);
      expect(sentCommandId).toEqual(0);
    });
    it('should handle no callback', function(){
      lighting5.switchOff('0xF09AC8/1');
      expect(fakeSerialPort).toHaveSent([10, 20, 1, 0, 0xF0, 0x9A, 0xC8, 1, 0, 0x1f, 0]);
    });
  });
});


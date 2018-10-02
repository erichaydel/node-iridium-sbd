// Node.js library for Iridium SBD (short burst data)
// v0.0.1 (2012-12-28)
// (C) 2015 Brian Robinson <brian@ndmweb.com>

// Original Source: http://www.veri.fi/iridiumsbd.tar.gz
// (C) 2012 Razvan Dragomirescu <razvan.dragomirescu@veri.fi>

const zlib = require('zlib');
const async = require('async');
const SerialPort = require('serialport');
const EventEmitter = require('events').EventEmitter;
const through2 = require('through2');

// this array contains all possible unsollicited response codes and their
// corresponding handling functions

let iridiumCount = 0;

function createIridium() {
  let df;
  let er;
  let tf;

  let _serialPort;
  const iridiumEvents = new EventEmitter();

  let OK = /^OK\r/;
  let ALL = /.*/;

  const iridium = {
    id: iridiumCount++,
    buffer: '',
    data: '',
    messagePending:0,
    binary: { mode: false, buffer: Buffer.allocUnsafe(512), bufferCounter: 0, waiting: false },
    errors: [
      /ERROR/
    ],
    lock:0,
    pending:0,
    globals: {
      bars:0,
      baudrate: 19200, //serial baudrate for the RockBlock
      debug: 0, //should send extra debug info to the console
      defaultTimeout: 60000, // 60 seconds general timeout for all commands
      simpleTimeout: 2000, // 2 seconds timeout for simple command such as 'echo off' (ATE0)
      timeoutForever: -1,
      maxAttempts: 10, //max attempts to send a message
      port: '/dev/ttyUSB0',
      flowControl: false
    },
    // emit a 'ringalert' event if the SBDRING unsollicited response is received
    sbdring: function() {
      iridiumEvents.emit('ringalert');
    },


    // log if debug enabled
    log: function(message) {
      if(iridium.globals.debug){
        iridiumEvents.emit('debug', message);
      }
    },
    on: function(ev, callback) {
      iridiumEvents.on(ev, callback);
    },
    // interpret the automatic registration result
    areg: function(line) {
      const m = line.match(/^\+AREG:(\d+),(\d+)/);
      const regevent = m[1];
      const regerr = m[2];
      iridium.log('Registration result: ' + regevent + ' with error ' + regerr);
    },

    unsollicited: {
      SBDRING: {
        pattern: /^SBDRING/,
        execute: 'sbdring'
      },
      AREG: {
        pattern: /^\+AREG/,
        execute: 'areg'
      }
    },


    // this is the modem initialization process - echo off, clear all buffers (MO & MT)
    // query registration status (should return 2 = registered)
    // enable ring alert (AT+SBDMTA=1)

    init: function() {
      iridium.batchProcess([
        iridium.echoOff,
        iridium.clearBuffers,
        iridium.enableRegistration,
        iridium.ringAlertEnable,
        iridium.initComplete
      ]);
    },

    batchProcess: function(tasks) {
      async.series(tasks, function(err, results) {
        if (err) {
          iridium.log('Batch process had error: ', err, results);
        }
        else {
          iridium.log('Batch process completed OK', err, results);
        }
      });
    },

    initComplete: function(callback) {
      iridiumEvents.emit('initialized');
      iridium.log('[SBD] IRIDIUM INITIALIZED');
      callback(null);
    },


    sendCompressedMessage: function(text, callback){
      zlib.deflateRaw(Buffer.from(text,'utf-8'), function(err, buffer) {
        if (!err) {
          iridium.log('Text compressed, initial length ' + text.length + ', compressed length ' + buffer.length);
          iridium.c_attempt = 0;
          iridium.mailboxSend(buffer, callback);
        }
      });
    },

    mailboxCheck: function() {
      if (iridium.lock) {
        iridium.pending++;
      } else {
        iridium.sendMessage({ message: '' });
      }
    },

    mailboxSend: function(buffer, callback){
      iridium.c_attempt++;
      if(iridium.c_attempt <= iridium.globals.maxAttempts){
        iridium.lock=1;
        iridium.sendBinaryMessage({ message: buffer }, function(err, momsn) {
          if (err==null) {
            if (buffer) iridium.log('[SBD] Binary message sent successfully, assigned MOMSN ' + momsn);

            // check to see if there are other messages pending - if there are, send a new mailbox check to fetch them in 1 second
            if (iridium.pending>0) setTimeout(function() { iridium.sendMessage({ message: '' }); }, 1000);
            else {
              iridium.lock=0;
            }
            callback(false, momsn);
          }
          else {
            iridium.log('[SBD] Iridium returned error ' + err + ', will retry in 20s');
            setTimeout(function() {
              iridium.mailboxSend(buffer, callback);
            }, 20000);
          }
        });
      }
      else{
        iridium.log('[SBD] Failed to send. The maxAttempts of send requests has been reached.');
        callback({error:'Failed to send. The maxAttempts of send requests has been reached.'});
      }
    },

    sendBinaryMessage: function(state, callback, maxWait) {
      if (maxWait) state.maxWait = maxWait;
      state.binaryMessage = true;

      if (state.message.length == 0) {
        iridium.sendMessage(state, callback, maxWait);
        return;
      }

      const buffer = (Buffer.isBuffer(state.message)) ? state.message : Buffer.from(state.message);

      const command = 'AT+SBDWB=' + buffer.length;

      const ob = Buffer.allocUnsafe(buffer.length + 2);
      let i, sum = 0;
      for (i = 0; i < buffer.length; i++) {
        ob[i] = buffer[i];
        sum += buffer[i];
      }
      ob[buffer.length+1] = sum & 0xff;
      sum >>= 8;
      ob[buffer.length] = sum & 0xff;

      // first write the binary message to storage - issue AT+SBDWB and wait for the modem to say READY
      iridium.AT(command, /READY/, ALL, function(err, text) {

        if (err) {
          iridium.messagePending = 0;
          iridium.clearMOBuffers(function() {
            callback(err);
          });
          return;
        }

        // send the binary message and wait for OK
        iridium.ATS(ob, OK, ALL, function(berr) {
          if (berr) {
            iridium.messagePending = 0;
            iridium.clearMOBuffers(function() {
              callback(berr);
            });
            return;
          }

          iridium.messagePending = 1;
          iridium.waitForNetwork(function(xerr) {
            if (xerr) {
              iridium.messagePending = 0;
              iridium.clearMOBuffers(function() {
                callback(xerr);
              });
              return;
            }
            iridium.messagePending=2;
            iridium.disableSignalMonitoring(function(xcallback) {
              iridium.initiateSession(state, callback);
            });
          }, iridium.globals.maxWait);
        });
      });
    },

    // send a message via SBD and call back when done
    sendMessage: function(state, callback, maxWait) {
      if (maxWait) state.maxWait = maxWait;

      // if no message is given, this is a mailbox check, so clear the MO storage
      const command = state.message ? 'AT+SBDWT=' + state.message : 'AT+SBDD0';

      // write the MO message, wait for network (+CIEV event)
      // disable signal monitoring (+CIER=0) then send the message (+SBDIXA)

      iridium.AT(command, OK, ALL, function(err, text) {
        if (err) {
          iridium.messagePending = 0;
          iridium.clearMOBuffers(function() {
            callback(err);
          });
          return;
        }

        iridium.messagePending = 1;
        iridium.waitForNetwork(function(xerr) {
          if (xerr) {
            iridium.messagePending = 0;
            iridium.clearMOBuffers(function() {
              callback(xerr);
            });
            return;
          }

          iridium.messagePending=2;
          iridium.disableSignalMonitoring(function(xcallback) {
            iridium.initiateSession(state, callback);
          });
        }, maxWait);
      });
    },

    // in binary mode we do not stop at OK or any other regexp, it's all time-based (it reads all available data for bufferTimeout seconds)
    enableBinaryMode: function(bufferTimeout) {
      iridium.binary.mode = true;
      iridium.binary.waiting = true;
      iridium.binary.timeout = new Promise((resolve) => {
        setTimeout(resolve, bufferTimeout);
      });
    },

    // read line by line or a whole binary blob, depending on the mode
    readSBD: through2.obj(function (chunk, enc, cb) {
      if (iridium.binary.mode) {
        if (iridium.binary.waiting) {
          iridium.binary.waiting = false;
          iridium.binary.timeout.then(() => {
            const data = Buffer.allocUnsafe(iridium.binary.bufferCounter);
            iridium.binary.buffer.copy(data);
            this.push(data);
            iridium.binary.bufferCounter = 0;
            iridium.binary.mode = false;
          });
        }
        iridium.binary.bufferCounter += chunk.copy(iridium.binary.buffer, iridium.binary.bufferCounter);
      }
      else {
        // Collect data
        iridium.data += chunk.toString('binary');
        // Split collected data by delimiter
        const parts = iridium.data.split('\n')
        iridium.data = parts.pop();
        parts.forEach((part) => this.push(part));
      }
      cb();
    }),

    close: function (cb) {
      return _serialPort.close(cb);
    },

    // open the serial port
    // config options are: 'debug' (set to 1 to monitor the AT commands and response
    // and 'port' (the actual device to use - defaults to /dev/ttyUSB0)

    open: function(config) {

      if (config) {
        //change globals...
        for (let key in config){
          if(typeof iridium.globals[key] != 'undefined'){ iridium.globals[key] = config[key]; }
          iridium.log('set option: ' + key + ': ' + config[key]);
        }
      }
      _serialPort = new SerialPort(iridium.globals.port, {
        baudRate: iridium.globals.baudrate
      });
      const parser = _serialPort.pipe(iridium.readSBD);

      parser.on('data', function (data) {
        iridium.log('< ' + data);
        if (!er) {
          df(null, data);
          delete(df);
          delete(er);
          return;
        }

        for (x in iridium.unsollicited) {
          if (iridium.unsollicited[x].pattern.test(data)) {
            iridium[iridium.unsollicited[x].execute](data);
            return;
          }
        }

        for (x in iridium.errors) {
          if (iridium.errors[x].test(data)) {
            df(iridium.errors[x], iridium.buffer);
            iridium.buffer = '';
            delete(df);
            delete(er);
            return;
          }
        }


        if (!kr || kr.test(data)) {
          iridium.buffer+=(data + '\n');
        }
        if (er && er.test(data)) {
          df(null, iridium.buffer);
          iridium.buffer='';
          delete(df);
          delete(er);
        }
      });
      _serialPort.on('error', function (error) {
        iridium.log('ERROR: ' + error);
      });

      _serialPort.on('open', function() {
        if(iridium.globals.flowControl){
          iridium.init();
        }
        else {
          iridium.disableFlowControl(iridium.init);
        }
      });
    },

    waitForNetwork: function(callback, maxWait) {
      iridium.ATS('AT+CIER=1,1,0,0', /\+CIEV:0,[^0]/, ALL, callback, maxWait ? maxWait : iridium.globals.timeoutForever);
    },

    getSystemTime: function(callback) {
      iridium.AT('AT+CCLK?', OK, ALL, function(err, result) {
        if (err) callback(err);
        else {
          const m = result.match(/CCLK:(\d+)\/(\d+)\/(\d+),(\d+):(\d+):(\d+)/);
          if (!m) callback('UNKNOWN_TIME');
          else {
            const ctime = new Date(Date.UTC(2000+Number(m[1]), m[2]-1, m[3], m[4], m[5], m[6]));
            callback(null, ctime);
          }

        }
      });
    },

    disableFlowControl: function(callback){
      iridium.log('[SDB] DISABLING FLOW CONTROL');
      iridium.ATS('AT&K0', OK, ALL, callback, iridium.globals.simpleTimeout);
    },

    disableSignalMonitoring: function(callback) {
      iridium.ATS('AT+CIER=0,0,0,0', OK, ALL, callback, iridium.globals.simpleTimeout);
    },
    getSignalQuality: function(callback) {
      iridium.ATS('AT+CSQ', OK, ALL, callback, iridium.globals.simpleTimeout);
    },
    ringAlertEnable: function(callback) {
      iridium.ATS('AT+SBDMTA=1', OK, ALL, callback, iridium.globals.simpleTimeout);
    },

    echoOff: function(callback) {
      iridium.ATS('ATE0', OK, ALL, callback, iridium.globals.simpleTimeout);
    },

    enableRegistration: function(callback) {
      iridium.ATS('AT+SBDAREG=1', OK, ALL, callback, iridium.globals.simpleTimeout);
    },

    clearMOBuffers: function(callback) {
      iridium.ATS('AT+SBDD0', OK, ALL, callback, iridium.globals.simpleTimeout);
    },

    clearMTBuffers: function(callback) {
      iridium.ATS('AT+SBDD1', OK, ALL, callback, iridium.globals.simpleTimeout);
    },

    clearBuffers: function(callback) {
      iridium.ATS('AT+SBDD2', OK, ALL, callback, iridium.globals.simpleTimeout);
    },

    // emit a 'newmessage' event containing the message
    // and the number of queued messages still waiting at the server
    readBinaryMessage: function(mtqueued, callback) {
      iridium.enableBinaryMode(1000);
      iridium.AT('AT+SBDRB', false, false, function(err, buffer) {
        if (err) {
          iridium.clearMTBuffers(function() {
            callback(err);
          });
          return;
        }

        const ib = buffer;
        const messageLength = ib.readUInt16BE(0);
        const messageBuffer = Buffer.allocUnsafe(messageLength);
        ib.copy(messageBuffer, 0, 2, messageLength+2);

        iridium.log('Received message is '+messageBuffer.toString('hex'));
        iridium.binary.mode = false;
        iridium.pending = mtqueued;
        iridiumEvents.emit('newmessage', messageBuffer, mtqueued);
        iridium.clearMTBuffers(callback);
      }, iridium.globals.simpleTimeout);
    },

    // emit a 'newmessage' event containing the message
    // and the number of queued messages still waiting at the server
    readMessage: function(mtqueued, callback) {
    iridium.AT('AT+SBDRT', OK, ALL, function(err, text) {

      if (err) {
        iridium.clearMTBuffers(function() {
          callback(err);
        });
        return;
      }

      const m = text.match(/SBDRT:[^]{2}(.*)/);
      const rmessage = m[1];
      iridium.log('Received message is '+rmessage);
      iridiumEvents.emit('newmessage', rmessage, mtqueued);
      iridium.clearMTBuffers(callback);
    }, iridium.globals.simpleTimeout);
    },


    // most important function, initiates a SBD session and sends/receives messages
    initiateSession: function(state, callback) {
      if (!state.failCount) state.failCount = 0;

      iridium.AT('AT+SBDIX', OK, /\+SBDIX/, function(err, text) {
        if (err) {
          iridium.messagePending = 1;
          iridium.clearMOBuffers(function() {
            callback(err);
          });
          return;
        }
        const m = text.match(/\+SBDIX: (\d+), (\d+), (\d+), (\d+), (\d+), (\d+)/);

        if(m && m.length) {
          const status = m[1];
          const momsn = m[2];
          const mtstatus = m[3];
          const mtmsn = m[4];
          const mtlen = m[5];
          const mtqueued = m[6];
          const maxTries = state.maxTries || 3;

          if (status<=4) {
            iridium.log('MO message transferred successfully');
            iridium.messagePending = 0;
          }
          else if (status==18) {
            iridium.log('MO message failed, radio failure');
            iridium.messagePending = 1;
            iridium.clearMOBuffers(function() {
              if (state.failCount < maxTries) {
                state.failCount++;
                iridium.log(`Retry message: ${state.failCount}/${maxTries}`);
                iridium[state.binaryMessage ? 'sendBinaryMessage' : 'sendMessage'](state, callback, state.maxWait);
              }
              else callback('radio failure');
            });
            return;
          }
          else if (status==32) {
            iridium.log('MO message failed, network failure');
            iridium.messagePending = 1;
            iridium.clearMOBuffers(function() {
              if (state.failCount < maxTries) {
                state.failCount++;
                iridium.log(`Retry message: ${state.failCount}/${maxTries}`);
                iridium[state.binaryMessage ? 'sendBinaryMessage' : 'sendMessage'](state, callback, state.maxWait);
              }
              else callback('network failure');
            });
            return;
          }
          else {
            iridium.log('MO message failed, error '+status);
            iridium.messagePending = 1;
            iridium.clearMOBuffers(function() {
              if (state.failCount < maxTries) {
                state.failCount++;
                iridium.log(`Retry message: ${state.failCount}/${maxTries}`);
                iridium[state.binaryMessage ? 'sendBinaryMessage' : 'sendMessage'](state, callback, state.maxWait);
              }
              else callback('unknown failure');
            });
            return;
          }

          if (mtqueued>0) {
            iridium.log('There are still '+mtqueued+' messages waiting!');
          }

          if (mtstatus==0) {
            iridium.log('No MT messages are pending');
            iridium.finishSession(callback,momsn);
          }
          else if (mtstatus==1) {
            iridium.log('A MT message has been transferred, use AT+SBDRT to read it');

            //disableFlowControl(function(){
            iridium.readBinaryMessage(mtqueued, function() {
              iridium.clearMOBuffers(function(err) {
                callback(err, momsn);
              });
            });
            //});

            return;
          }
          else {
            iridium.log('Error determining MT status: '+mtstatus);
            iridium.finishSession(callback,momsn);
          }
        }
        else {
          iridium.log('Error parsing SBDIX!');
          iridium.finishSession(callback,momsn);
        }
      });
    },

    finishSession: function(callback,momsn){
      iridium.clearMOBuffers(function(err) {
        callback(err, momsn);
      });
    },

    // simplified AT command function - when you don't care about the result
    // the end callback is simply a null function (does nothing)
    ATS: function(command, endregexp, keepregexp, callback, timeout) {
      iridium.AT(command, endregexp, keepregexp, callback, timeout);
    },

    // send an AT command to the modem and call datafunction when complete
    // endregexp is the regular expression that marks the end of the response (usually the string OK)
    // keepregexp tells it to filter the response and keep only the lines that match it
    // datafunction is the function to call when the response is fully received
    AT: function(command, endregexp, keepregexp, datafunction, timeout) {
      er = endregexp; // when to push the completed buffer to the datafunction
      kr = keepregexp; // what lines to keep
      if (tf) clearTimeout(tf); // any new AT command clears the previous command
      delete tf;
      df = function (err, text) {
        if (tf) clearTimeout(tf);
        delete(tf);
        datafunction(err, text); // what to call when ended
      };
      if (!timeout) timeout=iridium.globals.defaultTimeout; // general timeout 60 seconds
      if (timeout>0) tf = setTimeout(function() {
        iridium.log('Sending a timeout event for command '+command);
        datafunction();
      }, timeout);

      if (command instanceof Buffer) {
        iridium.log('[BINARY] > '+command.toString('hex'));
        _serialPort.write(command);
      }
      else {
        iridium.log('> '+command);
        _serialPort.write(command+'\r');
      }
    }
  };
  return iridium;
}

module.exports = createIridium;

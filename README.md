Node.js library for sending and receiving Iridium SBD (Short Burst Data). Created for using with [RockBlock](http://www.rock7.com)  Iridium 9602 modems.


## Installation
```console
$ npm install iridium-sbd
```

## Usage
```javascript
var iridium = require('iridium-sbd');

iridium.open({
  debug: 1, //turn debugging on
  port: "/dev/ttyUSB0",
  flowControl: true //set to false to disable flowControl on the SBD for 3-wire UART setups 
});

iridium.on('initialized', function() {
  console.log(">> [SBD] IRIDIUM INITIALIZED");

  iridium.sendCompressedMessage("Hello world!", function(err,momsn){
    console.log("Message Sent!");
  });
  
});

iridium.on('ringalert', function() {
  console.log(">> [SBD] RING ALERT");
});

iridium.on('newmessage', function(message, queued) {
  console.log("[SBD] Received new message ", message);
});

iridium.on('debug',function(log){
  console.log('>>> '+log);
});


```


## Credits

 - Razvan Dragomirescu's original Iridium SDB node.js library. [http://www.veri.fi/iridiumsbd.tar.gz](http://www.veri.fi/iridiumsbd.tar.gz)
 - Rock Seven - RockBlock (Iridium 9602). [https://www.rock7.com/](https://www.rock7.com/)
 
 
'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.startServer = startServer;

var _net = require('net');

var _utils = require('./utils');

var _logger = require('./logger');

var _logger2 = _interopRequireDefault(_logger);

var _encryptor = require('./encryptor');

var _createUDPRelay = require('./createUDPRelay');

var _createUDPRelay2 = _interopRequireDefault(_createUDPRelay);

var _ip = require('ip');

var _ip2 = _interopRequireDefault(_ip);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

var NAME = 'ssServer';

function createClientToDst(connection, data, password, method, onConnect, isLocalConnected) {
  var dstInfo = (0, _utils.getDstInfo)(data, true);

  var cipher = null;
  var tmp = void 0;
  var cipheredData = void 0;
  var preservedData = null;

  if (!dstInfo) {
    _logger2.default.warn(NAME + ' receive invalid msg. ' + 'local method/password doesn\'t accord with the server\'s?');
    return null;
  }

  var clientOptions = {
    port: dstInfo.dstPort.readUInt16BE(),
    host: dstInfo.atyp === 3 ? dstInfo.dstAddr.toString('ascii') : _ip2.default.toString(dstInfo.dstAddr)
  };

  if (dstInfo.totalLength < data.length) {
    preservedData = data.slice(dstInfo.totalLength);
  }

  var clientToDst = (0, _net.connect)(clientOptions, onConnect);

  clientToDst.on('data', function (clientData) {
    _logger2.default.debug('server received data from DST:' + clientData.toString('ascii'));

    if (!cipher) {
      tmp = (0, _encryptor.createCipher)(password, method, clientData);
      cipher = tmp.cipher;
      cipheredData = tmp.data;
    } else {
      cipheredData = cipher.update(clientData);
    }

    if (isLocalConnected()) {
      (0, _utils.writeOrPause)(clientToDst, connection, cipheredData);
    } else {
      clientToDst.destroy();
    }
  });

  clientToDst.on('drain', function () {
    connection.resumse();
  });

  clientToDst.on('end', function () {
    if (isLocalConnected()) {
      connection.end();
    }
  });

  clientToDst.on('error', function (e) {
    _logger2.default.warn('ssServer error happened when write to DST: ' + e.stack);
  });

  clientToDst.on('close', function (e) {
    if (isLocalConnected()) {
      if (e) {
        connection.destroy();
      } else {
        connection.end();
      }
    }
  });

  return {
    clientToDst: clientToDst, preservedData: preservedData
  };
}

function handleConnection(config, connection) {
  var stage = 0;
  var clientToDst = null;
  var decipher = null;
  var tmp = void 0;
  var data = void 0;
  var localConnected = true;
  var dstConnected = false;

  connection.on('data', function (chunck) {
    try {
      if (!decipher) {
        tmp = (0, _encryptor.createDecipher)(config.password, config.method, chunck);
        decipher = tmp.decipher;
        data = tmp.data;
      } else {
        data = decipher.update(chunck);
      }
    } catch (e) {
      _logger2.default.warn(NAME + ' receive invalid data');
      return;
    }

    switch (stage) {
      case 0:
        _logger2.default.debug('server at stage ' + stage + ' received data: ' + data.toString('hex'));

        // TODO: should pause? or preserve data?
        connection.pause();

        tmp = createClientToDst(connection, data, config.password, config.method, function () {
          dstConnected = true;
          connection.resume();
        }, function () {
          return localConnected;
        });

        if (!tmp) {
          connection.destroy();
          return;
        }

        clientToDst = tmp.clientToDst;

        if (tmp.preservedData) {
          (0, _utils.writeOrPause)(connection, clientToDst, tmp.preservedData);
        }

        stage = 1;
        break;
      case 1:
        _logger2.default.debug('server at stage ' + stage + ' received data: ' + data.toString('ascii'));

        (0, _utils.writeOrPause)(connection, clientToDst, data);

        break;
      default:
        return;
    }
  });

  connection.on('drain', function () {
    clientToDst.resume();
  });

  connection.on('end', function () {
    localConnected = false;

    if (dstConnected) {
      clientToDst.end();
    }
  });

  connection.on('error', function (e) {
    _logger2.default.error('ssServer error happened in the connection with ssLocal : ' + e.message);
  });

  connection.on('close', function (e) {
    localConnected = false;

    if (dstConnected) {
      if (e) {
        clientToDst.destroy();
      } else {
        clientToDst.end();
      }
    }
  });

  setTimeout(function () {
    _logger2.default.warn(NAME + ' connection timeout.');

    if (localConnected) {
      connection.destroy();
    }

    if (dstConnected) {
      clientToDst.destroy();
    }
  }, config.timeout * 1000);
}

function createServer(config) {
  var server = (0, _net.createServer)(handleConnection.bind(null, config)).listen(config.serverPort);
  var udpRelay = (0, _createUDPRelay2.default)(config, true);

  server.on('close', function () {
    _logger2.default.warn(NAME + ' server closed');
  });

  server.on('error', function (e) {
    _logger2.default.error(NAME + ' server error: ' + e.message);
  });

  _logger2.default.verbose(NAME + ' is listening on ' + config.serverAddr + ':' + config.serverPort);

  return {
    server: server, udpRelay: udpRelay
  };
}

function startServer(config) {
  var server = createServer(config);

  return server;
}
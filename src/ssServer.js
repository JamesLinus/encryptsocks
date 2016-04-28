import { createServer as _createServer, connect } from 'net';
import { getConfig, getDstInfo, inetNtoa, writeOrPause, getArgv } from './utils';
import logger, { changeLevel } from './logger';
import { createCipher, createDecipher } from './encryptor';

function flushPreservedData(connection, clientToDst, dataArr) {
  let i = dataArr.length;

  while (i > 0) {
    i--;
    writeOrPause(connection, clientToDst, dataArr[i]);
  }

  dataArr.length = 0;
}

function createClientToDst(connection, data, preservedData, password, method, cb) {
  const dstInfo = getDstInfo(data, true);

  let clientToDst;
  let clientOptions;
  let cipher = null;
  let tmp;

  if (!dstInfo) {
    return null;
  }

  if (dstInfo.totalLength < data.length) {
    preservedData.push(data.slice(dstInfo.totalLength));
  }

  clientOptions = {
    port: dstInfo.dstPort.readUInt16BE(),
    host: (dstInfo.atyp === 3
      ? dstInfo.dstAddr.toString('ascii') : inetNtoa(dstInfo.dstAddr)),
  };

  clientToDst = connect(clientOptions, cb);

  clientToDst.on('data', clientData => {
    logger.debug(`server received data from DST:${clientData.toString('ascii')}`);
    if (!cipher) {
      tmp = createCipher(password, method, clientData);
      cipher = tmp.cipher;
      writeOrPause(clientToDst, connection, tmp.data);
    } else {
      writeOrPause(clientToDst, connection, cipher.update(clientData));
    }
  });

  clientToDst.on('drain', () => {
    connection.resumse();
  });

  clientToDst.on('end', () => {
    connection.end();
  });

  clientToDst.on('error', e => {
    logger.warn(`ssServer error happened when write to DST: ${e.message}`);
    connection.destroy();
  });

  return clientToDst;
}

function handleConnection(config, connection) {
  const preservedData = [];

  let stage = 0;
  let clientToDst = null;
  let decipher = null;
  let tmp;

  connection.on('data', data => {
    if (!decipher) {
      tmp = createDecipher(config.password, config.method, data);
      decipher = tmp.decipher;
      data = tmp.data;
    } else {
      data = decipher.update(data);
    }

    switch (stage) {
      case 0:
        logger.debug(`server at stage ${stage} received data: ${data.toString('hex')}`);

        // TODO: should pause? or preserve data?
        connection.pause();

        clientToDst = createClientToDst(
          connection, data, preservedData,
          config.password, config.method,
          () => {
            connection.resume();
          }
        );

        if (!clientToDst) {
          // TODO: throw
          connection.destroy();
          return;
        }

        flushPreservedData(connection, clientToDst, preservedData);

        stage = 1;
        break;
      case 1:
        logger.debug(`server at stage ${stage} received data: ${data.toString('ascii')}`);

        writeOrPause(connection, clientToDst, data);

        break;
      default:
        return;
    }
  });

  connection.on('drain', () => {
    clientToDst.resume();
  });

  connection.on('end', () => {
    clientToDst.end();
  });

  connection.on('error', e => {
    logger.warn(`ssServer error happened in the connection with ssLocal : ${e.message}`);

    if (clientToDst) {
      connection.destroy();
      clientToDst.destroy();
    }
  });
}

function createServer(config) {
  const server = _createServer(handleConnection.bind(null, config));

  return server;
}

export function startServer() {
  const argv = getArgv();

  const config = getConfig();

  if (argv.level) {
    changeLevel(logger, argv.level);
  }

  // TODO: port occupied
  const server = createServer(config).listen(config.server_port);

  return server;
}

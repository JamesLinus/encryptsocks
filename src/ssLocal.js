import { createServer as _createServer, connect } from 'net';
import {
  getConfig, getDstInfo, writeOrPause, getArgv, getDstStr,
  inetAton,
} from './utils';
import logger, { changeLevel } from './logger';
import { createCipher, createDecipher } from './encryptor';
import { filter } from './filter';
import createUDPRelay from './createUDPRelay';

function handleMethod(connection, data) {
  // +----+----------+----------+
  // |VER | NMETHODS | METHODS  |
  // +----+----------+----------+
  // | 1  |    1     | 1 to 255 |
  // +----+----------+----------+
  const buf = new Buffer(2);

  if (!~data.indexOf(0x00, 2)) {
    logger.warn('unsupported method');
    buf.writeUInt16BE(0x05FF);
    connection.write(buf);
    return -1;
  }

  buf.writeUInt16BE(0x0500);
  logger.debug(`1. TRY TO WRITE: ${buf}`);
  connection.write(buf);

  return 1;
}

function handleRequest(
  connection, data,
  { serverAddr, serverPort, password, method, localAddr, localPort },
  dstInfo, onConnect
) {
  const cmd = data[1];
  // TODO: support domain and ipv6
  const clientOptions = {
    port: serverPort,
    host: serverAddr,
  };
  const isUDPRelay = (cmd === 0x03);

  // TODO: most dst infos are not used
  let repBuf;
  let clientToRemote;
  let tmp = null;
  let decipher = null;
  let decipheredData = null;
  let cipher = null;
  let cipheredData = null;
  let stage = -1;

  if (cmd !== 0x01 && !isUDPRelay) {
    logger.warn(`unsupported cmd: ${cmd}`);
    return {
      stage,
    };
  }

  // prepare data

  // +----+-----+-------+------+----------+----------+
  // |VER | REP |  RSV  | ATYP | BND.ADDR | BND.PORT |
  // +----+-----+-------+------+----------+----------+
  // | 1  |  1  | X'00' |  1   | Variable |    2     |
  // +----+-----+-------+------+----------+----------+

  if (isUDPRelay) {
    repBuf = new Buffer(4);
    repBuf.writeUInt32BE(0x05000001);
    tmp = new Buffer(2);
    tmp.writeUInt16BE(localPort);
    repBuf = Buffer.concat([repBuf, inetAton(localAddr), tmp]);

    logger.debug(`Response to udp association: ${repBuf.toString('hex')}`);
    connection.write(repBuf);

    return {
      stage: 10,
    };
  }

  logger.verbose(`connecting: ${dstInfo.dstAddr.toString('utf8')}:${dstInfo.dstPort.readUInt16BE()}`);

  repBuf = new Buffer(10);
  repBuf.writeUInt32BE(0x05000001);
  repBuf.writeUInt32BE(0x00000000, 4, 4);
  // TODO: should this be 0x0000?
  repBuf.writeUInt16BE(2222, 8, 2);

  tmp = createCipher(password, method,
    data.slice(3)); // skip VER, CMD, RSV
  // logger.warn(data.slice(3).toString('hex'));
  cipher = tmp.cipher;
  cipheredData = tmp.data;

  // connect

  clientToRemote = connect(clientOptions, () => {
    // TODO: no sence?
    onConnect();
  });

  // TODO: should pause until the replay finished
  clientToRemote.on('data', remoteData => {
    // TODO:
    if (!decipher) {
      tmp = createDecipher(password, method, remoteData);
      decipher = tmp.decipher;
      decipheredData = tmp.data;
    } else {
      decipheredData = decipher.update(remoteData);
    }

    logger.debug(`ssLocal received data from remote: ${decipheredData.toString('hex')}`);
    writeOrPause(clientToRemote, connection, decipheredData);
  });

  clientToRemote.on('drain', () => {
    connection.resume();
  });

  clientToRemote.on('end', () => {
    connection.end();
  });

  clientToRemote.on('error', e => {
    logger.warn(`ssLocal error happened in clientToRemote when connecting to ${getDstStr(dstInfo)}: ${e.message}`);
  });

  clientToRemote.on('close', e => {
    if (e) {
      connection.destroy();
    } else {
      connection.end();
    }
  });

  // write
  logger.debug(`2. TRY TO WRITE: ${repBuf.toString('hex')}`);
  connection.write(repBuf);

  // TODO: write before connected
  writeOrPause(connection, clientToRemote, cipheredData);

  return {
    stage: 2,
    cipher,
    clientToRemote,
  };
}

function handleConnection(config, connection) {
  const preservedData = [];

  let stage = 0;
  let clientToRemote;
  let tmp;
  let cipher;
  let dstInfo;
  let remoteConnected = false;

  connection.on('data', data => {
    switch (stage) {
      case 0:
        logger.debug(`ssLocal at stage ${stage} received data from client: ${data.toString('hex')}`);

        stage = handleMethod(connection, data);

        break;
      case 1:
        dstInfo = getDstInfo(data);

        if (!dstInfo) {
          logger.warn(`Failed to get 'dstInfo' from parsing data: ${data}`);
          connection.destroy();
          return;
        }

        // TODO:
        if (!filter(dstInfo)) {
          // TODO: clean everything
          connection.end();
          connection.destroy();
          stage = -1;
          return;
        }

        logger.debug(`ssLocal at stage ${stage} received data from client: ${data.toString('hex')}`);

        tmp = handleRequest(
          connection, data, config, dstInfo,
          () => {
            remoteConnected = true;
          }
        );

        stage = tmp.stage;

        if (stage === 2) {
          clientToRemote = tmp.clientToRemote;
          cipher = tmp.cipher;
        }

        // TODO: should destroy everything for UDP relay?
        break;
      case 2:
        tmp = cipher.update(data);
        logger.debug(`ssLocal at stage ${stage} received data from client and write to remote: ${tmp.toString('hex')}`);

        writeOrPause(connection, clientToRemote, tmp);

        break;
      default:
        return;
    }
  });

  connection.on('drain', () => {
    if (remoteConnected) {
      clientToRemote.resume();
    }
  });

  connection.on('end', () => {
    // TODO: test existence
    if (clientToRemote) {
      clientToRemote.end();
    }
  });

  connection.on('close', e => {
    if (clientToRemote) {
      if (e) {
        clientToRemote.destroy();
      } else {
        clientToRemote.end();
      }
    }
  });

  connection.on('error', e => {
    logger.warn(`ssLocal error happened in client connection: ${e.message}`);
  });

  if (stage === -1) {
    connection.destroy();
  }
}

function createServer(config) {
  const server = _createServer(handleConnection.bind(null, config));
  const udpRelay = createUDPRelay(config, false);

  server.on('close', () => {
    // TODO:
  });

  server.on('error', e => {
    // TODO:
    logger.warn(`ssLocal server error: ${e.message}`);
  });

  server.listen(config.localPort);

  return {
    server, udpRelay,
  };
}

export function startServer() {
  const argv = getArgv();

  const config = getConfig();

  if (argv.level) {
    changeLevel(logger, argv.level);
  }

  // TODO: throw when the port is occupied
  const server = createServer(config);

  return server;
}

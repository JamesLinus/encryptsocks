import ip from 'ip';
import os from 'os';
import { writeFileSync, accessSync, mkdirSync } from 'fs';
import { join } from 'path';

const DEFAULT_PATH = join(__dirname, '../logs/debug.log');
const hasOwnProperty = {}.hasOwnProperty;

let platform = null;

export const BufferFrom = (() => {
  try {
    Buffer.from('aa', 'hex');
  } catch (err) {
    return ((...args) => new Buffer(...args));
  }

  return Buffer.from;
})();

export function isWindows() {
  if (!platform) {
    platform = os.type();
  }

  return platform === 'Windows_NT';
}

export function safelyKill(pid, signal) {
  if (pid === null || pid === undefined) {
    return;
  }

  if (signal && !isWindows()) {
    process.kill(pid, signal);
  } else {
    process.kill(pid);
  }
}

export function safelyKillChild(child, signal) {
  if (!child) {
    return;
  }

  if (signal && !isWindows()) {
    child.kill(signal);
  } else {
    child.kill();
  }
}

export function fileLog(content, path = DEFAULT_PATH) {
  writeFileSync(path, content);
}

// NOTE: https://github.com/winstonjs/winston/issues/228
// Winston will log things asynchronously so we have to
// make sure it has log the error before exiting this
// process.
// And this is disappointing.
export function createSafeAfterHandler(logger, next) {
  let numFlushes = 0;
  let numFlushed = 0;

  return () => {
    Object.keys(logger.transports).forEach((k) => {
      // eslint-disable-next-line
      const stream = logger.transports[k]._stream;
      if (stream) {
        numFlushes += 1;
        stream.once('finish', () => {
          numFlushed += 1;
          if (numFlushes === numFlushed) {
            next();
          }
        });
        stream.end();
      }
    });

    if (numFlushes === 0) {
      next();
    }
  };
}

export function closeSilently(server) {
  if (server) {
    try {
      server.close();
    } catch (e) {
      // already closed
    }
  }
}

export function mkdirIfNotExistSync(path) {
  try {
    accessSync(path);
  } catch (e) {
    mkdirSync(path);
  }
}

export function sendDgram(socket, data, ...args) {
  socket.send(data, 0, data.length, ...args);
}

export function writeOrPause(fromCon, toCon, data) {
  const res = toCon.write(data);

  if (!res) {
    fromCon.pause();
  }

  return res;
}

function parseDstInfo(data, offset) {
  const atyp = data[offset];

  let dstAddr;
  let dstPort;
  let dstAddrLength;
  let dstPortIndex;
  let dstPortEnd;
  // length of non-data field
  let totalLength;

  switch (atyp) {
    case 0x01:
      dstAddrLength = 4;
      dstAddr = data.slice(offset + 1, offset + 5);
      dstPort = data.slice(offset + 5, offset + 7);
      totalLength = offset + 7;
      break;
    case 0x04:
      dstAddrLength = 16;
      dstAddr = data.slice(offset + 1, offset + 17);
      dstPort = data.slice(offset + 17, offset + 19);
      totalLength = offset + 19;
      break;
    case 0x03:
      dstAddrLength = data[offset + 1];
      dstPortIndex = 2 + offset + dstAddrLength;
      dstAddr = data.slice(offset + 2, dstPortIndex);
      dstPortEnd = dstPortIndex + 2;
      dstPort = data.slice(dstPortIndex, dstPortEnd);
      totalLength = dstPortEnd;
      break;
    default:
      return null;
  }

  if (data.length < totalLength) {
    return null;
  }

  return {
    atyp, dstAddrLength, dstAddr, dstPort, totalLength,
  };
}

export function getDstInfo(data, isServer) {
  // +----+-----+-------+------+----------+----------+
  // |VER | CMD |  RSV  | ATYP | DST.ADDR | DST.PORT |
  // +----+-----+-------+------+----------+----------+
  // | 1  |  1  | X'00' |  1   | Variable |    2     |
  // +----+-----+-------+------+----------+----------+
  // Yet begin with ATYP.

  const offset = isServer ? 0 : 3;
  return parseDstInfo(data, offset);
}

export function getDstInfoFromUDPMsg(data, isServer) {
  // +----+------+------+----------+----------+----------+
  // |RSV | FRAG | ATYP | DST.ADDR | DST.PORT |   DATA   |
  // +----+------+------+----------+----------+----------+
  // | 2  |  1   |  1   | Variable |    2     | Variable |
  // +----+------+------+----------+----------+----------+

  const offset = isServer ? 0 : 3;

  return parseDstInfo(data, offset);
}

const formatKeyValues = {
  server: 'serverAddr',
  server_port: 'serverPort',
  local_addr: 'localAddr',
  local_port: 'localPort',
  local_addr_ipv6: 'localAddrIPv6',
  server_addr_ipv6: 'serverAddrIPv6',
};

export function formatConfig(_config) {
  const formattedConfig = Object.assign({}, _config);

  Object.keys(formatKeyValues).forEach((key) => {
    if (hasOwnProperty.call(formattedConfig, key)) {
      formattedConfig[formatKeyValues[key]] = formattedConfig[key];
      delete formattedConfig[key];
    }
  });

  return formattedConfig;
}

export function getDstStr(dstInfo) {
  if (!dstInfo) {
    return null;
  }

  switch (dstInfo.atyp) {
    case 1:
    case 4:
      return `${ip.toString(dstInfo.dstAddr)}:${dstInfo.dstPort.readUInt16BE()}`;
    case 3:
      return `${dstInfo.dstAddr.toString('utf8')}:${dstInfo.dstPort.readUInt16BE()}`;
    default:
      return 'WARN: invalid atyp';
  }
}

export function getPrefixedArgName(name) {
  return name.length === 1 ? `-${name}` : `--${name}`;
}

export function obj2Argv(obj) {
  if (typeof obj !== 'object') {
    throw new Error('expect an object when stringify to argv');
  }

  let argv = '';

  Object.keys(obj).forEach((name) => {
    const argName = getPrefixedArgName(name);
    const value = obj[name];
    let argValue = '';

    if (typeof value === 'boolean') {
      if (!value) {
        return;
      }
    } else {
      argValue = String(value);
    }

    const parts = argValue.length > 0 ? `${argName} ${argValue}` : `${argName}`;

    argv = `${argv} ${parts}`;
  });

  return argv;
}

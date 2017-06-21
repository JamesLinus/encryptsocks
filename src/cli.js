import { version } from '../package.json';
import * as ssLocal from './ssLocal';
import * as ssServer from './ssServer';
import { updateGFWList as _updateGFWList, GFWLIST_FILE_PATH } from './gfwlistUtils';
import { getConfig, DAEMON_COMMAND } from './config';
import { start, stop, restart } from './pm';

const log = console.log; // eslint-disable-line

function getDaemonType(isServer) {
  return isServer ? 'server' : 'local';
}

function logHelp(invalidOption) {
  log(
// eslint-disable-next-line
`
${(invalidOption ? `${invalidOption}\n` : '')}shadowsocks-js ${version}
You can supply configurations via either config file or command line arguments.

Proxy options:
  -c CONFIG_FILE                Path to the config file.
  -s SERVER_ADDR                Server address. default: 0.0.0.0
  -p SERVER_PORT                Server port. default: 8083
  -l LOCAL_ADDR                 Local binding address. default: 127.0.0.1
  -b LOCAL_PORT                 Local port. default: 1080
  -k PASSWORD                   Password.
  -m METHOD                     Encryption method. default: aes-128-cfb
  -t TIMEOUT                    Timeout in seconds. default: 600
  --pac_port PAC_PORT           PAC file server port. default: 8090
  --pac_update_gfwlist [URL]    [localssjs] Update the gfwlist
                                for PAC server. You can specify the
                                request URL.
  --log_path LOG_PATH           The directory path to log. Won't if not set.
  --level LOG_LEVEL             Log level. default: warn
                                example: --level verbose
General options:
  -h, --help                    Show this help message and exit.
  -d start/stop/restart         Run as a daemon.
`
  );
}

function updateGFWList(flag) {
  log('Updating gfwlist...');

  const next = (err) => {
    if (err) {
      throw err;
    } else {
      log(`Updating finished. You can checkout the file here: ${GFWLIST_FILE_PATH}`);
    }
  };

  if (typeof flag === 'string') {
    _updateGFWList(flag, next);
  } else {
    _updateGFWList(next);
  }
}

function runDaemon(isServer, cmd) {
  const type = getDaemonType(isServer);

  switch (cmd) {
    case DAEMON_COMMAND.start: {
      start(type);
      return;
    }
    case DAEMON_COMMAND.stop: {
      stop(type);
      return;
    }
    case DAEMON_COMMAND.restart: {
      restart(type);
      break;
    }
    default:
  }
}

function runSingle(isServer, proxyOptions) {
  const willLogToConsole = true;
  return isServer ? ssServer.startServer(proxyOptions, willLogToConsole)
    : ssLocal.startServer(proxyOptions, willLogToConsole);
}

export default function client(isServer) {
  const argv = process.argv.slice(2);

  getConfig(argv, (err, config) => {
    if (err) {
      throw err;
    }

    const { generalOptions, proxyOptions, invalidOption } = config;

    if (generalOptions.help || invalidOption) {
      logHelp(invalidOption);
    } else if (generalOptions.pacUpdateGFWList) {
      updateGFWList(generalOptions.pacUpdateGFWList);
    } else if (generalOptions.daemon) {
      runDaemon(isServer, generalOptions.daemon);
    } else {
      runSingle(isServer, proxyOptions);
    }
  });
}

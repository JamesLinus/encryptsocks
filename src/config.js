import path from 'path';
import { isV4Format } from 'ip';
import { lookup } from 'dns';
import minimist from 'minimist';
import { readFileSync, accessSync } from 'fs';
import DEFAULT_CONFIG from './defaultConfig';
import fileConfig from '../config.json';
import { getPrefixedArgName } from './utils';

export const DAEMON_COMMAND = {
  start: 'start',
  stop: 'stop',
  restart: 'restart',
};

const PROXY_ARGUMENT_PAIR = {
  c: 'configFilePath',
  s: 'serverAddr',
  p: 'serverPort',
  pac_port: 'pacServerPort',
  l: 'localAddr',
  b: 'localPort',
  k: 'password',
  m: 'method',
  t: 'timeout',
  level: 'level',
  log_path: 'logPath',
  // private
  mem: '_recordMemoryUsage',
};

const PROXY_ARGUMENT_EXTRAL_KEYS = [
  'localAddrIPv6',
  'serverAddrIPv6',
  '_recordMemoryUsage',
];

const GENERAL_ARGUMENT_PAIR = {
  h: 'help',
  help: 'help',
  d: 'daemon',
  pac_update_gfwlist: 'pacUpdateGFWList',
};

function getProxyOptionArgName(optionName) {
  // ignore these keys
  if (PROXY_ARGUMENT_EXTRAL_KEYS.indexOf(optionName) >= 0) {
    return null;
  }

  const result = Object.keys(PROXY_ARGUMENT_PAIR)
    .find(item => PROXY_ARGUMENT_PAIR[item] === optionName);

  if (!result) {
    throw new Error(`invalid optionName: "${optionName}"`);
  }

  return result;
}

export function stringifyProxyOptions(proxyOptions) {
  if (typeof proxyOptions !== 'object') {
    throw new Error('invalid type of "proxyOptions"');
  }

  const args = [];

  Object.keys(proxyOptions).forEach((optionName) => {
    const value = proxyOptions[optionName];
    const argName = getProxyOptionArgName(optionName);

    if (!argName) {
      return;
    }

    args.push(getPrefixedArgName(argName), value);
  });

  return args.join(' ');
}

function getArgvOptions(argv) {
  const generalOptions = {};
  const proxyOptions = {};
  const configPair = minimist(argv);
  const optionsType = [{
    options: proxyOptions,
    keys: Object.keys(PROXY_ARGUMENT_PAIR),
    values: PROXY_ARGUMENT_PAIR,
  }, {
    options: generalOptions,
    keys: Object.keys(GENERAL_ARGUMENT_PAIR),
    values: GENERAL_ARGUMENT_PAIR,
  }];

  let invalidOption = null;

  Object.keys(configPair).forEach((key) => {
    if (key === '_') {
      return;
    }

    let hit = false;

    optionsType.forEach((optType) => {
      const i = optType.keys.indexOf(key);

      if (i >= 0) {
        optType.options[optType.values[optType.keys[i]]] = configPair[key]; // eslint-disable-line
        hit = true;
      }
    });

    if (!hit) {
      invalidOption = key;
    }
  });

  if (invalidOption) {
    invalidOption = (invalidOption.length === 1) ? `-${invalidOption}` : `--${invalidOption}`;
  } else if (generalOptions.daemon
    && Object.keys(DAEMON_COMMAND).indexOf(generalOptions.daemon) < 0) {
    invalidOption = `invalid daemon command: ${generalOptions.daemon}`;
  }

  if (proxyOptions.logPath && !path.isAbsolute(proxyOptions.logPath)) {
    proxyOptions.logPath =
      path.resolve(process.cwd(), proxyOptions.logPath);
  }

  return {
    generalOptions, proxyOptions, invalidOption,
  };
}

function readConfig(_filePath) {
  if (!_filePath) {
    return null;
  }

  const filePath = path.resolve(process.cwd(), _filePath);

  try {
    accessSync(filePath);
  } catch (e) {
    throw new Error(`failed to find config file in: ${filePath}`);
  }

  return JSON.parse(readFileSync(filePath));
}

/**
 * Transform domain && ipv6 to ipv4.
 */
export function resolveServerAddr(config, next) {
  const { serverAddr } = config.proxyOptions;

  if (isV4Format(serverAddr)) {
    next(null, config);
  } else {
    lookup(serverAddr, (err, addresses) => {
      if (err) {
        next(new Error(`failed to resolve 'serverAddr': ${serverAddr}`), config);
      } else {
        // NOTE: mutate data
        config.proxyOptions.serverAddr = addresses; // eslint-disable-line
        next(null, config);
      }
    });
  }
}

export function getDefaultProxyOptions() {
  return Object.assign({}, DEFAULT_CONFIG);
}

export function getConfig(argv = [], arg1, arg2) {
  let doNotResolveIpv6 = arg1;
  let next = arg2;

  if (!arg2) {
    doNotResolveIpv6 = false;
    next = arg1;
  }

  const { generalOptions, proxyOptions, invalidOption } = getArgvOptions(argv);
  const specificFileConfig = readConfig(proxyOptions.configFilePath) || fileConfig;
  const config = {
    generalOptions,
    invalidOption,
    proxyOptions: Object.assign({}, DEFAULT_CONFIG, specificFileConfig, proxyOptions),
  };

  if (doNotResolveIpv6) {
    next(null, config);
    return;
  }

  resolveServerAddr(config, next);
}

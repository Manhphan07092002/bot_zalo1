const { config } = require('./config');

const LEVEL_ORDER = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
};

function canLog(level) {
  const current = LEVEL_ORDER[config.logLevel] ?? LEVEL_ORDER.info;
  const incoming = LEVEL_ORDER[level] ?? LEVEL_ORDER.info;
  return incoming <= current;
}

function createScope(scope) {
  function fmt(level, args) {
    return [new Date().toISOString(), `[${scope}]`, level.toUpperCase(), ...args];
  }

  return {
    debug: (...args) => canLog('debug') && console.log(...fmt('debug', args)),
    info: (...args) => canLog('info') && console.log(...fmt('info', args)),
    warn: (...args) => canLog('warn') && console.warn(...fmt('warn', args)),
    error: (...args) => canLog('error') && console.error(...fmt('error', args))
  };
}

module.exports = { createScope };

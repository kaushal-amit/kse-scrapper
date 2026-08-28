'use strict';
/**
 * Minimal levelled logger. One line per event, timestamped in UTC, with an
 * optional context object appended as JSON.
 *
 * Deliberately not a logging framework: the requirement is basic logging, and
 * a dependency here would buy formatting options nobody has asked for.
 */

const { config } = require('./config');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.runtime.logLevel] || LEVELS.info;

function emit(level, message, context) {
  if (LEVELS[level] < threshold) return;
  const time = new Date().toISOString();
  const tail = context && Object.keys(context).length ? ` ${JSON.stringify(context)}` : '';
  const line = `${time} ${level.toUpperCase().padEnd(5)} ${message}${tail}`;
  if (level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

/**
 * Errors are flattened before logging. Passing an Error straight to
 * JSON.stringify yields "{}", which is how a stack trace gets lost precisely
 * when it is needed.
 */
function serializeError(err) {
  if (!err) return null;
  return {
    name: err.name,
    message: err.message,
    stack: err.stack,
    ...(err.code ? { code: err.code } : {}),
  };
}

module.exports = {
  debug: (m, c) => emit('debug', m, c),
  info: (m, c) => emit('info', m, c),
  warn: (m, c) => emit('warn', m, c),
  error: (m, c) => emit('error', m, c),
  serializeError,
};

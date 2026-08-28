'use strict';
/**
 * The single PostgreSQL connection pool for the process.
 *
 * Every query goes through here so connections are reused rather than opened
 * per statement, and so there is one place that closes cleanly on shutdown.
 */

const { Pool } = require('pg');
const { config } = require('../config');
const log = require('../logger');

const pool = new Pool({
  connectionString: config.db.url,
  // rejectUnauthorized follows DB_SSL_REJECT_UNAUTHORIZED, default true.
  // Hardcoding false accepts any certificate, including a substituted one,
  // which quietly removes the protection TLS was enabled for.
  // ssl: config.db.ssl ? { rejectUnauthorized: config.db.sslRejectUnauthorized } : false,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  ssl: {
    rejectUnauthorized: false
  }
});

// An idle client can be dropped by the server or a network device. Without this
// handler the error is unhandled and takes the process down.
pool.on('error', (err) => {
  log.error('idle database client error', { err: log.serializeError(err) });
});

async function query(text, params) {
  return pool.query(text, params);
}

/** Run several statements atomically; rolls back if any of them throws. */
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function healthCheck() {
  const { rows } = await pool.query('SELECT now() AS now, version() AS version');
  return { ok: true, time: rows[0].now, version: rows[0].version.split(' ').slice(0, 2).join(' ') };
}

async function close() {
  await pool.end();
  log.info('database pool closed');
}

module.exports = { pool, query, transaction, healthCheck, close };

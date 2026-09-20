'use strict';
/**
 * The single PostgreSQL connection pool for the process.
 *
 * Every query goes through here so connections are reused rather than opened
 * per statement, and so there is one place that closes cleanly on shutdown.
 */

const { Pool, types } = require('pg');
const { config } = require('../config');
const log = require('../logger');

const sslMode = require('./sslMode');

/*
 * ─── A `date` COMES BACK AS THE TEXT POSTGRES SENT ─────────────────────────
 *
 * node-postgres parses a bare `date` into a JS Date at LOCAL midnight. On a
 * server in Kuwait, '2026-04-20'::date becomes 2026-04-19T21:00:00Z — and every
 * piece of code that then rendered it with getUTC* or toISOString() read the day
 * BEFORE the one stored.
 *
 * That was live in three places, each with its own consequence:
 *
 *   · src/market/holidays.js — the calendar loaded one day early, so the
 *     scraper skipped a real session (unrecoverable: a session not captured
 *     cannot be re-scraped) and then ran on the actual holiday, spending a
 *     login attempt on a shut terminal and computing a symbol_day from no
 *     captures. Exactly the three-part failure migration 040 exists to prevent,
 *     inverted.
 *   · src/migration/repair.js — collision_days shifted back a day, so `--apply`
 *     DELETED quotes from the uncontested session BEFORE the collision and left
 *     the collision itself untouched. The `trading_date = ANY($3)` clause that
 *     F-11 added to stop the tool destroying sessions that were never in
 *     question became the clause that selected them.
 *   · scripts/fix-tradingview-dates.js — the dry run printed the evidence for
 *     --from one day early, so the operator would bound the repair a day too
 *     wide, shifting a day of correct history.
 *
 * Each was individually fixable, and each fix would have been one more place
 * that has to remember. THE TYPE IS THE PROBLEM: a `date` has no time and no
 * zone, and turning it into an instant is what creates the ambiguity. Postgres
 * sends 'YYYY-MM-DD'; this hands that string through untouched.
 *
 * 1082 is DATE. timestamptz (1184) is deliberately untouched — those ARE
 * instants, and a Date object is the right shape for them.
 *
 * Set here, at the pool, because this module is required by everything that
 * talks to the database and by nothing that does not.
 */
types.setTypeParser(1082, (v) => v);

/*
 * TLS is decided by DB_SSL_MODE, in src/db/sslMode.js, and announced at boot.
 *
 * What was here before was a hardcoded `ssl: { rejectUnauthorized: false }`
 * sitting directly under a commented-out line that read the config — beneath a
 * comment explaining why hardcoding false is wrong. It disabled certificate
 * verification on every connection, AND it forced TLS on even when DB_SSL was
 * false, so the documented default configuration could not connect to the
 * documented default database at all.
 */
const SSL_MODE = sslMode.resolveMode({ warn: (m) => log.warn(m) });
log.info(sslMode.describe(SSL_MODE));

const pool = new Pool({
  connectionString: config.db.url,
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

'use strict';
/**
 * src/kb/thresholds.js — the numbers every gate reads, loaded once.
 *
 * ─── WHY A TABLE AND NOT CONSTANTS ─────────────────────────────────────────
 * A threshold in a source file cannot be changed without a deploy, and one in
 * an env var cannot be changed without a restart. Both have to be edited in a
 * place the person who decided the number cannot reach.
 *
 * Loaded ONCE at boot into a typed object. Not read per query: the fast loop
 * runs every 20 seconds across 8 symbols and would otherwise ask the database
 * for the same 30 numbers 1,440 times a session.
 *
 * ─── THE FALLBACK AND THE ASSERTION DO DIFFERENT JOBS ──────────────────────
 * A missing key falls back to its env var so nothing breaks during the deploy
 * window — but it WARNS, naming the key and the value it used, because a typo
 * in the seed would otherwise leave a gate running on the old number with
 * nothing to say so.
 *
 * The assertion is separate and harder: it checks the known key list against
 * the table and FAILS THE BOOT on a missing row, even where a fallback exists.
 * The fallback covers the deploy; the assertion covers correctness.
 */

const { query } = require('../db/pool');
const log = require('../logger');

/**
 * Every key the code reads, with the env var that covered it before.
 *
 * This list is the assertion. A key added to the code and not to this list is
 * unchecked; a key here and missing from the table fails the boot.
 */
const REQUIRED = {
  bid_age_real_minutes: null,
  bid_age_bait_minutes: null,
  bid_bait_min_qty: null,
  my_pct_min: null,
  my_pct_max: null,
  tick_min_price: null,
  tiny_pct_max: null,
  exit_depth_max_x: null,
  no_protection_qty: null,
  snapshots_min: null,
  volume_vs_yesterday: null,
  ceiling_presence_pct: null,
  parked_max_changes: null,
  frozen_min_qty: null,
  moves_min: null,
  up2_min: null,
  min_position_kd: null,
  max_price_fils: null,
  reserve_pct: null,
  reserve_release_hhmm: null,
  commission_rate: null,
  commission_min_kd: null,

  // The seven that were env vars in signals.js. Their fallbacks are the exact
  // variables that used to hold them, so a half-applied migration keeps the
  // same behaviour rather than a default.
  sig_no_protection_bid: 'SIG_NO_PROTECTION_BID',
  sig_buyers_ratio: 'SIG_BUYERS_RATIO',
  sig_big_qty: 'SIG_BIG_QTY',
  sig_bait_max_age_secs: 'SIG_BAIT_MAX_AGE_SECS',
  sig_tiny_trade_shares: 'SIG_TINY_TRADE_SHARES',
  sig_wall_qty: 'SIG_WALL_QTY',
  wakeup_pace_min: 'WAKEUP_PACE_MIN',
  wakeup_trades_min: 'WAKEUP_TRADES_MIN',
};

let cache = null;

/**
 * Load, warn, assert.
 *
 * `strict` is false for tools that must run against a database predating the
 * seed — a migration cannot depend on the rows a later file inserts.
 */
async function load({ strict = true, quiet = false } = {}) {
  const values = {};
  const missing = [];
  let rows = [];

  try {
    ({ rows } = await query(
      'SELECT key, value FROM kb_threshold WHERE still_true'));
  } catch (err) {
    // The table itself is absent — before migration 031, or the wrong database.
    if (strict) {
      throw new Error(
        `kb_threshold is unreadable: ${err.message}. `
        + 'Run: node src/db/migrate.js --to=<the database this process uses>');
    }
    log.warn('kb_threshold unreadable — every gate will use its env fallback', {
      err: err.message,
    });
  }

  for (const r of rows) values[r.key] = Number(r.value);

  for (const [key, envVar] of Object.entries(REQUIRED)) {
    if (values[key] !== undefined && Number.isFinite(values[key])) continue;

    missing.push(key);
    const fallback = envVar ? process.env[envVar] : undefined;
    if (fallback !== undefined && fallback !== '') {
      values[key] = Number(fallback);
      // Name the key AND the value, so someone reading this can see whether
      // the fallback happens to be right without opening the code.
      log.warn(`kb_threshold: ${key} missing — using ${envVar}=${fallback}`);
    } else {
      log.warn(`kb_threshold: ${key} missing and no fallback exists`);
    }
  }

  if (strict && missing.length) {
    throw new Error(
      `kb_threshold is missing ${missing.length} key(s): ${missing.join(', ')}. `
      + 'A gate reading a fallback is a gate nobody decided. '
      + 'Run: psql <this database> -1 -f sql/kb_seed.sql');
  }

  // A green line that says "I looked" is worth more than silence.
  if (!quiet) {
    console.log(`    kb_threshold: ${Object.keys(REQUIRED).length} keys · `
      + `${missing.length ? `${missing.length} MISSING` : 'all present'}`
      + `  (${rows.length} rows in the table)`);
  }

  cache = values;
  return values;
}

/**
 * The loaded values. Throws rather than returning undefined: a gate silently
 * comparing against undefined evaluates false and never fires, which looks
 * exactly like a quiet market.
 */
function get(key) {
  if (!cache) throw new Error('kb_threshold has not been loaded — call load() at boot');
  const v = cache[key];
  if (v === undefined) throw new Error(`kb_threshold: ${key} was never loaded`);
  return v;
}

/** The whole object, for code that destructures several at once. */
function all() {
  if (!cache) throw new Error('kb_threshold has not been loaded — call load() at boot');
  return cache;
}

/** Tests and the reloader. */
function reset() { cache = null; }
function isLoaded() { return cache !== null; }

module.exports = { load, get, all, reset, isLoaded, REQUIRED };

'use strict';
/**
 * src/market/holidays.js — days the exchange is shut that are not weekends.
 *
 * Loaded once at boot into memory and consulted synchronously, because the
 * callers are clock predicates (`isTradingDay`) that run on every cron tick and
 * cannot be made async without rewriting the scheduler. The calendar changes a
 * few times a year; `reload()` exists for the nightly and for tests.
 *
 * TWO SOURCES, ONE ANSWER.
 *   · spread.trading_day is the BACKEND's, and is authoritative when present —
 *     it is the same table the backend's own session logic reads, so the two
 *     services cannot disagree about whether the market was open.
 *   · public.market_holiday is this repo's own, and is what a scraper-only
 *     database has. A capture service that cannot tell whether the market is
 *     open without the backend's schema is coupled the wrong way round.
 *
 * AN EMPTY CALENDAR IS NOT "NO HOLIDAYS". It is "no calendar", and the boot
 * says so once. The alternative — seeding guessed dates — would silently skip a
 * real session, and a session skipped cannot be re-scraped.
 */

const { query } = require('../db/pool');
const log = require('../logger');

/** Set of 'YYYY-MM-DD'. Empty until load() has run. */
let closed = new Set();
let loaded = false;
let sourceUsed = 'none';

/**
 * 'YYYY-MM-DD' from whatever the row carried.
 *
 * A `date` column now arrives as the text Postgres sent (src/db/pool.js), so
 * the string branch is the one that runs for database rows. The Date branch
 * remains for a caller passing a JS Date — _setForTest, and anything future —
 * and it reads LOCAL components.
 *
 * It read getUTC*, and that was the bug: node-postgres parses a bare `date` at
 * LOCAL midnight, so under TZ=Asia/Kuwait every holiday came back as the day
 * BEFORE the one seeded. The scraper skipped a real session — and a session not
 * captured cannot be re-scraped — then ran on the actual holiday, spending one
 * of the day's two login attempts on a shut terminal.
 */
function dayKey(v) {
  if (!v) return null;
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  return String(v).slice(0, 10);
}

/**
 * Read both calendars and merge them. Never throws: a capture service must not
 * fail to start because a holiday table is missing — it warns and treats the
 * calendar as empty, which is the same behaviour this code had before the table
 * existed at all.
 */
async function load() {
  const days = new Set();
  const sources = [];

  try {
    const { rows } = await query('SELECT holiday_date FROM public.market_holiday');
    for (const r of rows) days.add(dayKey(r.holiday_date));
    if (rows.length) sources.push(`market_holiday(${rows.length})`);
  } catch (err) {
    log.warn('holidays: public.market_holiday could not be read', { err: err.message });
  }

  // The backend's, when its schema is present. Reads of spread.* are allowed
  // across the seam; writes are not.
  try {
    const has = await query("SELECT to_regclass('spread.trading_day') AS t")
      .then((r) => !!r.rows[0].t).catch(() => false);
    if (has) {
      const { rows } = await query(
        "SELECT day FROM spread.trading_day WHERE status <> 'SESSION'");
      for (const r of rows) days.add(dayKey(r.day));
      if (rows.length) sources.push(`spread.trading_day(${rows.length})`);
    }
  } catch (err) {
    // A different column set in the backend's table is not this service's
    // problem to fix, but it IS worth saying out loud rather than silently
    // running on half a calendar.
    log.warn('holidays: spread.trading_day could not be read', { err: err.message });
  }

  closed = days;
  loaded = true;
  sourceUsed = sources.length ? sources.join(' + ') : 'none';

  if (!days.size) {
    log.warn('holidays: NO CALENDAR LOADED — every weekday will be treated as a '
      + 'session. On a closed weekday the AWSAT jobs will spend a login attempt and the '
      + 'nightly computes will write a row built from no captures. '
      + 'Seed public.market_holiday (see migration 040).');
  } else {
    log.info('holidays: calendar loaded', { days: days.size, from: sourceUsed });
  }
  return { days: days.size, from: sourceUsed };
}

const reload = load;

/** Synchronous, for the clock predicates. False when no calendar is loaded. */
function isHoliday(day) {
  const k = dayKey(day);
  return !!k && closed.has(k);
}

function status() {
  return { loaded, days: closed.size, from: sourceUsed, dates: [...closed].sort() };
}

/** Tests inject a calendar rather than standing up a database. */
function _setForTest(dates) {
  closed = new Set((dates || []).map(dayKey));
  loaded = true;
  sourceUsed = 'test';
}

module.exports = { load, reload, isHoliday, status, dayKey, _setForTest };

'use strict';
/**
 * src/db/alarm.js — one way to raise a data_alarm.
 *
 * The INSERT was written out by hand in four places (scheduler, columnCoverage,
 * computeMarketDay, computeSymbolDay), each with its own catch and its own
 * wording for the failure. That is survivable while the shape is stable and
 * expensive the moment it is not — and it was not: for weeks every one of
 * those four inserted into a table THAT DID NOT EXIST. `public.data_alarm` was
 * created by migration 050, this week. Four independent call sites, four
 * independent swallowed errors, and no alarm had ever been raised by the
 * scraper in its life.
 *
 * So the point of this module is not tidiness. It is that there is now ONE
 * place where "could the alarm be written?" is answered, and it can be asked
 * about that one place.
 *
 * ─── IT STILL NEVER THROWS ─────────────────────────────────────────────────
 * An alarm that can break the job it is warning about is worse than no alarm:
 * the nightly derive would fail on a bad day, which is exactly the day its
 * output is needed. It returns false instead, and says so in the log.
 */
const { query } = require('./pool');
const log = require('../logger');

/**
 * @param {object} a
 * @param {string} a.day         trading date
 * @param {string} a.table       the table the alarm is about
 * @param {string} a.alarm       the alarm name, SHOUTED — it is grepped for
 * @param {string|object} a.detail  one sentence a human can act on, or a
 *                                 structured object. `detail` is jsonb, so a
 *                                 bare string is a type error the driver
 *                                 reports as "invalid input syntax for type
 *                                 json" — which the catch below would have
 *                                 swallowed into a log line, exactly as the
 *                                 missing table was swallowed for weeks.
 *                                 Both shapes are encoded here so no caller
 *                                 has to remember.
 * @param {string} [a.column]    the column, when the alarm is about one
 * @returns {Promise<boolean>}   whether the row was written
 */
async function raise({ day, table, alarm, detail, column = null }) {
  try {
    await query(
      `INSERT INTO data_alarm (trading_date, table_name, column_name, alarm, detail)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [day, table, column, alarm, JSON.stringify(
        typeof detail === 'string' ? { what: detail } : detail)]);
    log.warn(`data_alarm: ${alarm}`, { day, table, column, detail });
    return true;
  } catch (e) {
    /*
     * This is the branch that hid the missing table for weeks. It logs at
     * ERROR, not WARN: failing to record an alarm is a worse event than the
     * alarm itself, because it is the one failure that makes every other
     * failure invisible.
     */
    log.error('data_alarm COULD NOT BE WRITTEN — the condition it describes is '
      + 'real and is now recorded nowhere but this line',
    { day, table, column, alarm, error: e.message });
    return false;
  }
}

/**
 * Has this alarm already been raised for this day? Used by detectors that run
 * every minute, so a single condition does not produce 240 rows.
 *
 * A failed read returns TRUE — "already raised" — so a database problem makes
 * the detector quiet rather than making it spam. The opposite choice fills the
 * table during exactly the incident somebody will need to read it.
 */
async function alreadyRaised(day, alarm, { sinceMinutes = null } = {}) {
  try {
    const { rows } = await query(
      `SELECT 1 FROM data_alarm
        WHERE trading_date = $1 AND alarm = $2
          AND ($3::int IS NULL OR raised_at > now() - ($3 || ' minutes')::interval)
        LIMIT 1`, [day, alarm, sinceMinutes]);
    return rows.length > 0;
  } catch (e) {
    log.warn('data_alarm: could not check for an existing row, staying quiet',
      { day, alarm, error: e.message });
    return true;
  }
}

module.exports = { raise, alreadyRaised };

'use strict';
/**
 * ============================================================================
 *  A COLUMN THAT STOPS BEING CAPTURED LOOKS EXACTLY LIKE A COLUMN WITH
 *  NOTHING TO SAY
 * ============================================================================
 * Measured on `kse`, 25 September 2026 — the case this file exists for:
 *
 *   awsat_market_quotes.last_trade_time   26 Aug: 27,608 of 27,608  (100%)
 *                                         30 Aug:      0 of 35,840  (0%)
 *   awsat_market_quotes.last_trade_date   same day, same collapse
 *
 * Both are the EXCHANGE'S OWN trade timestamp — not our capture time — and
 * both have been empty on every row since. 737,218 rows in September, not one
 * of them carrying either field, for four weeks, with nothing anywhere saying
 * so. The cause was the cutover from `awsat_server` to `awsat_client` on 30
 * August: the client path hardcodes last_trade_date to null and reads
 * last_trade_time from a key the page does not appear to supply.
 *
 * Nobody noticed because NULL is the honest value for "this symbol has not
 * traded yet today", so a dead column and a quiet one are the same shape. The
 * only thing that tells them apart is YESTERDAY: a column that was 100%
 * populated on the last session and 0% on this one has not gone quiet, it has
 * stopped.
 *
 * ─── WHAT IT DOES NOT DO ───────────────────────────────────────────────────
 * It does not compare against a hand-written list of columns that "should" be
 * populated. Such a list is written once, is wrong the first time a column is
 * legitimately retired, and nobody updates it. The previous session IS the
 * expectation, and it updates itself.
 *
 * It does not fire on a column that was already empty yesterday: that is a
 * standing condition, not news, and re-reporting it every night is how an
 * alarm gets muted. The alarm is for the TRANSITION.
 *
 * It does not fire on a small drop. A field that is 86% populated one day and
 * 71% the next is the market, not the capture. The threshold is a collapse
 * from populated to effectively nothing.
 * ============================================================================
 */
const { query } = require('../db/pool');
const log = require('../logger');

/**
 * Tables worth watching, and why each one.
 *
 * Only tables the CAPTURE writes: a derived table going empty is the job's own
 * failure and its job reports that itself. This is about the feed.
 */
const WATCHED = ['awsat_market_quotes', 'awsat_stock_depth', 'awsat_order_obs'];

/** Populated yesterday and effectively gone today. */
const WAS_POPULATED_PCT = 50;   // at least half the rows had it
const NOW_EMPTY_PCT = 1;        // and now under one percent do

/** Columns whose NULLs are structural rather than informative. */
const SKIP = new Set(['id', 'created_at', 'updated_at', 'observed_at',
  'first_seen_at', 'last_seen_at', 'trading_date', 'run_id']);

async function columnsOf(table) {
  const { rows } = await query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position;`, [table]);
  return rows.map((r) => r.column_name).filter((c) => !SKIP.has(c));
}

/** The session before `day` that actually produced rows in this table. */
async function previousSessionWithRows(table, day) {
  const { rows } = await query(
    `SELECT trading_date FROM public.${table}
      WHERE trading_date < $1
      GROUP BY trading_date HAVING count(*) > 0
      ORDER BY trading_date DESC LIMIT 1;`, [day]);
  return rows.length ? rows[0].trading_date : null;
}

/**
 * Per-column populated percentage for one day, in ONE query rather than one
 * per column — 30 columns x 2 days is 60 scans of a 1.7M-row table otherwise.
 */
async function coverage(table, day, cols) {
  if (!cols.length) return { total: 0, pct: new Map() };
  const parts = cols.map((c) => `count("${c}")::numeric AS "${c}"`).join(', ');
  const { rows } = await query(
    `SELECT count(*)::numeric AS total, ${parts} FROM public.${table} WHERE trading_date = $1;`,
    [day]);
  const r = rows[0];
  const total = Number(r.total);
  const pct = new Map();
  if (total > 0) for (const c of cols) pct.set(c, (100 * Number(r[c])) / total);
  return { total, pct };
}

/**
 * Compare `day` against the previous session that had rows, and alarm on any
 * column that went from populated to empty. Returns the collapses found.
 */
async function check(day, { db = { query } } = {}) {
  const found = [];
  for (const table of WATCHED) {
    /* eslint-disable no-await-in-loop */
    const cols = await columnsOf(table);
    if (!cols.length) continue;

    const prevDay = await previousSessionWithRows(table, day);
    if (!prevDay) continue;

    const today = await coverage(table, day, cols);
    const prev = await coverage(table, prevDay, cols);
    // No rows today is a capture outage, not a column problem, and the feed
    // alarm owns that. Saying it again here would be a second voice for one
    // fact.
    if (!today.total || !prev.total) continue;

    for (const c of cols) {
      const was = prev.pct.get(c);
      const now = today.pct.get(c);
      if (was === undefined || now === undefined) continue;
      if (was < WAS_POPULATED_PCT || now >= NOW_EMPTY_PCT) continue;

      const hit = { table, column: c, day, prevDay,
        wasPct: Math.round(was * 10) / 10, nowPct: Math.round(now * 10) / 10,
        rowsToday: today.total };
      found.push(hit);

      const msg = `${table}.${c} was ${hit.wasPct}% populated on ${prevDay} and is `
        + `${hit.nowPct}% on ${day} across ${today.total} rows. `
        + 'A column that STOPS being captured looks exactly like a column with nothing to '
        + 'say — NULL is the honest value for "has not traded yet", so only yesterday can '
        + 'tell them apart. Measured precedent: last_trade_time and last_trade_date went '
        + '100% to 0% on 30 August 2026 at the awsat_server -> awsat_client cutover and '
        + 'stayed empty for four weeks with nothing saying so.';
      log.error('column coverage collapsed', hit);
      await db.query(
        `INSERT INTO data_alarm (trading_date, table_name, column_name, alarm, detail)
         VALUES ($1, $2, $3, 'COLUMN_COVERAGE_COLLAPSED', $4)
         ON CONFLICT DO NOTHING`,
        [day, table, c, JSON.stringify({ ...hit, what: msg })]).catch((e) => {
        // Best-effort, like every other alarm here: losing it must not lose the
        // day's compute.
        log.warn('column coverage: could not write the data_alarm row', { day, table, column: c, error: e.message });
      });
      /* eslint-enable no-await-in-loop */
    }
  }
  if (!found.length) log.info('column coverage: no collapse', { day, tables: WATCHED.length });
  return found;
}

module.exports = { check, WATCHED, WAS_POPULATED_PCT, NOW_EMPTY_PCT, SKIP };

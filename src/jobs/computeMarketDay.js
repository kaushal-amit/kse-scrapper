'use strict';
/**
 * src/jobs/computeMarketDay.js — one row per session.
 *
 *   npm run run:once -- daily.marketday --date=2026-08-25
 *
 * Reads symbol_day, so it must run AFTER daily.symbolday for the same date.
 * Idempotent: re-running corrects the row rather than duplicating it.
 *
 * ─── WHY IT REFUSES RATHER THAN COMPUTES ZEROS ─────────────────────────────
 * With no symbol_day rows every count is zero, which stores as a perfectly
 * valid-looking flat market: 0 advancing, 0 declining, regime RISK_OFF. Nothing
 * downstream could tell that from a real session where nothing rose.
 *
 * A row of zeros reading as a flat market is exactly the silent wrong number
 * this rebuild exists to prevent, so the absence of input is an error.
 */

const { query } = require('../db/pool');
const clock = require('../market/clock');
const log = require('../logger');
const M = require('./marketDayMetrics');

const COLUMNS = [
  'trading_date',
  'symbols_traded', 'advancing', 'declining', 'unchanged',
  'pct_advancing', 'pct_advancing_ratio', 'breadth_5d_avg', 'thin_symbols',
  'avg_pct_change', 'median_pct_change', 'pct_change_p10', 'pct_change_p90',
  'total_volume', 'total_trades', 'volume_vs_20d', 'symbols_over_3x_daily',
  'new_symbols', 'suspended_symbols', 'renamed_symbols', 'cb_events_total',
  'regime', 'computed_at',
];

/** Every symbol_day row for the session. */
async function loadDay(day) {
  const { rows } = await query(
    `SELECT symbol, chg_fils, chg_1d, trades, total_volume, data_quality
       FROM symbol_day WHERE trading_date = $1`, [day]);
  return rows;
}

/**
 * Each symbol's average trade count over its previous sessions.
 *
 * Five sessions, ending before today — today's own count must not be inside
 * its own baseline or every symbol looks normal.
 */
async function trailingTrades(day, sessions = 5) {
  const { rows } = await query(`
    WITH recent AS (
      SELECT symbol, trades,
             row_number() OVER (PARTITION BY symbol ORDER BY trading_date DESC) AS rn
        FROM symbol_day
       WHERE trading_date < $1 AND trades IS NOT NULL
    )
    SELECT symbol, avg(trades)::numeric AS avg_trades
      FROM recent WHERE rn <= $2 GROUP BY symbol`, [day, sessions]);

  const out = new Map();
  for (const r of rows) out.set(r.symbol, Number(r.avg_trades));
  return out;
}

/** Prior sessions' market totals, oldest first, for the rolling windows. */
async function priorSessions(day, limit = 30) {
  const { rows } = await query(
    `SELECT trading_date, total_volume, pct_advancing
       FROM market_day WHERE trading_date < $1
       ORDER BY trading_date DESC LIMIT $2`, [day, limit]);
  return rows.reverse();
}

/**
 * Symbols appearing in symbol_day for the FIRST TIME EVER.
 *
 * Not "first in the backfill window" — a symbol present in July is not new in
 * August, and counting it so would report listings that never happened.
 */
async function newSymbols(day) {
  const { rows } = await query(`
    SELECT count(*)::int AS c FROM (
      SELECT symbol FROM symbol_day WHERE trading_date = $1
      EXCEPT
      SELECT symbol FROM symbol_day WHERE trading_date < $1) g`, [day]);
  return rows[0].c;
}

/**
 * Symbols present in the previous session and absent today.
 *
 * Compared against the previous session WITH DATA, never yesterday's date —
 * with 19, 20 and 23 August missing, a date comparison would report every
 * symbol as suspended on the 24th.
 */
async function suspendedSymbols(day) {
  const { rows: prev } = await query(
    'SELECT max(trading_date) AS d FROM symbol_day WHERE trading_date < $1', [day]);
  if (!prev[0].d) return null;
  const { rows } = await query(`
    SELECT count(*)::int AS c FROM (
      SELECT symbol FROM symbol_day WHERE trading_date = $1
      EXCEPT
      SELECT symbol FROM symbol_day WHERE trading_date = $2) g`, [prev[0].d, day]);
  return rows[0].c;
}

async function compute(tradingDay, runId) {
  const day = tradingDay || clock.tradingDay();

  await require('../db/preflight').check('market_day compute', {
    market_day: ['thin_symbols', 'pct_advancing_ratio', 'symbols_over_3x_daily',
      'pct_advancing', 'regime'],
    symbol_day: ['chg_fils', 'chg_1d', 'trades', 'total_volume', 'data_quality'],
  });

  const rows = await loadDay(day);
  if (!rows.length) {
    throw new Error(
      `symbol_day has no rows for ${day}. market_day reads it, and computing `
      + 'from nothing would store zeros that read as a flat market. '
      + `Run: npm run run:once -- daily.symbolday --date=${day}`);
  }

  const b = M.breadth(rows);
  const dist = M.moveDistribution(rows);
  const act = M.activity(rows);

  const trailing = await trailingTrades(day);
  const prior = await priorSessions(day);

  const row = {
    trading_date: day,
    ...b,
    ...dist,
    ...act,
    breadth_5d_avg: M.breadth5dAvg(
      b.pct_advancing, prior.map((p) => (p.pct_advancing === null ? null : Number(p.pct_advancing)))),
    volume_vs_20d: M.volumeVs20d(
      act.total_volume,
      prior.map((p) => Number(p.total_volume)).filter((v) => Number.isFinite(v))),
    symbols_over_3x_daily: M.over3xDaily(rows, trailing),
    new_symbols: await newSymbols(day),
    suspended_symbols: await suspendedSymbols(day),
    // Needs instruments.code and the old symbol's last session. KPPC->PHC is
    // the only case and it is historical; left NULL until a rename happens.
    renamed_symbols: null,
    // symbol_day.cb_events is NULL — no circuit-breaker detection exists yet.
    cb_events_total: null,
    regime: M.regimeOf(b.pct_advancing),
    computed_at: new Date(),
  };
  // breadth() returns no_prev_close for reporting; market_day has no column.
  delete row.no_prev_close;

  const values = COLUMNS.map((c) => (row[c] === undefined ? null : row[c]));
  await query(
    `INSERT INTO market_day (${COLUMNS.join(', ')})
     VALUES (${COLUMNS.map((_, i) => `$${i + 1}`).join(', ')})
     ON CONFLICT (trading_date) DO UPDATE SET
       ${COLUMNS.filter((c) => c !== 'trading_date').map((c) => `${c} = EXCLUDED.${c}`).join(', ')}`,
    values);

  log.info('market_day: written', {
    day,
    symbols: b.symbols_traded,
    breadth: `${b.advancing}/${b.declining}/${b.unchanged}`,
    pct_advancing: b.pct_advancing,
    regime: row.regime,
    thin: b.thin_symbols,
    runId,
  });

  return { extracted: rows.length, inserted: 1, rejected: 0, regime: row.regime };
}

module.exports = {
  compute, loadDay, trailingTrades, priorSessions, newSymbols, suspendedSymbols, COLUMNS,
};

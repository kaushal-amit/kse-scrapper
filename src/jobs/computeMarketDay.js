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
  // What OUR rule produced, written every run whatever the source.
  'computed_advancing', 'computed_declining', 'computed_symbols',
  'pct_advancing', 'pct_advancing_ratio', 'breadth_5d_avg', 'thin_symbols',
  'avg_pct_change', 'median_pct_change', 'pct_change_p10', 'pct_change_p90',
  'total_volume', 'total_trades', 'volume_vs_20d', 'symbols_over_3x_daily',
  'new_symbols', 'suspended_symbols', 'renamed_symbols', 'cb_events_total',
  'regime', 'computed_at',
  // Broker-sourced, from the last non-STALE capture of the session.
  'turnover_kd', 'index_close', 'index_ytd_pct', 'broker_seen_at',
];

/**
 * Every TRADEABLE symbol_day row for the session.
 *
 * ─── THREE FILTERS, TWO COLUMNS, DELIBERATELY DIFFERENT ────────────────────
 *
 *   symbol_day        is_primary      history keeps a delisted stock
 *   market_day        is_tradeable    breadth excludes it
 *   /depth-symbols    is_tradeable    never sweep it
 *
 * A symbol is primary but NOT tradeable for two distinct reasons: it sits on
 * the Auction Market, or it is DELISTED. Both are correct. is_primary is never
 * set false by either — BAREEQ keeps its 8 sessions in symbol_day and simply
 * stops counting in breadth.
 *
 * This looks like an inconsistency and is not one. Do not "fix" it.
 *
 * ─── UNKNOWN SYMBOLS ARE KEPT ──────────────────────────────────────────────
 * NOT EXISTS, not a join: a symbol with no instruments row yet — a new listing
 * — must still count. Dropping it would let an absence in the registry delete
 * a fact in the quotes, which is the same error as writing an empty row to
 * represent an absence, in the other direction.
 */
async function loadDay(day) {
  const { rows } = await query(
    `SELECT sd.symbol, sd.chg_fils, sd.chg_1d, sd.trades, sd.total_volume,
            sd.data_quality
       FROM symbol_day sd
      WHERE sd.trading_date = $1
        AND NOT EXISTS (
          SELECT 1 FROM instruments i
           WHERE i.symbol = sd.symbol AND i.is_tradeable = false)`, [day]);
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

  /**
   * A SESSION MUST HAVE TRADED.
   *
   * Same shape as the guard below: writing a row for a day with no quotes
   * creates a market_day entry for a non-session, and the market-summary
   * endpoint then derives trading_date from it. Two rows for 28 and 29 August
   * got in that way and had to be deleted.
   */
  const { rows: traded } = await query(
    'SELECT count(*)::int AS n FROM awsat_market_quotes WHERE trading_date = $1', [day]);
  if (!traded[0].n) {
    throw new Error(
      `awsat_market_quotes has no rows for ${day}, so it was not a session. `
      + 'Writing a market_day row would create one for a day that never traded, '
      + 'and the market-summary endpoint reads those back as sessions.');
  }

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

  /**
   * DID THE BROKER ALREADY SPEAK FOR THIS DAY?
   *
   * If so its breadth stands and the compute must not replace it. A backfill
   * silently overwriting a day's authoritative count would look exactly like a
   * working system — the same shape as the KPPC/PHC inversion, where the
   * counts were right and the rows were wrong.
   */
  /**
   * The broker's own figures, from the LAST NON-STALE CAPTURE of this session.
   *
   * Read here rather than written by the ingest endpoint: one writer per table.
   * The endpoint owns awsat_market_summary; this job owns market_day.
   *
   * STALE excluded because a shut market's panel shows the PREVIOUS session —
   * Friday's read of Thursday's close is real data about Thursday, but it is
   * not a capture OF Friday and must not speak for it.
   *
   * A session whose capture stopped early has no CLOSE row, so this finds
   * whatever LIVE captures exist; a session nobody captured finds nothing and
   * the computed breadth stands, which broker_seen_at IS NULL already handles.
   */
  const { rows: caps } = await query(
    `SELECT captured_at, session_state, symbols_traded, advancing, declining,
            unchanged, total_volume, total_trades, turnover_kd,
            index_close, index_ytd_pct
       FROM awsat_market_summary
      WHERE trading_date = $1 AND session_state <> 'STALE'
      ORDER BY captured_at DESC LIMIT 1`, [day]);
  const broker = caps[0] || null;

  if (broker) {
    const ourPct = b.pct_advancing;
    const theirPct = broker.symbols_traded
      ? Number(((100 * broker.advancing) / broker.symbols_traded).toFixed(4)) : null;
    // Rule 3: name both numbers when they part company. If this fires often,
    // our rule is wrong and the broker is probably right.
    if (ourPct !== null && theirPct !== null && Math.abs(ourPct - theirPct) > 2) {
      log.warn('market_day: our breadth disagrees with the broker by more than 2 points', {
        day,
        ours: `${b.advancing}/${b.declining}/${b.unchanged} of ${b.symbols_traded} = ${ourPct}%`,
        broker: `${broker.advancing}/${broker.declining}/${broker.unchanged} of ${broker.symbols_traded} = ${theirPct}%`,
        difference: Number((ourPct - theirPct).toFixed(2)),
        capturedAt: broker.captured_at,
        sessionState: broker.session_state,
        note: 'the broker figure stands. Ours is a reconstruction; theirs is the count.',
      });
    }
  }

  const row = {
    trading_date: day,
    ...b,
    // Written every run, whatever the source, so the disagreement is queryable
    // across every session rather than grep-able for a fortnight.
    computed_advancing: b.advancing,
    computed_declining: b.declining,
    computed_symbols: b.symbols_traded,
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

  // The broker's six stand. pct_advancing and regime are RECOMPUTED from them,
  // not from ours — the regime must follow the authoritative count.
  if (broker) {
    row.symbols_traded = broker.symbols_traded;
    row.advancing = broker.advancing;
    row.declining = broker.declining;
    row.unchanged = broker.unchanged;
    row.total_volume = broker.total_volume ?? row.total_volume;
    row.total_trades = broker.total_trades ?? row.total_trades;
    row.turnover_kd = broker.turnover_kd ?? null;
    row.index_close = broker.index_close ?? null;
    row.index_ytd_pct = broker.index_ytd_pct ?? null;
    // Stamped by THIS job now, from the capture it read.
    row.broker_seen_at = broker.captured_at;
    row.pct_advancing = broker.symbols_traded
      ? Number(((100 * broker.advancing) / broker.symbols_traded).toFixed(4)) : null;
    row.pct_advancing_ratio = (broker.advancing + broker.declining)
      ? Number(((100 * broker.advancing) / (broker.advancing + broker.declining)).toFixed(4)) : null;
    row.regime = M.regimeOf(row.pct_advancing);
  }

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

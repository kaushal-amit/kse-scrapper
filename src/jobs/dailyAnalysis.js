'use strict';
/*
 * F-12 · the three constants below are NOT in config/thresholds.js, on purpose.
 *
 * `analyse()` is retired (see the note at its definition) and this engine is
 * kept only as reference for what symbol_day may later draw on. Promoting its
 * numbers into the sanctioned threshold file would publish them as live
 * settings and invite someone to tune a retired engine. They are plain literals
 * with this note instead, and the moment any of it is wired up they move.
 */
/**
 * Daily stock analysis — computes per-symbol metrics for a trading day.
 *
 * The metrics come from dailyCompute.js, ported verbatim from the working
 * ingestion service. This file is only the plumbing: read the day's 1-minute
 * rows, group them per symbol, hand each group to the engine, store the result.
 *
 * ─── WHERE THE MINUTE ROWS COME FROM ───────────────────────────────────────
 * tradingview_watchlist holds one capture per symbol per minute, and each row
 * carries a single last_price rather than an OHLC bar. The engine wants
 * { open, high, low, close, vol } per minute, so a one-capture minute becomes a
 * flat bar — open = high = low = close. That is honest for a snapshot feed: a
 * minute observed once has no measurable range, and inventing one would put
 * fabricated highs into every swing calculation downstream.
 *
 * When several captures land in the same minute, the real spread across them is
 * used.
 */

const { query } = require('../db/pool');
const clock = require('../market/clock');
const compute = require('./dailyCompute');
const log = require('../logger');

/** Defaults from the reference config; overridable per deployment. */
const CFG = {
  minSwingFils: 2.0 /* retired engine — see the note below */,
  volSpikeMultiplier: 2.0 /* retired engine */,
  targetProfitFils: 2.0 /* retired engine */,
  fibLevels: (process.env.ANALYSIS_FIB_LEVELS || '0.236,0.382,0.500,0.618,0.786')
    .split(',').map(Number),
};

const COLUMNS = [
  'symbol', 'trade_date', 'day_open', 'day_close', 'oc_margin', 'day_high',
  'day_low', 'day_range', 'total_volume', 'avg_vol_min', 'highest_volume',
  'vol_spike_count', 'bull_swings', 'bear_swings', 'total_swings',
  'tradable_bull_swings', 'largest_bull_swing', 'largest_bear_swing',
  'avg_swing_size', 'avg_time_btwn_swings', 'longest_bull_run',
  'longest_bear_run', 'fib_signals', 'successful_fib', 'fib_win_pct',
  'auto_target_fils', 'avg_profit_fib', 'avg_loss_fib', 'avg_time_to_target',
  'best_earning_time', 'false_signal_pct', 'est_buyer_vol', 'est_seller_vol',
  'buyer_pct', 'seller_pct',
];

/** Engine output (camelCase) -> table columns (snake_case). */
function toRow(m, day) {
  return {
    symbol: m.symbol, trade_date: day,
    day_open: m.dayOpen, day_close: m.dayClose, oc_margin: m.ocMargin,
    day_high: m.dayHigh, day_low: m.dayLow, day_range: m.dayRange,
    total_volume: m.totalVolume, avg_vol_min: m.avgVolMin,
    highest_volume: m.highestVolume, vol_spike_count: m.volSpikeCount,
    bull_swings: m.bullSwings, bear_swings: m.bearSwings,
    total_swings: m.totalSwings, tradable_bull_swings: m.tradableBullSwings,
    largest_bull_swing: m.largestBullSwing, largest_bear_swing: m.largestBearSwing,
    avg_swing_size: m.avgSwingSize, avg_time_btwn_swings: m.avgTimeBtwnSwings,
    longest_bull_run: m.longestBullRun, longest_bear_run: m.longestBearRun,
    fib_signals: m.fibSignals, successful_fib: m.successfulFib,
    fib_win_pct: m.fibWinPct, auto_target_fils: m.autoTargetFils,
    avg_profit_fib: m.avgProfitFib, avg_loss_fib: m.avgLossFib,
    avg_time_to_target: m.avgTimeToTarget, best_earning_time: m.bestEarningTime,
    false_signal_pct: m.falseSignalPct, est_buyer_vol: m.estBuyerVol,
    est_seller_vol: m.estSellerVol, buyer_pct: m.buyerPct, seller_pct: m.sellerPct,
  };
}

/**
 * Build per-minute OHLCV bars for one day, per symbol.
 *
 * Grouping happens in SQL because the alternative is pulling every capture into
 * Node and grouping there — ~137 symbols x 240 minutes, for no gain.
 */
async function loadMinuteBars(day) {
  const { rows } = await query(`
    SELECT symbol,
           date_trunc('minute', created_at)      AS ts,
           (array_agg(last_price ORDER BY created_at ASC))[1]  AS open,
           max(last_price)                        AS high,
           min(last_price)                        AS low,
           (array_agg(last_price ORDER BY created_at DESC))[1] AS close,
           max(volume)                            AS vol_cumulative
      FROM tradingview_watchlist
     WHERE trading_date = $1 AND last_price IS NOT NULL
     GROUP BY symbol, date_trunc('minute', created_at)
     ORDER BY symbol, ts`, [day]);

  const bySymbol = new Map();
  for (const r of rows) {
    if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, []);
    bySymbol.get(r.symbol).push({
      ts: r.ts,
      open: Number(r.open), high: Number(r.high),
      low: Number(r.low), close: Number(r.close),
      volCumulative: r.vol_cumulative === null ? null : Number(r.vol_cumulative),
    });
  }

  // Volume on the feed is CUMULATIVE for the session, but the engine wants the
  // volume traded IN each minute. Differencing consecutive values gives that;
  // summing the cumulative figures would multiply the day's volume by the
  // number of minutes.
  for (const bars of bySymbol.values()) {
    let previous = 0;
    for (const b of bars) {
      const cum = b.volCumulative === null ? previous : b.volCumulative;
      // A cumulative counter that goes backwards means a reset or a bad read;
      // treating it as negative volume would corrupt every spike calculation.
      b.vol = Math.max(0, cum - previous);
      previous = Math.max(previous, cum);
      delete b.volCumulative;
    }
  }
  return bySymbol;
}

/**
 * RETIRED — the table this wrote to no longer exists.
 *
 * daily_stock_analysis was dropped by migration 011: its columns were the
 * Fibonacci and swing strategy, retired weeks ago. symbol_day replaces it, and
 * the specification is explicit that its compute job comes AFTER the quote
 * migration is deduplicated — 6,265 duplicate keys must not carry over.
 *
 * The engine in dailyCompute.js is kept, not deleted. It is the working
 * implementation of formulas that were hard to obtain, several of its outputs
 * (day_open/close/high/low/range, the volume group) survive into symbol_day
 * under new names, and deleting it would mean recovering it from git when the
 * new job is written.
 *
 * This returns a SKIPPED result rather than throwing: a job retired on purpose
 * is not a failure, and counting it as one would raise alarms for a system
 * behaving exactly as specified.
 */
async function analyse(tradingDay, runId) {
  const day = tradingDay || clock.tradingDay();
  log.info('daily.analysis is retired — symbol_day replaces daily_stock_analysis', {
    day,
    runId,
    next: 'the symbol_day compute job comes after the quote migration',
  });
  return { extracted: 0, inserted: 0, rejected: 0, skipped: true };
}

/** The previous implementation, kept for the symbol_day job to draw on. */
async function analyseLegacy(tradingDay, runId) {
  const day = tradingDay || clock.tradingDay();
  const bySymbol = await loadMinuteBars(day);

  if (!bySymbol.size) {
    log.warn('analysis: no minute data for this day', { day });
    return { extracted: 0, inserted: 0, rejected: 0 };
  }

  const rows = [];
  const skipped = [];
  for (const [symbol, bars] of bySymbol) {
    // The engine itself refuses fewer than 5 bars; it returns null rather than
    // computing a swing profile from almost nothing.
    const metrics = compute.computeDailyMetrics(symbol, day, bars, CFG);
    if (!metrics) { skipped.push(`${symbol}(${bars.length})`); continue; }
    rows.push(toRow(metrics, day));
  }

  if (skipped.length) {
    log.warn('analysis: symbols with too few minutes to analyse', {
      count: skipped.length, sample: skipped.slice(0, 10),
    });
  }
  if (!rows.length) return { extracted: bySymbol.size, inserted: 0, rejected: skipped.length };

  // NO INSERT. daily_stock_analysis was dropped by migration 011, so there is
  // nowhere to write. What is worth keeping here is the COMPUTATION — the rows
  // are returned so the symbol_day job can consume them once it exists.
  //
  // Leaving the old INSERT in place would have made this fail with "relation
  // does not exist", which reads as a broken job rather than a retired one.
  log.info('analysis: metrics computed (not stored — symbol_day job pending)', {
    day, symbols: rows.length, skipped: skipped.length, runId,
  });
  return {
    extracted: bySymbol.size, inserted: 0, rejected: skipped.length, rows,
  };
}

/**
 * The most recent trading day before today.
 *
 * The analysis runs before the session opens, so "today" has no data yet — the
 * day to analyse is the previous trading day. Stepping over the weekend
 * matters: run on a Sunday morning, the last session was Thursday.
 */
function previousTradingDay(from = new Date()) {
  const d = new Date(from);
  for (let i = 0; i < 10; i += 1) {
    d.setUTCDate(d.getUTCDate() - 1);
    if (clock.isTradingDay(d)) return clock.tradingDay(d);
  }
  return clock.tradingDay(d);
}

module.exports = {
  analyse, analyseLegacy, loadMinuteBars, toRow, previousTradingDay, CFG, COLUMNS,
};

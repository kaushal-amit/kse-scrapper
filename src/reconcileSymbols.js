'use strict';
/**
 * Is AWSAT covering the same stocks as TradingView?
 *
 * ─── WHY THIS IS CHECKED EVERY CYCLE ───────────────────────────────────────
 * The two feeds discover their symbols independently: TradingView from a
 * watchlist, AWSAT from the broker's own board. Nothing forces them to agree,
 * and a divergence is invisible in either feed alone — both look complete,
 * because each is complete by its own definition.
 *
 * Comparing them per cycle turns "AWSAT quietly stopped covering four stocks"
 * into a log line on the cycle it happens, rather than a gap someone finds
 * weeks later while querying.
 *
 * ─── TRADINGVIEW IS THE REFERENCE, NOT AWSAT ───────────────────────────────
 * The watchlist is the deliberately curated list. The broker board is whatever
 * the terminal happens to show, which varies with the market filter, the
 * instrument type and how far the grid was scrolled. So the question asked is
 * "which watchlist symbols is AWSAT missing", not the reverse.
 */

const { query } = require('./db/pool');
const clock = require('./market/clock');
const log = require('./logger');

/**
 * The reference list: symbols TRADINGVIEW captured.
 *
 * ─── WHY THIS NEVER FALLS BACK TO `instruments` ────────────────────────────
 * It used to. `instruments` is the registry every collector writes to,
 * INCLUDING AWSAT — so before TradingView's first run of the day it held
 * AWSAT's own 194 symbols, and the check compared AWSAT against itself and
 * reported "coverage complete, 194 symbols".
 *
 * A check that can only pass is worse than no check: it reports success on
 * exactly the morning the coverage is short.
 *
 * So the reference is TradingView's own captures, and if today has none yet the
 * MOST RECENT trading day is used instead — the watchlist barely changes day to
 * day, and yesterday's list is a real reference where today's absence is not.
 * With neither, the check is SKIPPED and says so.
 */
async function referenceSymbols(day) {
  const today = await query(
    'SELECT DISTINCT symbol FROM tradingview_watchlist WHERE trading_date = $1', [day]);
  if (today.rows.length) {
    return { symbols: new Set(today.rows.map((r) => r.symbol)), from: day };
  }

  const previous = await query(
    `SELECT symbol, trading_date FROM tradingview_watchlist
      WHERE trading_date = (
        SELECT max(trading_date) FROM tradingview_watchlist WHERE trading_date < $1
      )`, [day]);

  if (previous.rows.length) {
    return {
      symbols: new Set(previous.rows.map((r) => r.symbol)),
      from: previous.rows[0].trading_date,
      stale: true,
    };
  }

  return { symbols: new Set(), from: null };
}

/**
 * Compare a captured AWSAT symbol set against the reference.
 * Reports; never blocks a write. A partial capture is still worth storing.
 */
async function check(capturedSymbols, { day = clock.tradingDay(), source = 'awsat' } = {}) {
  const ref = await referenceSymbols(day);
  const reference = ref.symbols;

  if (!reference.size) {
    log.warn('symbol reconciliation SKIPPED — TradingView has captured nothing '
      + 'yet, and there is no earlier day to compare against', { day, source });
    return { checked: false, expected: 0, captured: capturedSymbols.size };
  }
  if (ref.stale) {
    // Say which day the reference came from. A comparison against yesterday is
    // still useful, but it is not the same claim as a comparison against today.
    log.info('using the previous session\'s watchlist as the reference', {
      referenceDay: ref.from, symbols: reference.size,
    });
  }

  const captured = capturedSymbols instanceof Set
    ? capturedSymbols : new Set(capturedSymbols);

  const missing = [...reference].filter((s) => !captured.has(s));
  const extra = [...captured].filter((s) => !reference.has(s));
  const coverage = reference.size ? (reference.size - missing.length) / reference.size : 0;

  const result = {
    checked: true,
    day,
    referenceDay: ref.from,
    referenceIsStale: Boolean(ref.stale),
    source,
    expected: reference.size,
    captured: captured.size,
    matched: reference.size - missing.length,
    missing: missing.length,
    extra: extra.length,
    coveragePct: Math.round(coverage * 1000) / 10,
  };

  if (missing.length) {
    // Listed, not just counted: "4 missing" cannot be acted on, four tickers can.
    log.warn('AWSAT is missing symbols the TradingView watchlist has', {
      ...result, missingSymbols: missing.slice(0, 25),
    });
  }
  if (extra.length) {
    // Not an error. The broker board legitimately carries instruments the
    // watchlist does not — rights, REITs, indices. Worth seeing, not fixing.
    log.info('AWSAT captured symbols outside the watchlist', {
      count: extra.length, sample: extra.slice(0, 10),
    });
  }
  if (!missing.length && reference.size) {
    log.info('symbol coverage complete', {
      day, source, symbols: reference.size,
    });
  }

  return { ...result, missingSymbols: missing, extraSymbols: extra };
}

module.exports = { check, referenceSymbols };

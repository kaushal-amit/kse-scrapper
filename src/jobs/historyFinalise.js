'use strict';
/**
 * Finalise the session's history from the minute data already collected.
 *
 * ─── WHY THIS IS NOT A SCRAPER ─────────────────────────────────────────────
 * The chart scraper opens a TradingView chart per symbol, right-clicks for the
 * context menu, switches to Table view and scrolls. At 137 symbols that is
 * 25-35 minutes in which every step can fail on its own — and it did: one
 * context menu that would not open cost AAYAN its entire day of history.
 *
 * But a day's open/high/low/close/volume IS an aggregate of that day's minutes,
 * and those minutes are already in tradingview_watchlist. Deriving the bar from
 * them is a single query: about a second, deterministic, cannot half-succeed.
 *
 * The chart scraper stays for BACKFILL — days that predate collection, where
 * there are no minutes to aggregate and scraping is the only option.
 *
 * ─── WHAT open AND close MEAN HERE ─────────────────────────────────────────
 * open  = last_price of the FIRST capture of the day
 * close = last_price of the LAST capture
 *
 * The first and last OBSERVED price, not the exchange's auction prices. Those
 * differ when collection starts after the opening auction or stops before the
 * close, so a day with too few captures is flagged rather than stored as a bar
 * that looks like every other row.
 */

const { query } = require('../db/pool');
const clock = require('../market/clock');
const log = require('../logger');

/**
 * Minimum captures before a day counts as a bar. A symbol seen three times
 * cannot produce a meaningful high or low.
 */
const MIN_CAPTURES = Number(process.env.HISTORY_MIN_CAPTURES || 10);

async function finalise(tradingDay, runId) {
  const day = tradingDay || clock.tradingDay();

  // One scan: DISTINCT ON gives first and last capture per symbol, the
  // aggregates come from the same set. Two queries would let it change between.
  const { rows } = await query(`
    WITH captures AS (
      SELECT symbol, last_price, volume, created_at
        FROM tradingview_watchlist
       WHERE trading_date = $1 AND last_price IS NOT NULL
    ),
    bounds AS (
      SELECT symbol, count(*) AS captures,
             max(last_price) AS high_price,
             min(last_price) AS low_price,
             -- Volume is CUMULATIVE through the session, so the day's total is
             -- the last value. Summing would multiply it by the capture count.
             max(volume) AS volume
        FROM captures GROUP BY symbol
    ),
    firsts AS (
      SELECT DISTINCT ON (symbol) symbol, last_price AS open_price
        FROM captures ORDER BY symbol, created_at ASC
    ),
    lasts AS (
      SELECT DISTINCT ON (symbol) symbol, last_price AS close_price
        FROM captures ORDER BY symbol, created_at DESC
    )
    SELECT b.symbol, b.captures, b.high_price, b.low_price, b.volume,
           f.open_price, l.close_price
      FROM bounds b JOIN firsts f USING (symbol) JOIN lasts l USING (symbol)
     ORDER BY b.symbol`, [day]);

  if (!rows.length) {
    log.warn('history: no minute data for this day — nothing to finalise', { day });
    return { extracted: 0, inserted: 0, rejected: 0 };
  }

  const usable = [];
  const thin = [];
  for (const r of rows) {
    if (Number(r.captures) < MIN_CAPTURES) { thin.push(`${r.symbol}(${r.captures})`); continue; }
    usable.push(r);
  }
  if (thin.length) {
    log.warn('history: too few captures to form a bar', {
      count: thin.length, minCaptures: MIN_CAPTURES, sample: thin.slice(0, 10),
    });
  }
  if (!usable.length) return { extracted: rows.length, inserted: 0, rejected: thin.length };

  // UPSERT: a re-run must correct the bar, not duplicate it — and a re-run is
  // exactly what happens when the first attempt fired before the session ended.
  const values = [];
  const tuples = usable.map((r, i) => {
    const open = Number(r.open_price);
    const close = Number(r.close_price);
    values.push(r.symbol, day, r.open_price, r.high_price, r.low_price, r.close_price,
      r.volume, close - open,
      open > 0 ? Number((((close - open) / open) * 100).toFixed(4)) : null);
    const b = i * 9;
    return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9})`;
  });

  const res = await query(
    `INSERT INTO tradingview_history
       (symbol, trade_date, open_price, high_price, low_price, close_price,
        volume, change_value, change_pct)
     VALUES ${tuples.join(', ')}
     ON CONFLICT (symbol, trade_date) DO UPDATE SET
       open_price = EXCLUDED.open_price, high_price = EXCLUDED.high_price,
       low_price = EXCLUDED.low_price,   close_price = EXCLUDED.close_price,
       volume = EXCLUDED.volume,
       change_value = EXCLUDED.change_value, change_pct = EXCLUDED.change_pct,
       session_finalised_at = now(), updated_at = now()
     RETURNING symbol`, values,
  );

  await query(
    `UPDATE tradingview_history SET session_finalised_at = now()
      WHERE trade_date = $1 AND session_finalised_at IS NULL`, [day]);

  log.info('history: session finalised from minute data', {
    day, symbols: res.rowCount, skippedThin: thin.length, runId,
  });
  return { extracted: rows.length, inserted: res.rowCount, rejected: thin.length };
}

module.exports = { finalise, MIN_CAPTURES };

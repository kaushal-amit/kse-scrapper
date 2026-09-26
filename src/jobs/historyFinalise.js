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
const MIN_CAPTURES = require('../config/thresholds').get('history_min_captures');

async function finalise(tradingDay, runId) {
  const day = tradingDay || clock.tradingDay();

  // One scan: DISTINCT ON gives first and last capture per symbol, the
  // aggregates come from the same set. Two queries would let it change between.
  const { rows } = await query(`
    WITH captures AS (
      SELECT symbol, last_price, volume, change_value, change_pct, created_at
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
      SELECT DISTINCT ON (symbol) symbol, last_price AS close_price,
             -- P6-TV-5 · the venue's OWN change, which is against the PREVIOUS
             -- CLOSE. close - open computed here is an intraday move, and the
             -- backfill path writes the prev-close figure into the same two
             -- columns from TradingView's Change column: two incompatible
             -- meanings in tradingview_history.change_value, whichever ran last.
             change_value, change_pct
        FROM captures ORDER BY symbol, created_at DESC
    ),
    prev AS (
      /*
       * The previous session's CLOSE for this symbol, which is what "change"
       * is measured against. Used only when the venue did not give a change.
       *
       * ─── D8 · NOT FROM A MINUTE BAR ──────────────────────────────────────
       *
       * Measured against the official closes: CHART bars match 2,493 of
       * 2,493, UNKNOWN 393 of 400, and MINUTES 300 of 781 — thirty-eight
       * percent. A minute bar's close is the last print our grid happened to
       * catch, which is not the closing auction, so using one here computes
       * a change against a price the exchange never published.
       *
       * bar_source arrived in 050. Excluding MINUTES is a one-line filter
       * that was impossible to write before the column existed, which is
       * most of why this went unnoticed: there was nothing to filter ON.
       *
       * UNKNOWN is KEPT. 14,191 rows carry it because run_id is null on
       * them and the source cannot be derived — but they agree with the
       * official close 98% of the time, so treating "we cannot prove where
       * this came from" as "this is wrong" would throw away the bulk of the
       * history to avoid a 2% error, and leave prev_close NULL instead.
       */
      SELECT DISTINCT ON (h.symbol) h.symbol, h.close_price AS prev_close
        FROM tradingview_history h
       WHERE h.trade_date < $1 AND h.close_price IS NOT NULL
         AND COALESCE(h.bar_source, 'UNKNOWN') <> 'MINUTES'
       ORDER BY h.symbol, h.trade_date DESC
    )
    SELECT b.symbol, b.captures, b.high_price, b.low_price, b.volume,
           f.open_price, l.close_price, l.change_value, l.change_pct,
           p.prev_close
      FROM bounds b JOIN firsts f USING (symbol) JOIN lasts l USING (symbol)
      LEFT JOIN prev p USING (symbol)
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
    // P6-TV-5 · the last capture's own change, against the previous close —
    // the same definition the backfill writes. NULL when the venue did not
    // give one: "not measured", never a computed stand-in.
    // The venue's own figure first; else derived from the PREVIOUS SESSION'S
    // CLOSE, which is the same question. Never close - open: that is the
    // intraday move, and the backfill path fills these columns prev-close
    // based, so the two would disagree depending on which ran last.
    const close = Number(r.close_price);
    const prevClose = r.prev_close === null || r.prev_close === undefined
      ? null : Number(r.prev_close);
    const changeValue = r.change_value !== null && r.change_value !== undefined
      ? Number(r.change_value)
      : (prevClose !== null && Number.isFinite(close) ? close - prevClose : null);
    const changePct = r.change_pct !== null && r.change_pct !== undefined
      ? Number(r.change_pct)
      : (prevClose ? Number((((close - prevClose) / prevClose) * 100).toFixed(4)) : null);
    values.push(r.symbol, day, r.open_price, r.high_price, r.low_price, r.close_price,
      r.volume, changeValue, changePct,
      // P6-TV-8 · the run that wrote the bar, so it can be traced.
      runId || null);
    const b = i * 10;
    return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9}, $${b + 10})`;
  });

  const res = await query(
    `INSERT INTO tradingview_history
       (symbol, trade_date, open_price, high_price, low_price, close_price,
        volume, change_value, change_pct, run_id)
     VALUES ${tuples.join(', ')}
     ON CONFLICT (symbol, trade_date) DO UPDATE SET
       open_price = EXCLUDED.open_price, high_price = EXCLUDED.high_price,
       low_price = EXCLUDED.low_price,   close_price = EXCLUDED.close_price,
       volume = EXCLUDED.volume,
       change_value = EXCLUDED.change_value, change_pct = EXCLUDED.change_pct,
       run_id = EXCLUDED.run_id,
       session_finalised_at = now(), updated_at = now()
     RETURNING symbol`, values,
  );

  /*
   * P6-TV-7 · ONLY THE SYMBOLS THIS RUN ACTUALLY FINALISED.
   *
   * The blanket UPDATE stamped session_finalised_at on every row of the day —
   * including the symbols rejected above as too thin to form a bar, and rows
   * that came from the backfill. It asserted a finalisation that did not
   * happen, and nothing downstream could tell the two apart.
   */
  await query(
    `UPDATE tradingview_history SET session_finalised_at = now()
      WHERE trade_date = $1 AND session_finalised_at IS NULL
        AND symbol = ANY($2::text[])`, [day, usable.map((r) => r.symbol)]);

  log.info('history: session finalised from minute data', {
    day, symbols: res.rowCount, skippedThin: thin.length, runId,
  });
  return { extracted: rows.length, inserted: res.rowCount, rejected: thin.length };
}

module.exports = { finalise, MIN_CAPTURES };

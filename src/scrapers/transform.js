'use strict';
/**
 * Turning a scraped table into rows.
 *
 * WHY THIS IS SEPARATE FROM THE SCRAPERS
 * The browser part of a scraper cannot be tested without a browser, but the
 * part that actually goes wrong is this one: column drifted by one, a header row
 * treated as data, a source that changed its number format. Keeping the
 * transformation pure means it can be tested against real-shaped input,
 * including the malformed cases, in milliseconds and with no Chromium.
 *
 * The scrapers hand over arrays of cell strings; everything below is ordinary
 * JavaScript.
 */

const parse = require('./parse');

/**
 * Words that only ever appear in a header cell on these boards.
 * Used as a fallback when the header row was not captured separately.
 */
const HEADER_WORDS = new Set([
  'symbol', 'name', 'ticker', 'company', 'price', 'last', 'close', 'open', 'high',
  'low', 'chg', 'chg %', 'change', 'change %', 'vol', 'volume', 'value', 'turnover',
  'trades', 'bid', 'ask', 'offer', 'qty', 'quantity', 'side', 'status', 'order',
  'order id', 'filled', 'prev close', 'market',
]);

/**
 * Does this row look like a header rather than data?
 *
 * A header row that slips through becomes an instrument called "SYMBOL" with
 * null prices, re-inserted every minute. The database accepts it happily, so
 * nothing downstream ever flags it.
 *
 * THE OBVIOUS TEST IS WRONG. "A row with no numbers in it is a header" drops a
 * legitimate row: a suspended symbol, or any symbol before its first trade of
 * the day, has a name and a ticker and blanks or dashes everywhere else. Caught
 * by test — `ABAR | Al Arabi | — | | —` was being discarded as a header, which
 * is silent data loss of exactly the rows most worth noticing.
 *
 * So the test is textual, not numeric:
 *   1  identical to the header row we already captured, or
 *   2  its filled cells are ALL known header words.
 * A real row fails both, because a ticker is not a header word.
 */
function looksLikeHeader(cells, header = null) {
  if (!cells.length) return true;

  const filled = cells.filter((c) => c && String(c).trim());
  if (!filled.length) return true;

  // 1 — the same row as the header we captured.
  if (header && header.length) {
    const a = cells.map((c) => String(c || '').trim().toLowerCase()).join('|');
    const b = header.map((c) => String(c || '').trim().toLowerCase()).join('|');
    if (a === b) return true;
  }

  // 2 — every filled cell is a header word.
  return filled.every((c) => HEADER_WORDS.has(String(c).trim().toLowerCase()));
}

/**
 * Map header text to column positions.
 *
 * Resolving by NAME rather than by position matters because a column added
 * upstream shifts everything to its right. Fixed indices then keep working —
 * they just read the wrong column, and record the change percentage as the
 * price. Nothing errors; the data is simply wrong from that day on.
 *
 * Returns an object of field -> index, with -1 where the column was not found.
 */
function resolveColumns(header, aliases) {
  const lower = header.map((h) => String(h || '').trim().toLowerCase());
  const index = {};

  for (const [field, names] of Object.entries(aliases)) {
    // Exact match first: "chg" must not win the "chg %" column just because it
    // is a prefix of it.
    let i = lower.findIndex((h) => names.includes(h));
    if (i === -1) i = lower.findIndex((h) => names.some((n) => h.startsWith(n)));
    index[field] = i;
  }
  return index;
}

/**
 * Build quote rows from a table.
 *
 * @param {string[]}   header     header cell text, may be empty
 * @param {string[][]} rows       data rows as arrays of cell text
 * @param {object}     aliases    field -> acceptable header names
 * @param {object}     meta       { minuteBucket, tradingDay, capturedAt, source, runId }
 * @param {object}     fallback   field -> fixed index, used only when the header is unusable
 * @returns {{quotes: Array, symbols: Array, skipped: number, usedFallback: boolean}}
 */
function buildQuotes(header, rows, aliases, meta, fallback = {}) {
  const byName = resolveColumns(header, aliases);

  // If the header gave us nothing usable, fall back to fixed positions — but
  // record that we did, so the caller can treat it as the warning it is.
  const resolvedCount = Object.values(byName).filter((i) => i >= 0).length;
  const usedFallback = resolvedCount === 0 && Object.keys(fallback).length > 0;
  const index = usedFallback ? { ...fallback } : byName;

  const quotes = [];
  const symbols = [];
  let skipped = 0;

  for (const cells of rows) {
    if (looksLikeHeader(cells, header)) { skipped += 1; continue; }

    const symbol = parse.toSymbol(cells[0]);
    if (!symbol) { skipped += 1; continue; }

    const at = (i) => (i !== undefined && i >= 0 && i < cells.length ? cells[i] : null);

    quotes.push({
      symbol,
      minute_bucket: meta.minuteBucket,
      trading_day: meta.tradingDay,
      captured_at: meta.capturedAt,
      market: meta.market || null,
      last_price: parse.toNumber(at(index.last)),
      change_amount: parse.toNumber(at(index.change_amount)),
      change_percent: parse.toNumber(at(index.change_percent)),
      open_price: parse.toNumber(at(index.open_price)),
      high_price: parse.toNumber(at(index.high_price)),
      low_price: parse.toNumber(at(index.low_price)),
      prev_close: parse.toNumber(at(index.prev_close)),
      bid: parse.toNumber(at(index.bid)),
      bid_qty: parse.toInteger(at(index.bid_qty)),
      ask: parse.toNumber(at(index.ask)),
      ask_qty: parse.toInteger(at(index.ask_qty)),
      volume: parse.toInteger(at(index.volume)),
      turnover: parse.toNumber(at(index.turnover)),
      trades_count: parse.toInteger(at(index.trades_count)),
      source: meta.source,
      run_id: meta.runId,
    });

    symbols.push({ symbol, name: parse.clean(cells[1]), market: meta.market || null });
  }

  return { quotes, symbols, skipped, usedFallback };
}

/**
 * How many of these rows carry a usable price?
 *
 * This is the check that catches a source redesign. When selectors drift, the
 * rows still parse — there are still 135 of them, they still have symbols — but
 * every price comes back null. Inserted, that is 135 rows of nothing recorded
 * as a successful run, and the gap is invisible until someone queries the data
 * weeks later.
 */
function priceCoverage(quotes) {
  if (!quotes.length) return 0;
  const withPrice = quotes.filter((q) => q.last_price !== null && q.last_price !== undefined).length;
  return withPrice / quotes.length;
}

/** Build depth ladder rows. Header rows and empty levels are dropped. */
function buildDepthLevels(rows, symbol, meta, cols = {}) {
  const c = {
    bid_qty: 0, bid: 1, ask: 2, ask_qty: 3, bid_orders: -1, ask_orders: -1, ...cols,
  };
  const levels = [];
  let level = 0;

  for (const cells of rows) {
    if (looksLikeHeader(cells)) continue;

    const at = (i) => (i >= 0 && i < cells.length ? cells[i] : null);
    const bid = parse.toNumber(at(c.bid));
    const ask = parse.toNumber(at(c.ask));
    if (bid === null && ask === null) continue;

    level += 1;
    // The table's own CHECK caps this at 20; stop rather than emit rows that
    // will be rejected one at a time.
    if (level > 20) break;

    levels.push({
      symbol,
      captured_at: meta.capturedAt,
      trading_day: meta.tradingDay,
      level,
      bid,
      bid_qty: parse.toInteger(at(c.bid_qty)),
      bid_orders: parse.toInteger(at(c.bid_orders)),
      ask,
      ask_qty: parse.toInteger(at(c.ask_qty)),
      ask_orders: parse.toInteger(at(c.ask_orders)),
      run_id: meta.runId,
    });
  }
  return levels;
}

/** Build order rows. */
function buildOrders(rows, meta, cols = {}) {
  const c = {
    order_id: 0, symbol: 1, side: 2, status: 3, price: 4, quantity: 5, filled: 6, ...cols,
  };
  const orders = [];

  for (const cells of rows) {
    if (looksLikeHeader(cells)) continue;

    const at = (i) => (i >= 0 && i < cells.length ? cells[i] : null);
    const orderId = parse.clean(at(c.order_id));
    // Without an id the row cannot be deduplicated across captures or
    // reconciled against a fill later, so it is not worth storing.
    if (!orderId) continue;

    const quantity = parse.toInteger(at(c.quantity));
    const filled = parse.toInteger(at(c.filled));

    orders.push({
      order_id: orderId,
      captured_at: meta.capturedAt,
      trading_day: meta.tradingDay,
      // Nullable on purpose: an unreadable symbol must not discard an order
      // whose id, price and quantities are still true.
      symbol: parse.toSymbol(at(c.symbol)),
      side: parse.toSide(at(c.side)),
      order_status: parse.clean(at(c.status)),
      price: parse.toNumber(at(c.price)),
      quantity,
      filled_quantity: filled,
      remaining_qty: (quantity !== null && filled !== null && filled <= quantity)
        ? quantity - filled : null,
      order_time: null,
      run_id: meta.runId,
    });
  }
  return orders;
}

module.exports = {
  looksLikeHeader, resolveColumns, buildQuotes, priceCoverage,
  buildDepthLevels, buildOrders,
};

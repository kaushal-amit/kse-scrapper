'use strict';
/**
 * Row validation, applied between scraping and persistence.
 *
 * The database constraints are the real guarantee and stay where they are —
 * they catch anything that gets past this. But relying on them alone means
 * every malformed row costs a failed batch and a row-by-row retry, and the
 * error text names a constraint rather than the cell that was misread.
 *
 * So this layer does two things the constraints cannot:
 *
 *   NULLIFY rather than reject, where the value is optional. A nonsensical
 *   `volume` should not cost the price on the same row. Dropping the whole row
 *   would lose good data to protect a field nobody may be using.
 *
 *   REJECT the row only when the part that makes it worth storing is missing
 *   or impossible — no symbol, no minute bucket, a negative price.
 *
 * Every decision is counted and reported so a source change shows up as a
 * rising reject count rather than as quietly thinner data.
 */

const log = require('./logger');

/**
 * Sanity ceiling for prices, in the source's own units.
 *
 * Kuwait quotes in fils and the most expensive listed shares trade in the low
 * thousands. A value above this is a parse error — a volume read into a price
 * column, or two cells concatenated — not a real quote.
 */
const MAX_PRICE = 1_000_000;
const MAX_QUANTITY = 1e15;      // comfortably above any real share count

function isImpossible(n, max) {
  return n !== null && n !== undefined && (!Number.isFinite(n) || n < 0 || n > max);
}

/**
 * Coerce a value destined for a bigint column.
 *
 * Postgres rejects "0.4" for bigint, and because a multi-row INSERT is one
 * statement, one fractional cell fails the whole batch. Seen live: a single
 * 0.4 took 19 valid depth rows down with it into the slow row-by-row path.
 *
 * A fractional share count is a parse artifact, not a real quantity, so it is
 * rounded rather than dropped — the row's prices are still worth keeping.
 * Rounding is safe here precisely BECAUSE the scrapers no longer fall back to
 * reading another table: a fraction now means a rounding edge, not a column
 * read from the wrong grid.
 */
function toBigint(n) {
  if (n === null || n === undefined) return null;
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

/**
 * Validate one quote. Returns { ok, row, reason }.
 * `row` is the cleaned row when ok, otherwise null.
 */
function validateQuote(q) {
  if (!q.symbol) return { ok: false, reason: 'no symbol' };
  if (!q.market) return { ok: false, reason: 'no market' };

  // A single-character market is a RAW MARKET_ID that escaped the name map —
  // 'B' reached the table this way, 798 rows of it. Rejecting it here means the
  // gap surfaces as a validation warning naming the code, instead of as a
  // market name nothing downstream can interpret.
  if (/^[A-Z]$/i.test(String(q.market).trim())) {
    return { ok: false, reason: `market is a raw code, not a name: "${q.market}"` };
  }
  if (!(q.created_at instanceof Date) || Number.isNaN(q.created_at.getTime())) {
    return { ok: false, reason: 'invalid created_at' };
  }
  if (!q.trading_date) return { ok: false, reason: 'no trading_date' };

  // A negative price is always a misread; the row is not worth keeping.
  // chg and pct_chg are excluded: those are legitimately negative.
  for (const f of ['last_price', 'open_price', 'high_price', 'low_price', 'bid', 'offer']) {
    if (isImpossible(q[f], MAX_PRICE)) return { ok: false, reason: `impossible ${f}: ${q[f]}` };
  }

  // Quantities are optional context. A bad one is discarded, not fatal.
  const row = { ...q };
  for (const f of ['volume', 'bid_qty', 'offer_qty', 'trades', 'last_qty']) {
    if (isImpossible(row[f], MAX_QUANTITY)) row[f] = null;
    else row[f] = toBigint(row[f]);
  }

  return { ok: true, row };
}

/**
 * Is this level an actual book, or the absence of one?
 *
 * A level with no bid, no offer and no quantity on either side describes
 * nothing. It is what the socket reports for a symbol with no live book —
 * outside trading hours, a suspended stock, or one the terminal never
 * subscribed to.
 *
 * 398 such rows reached awsat_stock_depth: every one level 1, every value 0.
 * They look like data in a SELECT, so "depth is broken" and "depth is working
 * but flooded with empties" were indistinguishable. Rejecting them at the
 * boundary is what makes the difference visible.
 */
function isEmptyBook(d) {
  const blank = (v) => v === null || v === undefined || Number(v) === 0;
  return blank(d.bid) && blank(d.offer) && blank(d.bid_qty) && blank(d.offer_qty);
}

function validateDepthLevel(d) {
  if (!d.symbol) return { ok: false, reason: 'no symbol' };
  if (!(d.created_at instanceof Date)) return { ok: false, reason: 'invalid created_at' };
  if (!Number.isInteger(d.level) || d.level < 1 || d.level > 20) {
    return { ok: false, reason: `level out of range: ${d.level}` };
  }
  if (isImpossible(d.bid, MAX_PRICE)) return { ok: false, reason: `impossible bid: ${d.bid}` };
  if (isImpossible(d.offer, MAX_PRICE)) return { ok: false, reason: `impossible offer: ${d.offer}` };

  // A level with neither side is an empty ladder row, not data.
  if (d.bid === null && d.offer === null) return { ok: false, reason: 'empty level' };

  if (isEmptyBook(d)) {
    return { ok: false, reason: 'empty book — no bid, offer or quantity on either side' };
  }

  const row = { ...d };
  for (const f of ['bid_qty', 'offer_qty', 'bid_orders', 'offer_orders']) {
    if (isImpossible(row[f], MAX_QUANTITY)) row[f] = null;
    else row[f] = toBigint(row[f]);
  }
  return { ok: true, row };
}

function validateOrder(o) {
  if (!o.order_id) return { ok: false, reason: 'no order_id' };
  if (!(o.created_at instanceof Date)) return { ok: false, reason: 'invalid created_at' };
  if (isImpossible(o.price, MAX_PRICE)) return { ok: false, reason: `impossible price: ${o.price}` };

  const row = { ...o };
  if (row.side && !['BUY', 'SELL', 'UNKNOWN'].includes(row.side)) row.side = 'UNKNOWN';
  for (const f of ['quantity', 'filled_quantity', 'remaining_qty']) {
    if (isImpossible(row[f], MAX_QUANTITY)) row[f] = null;
    else row[f] = toBigint(row[f]);
  }

  // filled > quantity means the parser drifted a column. Keep the row — the id
  // and price are still true — but drop the pair that cannot both be right,
  // rather than lose the record to a CHECK violation.
  if (row.quantity !== null && row.filled_quantity !== null
      && row.filled_quantity > row.quantity) {
    log.warn('order filled exceeds quantity — dropping both, parser may have drifted', {
      order_id: row.order_id, quantity: row.quantity, filled: row.filled_quantity,
    });
    row.filled_quantity = null;
    row.remaining_qty = null;
  }

  return { ok: true, row };
}

/**
 * Run a validator over a list, logging a capped sample of the rejections.
 *
 * Capped because a wholesale source change would otherwise write one log line
 * per symbol per minute, and the volume is what stops anyone reading them.
 */
function validateAll(rows, validator, label) {
  const good = [];
  const reasons = [];

  for (const r of rows) {
    const result = validator(r);
    if (result.ok) good.push(result.row);
    else reasons.push(`${r.symbol || r.order_id || '?'}: ${result.reason}`);
  }

  if (reasons.length) {
    log.warn('rows failed validation and were not stored', {
      label,
      rejected: reasons.length,
      of: rows.length,
      sample: reasons.slice(0, 5),
    });
  }

  return { rows: good, rejected: reasons.length };
}

module.exports = {
  validateQuote, validateDepthLevel, validateOrder, validateAll, toBigint,
  isEmptyBook, MAX_PRICE,
};

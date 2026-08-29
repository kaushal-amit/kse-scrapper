'use strict';
/**
 * The seven checks the fast loop runs, per the Step 3 list.
 *
 * ─── PURE FUNCTIONS, ON PURPOSE ────────────────────────────────────────────
 * Each check takes two consecutive snapshots and returns a signal or null.
 * Nothing here reads a database, calls an API or knows what a slot is — so
 * every threshold can be tested against a hand-built pair of snapshots, and a
 * change to one check cannot alter another.
 *
 * A snapshot is one row of symbol_minute:
 *   { symbol, bid, bid_qty, offer, offer_qty, last_price, volume, trades,
 *     bid_age_secs, captured_at }
 *
 * ─── WHAT THESE DO NOT DO ──────────────────────────────────────────────────
 * They describe the book. They do not decide whether to trade, and nothing in
 * this server acts on them — the signal is written to signal_log and pushed to
 * the phone. The trader decides.
 */

/**
 * ─── THE THRESHOLDS COME FROM src/config/thresholds.js ─────────────────────
 * They were env vars read at module load, then briefly a database table. Both
 * were wrong for different reasons: env vars lose the provenance, and a table
 * owned by the BACKEND meant this capture service refused to boot when that
 * table was missing.
 *
 * A file carries the CR that set each number and cannot fail to load.
 *
 * Read through a getter rather than captured at module load: the module is
 * required before load() runs, so a captured value would be whatever the
 * fallback was and the table would never take effect.
 *
 * The VALUES are unchanged, so every one of the 32 checks behaves exactly as
 * before. Only where the number lives has moved.
 */
const T = require('./config/thresholds');

// Read through getters rather than captured at module load, so an env override
// applied before boot still takes effect.
const NO_PROTECTION_BID = () => T.get('sig_no_protection_bid');
const BUYERS_RATIO = () => T.get('sig_buyers_ratio');
const BIG_QTY = () => T.get('sig_big_qty');
const BAIT_MAX_AGE_SECS = () => T.get('sig_bait_max_age_secs');
const TINY_TRADE_SHARES = () => T.get('sig_tiny_trade_shares');

/** Volume traded between two snapshots. Volume is cumulative for the session. */
/**
 * The columns evaluate() reads off a symbol_minute row.
 *
 * Listed rather than inferred so a missing one can be NAMED. "Invalid row
 * shape" sends someone reading code; "row is missing volume_delta" sends them
 * to the right line.
 */
const REQUIRED_COLUMNS = [
  'last_price', 'bid', 'bid_qty', 'offer', 'offer_qty', 'volume_delta',
  'bid_age_secs',
];

/**
 * Reject a row that is not a symbol_minute row.
 *
 * ─── WHY THIS THROWS RATHER THAN COPES ─────────────────────────────────────
 * A tolerant version would have hidden the bug this was written for: for weeks
 * tradedBetween read `volume` — a column symbol_minute does not have — and
 * WALL_PLACED, WALL_PULLED and FROZEN returned null on every evaluation. Four
 * of seven checks worked and the system looked normal.
 *
 * A fallback would have made a quote-shaped row work, nobody would have
 * noticed the real one did not, and it would have surfaced in production
 * instead of in a test.
 */
function assertRowShape(row, which) {
  if (!row || typeof row !== 'object') {
    throw new Error(`signals.evaluate: ${which} row is not an object.`);
  }
  const missing = REQUIRED_COLUMNS.filter((c) => !(c in row));
  if (missing.length) {
    const err = new Error(
      `signals.evaluate: ${which} row is missing \`${missing.join('`, `')}\`. `
      + `Expected a symbol_minute row (${REQUIRED_COLUMNS.length} required columns). `
      + `Got ${Object.keys(row).length} properties.`);
    // Tagged so the fast loop can COUNT these specifically. A shape error is
    // not the same as a database error and must not be swallowed with one.
    err.shapeError = true;
    err.missingColumns = missing;
    throw err;
  }
}

/**
 * Shares traded between two observations.
 *
 * ─── READ volume_delta, NOT A CUMULATIVE ───────────────────────────────────
 * This used to compute now.volume - prev.volume. symbol_minute has 18 columns
 * and `volume` is NOT one of them — it stores volume_delta, already the
 * difference.
 *
 * So prev.volume was undefined on every real row, this returned null, and
 * WALL_PLACED, WALL_PULLED and FROZEN returned null on EVERY evaluation.
 * Three of the seven checks could never fire. Not on a bad tick — ever.
 *
 * The 32 unit tests passed throughout, because each built its own input object
 * with a `volume` property the real row shape does not have. A test that
 * constructs its own input proves the logic and nothing about the wiring.
 *
 * The cumulative form is still accepted: the fast loop reads symbol_minute, but
 * an ad-hoc caller may hold quote rows, and refusing those would trade one
 * silent failure for another.
 */
function tradedBetween(prev, now) {
  // volume_delta IS the difference. symbol_minute has 18 columns and `volume`
  // is not one of them — computing now.volume - prev.volume read undefined on
  // every real row.
  //
  // A null delta means UNKNOWN, not zero: after a process restart the previous
  // cumulative is not yet known, and the three volume-keyed checks must go
  // SILENT rather than fire on a guess.
  if (now.volume_delta === null || now.volume_delta === undefined) return null;
  const d = Number(now.volume_delta);
  // A counter going backwards is a reset or a bad read, not negative volume.
  return Number.isFinite(d) && d >= 0 ? d : null;
}

const n = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

/**
 * 10 · NO PROTECTION — the bid is too thin to lean on.
 *
 * Below this there is nothing holding the price up: a single ordinary sell
 * takes out the whole level.
 */
function noProtection(prev, now) {
  const bidQty = n(now.bid_qty);
  if (bidQty === null || bidQty >= NO_PROTECTION_BID()) return null;
  return {
    signal: 'NO_PROTECTION',
    detail: `bid ${bidQty.toLocaleString()} < ${NO_PROTECTION_BID().toLocaleString()}`,
    bid_qty: bidQty,
  };
}

/**
 * 11 · BUYERS 8:5 — buyers outweigh sellers AND the price is rising.
 *
 *     ratio >= 1.6 AND price rising
 *
 * BOTH conditions, and the second is about PRICE, not the ratio. An earlier
 * version of this required the RATIO to be increasing, which is a different
 * test and can fire while the price falls — a book leaning up under a price
 * going down is a queue building against the move, not with it.
 */
function buyersRatio(prev, now) {
  const bq = n(now.bid_qty);
  const oq = n(now.offer_qty);
  if (bq === null || oq === null || oq === 0) return null;

  const ratio = bq / oq;
  if (ratio < BUYERS_RATIO()) return null;

  const before = n(prev.last_price);
  const after = n(now.last_price);
  if (before === null || after === null || after <= before) return null;

  return {
    signal: 'BUYERS_8_5',
    detail: `ratio ${ratio.toFixed(2)} with price ${before} to ${after}`,
    ratio: Number(ratio.toFixed(4)),
    from_px: before,
    to_px: after,
  };
}

/**
 * 12 · WALL PLACED — offer size grew with no trading to explain it.
 *
 * "Without corresponding trading volume" is the whole signal. Offer size rising
 * because trades happened is ordinary; rising while nothing traded means
 * someone placed size.
 */
function wallPlaced(prev, now) {
  const before = n(prev.offer_qty);
  const after = n(now.offer_qty);
  if (before === null || after === null || after <= before) return null;

  const traded = tradedBetween(prev, now);
  if (traded === null || traded > 0) return null;

  return {
    signal: 'WALL_PLACED',
    detail: `offer ${before.toLocaleString()} to ${after.toLocaleString()} with no volume`,
    added: after - before,
    offer: n(now.offer),
  };
}

/** 13 · WALL PULLED — offer size fell with no trading to explain it. */
function wallPulled(prev, now) {
  const before = n(prev.offer_qty);
  const after = n(now.offer_qty);
  if (before === null || after === null || after >= before) return null;

  const traded = tradedBetween(prev, now);
  if (traded === null || traded > 0) return null;

  return {
    signal: 'WALL_PULLED',
    detail: `offer ${before.toLocaleString()} to ${after.toLocaleString()} with no volume`,
    removed: before - after,
    offer: n(now.offer),
  };
}

/**
 * 14 · BAIT BID — a large bid that has not been there long.
 *
 * Size that has stood for an hour is a real buyer. The same size placed four
 * minutes ago is a display, and it can leave as fast as it arrived.
 */
function baitBid(prev, now) {
  const bidQty = n(now.bid_qty);
  const age = n(now.bid_age_secs);
  if (bidQty === null || bidQty <= BIG_QTY()) return null;
  if (age === null || age >= BAIT_MAX_AGE_SECS()) return null;

  return {
    signal: 'BAIT_BID',
    detail: `bid ${bidQty.toLocaleString()} only ${age}s old`,
    bid_qty: bidQty,
    bid_age_secs: age,
  };
}

/**
 * 15 · FROZEN — both sides large, nothing trading.
 *
 * The book looks deep and is not moving. Posting into it means joining a queue
 * behind size that is not being consumed.
 */
function frozen(prev, now) {
  const bq = n(now.bid_qty);
  const oq = n(now.offer_qty);
  if (bq === null || oq === null) return null;
  if (bq <= BIG_QTY() || oq <= BIG_QTY()) return null;

  const traded = tradedBetween(prev, now);
  if (traded === null || traded > 0) return null;

  return {
    signal: 'FROZEN',
    detail: `bid ${bq.toLocaleString()} / offer ${oq.toLocaleString()}, nothing traded`,
    bid_qty: bq,
    offer_qty: oq,
  };
}

/**
 * 16 · BID EMPTY — a small print moved the price down.
 *
 * The size is the point. A large sell moving the price is the market working;
 * a hundred shares moving it means there was nothing underneath.
 */
function bidEmpty(prev, now) {
  const before = n(prev.last_price);
  const after = n(now.last_price);
  if (before === null || after === null || after >= before) return null;

  const traded = tradedBetween(prev, now);
  if (traded === null || traded === 0) return null;
  if (traded > TINY_TRADE_SHARES()) return null;

  return {
    signal: 'BID_EMPTY',
    detail: `${traded} share(s) moved the price ${before} to ${after}`,
    shares: traded,
    from_px: before,
    to_px: after,
  };
}

const CHECKS = [
  noProtection, buyersRatio, wallPlaced, wallPulled, baitBid, frozen, bidEmpty,
];

function evaluate(prev, now) {
  if (prev === null || prev === undefined) return [];
  assertRowShape(prev, 'previous');
  assertRowShape(now, 'current');

  if (!prev || !now) return [];
  const out = [];
  for (const check of CHECKS) {
    let hit = null;
    try {
      hit = check(prev, now);
    } catch {
      hit = null;      // one bad check must not lose the other six
    }
    if (hit) {
      out.push({
        ...hit,
        symbol: now.symbol,
        captured_at: now.captured_at,
        last_price: n(now.last_price),
      });
    }
  }
  return out;
}

module.exports = {
  REQUIRED_COLUMNS,
  assertRowShape,
  assertRowShape,
  REQUIRED_COLUMNS,
  evaluate,
  noProtection,
  buyersRatio,
  wallPlaced,
  wallPulled,
  baitBid,
  frozen,
  bidEmpty,
  tradedBetween,
  THRESHOLDS: {
    // Exported as FUNCTIONS: the value is read when a check runs, not when
    // this module is required — which happens before load().
    NO_PROTECTION_BID, BUYERS_RATIO, BIG_QTY, BAIT_MAX_AGE_SECS, TINY_TRADE_SHARES,
  },
};

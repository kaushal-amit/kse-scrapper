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

const NO_PROTECTION_BID = Number(process.env.SIG_NO_PROTECTION_BID || 20_000);
const BUYERS_RATIO = Number(process.env.SIG_BUYERS_RATIO || 1.6);
const BIG_QTY = Number(process.env.SIG_BIG_QTY || 100_000);
const BAIT_MAX_AGE_SECS = Number(process.env.SIG_BAIT_MAX_AGE_SECS || 300);
const TINY_TRADE_SHARES = Number(process.env.SIG_TINY_TRADE_SHARES || 100);

/** Volume traded between two snapshots. Volume is cumulative for the session. */
function tradedBetween(prev, now) {
  if (prev.volume === null || now.volume === null
    || prev.volume === undefined || now.volume === undefined) return null;
  const delta = Number(now.volume) - Number(prev.volume);
  // A cumulative counter going backwards is a reset or a bad read, not
  // negative volume. Treated as unknown rather than as a fall.
  return delta < 0 ? null : delta;
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
  if (bidQty === null || bidQty >= NO_PROTECTION_BID) return null;
  return {
    signal: 'NO_PROTECTION',
    detail: `bid ${bidQty.toLocaleString()} < ${NO_PROTECTION_BID.toLocaleString()}`,
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
  if (ratio < BUYERS_RATIO) return null;

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
  if (bidQty === null || bidQty <= BIG_QTY) return null;
  if (age === null || age >= BAIT_MAX_AGE_SECS) return null;

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
  if (bq <= BIG_QTY || oq <= BIG_QTY) return null;

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
  if (traded > TINY_TRADE_SHARES) return null;

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

/**
 * Run every check over one pair of snapshots.
 *
 * All seven run — the first match does not stop the rest. A thin bid AND a
 * pulled wall at the same moment is a different situation from either alone,
 * and stopping early would hide the combination.
 */
function evaluate(prev, now) {
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
    NO_PROTECTION_BID, BUYERS_RATIO, BIG_QTY, BAIT_MAX_AGE_SECS, TINY_TRADE_SHARES,
  },
};

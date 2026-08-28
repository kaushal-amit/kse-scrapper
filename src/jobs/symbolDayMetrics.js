'use strict';
/**
 * src/jobs/symbolDayMetrics.js — the arithmetic, with no database in it.
 *
 * Every function takes an array of capture rows for ONE symbol on ONE day and
 * returns numbers. Nothing here opens a connection, so each rule can be tested
 * against a hand-built day and S1-S10 can run without a fixture.
 *
 * ─── THE VOLUME GATE ───────────────────────────────────────────────────────
 * Every movement metric counts only rows where volume ROSE since the previous
 * capture. A price that changes without volume is a quote update, not a trade
 * — it is not a move in any direction, and counting it inflates every
 * movement, tape-quality and flow figure at once.
 *
 * ─── CUMULATIVE COLUMNS ────────────────────────────────────────────────────
 * volume, trades and last_qty are session running totals, not per-capture
 * values. MRC's last five captures all read 10,876,132; summing them would
 * report 54 million on a 10.8 million day. They are read with max(), and
 * per-minute figures come from differences.
 *
 * ─── FILS ──────────────────────────────────────────────────────────────────
 * Prices are already in fils. 204 means 204 fils, a 1-fil move is a difference
 * of 1, and no conversion happens anywhere.
 */

/** Sessions whose prints count toward a close. Mirrors closing_sessions(). */
const CLOSING_SESSIONS = new Set([
  'Trading', 'Close Auction Acceptance', 'Trading at Last', 'Close-Of-Day',
]);

const TINY_SHARES = Number(process.env.SD_TINY_SHARES || 100);
const AT_OFFER_INVALIDATES_RATIO = Number(process.env.SD_AT_OFFER_MAX || 90);
const THIN_ABSOLUTE_MINUTES = Number(process.env.SD_THIN_MINUTES || 60);
const THIN_MEDIAN_FRACTION = Number(process.env.SD_THIN_FRACTION || 0.80);
const CRAWLER_MAX_PRICE = Number(process.env.SD_CRAWLER_MAX_PX || 100);

const n = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

/** Captures in time order. Everything below assumes this ordering. */
function ordered(rows) {
  return [...rows].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

/**
 * Consecutive pairs where volume ROSE — the only rows that represent trading.
 *
 * Returns { prev, now, traded } so each caller sees both sides of the step and
 * the size of it, rather than recomputing the difference.
 */
function volumeSteps(rows) {
  const out = [];
  const sorted = ordered(rows);
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const now = sorted[i];
    const a = n(prev.volume);
    const b = n(now.volume);
    if (a === null || b === null) continue;
    const traded = b - a;
    // A cumulative counter going backwards is a reset or a bad read, not
    // negative trading.
    if (traded <= 0) continue;
    out.push({ prev, now, traded });
  }
  return out;
}

/** OHLC across EVERY row of the day, auction included. */
function priceBlock(rows) {
  const sorted = ordered(rows);
  const prices = sorted.map((r) => n(r.last_price)).filter((p) => p !== null && p > 0);
  if (!prices.length) return { open_px: null, high_px: null, low_px: null };
  return {
    open_px: prices[0],
    // High and low must include the auction: CATTL's 24 August low was set in
    // a circuit-breaker auction, not in continuous trading.
    high_px: Math.max(...prices),
    low_px: Math.min(...prices),
  };
}

/**
 * The close, from all four closing sessions.
 *
 * Filtering to 'Trading' alone reads the last CONTINUOUS trade as the close and
 * cuts off the auction — TIJARA 172 instead of 176. A NULL session is included:
 * an unlabelled print is more likely a gap in capture than one the exchange
 * meant to exclude.
 */
function closePrice(rows) {
  const eligible = ordered(rows).filter((r) => {
    const px = n(r.last_price);
    if (px === null || px <= 0) return false;
    return r.session === null || r.session === undefined
      || CLOSING_SESSIONS.has(String(r.session).trim());
  });
  if (!eligible.length) return null;
  return n(eligible[eligible.length - 1].last_price);
}

/**
 * WHICH session the close came from.
 *
 * Through 27 July the scraper stopped at 12:59 Kuwait, half an hour before the
 * close, so Close-Of-Day never existed to capture and close_px is the last
 * continuous Trading print — wrong by a fil or two on every symbol for ten
 * consecutive days.
 *
 * data_quality = THIN already says "something was wrong". This says exactly
 * what, so a caller can decide for itself whether a Trading-sourced close is
 * good enough for what it is doing.
 */
function closeSource(rows) {
  const eligible = ordered(rows).filter((r) => {
    const px = n(r.last_price);
    if (px === null || px <= 0) return false;
    return r.session === null || r.session === undefined
      || CLOSING_SESSIONS.has(String(r.session).trim());
  });
  if (!eligible.length) return null;   // close_px is NULL too; no fifth value

  const session = String(eligible[eligible.length - 1].session || '').trim();
  if (session === 'Close-Of-Day') return 'CLOSE_OF_DAY';
  if (session === 'Trading at Last') return 'TRADING_AT_LAST';
  if (session === 'Close Auction Acceptance') return 'AUCTION';
  // 'Trading', or an unlabelled row: the last continuous print, not the close.
  return 'TRADING';
}

function hasCloseOfDay(rows) {
  return rows.some((r) => String(r.session || '').trim() === 'Close-Of-Day');
}

/** Cumulative totals, read with max() rather than summed. */
function volumeBlock(rows) {
  const vols = rows.map((r) => n(r.volume)).filter((v) => v !== null);
  const trades = rows.map((r) => n(r.trades)).filter((v) => v !== null);
  const steps = volumeSteps(rows);

  const total = vols.length ? Math.max(...vols) : null;
  const tradeCount = trades.length ? Math.max(...trades) : null;

  return {
    total_volume: total,
    trades: tradeCount,
    avg_trade_size: (total !== null && tradeCount) ? Number((total / tradeCount).toFixed(4)) : null,
    // The largest single INCREASE, not the largest reading.
    highest_minute_volume: steps.length ? Math.max(...steps.map((s) => s.traded)) : null,
  };
}

/**
 * Movement, tape quality and flow — all from the same volume-bearing steps.
 *
 * Computed together because they share one traversal and one definition of
 * what a trade is. Splitting them invites two functions to disagree about
 * which rows count.
 */
function movementBlock(rows) {
  const steps = volumeSteps(rows);

  let moves = 0;
  let up = 0;
  let down = 0;
  let up2 = 0;
  let up3 = 0;
  let upTiny = 0;
  let downTiny = 0;
  let under100 = 0;
  let atOffer = 0;
  let atBid = 0;
  let boughtAtOffer = 0;
  let soldAtBid = 0;
  let insideSpread = 0;

  for (const { prev, now, traded } of steps) {
    const before = n(prev.last_price);
    const after = n(now.last_price);
    const qty = n(now.last_qty);
    const bid = n(now.bid);
    const offer = n(now.offer);

    // ── tape quality: the size of the print that moved it ──
    // last_qty repeats while nothing trades, so it is read only here, on rows
    // where volume rose. Otherwise one stale 5,000 is counted again and again.
    const tiny = qty !== null && qty <= TINY_SHARES;
    if (tiny) under100 += 1;

    // ── flow: print location, not the tick rule ──
    // APPROXIMATE BY CONSTRUCTION: last_price is the price of a trade that may
    // have happened up to a minute before this book was read, so it is compared
    // against a slightly later bid and offer. Every finding this month used
    // exactly this method, so it is kept unchanged — a more accurate method
    // would make the historical results non-comparable.
    if (after !== null && offer !== null && after >= offer) {
      atOffer += 1;
      boughtAtOffer += traded;
    } else if (after !== null && bid !== null && after <= bid) {
      atBid += 1;
      soldAtBid += traded;
    } else {
      insideSpread += traded;
    }

    if (before === null || after === null) continue;
    const delta = after - before;          // already in fils
    if (delta === 0) continue;

    moves += 1;
    if (delta > 0) {
      up += 1;
      if (delta >= 2) up2 += 1;
      if (delta >= 3) up3 += 1;
      if (tiny) upTiny += 1;
    } else {
      down += 1;
      if (tiny) downTiny += 1;
    }
  }

  const pct = (a, b) => (b ? Number(((100 * a) / b).toFixed(4)) : null);
  const priced = atOffer + atBid + (steps.length - atOffer - atBid);

  return {
    moves,
    up_moves: up,
    down_moves: down,
    up_moves_2plus: up2,
    up_moves_3plus: up3,
    up_moves_tiny: upTiny,
    down_moves_tiny: downTiny,
    trades_under_100: under100,
    // THE GATE, and it is UP-ONLY. Blending halves it: up-moves run 43-70%
    // tiny and down-moves 0-20%, so ARABREC reads 12% blended and 24% up-only.
    tiny_pct_up: pct(upTiny, up),
    tiny_pct_down: pct(downTiny, down),
    bought_at_offer: boughtAtOffer,
    sold_at_bid: soldAtBid,
    shares_inside_spread: insideSpread,
    trades_at_offer: atOffer,
    trades_at_bid: atBid,
    pct_at_offer: pct(atOffer, priced),
    steps: steps.length,
  };
}

/**
 * buy_sell_ratio, and the reason it is often NULL.
 *
 * A stock that sits at the offer classifies EVERY print as buying. GFH sits
 * there 98% of minutes and read 52:1; KRE 99% and read 199:1. Those are
 * artefacts of the measurement, not observations about the market, so above
 * the threshold the ratio is refused rather than reported.
 */
function buySellRatio(movement) {
  if (movement.pct_at_offer !== null && movement.pct_at_offer > AT_OFFER_INVALIDATES_RATIO) {
    return null;
  }
  if (!movement.sold_at_bid) return null;      // no denominator
  return Number((movement.bought_at_offer / movement.sold_at_bid).toFixed(4));
}

/** Distinct minutes actually captured — the input to data_quality. */
function minutesCaptured(rows) {
  const minutes = new Set();
  for (const r of rows) {
    if (!r.created_at) continue;
    minutes.add(new Date(r.created_at).toISOString().slice(0, 16));
  }
  return minutes.size;
}

/**
 * FULL or THIN.
 *
 * The median is that DAY'S market median, not a fixed 270: capture length
 * varies market-wide (203 minutes on 26 August, 259 on the 25th), so a fixed
 * denominator would mark every symbol THIN on a short day. Self-calibrating
 * against the market means only symbols that fell behind THEIR OWN market are
 * flagged.
 *
 * The absolute floor is the second half. Without it, a day where capture died
 * at 09:20 for everyone gives a tiny median and every symbol reads FULL against
 * a broken baseline.
 */
function dataQuality(minutes, marketMedian, closeOfDay) {
  if (minutes < THIN_ABSOLUTE_MINUTES) return 'THIN';
  if (marketMedian && minutes < THIN_MEDIAN_FRACTION * marketMedian) return 'THIN';
  if (!closeOfDay) return 'THIN';
  return 'FULL';
}

/**
 * family — CRAWLER only.
 *
 * Every other class needs bid_p50, which lives in the book group and stays
 * NULL until depth covers more than 19 symbols. CRAWLER is decidable from L1
 * alone: below 100 fils the tick is 0.1 fils, which changes the economics of
 * every trade rather than describing the stock's behaviour.
 */
function familyOf(closePx) {
  if (closePx === null) return null;
  return closePx < CRAWLER_MAX_PRICE ? 'CRAWLER' : null;
}

/**
 * Did the price cross the 100-fil tick boundary?
 *
 * Two tick regimes in one session means per-fil economics are right for part of
 * the day and wrong for the rest — the error that made COAST read "+5.00 a fil"
 * against an actual -2.56.
 */
function tickBandCrossed(closePx, highPx) {
  if (closePx === null || highPx === null) return null;
  return closePx < CRAWLER_MAX_PRICE && highPx >= CRAWLER_MAX_PRICE;
}

module.exports = {
  ordered,
  volumeSteps,
  priceBlock,
  closePrice,
  closeSource,
  hasCloseOfDay,
  volumeBlock,
  movementBlock,
  buySellRatio,
  minutesCaptured,
  dataQuality,
  familyOf,
  tickBandCrossed,
  CLOSING_SESSIONS,
  TINY_SHARES,
  AT_OFFER_INVALIDATES_RATIO,
  THIN_ABSOLUTE_MINUTES,
  THIN_MEDIAN_FRACTION,
};

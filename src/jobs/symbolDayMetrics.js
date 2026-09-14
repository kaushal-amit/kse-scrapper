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

/**
 * THE CLOSE IS A PRECEDENCE ORDER, NOT A SESSION LIST.
 *
 * A list plus "latest by created_at" picks whichever session happened to be
 * captured last, which is not the same as the best available close. CABLE on
 * 2 August has a Close-Of-Day at 1650 captured at 10:17 and an auction print at
 * 1648 captured later in the file — ordering by time reaches the auction and
 * never gets to the official close.
 *
 * Highest tier present wins; within a tier, the latest capture. Stated here
 * rather than left to DISTINCT ON, because three identical Close-Of-Day rows at
 * 10:15, 10:16 and 10:17 must resolve deterministically.
 *
 * '' sits with Trading: it is a JULY CAPTURE DEFECT, not an exchange state —
 * those rows are 09:00-12:59 continuous trading whose label was not captured.
 * NULL is excluded entirely: those are 14:13-14:23 Friday reads, after the
 * close on a non-trading day, and their volume is cumulative rather than new.
 */
const CLOSE_TIERS = new Map([
  ['Close-Of-Day', 1],
  ['Closing', 2],
  ['Trading at Last', 3],
  ['Close Auction Acceptance', 4],
  ['Trading', 5],
  ['', 5],
]);

const TIER_NAME = ['', 'CLOSE_OF_DAY', 'CLOSING', 'TRADING_AT_LAST', 'AUCTION', 'TRADING'];

/**
 * THE RANGE IS A DIFFERENT SET FROM THE CLOSE.
 *
 * Everything from 13:00 clears at one price, so feeding it into a high or low
 * measures the auction rather than the session. TIJARA on 9 August: a 3-fil
 * continuous range became 9 because one auction print of 849,788 shares cleared
 * eight fils below the 12:59 price.
 *
 * CB Auction IS included — 581 rows, 26.8 million shares, real trading after a
 * circuit breaker. CATTL's 24 August low of 217 was set in one.
 */
const RANGE_SESSIONS = new Set(['Trading', 'CB Auction', '']);

/** Kept for the tests that assert the old four-session set still resolves. */
const CLOSING_SESSIONS = new Set([
  'Trading', 'Close Auction Acceptance', 'Trading at Last', 'Close-Of-Day',
]);

const T = require('../config/thresholds');

// F-12 · the same concept as signals.js's tiny print, so the same key.
const TINY_SHARES = T.get('sig_tiny_trade_shares');
const AT_OFFER_INVALIDATES_RATIO = T.get('sd_at_offer_invalidates_pct');
const THIN_ABSOLUTE_MINUTES = T.get('sd_thin_absolute_minutes');
const THIN_MEDIAN_FRACTION = T.get('sd_thin_median_fraction');
const CRAWLER_MAX_PRICE = T.get('sd_crawler_max_price_fils');

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
  // Only the sessions where a price is the session's own — see RANGE_SESSIONS.
  const sorted = ordered(rows).filter((r) => {
    if (r.session === null || r.session === undefined) return false;
    return RANGE_SESSIONS.has(String(r.session).trim());
  });
  const prices = sorted.map((r) => n(r.last_price)).filter((p) => p !== null && p > 0);
  if (!prices.length) return { open_px: null, high_px: null, low_px: null };
  return {
    open_px: prices[0],
    // CB Auction is in RANGE_SESSIONS, so CATTL's 24 August low of 217 counts.
    // The CLOSING auction is not: it clears at one price and is not a range.
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
function closeRow(rows) {
  let best = null;
  let bestTier = 99;
  for (const r of ordered(rows)) {
    const px = n(r.last_price);
    if (px === null || px <= 0) continue;
    if (r.session === null || r.session === undefined) continue;   // Friday reads
    const tier = CLOSE_TIERS.get(String(r.session).trim());
    if (tier === undefined) continue;                              // Pre-Auction etc.
    // Highest tier wins; within a tier the LATEST, and `ordered` ascends.
    if (tier < bestTier || tier === bestTier) {
      if (tier <= bestTier) { best = r; bestTier = tier; }
    }
  }
  return best;
}

function closePrice(rows) {
  const r = closeRow(rows);
  return r ? n(r.last_price) : null;
}

/**
 * WHICH tier the close came from.
 *
 * Through 27 July the scraper stopped at 12:59, so Close-Of-Day never existed
 * to capture and close_px is the last continuous print — the TIJARA
 * 172-instead-of-176 error, systematically, on every symbol for ten days.
 * data_quality = THIN says something was wrong; this says exactly what.
 */
function closeSource(rows) {
  const r = closeRow(rows);
  if (!r) return null;                 // close_px is NULL too; no fifth value
  return TIER_NAME[CLOSE_TIERS.get(String(r.session).trim())];
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
  let insideSpreadSteps = 0;   // steps with a readable book, priced between
  let unbookedSteps = 0;      // steps whose book did not render at all

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
      /*
       * P2 · A STEP WHOSE BOOK WE COULD NOT READ IS NOT A STEP INSIDE THE
       * SPREAD.
       *
       * This branch catches both: a print genuinely between the bid and the
       * offer, and a step where bid/offer (or the price itself) did not render
       * at all — a halt, pre-open, a limit, a short capture. They are counted
       * apart now, because one belongs in the pct_at_offer denominator and the
       * other cannot.
       */
      if (after !== null && bid !== null && offer !== null) insideSpreadSteps += 1;
      else unbookedSteps += 1;
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

  /*
   * P2 · THE DENOMINATOR IS THE STEPS WHOSE BOOK WAS ACTUALLY READ.
   *
   * It was `atOffer + atBid + (steps.length - atOffer - atBid)`, which reduces
   * algebraically to steps.length. The name `priced` and the tautological
   * arithmetic both say a measured denominator was intended and never arrived.
   *
   * A step with no book falls into the else branch above and used to be counted
   * as inside the spread. It can never reach the atOffer numerator, and it was
   * in the denominator.
   *
   * WHAT THAT COST. A symbol sitting at the offer on every step where the book
   * WAS read, with half the day's steps unbooked, reported pct_at_offer 50
   * instead of ~100. buySellRatio() then does not trip
   * sd_at_offer_invalidates_pct, and publishes the ratio TMI rule 5 exists to
   * refuse — and because the STORED pct_at_offer is 50, migration 013's
   * symbol_day_ratio_invalid_at_offer CHECK accepts the row as well. The
   * database-level enforcement is defeated by the same wrong number it is
   * enforcing on.
   *
   * shares_inside_spread still carries the unbooked VOLUME. "We could not see
   * where this traded" is not "it traded at the offer", and that column is
   * descriptive rather than a gate — but unbooked_steps is reported beside it
   * so the shortfall is visible rather than inferred.
   */
  const priced = atOffer + atBid + insideSpreadSteps;

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
    // P2 · what the pct_at_offer denominator is, and what it had to leave out.
    priced_steps: priced,
    unbooked_steps: unbookedSteps,
    trades_at_offer: atOffer,
    trades_at_bid: atBid,
    pct_at_offer: pct(atOffer, priced),
    steps: steps.length,
  };
}

/**
 * The SHAPE of a session's trading, not its totals.
 *
 * ─── VOLUME DELTA, NOT last_qty ────────────────────────────────────────────
 * Measured both against six known outcomes. They disagree in SIGN on two, and
 * last_qty gets both backwards:
 *
 *     TIJARA 16 Aug   173 -> 181, free    delta 4.99    last_qty 0.71
 *     MRC    16 Aug   fell that week      delta 0.17    last_qty 2.14
 *
 * last_qty is one print sampled at capture time; at 60-second polling that is a
 * single trade out of dozens. The delta is everything that traded in the step.
 *
 * ─── THE COUNTS ARE STORED, NOT USED AS A THRESHOLD ────────────────────────
 * A minimum would have discarded the best evidence: MRC on 16 August had 7
 * up-moves and 9 down, below any sensible gate, and it preceded the fall by six
 * days while buy_sell_ratio read positive. A gate can demand ten a side; the
 * analysis can look at seven and know it is seven.
 *
 * ─── THE SPLIT IS 11:15 ────────────────────────────────────────────────────
 * The session runs 09:00-13:30, so its midpoint is 11:15, not noon. Named
 * first/second half for that reason — a column called am_ that changes at 11:15
 * is the moves_2plus mistake, where the name said one thing and the rule did
 * another.
 */
// F-12 · a CLOCK TIME, and it was written as arithmetic on literals — wrong
// the moment the session's hours change, which END_TIME has already done once.
const SESSION_MIDPOINT_MIN = (() => {
  const hhmm = T.get('sd_session_midpoint_hhmm');
  return Math.floor(hhmm / 100) * 60 + (hhmm % 100);
})();     // 11:15 Kuwait

function flowBlock(rows) {
  const steps = volumeSteps(rows);

  let upShares = 0;
  let downShares = 0;
  let nUp = 0;
  let nDown = 0;
  let turnover = 0;
  let firstHalf = 0;
  let secondHalf = 0;
  let firstMinutes = new Set();
  let secondMinutes = new Set();

  for (const { prev, now, traded } of steps) {
    const before = n(prev.last_price);
    const after = n(now.last_price);

    // Value traded in this step, in KD. Prices are fils; 1 KD = 1000 fils.
    if (after !== null) turnover += (traded * after) / 1000;

    // Kuwait is UTC+3 with no daylight saving.
    const k = new Date(new Date(now.created_at).getTime() + 3 * 3600_000);
    const minuteOfDay = k.getUTCHours() * 60 + k.getUTCMinutes();
    const stamp = `${k.getUTCHours()}:${k.getUTCMinutes()}`;
    if (minuteOfDay < SESSION_MIDPOINT_MIN) { firstHalf += traded; firstMinutes.add(stamp); }
    else { secondHalf += traded; secondMinutes.add(stamp); }

    if (before === null || after === null || after === before) continue;
    if (after > before) { upShares += traded; nUp += 1; }
    else { downShares += traded; nDown += 1; }
  }

  const avgUp = nUp ? upShares / nUp : null;
  const avgDown = nDown ? downShares / nDown : null;
  const round = (v) => (v === null ? null : Number(v.toFixed(4)));

  return {
    avg_uptick_shares: round(avgUp),
    avg_downtick_shares: round(avgDown),
    // NULL rather than Infinity when nothing sold: a ratio with no denominator
    // is not a large ratio, it is an unknown one.
    uptick_ratio: (avgUp !== null && avgDown) ? Number((avgUp / avgDown).toFixed(4)) : null,
    n_upticks: nUp,
    n_downticks: nDown,
    turnover_kd: round(turnover),
    first_half_shares_per_min: firstMinutes.size ? round(firstHalf / firstMinutes.size) : null,
    second_half_shares_per_min: secondMinutes.size ? round(secondHalf / secondMinutes.size) : null,
  };
}

/**
 * FULL, SHORT or CB_ONLY.
 *
 * Fourteen of 29 captured days ended at 12:59 or earlier, so their ranges are
 * as truncated as their closes and nothing said so. Range drives rangeOverCost
 * and several gates, which makes an unmarked short range a wrong gate.
 */
function rangeSource(rows) {
  const usable = rows.filter((r) => {
    if (r.session === null || r.session === undefined) return false;
    return RANGE_SESSIONS.has(String(r.session).trim());
  });
  if (!usable.length) return null;

  const onlyCb = usable.every((r) => String(r.session).trim() === 'CB Auction');
  if (onlyCb) return 'CB_ONLY';

  // Did continuous trading reach 13:10? Kuwait is UTC+3.
  const latest = Math.max(...usable.map((r) => {
    const k = new Date(new Date(r.created_at).getTime() + 3 * 3600_000);
    return k.getUTCHours() * 60 + k.getUTCMinutes();
  }));
  const fullAt = (() => {
    const hhmm = T.get('sd_range_full_hhmm');
    return Math.floor(hhmm / 100) * 60 + (hhmm % 100);
  })();
  return latest >= fullAt ? 'FULL' : 'SHORT';
}

/**
 * The touch spread, in fils and as a percentage.
 *
 * Both, because the raw figure ranks tick bands backwards: EKTTITAB at 0.15
 * fils looks tightest on the board and is 1.5 ticks, wider than GFH at 1.00
 * fils. The percentage is comparable across every symbol and is what
 * rangeOverCost divides by.
 *
 * Volume-gated like every other measure: a spread quoted while nothing trades
 * is a quote, not a cost anyone paid.
 */
function spreadBlock(rows, closePx) {
  const steps = volumeSteps(rows);
  const spreads = [];
  for (const { now } of steps) {
    const bid = n(now.bid);
    const offer = n(now.offer);
    if (bid === null || offer === null || bid <= 0 || offer <= 0) continue;
    const sp = offer - bid;
    if (sp < 0) continue;          // crossed book: a bad read, not a spread
    spreads.push(sp);
  }
  if (!spreads.length) return { avg_spread_fils: null, avg_spread_pct: null };
  const avg = spreads.reduce((t, v) => t + v, 0) / spreads.length;
  return {
    avg_spread_fils: Number(avg.toFixed(4)),
    avg_spread_pct: (closePx && closePx > 0)
      ? Number(((100 * avg) / closePx).toFixed(4)) : null,
  };
}

/** The Kuwait hour carrying the most trades. */
function peakHour(rows) {
  const byHour = new Map();
  for (const { now, traded } of volumeSteps(rows)) {
    const k = new Date(new Date(now.created_at).getTime() + 3 * 3600_000);
    const h = k.getUTCHours();
    byHour.set(h, (byHour.get(h) || 0) + traded);
  }
  if (!byHour.size) return null;
  let best = null;
  let most = -1;
  for (const [h, v] of byHour) if (v > most) { most = v; best = h; }
  return best;
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
  flowBlock,
  spreadBlock,
  peakHour,
  rangeSource,
  closeRow,
  RANGE_SESSIONS,
  CLOSE_TIERS,
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

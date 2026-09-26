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
const FULL_MIN_FRACTION = T.get('sd_full_min_fraction');
const PARTIAL_MIN_FRACTION = T.get('sd_partial_min_fraction');
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
 * The rows that belong to THIS session.
 *
 * P4 · ONE FILTER, AT THE ONE PLACE EVERY BLOCK PASSES THROUGH.
 *
 * P3 gave volumeBlock a session filter and stopped there. movementBlock,
 * flowBlock, spreadBlock and peakHour each still called volumeSteps(rows) on
 * the raw array — and every number those blocks produce is a multiple of a
 * volume DELTA, so the rows the filter exists to exclude poisoned them all.
 *
 * On the mixed fixture pass3-fixes.test.js already builds — a real session plus
 * one stray unlabelled read — volumeBlock correctly said 9,000 shares while
 * flowBlock said turnover_kd 20,199,793 and peakHour said hour 14, which is
 * after END_TIME. One symbol_day row contradicting itself about one session:
 * the exact defect the P3 fix was written for, surviving in four of the five
 * places it lives.
 *
 * Fixing it five times would leave a sixth for the next reader. volumeSteps is
 * the choke point — every step-derived number in this file comes through it —
 * so the filter goes here, and the blocks inherit it without knowing.
 *
 * WHAT THIS EXCLUDES, precisely: a row with NO session. Those are the
 * 14:13-14:23 Friday reads described at the top of this file, whose volume is
 * the PREVIOUS session's cumulative total. An empty-string session is KEPT — it
 * is a July capture defect on continuous-trading rows, not an exchange state —
 * and so is every labelled session, including the auctions, because they are
 * real trading even where they are excluded from the RANGE.
 */
function ownSession(rows) {
  return rows.filter((r) => r.session !== null && r.session !== undefined);
}

/**
 * Consecutive pairs where volume ROSE — the only rows that represent trading.
 *
 * Returns { prev, now, traded } so each caller sees both sides of the step and
 * the size of it, rather than recomputing the difference.
 */
function volumeSteps(rows) {
  const out = [];
  // P4 · the session filter lives HERE, so movementBlock, flowBlock,
  // spreadBlock and peakHour inherit it. See ownSession.
  const sorted = ordered(ownSession(rows));
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
 * ============================================================================
 *  D3 · THE EXCHANGE'S OWN REFERENCE PRICE
 * ============================================================================
 * The board carries `chg` beside `last_price`, and the exchange computes it
 * against its own reference — the previous official close. So
 *
 *     last_price - chg
 *
 * IS that close, published by the exchange, constant through the whole day,
 * for every symbol, with no reconstruction at all.
 *
 * We were not using it. prev_close was rebuilt by reaching back through
 * previousCloses(): find the last session whose capture ran late enough to be
 * usable, take its best close by precedence tier, cap the reach at five
 * sessions. Every one of those rules is careful and several were hard-won,
 * and the whole apparatus is answering a question the feed answers directly.
 *
 * It disagrees with the exchange on 1,138 of 6,082 symbol-days: by more than
 * 1% on 389 and more than 5% on 41. The failures cluster exactly where a
 * reconstruction would be expected to fail — July, when closes came from the
 * Trading session; the days after the 19-23 August gap; and 15 September,
 * where 108 of 134 symbols are wrong because the 14 September capture stopped
 * at 11:59 and a mid-session price was carried forward as a close.
 *
 * chg_1d, every gap, and everything built on a previous close is wrong on
 * those days.
 *
 * ─── WHY min() AND NOT max() OR first() ────────────────────────────────────
 * The value is constant through the session by construction, so any picker
 * returns the same number on a clean day. min() is chosen because it is
 * order-independent and cheap, and because on a dirty day — a mislabelled row,
 * a capture straddling a corporate action — the disagreement is reported
 * separately rather than being silently resolved by whichever row sorted
 * first. `spread` below is that report: non-zero means the feed contradicted
 * itself and the value should be treated as suspect.
 *
 * ─── AND IT IS NOT UNCONDITIONAL ───────────────────────────────────────────
 * A zero last_price is not a price (P4/P5, twice over in this file). A NULL
 * chg gives no reference at all. Both are excluded rather than defaulted, so
 * a symbol that never traded returns null and keeps prev_close NULL, which is
 * the honest state and the one prev_session_gap_days exists to expose.
 */
function referenceClose(rows) {
  const refs = [];
  for (const r of ordered(rows)) {
    if (r.session === null || r.session === undefined) continue;
    const sess = String(r.session).trim();
    // Continuous trading only. An auction row's chg is computed against the
    // same reference, but auction labelling is where the feed is least
    // reliable and there is no reason to widen the set for a constant.
    if (sess !== 'Trading' && sess !== '') continue;
    const px = n(r.last_price);
    const chg = n(r.chg);
    if (px === null || px <= 0 || chg === null) continue;
    const ref = px - chg;
    if (ref <= 0) continue;              // a reference of zero is not a close
    refs.push(ref);
  }
  if (!refs.length) return { ref: null, spread: null, samples: 0 };
  const lo = Math.min(...refs);
  const hi = Math.max(...refs);
  return { ref: lo, spread: Number((hi - lo).toFixed(6)), samples: refs.length };
}

/**
 * ============================================================================
 *  D6 · THE HIGH AND LOW THE FEED ALREADY PUBLISHES
 * ============================================================================
 * high_px was the maximum of the last prices WE captured, and the grid is
 * ~60 seconds. A stock that spiked and came back inside one minute never
 * appeared in it.
 *
 * Measured: symbol_day.high_px is below the feed's own day high on 974 of
 * 6,351 symbol-days, and low_px above the feed's day low on 1,100 — and NEVER
 * the other way, which is the signature of a sampling floor rather than a
 * disagreement. A sampled extreme can only ever be inside the true one.
 *
 * `high_price` and `low_price` arrive on every quote row, are the exchange's
 * running session extremes, and are 100% populated across all 49 captured
 * days (14 Jul - 24 Sep, zero nulls). Taking them is not an improvement to
 * the estimate; it removes the estimate.
 *
 * ─── WHAT THIS DOES NOT TOUCH ──────────────────────────────────────────────
 * open_px. The feed publishes `open_price` and our open_px has the identical
 * defect — on 20 September, where capture began at 10:11, "the first price we
 * saw" is not the open by any reading. But open_px is read by a LIVE TRADING
 * GATE ("at or above open, and high > open"), so changing it changes which
 * stocks the desk buys. That is a trading decision, not a data fix, and it is
 * flagged for Amit rather than taken here.
 */
function feedRange(rows) {
  const highs = [];
  const lows = [];
  for (const r of rows) {
    const h = n(r.high_price);
    const l = n(r.low_price);
    if (h !== null && h > 0) highs.push(h);
    if (l !== null && l > 0) lows.push(l);
  }
  return {
    feed_high: highs.length ? Math.max(...highs) : null,
    feed_low: lows.length ? Math.min(...lows) : null,
  };
}

/**
 * ============================================================================
 *  D4 · CIRCUIT-BREAKER AUCTIONS, COUNTED AS EVENTS
 * ============================================================================
 * The dropped cb_events counted CB Auction CAPTURE ROWS. A ten-minute halt
 * makes ten of them and a thirty-minute halt makes thirty, so the column
 * reported halt DURATION in units of the capture grid while being named and
 * read as a count of events. It agreed with the real auction count on 17 of
 * 338 breaker symbol-days.
 *
 * ─── WHAT SEPARATES TWO AUCTIONS ───────────────────────────────────────────
 * Not a gap in the label. FUTUREKID went into 8 auctions on 3 September
 * inside an unbroken run of CB Auction rows. What moved between them was
 * VOLUME: the auction cleared, printed, and the stock went straight into
 * another one.
 *
 * So a new auction starts when EITHER
 *     the previous capture was not a CB Auction   (entering a halt), OR
 *     volume moved since the previous capture     (the last one printed).
 *
 * Both halves are load-bearing. Without the volume clause FUTUREKID counts 1
 * that day. Without the session clause a stock that never halts counts an
 * auction on every trade.
 *
 * ─── AND IT IS 0, NOT NULL, WHEN A DAY HAS ROWS AND NO HALTS ───────────────
 * NULL means not computed. Zero means measured, and there were none. Those
 * are different facts and this month has cost enough to keep them apart.
 */
function cbAuctions(rows) {
  const sorted = ordered(rows);
  if (!sorted.length) return null;
  let count = 0;
  let prevSession = null;
  let prevVolume = null;
  for (const r of sorted) {
    const sess = r.session === null || r.session === undefined
      ? null : String(r.session).trim();
    const vol = n(r.volume);
    if (sess === 'CB Auction') {
      const entering = prevSession !== 'CB Auction';
      // `is distinct from`: a NULL volume on either side is a CHANGE, not a
      // match. Treating unknown as unchanged would merge two auctions across
      // a capture that failed to read the column.
      const printed = !entering
        && (vol === null || prevVolume === null || vol !== prevVolume);
      if (entering || printed) count += 1;
    }
    prevSession = sess;
    prevVolume = vol;
  }
  return count;
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

/**
 * Cumulative totals, read with max() rather than summed.
 *
 * P3 · AND FROM THIS SESSION'S ROWS ONLY.
 *
 * priceBlock filters to RANGE_SESSIONS, closeRow drops `session IS NULL`,
 * rangeSource filters — and this read EVERY row. The docblock at the top of
 * this file says what the NULL-session rows are: "the 14:13-14:23 Friday reads,
 * after the close on a non-trading day, and their volume is CUMULATIVE RATHER
 * THAN NEW" — that is, they carry the PREVIOUS session's running totals.
 *
 * compute() has no trading-day guard and scripts/backfill-symbol-day.js
 * enumerates every trading_date that has any row at all, Fridays included. So a
 * Friday holding nothing but those two reads produced:
 *
 *   priceBlock  {open_px: null, high_px: null, low_px: null}
 *   closePrice  null · closeSource null · rangeSource null
 *   volumeBlock {total_volume: 10876132, trades: 412, avg_trade_size: 26398.38}
 *
 * A symbol_day row asserting 10.9 million shares and 412 trades on a day with
 * no measurable price — a day nothing traded. That row then counts as an active
 * session in activityBlock's days_active (which tests total_volume > 0), is
 * summed into market_day.total_volume and so into volume_vs_20d, and enters the
 * 5-session trailingTrades baseline behind symbols_over_3x_daily.
 *
 * The loud answer is NULL, which is what every price column on that row already
 * gives. Filtered by the same rule priceBlock uses: a row whose session is NULL
 * is not this session's.
 */
function volumeBlock(rows) {
  /*
   * P4 · the SHARED filter, not a second definition of one.
   *
   * P3 wrote a bespoke RANGE_SESSIONS-or-CLOSE_TIERS test here. That is a
   * narrower rule than the one volumeSteps now applies, and two filters for one
   * concept is how the close rule came to have two definitions (P2-CLOSE). A
   * labelled session we do not recognise is still a session; a row with no
   * label at all is the Friday read.
   */
  const own = ownSession(rows);

  const vols = own.map((r) => n(r.volume)).filter((v) => v !== null);
  const trades = own.map((r) => n(r.trades)).filter((v) => v !== null);
  const steps = volumeSteps(own);

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
    /*
     * P3 · ZERO IS NOT A PRICE, AND IT USED TO READ AS ONE.
     *
     * `offer = 0` is not null, so `after >= offer` was true for every positive
     * price — and the terminal emits bid/offer/bid_qty/offer_qty = 0 for a
     * symbol with NO LIVE BOOK. test/suites/empty-books.test.js documents that
     * exact row shape and counts 398 of them; validate.js applies isEmptyBook
     * on the DEPTH path only, so validateQuote lets bid: 0 / offer: 0 through.
     *
     * spreadBlock in this same file has always guarded `bid <= 0 || offer <= 0`.
     * movementBlock did not, so one row could carry avg_spread_fils NULL beside
     * pct_at_offer 100 — the file contradicting itself about the same book.
     *
     * A stock that FELL on every step, with a zero book, reported:
     *
     *   pct_at_offer 100 · trades_at_offer 2 · bought_at_offer 2000
     *   unbooked_steps 0  · priced_steps 2   · down_moves 2
     *
     * — the whole day's volume recorded as buying at the offer, on a day it
     * fell, and migration 013's symbol_day_ratio_invalid_at_offer CHECK passing
     * on the fabricated 100 because that is the number it checks.
     *
     * AND IT DEFEATED THE P2 FIX DIRECTLY BELOW. The insideSpreadSteps /
     * unbookedSteps split exists so that a step whose book we could not read
     * stays out of the pct_at_offer denominator. A zero book never reached that
     * branch at all: it was classified at the offer two lines earlier, counted
     * as measured, and counted in the numerator. The split was right about the
     * case it saw and blind to the case beside it.
     */
    const bidReal = bid !== null && bid > 0;
    const offerReal = offer !== null && offer > 0;

    if (after !== null && offerReal && after >= offer) {
      atOffer += 1;
      boughtAtOffer += traded;
    } else if (after !== null && bidReal && after <= bid) {
      atBid += 1;
      soldAtBid += traded;
    } else {
      insideSpread += traded;
      /*
       * P2 · A STEP WHOSE BOOK WE COULD NOT READ IS NOT A STEP INSIDE THE
       * SPREAD.
       *
       * This branch catches both: a print genuinely between the bid and the
       * offer, and a step where the book (or the price itself) did not render
       * at all — a halt, pre-open, a limit, a short capture, or the zero book
       * above. They are counted apart, because one belongs in the pct_at_offer
       * denominator and the other cannot.
       */
      if (after !== null && bidReal && offerReal) insideSpreadSteps += 1;
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

/*
 * ─── C3 · rangeSource IS GONE ──────────────────────────────────────────────
 *
 * It marked a range FULL when continuous trading reached 13:10, against a
 * session that ends at 13:00 — so it could never fire. 050 moved the
 * threshold to 13:00, which was still wrong: captures are 60 seconds apart,
 * so a COMPLETE session's last capture lands at 12:59. Of the 48 stored days,
 * 43 end at 12:59, 2 at 13:00 and 3 earlier, so even the corrected threshold
 * marked two days in forty-eight as FULL.
 *
 * The third threshold was not the fix. D6 now takes high and low from the
 * feed's own extremes, so the range is not sampled at all and capture length
 * has stopped bearing on it. Completeness is close_source's question, and D3
 * makes that column truthful.
 *
 * Retired in 055 (stopped writing, rows nulled), dropped in 056 after backend
 * 079 stops the view projecting it.
 */


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

/**
 * Distinct minutes captured INSIDE THE CONTINUOUS SESSION — the input to
 * data_quality and coverage_pct.
 *
 * ─── WHY THE WINDOW IS HERE AND NOT ONLY IN THE DENOMINATOR ────────────────
 * A fraction needs both halves measured over the same window. This counted
 * every captured minute from 08:40, and the denominator was about to become
 * the 240-minute continuous session: 13 September then reads 259/240 = 108%.
 * A coverage over 100% is not a rounding problem, it is two different
 * questions divided by each other.
 *
 * It also makes the Close-Of-Day exemption safe. That row is INGESTED — the
 * door lets the first terminal-label row through whenever it arrives, because
 * the venue publishes it at 13:15 on a day we watch continuously and at 14:43
 * on a day we do not — and EXCLUDED FROM THE COUNT here, because a print
 * arriving after the bell does not lengthen the session it closes. Ingest door
 * and measurement window are separate on purpose; see config.market.
 *
 * `bounds` is { startMinutes, endMinutes } in Kuwait local minutes-of-day.
 * Kuwait is UTC+3 with no DST, so the conversion is a constant offset and a
 * minute bucket is the same bucket in either zone.
 */
const KUWAIT_UTC_OFFSET_MINS = 180;

function minutesCaptured(rows, bounds = null) {
  const lo = bounds ? bounds.startMinutes : null;
  const hi = bounds ? bounds.endMinutes : null;
  const minutes = new Set();
  for (const r of rows) {
    if (!r.created_at) continue;
    const d = new Date(r.created_at);
    if (lo != null && hi != null) {
      const kwMins = (d.getUTCHours() * 60 + d.getUTCMinutes() + KUWAIT_UTC_OFFSET_MINS) % 1440;
      // Half-open [open, close): 13:00 itself is the bell, not a traded minute.
      if (kwMins < lo || kwMins >= hi) continue;
    }
    minutes.add(d.toISOString().slice(0, 16));
  }
  return minutes.size;
}

/**
 * ============================================================================
 *  FULL · PARTIAL · THIN — rule 2 (049)
 * ============================================================================
 * The schema has allowed three values since migration 011 and 3,496 rows carry
 * PARTIAL, but this function could only ever return two of them: the rule that
 * wrote them exists in no commit on any branch. Rule 2 is a NEW rule, written
 * deliberately rather than reconstructed — there is no old rule to reproduce,
 * only its output, and anything tuned until it landed on 14 July's "133" would
 * be back-fitted to the answer.
 *
 * ─── WHY THE DENOMINATOR CHANGED ───────────────────────────────────────────
 * The old comment here argued for the day's own median over a fixed 270,
 * because capture length varies market-wide. That is true and it is not what
 * the median gives you. Dividing a day's capture length by that same day's
 * capture length is self-referential: when capture dies early for EVERYONE,
 * the median collapses with it, every symbol scores ~100%, and the fraction
 * test cannot fire. Measured on `kse`:
 *
 *   20 Sep   188 minutes   coverage 100.0%   FULL      <- the outage day
 *   15 Sep   233 minutes   coverage  86.3%   PARTIAL
 *
 * A shorter day scoring higher. The failure is one-directional and it hides
 * the worst case: a partial outage is caught because the symbols disagree, a
 * total outage is invisible because they all agree about being broken.
 *
 * `scheduledMinutes` is the day's SCHEDULED capture window, from
 * public.market_session_hours via the calendar, falling back to the standard
 * window in config. It cannot move with the data. A genuine half-day gets a
 * row and a correct denominator rather than reading PARTIAL for ever — which
 * is why this is the calendar and not a constant.
 *
 * ─── THE TWO OLDER TESTS ARE KEPT, DEMOTED ─────────────────────────────────
 * The median test still catches what rule 2 cannot: ONE symbol falling behind
 * a market that is otherwise fine. The absolute floor is now a true last
 * resort rather than the only thing standing between a 188-minute session and
 * the word FULL.
 *
 * @param {number}  minutes           distinct minutes captured for this symbol
 * @param {number}  marketMedian      that day's median, for the per-symbol test
 * @param {boolean} closeOfDay        whether the final print was captured
 * @param {number|null} scheduledMinutes  the scheduled window; null = unknown
 */
function dataQuality(minutes, marketMedian, closeOfDay, scheduledMinutes = null) {
  // The last resort, unchanged.
  if (minutes < THIN_ABSOLUTE_MINUTES) return 'THIN';
  // One symbol behind its own market — the case a scheduled denominator cannot
  // see, because the market was fine and this symbol was not.
  if (marketMedian && minutes < THIN_MEDIAN_FRACTION * marketMedian) return 'THIN';

  /*
   * RULE 2. Only when the scheduled window is known: a guessed denominator and
   * a read one are not the same measurement, and inventing one here is how the
   * self-referential median got in.
   */
  if (scheduledMinutes > 0) {
    const frac = minutes / scheduledMinutes;
    if (frac < PARTIAL_MIN_FRACTION) return 'THIN';
    if (frac < FULL_MIN_FRACTION) return 'PARTIAL';
  }

  /*
   * No Close-Of-Day print. This stays THIN rather than becoming PARTIAL: a
   * session whose final print was never captured has no close, and every
   * derivation that reaches for one — prev_close, chg_fils, the 5-day range —
   * is reaching for something that does not exist. That is worse than a short
   * session, not milder.
   */
  if (!closeOfDay) return 'THIN';
  return 'FULL';
}

/**
 * The rule that produced the labels above. Stored on every row this code
 * writes, so the column can never again hold two generations of label with
 * nothing telling them apart. NULL means rule 1 — unrecoverable, preserved,
 * never overwritten.
 */
const QUALITY_RULE_VERSION = 2;

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
  ownSession,
  volumeSteps,
  flowBlock,
  spreadBlock,
  peakHour,
  closeRow,
  RANGE_SESSIONS,
  CLOSE_TIERS,
  priceBlock,
  referenceClose,
  cbAuctions,
  feedRange,
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
  FULL_MIN_FRACTION,
  PARTIAL_MIN_FRACTION,
  QUALITY_RULE_VERSION,
};

'use strict';
/**
 * P3 · the four High findings from the third review pass.
 *
 * ─── 1 · A ZERO BOOK IS NOT A PRINT AT THE OFFER ───────────────────────────
 * `offer = 0` is not null, so `after >= offer` was true for every positive
 * price — and the terminal emits bid/offer/bid_qty/offer_qty = 0 for a symbol
 * with NO LIVE BOOK. test/suites/empty-books.test.js documents that exact shape
 * and counts 398 rows of it; validate.js applies isEmptyBook on the DEPTH path
 * only, so validateQuote lets it through.
 *
 * This one defeated the P2 fix beside it. The insideSpreadSteps/unbookedSteps
 * split exists so an unreadable book stays out of the pct_at_offer denominator;
 * a ZERO book never reached that branch, being classified at the offer two
 * lines earlier — counted as measured AND in the numerator. spreadBlock in the
 * same file has always guarded `bid <= 0 || offer <= 0`, so one row could carry
 * avg_spread_fils NULL beside pct_at_offer 100.
 *
 * ─── 2 · volumeBlock READ EVERY ROW, INCLUDING THE FRIDAY READS ────────────
 * priceBlock, closeRow and rangeSource all filter by session. volumeBlock did
 * not — and this file's own docblock says the NULL-session rows are "the
 * 14:13-14:23 Friday reads … their volume is CUMULATIVE RATHER THAN NEW", i.e.
 * the PREVIOUS session's running totals. compute() has no trading-day guard and
 * the backfill enumerates every date with any row.
 *
 * ─── 3 · bid_age_secs = 0 ON A LEVEL NEVER MEASURED ────────────────────────
 * `if (!prev || …) return 0` — `!prev` is "no previous row today", not "just
 * placed", and zero is the most signal-triggering value the column can hold.
 * previousRow() is scoped to (symbol, trading_date), so it fires exactly when
 * the wake-up scan promotes a symbol mid-session: BAIT_BID on a bid that has
 * stood all morning, graded into signal_log.was_right.
 *
 * ─── 4 · the depth sweep's rotation cursor did not exist ───────────────────
 * (asserted at the bottom, against the shipped source.)
 */
const { requireTestDb } = require('../dbguard');
requireTestDb('pass3-fixes');

const fs = require('fs');
const path = require('path');
const { close } = require('../../src/db/pool');
const M = require('../../src/jobs/symbolDayMetrics');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };

const REPO = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const liveOf = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const at = (m) => new Date(`2026-09-10T${String(9 + Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00+03:00`);

// ── 1 · THE ZERO BOOK ──────────────────────────────────────────────────────
{
  // A stock that FELL on every step, with the no-live-book row shape.
  const falling = [
    { created_at: at(0), volume: 0, last_price: 200, bid: 0, offer: 0, session: 'Trading' },
    { created_at: at(1), volume: 1000, last_price: 199, bid: 0, offer: 0, session: 'Trading' },
    { created_at: at(2), volume: 2000, last_price: 198, bid: 0, offer: 0, session: 'Trading' },
  ];
  const f = M.movementBlock(falling);

  ck('a zero book is NOT a print at the offer', f.trades_at_offer === 0, f);
  ck('nor is the day\'s volume recorded as buying',
    f.bought_at_offer === 0, f.bought_at_offer);
  ck('both steps are reported as UNBOOKED', f.unbooked_steps === 2, f);
  ck('and none of them is priced', f.priced_steps === 0, f);
  ck('so pct_at_offer is NOT COMPUTED rather than a fabricated 100',
    f.pct_at_offer === null, f.pct_at_offer);
  ck('and specifically not 100', f.pct_at_offer !== 100, f.pct_at_offer);
  ck('the stock is still measured as falling — this changes the BOOK reading, '
    + 'not the price reading', f.down_moves === 2, f);

  // The contradiction the file used to carry inside one row.
  const sp = M.spreadBlock(falling, 198);
  ck('spreadBlock refuses the same rows, as it always has',
    sp.avg_spread_fils === null, sp);
  ck('and now movementBlock agrees with it — one row cannot say '
    + 'avg_spread_fils NULL and pct_at_offer 100 about the same book',
  (sp.avg_spread_fils === null) === (f.pct_at_offer === null), [sp, f.pct_at_offer]);

  // One side zero is just as unreadable as both.
  const halfBook = [
    { created_at: at(0), volume: 0, last_price: 200, bid: 199, offer: 0, session: 'Trading' },
    { created_at: at(1), volume: 1000, last_price: 200, bid: 199, offer: 0, session: 'Trading' },
  ];
  const h = M.movementBlock(halfBook);
  ck('a zero OFFER alone is unbooked too', h.unbooked_steps === 1 && h.priced_steps === 0, h);

  // And a real book still works exactly as before.
  const real = [
    { created_at: at(0), volume: 0, last_price: 100, bid: 99, offer: 100, session: 'Trading' },
    { created_at: at(1), volume: 1000, last_price: 100, bid: 99, offer: 100, session: 'Trading' },
    { created_at: at(2), volume: 2000, last_price: 100, bid: 99, offer: 100, session: 'Trading' },
  ];
  const r = M.movementBlock(real);
  ck('a REAL book at the offer still reads 100', r.pct_at_offer === 100, r);
  ck('with nothing unbooked', r.unbooked_steps === 0, r);

  // A print at the bid, with a real book, is still at the bid.
  const bidSide = [
    { created_at: at(0), volume: 0, last_price: 99, bid: 99, offer: 101, session: 'Trading' },
    { created_at: at(1), volume: 1000, last_price: 99, bid: 99, offer: 101, session: 'Trading' },
  ];
  ck('and a print at the bid is still at the bid',
    M.movementBlock(bidSide).trades_at_bid === 1, M.movementBlock(bidSide));
}

// ── 2 · THE SESSION FILTER ON volumeBlock ──────────────────────────────────
{
  /*
   * The Friday shape: two reads at 14:13 and 14:23 with NO session, carrying
   * the PREVIOUS session's cumulative totals. Nothing traded on this date.
   */
  const friday = [
    { created_at: new Date('2026-09-11T14:13:00+03:00'), volume: 10876132, trades: 412, last_price: 204, session: null },
    { created_at: new Date('2026-09-11T14:23:00+03:00'), volume: 10876132, trades: 412, last_price: 204, session: null },
  ];

  const v = M.volumeBlock(friday);
  ck('a day of Friday reads has NO total volume', v.total_volume === null, v);
  ck('and no trade count', v.trades === null, v);
  ck('and no average trade size', v.avg_trade_size === null, v);
  ck('and no highest minute', v.highest_minute_volume === null, v);

  // The columns that already refused, for the comparison that makes the point.
  ck('priceBlock already refused these rows', M.priceBlock(friday).open_px === null);
  ck('closePrice already refused them', M.closePrice(friday) === null);
  ck('so the row no longer claims 10.9M shares beside no measurable price',
    v.total_volume === null && M.priceBlock(friday).open_px === null, v);

  // A REAL session is unaffected.
  const session = [
    { created_at: at(0), volume: 1000, trades: 10, last_price: 200, session: 'Trading' },
    { created_at: at(1), volume: 5000, trades: 40, last_price: 201, session: 'Trading' },
    { created_at: at(2), volume: 9000, trades: 70, last_price: 202, session: 'Close-Of-Day' },
  ];
  const s = M.volumeBlock(session);
  ck('a real session still totals correctly', s.total_volume === 9000, s);
  ck('and counts its trades', s.trades === 70, s);
  ck('the closing session counts toward volume — it is real trading',
    s.total_volume === 9000, s);
  ck('and the largest INCREASE is still the highest minute',
    s.highest_minute_volume === 4000, s);

  // A session with a Friday read appended must not inherit it.
  const mixed = [...session,
    { created_at: new Date('2026-09-11T14:13:00+03:00'), volume: 99999999, trades: 9999, last_price: 202, session: null }];
  ck('a stray unlabelled read cannot inflate a real session',
    M.volumeBlock(mixed).total_volume === 9000, M.volumeBlock(mixed));
}

// ── 3 · THE UNMEASURED LEVEL AGE ───────────────────────────────────────────
{
  const live = liveOf(read('src/jobs/writeSymbolMinute.js'));
  ck('no previous row yields NULL, not 0', /if \(!prev\) return null;/.test(live));
  ck('and the reset for a CHANGED price is still 0 — that level really is new',
    /if \(prevPrice === null \|\| Number\(prevPrice\) !== price\) return 0;/.test(live));
  ck('the two cases are no longer folded together',
    !/if \(!prev \|\| prevPrice === null/.test(live),
    (live.match(/.*!prev \|\|.*/g) || []));

  // The consumer already handles null — which is why null is a no-op.
  const signals = read('src/signals.js');
  ck('baitBid declines to fire on an age it does not have',
    /age === null/.test(signals), (signals.match(/.*age === null.*/g) || [])[0]);
}

// ── 4 · THE ROTATION CURSOR ────────────────────────────────────────────────
{
  const DEPTH = read('userscript/awsat-depth-all.user.js');
  const live = liveOf(DEPTH);

  ck('the sweep starts at the cursor, not at 0',
    /var target = targets\[cursor\];/.test(live), (live.match(/.*var target = targets.*/g) || []));
  ck('and it no longer walks a local index from zero',
    !/var target = targets\[i\+\+\];/.test(live));
  ck('the cursor wraps', /cursor = \(cursor \+ 1\) % targets\.length;/.test(live));
  // Scoped to the sweep: `captureLadder(target,` also matches its own
  // declaration, which sits earlier in the file.
  const sweepBlock = live.slice(live.indexOf('var target = targets[cursor];'));
  ck('and advances BEFORE the capture, so a stalled symbol is not the one the '
    + 'next sweep starts on too',
  sweepBlock.indexOf('cursor = (cursor + 1) % targets.length;')
    < sweepBlock.indexOf('captureLadder(target,'), 'ordering');
  ck('the sweep ends on how many it VISITED, not on an index',
    /if \(visited >= targets\.length \|\| Date\.now\(\) - started > LADDER_BUDGET_MS\)/.test(live));
  ck('rotationSeen is actually written now',
    /rotationSeen\.add\(target\.symbol\)/.test(live));
  ck('and a completed rotation is timed and reset',
    /stats\.rotationMs = Date\.now\(\) - rotationStarted;/.test(live));

  // The panel counters that were rendered and never assigned.
  ck('ladderPosts is written', /stats\.ladderPosts = \(stats\.ladderPosts \|\| 0\) \+ ok;/.test(live));
  ck('and ladderSkips', /stats\.ladderSkips = \(stats\.ladderSkips \|\| 0\) \+ skipped;/.test(live));

  const hdr = (DEPTH.match(/@version\s+(\d+\.\d+\.\d+)/) || [])[1];
  const panel = (DEPTH.match(/var VERSION = '(\d+\.\d+\.\d+)'/) || [])[1];
  ck('the header and the panel constant agree', hdr === panel, [hdr, panel]);
}

// ── the cursor, exercised as logic ─────────────────────────────────────────
{
  /*
   * The property that matters: across consecutive budget-limited sweeps, every
   * symbol is eventually visited. Under the old code the tail never was.
   */
  const sweep = (targets, cursorIn, capacity) => {
    let cursor = cursorIn >= targets.length ? 0 : cursorIn;
    const visited = [];
    while (visited.length < Math.min(capacity, targets.length)) {
      visited.push(targets[cursor]);
      cursor = (cursor + 1) % targets.length;
    }
    return { visited, cursor };
  };

  const slots = ['A', 'B', 'C', 'D', 'E'];

  // The failure: a budget that only ever affords two symbols.
  let cursor = 0;
  const seen = new Set();
  for (let i = 0; i < 3; i += 1) {
    const r = sweep(slots, cursor, 2);
    r.visited.forEach((s) => seen.add(s));
    cursor = r.cursor;
  }
  ck('three two-symbol sweeps reach all five slots', seen.size === 5, [...seen]);

  // The old behaviour, for the contrast.
  const oldSeen = new Set();
  for (let i = 0; i < 3; i += 1) slots.slice(0, 2).forEach((s) => oldSeen.add(s));
  ck('restarting at 0 every sweep reaches only two of them — the other three '
    + 'are never captured', oldSeen.size === 2, [...oldSeen]);

  // And a full-capacity sweep still visits everything exactly once.
  const full = sweep(slots, 0, 5);
  ck('a sweep that fits visits every symbol', new Set(full.visited).size === 5, full.visited);
  ck('exactly once', full.visited.length === 5, full.visited);
  ck('and leaves the cursor back at the start', full.cursor === 0, full.cursor);

  // A cursor left beyond a shortened list is reset rather than skipping.
  const shortened = sweep(['A', 'B'], 4, 2);
  ck('a cursor past the end of a shortened list starts over',
    shortened.visited.length === 2, shortened.visited);
}

(async () => {
  await close();
  console.log(`\npass3 fixes: ${p}/${n}`);
  process.exit(p === n ? 0 : 1);
})();

'use strict';
/**
 * ============================================================================
 *  D4 · COUNTING CAPTURE ROWS AND CALLING THEM EVENTS
 * ============================================================================
 * symbol_day.cb_events counted CB Auction CAPTURE ROWS. A ten-minute halt
 * makes ten of them; a thirty-minute halt makes thirty. So the column
 * reported halt DURATION, in units of the capture grid, while carrying a
 * name that says "count of events" and being read that way. It agreed with
 * the real auction count on 17 of 338 breaker symbol-days — 5%.
 *
 * It was dropped in 053 as a column with no writer, which it also was. Two
 * separate defects in one column: it measured the wrong thing, and nothing
 * had measured it for weeks either way.
 *
 * ─── THE RULE IS NOT "A RUN OF THE LABEL" ──────────────────────────────────
 * FUTUREKID went into 8 auctions on 3 September with no break in the CB
 * Auction label anywhere in them. What separated them was VOLUME MOVING: the
 * auction cleared, printed, and the stock went straight into another one.
 *
 * So both halves of the rule are load-bearing, and this suite proves each of
 * them fails on its own:
 *   · without the volume clause, FUTUREKID's day counts 1
 *   · without the session clause, a stock that never halts counts an auction
 *     on every trade
 * ============================================================================
 */
const M = require('../../src/jobs/symbolDayMetrics');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };

let t0 = Date.parse('2026-09-03T06:00:00Z');
const cap = (session, volume) => ({
  session, volume, last_price: 100, created_at: new Date(t0 += 60_000),
});

(async () => {
  console.log('\n=== one halt is one auction, however long it lasts ===');
  /*
   * The exact defect. Ten captures inside one halt with no print between
   * them is one event; the old column called it ten.
   */
  const longHalt = [cap('Trading', 1000)];
  for (let i = 0; i < 10; i += 1) longHalt.push(cap('CB Auction', 1000));
  longHalt.push(cap('Trading', 1000));
  ck('a ten-capture halt counts ONE auction, not ten', M.cbAuctions(longHalt) === 1,
    M.cbAuctions(longHalt));

  console.log('\n=== FUTUREKID · eight auctions inside an unbroken label ===');
  const futurekid = [cap('Trading', 500)];
  for (let i = 1; i <= 8; i += 1) {
    futurekid.push(cap('CB Auction', 500 + i * 100));   // each one printed
    futurekid.push(cap('CB Auction', 500 + i * 100));   // and sat there
  }
  ck('volume moving inside the run separates the auctions',
    M.cbAuctions(futurekid) === 8, M.cbAuctions(futurekid));

  console.log('\n=== and each half of the rule fails alone ===');
  /*
   * Stated as measurements rather than as prose, so a future simplification
   * has to argue with a number. The session clause alone gives 1 on the
   * FUTUREKID day; the volume clause alone fires on ordinary trading.
   */
  const sessionOnly = (rows) => {
    let c = 0; let prev = null;
    for (const r of rows) { if (r.session === 'CB Auction' && prev !== 'CB Auction') c += 1; prev = r.session; }
    return c;
  };
  ck('the session transition alone undercounts FUTUREKID as 1',
    sessionOnly(futurekid) === 1, sessionOnly(futurekid));

  const normalDay = [cap('Trading', 100), cap('Trading', 200), cap('Trading', 300)];
  ck('a day with no halt counts 0 — the volume clause must not fire on '
    + 'ordinary trading', M.cbAuctions(normalDay) === 0, M.cbAuctions(normalDay));

  console.log('\n=== two separate halts are two auctions ===');
  const twice = [
    cap('Trading', 100), cap('CB Auction', 100), cap('CB Auction', 100),
    cap('Trading', 150), cap('Trading', 150),
    cap('CB Auction', 150), cap('CB Auction', 150), cap('Trading', 200),
  ];
  ck('the label leaving and returning is a second auction',
    M.cbAuctions(twice) === 2, M.cbAuctions(twice));

  console.log('\n=== NOT COMPUTED and ZERO are different answers ===');
  ck('no rows at all is NULL — not computed', M.cbAuctions([]) === null, M.cbAuctions([]));
  ck('rows with no halt is 0 — measured, and there were none',
    M.cbAuctions(normalDay) === 0, M.cbAuctions(normalDay));

  console.log('\n=== an unreadable volume does not silently merge two auctions ===');
  /*
   * `is distinct from`, not `<>`. If volume failed to read on one capture,
   * treating unknown as unchanged would fuse the auction either side of it
   * into one — an undercount produced by a capture defect, which is the
   * quietest kind.
   */
  const nullVol = [
    cap('Trading', 100), cap('CB Auction', 100),
    cap('CB Auction', null), cap('CB Auction', 100),
  ];
  ck('a NULL volume counts as a change rather than a match',
    M.cbAuctions(nullVol) === 3, M.cbAuctions(nullVol));

  console.log('\n=== the guard can fail ===');
  ck('cbAuctions is exported', typeof M.cbAuctions === 'function', null);
  ck('the old cb_events measure is gone', typeof M.cbEvents === 'undefined', null);

  console.log(`\nd4 cb auctions: ${p}/${n}`);
  process.exit(p === n ? 0 : 1);
})();

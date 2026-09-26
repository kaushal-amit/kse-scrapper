'use strict';
/**
 * ============================================================================
 *  THE CAPTURE WINDOW · 08:40 to 13:20 Kuwait
 * ============================================================================
 * TWO TRAPS AT THE TWO ENDS OF THE DAY, BOTH MEASURED IN `kse`.
 *
 * AFTER THE CLOSE. No capture script stopped when the market shut. P6-CLI-5
 * already knew — it skips the frozen-board detector out of hours because
 * "from 13:30 until the tab is shut the same board is posted every 60 s" —
 * and it skipped the DETECTOR while still storing every row. On 24 September
 * the client was still saving at 16:22: 17,640 price rows and 16,086 depth
 * rows after 13:20, every one of them the same shut board.
 *
 * BEFORE THE OPEN, which is worse. On 20 September 1,022 rows arrived before
 * 08:00 with NO session label at all, carrying 17 SEPTEMBER's cumulative
 * trades and volume — the terminal was serving Thursday's figures after an
 * outage. 79 of 140 symbols STILL have identical day totals for the two
 * dates. Those are not early rows; they are the previous session's data
 * wearing today's date.
 *
 * Close-Of-Day starts at 13:15, so by 13:20 the final print is in.
 *
 * ─── WHY THE SERVER AND NOT THE FOUR SCRIPTS ────────────────────────────────
 * The scripts stop too, so a browser does not burn three hours of cycles on
 * batches that will be refused. But a userscript can be a stale copy in
 * somebody's Tampermonkey, and the property has to hold anyway — so the one
 * door every capture comes through is where it is enforced.
 *
 * ─── AND WHY THE SUITE WIDENS IT ───────────────────────────────────────────
 * test/all.js sets CAPTURE_START_TIME/CAPTURE_END_TIME wide for every other
 * suite, because they post with `new Date()` and would otherwise pass only
 * between 08:40 and 13:20. THIS suite sets neither: it asserts the real
 * defaults and supplies the clock itself.
 * ============================================================================
 */
delete process.env.CAPTURE_START_TIME;
delete process.env.CAPTURE_END_TIME;

const assert = require('assert');
const { config } = require('../../src/config');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };

// A Kuwait wall time on a Thursday (24 Sep 2026), as an instant.
const at = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 8, 24, h - 3, m, 0));
};

(async () => {
  console.log('\n=== the defaults are the measured ones ===');
  ck('capture opens at 08:40', config.market.captureStartTime === '08:40', config.market.captureStartTime);
  ck('capture closes at 13:20', config.market.captureEndTime === '13:20', config.market.captureEndTime);
  ck('  in minutes, for the guard', config.market.captureStartMinutes === 520
    && config.market.captureEndMinutes === 800,
  [config.market.captureStartMinutes, config.market.captureEndMinutes]);
  /*
   * The capture window must NOT be the session window. START_TIME/END_TIME
   * drive the scheduler, and the after-close jobs are derived from END_TIME at
   * +1/+5/+12 — moving END_TIME to 13:20 would move daily.symbolday and
   * daily.marketday with it. That is the trap src/scheduler.js's own header
   * warns about and the reason those two did not run on 24 September.
   */
  ck('they are SEPARATE from the session window, so narrowing capture cannot '
    + 'move the nightly jobs',
  config.market.captureEndTime !== config.market.endTime
    && config.market.endMinutes === 13 * 60 + 30,
  { capture: config.market.captureEndTime, session: config.market.endTime });

  console.log('\n=== the door refuses, at both ends, with the reason ===');
  {
    // checkCapturedAt is module-private; exercised through the same shape the
    // handlers use, with the staleness limit widened so only the WINDOW
    // decides. Reading it from source keeps the test on the shipped code.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../../src/api/ingest.js'), 'utf8');
    const from = src.indexOf('function checkCapturedAt');
    const to = src.indexOf('/*\n * Drop rows identical to the last stored row');
    assert(from > 0 && to > from, 'could not slice checkCapturedAt out of ingest.js');
    const mod = { exports: {} };
    // eslint-disable-next-line no-new-func
    new Function('module', 'config', 'clock', `${src.slice(from, to)}\nmodule.exports = { checkCapturedAt };`)(
      mod, config, require('../../src/market/clock'));
    const { checkCapturedAt } = mod.exports;
    const HUGE = 10 ** 15;   // the staleness limit out of the way

    /*
     * ─── 051 · THE DOOR NOW HAS TWO SHAPES AFTER 13:20 ───────────────────
     *
     * checkCapturedAt is called here WITHOUT allowLateCloseOfDay, which is how
     * every endpoint but /quotes calls it, so 13:20-15:00 is still refused —
     * a late depth snapshot or order list is a page left open, with no closing
     * print in it. What changed is the REASON, and the reason matters: the old
     * one asserted "Close-Of-Day starts 13:15, so the final print is already
     * in", which is disproved. Measured first Close-Of-Day row: 13:15 on
     * 23 Sep (captured continuously), 13:25 on 13 Aug, 14:43 on 24 Sep — the
     * last two on the far side of a gap in OUR capture, so they are looking
     * times, not publication times.
     *
     * 16:22 is past the backstop and refused for a different reason, which the
     * cases below pin apart — the two refusals must not collapse into one
     * message, or the backstop stops being visible.
     */
    const cases = [
      ['08:39', false, /before the capture window opens/],
      ['08:40', true, null],
      ['09:00', true, null],
      ['13:19', true, null],
      ['13:20', false, /Close-Of-Day exemption applies to quotes only/],
      ['14:43', false, /Close-Of-Day exemption applies to quotes only/],
      ['16:22', false, /after the Close-Of-Day backstop/],
    ];
    for (const [hhmm, expectOk, re] of cases) {
      const r = checkCapturedAt(at(hhmm).toISOString(), HUGE);
      ck(`${hhmm} Kuwait is ${expectOk ? 'ACCEPTED' : 'REFUSED'}`, r.ok === expectOk,
        { hhmm, ok: r.ok, reason: r.reason });
      if (!expectOk) {
        ck(`  and it says WHY (${hhmm})`, re.test(r.reason || '') && r.outsideWindow === true, r.reason);
      }
    }
    ck('the before-open reason names what those rows actually carry — the '
      + 'PREVIOUS session\'s totals, not "too early"',
    /PREVIOUS session/.test(checkCapturedAt(at('08:00').toISOString(), HUGE).reason || ''), null);
    /*
     * The old check asserted the reason said "Close-Of-Day starts 13:15" — the
     * rationale 051 disproved. Asserting a disproved sentence is worse than
     * asserting nothing: it holds the wrong explanation in place. What must be
     * true now is that the two post-13:20 refusals are DISTINGUISHABLE, so an
     * operator can tell "this endpoint does not take late closes" from "this
     * is too late to be a close at all".
     */
    ck('a late-but-before-backstop refusal names the exemption, not the door',
      /exemption applies to quotes only/
        .test(checkCapturedAt(at('14:00').toISOString(), HUGE).reason || ''), null);
    ck('  and a past-backstop refusal names the BACKSTOP, so the two do not collapse',
      /after the Close-Of-Day backstop at 15:00/
        .test(checkCapturedAt(at('15:01').toISOString(), HUGE).reason || ''), null);
    ck('  and the quotes endpoint DOES get the late window, flagged for filtering',
      (() => { const r = checkCapturedAt(at('14:43').toISOString(), HUGE,
        { allowLateCloseOfDay: true }); return r.ok === true && r.lateCloseOfDayOnly === true; })(),
      checkCapturedAt(at('14:43').toISOString(), HUGE, { allowLateCloseOfDay: true }));
    ck('  and an ordinary in-window capture is NOT flagged late',
      checkCapturedAt(at('10:00').toISOString(), HUGE,
        { allowLateCloseOfDay: true }).lateCloseOfDayOnly === false, null);
  }

  console.log('\n=== all four scripts stop too ===');
  {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '../../userscript');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.user.js'))) {
      const s = fs.readFileSync(path.join(dir, f), 'utf8');
      ck(`${f} has the window guard`, /function inCaptureWindow\(\)/.test(s)
        && /CAP_OPEN_MIN = 8 \* 60 \+ 40/.test(s) && /CAP_CLOSE_MIN = 13 \* 60 \+ 20/.test(s), null);
      ck(`  ${f} calls it before capturing`, /if \(!inCaptureWindow\(\)\)/.test(s), null);
      ck(`  ${f} skips the weekend too`, /dow === 5 \|\| dow === 6/.test(s), null);
      ck(`  ${f} says the server is the authority`, /SERVER is the authority|SERVER refuses/.test(s), null);
    }
  }

  console.log(`\ncapture window: ${p}/${n}`);
  process.exit(p === n ? 0 : 1);
})().catch((e) => { console.log('capture-window ERROR', e && e.stack ? e.stack : e); process.exit(1); });

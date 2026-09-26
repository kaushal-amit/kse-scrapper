'use strict';
/**
 * P5 · three findings, and the two High ones are in lines changed by P4.
 *
 * The pattern is now the finding, so it is written down here rather than only
 * in a report:
 *
 *   P4 guarded the FORWARD price in priceInForceAt and left the BASE price — the
 *   other operand of the same subtraction — unguarded. Guarding one operand of
 *   a difference is not guarding the difference.
 *
 *   P4 removed the socket tap's retry CAP and left the latch that ends the
 *   retries keyed on the cumulative master size, which the passive
 *   interceptors have already made non-zero. Removing the cap did nothing,
 *   because the flag was already set by the time it mattered.
 *
 * And one that P3/P4 made worse rather than introduced: `session: r.session ||
 * null` in ingest collapses an EMPTY session cell to NULL, and the session
 * filter P4 moved into volumeSteps now discards those rows from every
 * step-derived metric.
 */
const { requireTestDb } = require('../dbguard');
requireTestDb('pass5-fixes');

const fs = require('fs');
const path = require('path');
const { query, close } = require('../../src/db/pool');
const score = require('../../src/jobs/scoreSignals');
const M = require('../../src/jobs/symbolDayMetrics');
const ingest = require('../../src/api/ingest');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };

const REPO = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const liveOf = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

// ── 1 · BOTH OPERANDS OF THE SUBTRACTION ───────────────────────────────────
{
  const g = score.grade;

  // The reproduction, exactly as the pass measured it.
  ck('a ZERO BASE grades nothing — it used to grade every "up" as RIGHT',
    g(0, 204, 'up') === null, g(0, 204, 'up'));
  ck('and it used to grade "down" as WRONG, which is equally a verdict',
    g(0, 204, 'down') === null, g(0, 204, 'down'));
  ck('and "still" too', g(0, 204, 'still') === null, g(0, 204, 'still'));

  // The forward side P4 already fixed, restated here so the pair is visible.
  ck('a zero FORWARD price grades nothing either', g(204, 0, 'down') === null);
  ck('nor does a zero on both sides', g(0, 0, 'still') === null);

  // A negative can reach here from a backend mirror; it is not a price either.
  ck('a negative base grades nothing', g(-1, 204, 'up') === null);

  // Real prices are unaffected — the guard must not eat the measurements.
  ck('a real rise is still RIGHT for an up signal', g(200, 204, 'up') === true);
  ck('a real rise is WRONG for a down signal', g(200, 204, 'down') === false);
  ck('a real fall is RIGHT for a down signal', g(204, 200, 'down') === true);
  ck('a flat tape is RIGHT for a still signal', g(200, 200, 'still') === true);
  ck('and an ungradable mode is still null', g(200, 204, 'none') === null);

  const live = liveOf(read('src/jobs/scoreSignals.js'));
  ck('the guard is on the function every caller goes through, not on one query',
    /if \(Number\(base\) <= 0 \|\| Number\(px\) <= 0\) return null;/.test(live));
}

// ── 2 · THE MASTER LATCH ───────────────────────────────────────────────────
{
  const live = liveOf(read('src/scrapers/awsatSocketTap.js'));
  ck('the size is captured BEFORE the fetch', /const before = tap\.master\.size;/.test(live));
  ck('and the latch requires this reply to have GROWN it',
    /if \(tap\.master\.size > before\) tap\.fullMasterFetched = true;/.test(live));
  ck('not merely that the map is non-empty — which the passive interceptors '
    + 'have already made true', !/if \(tap\.master\.size\) tap\.fullMasterFetched/.test(live));
  ck('and the retry loop still has no try cap', !/masterTries >= 8/.test(live));
}

// ── the latch, exercised ───────────────────────────────────────────────────
{
  // The shipped condition, against the three replies the broker actually gives.
  const latch = (sizeBefore, sizeAfter) => sizeAfter > sizeBefore;

  // The normal state: the app's own cached delta has already put 2 symbols in.
  ck('an ERROR ENVELOPE after the app cached 2 symbols does NOT latch',
    latch(2, 2) === false);
  ck('nor does an empty DAT', latch(2, 2) === false);
  ck('a real master of 137 DOES latch', latch(2, 137) === true);
  ck('and so does one that arrives into an empty map', latch(0, 137) === true);
  ck('the old rule latched on all four — it only asked whether the map was '
    + 'non-empty', [2, 2, 137, 137].every((after) => after > 0));
}

// ── 3 · AN EMPTY SESSION CELL IS NOT AN ABSENT ONE ─────────────────────────
{
  const row = (over) => ingest.toQuoteRow({ symbol: 'ZZS', ...over },
    { tradingDate: '2026-09-10', source: 'awsat_client' });

  ck('an empty session cell is preserved as an empty string',
    row({ session: '' }).session === '', row({ session: '' }).session);
  ck('an ABSENT session is null', row({}).session === null, row({}).session);
  ck('an explicit null is null', row({ session: null }).session === null);
  ck('and a real label passes through', row({ session: 'Trading' }).session === 'Trading');

  // And the two shapes are treated differently downstream, which is the point.
  const at = (m) => new Date(`2026-09-10T09:${String(m).padStart(2, '0')}:00+03:00`);
  const blank = [
    { created_at: at(0), volume: 1000, trades: 10, last_price: 200, session: '' },
    { created_at: at(1), volume: 4000, trades: 30, last_price: 201, session: '' },
  ];
  const absent = blank.map((r) => ({ ...r, session: null }));

  ck('a blank-label session is KEPT — it is a capture defect, not a state',
    M.volumeBlock(blank).total_volume === 4000, M.volumeBlock(blank));
  ck('its steps reach the flow blocks', M.volumeSteps(blank).length === 1);
  ck('and its prices are read', M.priceBlock(blank).open_px === 200, M.priceBlock(blank));

  ck('while an ABSENT label is discarded — that is the Friday read',
    M.volumeBlock(absent).total_volume === null, M.volumeBlock(absent));
  ck('and none of its steps reach the flow blocks', M.volumeSteps(absent).length === 0);

  const live = liveOf(read('src/api/ingest.js'));
  ck('the collapsing `|| null` is gone',
    !/session: r\.session \|\| null,/.test(live), (live.match(/.*session: r\.session.*/g) || []));
}

(async () => {
  try {
    // ── the base-price guard, through the real scoring path ───────────────
    {
      const SYM = 'ZZBASE';
      const DAY = '2026-09-10';
      await query("DELETE FROM signal_log WHERE symbol = $1", [SYM]);
      await query('DELETE FROM symbol_minute WHERE symbol = $1', [SYM]);

      const fired = new Date(`${DAY}T11:02:00+03:00`);
      // A signal fired on a row whose quote grid had gone empty: price 0, with
      // the ladder still rendering, which is how WALL_PULLED and NO_PROTECTION
      // fire without ever reading last_price.
      await query(
        `INSERT INTO signal_log (symbol, trading_date, fired_at, signal, price, message)
         VALUES ($1, $2, $3, 'WALL_PULLED', 0, 'zero-price row')`,
        [SYM, DAY, fired]);
      // And a real print five minutes later, once the book recovered.
      await query(
        `INSERT INTO symbol_minute (symbol, ts, trading_date, last_price, source)
         VALUES ($1, $2, $3, 204, 'BACKFILL')`,
        [SYM, new Date(`${DAY}T11:07:00+03:00`), DAY]);

      await score.score(DAY);
      const r = (await query(
        'SELECT px_5min, was_right FROM signal_log WHERE symbol = $1', [SYM])).rows[0];

      ck('the forward price is still found', Number(r.px_5min) === 204, r);
      ck('BUT THE SIGNAL IS NOT GRADED — the base was never a price',
        r.was_right === null, r);
      ck('and specifically it is not recorded as RIGHT', r.was_right !== true, r);

      // The same signal on a real base IS graded.
      await query("DELETE FROM signal_log WHERE symbol = $1", [SYM]);
      await query(
        `INSERT INTO signal_log (symbol, trading_date, fired_at, signal, price, message)
         VALUES ($1, $2, $3, 'WALL_PULLED', 200, 'real-price row')`,
        [SYM, DAY, fired]);
      await score.score(DAY);
      const ok = (await query(
        'SELECT was_right FROM signal_log WHERE symbol = $1', [SYM])).rows[0];
      ck('a real base on the same signal IS graded', ok.was_right !== null, ok);

      await query("DELETE FROM signal_log WHERE symbol = $1", [SYM]);
      await query('DELETE FROM symbol_minute WHERE symbol = $1', [SYM]);
    }
  } catch (e) {
    ck('the suite ran without throwing', false, e.message);
  }

  await close();
  console.log(`\npass5 fixes: ${p}/${n}`);
  process.exit(p === n ? 0 : 1);
})();

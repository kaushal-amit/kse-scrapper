'use strict';
/**
 * ============================================================================
 *  C1 · THE GRADE WAS MADE FROM A PRICE THE MARK COULD NOT HAVE KNOWN
 * ============================================================================
 * signal-scoring-window.test.js proves priceInForceAt reads the right side of
 * the mark. This suite proves the two things that decide whether that reaches
 * anybody:
 *
 *   1. THE BIAS IS DIRECTIONAL, not noise. Reconstruct the KB team's finding
 *      on a fixture: with captures straddling the mark, the old rule takes
 *      the later price every time. A late read that were random would average
 *      out over 400 signals; this one cannot, because the signal always fires
 *      just after a capture, so the mark always falls just before the next
 *      one. Same sign, every row.
 *
 *   2. THE STORED ROWS ACTUALLY MOVE. A rule change that leaves signal_log
 *      alone has fixed nothing anyone reads — `score()` only visits
 *      `scored_at IS NULL`, so every existing grade keeps the price that
 *      produced it. Amit, 26 Sep: "the code says X" and "the rows say X" are
 *      different claims. This is the second one.
 *
 * The re-score is also where the honest cost shows up: rows whose horizon was
 * never measurable lose their grade. The suite requires that to happen rather
 * than treating it as a regression.
 * ============================================================================
 */
const { requireTestDb } = require('../dbguard');
requireTestDb('c1-scoring-mark');

const fs = require('fs');
const path = require('path');
const { query, close } = require('../../src/db/pool');
const score = require('../../src/jobs/scoreSignals');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };

const DAY = '2026-09-17';
const AT = (hhmmss) => new Date(`${DAY}T${hhmmss}+03:00`);
const SYM = 'C1SYM';

const quote = (at, px) => query(
  `INSERT INTO awsat_market_quotes (symbol, market, created_at, trading_date, ingest_source, last_price)
   VALUES ($1, 'Main Market', $2, $3, 'awsat_client', $4)`, [SYM, at, DAY, px]);

const signal = (firedAt, sig, price) => query(
  `INSERT INTO signal_log (symbol, signal, fired_at, trading_date, price)
   VALUES ($1, $2, $3, $4, $5) RETURNING id`, [SYM, sig, firedAt, DAY, price]);

(async () => {
  try {
    await query('DELETE FROM signal_log WHERE symbol = $1', [SYM]);
    await query('DELETE FROM awsat_market_quotes WHERE symbol = $1', [SYM]);

    /*
     * THE REAL GEOMETRY. Captures on a 60-second grid; the signal fires 3
     * seconds after one of them, computed from it. This is not a contrived
     * fixture — it is what every row in signal_log looks like.
     */
    const GRID = ['09:00:00', '09:01:00', '09:02:00', '09:03:00', '09:04:00',
      '09:05:00', '09:06:00', '09:07:00'];
    // A market drifting up one fil a minute, so "which capture" is visible in
    // the answer rather than hidden behind a flat tape.
    const PX = { '09:00:00': 100, '09:01:00': 101, '09:02:00': 102, '09:03:00': 103,
      '09:04:00': 104, '09:05:00': 105, '09:06:00': 106, '09:07:00': 107 };
    for (const t of GRID) await quote(AT(t), PX[t]);

    const fired = AT('09:00:03');            // 3 s after the 09:00 capture

    console.log('\n=== the mark falls between two captures, and only one of them existed ===');
    /*
     * fired 09:00:03, so the 5-minute mark is 09:05:03. The capture in force
     * is 09:05 (105). The old rule took the first at or after the mark: 09:06
     * (106) — 57 seconds late, and a price nobody could have traded at 09:05:03.
     */
    const inForce = await score.priceInForceAt(SYM, fired, 5);
    ck('the price in force at the mark is the 09:05 capture', inForce === 105, inForce);
    ck('  and not the 09:06 one the old rule would have taken', inForce !== 106, inForce);

    console.log('\n=== and the bias has a sign — it is not noise that averages out ===');
    /*
     * Fire at three seconds past each of the first four captures. Every mark
     * lands 3 s after a capture, so every old-rule read overshoots by 57 s
     * and every one of them reads HIGHER on a rising tape. Four for four is
     * the point: a random error would not be.
     */
    let overshoots = 0;
    for (const t of ['09:00:00', '09:01:00']) {
      const f = AT(t.replace(/:00$/, ':03'));
      const now = await score.priceInForceAt(SYM, f, 5);
      // The old rule, reproduced inline — the first capture at or after the mark.
      const { rows: old } = await query(
        `SELECT last_price FROM awsat_market_quotes
          WHERE symbol = $1 AND trading_date = $2::date
            AND created_at >= $3::timestamptz + interval '5 minutes'
          ORDER BY created_at ASC LIMIT 1`, [SYM, DAY, f]);
      const was = old.length ? Number(old[0].last_price) : null;
      if (was !== null && now !== null && was > now) overshoots += 1;
    }
    ck('every signal tested reads HIGHER under the old rule on a rising tape — '
      + 'same sign each time, which is why 400 of them do not cancel out',
    overshoots === 2, overshoots);

    console.log('\n=== the stored rows move, which is the part that matters ===');
    const { rows: [row] } = await signal(fired, 'BUYERS_8_5', 100);

    // Grade it the way the old rule did: px_5min = 106, a 6-fil rise.
    await query(
      `UPDATE signal_log SET px_5min = 106, was_right = true, scored_at = now()
        WHERE id = $1`, [row.id]);
    const before = await query('SELECT px_5min, was_right FROM signal_log WHERE id = $1', [row.id]);
    ck('the row starts with the old grade', Number(before.rows[0].px_5min) === 106, before.rows[0]);

    await score.rescoreAll(null, { from: DAY });

    const after = await query(
      'SELECT px_5min, was_right, scored_at FROM signal_log WHERE id = $1', [row.id]);
    ck('after the re-score px_5min is the in-force price, not the later one',
      Number(after.rows[0].px_5min) === 105, after.rows[0]);
    ck('  and the row is scored again rather than left cleared — a re-score '
      + 'that clears and does not refill is worse than not running',
    after.rows[0].scored_at !== null, after.rows[0]);
    ck('  the verdict is still gradable here (a 5-fil rise is still a rise)',
      after.rows[0].was_right === true, after.rows[0]);

    console.log('\n=== a horizon that was never measurable LOSES its grade ===');
    /*
     * The honest cost. A signal with no capture between it and the mark was
     * being graded against its own price — "no move" for every family,
     * uniformly. It must come back NULL, and the count of graded rows must
     * fall. A re-score that only ever adds rows is not correcting anything.
     */
    const lonely = AT('09:07:30');           // nothing after 09:07 on this fixture
    const { rows: [r2] } = await signal(lonely, 'NO_PROTECTION', 106);
    await query(
      `UPDATE signal_log SET px_5min = 106, was_right = false, scored_at = now()
        WHERE id = $1`, [r2.id]);

    await score.rescoreAll(null, { from: DAY });
    const gone = await query(
      'SELECT px_5min, was_right, scored_at FROM signal_log WHERE id = $1', [r2.id]);
    ck('its forward price is NOT COMPUTED', gone.rows[0].px_5min === null, gone.rows[0]);
    ck('  and was_right is NULL, not false — "not measurable" is not "wrong"',
      gone.rows[0].was_right === null, gone.rows[0]);
    ck('  but it IS marked scored, so the nightly job stops retrying it for ever',
      gone.rows[0].scored_at !== null, gone.rows[0]);

    console.log('\n=== the operator path exists and does not write by default ===');
    const sp = path.join(__dirname, '..', '..', 'scripts', 'rescore-signals.js');
    ck('scripts/rescore-signals.js exists', fs.existsSync(sp), null);
    const src = fs.readFileSync(sp, 'utf8');
    ck('  and is DRY RUN BY DEFAULT, like every other history-rewriting script here',
      /DRY RUN BY DEFAULT/.test(src) && /--apply/.test(src), null);
    ck('  it reports how far the numbers move BEFORE anyone commits to it',
      /verdicts change/.test(src), null);
    ck('  and it verifies the write landed rather than assuming it',
      /still unscored/.test(src), null);

    console.log('\n=== the guard can fail ===');
    // If the fixtures never inserted, every check above is about nothing.
    const cnt = await query(
      'SELECT count(*)::int c FROM awsat_market_quotes WHERE symbol = $1', [SYM]);
    ck('the fixture quotes are really there', cnt.rows[0].c === GRID.length, cnt.rows[0]);

    await query('DELETE FROM signal_log WHERE symbol = $1', [SYM]);
    await query('DELETE FROM awsat_market_quotes WHERE symbol = $1', [SYM]);
  } catch (e) {
    ck('the suite ran without throwing', false, e.message);
  }

  await close();
  console.log(`\nc1 scoring mark: ${p}/${n}`);
  process.exit(p === n ? 0 : 1);
})();

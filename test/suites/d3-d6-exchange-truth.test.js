'use strict';
/**
 * ============================================================================
 *  D3/D6/C3 · WE WERE RECONSTRUCTING TWO NUMBERS THE EXCHANGE PUBLISHES
 * ============================================================================
 * D3 · prev_close was rebuilt by reaching back through previousCloses() —
 *      find the last session whose capture ran late enough to be usable, take
 *      its best close by precedence tier, cap the reach at five sessions.
 *      Every rule in that chain is careful and several were hard-won. All of
 *      them answer a question `last_price - chg` answers directly, because
 *      the exchange computes chg against its own reference: the previous
 *      official close, constant through the day, published on every row.
 *
 *      It disagreed on 1,138 of 6,082 symbol-days. 389 by more than 1%, 41 by
 *      more than 5%.
 *
 * D6 · high_px was the maximum of the prices WE sampled on a ~60-second grid,
 *      so a spike that came back inside the minute never appeared. Below the
 *      feed's high on 974 of 6,351 symbol-days, above its low on 1,100, and
 *      NEVER the other way — the signature of a sampling floor, not a
 *      disagreement. A sampled extreme can only be inside the true one.
 *
 * C3 · range_source asked whether capture reached 13:10 against a session
 *      ending at 13:00, so it could never fire. The 13:00 correction was
 *      still wrong: a complete session's last capture is 12:59. Retired
 *      rather than re-thresholded, because D6 removes the question.
 *
 * ─── AND THE ONE THAT TIES THEM TOGETHER ───────────────────────────────────
 * 14 September's capture stopped at 11:59. The 11:59 prices went in as that
 * day's closes, and 15 September's prev_close is wrong on 108 of 134 symbols
 * as a direct result. Two fixes meet there: the day is labelled
 * AWAITING_NEXT_SESSION instead of being given a close's name, and its real
 * close is recovered the next morning from that session's reference.
 * ============================================================================
 */
const { requireTestDb } = require('../dbguard');
requireTestDb('d3-d6-exchange-truth');

const { query, close } = require('../../src/db/pool');
const M = require('../../src/jobs/symbolDayMetrics');
const { repairAwaitingCloses } = require('../../src/jobs/repairAwaitingCloses');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };

const row = (o) => ({
  session: 'Trading', created_at: new Date(), last_price: null, chg: null,
  high_price: null, low_price: null, volume: 0, ...o,
});

(async () => {
  try {
    console.log('\n=== D3 · the reference is last_price - chg, and it is constant ===');
    const day = [
      row({ last_price: 204, chg: 4, created_at: new Date('2026-09-17T06:00:00Z') }),
      row({ last_price: 210, chg: 10, created_at: new Date('2026-09-17T07:00:00Z') }),
      row({ last_price: 198, chg: -2, created_at: new Date('2026-09-17T08:00:00Z') }),
    ];
    let ref = M.referenceClose(day);
    ck('the previous close is recovered from any row', ref.ref === 200, ref);
    ck('  and the feed agrees with itself, so the spread is zero', ref.spread === 0, ref);
    ck('  over every sample, not one', ref.samples === 3, ref);

    console.log('\n=== a feed that contradicts itself is REPORTED, not resolved ===');
    /*
     * The value is constant by construction, so a non-zero spread means
     * something is wrong — a mislabelled row, a capture straddling a
     * corporate action. Picking a winner silently would turn a detectable
     * fault into a plausible number, which is the failure mode this whole
     * batch is about.
     */
    ref = M.referenceClose([...day, row({ last_price: 300, chg: 10 })]);
    ck('the disagreement is carried on the row', ref.spread === 90, ref);

    console.log('\n=== zero and NULL are not references ===');
    ck('a zero last_price gives nothing',
      M.referenceClose([row({ last_price: 0, chg: -5 })]).ref === null, null);
    ck('a NULL chg gives nothing',
      M.referenceClose([row({ last_price: 204, chg: null })]).ref === null, null);
    ck('a reference of zero is refused — a close of nothing is not a close',
      M.referenceClose([row({ last_price: 204, chg: 204 })]).ref === null, null);
    ck('a symbol that never traded keeps prev_close NULL rather than guessing',
      M.referenceClose([]).ref === null, null);

    console.log('\n=== D6 · the extremes come from the feed, and beat the samples ===');
    /*
     * The spike is the whole case: a print at 260 that came back inside one
     * minute, so no capture ever saw it, while the feed's running high did.
     */
    const spiky = [
      row({ last_price: 200, high_price: 200, low_price: 200 }),
      row({ last_price: 205, high_price: 260, low_price: 180 }),
      row({ last_price: 202, high_price: 260, low_price: 180 }),
    ];
    const f = M.feedRange(spiky);
    ck('the feed high is the spike nobody captured', f.feed_high === 260, f);
    ck('the feed low is the dip nobody captured', f.feed_low === 180, f);
    const sampled = M.priceBlock(spiky);
    ck('  and the sampled high is INSIDE it, as it can only ever be',
      sampled.high_px < f.feed_high, { sampled: sampled.high_px, feed: f.feed_high });
    ck('  and the sampled low is inside it too',
      sampled.low_px > f.feed_low, { sampled: sampled.low_px, feed: f.feed_low });

    console.log('\n=== a day with no feed extremes keeps the sampled range ===');
    const noFeed = [row({ last_price: 200 }), row({ last_price: 206 })];
    const nf = M.feedRange(noFeed);
    ck('the feed values are NULL', nf.feed_high === null && nf.feed_low === null, nf);
    ck('  so the range is not lost — the fallback is the old measurement, not '
      + 'an empty column', M.priceBlock(noFeed).high_px === 206, null);

    console.log('\n=== C3 · rangeSource is gone from the code, not re-thresholded ===');
    ck('the function no longer exists', typeof M.rangeSource === 'undefined', typeof M.rangeSource);
    /*
     * thresholds.get() THROWS on an unknown key rather than returning
     * undefined — so a stale reader fails at the call site instead of
     * silently comparing against NaN. Asserting the throw is asserting that
     * guard as much as the removal.
     */
    let threw = null;
    try { require('../../src/config/thresholds').get('sd_range_full_hhmm'); threw = false; }
    catch (e) { threw = /unknown scraper threshold/.test(e.message); }
    ck('  and reading the threshold it used now THROWS, so a stale reader '
      + 'fails loudly instead of comparing against undefined', threw === true, threw);

    console.log('\n=== 14 SEPTEMBER · a missed close is recovered the next morning ===');
    /*
     * The end-to-end case. Day one's capture stops before the auction, so it
     * has no close of its own; day two publishes it as that session's
     * reference. Nothing else can supply the number, and it is not an
     * estimate — it is the same figure from the same authority, a day late.
     */
    const SYM = 'D3SYM';
    const D1 = '2026-09-14';
    const D2 = '2026-09-15';
    await query('DELETE FROM symbol_day WHERE symbol = $1', [SYM]);
    await query('DELETE FROM awsat_market_quotes WHERE symbol = $1', [SYM]);

    // Day two's board: last 212, chg +9 → day one's official close was 203.
    // Two sweeps a minute apart — the uniqueness key is (symbol, captured
    // instant), so both rows cannot share one timestamp.
    for (const [i, [px, chg]] of [[210, 7], [212, 9]].entries()) {
      await query(
        `INSERT INTO awsat_market_quotes
           (symbol, market, created_at, trading_date, ingest_source, last_price, chg, session)
         VALUES ($1,'Main Market', $2, $3,'awsat_client',$4,$5,'Trading')`,
        [SYM, new Date(`${D2}T09:3${i}:00+03:00`), D2, px, chg]);
    }

    // Day one as the stopped capture left it: an 11:59 price, labelled for
    // what it is rather than given a close's name.
    await query(
      `INSERT INTO symbol_day (symbol, trading_date, source, close_px, close_source, prev_close)
       VALUES ($1, $2, 'AWSAT', 199, 'AWAITING_NEXT_SESSION', 195)`, [SYM, D1]);

    const out = await repairAwaitingCloses(D2);
    ck('the repair reports what it changed', out.repaired === 1, out);

    const after = await query(
      `SELECT close_px, close_source, chg_fils, chg_1d
         FROM symbol_day WHERE symbol = $1 AND trading_date = $2`, [SYM, D1]);
    const r = after.rows[0];
    ck('the close is the exchange\'s, not the 11:59 print', Number(r.close_px) === 203, r);
    ck('  and it is labelled as recovered, not as a captured close',
      r.close_source === 'NEXT_SESSION_REFERENCE', r);
    ck('  chg_fils is recomputed against the new close — a stored change '
      + 'measured from the old one is the contradiction 049 exists to catch',
    Number(r.chg_fils) === 8, r);
    ck('  and chg_1d with it', Math.abs(Number(r.chg_1d) - 4.1026) < 0.001, r);

    console.log('\n=== the repair never touches a day that HAS a real close ===');
    const D0 = '2026-09-13';
    await query(
      `INSERT INTO symbol_day (symbol, trading_date, source, close_px, close_source, prev_close)
       VALUES ($1, $2, 'AWSAT', 188, 'CLOSE_OF_DAY', 180)`, [SYM, D0]);
    await repairAwaitingCloses(D2);
    const kept = await query(
      `SELECT close_px, close_source FROM symbol_day
        WHERE symbol = $1 AND trading_date = $2`, [SYM, D0]);
    ck('a captured official close is left exactly as it was — a repair that '
      + 'can overwrite good data is a worse defect than the one it fixes',
    Number(kept.rows[0].close_px) === 188
      && kept.rows[0].close_source === 'CLOSE_OF_DAY', kept.rows[0]);

    console.log('\n=== and a day whose next session has not arrived still waits ===');
    const D9 = '2026-09-24';
    await query(
      `INSERT INTO symbol_day (symbol, trading_date, source, close_px, close_source, prev_close)
       VALUES ($1, $2, 'AWSAT', 250, 'AWAITING_NEXT_SESSION', 245)`, [SYM, D9]);
    const out2 = await repairAwaitingCloses(D2);
    const waiting = await query(
      `SELECT close_source FROM symbol_day WHERE symbol = $1 AND trading_date = $2`, [SYM, D9]);
    ck('it keeps the AWAITING label rather than being given a close',
      waiting.rows[0].close_source === 'AWAITING_NEXT_SESSION', waiting.rows[0]);
    ck('  and the repair says how many are still owed, so the backlog is a '
      + 'number rather than a thing to remember',
    out2.stillAwaiting >= 1, out2);

    await query('DELETE FROM symbol_day WHERE symbol = $1', [SYM]);
    await query('DELETE FROM awsat_market_quotes WHERE symbol = $1', [SYM]);

    console.log('\n=== the guard can fail ===');
    ck('referenceClose is exported', typeof M.referenceClose === 'function', null);
    ck('feedRange is exported', typeof M.feedRange === 'function', null);
  } catch (e) {
    ck('the suite ran without throwing', false, e.message);
  }

  await close();
  console.log(`\nd3/d6 exchange truth: ${p}/${n}`);
  process.exit(p === n ? 0 : 1);
})();

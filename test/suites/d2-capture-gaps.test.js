'use strict';
/**
 * ============================================================================
 *  D2 · FIVE SESSIONS DIED AND NOTHING SAID SO UNTIL SOMEBODY COUNTED ROWS
 * ============================================================================
 *     14 Sep  stopped 11:59   no closing auction, no Trading at Last, no close
 *     26 Aug  stopped 12:23   no close
 *     20 Sep  started 10:11   the first 71 minutes of trading missed
 *     15 Sep  started 09:09   the open missed
 *     24 Sep  close first captured at 14:43 against a usual ~13:15
 *
 * Two separate failures of observation, and this suite covers both.
 *
 * 1 · NOTHING WATCHED WHILE THE SESSION RAN. The heartbeat says a script is
 *     alive, and a script can be alive, logged in and returning an empty
 *     grid. scrape_runs says a job started and finished, and both are true of
 *     a run that inserted nothing. The only fact that settles it is whether
 *     ROWS ARE STILL ARRIVING.
 *
 *     The value is in the minutes. A gap seen at 11:59 on 14 September is a
 *     restart; the same gap seen that night is a permanent hole, and it did
 *     not stay on 14 September — 15 September's prev_close is wrong on 108 of
 *     134 symbols because the previous close was a mid-session price.
 *
 * 2 · THE DAY'S SHAPE WAS NEVER RECORDED. There was no column anywhere
 *     saying when capture started, when it stopped, or whether a
 *     Close-Of-Day row existed at all — so the question "is this day's close
 *     a close?" had no input to read, and close_source answered it anyway.
 *
 * ─── THE MEASUREMENT IS MARKET-WIDE ON PURPOSE ─────────────────────────────
 * One client scrapes the whole board, so capture dies for every symbol at the
 * same instant. largest_gap_secs was a symbol_day column once — declared,
 * never written, dropped in 053. Per-symbol was the wrong SHAPE for it, not
 * just the wrong table: 137 copies of one fact with 137 chances to disagree.
 * ============================================================================
 */
const { requireTestDb } = require('../dbguard');
requireTestDb('d2-capture-gaps');

const { query, close } = require('../../src/db/pool');
const { captureShape, sessionMinutes } = require('../../src/jobs/captureShape');
const watch = require('../../src/jobs/captureGapWatch');
const { config } = require('../../src/config');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };

const DAY = '2026-09-17';                       // a Thursday clear of other fixtures
const AT = (hhmm) => new Date(`${DAY}T${hhmm}:00+03:00`);

/** One sweep: several symbols at the SAME instant, as the real client writes. */
async function sweep(hhmm, session = 'Trading') {
  for (const sym of ['D2A', 'D2B', 'D2C']) {
    await query(
      `INSERT INTO awsat_market_quotes
         (symbol, market, created_at, trading_date, ingest_source, last_price, session)
       VALUES ($1, 'Main Market', $2, $3, 'awsat_client', 100, $4)`,
      [sym, AT(hhmm), DAY, session]);
  }
}

const wipe = () => query("DELETE FROM awsat_market_quotes WHERE symbol LIKE 'D2%'")
  .then(() => query('DELETE FROM data_alarm WHERE trading_date = $1', [DAY]));

(async () => {
  try {
    await wipe();

    console.log('\n=== a complete session ===');
    // 09:00 to 13:00 on the minute, plus a closing print.
    for (let m = 0; m <= 240; m += 1) {
      const h = 9 + Math.floor(m / 60);
      await sweep(`${String(h).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
    }
    await sweep('13:15', 'Close-Of-Day');

    let shape = await captureShape(DAY);
    ck('every session minute is captured', shape.session_minutes_captured === 241,
      shape.session_minutes_captured);
    ck('  which is the whole session, measured against 240 not 280 — the '
      + 'denominator 049 corrected',
    sessionMinutes() === 240, sessionMinutes());
    ck('the largest gap is one grid interval', shape.largest_gap_secs === 60,
      shape.largest_gap_secs);
    ck('the close exists', shape.close_of_day_rows === 3, shape.close_of_day_rows);

    console.log('\n=== 14 SEPTEMBER · the capture stops at 11:59 ===');
    /*
     * The one that propagated. Without the trailing "last capture to close"
     * gap, the largest gap on this day is the ordinary 60 seconds between two
     * morning sweeps and the missing hour is invisible — which is exactly how
     * it went unnoticed for twelve days.
     */
    await query("DELETE FROM awsat_market_quotes WHERE symbol LIKE 'D2%'");
    for (let m = 0; m <= 179; m += 1) {         // 09:00 -> 11:59
      const h = 9 + Math.floor(m / 60);
      await sweep(`${String(h).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
    }
    shape = await captureShape(DAY);
    ck('NO Close-Of-Day row — the day has no official close',
      shape.close_of_day_rows === 0, shape.close_of_day_rows);
    ck('  and that is the fact D3 reads: anything stored as a close on this '
      + 'day is a mid-session price wearing a label',
    shape.close_of_day_rows === 0, shape.close_of_day_rows);
    ck('the largest gap is the missing HOUR, not the 60 s between two morning '
      + 'sweeps — the trailing run to the close is a gap',
    shape.largest_gap_secs === 61 * 60, shape.largest_gap_secs);
    ck('  and it is positioned, so it can be matched against a deploy or a restart',
      shape.largest_gap_at !== null, shape.largest_gap_at);
    ck('session minutes fall short of 240', shape.session_minutes_captured === 180,
      shape.session_minutes_captured);

    console.log('\n=== 20 SEPTEMBER · nothing arrives until 10:11 ===');
    /*
     * The mirror case. The run from the OPEN to the first capture has to
     * count, or a session that started 71 minutes late reports its largest
     * gap as whatever happened afterwards — 60 seconds, on a clean afternoon.
     */
    await query("DELETE FROM awsat_market_quotes WHERE symbol LIKE 'D2%'");
    for (let m = 71; m <= 240; m += 1) {
      const h = 9 + Math.floor(m / 60);
      await sweep(`${String(h).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
    }
    shape = await captureShape(DAY);
    ck('the leading gap is measured from the OPEN, not from the first capture',
      shape.largest_gap_secs === 71 * 60, shape.largest_gap_secs);
    ck('  and first_capture_at records when it did start',
      shape.first_capture_at !== null, shape.first_capture_at);

    console.log('\n=== a day with no capture at all is not a perfect day ===');
    await query("DELETE FROM awsat_market_quotes WHERE symbol LIKE 'D2%'");
    shape = await captureShape(DAY);
    ck('largest_gap_secs is NULL, not 0 — zero reads as a flawless session, '
      + 'the exact inversion of the truth',
    shape.largest_gap_secs === null, shape.largest_gap_secs);
    ck('  and session minutes are 0', shape.session_minutes_captured === 0,
      shape.session_minutes_captured);
    ck('  and there is no close', shape.close_of_day_rows === 0, shape.close_of_day_rows);

    console.log('\n=== the watchdog, while the session is still running ===');
    await query('DELETE FROM data_alarm WHERE trading_date = $1', [DAY]);
    await query("DELETE FROM awsat_market_quotes WHERE symbol LIKE 'D2%'");

    // 10:00, and the last capture was 10:02... i.e. fresh.
    await sweep('09:58');
    let r = await watch.checkOnce({ now: AT('10:00'), day: DAY });
    ck('a fresh capture raises nothing', r.checked && r.ok === true, r);

    // Now it is 10:10 and nothing has arrived since 09:58: a 12-minute hole.
    r = await watch.checkOnce({ now: AT('10:10'), day: DAY });
    ck('a 12-minute hole DOES raise', r.checked && r.ok === false && r.raised === true, r);
    const raised = await query(
      'SELECT alarm, detail FROM data_alarm WHERE trading_date = $1', [DAY]);
    ck('  one CAPTURE_GAP row', raised.rows.length === 1
      && raised.rows[0].alarm === 'CAPTURE_GAP', raised.rows);
    // detail is jsonb, so read the field rather than the row.
    const detailText = JSON.stringify((raised.rows[0] || {}).detail || {});
    ck('  whose detail says what is at stake, not just that a number was exceeded',
      /prev_close|close will be missed/i.test(detailText), raised.rows[0]);

    console.log('\n=== and it raises ONCE per episode, not once a minute ===');
    r = await watch.checkOnce({ now: AT('10:11'), day: DAY });
    ck('the second minute of the same outage is suppressed', r.suppressed === true, r);
    const still = await query(
      'SELECT count(*)::int c FROM data_alarm WHERE trading_date = $1', [DAY]);
    ck('  still one row — an hour-long outage must not write 55 of them, or the '
      + 'row that matters becomes the hardest to find',
    still.rows[0].c === 1, still.rows[0]);

    console.log('\n=== no capture AT ALL is measured from the open, not skipped ===');
    await query('DELETE FROM data_alarm WHERE trading_date = $1', [DAY]);
    await query("DELETE FROM awsat_market_quotes WHERE symbol LIKE 'D2%'");
    r = await watch.checkOnce({ now: AT('10:11'), day: DAY });
    ck('with max(created_at) NULL it still fires — the 20 September shape, '
      + 'where "no rows" and "no gap" look identical from the outside',
    r.checked && r.raised === true, r);
    ck('  and the gap is measured from the open (71 minutes), not from nothing',
      r.sinceSecs === 71 * 60, r.sinceSecs);

    console.log('\n=== it is quiet outside continuous trading ===');
    await query('DELETE FROM data_alarm WHERE trading_date = $1', [DAY]);
    r = await watch.checkOnce({ now: AT('08:50'), day: DAY });
    ck('before the open it does not check — pre-open capture is useful and its '
      + 'absence is not a data failure (049)',
    r.checked === false, r);
    r = await watch.checkOnce({ now: AT('14:30'), day: DAY });
    ck('after the close it does not check — a quiet board is the market being '
      + 'shut, and an alarm that fires every evening is read by nobody',
    r.checked === false, r);
    const none = await query(
      'SELECT count(*)::int c FROM data_alarm WHERE trading_date = $1', [DAY]);
    ck('  so nothing was written', none.rows[0].c === 0, none.rows[0]);

    console.log('\n=== the guard can fail ===');
    ck('the session window is the one 049 set',
      config.market.sessionStartMinutes === 540 && config.market.sessionEndMinutes === 780,
      [config.market.sessionStartMinutes, config.market.sessionEndMinutes]);
    ck('the threshold is the five minutes that was asked for',
      require('../../src/config/thresholds').get('capture_gap_alarm_secs') === 300, null);

    await wipe();
  } catch (e) {
    ck('the suite ran without throwing', false, e.message);
  }

  await close();
  console.log(`\nd2 capture gaps: ${p}/${n}`);
  process.exit(p === n ? 0 : 1);
})();

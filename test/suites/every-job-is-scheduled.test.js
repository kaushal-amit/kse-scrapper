'use strict';
/**
 * ============================================================================
 *  A JOB THAT IS REGISTERED AND NEVER RUNS
 * ============================================================================
 * src/config.js says it, in a comment, above the enabled list:
 *
 *   "A job added without being listed here is never scheduled, and nothing
 *    says so — the boot log simply shows one fewer job than expected. That has
 *    now happened twice."
 *
 * It has now happened three times. `daily.minutesample` was added to JOBS, to
 * the worker-routing list and to its own test suite, and was in neither
 * `config.scrapers.enabled` nor `AFTER_CLOSE_JOBS` — so it would never have
 * fired, and nothing anywhere would have said so. The nightly derive would
 * simply have had no rows, which looks exactly like a market with nothing in
 * it.
 *
 * The answer to the first two occurrences was that comment. A comment is not a
 * check. This is the check.
 *
 * ─── THE SECOND HALF, WHICH IS THE EASIER MISTAKE ──────────────────────────
 *
 * The scheduler gives any enabled job NOT in AFTER_CLOSE_JOBS the intraday
 * cadence — once a minute inside the capture window. So adding a NIGHTLY job
 * to `enabled` and forgetting AFTER_CLOSE_JOBS does not leave it unscheduled;
 * it runs it 280 times a session. That is worse than never running, because it
 * looks like it is working.
 *
 * Every job therefore has to be one of exactly three things, and say which:
 * intraday, after-close, or manual-only.
 * ============================================================================
 */
const jobs = require('../../src/jobs');
const scheduler = require('../../src/scheduler');
const { config } = require('../../src/config');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };

/**
 * Jobs deliberately kept off the schedule, each with the reason.
 *
 * The list is short on purpose. "Manual" is a claim about how a job is meant
 * to be used, and an unexplained entry here is indistinguishable from one
 * somebody forgot to schedule — which is the defect this suite exists for.
 */
const MANUAL_ONLY = {
  /*
   * NOT "backfills are inherently manual" — that reading turns the
   * classification into the excuse and the fix never happens.
   *
   * It is manual because of what it DID: `tradingview.backfill --date=...`
   * was parsed, passed, and dropped on the floor (the function took (runId)
   * where every other dated job takes (runId, args)), so it silently
   * refetched the last 30 days, overwrote three weeks of bars, and reported
   * SUCCESS. A job that ignores the parameter bounding it cannot be put on a
   * schedule.
   *
   * That is FIXED — --date, --from/--to, and a refusal on an empty range —
   * and NOT YET DEPLOYED. Once it is, "manual" rests only on slow and
   * fragile, which is a weaker reason and should be revisited rather than
   * inherited.
   */
  'tradingview.backfill':
    'MANUAL UNTIL THE --date FIX IS DEPLOYED. It ignored --date entirely: the '
    + 'function took (runId) where every other dated job takes (runId, args), so a '
    + 'request for one day refetched thirty, overwrote three weeks of bars and '
    + 'reported SUCCESS. Fixed in this branch, undeployed. After the deploy the only '
    + 'remaining reason is that it is slow and fragile — weaker, and worth revisiting '
    + 'rather than inheriting',
};

/** Jobs that run DURING the session, once a minute or on their own cadence. */
const INTRADAY = new Set([
  'tradingview.quotes', 'awsat.board', 'awsat.depth', 'awsat.orders',
  'signals.fast', 'signals.wakeup',
  // D2 · the capture-gap watchdog. Once a minute inside the window is the
  // default cadence for an enabled job with no AFTER_CLOSE entry, and for
  // this one the default is the right answer rather than an oversight: a
  // watchdog that checks after the close reports a hole instead of saving a
  // session. It is listed here so that is a decision on the record.
  'session.gapwatch',
]);

(async () => {
  try {
    const all = jobs.jobNames;
    const enabled = new Set(config.scrapers.enabled);
    const afterClose = scheduler.AFTER_CLOSE_JOBS;

    console.log('\n=== every registered job is enabled, or manual-only and says why ===');
    const unaccounted = all.filter((j) => !enabled.has(j) && !(j in MANUAL_ONLY));
    ck('no job is registered, disabled, and unexplained', unaccounted.length === 0, unaccounted);

    for (const j of Object.keys(MANUAL_ONLY)) {
      ck(`manual-only job still exists: ${j}`, all.includes(j), j);
      ck(`  and is genuinely off the schedule: ${j}`,
        !enabled.has(j) && !afterClose[j], { enabled: enabled.has(j), afterClose: !!afterClose[j] });
      ck(`  and the reason is a sentence, not a shrug: ${j}`,
        (MANUAL_ONLY[j] || '').length > 40, MANUAL_ONLY[j]);
    }
    ck('the backfill reason names the DEFECT that makes it manual, not a habit — '
      + '"backfills are inherently manual" would make the classification the excuse '
      + 'and the fix would never happen',
    /--date/.test(MANUAL_ONLY['tradingview.backfill'])
      && /undeployed|not yet deployed/i.test(MANUAL_ONLY['tradingview.backfill']),
    MANUAL_ONLY['tradingview.backfill']);
    {
    }

    console.log('\n=== nothing is enabled that does not exist ===');
    const ghosts = [...enabled].filter((j) => !all.includes(j));
    ck('every enabled name is a registered job', ghosts.length === 0, ghosts);

    console.log('\n=== and every enabled job says WHICH cadence it wants ===');
    // The trap: an enabled job with no AFTER_CLOSE_JOBS entry gets the intraday
    // schedule by default, so a nightly job forgotten here runs every minute.
    const miscadenced = [...enabled].filter((j) => !afterClose[j] && !INTRADAY.has(j));
    ck('no enabled job falls through to the intraday default by accident — a nightly '
      + 'derive scheduled that way runs 280 times a session and looks like it is working',
    miscadenced.length === 0, miscadenced);

    const claimedIntraday = [...INTRADAY].filter((j) => afterClose[j]);
    ck('nothing is claimed intraday AND scheduled after the close',
      claimedIntraday.length === 0, claimedIntraday);

    console.log('\n=== the specific job that prompted this ===');
    ck('daily.minutesample is enabled', enabled.has('daily.minutesample'), null);
    ck('  and runs AFTER the close, not once a minute',
      !!afterClose['daily.minutesample'], afterClose['daily.minutesample']);
    ck('  and lands before daily.marketday, which runs the column-coverage check last',
      afterClose['daily.minutesample'] < afterClose['daily.marketday'],
      { sample: afterClose['daily.minutesample'], marketday: afterClose['daily.marketday'] });

    console.log('\n=== the catch-up never runs a job before its own time ===');
    /*
     * signals.score missed 24 September and nobody noticed until the rows were
     * counted by hand. Adding it to CATCH_UP_JOBS naively would have made
     * scoring WORSE: the catch-up fires once the CLOSE has passed (13:30) and
     * signals.score is scheduled 17:45, because it needs the +15 and +60
     * minute forward prices. A catch-up at 13:31 scores the day against prices
     * that have not happened, then finds rows present and never runs again.
     */
    const catchUp = require('../../src/scheduler');
    ck('signals.score is in the catch-up at all — it was not, and that is how '
      + '24 September went unscored',
    !!scheduler.AFTER_CLOSE_JOBS['signals.score'], null);
    const scoreCron = String(scheduler.AFTER_CLOSE_JOBS['signals.score'] || '').split(/\s+/);
    const scoreMin = Number(scoreCron[2]) * 60 + Number(scoreCron[1]);
    ck('  and it is scheduled well after the close, not just after it',
      scoreMin > config.market.endMinutes + 120,
      { scheduled: scoreMin, close: config.market.endMinutes });
    ck('  so the catch-up floor is read from the cron, not restated',
      /scheduledMinuteOfDay/.test(require('fs').readFileSync(
        require('path').join(__dirname, '..', '..', 'src', 'scheduler.js'), 'utf8')), null);
    void catchUp;

    console.log('\n=== the chain: spacing is not sequencing ===');
    /*
     * 13:31 -> 13:35 -> 13:38 -> 13:42 are four independent cron entries. Four
     * minutes is enough on a normal day; daily.symbolday over a backfill range
     * is not a normal day, and daily.marketday reads symbol_day. Without a
     * gate it aggregates a table still being written — the same drift the
     * market_day fingerprint detects afterwards, arriving through the
     * scheduler.
     */
    const sch = require('fs').readFileSync(
      require('path').join(__dirname, '..', '..', 'src', 'scheduler.js'), 'utf8');
    ck('daily.marketday waits for daily.symbolday, not for four minutes',
      /'daily\.marketday':\s*'daily\.symbolday'/.test(sch), null);
    ck('  and "done" is a SUCCESS row in scrape_runs, not "the process is not running" '
      + '— which is true before it starts as well as after it finishes',
    /status = 'SUCCESS'/.test(sch) && /predecessorDone/.test(sch), null);
    ck('  a failed check counts as NOT done, so the job waits rather than assuming',
      /treating it as not done/.test(sch), null);
    ck('  a blocked job is RECORDED, not silently skipped',
      /recordSkip\(name, `blocked:/.test(sch), null);
    ck('  and the catch-up honours the same gate, or it would restore the wrong rows',
      /const pre = await predecessorDone\(name, day\);\n    if \(!pre\.ok\) continue;/.test(sch), null);
    // The edge that is NOT declared matters as much: minutesample reads
    // quotes_clean and depth, so chaining it would serialise a job that cannot
    // be affected, and the next person would delete the gate rather than the edge.
    ck('daily.minutesample is deliberately NOT chained — it cannot aggregate an '
      + 'incomplete symbol_day because it never reads one',
    !/'daily\.minutesample':\s*'daily\./.test(sch), null);

    console.log('\n=== and the gate actually blocks, against a real database ===');
    /*
     * The checks above read the source. Source says what was written; this
     * says what happens. The distinction is the whole week: a test proves a
     * function works, and nothing proved it is reached.
     */
    {
      const db = require('../../src/db/pool');
      const DAY = '2026-11-23';   // clear of every other suite's fixtures
      await db.query('DELETE FROM scrape_runs WHERE trading_date = $1', [DAY]);

      const before = await scheduler.predecessorDone('daily.marketday', DAY);
      ck('marketday is BLOCKED while symbolday has no SUCCESS row for the day',
        before.ok === false && before.needs === 'daily.symbolday', before);

      // A FAILED predecessor is not a finished one.
      await db.query(
        `INSERT INTO scrape_runs (scraper, trading_date, status, started_at)
         VALUES ('daily.symbolday', $1, 'FAILED', now())`, [DAY]);
      const failed = await scheduler.predecessorDone('daily.marketday', DAY);
      ck('  a FAILED predecessor still blocks it — the row exists, the work did not',
        failed.ok === false, failed);

      await db.query(
        `INSERT INTO scrape_runs (scraper, trading_date, status, started_at)
         VALUES ('daily.symbolday', $1, 'SUCCESS', now())`, [DAY]);
      const after = await scheduler.predecessorDone('daily.marketday', DAY);
      ck('  and it is released once symbolday records SUCCESS', after.ok === true, after);

      const unchained = await scheduler.predecessorDone('daily.minutesample', DAY);
      ck('  a job with no declared predecessor is never blocked',
        unchained.ok === true && unchained.needs === null, unchained);

      await db.query('DELETE FROM scrape_runs WHERE trading_date = $1', [DAY]);
      await db.close();
    }

    console.log('\n=== the guard can fail ===');
    // If jobNames or enabled ever came back empty, every check above would pass
    // on nothing at all.
    ck('there are jobs to check', all.length >= 10, all.length);
    ck('there are enabled jobs to check', enabled.size >= 10, enabled.size);
    ck('there are after-close jobs to check', Object.keys(afterClose).length >= 5,
      Object.keys(afterClose).length);

    console.log(`\nevery job is scheduled: ${p}/${n}`);
    process.exit(p === n ? 0 : 1);
  } catch (e) {
    console.error('every-job-is-scheduled ERROR', e);
    process.exit(1);
  }
})();

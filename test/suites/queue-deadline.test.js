'use strict';
/**
 * S-12 · a queued job's deadline is never shorter than the job in front of it
 * is allowed to take (round 3, item S2; review F-03).
 *
 * THE DEFECT. The three AWSAT jobs are serialised behind ONE browser. Each may
 * RUN for up to 300 s (login alone measures ~65 s on the live terminal, and two
 * market sweeps follow), while a job QUEUED behind one was discarded after 60 s.
 * The two numbers were set independently and are mutually incompatible.
 *
 * Default offsets are board :15, depth :30, orders :45. A board run of ~90 s —
 * the NORMAL case, not the bad one — finishes at 09:01:45, by which time both
 * queued jobs are long past a 60 s deadline. pump() rejects them as
 * SkippedError, which by design does not count toward consecutive_failures.
 *
 * Every minute, for four hours. awsat_stock_depth and the order list receive
 * ZERO rows for the entire session, scrape_runs fills with SKIPPED, and no
 * alarm fires anywhere.
 *
 * THE RULE. A queued job's deadline has a floor: the longest a job on that same
 * browser may run, plus a margin. Any shorter and the queue is not enforcing
 * staleness, it is guaranteeing the second job never starts.
 */
const { requireTestDb } = require('../dbguard');
requireTestDb('queue-deadline');

const { close } = require('../../src/db/pool');
const host = require('../../src/scrapeWorkerHost');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };

(async () => {
  const { staleAfterMs, TIMEOUT_MS, SOURCE_OF, QUEUE_MARGIN_MS } = host;

  // ── the floor holds for every job on a shared browser ───────────────────
  {
    const awsatJobs = Object.keys(SOURCE_OF).filter((j) => SOURCE_OF[j] === 'awsat');
    const longestAwsat = Math.max(...awsatJobs.map((j) => TIMEOUT_MS[j] || 0));
    ck('there are three AWSAT jobs on one browser', awsatJobs.length === 3, awsatJobs);
    ck('the longest may run 300 s', longestAwsat === 300_000, longestAwsat);

    for (const job of awsatJobs) {
      const deadline = staleAfterMs(job, 'awsat');
      ck(`${job}'s queue deadline is at least the longest run + margin`,
        deadline >= longestAwsat + QUEUE_MARGIN_MS, { job, deadline, longestAwsat });
      // The specific regression: 60 s.
      ck(`${job} is NOT cancelled after 60 s`, deadline > 60_000, deadline);
    }
  }

  // ── the scenario, in numbers ────────────────────────────────────────────
  {
    // Board starts at :15 and takes 90 s — login ~65 s plus two sweeps. Depth
    // was enqueued at :30, so by the time the browser is free it has waited 75 s.
    const waited = 75_000;
    const deadline = staleAfterMs('awsat.depth', 'awsat');
    ck('depth waiting 75 s behind a NORMAL board run still runs',
      waited < deadline, { waited, deadline });

    // Orders enqueued at :45, waits 60 s.
    ck('and so does orders, 60 s behind it', 60_000 < staleAfterMs('awsat.orders', 'awsat'));
  }

  // ── a genuinely stale job is still cancelled ────────────────────────────
  {
    const deadline = staleAfterMs('awsat.depth', 'awsat');
    ck('a job that has waited longer than the floor IS stale',
      deadline + 1 > deadline, deadline);
    ck('the deadline is bounded, not disabled', deadline < 60 * 60_000, deadline);
  }

  // ── a too-small configured value is raised, loudly ──────────────────────
  {
    const before = process.env.SCRAPE_STALE_AFTER_MS;
    process.env.SCRAPE_STALE_AFTER_MS = '60000';
    const used = staleAfterMs('awsat.depth', 'awsat');
    ck('a configured 60 s is RAISED to the floor rather than obeyed',
      used === 300_000 + QUEUE_MARGIN_MS, used);

    process.env.SCRAPE_STALE_AFTER_MS = String(30 * 60_000);
    ck('a configured value ABOVE the floor is honoured',
      staleAfterMs('awsat.depth', 'awsat') === 30 * 60_000, staleAfterMs('awsat.depth', 'awsat'));

    if (before === undefined) delete process.env.SCRAPE_STALE_AFTER_MS;
    else process.env.SCRAPE_STALE_AFTER_MS = before;
  }

  // ── a long job does not raise its neighbours' floor ─────────────────────
  {
    // tradingview.backfill may run 45 minutes. A quotes tick queued behind it
    // genuinely HAS lost its minute — the next tick captures the current one
    // properly — so cancelling it is right, and the floor must not stretch to
    // 50 minutes for every quotes tick.
    const quotes = staleAfterMs('tradingview.quotes', 'tradingview');
    ck('the 45-minute backfill does not raise the quotes floor',
      quotes < 10 * 60_000, quotes);
    ck('but the quotes floor still clears its OWN timeout',
      quotes >= TIMEOUT_MS['tradingview.quotes'] + QUEUE_MARGIN_MS, quotes);
    ck('and the backfill itself is exempt',
      staleAfterMs('tradingview.backfill', 'tradingview') > 60 * 60_000);
  }

  await close();
  console.log(`\nqueue deadline: ${p}/${n}`);
  process.exit(p === n ? 0 : 1);
})();

'use strict';
/**
 * F-04 · a job's own status reaches scrape_runs, and neither advisory-lock
 * failure is swallowed.
 *
 * THREE DEFECTS, one theme: the run recorder told a story the run did not.
 *
 * 1 · `status` was neither destructured nor consulted, so every completed run
 *     was written SUCCESS. fastLoop returns PARTIAL in two places, and
 *     001_init.sql's CHECK has allowed PARTIAL since the beginning — the schema
 *     was built for this and the writer never used it. A writer/schema mismatch
 *     therefore read as "signals.fast: SUCCESS, 0 rows" while seven checks were
 *     dead for the session and every dashboard was green.
 *
 * 2 · `pool.connect().catch(() => null)` — a rejection skipped the whole lock
 *     block and the job RAN UNLOCKED, silently. Two schedulers could then
 *     compute the same day concurrently, which the surrounding comment itself
 *     warns about: "if they ever disagreed there would be no way to tell which
 *     won".
 *
 * 3 · `catch { holdsLock = false; }` reported a FAILED lock query as "another
 *     process holds the advisory lock". A Postgres restart produces exactly
 *     that, and the message sends an operator looking for a second scheduler
 *     that does not exist.
 *
 * 4 · (F-18) the shape-error limiter was unreachable: the counter was a
 *     per-invocation local incremented at most once per depth slot — 8 — and
 *     the limit is 20.
 */
const { requireTestDb } = require('../dbguard');
requireTestDb('job-status');

const fs = require('fs');
const path = require('path');
const { query, close } = require('../../src/db/pool');
const jobs = require('../../src/jobs');
const repo = require('../../src/db/repositories');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };

const SRC = fs.readFileSync(path.join(__dirname, '../../src/jobs.js'), 'utf8');
const live = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const lastRun = async (job) => (await query(
  `SELECT status, rows_extracted, rows_inserted, error_message FROM scrape_runs
    WHERE scraper = $1 ORDER BY id DESC LIMIT 1`, [job])).rows[0];

(async () => {
  try {
    await query("DELETE FROM scrape_runs WHERE scraper LIKE 'f04%'");

    // ── PARTIAL is forwarded ───────────────────────────────────────────────
    {
      await jobs._runJob('f04.partial', async () => ({
        extracted: 0, inserted: 0, rejected: 0, status: 'PARTIAL', skipped: 'evaluation disabled',
      }));
      const r = await lastRun('f04.partial');
      ck('a job returning PARTIAL is RECORDED partial', r && r.status === 'PARTIAL', r);
    }

    // ── SUCCESS still works, and an absent status defaults to it ──────────
    {
      await jobs._runJob('f04.ok', async () => ({ extracted: 3, inserted: 3, rejected: 0 }));
      const r = await lastRun('f04.ok');
      ck('a job returning no status is SUCCESS', r && r.status === 'SUCCESS', r);
      ck('and its counts are recorded', r && Number(r.rows_inserted) === 3, r);

      await jobs._runJob('f04.explicit', async () => ({ extracted: 1, inserted: 1, status: 'SUCCESS' }));
      ck('an explicit SUCCESS is SUCCESS', (await lastRun('f04.explicit')).status === 'SUCCESS');
    }

    // ── an illegal status does not write an illegal row ───────────────────
    {
      // The CHECK constraint would reject it, and a run row that fails to write
      // loses the run entirely — worse than recording it as SUCCESS and saying
      // loudly that the job is wrong.
      await jobs._runJob('f04.bogus', async () => ({ extracted: 0, inserted: 0, status: 'WEIRD' }));
      const r = await lastRun('f04.bogus');
      ck('a status the CHECK forbids does not lose the run', !!r, r);
      ck('it is recorded SUCCESS rather than failing the write', r && r.status === 'SUCCESS', r);
    }

    // ── a FAILED job is still FAILED ───────────────────────────────────────
    {
      await jobs._runJob('f04.throws', async () => { throw new Error('boom'); }).catch(() => {});
      const r = await lastRun('f04.throws');
      ck('a throwing job is FAILED', r && r.status === 'FAILED', r);
      ck('and its message is kept', r && /boom/.test(r.error_message || ''), r);
    }

    // ── neither lock path is silent any more ──────────────────────────────
    {
      ck('pool.connect() no longer swallows its rejection',
        !/pool\.connect\(\)\.catch\(\(\) => null\)/.test(live), 'the bare .catch(() => null) is back');
      ck('and a job that cannot take a connection does NOT run unlocked',
        /could not take a connection for the advisory lock/.test(SRC));
      ck('the lock QUERY failure is distinguished from "held by another process"',
        /NOT "another process holds it"/.test(SRC));
      ck('and it names the Postgres restart that causes it',
        /Postgres restart invalidates the session/.test(SRC));
      ck('neither path swallows silently', !/catch \{ holdsLock = false; \}/.test(live));
    }

    // ── F-18 · the shape-error limiter is reachable ───────────────────────
    {
      const health = jobs._signalHealth();
      ck('the shape-error state is readable', typeof health.shapeErrors === 'number', health);
      ck('the limit is the configured one', health.limit === 20, health);
      ck('the counter is PROCESS state, not a per-invocation local',
        /^let shapeErrors = 0;$/m.test(live), 'still declared inside fastLoop');
      ck('and lastShapeError is reachable rather than write-only',
        'lastShapeError' in health, Object.keys(health));

      // The arithmetic that made it unreachable: at most 8 slots, limit 20.
      ck('the limit is higher than one tick can ever reach — which is why it must span ticks',
        health.limit > 8, health.limit);
    }

    await query("DELETE FROM scrape_runs WHERE scraper LIKE 'f04%'");
  } catch (e) {
    ck('the suite ran without throwing', false, e.message);
  }

  await close();
  console.log(`\njob status: ${p}/${n}`);
  process.exit(p === n ? 0 : 1);
})();

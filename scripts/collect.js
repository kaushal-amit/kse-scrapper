'use strict';
/**
 * scripts/collect.js — run a scraper every minute for N minutes.
 *
 *   npm run collect -- --job=tradingview.quotes --minutes=15
 *
 * History and the daily analysis AGGREGATE minute captures, so they need
 * captures to exist. A single run gives one price per symbol, and one price has
 * no range — no high, no low, no swings. That is why a lone quotes run followed
 * by history reports "too few captures to form a bar": the guard is right and
 * the data is thin.
 *
 * This builds up a session's worth so the downstream jobs have something real
 * to work on, without waiting for a live trading day.
 */

const jobs = require('../src/jobs');
const db = require('../src/db/pool');
const workerHost = require('../src/scrapeWorkerHost');
const log = require('../src/logger');

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
};

const JOB = arg('job', 'tradingview.quotes');
const MINUTES = Number(arg('minutes', 10));
const EVERY_MS = Number(arg('everyMs', 60_000));

async function main() {
  if (!jobs.jobNames.includes(JOB)) {
    console.error(`\n  unknown job: ${JOB}\n  known: ${jobs.jobNames.join(', ')}\n`);
    process.exit(1);
  }

  console.log(`\n  collecting ${JOB} every ${EVERY_MS / 1000}s for ${MINUTES} run(s)`);
  console.log(`  ${'─'.repeat(66)}`);

  let ok = 0;
  let failed = 0;

  for (let i = 1; i <= MINUTES; i += 1) {
    const started = Date.now();
    const r = await jobs.run(JOB);
    if (r.status === 'SUCCESS') ok += 1; else failed += 1;
    console.log(`  ${String(i).padStart(3)}/${MINUTES}  ${r.status.padEnd(8)}`
      + `extracted=${r.extracted ?? 0} inserted=${r.inserted ?? 0}`);

    if (i < MINUTES) {
      // Wait the REMAINDER of the interval, not the full interval — otherwise
      // a 12s scrape makes each cycle 72s and the captures drift apart.
      const wait = Math.max(0, EVERY_MS - (Date.now() - started));
      await new Promise((r2) => setTimeout(r2, wait));
    }
  }

  console.log(`  ${'─'.repeat(66)}`);
  console.log(`  ${ok} succeeded, ${failed} failed\n`);
  console.log('  Now aggregate what was collected:');
  console.log('      npm run run:once -- tradingview.history');
  console.log('      npm run run:once -- daily.analysis --date=' + require('../src/market/clock').tradingDay() + '\n');

  await workerHost.stopAll();
  await db.close();
  process.exit(failed && !ok ? 1 : 0);
}

main().catch(async (err) => {
  log.error('collect failed', { err: log.serializeError(err) });
  await workerHost.stopAll().catch(() => {});
  await db.close().catch(() => {});
  process.exit(1);
});

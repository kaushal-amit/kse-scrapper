'use strict';
/**
 * Run one scraper immediately, ignoring the trading window.
 *
 * For development and for verifying selectors after a site change, when waiting
 * until Sunday morning is not a reasonable debugging loop.
 *
 *   node src/runOnce.js tradingview.quotes
 */

const jobs = require('./jobs');
const db = require('./db/pool');
const workerHost = require('./scrapeWorkerHost');
const clock = require('./market/clock');
const log = require('./logger');

async function main() {
  const name = process.argv[2];
  if (!name) {
    console.log(`\nUsage: node src/runOnce.js <job> [--date=YYYY-MM-DD]\n`);
    console.log(`Jobs: ${jobs.jobNames.join(', ')}\n`);
    console.log('Examples:');
    console.log('  node src/runOnce.js tradingview.quotes');
    console.log('  node src/runOnce.js tradingview.history --date=2026-08-24');
    console.log('  node src/runOnce.js daily.analysis --date=2026-08-24\n');
    console.log('Through npm, the job name must come AFTER the -- separator:');
    console.log('  npm run run:once -- tradingview.history --date=2026-08-24');
    console.log('  (npm swallows arguments placed before its own --)\n');
    console.log('For a manual test with only a few captures collected, lower the');
    console.log('bar count first:  HISTORY_MIN_CAPTURES=2 npm run run:once tradingview.history\n');
    process.exit(1);
  }

  const status = clock.windowStatus();
  if (!status.open) {
    log.warn('outside the trading window — running anyway because this is runOnce', status);
  }

  // --date lets a specific day be re-finalised or re-analysed by hand, which
  // is the only way to test these jobs without waiting for 17:00 tomorrow.
  // Accept --date=X and "--date X", and ALSO HISTORY_DATE, because npm eats
  // arguments placed before its own `--` separator. Your run showed exactly
  // that: the echoed command had no --date and both jobs silently used their
  // defaults, which looked like the jobs ignoring the flag.
  const argv = process.argv.slice(2);
  let dateArg = (argv.find((a) => a.startsWith('--date=')) || '').split('=')[1];
  if (!dateArg) {
    const i = argv.indexOf('--date');
    if (i >= 0 && argv[i + 1]) dateArg = argv[i + 1];
  }
  if (!dateArg && process.env.RUN_DATE) dateArg = process.env.RUN_DATE;
  if (dateArg && !/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
    log.error('--date must be YYYY-MM-DD', { got: dateArg });
    process.exit(1);
  }

  // Say what was actually resolved. A flag that silently fails to arrive is
  // indistinguishable from a job that ignores it.
  log.info('running', {
    job: name,
    date: dateArg || '(default — today, or the previous trading day for analysis)',
    tip: dateArg ? undefined
      : 'to target a specific day: npm run run:once -- <job> --date=YYYY-MM-DD',
  });

  const result = await jobs.run(name, dateArg ? { date: dateArg } : undefined);
  log.info('result', result);

  await workerHost.stopAll();
  await db.close();
  process.exit(result.status === 'SUCCESS' ? 0 : 1);
}

main().catch(async (err) => {
  log.error('runOnce failed', { err: log.serializeError(err) });
  await workerHost.stopAll().catch(() => {});
  await db.close().catch(() => {});
  process.exit(1);
});

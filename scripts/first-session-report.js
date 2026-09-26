#!/usr/bin/env node
'use strict';
/**
 * ============================================================================
 *  THE FIRST POST-DEPLOY SESSION — OBSERVED, NOT ASSUMED
 * ============================================================================
 *   node scripts/first-session-report.js [--date=YYYY-MM-DD]
 *
 * The schedule is correct in code and has never been seen to run. Nothing from
 * the backend has written to production since 15 September, so the first
 * session after the deploy is the only baseline that exists, and it happens
 * once.
 *
 * This is deliberately NOT a dashboard. It is a one-shot report for one
 * session, answering the only question that matters about a scheduler nobody
 * has watched:
 *
 *     for each after-close job — did it produce rows, at its scheduled time,
 *     exactly once?
 *
 * Not "did the service start". A running process is what every one of this
 * week's four findings looked like from the outside.
 *
 * Every line is one of PASS / FAIL / NOT OBSERVED. NOT OBSERVED is its own
 * verdict and never collapses into PASS: a job with no scrape_runs row at all
 * has not been shown to work, and saying so is the entire point.
 * ============================================================================
 */
const { pool } = require('../src/db/pool');
const clock = require('../src/market/clock');
const scheduler = require('../src/scheduler');
const { config } = require('../src/config');

const arg = (k) => {
  const m = process.argv.slice(2).find((a) => a.startsWith(`--${k}=`));
  return m ? m.split('=')[1] : null;
};

/** What each after-close job must have PRODUCED, not merely attempted. */
const PRODUCES = {
  'daily.symbolday': {
    sql: 'SELECT count(*)::int AS n FROM symbol_day WHERE trading_date = $1',
    what: 'per-symbol statistics',
  },
  'daily.minutesample': {
    sql: 'SELECT count(*)::int AS n FROM symbol_minute_sample WHERE trading_date = $1',
    what: 'minute board samples',
  },
  'daily.marketday': {
    sql: 'SELECT count(*)::int AS n FROM market_day WHERE trading_date = $1',
    what: 'the market breadth row',
  },
  'signals.score': {
    sql: 'SELECT count(*)::int AS n FROM signal_log WHERE trading_date = $1 AND was_right IS NOT NULL',
    what: 'scored signal outcomes',
  },
  'tradingview.history': {
    sql: 'SELECT count(*)::int AS n FROM tradingview_history WHERE trade_date = $1',
    what: 'daily bars',
  },
  'daily.instruments': {
    sql: 'SELECT count(*)::int AS n FROM instruments WHERE updated_at::date = $1',
    what: 'refreshed instrument rows',
  },
};

/** The minute of day the job was scheduled for, from its own cron. */
function dueAt(name) {
  const expr = scheduler.AFTER_CLOSE_JOBS[name];
  if (!expr) return null;
  const f = String(expr).trim().split(/\s+/);
  if (f.length < 3) return null;
  const m = Number(f[1]); const h = Number(f[2]);
  return Number.isInteger(m) && Number.isInteger(h) ? h * 60 + m : null;
}

const hhmm = (mins) => (mins == null ? '  --  '
  : `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`);

/** How far a start may drift from its cron before it is worth saying so. */
const DRIFT_TOLERANCE_MINS = 10;

(async () => {
  const day = arg('date') || clock.tradingDay();
  const lines = [];
  let fails = 0; let unobserved = 0;

  console.log(`\n  FIRST-SESSION REPORT · ${day}`);
  console.log(`  capture ${config.market.captureStartTime}-${config.market.captureEndTime} · `
    + `session ${config.market.sessionStartTime}-${config.market.sessionEndTime} Kuwait\n`);
  console.log('  job                   due    ran     runs  rows      verdict');
  console.log('  ' + '-'.repeat(72));

  for (const name of Object.keys(PRODUCES)) {
    const due = dueAt(name);
    const spec = PRODUCES[name];

    /* eslint-disable no-await-in-loop */
    const { rows: runs } = await pool.query(
      `SELECT status, started_at, finished_at FROM scrape_runs
        WHERE scraper = $1 AND trading_date = $2 ORDER BY started_at;`, [name, day]);
    let rowCount = null; let readErr = null;
    try {
      const { rows } = await pool.query(spec.sql, [day]);
      rowCount = Number(rows[0] && rows[0].n);
    } catch (e) {
      // A read that FAILED is not zero rows. It is its own answer.
      readErr = e.message;
    }
    /* eslint-enable no-await-in-loop */

    const ok = runs.filter((r) => r.status === 'SUCCESS');
    const ranAt = ok.length
      ? (() => { const p = clock.parts(new Date(ok[0].started_at)); return p.hour * 60 + p.minute; })()
      : null;

    let verdict; let note = '';
    if (readErr) {
      verdict = 'NOT OBSERVED'; unobserved += 1;
      note = `the row count could not be read (${readErr.slice(0, 60)}) — not the same as zero`;
    } else if (!runs.length) {
      verdict = 'NOT OBSERVED'; unobserved += 1;
      note = 'no scrape_runs row at all — the job did not fire, and a schedule that has '
           + 'never run is not a schedule that works';
    } else if (!ok.length) {
      verdict = 'FAIL'; fails += 1;
      note = `ran but never succeeded (${runs.map((r) => r.status).join(', ')})`;
    } else if (ok.length > 1) {
      verdict = 'FAIL'; fails += 1;
      note = `${ok.length} SUCCESS runs — a nightly job that ran more than once may have `
           + 'written the day twice, and an idempotent job hides that rather than preventing it';
    } else if (!rowCount) {
      verdict = 'FAIL'; fails += 1;
      note = `SUCCESS with no ${spec.what} — the run reported done and produced nothing`;
    } else if (due != null && ranAt != null && Math.abs(ranAt - due) > DRIFT_TOLERANCE_MINS) {
      verdict = 'FAIL'; fails += 1;
      note = `started ${ranAt - due > 0 ? 'late' : 'early'} by `
           + `${Math.abs(ranAt - due)} min — on the clock it was given, or by the catch-up?`;
    } else {
      verdict = 'PASS';
    }

    console.log(`  ${name.padEnd(21)} ${hhmm(due)}  ${hhmm(ranAt)}  `
      + `${String(ok.length).padStart(4)}  ${String(rowCount ?? '  --').padStart(6)}    ${verdict}`);
    if (note) lines.push(`      ${name}: ${note}`);
  }

  if (lines.length) { console.log(); lines.forEach((l) => console.log(l)); }

  console.log('\n  ' + '-'.repeat(72));
  if (fails === 0 && unobserved === 0) {
    console.log('  ALL OBSERVED — every after-close job produced rows, at its time, once.');
  } else {
    console.log(`  ${fails} FAILED, ${unobserved} NOT OBSERVED.`);
    console.log('  NOT OBSERVED is not a pass. A schedule correct in code and never seen to');
    console.log('  run is the shape of all four defects found this week.');
  }
  console.log();

  await pool.end();
  process.exit(fails === 0 && unobserved === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('first-session-report FAILED to run:', e.message);
  await pool.end().catch(() => {});
  process.exit(2);
});

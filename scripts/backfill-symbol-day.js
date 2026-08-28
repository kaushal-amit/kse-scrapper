'use strict';
/**
 * scripts/backfill-symbol-day.js — compute symbol_day over a range.
 *
 *   node scripts/backfill-symbol-day.js --from=2026-07-14 --to=2026-08-25
 *   node scripts/backfill-symbol-day.js --from=... --to=... --apply
 *
 * DRY RUN BY DEFAULT.
 *
 * One day at a time, through the same job the scheduler calls. A range-aware
 * variant would be a second implementation of the same arithmetic, and the two
 * would eventually disagree — which is the failure that has cost the most time
 * on this project.
 *
 * Days are taken from the DATA, not from a calendar: 19, 20 and 23 August have
 * no quotes, and iterating dates would compute empty rows for them.
 */

const { query, close } = require('../src/db/pool');
const { compute } = require('../src/jobs/computeSymbolDay');

const arg = (n) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split('=')[1] : null;
};
const FROM = arg('from');
const TO = arg('to');
const APPLY = process.argv.includes('--apply');

async function main() {
  if (!FROM || !TO) {
    console.error('\n  --from=YYYY-MM-DD --to=YYYY-MM-DD are required.\n');
    process.exit(1);
  }

  const { rows: days } = await query(`
    SELECT DISTINCT trading_date::text AS d
      FROM awsat_market_quotes
     WHERE trading_date BETWEEN $1 AND $2
     ORDER BY 1`, [FROM, TO]);

  console.log(`\n  BACKFILL symbol_day  ${APPLY ? '(APPLY)' : '(DRY RUN)'}`);
  console.log(`  ${FROM} .. ${TO} — ${days.length} session(s) with data`);
  console.log(`  ${'─'.repeat(66)}`);

  if (!APPLY) {
    for (const { d } of days) console.log(`    ${d}`);
    console.log('\n  Dry run — nothing computed. Re-run with --apply.\n');
    return;
  }

  let ok = 0;
  let failed = 0;
  let totalRows = 0;
  let totalThin = 0;

  for (const { d } of days) {
    try {
      const r = await compute(d, null);
      totalRows += r.inserted;
      totalThin += r.thin || 0;
      ok += 1;
      console.log(`    ${d}  ${String(r.inserted).padStart(4)} symbol(s)`
        + (r.thin ? `   ${r.thin} THIN` : ''));
    } catch (err) {
      // A schema mismatch will fail identically on every remaining day. Stop
      // once with the fix rather than printing it 28 times.
      if (/schema is behind/.test(err.message)) {
        console.log(`\n  ${err.message}\n`);
        console.log('  Stopping — every remaining day would fail the same way.\n');
        break;
      }
      // One bad day must not stop the rest — the others are still worth having,
      // and the failure is named rather than swallowed.
      failed += 1;
      console.log(`    ${d}  FAILED: ${err.message.slice(0, 70)}`);
    }
  }

  console.log(`  ${'─'.repeat(66)}`);
  console.log(`  ${ok} session(s) computed, ${failed} failed, `
    + `${totalRows} row(s), ${totalThin} THIN\n`);
}

main().then(async () => { await close(); process.exit(0); })
  .catch(async (e) => { console.error(`\n  failed: ${e.message}\n`); await close(); process.exit(1); });

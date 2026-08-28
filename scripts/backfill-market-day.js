'use strict';
/**
 * scripts/backfill-market-day.js — compute market_day over a range.
 *
 *   node scripts/backfill-market-day.js --from=2026-07-14 --to=2026-08-25
 *   node scripts/backfill-market-day.js --from=... --to=... --apply
 *
 * DRY RUN BY DEFAULT.
 *
 * Days come from symbol_day, not a calendar — it reads that table, so a date
 * with no rows there has nothing to compute and the job would refuse anyway.
 *
 * Order matters: rolling windows (breadth_5d_avg, volume_vs_20d) read PRIOR
 * market_day rows, so the days must be computed oldest first. Running them out
 * of order silently produces NULL rolling figures on days that should have
 * them.
 */

const { query, close } = require('../src/db/pool');
const { compute } = require('../src/jobs/computeMarketDay');

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
    SELECT DISTINCT trading_date::text AS d FROM symbol_day
     WHERE trading_date BETWEEN $1 AND $2
     ORDER BY 1`, [FROM, TO]);

  console.log(`\n  BACKFILL market_day  ${APPLY ? '(APPLY)' : '(DRY RUN)'}`);
  console.log(`  ${FROM} .. ${TO} — ${days.length} session(s) in symbol_day`);
  console.log(`  ${'─'.repeat(66)}`);

  if (!days.length) {
    console.log('\n  No symbol_day rows in that range. Run backfill:symbolday first.\n');
    return;
  }
  if (!APPLY) {
    for (const { d } of days) console.log(`    ${d}`);
    console.log('\n  Dry run — nothing computed. Re-run with --apply.\n');
    return;
  }

  let ok = 0;
  let failed = 0;
  const regimes = {};

  for (const { d } of days) {
    try {
      const r = await compute(d, null);
      regimes[r.regime] = (regimes[r.regime] || 0) + 1;
      ok += 1;
      console.log(`    ${d}  ${String(r.extracted).padStart(4)} symbol(s)  ${r.regime}`);
    } catch (err) {
      // A schema mismatch will fail identically on every remaining day. Stop
      // once with the fix rather than printing it 28 times.
      if (/schema is behind/.test(err.message)) {
        console.log(`\n  ${err.message}\n`);
        console.log('  Stopping — every remaining day would fail the same way.\n');
        break;
      }
      failed += 1;
      console.log(`    ${d}  FAILED: ${err.message.slice(0, 70)}`);
    }
  }

  console.log(`  ${'─'.repeat(66)}`);
  console.log(`  ${ok} session(s), ${failed} failed`);
  console.log(`  regimes: ${Object.entries(regimes).map(([k, v]) => `${k} ${v}`).join(' · ')}\n`);
}

main().then(async () => { await close(); process.exit(0); })
  .catch(async (e) => { console.error(`\n  failed: ${e.message}\n`); await close(); process.exit(1); });

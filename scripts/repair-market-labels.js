'use strict';
/**
 * scripts/repair-market-labels.js — the market-label repair, run deliberately.
 *
 * WHAT IT REPAIRS. One symbol under two markets at the SAME INSTANT is one
 * observation stored twice: a board sweep that failed to switch screens and
 * re-read the previous market. The minority label on those days is the wrong
 * one and its rows are duplicates.
 *
 * WHY IT IS A SCRIPT AND NOT PART OF migrate-all. It DELETES rows from the
 * trader's own capture record, and a trading minute cannot be re-scraped — the
 * data was paid for once. `migrate-all` used to call it with `{ apply: true }`,
 * so the deletion ran unattended as part of a migration. The block beside it
 * had already reached the opposite conclusion for removeUnwantedMarkets, for
 * exactly this reason, and left that one reporting-only.
 *
 * DRY RUN BY DEFAULT.
 *
 *   node scripts/repair-market-labels.js                 # what it would do
 *   node scripts/repair-market-labels.js --apply         # do it
 *   node scripts/repair-market-labels.js --confidence=0.95
 *
 * SCOPED TO THE COLLIDING DAYS. The share is measured on the days the collision
 * actually happened, and only rows on those days are deleted. Measured over a
 * symbol's lifetime instead — as it used to be — a stock that genuinely CHANGED
 * market (026 documents DALQANRE doing exactly that) would have its entire
 * history in the minority market deleted on the evidence of one bad sweep.
 */

const repair = require('../src/migration/repair');
const { close } = require('../src/db/pool');

const arg = (name, def = null) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : def;
};
const APPLY = process.argv.slice(2).includes('--apply');
const confidence = Number(arg('confidence', 0.9));

function log(...a) { process.stdout.write(a.join(' ') + '\n'); }

(async () => {
  if (!Number.isFinite(confidence) || confidence <= 0.5 || confidence > 1) {
    throw new Error(`--confidence must be between 0.5 and 1 (got "${arg('confidence')}"). `
      + 'Below 0.5 the "minority" label would be the majority one.');
  }

  log(`market-label repair — confidence ${confidence} — ${APPLY ? 'APPLY' : 'DRY RUN'}`);

  const res = await repair.repairMarketLabels({ apply: APPLY, confidence });

  if (!res.decided.length && !res.unclear.length) {
    log('  no same-instant duplicates. Nothing to repair.');
    return;
  }

  for (const d of res.decided) {
    log(`  ${d.symbol.padEnd(12)} ${d.distribution}`);
    log(`      keep ${d.keep}; drop ${d.drop.join(', ')} on ${d.days.length} day(s): ${d.days.join(', ')}`);
  }
  if (res.unclear.length) {
    log(`\n  ${res.unclear.length} symbol(s) too evenly split to judge — LEFT ALONE:`);
    for (const u of res.unclear) log(`      ${u.symbol.padEnd(12)} ${u.distribution}`);
    log('      An even split is not a failed switch. Investigate before deleting.');
  }

  if (APPLY) log(`\n  removed ${res.deleted} row(s).`);
  else log('\n  DRY RUN — nothing deleted. Re-run with --apply.');
})()
  .then(() => close())
  .catch((e) => { process.stderr.write(`\n${e.message}\n`); close().finally(() => process.exit(1)); });

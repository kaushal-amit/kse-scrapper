'use strict';
/**
 * scripts/seed-depth-slots.js — the night-before pre-day picks.
 *
 *   node scripts/seed-depth-slots.js --date=2026-08-30 --slots=MRC,EMIRATES,CATTL
 *   node scripts/seed-depth-slots.js --date=2026-08-30 --slots=... --apply
 *
 * DRY RUN BY DEFAULT.
 *
 * Date and symbols are both parameters. A script with next Sunday's date baked
 * into it is wrong the following week and right-looking the whole time.
 *
 * Only slots 1-3 — 4-8 are claimed by the wake-up scan from 09:00, inserted on
 * claim. Not seeding is a legitimate choice: the day then runs on wake-ups
 * alone, which is correct behaviour and not an error.
 */

const { query, close } = require('../src/db/pool');

const arg = (n) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : null;
};
const DATE = arg('date');
const SLOTS = (arg('slots') || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const APPLY = process.argv.includes('--apply');
const MAX_PRE_DAY = 3;

async function main() {
  if (!DATE || !SLOTS.length) {
    console.error('\n  --date=YYYY-MM-DD and --slots=SYM,SYM,SYM are required.\n');
    console.error('    node scripts/seed-depth-slots.js --date=2026-08-30 --slots=MRC,EMIRATES,CATTL\n');
    process.exit(1);
  }
  if (SLOTS.length > MAX_PRE_DAY) {
    console.error(`\n  ${SLOTS.length} symbols given; only slots 1-${MAX_PRE_DAY} are PRE_DAY.`);
    console.error('  Slots 4-8 belong to the wake-up scan and cannot be pre-assigned.\n');
    process.exit(1);
  }

  console.log(`\n  SEED depth slots  ${APPLY ? '(APPLY)' : '(DRY RUN)'}`);
  console.log(`  ${DATE}`);
  console.log(`  ${'─'.repeat(60)}`);

  // A symbol nobody has quotes for cannot have its book read. Better to say so
  // now than to hold a slot all session and capture nothing.
  const { rows: known } = await query(
    'SELECT DISTINCT symbol FROM instruments WHERE upper(symbol) = ANY($1)', [SLOTS]);
  const haveSet = new Set(known.map((r) => r.symbol.toUpperCase()));
  const unknown = SLOTS.filter((s) => !haveSet.has(s));

  SLOTS.forEach((s, i) => {
    console.log(`    slot ${i + 1}   ${s.padEnd(14)}`
      + (haveSet.has(s) ? 'known' : 'NOT IN instruments — the sweep will find nothing'));
  });

  const { rows: existing } = await query(
    `SELECT slot_no, symbol, slot_type FROM depth_watchlist
      WHERE trading_date = $1 ORDER BY slot_no`, [DATE]);
  if (existing.length) {
    console.log(`\n  Already assigned for ${DATE}:`);
    for (const e of existing) {
      console.log(`    slot ${e.slot_no}   ${String(e.symbol).padEnd(14)} ${e.slot_type}`);
    }
  }

  if (!APPLY) {
    console.log('\n  Dry run — nothing written. Re-run with --apply.\n');
    return;
  }
  if (unknown.length) {
    console.log(`\n  ${unknown.length} unknown symbol(s) — seeding anyway, but check the spelling.`);
  }

  let written = 0;
  for (let i = 0; i < SLOTS.length; i += 1) {
    const res = await query(
      `INSERT INTO depth_watchlist
         (trading_date, slot_no, symbol, slot_type, assigned_by)
       VALUES ($1, $2, $3, 'PRE_DAY', 'SEED')
       ON CONFLICT (trading_date, slot_no) DO UPDATE SET
         symbol = EXCLUDED.symbol,
         assigned_at = now(),
         released_at = NULL,
         assigned_by = 'SEED'
       RETURNING slot_no`, [DATE, i + 1, SLOTS[i]]);
    written += res.rowCount;
  }

  console.log(`\n  ${written} pre-day slot(s) assigned for ${DATE}.`);
  console.log('  Slots 4-8 fill from 09:00 as symbols wake.\n');
}

main().then(async () => { await close(); process.exit(0); })
  .catch(async (e) => { console.error(`\n  failed: ${e.message}\n`); await close(); process.exit(1); });

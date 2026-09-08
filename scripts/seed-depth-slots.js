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
// Q-10 · displacing a slot that already holds a live symbol needs an explicit
// --force and a --reason, so a mid-session re-seed is never silent.
const FORCE = process.argv.includes('--force');
const REASON = arg('reason');
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

  /**
   * REFUSE THE WHOLE BATCH IF A SYMBOL ALREADY HOLDS A DIFFERENT SLOT.
   *
   * ─── WHY NOT JUST REASSIGN ─────────────────────────────────────────────
   * The unique index enforces one slot per symbol, so reassigning CATTL from
   * slot 3 to slot 1 fails — but it failed AFTER writing slot 1, leaving the
   * day half-seeded with a raw Postgres error nobody can act on.
   *
   * Refusing up front is better than releasing the old slot silently: a
   * pre-day pick that quietly moves is a pick nobody chose, and the point of
   * slot order is that 1-3 are swept first.
   */
  const { rows: held } = await query(
    `SELECT slot_no, symbol FROM depth_watchlist
      WHERE trading_date = $1 AND symbol = ANY($2) AND released_at IS NULL`,
    [DATE, SLOTS]);

  const conflicts = held.filter((h) => SLOTS.indexOf(h.symbol.toUpperCase()) + 1 !== h.slot_no);
  if (conflicts.length) {
    console.error('\n  REFUSING — these symbols already hold a different slot today:\n');
    for (const c of conflicts) {
      console.error(`    ${c.symbol.padEnd(14)} holds slot ${c.slot_no}, `
        + `you asked for slot ${SLOTS.indexOf(c.symbol.toUpperCase()) + 1}`);
    }
    console.error('\n  One symbol, one slot. Release it first, or seed it in the slot');
    console.error('  it already holds:\n');
    // The order they are ALREADY in. Building it by swapping pairs produced a
    // list with a symbol twice — a suggestion that fails the moment it is run
    // is worse than none.
    const { rows: current } = await query(
      `SELECT symbol FROM depth_watchlist
        WHERE trading_date = $1 AND slot_type = 'PRE_DAY' AND released_at IS NULL
        ORDER BY slot_no`, [DATE]);
    if (current.length) {
      console.error(`    --slots=${current.map((r) => r.symbol).join(',')}\n`);
    }
    console.error('  Or release: UPDATE depth_watchlist SET released_at = now()');
    console.error(`               WHERE trading_date = '${DATE}' AND symbol = ANY(ARRAY[...]);\n`);
    process.exit(1);
  }

  /**
   * Q-10 · A SLOT THAT ALREADY HOLDS A DIFFERENT LIVE SYMBOL IS BEING DISPLACED.
   *
   * The seed is the night-before tool. Re-run mid-session — as it was at
   * 11:40:50 on the day this was filed — its ON CONFLICT DO UPDATE silently
   * overwrote whatever slot 1-3 held, stamping assigned_by='SEED' with no record
   * of what it replaced or why. That is the re-seed nobody could explain.
   *
   * So: a target slot holding a DIFFERENT active symbol is a displacement.
   * Refuse it unless --force, and when forced REQUIRE a --reason and RECORD the
   * displaced symbol + reason in the audit columns (migration 037). A first-ever
   * seed on an empty day displaces nothing and is unaffected.
   */
  const { rows: activeRows } = await query(
    `SELECT slot_no, symbol FROM depth_watchlist
      WHERE trading_date = $1 AND released_at IS NULL`, [DATE]);
  const activeBySlot = new Map(activeRows.map((r) => [r.slot_no, r.symbol.toUpperCase()]));
  const displacements = [];
  for (let i = 0; i < SLOTS.length; i += 1) {
    const held = activeBySlot.get(i + 1);
    if (held && held !== SLOTS[i]) displacements.push({ slot: i + 1, from: held, to: SLOTS[i] });
  }

  if (displacements.length && !FORCE) {
    console.error('\n  REFUSING — these slots already hold a different live symbol:\n');
    for (const d of displacements) console.error(`    slot ${d.slot}   ${d.from.padEnd(14)} → ${d.to}`);
    console.error('\n  This looks like a mid-session re-seed. The night-before seed is not meant');
    console.error('  to overwrite live slots — that is the silent re-seed Q-10 is about.');
    console.error('  If you really mean to displace them, say so and say why:\n');
    console.error(`    node scripts/seed-depth-slots.js --date=${DATE} --slots=${SLOTS.join(',')} --apply --force --reason="..."\n`);
    process.exit(1);
  }
  if (displacements.length && FORCE && !REASON) {
    console.error('\n  --force needs --reason="why these live slots are being displaced".');
    console.error('  A forced re-seed with no reason is exactly the silent overwrite Q-10 flagged.\n');
    process.exit(1);
  }

  if (!APPLY) {
    console.log('\n  Dry run — nothing written. Re-run with --apply.\n');
    if (displacements.length) console.log(`  (would displace: ${displacements.map((d) => `slot ${d.slot} ${d.from}→${d.to}`).join(', ')})\n`);
    return;
  }
  if (unknown.length) {
    console.log(`\n  ${unknown.length} unknown symbol(s) — seeding anyway, but check the spelling.`);
  }

  const displacedBySlot = new Map(displacements.map((d) => [d.slot, d.from]));
  let written = 0;
  for (let i = 0; i < SLOTS.length; i += 1) {
    const displaced = displacedBySlot.get(i + 1) || null;
    const res = await query(
      `INSERT INTO depth_watchlist
         (trading_date, slot_no, symbol, slot_type, assigned_by,
          replaced_symbol, replaced_at, replaced_by, replaced_reason)
       VALUES ($1, $2, $3, 'PRE_DAY', 'SEED',
               $4, CASE WHEN $4::text IS NULL THEN NULL ELSE now() END,
               CASE WHEN $4::text IS NULL THEN NULL ELSE 'SEED' END, $5)
       ON CONFLICT (trading_date, slot_no) DO UPDATE SET
         symbol = EXCLUDED.symbol,
         assigned_at = now(),
         released_at = NULL,
         assigned_by = 'SEED',
         replaced_symbol = EXCLUDED.replaced_symbol,
         replaced_at = EXCLUDED.replaced_at,
         replaced_by = EXCLUDED.replaced_by,
         replaced_reason = EXCLUDED.replaced_reason
       RETURNING slot_no`,
      [DATE, i + 1, SLOTS[i], displaced, displaced ? (REASON || 'seed re-run') : null]);
    written += res.rowCount;
    if (displaced) console.log(`    slot ${i + 1}   displaced ${displaced} → ${SLOTS[i]}  (recorded: ${REASON})`);
  }

  console.log(`\n  ${written} pre-day slot(s) assigned for ${DATE}.`);
  console.log('  Slots 4-8 fill from 09:00 as symbols wake.\n');
}

main().then(async () => { await close(); process.exit(0); })
  .catch(async (e) => { console.error(`\n  failed: ${e.message}\n`); await close(); process.exit(1); });

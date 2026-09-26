#!/usr/bin/env node
'use strict';
/**
 * ============================================================================
 *  C1 · RE-SCORE THE SIGNAL LOG — DRY RUN BY DEFAULT
 * ============================================================================
 *   node scripts/rescore-signals.js [--from=YYYY-MM-DD] [--apply]
 *
 * Signals were graded against the first capture AT OR AFTER fired_at + N. On
 * a ~60-second grid, with signals firing seconds after the capture they are
 * computed from, that is about a minute late on most of them — 232 of the
 * last 400 by more than 50 s — and it grades against a print that had not
 * happened at the mark. Lookahead, one-sided, in the evidence base.
 *
 * priceInForceAt now takes the last capture AT OR BEFORE the mark. This
 * re-scores what the old rule already graded, because a rule change that
 * leaves the stored rows alone has fixed nothing anyone reads.
 *
 * ─── WHY IT IS A DRY RUN FIRST ─────────────────────────────────────────────
 * This rewrites the numbers the strategy is judged on. Before that happens
 * somebody should see HOW MUCH it moves and in which direction — a correction
 * that flips a third of the grades is a different conversation from one that
 * flips four.
 *
 * So the default run recomputes every horizon in memory, writes nothing, and
 * prints the before/after tally per signal family plus the rows whose verdict
 * changes. --apply then does it for real, through the same code path a
 * nightly run uses.
 *
 * EXPECT THE GRADED COUNT TO FALL. A horizon with no capture between the
 * signal and the mark, or only a stale one, is now NOT COMPUTED rather than
 * silently graded. That is a real loss of rows and the point of the exercise:
 * some of what the log calls an outcome was never measurable. A smaller
 * denominator that means something beats a larger one that does not.
 * ============================================================================
 */
const { query, close } = require('../src/db/pool');
const score = require('../src/jobs/scoreSignals');

const arg = (k) => {
  const m = process.argv.slice(2).find((a) => a.startsWith(`--${k}=`));
  return m ? m.split('=')[1] : null;
};
const APPLY = process.argv.includes('--apply');
const FROM = arg('from');

const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '  -  ');

(async () => {
  const { rows } = await query(
    `SELECT id, symbol, signal, fired_at, price, px_5min, was_right
       FROM signal_log
      WHERE ($1::date IS NULL OR trading_date >= $1::date)
        AND scored_at IS NOT NULL
      ORDER BY fired_at`, [FROM]);

  console.log(`\n  RE-SCORE · ${rows.length} scored signals${FROM ? ` from ${FROM}` : ''}`
    + `  ·  ${APPLY ? 'APPLY' : 'DRY RUN — nothing is written'}\n`);

  /** old/new tallies per family, and the rows that move. */
  const tally = new Map();
  const moved = [];
  let lateOld = 0;

  for (const s of rows) {
    const fam = s.signal;
    if (!tally.has(fam)) {
      tally.set(fam, { n: 0, oldRight: 0, oldGraded: 0, newRight: 0, newGraded: 0, lost: 0 });
    }
    const t = tally.get(fam);
    t.n += 1;

    /* eslint-disable no-await-in-loop */
    const px5 = await score.priceInForceAt(s.symbol, s.fired_at, 5);
    /* eslint-enable no-await-in-loop */
    const base = s.price === null ? null : Number(s.price);
    const now = score.grade(base, px5, score.MODE[fam]);

    if (s.was_right !== null) { t.oldGraded += 1; if (s.was_right) t.oldRight += 1; }
    if (now !== null) { t.newGraded += 1; if (now) t.newRight += 1; }
    if (s.was_right !== null && now === null) t.lost += 1;

    // How often the stored px_5min differs from the in-force price at all.
    if (s.px_5min != null && px5 != null && Number(s.px_5min) !== px5) lateOld += 1;

    if (s.was_right !== now) {
      moved.push({ id: s.id, sym: s.symbol, fam, was: s.was_right, now,
        oldPx: s.px_5min == null ? null : Number(s.px_5min), newPx: px5 });
    }
  }

  console.log('  family           n   graded→   right→        was_right    now');
  console.log('  ' + '-'.repeat(68));
  let gOld = 0, gNew = 0, rOld = 0, rNew = 0, lost = 0;
  for (const [fam, t] of [...tally.entries()].sort()) {
    gOld += t.oldGraded; gNew += t.newGraded; rOld += t.oldRight; rNew += t.newRight; lost += t.lost;
    console.log(`  ${fam.padEnd(15)} ${String(t.n).padStart(3)}   `
      + `${String(t.oldGraded).padStart(4)}→${String(t.newGraded).padStart(4)}  `
      + `${String(t.oldRight).padStart(4)}→${String(t.newRight).padStart(4)}     `
      + `${pct(t.oldRight, t.oldGraded).padStart(7)}  ${pct(t.newRight, t.newGraded).padStart(7)}`);
  }
  console.log('  ' + '-'.repeat(68));
  console.log(`  TOTAL           ${String(rows.length).padStart(3)}   `
    + `${String(gOld).padStart(4)}→${String(gNew).padStart(4)}  `
    + `${String(rOld).padStart(4)}→${String(rNew).padStart(4)}     `
    + `${pct(rOld, gOld).padStart(7)}  ${pct(rNew, gNew).padStart(7)}`);

  console.log(`\n  ${moved.length} verdicts change.`);
  console.log(`  ${lost} rows lose their grade entirely — the horizon was never measurable.`);
  console.log(`  ${lateOld} rows had a stored px_5min that differs from the price in force `
    + 'at the mark;\n  every one of those was graded on information the mark did not have.');

  if (moved.length) {
    console.log('\n  first 20 that move:');
    console.log('    id      symbol      family           was → now     px_5min → in force');
    for (const m of moved.slice(0, 20)) {
      const v = (x) => (x === null ? 'NULL ' : x ? 'TRUE ' : 'FALSE');
      const p = (x) => (x === null ? '  --' : String(x));
      console.log(`    ${String(m.id).padEnd(7)} ${m.sym.padEnd(11)} ${m.fam.padEnd(16)} `
        + `${v(m.was)}→ ${v(m.now)}   ${p(m.oldPx).padStart(7)} → ${p(m.newPx)}`);
    }
  }

  if (!APPLY) {
    console.log('\n  DRY RUN — nothing written. Re-run with --apply to commit this.\n');
    await close();
    return;
  }

  const out = await score.rescoreAll(null, { from: FROM });
  console.log(`\n  APPLIED · cleared ${out.cleared}, re-scored across ${out.days} day(s).`);

  /*
   * PROVE IT TOOK. The whole reason this exists is that a change in code does
   * not reach stored rows on its own, so the script that reaches them says
   * whether it arrived rather than leaving somebody to check by hand later.
   */
  const { rows: after } = await query(
    `SELECT count(*)::int AS n,
            count(*) FILTER (WHERE scored_at IS NULL)::int AS unscored
       FROM signal_log WHERE ($1::date IS NULL OR trading_date >= $1::date)`, [FROM]);
  if (after[0].unscored > 0) {
    console.log(`\n  WARNING: ${after[0].unscored} of ${after[0].n} rows are still unscored. `
      + 'The clear ran and the re-score did not finish.\n');
    await close();
    process.exit(1);
  }
  console.log(`  verified: all ${after[0].n} rows carry a fresh scored_at.\n`);
  await close();
})().catch(async (e) => {
  console.error('rescore-signals FAILED:', e.message);
  await close().catch(() => {});
  process.exit(2);
});

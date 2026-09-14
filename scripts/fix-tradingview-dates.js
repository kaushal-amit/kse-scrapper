'use strict';
/**
 * scripts/fix-tradingview-dates.js — CR-12 · shift the corrupt trade_date block.
 *
 *   node scripts/fix-tradingview-dates.js                              # DRY RUN, and reports the window
 *   node scripts/fix-tradingview-dates.js --from=2026-07-13 --cutover=2026-08-05
 *   node scripts/fix-tradingview-dates.js --from=2026-07-13 --cutover=2026-08-05 --apply
 *
 * DRY RUN BY DEFAULT. Amit is the only deployer — run the dry run, read the
 * pre-checks, then re-run with --apply against a backup/staging first.
 *
 * WHAT IT DOES (and why the register's plain UPDATE could not):
 *   Every tradingview_history row inside the corrupt window is stamped one day
 *   early (verified on CATTL: tv close on D == symbol_day close on D+1), and the
 *   table holds Saturday sessions Boursa Kuwait cannot have. Those rows must
 *   move +1 day. Two things make a naive `UPDATE … SET trade_date = trade_date + 1`
 *   fail or mislead, both handled here:
 *     · PRIMARY KEY (symbol, trade_date): shifting dense consecutive dates
 *       collides row-by-row mid-statement (duplicate key). So: DROP the PK →
 *       shift → re-ADD the PK, inside one transaction. The re-add fails loudly
 *       if the shift ever produced a duplicate.
 *     · the register's collision query counts benign consecutive-day adjacency.
 *       The REAL pre-check is a shifted row landing on an UN-shifted row just
 *       past the cutover; that must be 0.
 *
 * THE WINDOW IS BOUNDED AT BOTH ENDS, AND --from HAS NO DEFAULT.
 *   An earlier revision of this script bounded the shift only at the top
 *   (`WHERE trade_date <= cutover`), so every row older than the corruption was
 *   shifted too. On a symbol thin enough to own no Thursday in the shifted
 *   range, that produces no weekend row, the commit gate reads zero, and a
 *   previously CORRECT history is silently moved one day — on the table that
 *   feeds symbol_day.prev_close and chg_1d. There is no safe default for the
 *   lower bound: a guessed --from is exactly the plausible-but-wrong number
 *   this project refuses. So --apply REQUIRES --from, and the dry run's job is
 *   to give you the evidence for choosing it.
 *
 * GATED: the transaction refuses to COMMIT unless, after the shift, zero rows
 * fall on Fri/Sat — ACROSS THE WHOLE TABLE, not just the window. That is what
 * makes a too-narrow --from fail loudly: weekend rows left below the window
 * survive the shift, the gate sees them, and everything rolls back. The backup
 * table is left in place regardless.
 *
 * This fixes the DATA. The WRITER that produced it is fixed separately in
 * src/scrapers/historyTransform.js (rowDay + the weekend refuse-guard).
 */

const { pool, query, close } = require('../src/db/pool');

const arg = (name, def = null) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : def;
};

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * node-pg hands a `date` column back as a JS Date, and String(Date) renders
 * "Fri Jul 17 2026 …" — a US-locale string in the SERVER's timezone, which is
 * both unreadable here and one DST-free-zone assumption away from naming the
 * wrong day. Every date printed by this script goes through here.
 */
function isoDay(v) {
  if (v === null || v === undefined) return '—';
  if (v instanceof Date) {
    return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}-${String(v.getUTCDate()).padStart(2, '0')}`;
  }
  return String(v).slice(0, 10);
}

/**
 * Validate the shift window. Exported so the rules are testable without a
 * database: the window's correctness is the whole safety property here.
 *
 * Returns { from, cutover } or throws with the sentence an operator needs.
 */
function validateWindow({ from, cutover, apply }) {
  if (!ISO_DAY.test(String(cutover))) {
    throw new Error(`--cutover must be YYYY-MM-DD (got "${cutover}")`);
  }
  if (from === null || from === undefined || from === '') {
    if (apply) {
      throw new Error(
        'REFUSING: --apply needs --from=YYYY-MM-DD, the FIRST corrupted date. '
        + 'Without a lower bound the shift moves every row older than the corruption too, '
        + 'and on a thin symbol that produces no weekend row for the gate to catch. '
        + 'Run the dry run first — it reports the earliest weekend row, which is the evidence for --from.');
    }
    return { from: null, cutover };
  }
  if (!ISO_DAY.test(String(from))) {
    throw new Error(`--from must be YYYY-MM-DD (got "${from}")`);
  }
  if (from > cutover) {
    throw new Error(`--from (${from}) is after --cutover (${cutover}) — the window is empty.`);
  }
  return { from, cutover };
}

/** A backup name that is unique per RUN, not per day. See the note in main(). */
function backupName(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14); // YYYYMMDDHHMMSS
  return `public.tradingview_history_backup_${stamp}`;
}

function log(...a) { process.stdout.write(a.join(' ') + '\n'); }

async function main() {
  const APPLY = process.argv.slice(2).includes('--apply');
  const { from: FROM, cutover: CUTOVER } =
    validateWindow({ from: arg('from'), cutover: arg('cutover', '2026-08-05'), apply: APPLY });

  log(`CR-12 · tradingview_history date shift — window ${FROM || '(unbounded — dry run only)'} … ${CUTOVER} — ${APPLY ? 'APPLY' : 'DRY RUN'}`);

  // ── pre-checks ──────────────────────────────────────────────────────────
  // $2 is the lower bound; NULL means "no lower bound", which only the dry run
  // is allowed to reach. Written as a single statement so every number below
  // describes the same instant.
  const { rows: [pre] } = await query(
    `SELECT
       (SELECT count(*) FROM public.tradingview_history
         WHERE EXTRACT(dow FROM trade_date) IN (5,6))                       AS weekend_rows,
       (SELECT min(trade_date) FROM public.tradingview_history
         WHERE EXTRACT(dow FROM trade_date) IN (5,6))                       AS first_weekend,
       (SELECT max(trade_date) FROM public.tradingview_history
         WHERE EXTRACT(dow FROM trade_date) IN (5,6))                       AS last_weekend,
       (SELECT count(*) FROM public.tradingview_history
         WHERE trade_date <= $1::date
           AND ($2::date IS NULL OR trade_date >= $2::date))                AS to_shift,
       (SELECT count(*) FROM public.tradingview_history
         WHERE EXTRACT(dow FROM trade_date) IN (5,6)
           AND $2::date IS NOT NULL AND trade_date < $2::date)              AS weekend_below_window,
       (SELECT count(*) FROM public.tradingview_history a
          JOIN public.tradingview_history b
            ON b.symbol = a.symbol AND b.trade_date = a.trade_date + 1
         WHERE a.trade_date <= $1::date
           AND ($2::date IS NULL OR a.trade_date >= $2::date)
           AND b.trade_date > $1::date)                                     AS real_collisions`,
    [CUTOVER, FROM]);

  const weekendRows = Number(pre.weekend_rows);
  const toShift = Number(pre.to_shift);
  const realCollisions = Number(pre.real_collisions);
  const weekendBelow = Number(pre.weekend_below_window);

  log(`  weekend rows now:         ${weekendRows}   (should be > 0 — the corruption)`);
  log(`  earliest weekend row:     ${isoDay(pre.first_weekend)}   <- the evidence for --from`);
  log(`  latest weekend row:       ${isoDay(pre.last_weekend)}`);
  log(`  rows to shift (in window):${toShift}`);
  log(`  real boundary collisions: ${realCollisions}   (MUST be 0)`);
  if (FROM) log(`  weekend rows BELOW --from:${weekendBelow}   (MUST be 0 — otherwise --from is too late)`);

  if (weekendRows === 0) { log('\nNothing to fix — no weekend rows. Aborting.'); return; }
  if (realCollisions !== 0) {
    throw new Error(`REFUSING: ${realCollisions} real boundary collisions — a shifted row would land on an existing one. Re-check the cutover.`);
  }
  // A weekend row older than --from is proof the corruption starts earlier than
  // declared. Shifting on that premise leaves it behind and the commit gate
  // would roll the whole run back anyway — say so here, before the backup.
  if (FROM && weekendBelow !== 0) {
    throw new Error(
      `REFUSING: ${weekendBelow} weekend row(s) fall BELOW --from=${FROM} (earliest is `
      + `${isoDay(pre.first_weekend)}). The corruption starts earlier than declared — `
      + 'widen --from, or establish that those rows are a different fault.');
  }

  if (!APPLY) {
    log(FROM
      ? '\nDRY RUN — no changes. Re-run with --apply (against a backup/staging first).'
      : `\nDRY RUN — no changes, and no --from was given. The earliest weekend row is `
        + `${isoDay(pre.first_weekend)}; confirm that is where the `
        + 'corruption starts, then re-run with --from=<that date> --apply.');
    return;
  }

  // ── back up (outside the transaction, so it survives a rollback) ─────────
  // Schema-qualified: every other statement here says public., and a role whose
  // search_path puts the backend's `spread` first would otherwise park a copy of
  // this table across the schema seam this repo must never write.
  // Named per RUN, not per day, and created WITHOUT `IF NOT EXISTS`: a second
  // run on the same day used to silently reuse the first run's snapshot while
  // printing a row count as though it had just taken one.
  const backup = backupName();
  await query(`CREATE TABLE ${backup} AS SELECT * FROM public.tradingview_history`);
  const { rows: [b] } = await query(`SELECT count(*) AS n FROM ${backup}`);
  log(`  backup: ${backup} (${b.n} rows)`);

  // ── shift, gated ─────────────────────────────────────────────────────────
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('ALTER TABLE public.tradingview_history DROP CONSTRAINT tradingview_history_pkey');
    const upd = await client.query(
      `UPDATE public.tradingview_history
          SET trade_date = trade_date + 1, updated_at = now()
        WHERE trade_date <= $1::date AND trade_date >= $2::date`, [CUTOVER, FROM]);
    await client.query('ALTER TABLE public.tradingview_history ADD CONSTRAINT tradingview_history_pkey PRIMARY KEY (symbol, trade_date)');
    const { rows: [post] } = await client.query(
      `SELECT count(*) AS weekend_rows FROM public.tradingview_history WHERE EXTRACT(dow FROM trade_date) IN (5,6)`);
    if (Number(post.weekend_rows) !== 0) {
      throw new Error(`GATE FAILED: ${post.weekend_rows} weekend rows remain after the shift — rolling back.`);
    }
    await client.query('COMMIT');
    log(`  shifted ${upd.rowCount} rows in [${FROM} … ${CUTOVER}]; weekend rows after: 0. COMMITTED.`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    log(`  ROLLED BACK: ${e.message}`);
    throw e;
  } finally {
    client.release();
  }

  log(`\nDone. Backup retained as ${backup} — keep it until the board is confirmed for a session.`);
}

module.exports = { validateWindow, backupName, isoDay };

if (require.main === module) {
  main().then(() => close()).catch((e) => { process.stderr.write(`\n${e.message}\n`); close().finally(() => process.exit(1)); });
}

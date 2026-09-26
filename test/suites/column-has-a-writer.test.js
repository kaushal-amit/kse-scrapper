'use strict';
/**
 * ============================================================================
 *  EVERY COLUMN A MIGRATION DECLARES MUST HAVE SOMETHING THAT WRITES IT
 * ============================================================================
 * A column with no writer is not an empty column. It is a column that LOOKS
 * like a measurement, passes every `IS NOT NULL` test nobody wrote, and is read
 * by a study as though it meant something. This repository has shipped five of
 * them, found one at a time and always by accident:
 *
 *   symbol_day.data_quality = 'PARTIAL'   3,496 rows from a rule in no commit
 *   market_day.thin_symbols               counted only THIN, so 3,365
 *                                         PARTIAL symbol-days were invisible
 *   market_day.cb_events / auction_volume declared, never written
 *   symbol_day.resumed                    declared, never written
 *   market_day.no_prev_close              COMPUTED and then deleted before the
 *                                         INSERT, because there was no column
 *
 * The last one is the clearest: breadth() worked out the number, and
 * computeMarketDay ran `delete row.no_prev_close` on the way to the database.
 * A refusal deleted before the write is not a refusal.
 *
 * This suite closes the class rather than the instances. It reads the columns
 * each table actually has, subtracts the columns each job's COLUMNS array
 * writes, and fails on the difference — so the NEXT table (bars_1m, halts,
 * rule_regimes, nms, pattern_registry) cannot be declared with a column nobody
 * fills. It is deliberately placed BEFORE those tables are built.
 *
 * ─── WHAT AN EXEMPTION MEANS ───────────────────────────────────────────────
 * A column genuinely written by something else — a trigger, a DEFAULT, a
 * backfill script, another service — is listed in EXEMPT with the reason. That
 * list is the point of the suite as much as the check is: it is the written-down
 * answer to "who writes this?", and it has to be renewed by hand whenever it
 * changes, which is exactly the friction that was missing.
 * ============================================================================
 */
const path = require('path');
const db = require('../../src/db/pool');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };

/** table -> the job module whose COLUMNS array is its writer. */
const WRITERS = [
  { table: 'symbol_day', mod: '../../src/jobs/computeSymbolDay' },
  { table: 'market_day', mod: '../../src/jobs/computeMarketDay' },
];

/**
 * Columns written by something other than a job's COLUMNS array. Every entry
 * needs a reason, and the reason has to name the writer.
 */
const EXEMPT = {
  // Empty, and that is a result. The first version of this list guessed at
  // id / computed_at / quality_rule_version / broker_seen_at / cb_events_total
  // and the suite rejected every one of them: all are written by a COLUMNS
  // array already, and `id` is not even a column — both tables are keyed on
  // (symbol, trading_date) and trading_date. An exemption list nobody checks
  // is a second place for a wrong answer about who writes a column, which is
  // the defect this suite exists to catch. So the stale-exemption check below
  // is not decoration: it caught its author on the first run.
  symbol_day: {},
  market_day: {},
};

/**
 * ─── ELEVEN COLUMNS WITH NO WRITER, AND THEY ARE NOT ORPHANS (053) ────────
 *
 * symbol_day declared 56 columns computeSymbolDay never writes. 45 of them
 * are gone: nothing wrote them and nothing read them, and a column with no
 * writer still looks like a measurement, still passes every IS NOT NULL test
 * nobody wrote, and is still read by a study as though it meant something.
 *
 * ELEVEN STAY, because spread.symbol_day — the board's view — selects them:
 *
 *   directly          markup, resumed, lift, hit, block_ratio
 *   as COALESCE(p.x, s.x) over spread.symbol_day_stats
 *                     pct_postable, pct_exitable, exitable_best_hour,
 *                     bid_p25, bid_p50, vol_ratio_5d
 *
 * The six COALESCE ones were first classified here as "dead, already replaced
 * by spread.symbol_day_stats". That was wrong, and the way it was wrong is
 * worth keeping: they are not replaced, they are the PREFERRED source with
 * the backend's recompute as the FALLBACK. They read NULL today precisely so
 * the fallback fires. A column that is NULL on purpose so something else is
 * used is the opposite of an orphan — and filling it here would silently take
 * over from the thing currently answering.
 *
 * HOW THE FIRST CLASSIFICATION MISSED THEM: the scan that produced "nothing
 * reads these" EXCLUDED MIGRATION FILES, on the reasoning that a migration
 * declaring a column is not a reader. True of a declaration. False of a VIEW,
 * and views live in migrations. Any future version of this check must read
 * migrations too.
 *
 * These eleven pass. Any NEW orphan is a hard failure — which is the point,
 * since this sits before bars_1m's successor, halts, rule_regimes, nms and
 * pattern_registry.
 */
const READ_BY_THE_BOARDS_VIEW = [
  // spread.symbol_day selects these directly
  'markup', 'resumed', 'lift', 'hit', 'block_ratio',
  // ...and these as the first branch of a COALESCE over symbol_day_stats
  'pct_postable', 'pct_exitable', 'exitable_best_hour',
  'bid_p25', 'bid_p50', 'vol_ratio_5d',
];

const PENDING_DECISION = {
  symbol_day: new Set(READ_BY_THE_BOARDS_VIEW),
  market_day: new Set(),
};

(async () => {
  try {
    for (const w of WRITERS) {
      console.log(`\n=== ${w.table} ===`);
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const job = require(path.join(__dirname, w.mod));
      const written = new Set(job.COLUMNS || []);
      ck(`${w.table}: the job exports a COLUMNS array (the check can fail)`,
        written.size > 0, written.size);

      const { rows } = await db.query(
        `SELECT column_name, column_default IS NOT NULL AS has_default, is_generated
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1
          ORDER BY ordinal_position;`, [w.table]);
      ck(`${w.table}: the table exists and has columns`, rows.length > 0, rows.length);

      const exempt = EXEMPT[w.table] || {};
      const pending = PENDING_DECISION[w.table] || new Set();
      const allOrphans = rows
        .map((r) => r.column_name)
        .filter((c) => !written.has(c) && !(c in exempt));
      const orphans = allOrphans.filter((c) => !pending.has(c));
      const stillPending = allOrphans.filter((c) => pending.has(c));

      if (stillPending.length) {
        console.log(`  NOTE  ${w.table}: ${stillPending.length} column(s) have no writer here and `
          + 'are selected by spread.symbol_day — five directly, six as the first branch of a '
          + 'COALESCE over spread.symbol_day_stats. NULL on purpose so the fallback fires; '
          + 'filling one would take over from the thing currently answering.');
      }
      ck(`${w.table}: no NEW column without a writer`, orphans.length === 0, orphans);

      // The pending list may only shrink. A name that is no longer an orphan —
      // filled, or dropped — must leave the list, or the count stops meaning
      // anything and the decision looks permanently outstanding.
      const resolved = [...pending].filter((c) => !allOrphans.includes(c));
      ck(`${w.table}: the pending list carries no column that is already resolved`,
        resolved.length === 0, resolved);

      // The exemption list must not rot: an exemption for a column that no
      // longer exists, or that the job now writes, is a stale answer to
      // "who writes this?" and reads as authoritative.
      const present = new Set(rows.map((r) => r.column_name));
      const staleExempt = Object.keys(exempt)
        .filter((c) => !present.has(c) || written.has(c));
      ck(`${w.table}: no stale exemptions`, staleExempt.length === 0, staleExempt);

      // And COLUMNS must not name a column the table does not have — the
      // mirror-image failure, which fails loudly at INSERT but only when the
      // job next runs, which for a nightly job is after the market shuts.
      const phantom = [...written].filter((c) => !present.has(c));
      ck(`${w.table}: COLUMNS names no column the table lacks`, phantom.length === 0, phantom);
    }

    console.log(`\ncolumn has a writer: ${p}/${n}`);
    await db.close();
    process.exit(p === n ? 0 : 1);
  } catch (e) {
    console.error('column-has-a-writer ERROR', e);
    await db.close().catch(() => {});
    process.exit(1);
  }
})();

'use strict';
/**
 * scripts/migrate-quotes.js — TMI Engine 01, step 2.
 *
 *   node scripts/migrate-quotes.js --from=postgresql://user:pass@host/olddb
 *   node scripts/migrate-quotes.js --from=... --apply
 *
 * NOTE: scripts/migrate-all.js supersedes this. It moves the quotes AND depth,
 * orders and daily history, works out which of the two quote tables is which
 * feed, and shares one column list with the rest. Two scripts writing the same
 * table from separate column lists is how the intrinsic_value mismatch
 * survived being fixed everywhere else:
 *
 *   node scripts/migrate-all.js --from=... --only=quotes --apply
 *
 * DRY RUN BY DEFAULT. Nothing is written without --apply. A migration that
 * runs the moment it is invoked gives no chance to read what it is about to do.
 *
 * ─── THE PROBLEM THIS EXISTS FOR ───────────────────────────────────────────
 * The source table has 6,265 duplicate keys, 571 of them with CONFLICTING
 * data. Those two numbers need different handling, and the distinction is the
 * whole job:
 *
 *   ~5,694 identical duplicates   collapse silently — nothing is lost
 *      571 CONFLICTING duplicates a CHOICE is being made about real data
 *
 * Reporting "6,265 duplicates removed" hides 571 decisions inside one number.
 * So conflicts are counted separately, written to a file, and the row kept is
 * chosen by a stated rule rather than by whichever arrived first.
 *
 * ─── WHY THE DUPLICATES EXIST ──────────────────────────────────────────────
 * The old scraper stamped rows with a ROUNDED time instead of the actual
 * capture moment, so two captures within the same minute collided on
 * (market, symbol, created_at). That is why conflicting rows are near-
 * simultaneous observations of a moving book rather than corruption — and why
 * the LAST one is the better row: it is the later look at the same minute.
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { query } = require('../src/db/pool');
const log = require('../src/logger');

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : null;
};

const FROM = arg('from') || process.env.MIGRATE_FROM;
const APPLY = process.argv.includes('--apply');
const TABLE = arg('table') || 'stock_quotes';
const BATCH = Number(arg('batch') || 5000);

/**
 * The unique column that makes pagination stable. Defaults to the primary key;
 * override if the source table names it differently.
 */
const ORDER_KEY = arg('orderKey') || 'id';
const OUT_DIR = path.resolve(__dirname, '..', 'tmp');

/** Columns that make a row's DATA, ignoring the key and bookkeeping. */
const DATA_FIELDS = [
  'last_price', 'last_qty', 'chg', 'pct_chg', 'volume', 'bid', 'bid_qty',
  'offer', 'offer_qty', 'trades', 'open_price', 'high_price', 'low_price',
  'intrinsic_value', 'session', 'nms', 'code', 'description',
];

const fingerprint = (r) => DATA_FIELDS
  .map((f) => (r[f] === null || r[f] === undefined ? '' : String(r[f]))).join('\u0001');

/** How complete a row is — the tiebreak when two rows disagree. */
const richness = (r) => DATA_FIELDS
  .filter((f) => r[f] !== null && r[f] !== undefined && r[f] !== '').length;

/**
 * Reduce rows sharing one key to a single row.
 *
 * ─── RICHEST, THEN HIGHEST VOLUME, THEN LAST ID ────────────────────────────
 * Richness first: a row with a price and no volume is a partial capture, not a
 * later truth.
 *
 * But richness does not discriminate on the real conflicts. Both of these are
 * complete:
 *
 *   AAYAN 27 Jul 10:06:21
 *     A   last 288   bid 287 x 175,000   trades 19   volume 264,251
 *     B   last 287   bid 286 x 402,100   trades 22   volume 439,251
 *
 * Equally rich, so the old rule fell through to "last by id" — which is
 * arbitrary, because the duplicates exist precisely BECAUSE their timestamps
 * were rounded together.
 *
 * Session volume is cumulative and monotonic, so 439,251 is provably the later
 * observation. That makes the choice evidential rather than a coin toss, and it
 * is checkable afterwards: the kept row always has the higher volume.
 *
 * Id remains the final tiebreak for rows where volume is equal or absent.
 */
function resolve(rows) {
  const rank = (r) => [
    richness(r),
    r.volume === null || r.volume === undefined ? -1 : Number(r.volume),
    Number(r.id ?? 0),
  ];

  let best = rows[0];
  for (let i = 1; i < rows.length; i += 1) {
    const a = rank(rows[i]);
    const b = rank(best);
    // Compare in order; the first difference decides.
    if (a[0] > b[0]
      || (a[0] === b[0] && a[1] > b[1])
      || (a[0] === b[0] && a[1] === b[1] && a[2] > b[2])) {
      best = rows[i];
    }
  }
  return best;
}

function classify(rows) {
  const prints = new Set(rows.map(fingerprint));
  return prints.size === 1 ? 'identical' : 'conflicting';
}

async function main() {
  if (!FROM) {
    console.error('\n  No source database given.\n');
    console.error('  Through npm, the separator is required:\n');
    console.error('      npm run migrate:quotes -- --from=postgresql://user:pass@host:5432/db');
    console.error('                             ^^ npm drops anything before this\n');
    console.error('  Or by environment:\n');
    console.error('      MIGRATE_FROM=postgresql://... npm run migrate:quotes\n');
    process.exit(1);
  }

  const source = new Pool({ connectionString: FROM });

  console.log(`\n  QUOTE MIGRATION  (step 2)`);
  console.log(`  mode        ${APPLY ? 'APPLY — rows will be written' : 'DRY RUN — nothing will be written'}`);
  console.log(`  source      ${FROM.replace(/:[^:@/]*@/, ':***@')}  table ${TABLE}`);
  console.log(`  ${'─'.repeat(72)}`);

  // ── VERIFY THE TARGET BEFORE READING A SINGLE SOURCE ROW ──────────────
  //
  // A column mismatch used to surface only at the first INSERT — after nearly
  // a million rows had been read and held in memory. The check costs one query
  // against a system table and turns a ten-minute failure into an instant one.
  const TARGET_COLS = ['market', 'symbol', 'code', 'description', 'last_price',
    'last_qty', 'chg', 'pct_chg', 'volume', 'bid', 'bid_qty', 'offer', 'offer_qty',
    'trades', 'last_trade_date', 'last_trade_time', 'open_price', 'high_price',
    'low_price', 'session', 'nms', 'trading_date', 'ingest_source',
    'source_precedence', 'created_at'];

  const { rows: liveCols } = await query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'awsat_market_quotes'`);
  const live = new Set(liveCols.map((c) => c.column_name));

  if (!live.size) {
    throw new Error('awsat_market_quotes does not exist in the target database. '
      + 'Run `npm run migrate` first.');
  }
  const missing = TARGET_COLS.filter((c) => !live.has(c));
  if (missing.length) {
    throw new Error(`the target is missing ${missing.length} column(s): `
      + `${missing.join(', ')}.\n  The target schema and this script disagree — `
      + 'run `npm run migrate` to bring the database up to date, or the script '
      + 'is stale.');
  }

  const { rows: countRows } = await source.query(`SELECT count(*)::int AS c FROM ${TABLE}`);
  const total = countRows[0].c;
  console.log(`  source rows ${total.toLocaleString()}`);

  let offset = 0;
  const byKey = new Map();
  const stats = { read: 0, keys: 0, identical: 0, conflicting: 0, unusable: 0 };

  // Read everything before writing anything. The conflict report has to be
  // complete before a decision is acted on — a streaming migration that fixes
  // as it goes cannot tell you what it is about to do.
  for (;;) {
    const { rows } = await source.query(
      // ORDER BY must end in a UNIQUE column. Duplicates share created_at and
      // symbol by definition, so sorting on those alone leaves their relative
      // order undefined — and OFFSET pagination over an unstable sort can skip
      // a row or return it twice. In a migration whose purpose is losing
      // nothing, that is the worst available bug.
      //
      // The primary key also makes "the last row" meaningful: highest id is
      // the row written last, which for a rounded-timestamp collision is the
      // later look at the same minute.
      `SELECT * FROM ${TABLE} ORDER BY created_at, symbol, ${ORDER_KEY} LIMIT $1 OFFSET $2`,
      [BATCH, offset],
    );
    if (!rows.length) break;
    offset += rows.length;
    stats.read += rows.length;

    for (const r of rows) {
      const market = r.market || (r.source === 'awsat' ? 'UNKNOWN' : r.source);
      const at = r.created_at || r.minute_bucket || r.captured_at;
      if (!r.symbol || !at || !market) { stats.unusable += 1; continue; }
      const key = `${market}\u0001${r.symbol}\u0001${new Date(at).toISOString()}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push({ ...r, __market: market, __at: at });
    }
    process.stdout.write(`\r  read ${stats.read.toLocaleString()} / ${total.toLocaleString()}`);
  }
  process.stdout.write('\n');

  const conflicts = [];
  const keep = [];
  for (const [key, rows] of byKey) {
    stats.keys += 1;
    if (rows.length === 1) { keep.push(rows[0]); continue; }

    const kind = classify(rows);
    if (kind === 'identical') stats.identical += rows.length - 1;
    else {
      stats.conflicting += rows.length - 1;
      conflicts.push({
        key,
        rows: rows.map((r) => Object.fromEntries(
          DATA_FIELDS.filter((f) => r[f] !== null && r[f] !== undefined).map((f) => [f, r[f]]),
        )),
      });
    }
    keep.push(resolve(rows));
  }

  console.log(`\n  distinct keys        ${stats.keys.toLocaleString()}`);
  console.log(`  identical duplicates ${stats.identical.toLocaleString()}   collapsed, nothing lost`);
  console.log(`  CONFLICTING          ${stats.conflicting.toLocaleString()}   a choice was made — see the report`);
  console.log(`  unusable rows        ${stats.unusable.toLocaleString()}   no symbol, market or timestamp`);
  console.log(`  rows to insert       ${keep.length.toLocaleString()}`);

  if (conflicts.length) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const file = path.join(OUT_DIR, `quote-conflicts-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(conflicts, null, 2));
    console.log(`\n  conflict report      ${file}`);
    console.log('  Rule applied: richest row wins, then HIGHEST VOLUME, then last id.');
    console.log('  Volume is cumulative within a session, so the higher figure is');
    console.log('  provably the later observation — evidential, not arbitrary.');
    console.log('  Read it before --apply. These are the only rows where the');
    console.log('  migration chose between two real observations.');
  }

  if (!APPLY) {
    console.log(`\n  ${'─'.repeat(72)}`);
    console.log('  DRY RUN — nothing written. Re-run with --apply to migrate.\n');
    await source.end();
    return;
  }

  // intrinsic_value is NOT here: migration 014 dropped it (100% NULL across
  // 838,762 rows). It was left in this list after being removed everywhere
  // else, and the mismatch only surfaced AFTER a million rows had been read.
  const COLS = ['market', 'symbol', 'code', 'description', 'last_price', 'last_qty',
    'chg', 'pct_chg', 'volume', 'bid', 'bid_qty', 'offer', 'offer_qty', 'trades',
    'last_trade_date', 'last_trade_time', 'open_price',
    'high_price', 'low_price', 'session', 'nms', 'trading_date', 'ingest_source',
    'source_precedence', 'created_at'];

  let inserted = 0;
  for (let i = 0; i < keep.length; i += 500) {
    const chunk = keep.slice(i, i + 500);
    const values = [];
    const tuples = chunk.map((r, n) => {
      const at = new Date(r.__at);
      const row = [
        r.__market, r.symbol, r.code ?? null, r.description ?? null,
        r.last_price ?? null, r.last_qty ?? null, r.chg ?? null, r.pct_chg ?? null,
        r.volume ?? null, r.bid ?? null, r.bid_qty ?? null, r.offer ?? null,
        r.offer_qty ?? null, r.trades ?? null, r.last_trade_date ?? null,
        // The target column is `time`; raw cell text is not castable.
        require('../src/scrapers/parse').toTime(r.last_trade_time), r.open_price ?? null,
        r.high_price ?? null, r.low_price ?? null, r.session ?? null, r.nms ?? null,
        r.trading_date ?? at.toISOString().slice(0, 10),
        'awsat_server', 1, at,
      ];
      values.push(...row);
      return `(${row.map((_, c) => `$${n * COLS.length + c + 1}`).join(', ')})`;
    });

    // ON CONFLICT DO NOTHING: the target may already hold rows from a partial
    // run, and re-running must be safe.
    const res = await query(
      `INSERT INTO awsat_market_quotes (${COLS.join(', ')}) VALUES ${tuples.join(', ')}
       ON CONFLICT (market, symbol, created_at, ingest_source) DO NOTHING`,
      values,
    );
    inserted += res.rowCount;
    process.stdout.write(`\r  inserted ${inserted.toLocaleString()}`);
  }

  process.stdout.write('\n');
  console.log(`\n  ${'─'.repeat(72)}`);
  console.log(`  ${inserted.toLocaleString()} rows written to awsat_market_quotes\n`);
  console.log('  Next: backfill symbol_day, then verify S1-S10 and M1-M6.\n');
  await source.end();
}

main().catch((err) => {
  log.error('quote migration failed', { err: err.message });
  console.error(`\n  failed: ${err.message}\n`);
  process.exit(1);
});

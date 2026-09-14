'use strict';
/**
 * scripts/migrate-all.js — move every table from the live RDS into the new schema.
 *
 *   node scripts/migrate-all.js --from=<url>                 dry run
 *   node scripts/migrate-all.js --from=<url> --apply
 *   node scripts/migrate-all.js --from=<url> --only=depth,orders
 *   node scripts/migrate-all.js --from=<url> --since=2026-08-01
 *
 * DRY RUN BY DEFAULT.
 *
 * ─── WHAT MOVES WHERE ──────────────────────────────────────────────────────
 *   market_stock_snapshots -> tradingview_watchlist
 *   stock_quotes           -> awsat_market_quotes
 *   stock_depth            -> awsat_stock_depth
 *   order_list_snapshots   -> awsat_order_list      (net_value recovered from raw)
 *   stock_daily            -> tradingview_history
 *
 * The two quote tables are the two FEEDS, not duplicates of one another — one
 * is the TradingView watchlist, the other the broker board. They back each
 * other up, so both are kept and neither overwrites the other.
 *
 * ─── THE ASSIGNMENT IS DETECTED, NOT ASSUMED ───────────────────────────────
 * Putting broker rows in the TradingView table would look completely normal
 * afterwards: same symbols, same prices, same shape. Nothing downstream would
 * complain, and the coverage check would compare a feed against itself. So the
 * source of each table is established from its own contents and the migration
 * REFUSES to run when the evidence is ambiguous.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const { Pool: TargetPool } = require('pg');
let targetPool = null;
/** All writes go here, not to the ambient DATABASE_URL. */
const query = (text, params) => targetPool.query(text, params);
const parse = require('../src/scrapers/parse');
const log = require('../src/logger');
const repair = require('../src/migration/repair');

const arg = (n) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : null;
};

const FROM = arg('from') || process.env.MIGRATE_FROM;

/**
 * The TARGET, explicitly.
 *
 * Until now the target came only from DATABASE_URL in .env, which meant two
 * runs of an identical command could write to different databases and nothing
 * in the shell history distinguished them. The depth run landed in kse and the
 * orders run did not — same command, invisible difference.
 *
 * A migration whose destination is not in the command is one you cannot audit
 * afterwards.
 */
const TO = arg('to') || process.env.MIGRATE_TO || process.env.DATABASE_URL;
const APPLY = process.argv.includes('--apply');
const SINCE = arg('since');
const ONLY = (arg('only') || '').split(',').map((s) => s.trim()).filter(Boolean);
const PAGE = Number(arg('batch') || 5000);
const OUT = path.resolve(__dirname, '..', 'tmp');

const fmt = (n) => Number(n).toLocaleString();

/**
 * Which feed a quote table holds, from its own contents.
 *
 * The broker board carries a market — Premier/Main — because that is how the
 * terminal is organised. The TradingView watchlist has no such concept. That
 * one difference is decisive and cheap to check.
 */
async function classifyQuoteTable(src, table) {
  const { rows: cols } = await src.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1`, [table]);
  const names = new Set(cols.map((c) => c.column_name));

  if (!names.has('market')) {
    return { feed: 'tradingview', why: 'no market column' };
  }

  const { rows } = await src.query(
    `SELECT DISTINCT market FROM "${table}" WHERE market IS NOT NULL LIMIT 20`);
  const markets = rows.map((r) => String(r.market));

  if (!markets.length) return { feed: 'tradingview', why: 'market column is empty' };

  const broker = markets.filter((m) => /premier|main|auction/i.test(m));
  if (broker.length) {
    return { feed: 'awsat', why: `broker markets present: ${broker.slice(0, 3).join(', ')}` };
  }
  if (markets.every((m) => /tradingview|tv|kse/i.test(m))) {
    return { feed: 'tradingview', why: `market values: ${markets.slice(0, 3).join(', ')}` };
  }
  return { feed: null, why: `cannot tell from market values: ${markets.slice(0, 5).join(', ')}` };
}

/**
 * Which source columns does this mapping actually read?
 *
 * ─── WHY THIS EXISTS ───────────────────────────────────────────────────────
 * awsat_stock_depth migrated with bid_qty populated and bid NULL on all 81,108
 * rows — quantities without prices, which makes every wall, level and range
 * analysis impossible. The cause was a mapping that read `r.bid` where the
 * source calls it something else. The quantities matched, so nothing looked
 * wrong until someone queried the prices.
 *
 * Guessing column names has now cost six separate failures. So the migration
 * reports every source column it did NOT read, and every target column it left
 * entirely NULL. A missed mapping becomes visible in the dry run instead of a
 * week later.
 */
async function columnCoverage(src, table, sampleRow, mapRow) {
  const { rows: cols } = await src.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1`, [table]);
  const sourceCols = cols.map((c) => c.column_name);

  // WHICH PROPERTIES DID mapRow ACTUALLY TOUCH?
  //
  // Comparing values does not work: the source holds "866KWF" and the target
  // holds 866, so every column that needs parsing looks unread. A Proxy
  // records the reads themselves, which is exact.
  const touched = new Set();
  const spy = new Proxy({ ...sampleRow }, {
    get(target, prop) {
      if (typeof prop === 'string') touched.add(prop);
      return target[prop];
    },
    has(target, prop) {
      if (typeof prop === 'string') touched.add(prop);
      return prop in target;
    },
  });

  let mapped = null;
  try { mapped = mapRow(spy); } catch { /* a mapping that throws is its own signal */ }

  // Bookkeeping we deliberately do not carry across.
  const IGNORE = new Set(['id', 'run_id', 'scrape_batch_id', 'updated_at', 'stock_url']);

  const unread = sourceCols
    .filter((c) => !IGNORE.has(c) && !touched.has(c))
    // A column that is empty in the sample has nothing to lose either way.
    .filter((c) => sampleRow[c] !== null && sampleRow[c] !== undefined && sampleRow[c] !== '')
    .map((c) => ({ column: c, sample: String(sampleRow[c]).slice(0, 22) }));

  const allNull = mapped
    ? Object.entries(mapped).filter(([, v]) => v === null || v === undefined).map(([k]) => k)
    : [];

  return { sourceCols: sourceCols.length, unread, allNull };
}

/** Copy in pages, ordered by a UNIQUE column so paging cannot skip or repeat. */
async function copyTable({
  src, table, orderKey, targetTable, targetCols, mapRow, conflict, since, sinceCol,
  dedupeOn,
}) {
  /**
   * REFUSE TO PAGE OVER A NON-UNIQUE SORT.
   *
   * OFFSET paging assumes a stable order. When the sort columns contain ties,
   * Postgres may order page 2 differently from page 1, so a row appears on both
   * or on neither. Measured on a 3,000-row table sorted by a non-unique column:
   * 2,577 seen, 423 SILENTLY LOST.
   *
   * Nothing downstream can detect it — the rows simply are not there. So this
   * is checked before a single row is read, and refuses rather than warns.
   */
  const orderCols = orderKey.split(',').map((k) => k.trim());
  const { rows: dupCheck } = await src.query(
    `SELECT count(*)::int AS n FROM (
       SELECT 1 FROM "${table}" GROUP BY ${orderCols.map((c) => `"${c}"`).join(', ')}
        HAVING count(*) > 1 LIMIT 1) g`);
  if (dupCheck[0].n > 0) {
    throw new Error(
      `${table}: ORDER BY (${orderKey}) is NOT unique, so OFFSET paging would `
      + 'silently skip and repeat rows. Add a unique column to orderKey.');
  }

  const where = [];
  const params = [];
  if (since && sinceCol) { params.push(since); where.push(`"${sinceCol}" >= $${params.length}`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const { rows: [{ n }] } = await src.query(
    `SELECT count(*)::bigint AS n FROM "${table}" ${whereSql}`, params);
  const total = Number(n);
  if (!total) return { total: 0, mapped: 0, inserted: 0, skipped: 0 };

  let offset = 0;
  let mapped = 0;
  let inserted = 0;
  let skipped = 0;
  let collapsed = 0;
  let coverage = null;
  let failed = 0;
  const failures = [];

  for (;;) {
    const { rows } = await src.query(
      `SELECT * FROM "${table}" ${whereSql}
        ORDER BY ${orderKey.split(',').map((k) => `"${k.trim()}"`).join(', ')}
        LIMIT ${PAGE} OFFSET ${offset}`, params);
    if (!rows.length) break;
    offset += rows.length;

    const batch = [];
    for (const r of rows) {
      const m = mapRow(r);
      if (m) batch.push(m); else skipped += 1;
    }
    mapped += batch.length;

    // Once, on the first page: what did this mapping ignore?
    if (!coverage && rows.length) {
      coverage = await columnCoverage(src, table, rows[0], mapRow);
    }

    // ── ONE ROW PER KEY, PER STATEMENT ──────────────────────────────────
    //
    // A snapshot source holds the same order many times over. INSERT ...
    // ON CONFLICT DO UPDATE cannot affect one key twice in a single command,
    // so a chunk holding two sightings of an order fails entirely.
    //
    // The LAST occurrence is kept. Rows are read in ascending id order, so the
    // last sighting is the most recent one — and for an order that means the
    // most advanced fill state, which is the row worth keeping.
    let ready = batch;
    if (dedupeOn && APPLY) {
      const byKey = new Map();
      for (const row of batch) {
        const k = row[dedupeOn];
        if (k === null || k === undefined) continue;
        byKey.set(k, row);          // later wins
      }
      collapsed += batch.length - byKey.size;
      ready = [...byKey.values()];
    }

    if (APPLY && ready.length) {
      for (let i = 0; i < ready.length; i += 500) {
        const chunk = ready.slice(i, i + 500);
        const values = [];
        const tuples = chunk.map((row, k) => {
          const ph = targetCols.map((c, j) => {
            values.push(row[c] === undefined ? null : row[c]);
            return `$${k * targetCols.length + j + 1}`;
          });
          return `(${ph.join(', ')})`;
        });
        try {
          const res = await query(
            `INSERT INTO ${targetTable} (${targetCols.join(', ')})
             VALUES ${tuples.join(', ')} ${conflict}`, values);
          inserted += res.rowCount;
        } catch (err) {
          // A whole chunk failing on ONE bad row loses 499 good ones, so the
          // chunk is retried row by row. The failures are then countable and
          // named instead of taking the table down.
          //
          // There is no transaction to roll back to: each INSERT autocommits,
          // so by the time an error arrives, earlier chunks are already
          // durable. Continuing and REPORTING is the only honest option —
          // stopping would leave a partial table with no record of where.
          for (const row of chunk) {
            try {
              const one = await query(
                `INSERT INTO ${targetTable} (${targetCols.join(', ')})
                 VALUES (${targetCols.map((_, j) => `$${j + 1}`).join(', ')}) ${conflict}`,
                targetCols.map((c) => (row[c] === undefined ? null : row[c])));
              inserted += one.rowCount;
            } catch (rowErr) {
              failed += 1;
              if (failures.length < 10) {
                failures.push({ reason: rowErr.message.slice(0, 90), row: JSON.stringify(row).slice(0, 160) });
              }
            }
          }
        }
      }
    }
    process.stdout.write(`\r    ${table}: ${fmt(offset)} read`
      + (total ? ` of ~${fmt(total)}` : '')
      + (APPLY ? `, ${fmt(inserted)} written` : ''));
  }
  process.stdout.write('\n');
  // `total` was counted once, before paging. The source is LIVE, so more rows
  // can arrive while the read is running and `read` legitimately exceeds it.
  // Reporting the actual figure, and flagging when it grew, is honest where a
  // stale total is not.
  return { total, read: offset, mapped, inserted, skipped, collapsed, coverage, failed, failures };
}

/**
 * Any numeric cell, safely.
 *
 * Number() returns NaN on everything this data actually contains —
 * "1,240,000", "1.24M", "176KWF", an em dash, a bidi-wrapped negative — and
 * Postgres rejects NaN outright, so ONE formatted volume anywhere in 1.9M rows
 * stops the whole run.
 *
 * parse.toNumber already handles all of it; the migrator simply was not using
 * it. Anything genuinely unreadable becomes NULL, which is true and storable.
 */
const KEEP_MARKETS = (process.env.AWSAT_KEEP_MARKETS || 'Premier Market,Main Market')
  .split(',').map((m) => m.trim()).filter(Boolean);

const num = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = parse.toNumber(v);
  return n === null || !Number.isFinite(n) ? null : n;
};

/**
 * The same, rounded, for bigint columns.
 *
 * A volume of "23.34 K" expands to 23,340 exactly, but "1.005M" does not — and
 * Postgres rejects a fraction for bigint. Rounding here keeps the row; letting
 * it through would fail the batch on a value that is meaningfully correct.
 */
const bigint = (v) => {
  const n = num(v);
  return n === null ? null : Math.round(n);
};
const day = (v) => (v ? new Date(v).toISOString().slice(0, 10) : null);

/**
 * Build a timestamptz from whatever the source holds.
 *
 * order_time in the old table is a CLOCK TIME — "09:16:02" — while the target
 * column is timestamptz. Postgres rejects the bare time, and the whole
 * migration stops on it.
 *
 * A time on its own is only meaningful with a date, and the row already knows
 * its trading day, so the two are combined. Kuwait is UTC+3 and the stored
 * clock is local, so the offset is explicit rather than left to the server's
 * timezone — which would silently shift every order by three hours.
 *
 * Anything unrecognisable becomes NULL: "we do not know when" is true and
 * storable, and an invented timestamp on an order is worse than none.
 */
function toTimestamp(value, dateHint) {
  if (value === null || value === undefined || value === '') return null;

  // Already a Date, or a full timestamp string.
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const raw = String(value).trim();
  if (!raw) return null;

  if (/\d{4}-\d{2}-\d{2}/.test(raw) || /\d{1,2}-\d{1,2}-\d{4}/.test(raw)) {
    // Normalise DD-MM-YYYY to ISO, then apply the Kuwait offset UNLESS the
    // string already carries one.
    //
    // Without this a datetime stored as "2026-08-25 09:16:02" is read as UTC
    // while a bare "09:16:02" is read as Kuwait — the same wall-clock moment
    // landing three hours apart depending only on how the source happened to
    // write it. The broker does not change timezone by column.
    const iso = raw.replace(/^(\d{1,2})-(\d{1,2})-(\d{4})/, '$3-$2-$1').replace(' ', 'T');
    const hasOffset = /[+-]\d{2}:?\d{2}$|Z$/.test(iso);
    const d = new Date(hasOffset ? iso : `${iso}+03:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // A clock time. Needs the day it belongs to.
  const t = parse.toTime(raw);
  if (!t || !dateHint) return null;
  const d = new Date(`${day(dateHint)}T${t}+03:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function main() {
  if (!FROM) {
    console.error('\n  No source database given.\n');
    console.error('      node scripts/migrate-all.js --from=postgresql://user:pass@host:5432/db\n');
    console.error('  Through npm the separator is required:\n');
    console.error('      npm run migrate:all -- --from=...\n');
    process.exit(1);
  }

  if (!TO) {
    console.error('\n  No target database. Set DATABASE_URL in .env or pass --to=<url>.\n');
    process.exit(1);
  }

  const src = new Pool({ connectionString: FROM, statement_timeout: 300_000 });
  targetPool = new TargetPool({ connectionString: TO, statement_timeout: 300_000 });

  const mask = (u) => String(u).replace(/:[^:@/]*@/, ':***@');
  const { rows: tgtWho } = await targetPool.query(
    'SELECT current_database() AS db, inet_server_addr()::text AS host');

  console.log(`\n  MIGRATION  ${APPLY ? '(APPLY)' : '(DRY RUN — nothing will be written)'}`);
  console.log(`  FROM  ${mask(FROM)}`);
  console.log(`  TO    ${mask(TO)}`);
  console.log(`        -> database "${tgtWho[0].db}" @ ${tgtWho[0].host}`);

  // Writing a database into itself would read and rewrite the same rows.
  if (APPLY && mask(FROM) === mask(TO)) {
    console.error('\n  REFUSING: source and target are the same database.\n');
    await src.end(); await targetPool.end();
    process.exit(1);
  }
  if (SINCE) console.log(`  since       ${SINCE}`);
  console.log(`  ${'─'.repeat(72)}`);

  // ── VERIFY EVERY TARGET BEFORE READING ANYTHING ───────────────────────
  //
  // One query against a system table, and a schema mismatch fails in a second
  // rather than after a million rows have been read.
  const TARGETS = {
    tradingview_watchlist: ['symbol', 'last_price', 'trading_date', 'created_at'],
    awsat_market_quotes: ['market', 'symbol', 'last_trade_time', 'ingest_source', 'created_at'],
    awsat_stock_depth: ['symbol', 'level', 'ingest_source', 'created_at'],
    awsat_order_list: ['order_id', 'net_value', 'raw', 'executions_observed'],
    tradingview_history: ['symbol', 'trade_date', 'close_price'],
  };
  for (const [t, cols] of Object.entries(TARGETS)) {
    const { rows } = await query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name=$1`, [t]);
    if (!rows.length) {
      console.error(`\n  target table ${t} does not exist. Run \`npm run migrate\` first.\n`);
      await src.end();
      process.exit(1);
    }
    const have = new Set(rows.map((r) => r.column_name));
    const gone = cols.filter((c) => !have.has(c));
    if (gone.length) {
      console.error(`\n  ${t} is missing: ${gone.join(', ')}`);
      console.error('  The target schema is behind this script. Run `npm run migrate`.\n');
      await src.end(); await targetPool.end();
      process.exit(1);
    }
  }

  // ── establish which quote table is which ──
  console.log('\n  IDENTIFYING THE TWO QUOTE FEEDS\n');
  const a = await classifyQuoteTable(src, 'stock_quotes');
  const b = await classifyQuoteTable(src, 'market_stock_snapshots');
  console.log(`    stock_quotes            -> ${a.feed || 'UNKNOWN'}   (${a.why})`);
  console.log(`    market_stock_snapshots  -> ${b.feed || 'UNKNOWN'}   (${b.why})`);

  if (!a.feed || !b.feed || a.feed === b.feed) {
    console.error('\n  REFUSING TO RUN.\n');
    console.error('  The two quote tables could not be told apart. Migrating them the');
    console.error('  wrong way round puts broker rows in the TradingView table, where');
    console.error('  they look entirely normal and nothing downstream complains.\n');
    console.error('  Check with:');
    console.error('    SELECT DISTINCT market FROM stock_quotes LIMIT 10;');
    console.error('    SELECT DISTINCT market FROM market_stock_snapshots LIMIT 10;\n');
    await src.end(); await targetPool.end();
    process.exit(1);
  }

  const awsatQuotes = a.feed === 'awsat' ? 'stock_quotes' : 'market_stock_snapshots';
  const tvQuotes = a.feed === 'awsat' ? 'market_stock_snapshots' : 'stock_quotes';
  console.log(`\n    AWSAT board  = ${awsatQuotes}`);
  console.log(`    TradingView  = ${tvQuotes}`);

  const want = (name) => !ONLY.length || ONLY.includes(name);
  const report = {};

  // ── 1 · TradingView watchlist ──
  if (want('tvquotes')) {
    console.log('\n  TRADINGVIEW WATCHLIST');
    report.tvquotes = await copyTable({
      src,
      table: tvQuotes,
      orderKey: 'id',
      since: SINCE,
      sinceCol: 'created_at',
      targetTable: 'tradingview_watchlist',
      targetCols: ['symbol', 'company_name', 'last_price', 'change_value', 'change_pct',
        'volume', 'avg_volume', 'market_cap', 'trading_date', 'created_at'],
      // DO UPDATE, not DO NOTHING: an earlier run stored these rows with
      // company_name and change_value NULL. DO NOTHING would leave them that
      // way for ever, and re-running would report success while fixing nothing.
      conflict: `ON CONFLICT (symbol, created_at) DO UPDATE SET
                   company_name = COALESCE(EXCLUDED.company_name, tradingview_watchlist.company_name),
                   change_value = COALESCE(EXCLUDED.change_value, tradingview_watchlist.change_value),
                   change_pct   = COALESCE(EXCLUDED.change_pct, tradingview_watchlist.change_pct),
                   last_price   = COALESCE(EXCLUDED.last_price, tradingview_watchlist.last_price),
                   volume       = COALESCE(EXCLUDED.volume, tradingview_watchlist.volume),
                   avg_volume   = COALESCE(EXCLUDED.avg_volume, tradingview_watchlist.avg_volume),
                   market_cap   = COALESCE(EXCLUDED.market_cap, tradingview_watchlist.market_cap)`,
      mapRow: (r) => {
        const at = r.created_at || r.captured_at;
        const sym = parse.toSymbol(r.symbol);
        if (!sym || !at) return null;
        return {
          symbol: sym,
          // The source column is company_name. I read `description` and `name`
          // — neither exists here — so 100 of 100 names migrated as NULL while
          // the source had every one of them.
          company_name: r.company_name ?? r.description ?? r.name ?? null,
          last_price: num(r.last_price),
          // Likewise `change`, not `chg`. The percent was mapped correctly and
          // the absolute value was not, which is why one was 100% populated and
          // the other 0%.
          change_value: num(r.change ?? r.chg ?? r.change_amount),
          change_pct: num(r.change_percent ?? r.pct_chg ?? r.change_pct),
          volume: bigint(r.volume),
          avg_volume: bigint(r.avg_volume),
          market_cap: num(r.market_cap),
          trading_date: r.trading_date || day(at),
          created_at: at,
        };
      },
    });
  }

  // ── 2 · AWSAT board ──
  if (want('quotes')) {
    console.log('\n  AWSAT MARKET QUOTES');
    report.quotes = await copyTable({
      src,
      table: awsatQuotes,
      orderKey: 'id',
      since: SINCE,
      sinceCol: 'created_at',
      targetTable: 'awsat_market_quotes',
      targetCols: ['market', 'symbol', 'code', 'description', 'last_price', 'last_qty',
        'chg', 'pct_chg', 'volume', 'bid', 'bid_qty', 'offer', 'offer_qty', 'trades',
        'last_trade_date', 'last_trade_time', 'open_price', 'high_price', 'low_price',
        'session', 'nms', 'trading_date', 'ingest_source', 'source_precedence', 'created_at'],
      conflict: 'ON CONFLICT (market, symbol, created_at, ingest_source) DO NOTHING',
      mapRow: (r) => {
        const at = r.created_at || r.captured_at;
        const sym = parse.toSymbol(r.symbol);
        if (!sym || !at || !r.market) return null;
        // A single-letter market is a raw MARKET_ID that escaped the name map.
        const market = /^[A-Z]$/i.test(String(r.market).trim())
          ? ({ P: 'Premier Market', M: 'Main Market', B: 'Auction Market' }[r.market] || null)
          : r.market;
        if (!market) return null;

        // Premier + Main only, as everywhere else in the system. The auction
        // book carries the SAME symbols at the SAME instants, so migrating it
        // produced 6,265 rows that collide on (symbol, created_at) while
        // satisfying the unique key — one observation recorded twice.
        //
        // The validator rejects a raw code like 'B', but 'Auction Market' is a
        // legitimate NAME and passed straight through.
        if (!KEEP_MARKETS.includes(market)) return null;

        return {
          market,
          symbol: sym,
          code: r.code ?? null,
          description: r.description ?? null,
          last_price: num(r.last_price),
          last_qty: bigint(r.last_qty),
          chg: num(r.chg),
          pct_chg: num(r.pct_chg),
          volume: bigint(r.volume),
          bid: num(r.bid),
          bid_qty: bigint(r.bid_qty),
          offer: num(r.offer),
          offer_qty: bigint(r.offer_qty),
          trades: bigint(r.trades),
          last_trade_date: r.last_trade_date ?? null,
          // The column is `time` in the new schema; raw cell text is not.
          last_trade_time: parse.toTime(r.last_trade_time),
          open_price: num(r.open_price),
          high_price: num(r.high_price),
          low_price: num(r.low_price),
          session: r.session ?? null,
          nms: num(r.nms),
          trading_date: r.trading_date || day(at),
          ingest_source: 'awsat_server',
          source_precedence: 1,
          created_at: at,
        };
      },
    });
  }

  // ── 3 · depth ──
  if (want('depth')) {
    console.log('\n  STOCK DEPTH');
    let priceless = 0;
    report.depth = await copyTable({
      src,
      table: 'stock_depth',
      orderKey: 'id',
      since: SINCE,
      sinceCol: 'created_at',
      targetTable: 'awsat_stock_depth',
      targetCols: ['symbol', 'level', 'bid', 'bid_qty', 'bid_orders', 'offer',
        'offer_qty', 'offer_orders', 'code', 'trading_date', 'ingest_source',
        'created_at', 'captured_at'],
      // DO UPDATE, not DO NOTHING.
      //
      // A re-run that REPAIRS existing rows must be able to write to them.
      // DO NOTHING skipped 81,108 rows and left their NULL prices intact while
      // reporting success — a repair that silently does nothing is worse than
      // one that fails.
      conflict: `ON CONFLICT (symbol, level, captured_at, ingest_source) DO UPDATE SET
                   bid          = COALESCE(EXCLUDED.bid, awsat_stock_depth.bid),
                   bid_qty      = COALESCE(EXCLUDED.bid_qty, awsat_stock_depth.bid_qty),
                   bid_orders   = COALESCE(EXCLUDED.bid_orders, awsat_stock_depth.bid_orders),
                   offer        = COALESCE(EXCLUDED.offer, awsat_stock_depth.offer),
                   offer_qty    = COALESCE(EXCLUDED.offer_qty, awsat_stock_depth.offer_qty),
                   offer_orders = COALESCE(EXCLUDED.offer_orders, awsat_stock_depth.offer_orders),
                   code         = COALESCE(EXCLUDED.code, awsat_stock_depth.code)`,
      mapRow: (r) => {
        const at = r.created_at || r.captured_at;
        const sym = parse.toSymbol(r.symbol);
        if (!sym || !at || r.level === null) return null;
        // The PRICE columns, under every name this feed has used. Reading
        // only `bid` left the price NULL on all 81,108 rows while the
        // quantities landed — a book showing 28,500 shares exist without
        // saying at what price, which makes every wall and range analysis
        // impossible.
        const bid = num(r.bid ?? r.bid_price ?? r.bidprice ?? r.bp ?? r.bbp);
        const offer = num(r.offer ?? r.offer_price ?? r.ask ?? r.ask_price
          ?? r.offerprice ?? r.ap ?? r.bap);
        const bidQty = bigint(r.bid_qty ?? r.bid_quantity ?? r.bq ?? r.bbq);
        const offerQty = bigint(r.offer_qty ?? r.ask_qty ?? r.offer_quantity
          ?? r.aq ?? r.baq);
        // An empty book is the ABSENCE of one.
        if (!bid && !offer && !bidQty && !offerQty) return null;

        // Quantities with NO price on either side is not a book either — it
        // says shares exist without saying where. Storing it produced 81,108
        // rows that look populated and cannot answer a single question.
        if (bid === null && offer === null) {
          priceless += 1;
          return null;
        }
        return {
          symbol: sym,
          level: Number(r.level),
          bid,
          bid_qty: bidQty,
          // Order counts prove whether a wall is one participant or many.
          bid_orders: bigint(r.bid_orders ?? r.bid_count ?? r.bid_orders_count ?? r.bno),
          offer,
          offer_qty: offerQty,
          offer_orders: bigint(r.offer_orders ?? r.ask_orders ?? r.offer_count
            ?? r.ask_count ?? r.ano),
          code: r.code ?? null,
          trading_date: r.trading_date || day(at),
          ingest_source: 'awsat_server',
          created_at: at,
          // The moment the BOOK was read. Ten levels share it, and it is what
          // groups a snapshot — created_at is insert time.
          captured_at: r.captured_at || at,
        };
      },
    });

    if (priceless) {
      console.log(`    ${fmt(priceless)} level(s) had quantities but NO price on `
        + 'either side — not stored. Check the source price column name.');
    }
  }

  // ── 4 · orders, recovering net_value from raw ──
  if (want('orders')) {
    console.log('\n  ORDER LIST   (net_value recovered from raw)');
    let recovered = 0;
    let recoveredStatus = 0;
    let recoveredFilled = 0;
    let noOrderId = 0;
    let noTimestamp = 0;
    let synthesized = 0;

    /**
     * Per-order tallies, accumulated as the rows stream past.
     *
     * The source snapshots each order 250+ times. Those repeats ARE the
     * sighting count, and a rise in `filled` between two of them is an
     * execution — the settlement fee is charged per execution, so an order
     * that filled in three parts is billed three times.
     *
     * Counted here, keyed by the very same id the mapping produces. An earlier
     * attempt rebuilt the key in SQL and it could never match: the JS hashes
     * NORMALISED values while SQL concatenated raw columns. Two languages
     * computing one identity is how a join silently matches nothing.
     */
    const tally = new Map();
    const skipSamples = [];
    report.orders = await copyTable({
      src,
      table: 'order_list_snapshots',
      orderKey: 'id',
      // The source snapshots each order repeatedly; the target keeps one row.
      dedupeOn: 'order_id',
      since: SINCE,
      sinceCol: 'captured_at',
      targetTable: 'awsat_order_list',
      targetCols: ['order_id', 'symbol', 'side', 'order_status', 'price', 'quantity',
        'filled_quantity', 'remaining_qty', 'order_time', 'trading_date',
        'ingest_source', 'created_at', 'first_seen_at', 'last_seen_at',
        'avg_price', 'order_value', 'net_value', 'status_reason', 'raw',
        // Both counters are computed in the SAME pass that identifies the
        // order, so they cannot disagree with the dedupe about what an order is.
        'sighting_count', 'executions_observed',
        'code', 'order_type', 'exchange', 'portfolio'],
      // One row per order: a later sighting updates rather than duplicating.
      conflict: `ON CONFLICT (order_id) DO UPDATE SET
                   order_status    = COALESCE(EXCLUDED.order_status, awsat_order_list.order_status),
                   filled_quantity = COALESCE(EXCLUDED.filled_quantity, awsat_order_list.filled_quantity),
                   remaining_qty   = COALESCE(EXCLUDED.remaining_qty, awsat_order_list.remaining_qty),
                   quantity        = COALESCE(EXCLUDED.quantity, awsat_order_list.quantity),
                   price           = COALESCE(EXCLUDED.price, awsat_order_list.price),
                   avg_price       = COALESCE(EXCLUDED.avg_price, awsat_order_list.avg_price),
                   order_value     = COALESCE(EXCLUDED.order_value, awsat_order_list.order_value),
                   net_value       = COALESCE(EXCLUDED.net_value, awsat_order_list.net_value),
                   status_reason   = COALESCE(EXCLUDED.status_reason, awsat_order_list.status_reason),
                   order_time      = COALESCE(EXCLUDED.order_time, awsat_order_list.order_time),
                   raw             = COALESCE(EXCLUDED.raw, awsat_order_list.raw),
                   code            = COALESCE(EXCLUDED.code, awsat_order_list.code),
                   order_type      = COALESCE(EXCLUDED.order_type, awsat_order_list.order_type),
                   exchange        = COALESCE(EXCLUDED.exchange, awsat_order_list.exchange),
                   portfolio       = COALESCE(EXCLUDED.portfolio, awsat_order_list.portfolio),
                   -- GREATEST, not the incoming value: a later page may carry a
                   -- lower count for an order already seen in an earlier one.
                   sighting_count  = GREATEST(EXCLUDED.sighting_count, awsat_order_list.sighting_count),
                   executions_observed = GREATEST(EXCLUDED.executions_observed,
                                                  awsat_order_list.executions_observed),
                   first_seen_at   = LEAST(EXCLUDED.first_seen_at, awsat_order_list.first_seen_at),
                   last_seen_at    = GREATEST(EXCLUDED.last_seen_at, awsat_order_list.last_seen_at),
                   updated_at      = now()`,
      mapRow: (r) => {
        const at = r.created_at || r.captured_at;

        // raw is read FIRST. The guard below used to test r.order_id — the
        // COLUMN — and this source keeps the id in raw.clOrdId just as it keeps
        // the status in raw.ordSts. Checking the column before the recovery
        // discarded 12,052 of 13,035 rows before the code that would have
        // found their ids ever ran.
        let raw = null;
        try {
          raw = r.raw && typeof r.raw === 'object' ? r.raw
            : (typeof r.raw === 'string' && r.raw.trim() ? JSON.parse(r.raw) : null);
        } catch { raw = null; }

        /**
         * RAW FIRST, COLUMN SECOND.
         *
         * The source's own columns are largely empty while raw holds the
         * values: order_status is 0/23 in the column and 23/23 in raw.ordSts;
         * filled_quantity the same against raw.cumQty. Only net_value had a
         * raw fallback, so everything else migrated as NULL — an order list
         * with no statuses and no fills.
         *
         * raw wins because it is what the broker actually sent; the columns
         * are what an older extractor managed to map, and it mapped almost
         * nothing.
         */
        const pick = (col, ...keys) => {
          for (const k of keys) {
            if (raw && raw[k] !== undefined && raw[k] !== null && raw[k] !== '') return raw[k];
          }
          return col === undefined ? null : col;
        };
        const pickNum = (col, ...keys) => num(pick(col, ...keys));
        const pickBigint = (col, ...keys) => bigint(pick(col, ...keys));

        // The id, from wherever it actually is. Only now can the row be judged.
        let orderId = pick(
          r.order_id ?? r.clordid ?? r.cl_ord_id ?? r.broker_order_id,
          'clOrdId', 'orderId', 'order_id');
        let synthetic = false;

        /**
         * NO BROKER ID? DERIVE ONE FROM THE ORDER ITSELF.
         *
         * 12,482 of 13,465 source rows carry no order id in any column or in
         * raw — but they are real captures, and they are not 12,482 orders.
         * They are ~107 orders seen 250+ times each across snapshots, and the
         * combination that identifies one is
         *
         *     trading_date · symbol · side · price · quantity · order_time
         *
         * Hashing that gives a stable id: the same order yields the same key
         * on every sighting and on every re-run, so the rows deduplicate and
         * the migration stays idempotent.
         *
         * ─── WHAT THIS COSTS ────────────────────────────────────────────────
         * Two GENUINELY separate orders of identical size, price and side
         * placed in the SAME SECOND collapse into one. Rare, but real — 107
         * could be 106. The alternative was storing 23 of 107, so the trade is
         * worth making; it just has to be stated rather than hidden.
         *
         * The SYN- prefix exists so nobody ever mistakes one of these for a
         * number the broker issued.
         */
        if (!orderId && at) {
          const t = toTimestamp(pick(r.order_time ?? r.order_date, 'adjustedCrdDte'),
            r.trading_date || at);
          const sym = parse.toSymbol(pick(r.symbol ?? r.s_description,
            'symbolInfo.dispProp1', 'symbolInfo.sDes'));
          const side = parse.toSide(pick(r.side ?? r.order_side, 'ordSide'));
          const px = pickNum(r.price ?? r.order_price, 'price');
          const q = pickBigint(r.quantity ?? r.qty, 'ordQty');

          // Every part must be present. A key built from half a row would
          // merge unrelated orders, which is worse than dropping the row.
          if (sym && side && px !== null && q !== null && t) {
            const material = [
              r.trading_date ? day(r.trading_date) : day(at),
              sym, side, px, q, new Date(t).toISOString(),
            ].join('|');
            orderId = `SYN-${crypto.createHash('sha1').update(material).digest('hex').slice(0, 16)}`;
            synthetic = true;
            synthesized += 1;
          }
        }

        if (!orderId || !at) {
          // Say WHICH row and why. "skipped 1" cannot be investigated; a
          // sample of the offending row can.
          if (!orderId) noOrderId += 1; else noTimestamp += 1;
          if (skipSamples.length < 3) {
            skipSamples.push({
              reason: !orderId ? 'no order id in any column or in raw' : 'no timestamp',
              row: JSON.stringify(r).slice(0, 200),
            });
          }
          return null;
        }

        const net = pickNum(r.net_value, 'netOrdVal');
        if (net !== null && (r.net_value === null || r.net_value === undefined)) recovered += 1;

        // The source's OWN column names, learned from the dry run's coverage
        // report. `status`, `filled` and `remaining` were there all along —
        // reading `order_status` and `filled_quantity` found nothing, which is
        // why both had to be rescued from raw on every row.
        const qty = pickBigint(r.quantity ?? r.qty, 'ordQty');
        const filled = pickBigint(r.filled_quantity ?? r.filled, 'cumQty');
        const status = pick(r.order_status ?? r.status, 'ordSts');
        if (status && !r.order_status) recoveredStatus += 1;
        if (filled !== null && (r.filled_quantity === null || r.filled_quantity === undefined)) {
          recoveredFilled += 1;
        }

        // pendQty is on only 3 of 23 rows, so remaining is usually DERIVED.
        // Deriving it is safe: quantity and filled both come from raw and the
        // subtraction is the broker's own arithmetic.
        const pend = pickBigint(r.remaining_qty ?? r.remaining, 'pendQty');

        // Tally this sighting against the id just resolved. Every repeat of
        // one order lands on the same entry, which is what makes the counts
        // agree with the dedupe.
        const seen = tally.get(orderId) || { sightings: 0, executions: 1, lastFilled: null };
        seen.sightings += 1;
        if (filled !== null) {
          if (seen.lastFilled !== null && filled > seen.lastFilled) seen.executions += 1;
          seen.lastFilled = filled;
        }
        tally.set(orderId, seen);

        return {
          order_id: String(orderId).trim(),
          symbol: parse.toSymbol(
            pick(r.symbol ?? r.s_description, 'symbolInfo.dispProp1', 'symbolInfo.sDes')),
          side: parse.toSide(pick(r.side ?? r.order_side, 'ordSide')),
          order_status: status ? String(status).trim() : null,
          price: pickNum(r.price ?? r.order_price, 'price'),
          quantity: qty,
          filled_quantity: filled,
          remaining_qty: pend
            ?? (qty !== null && filled !== null && filled <= qty ? qty - filled : null),
          order_time: toTimestamp(
            pick(r.order_time ?? r.order_date, 'adjustedCrdDte'), r.trading_date || at),
          trading_date: r.trading_date || day(at),
          ingest_source: 'awsat_server',
          created_at: at,
          first_seen_at: at,
          last_seen_at: at,
          avg_price: pickNum(r.avg_price ?? r.average_price, 'avgPrice'),
          order_value: pickNum(r.order_value ?? r.order_val, 'ordVal'),
          net_value: net,
          status_reason: pick(r.status_reason ?? r.reason, 'statusReason', 'rejectReason'),
          // Keep the synthetic marker in raw so the derivation is auditable.
          raw: JSON.stringify({ ...(raw || {}), ...(synthetic ? { _synthetic_id: true } : {}) }),
          // Live getters, not values.
          //
          // The tally keeps growing as later sightings of this order stream
          // past, and the row is not inserted until its page is complete. A
          // snapshot taken here would freeze the count at whatever it was on
          // the FIRST sighting — which is 1, the number that was wrong.
          code: pick(r.code, 'symbolInfo.code'),
          order_type: pick(r.order_type, 'ordTyp'),
          exchange: pick(r.exchange, 'exg'),
          portfolio: pick(r.portfolio, 'portfolio'),
          get sighting_count() { return seen.sightings; },
          get executions_observed() { return seen.executions; },
        };
      },
    });
    report.orders.recovered = recovered;

    if (APPLY) {
      const multi = [...tally.values()].filter((t) => t.executions > 1).length;
      const repeats = [...tally.values()].reduce((n, t) => n + t.sightings, 0) - tally.size;
      console.log(`               ${fmt(tally.size)} DISTINCT order(s) from `
        + `${fmt(repeats)} repeat sighting(s)`);
      console.log('               (the "written" figure sums inserts AND updates across');
      console.log('                pages, so it exceeds the order count — trust this one)');
      console.log(`               ${fmt(multi)} filled in more than one execution`);
      report.orders.multiExecution = multi;
      // The authoritative order count, for the reconciliation below.
      report.orders.distinct = tally.size;

      // WHY rows were skipped, and what a skipped one looks like.
      //
      // These counters were being incremented and never printed — an earlier
      // edit removed the reporting block and left the tracking behind. "skipped
      // 1" with no explanation is exactly the silence this was built to end.
      if (synthesized) {
        console.log(`               ${fmt(synthesized)} row(s) had no broker id — a SYN- id was`);
        console.log('               derived from (date, symbol, side, price, qty, order_time).');
        console.log('               Identical orders in the same second collapse into one.');
      }
      if (noOrderId || noTimestamp) {
        console.log(`               SKIPPED: ${fmt(noOrderId)} with no id anywhere, `
          + `${fmt(noTimestamp)} with no timestamp`);
        for (const sk of skipSamples) {
          console.log(`                 ${sk.reason}`);
          console.log(`                 ${sk.row}`);
        }
      }
    }
  }

  // ── 5 · daily history ──
  if (want('daily')) {
    console.log('\n  DAILY HISTORY');
    report.daily = await copyTable({
      src,
      table: 'stock_daily',
      // MUST END IN SOMETHING UNIQUE. stock_daily is keyed (symbol,
      // trading_date), so one date holds ~137 rows and ORDER BY trading_date
      // alone leaves their order undefined — OFFSET paging over an unstable
      // sort skips and repeats rows. Measured: 423 of 3,000 lost.
      orderKey: 'trading_date, symbol',
      since: SINCE,
      sinceCol: 'trading_date',
      targetTable: 'tradingview_history',
      targetCols: ['symbol', 'trade_date', 'open_price', 'high_price', 'low_price',
        'close_price', 'change_value', 'change_pct', 'volume'],
      conflict: `ON CONFLICT (symbol, trade_date) DO UPDATE SET
                   close_price = COALESCE(EXCLUDED.close_price, tradingview_history.close_price),
                   volume = COALESCE(EXCLUDED.volume, tradingview_history.volume),
                   updated_at = now()`,
      mapRow: (r) => {
        const sym = parse.toSymbol(r.symbol);
        const d = r.trading_date || r.trade_date;
        if (!sym || !d) return null;
        return {
          symbol: sym,
          trade_date: day(d),
          open_price: num(r.open_price ?? r.open_px),
          high_price: num(r.high_price ?? r.high_px),
          low_price: num(r.low_price ?? r.low_px),
          close_price: num(r.close_price ?? r.close_px),
          change_value: num(r.change_value ?? r.chg),
          change_pct: num(r.change_pct ?? r.pct_chg),
          volume: bigint(r.volume ?? r.total_volume),
        };
      },
    });
  }

  // ── summary ──
  console.log(`\n  ${'─'.repeat(72)}`);
  for (const [name, r] of Object.entries(report)) {
    console.log(`  ${name.padEnd(12)} read ${fmt(r.read ?? r.total).padStart(11)}`
      + `   mappable ${fmt(r.mapped).padStart(11)}`
      + `   skipped ${fmt(r.skipped).padStart(8)}`
      + (APPLY ? `   written ${fmt(r.inserted).padStart(11)}` : ''));
    if (r.read && r.total && r.read > r.total) {
      console.log(`  ${''.padEnd(12)} the source grew by ${fmt(r.read - r.total)} row(s) `
        + 'during the read — the scrapers are still writing to it');
    }
    if (r.skipped && r.total && r.skipped > r.total * 0.5) {
      console.log(`  ${''.padEnd(12)} WARNING: over half the rows were unmappable. `
        + 'Check the source column names against the mapping.');
    }
    // Rows that were mappable but the database refused. These are LOST — the
    // source is live and a trading minute cannot be re-read.
    if (r.failed) {
      console.log(`  ${''.padEnd(12)} !! ${fmt(r.failed)} ROW(S) REJECTED BY THE DATABASE:`);
      for (const f of r.failures) {
        console.log(`  ${''.padEnd(12)}    ${f.reason}`);
        console.log(`  ${''.padEnd(12)}    ${f.row}`);
      }
    }
    // mapped - inserted is explained by ON CONFLICT (already present) or by
    // collapsing. Anything left over is unaccounted for and must be said.
    if (APPLY) {
      const accounted = r.inserted + (r.collapsed || 0) + (r.failed || 0);
      if (r.mapped > accounted) {
        console.log(`  ${''.padEnd(12)} ${fmt(r.mapped - accounted)} row(s) mapped but not inserted `
          + '— already present (ON CONFLICT), or unaccounted for');
      }
    }
    if (r.coverage && r.coverage.unread.length) {
      console.log(`  ${''.padEnd(12)} SOURCE COLUMNS NOT READ: `
        + r.coverage.unread.map((u) => `${u.column}=${u.sample}`).join(', '));
      console.log(`  ${''.padEnd(12)} ^ these were never accessed by the mapping. If any belongs`);
      console.log(`  ${''.padEnd(12)}   in the target, the mapping is incomplete.`);
    }
    if (r.coverage && r.coverage.allNull.length) {
      console.log(`  ${''.padEnd(12)} TARGET COLUMNS ALL NULL: ${r.coverage.allNull.join(', ')}`);
    }
    if (r.collapsed) {
      console.log(`  ${''.padEnd(12)} ${fmt(r.collapsed)} repeat sighting(s) collapsed `
        + '— the source snapshots each order many times');
    }
    for (const [label, v] of [['net_value', r.recovered],
      ['order_status', r.recoveredStatus], ['filled_quantity', r.recoveredFilled]]) {
      if (v) console.log(`  ${''.padEnd(12)} ${label} recovered from raw on ${fmt(v)} row(s)`);
    }
  }

  // ── POST-MIGRATION ────────────────────────────────────────────────────
  //
  // Everything below fixes a problem this migration has actually caused at
  // least once. It runs automatically because the alternative — a list of
  // follow-up commands in a chat message — was tried, and the commands were
  // not run.
  //
  // Skip with --no-post if a step ever needs doing by hand.
  if (APPLY && !process.argv.includes('--no-post')) {
    console.log(`\n  ${'─'.repeat(72)}`);
    console.log('  POST-MIGRATION\n');

    // 1 · Statistics. A bulk load leaves the planner blind, and the very next
    //     query — including the ones below — is planned as though the tables
    //     were empty.
    process.stdout.write('    analysing tables … ');
    await repair.analyse(['tradingview_watchlist', 'awsat_market_quotes',
      'awsat_stock_depth', 'awsat_order_list', 'tradingview_history']);
    console.log('done');

    // 2 · Markets outside scope — REPORTED, never deleted.
    //
    // This used to delete them, which contradicts session_close(): the closing
    // AUCTION is one of the four sessions that determine a close — the whole
    // TIJARA 172-vs-176 fix. Deleting by MARKET and reading by SESSION are two
    // different things, and destroying rows on the strength of my own filter
    // while another function depends on them is not a trade worth making.
    //
    // Excluding the auction market at CAPTURE is right. Deleting captured rows
    // afterwards is not: the data is already paid for and cannot be re-read.
    const unwanted = await repair.removeUnwantedMarkets({ apply: false });
    if (unwanted.rows) {
      console.log(`    ${fmt(unwanted.rows)} row(s) in `
        + `${unwanted.markets.map((m) => m.market).join(', ')} — LEFT IN PLACE`);
      console.log('      (session_close() reads the closing auction; deleting these');
      console.log('       would destroy closes. Exclude at capture, not after.)');
    }

    // 3 · One symbol, one market. A symbol under two markets at the same
    //     instant is one observation stored twice — a board sweep that failed
    //     to switch and re-read the previous screen.
    /*
     * F-11 · REPORTED, NEVER APPLIED UNATTENDED.
     *
     * This was `{ apply: true }` inside `migrate-all`, so a destructive repair
     * ran with nobody watching as part of a migration run. It deletes rows from
     * the trader's own capture record, on the evidence of a same-instant
     * duplicate, and a wrong call here cannot be undone — the data was paid for
     * once and cannot be re-read.
     *
     * The block immediately above already reached this conclusion for
     * removeUnwantedMarkets, for the same reason, and left it at
     * `{ apply: false }`. This is the same decision applied to the same class
     * of operation.
     *
     * The repair is still available, deliberately:
     *     node scripts/repair-market-labels.js --apply
     */
    const labels = await repair.repairMarketLabels({ apply: false });
    if (labels.decided.length) {
      console.log(`    ${labels.decided.length} mislabelled symbol(s) found — NOT repaired:`);
      for (const d of labels.decided.slice(0, 10)) {
        console.log(`      ${d.symbol.padEnd(12)} ${d.distribution}  ->  keep ${d.keep}`);
      }
      if (labels.decided.length > 10) console.log(`      … +${labels.decided.length - 10} more`);
      console.log('      Deleting rows from the capture record is not an unattended');
      console.log('      operation. To apply, scoped to the colliding days only:');
      console.log('        node scripts/repair-market-labels.js --apply');
    }
    if (labels.unclear.length) {
      console.log(`    ${labels.unclear.length} symbol(s) too evenly split to judge — LEFT ALONE:`);
      for (const u of labels.unclear) console.log(`      ${u.symbol.padEnd(12)} ${u.distribution}`);
      console.log('      An even split is not a failed switch. Investigate before deleting.');
    }

    // 4 · The registry. /depth-symbols JOINs on it; empty means an empty
    //     sweep list and a client silently falling back to hardcoded names.
    const seeded = await repair.seedInstruments({ apply: true });
    console.log(`    instruments: ${fmt(seeded.written)} symbol(s) registered`);
    if (seeded.noMarket.length) {
      console.log(`      ${seeded.noMarket.length} with no market (watchlist only): `
        + `${seeded.noMarket.slice(0, 8).map((c) => c.symbol).join(', ')}`);
      console.log('      These will not be swept for depth.');
    }

    // 5 · RECONCILE against the source.
    //
    // Everything above proves the migration FINISHED. This asks whether it is
    // CORRECT: are the symbols the same, the date range the same, and is any
    // target column empty that the source had data for.
    //
    // The depth failure — quantities present, prices NULL on all 81,108 rows —
    // would have been caught here on the run that caused it, instead of a week
    // later by someone querying the table.
    console.log('\n  RECONCILIATION vs source\n');

    const PAIRS = [
      ['tradingview_watchlist', tvQuotes, 'created_at'],
      ['awsat_market_quotes', awsatQuotes, 'created_at'],
      ['awsat_stock_depth', 'stock_depth', 'created_at'],
      ['tradingview_history', 'stock_daily', 'trading_date'],
      // The table with the known history of silent loss was the one never
      // checked. It reconciles on DISTINCT orders, not rows: the source
      // snapshots each order hundreds of times, so a row count would always
      // look catastrophically short and tell you nothing.
      ['awsat_order_list', 'order_list_snapshots', 'captured_at'],
    ];

    for (const [target, source, tsCol] of PAIRS) {
      // Match the table to the --only name it belongs to, rather than by
      // substring: 'orders' does not appear in any target name, so the old
      // test skipped every table and the section printed nothing at all.
      const belongsTo = {
        tradingview_watchlist: 'tvquotes',
        awsat_market_quotes: 'quotes',
        awsat_stock_depth: 'depth',
        awsat_order_list: 'orders',
        tradingview_history: 'daily',
      }[target];
      if (ONLY.length && !ONLY.includes(belongsTo)) continue;
      try {
        const tgtKey = target === 'awsat_order_list' ? 'order_id' : 'symbol';

        // ORDERS ARE NOT RECOUNTED HERE.
        //
        // An earlier version rebuilt the identity in SQL with fewer parts than
        // the migration uses, collapsed 116 orders into 76, and then reported
        // the target as holding MORE than the source — impossible, and so
        // obviously a fault in the measurement rather than the data.
        //
        // The migration already counted the distinct orders while reading, with
        // the only definition that matters. Reusing that number is the one way
        // the two cannot drift apart.
        const knownDistinct = target === 'awsat_order_list'
          ? (report.orders && report.orders.distinct) : null;

        const { rows: srcAgg } = knownDistinct != null
          ? [{ rows: [{ symbols: knownDistinct, lo: null, hi: null }] }][0]
          : await src.query(
          `SELECT count(DISTINCT symbol)::int AS symbols,
                  min(${tsCol})::text AS lo, max(${tsCol})::text AS hi
             FROM "${source}"` + (SINCE ? ` WHERE ${tsCol} >= '${SINCE}'` : ''));

        // Dates still come from the source even when the count does not.
        if (knownDistinct != null) {
          const { rows: span } = await src.query(
            `SELECT min(${tsCol})::text AS lo, max(${tsCol})::text AS hi FROM "${source}"`);
          srcAgg[0].lo = span[0].lo;
          srcAgg[0].hi = span[0].hi;
        }
        const { rows: tgtAgg } = await query(
          `SELECT count(*)::int AS rows, count(DISTINCT ${tgtKey})::int AS symbols,
                  min(${target === 'tradingview_history' ? 'trade_date' : 'created_at'})::text AS lo,
                  max(${target === 'tradingview_history' ? 'trade_date' : 'created_at'})::text AS hi
             FROM ${target}`);

        const sy = srcAgg[0].symbols;
        const ty = tgtAgg[0].symbols;
        const gap = sy - ty;
        const label = target === 'awsat_order_list' ? 'order' : 'symbol';
        console.log(`    ${target.padEnd(24)} ${fmt(tgtAgg[0].rows).padStart(11)} row(s)  `
          + `${ty}/${sy} ${label}(s)`
          + (gap > 0 ? `   <-- ${gap} SYMBOL(S) MISSING` : ''));
        console.log(`    ${''.padEnd(24)} source ${String(srcAgg[0].lo).slice(0, 10)} .. ${String(srcAgg[0].hi).slice(0, 10)}`
          + `   target ${String(tgtAgg[0].lo).slice(0, 10)} .. ${String(tgtAgg[0].hi).slice(0, 10)}`);

        // Any target column entirely NULL is the depth-prices failure mode:
        // the table looks populated and cannot answer a question.
        const { rows: tcols } = await query(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema='public' AND table_name=$1`, [target]);
        const names = tcols.map((c) => c.column_name)
          .filter((c) => !['id', 'run_id', 'scrape_batch_id', 'computed_at'].includes(c));
        if (names.length && Number(tgtAgg[0].rows) > 0) {
          const counts = names.map((c) => `count("${c}")::bigint AS "${c}"`).join(', ');
          const { rows: filled } = await query(`SELECT ${counts} FROM ${target}`);
          const empty = Object.entries(filled[0])
            .filter(([, v]) => Number(v) === 0).map(([k]) => k);
          if (empty.length) {
            console.log(`    ${''.padEnd(24)} 100% NULL: ${empty.join(', ')}`);
            console.log(`    ${''.padEnd(24)} ^ check these against the source before trusting the table`);
          }
        }
      } catch (err) {
        console.log(`    ${target.padEnd(24)} could not reconcile: ${err.message.slice(0, 50)}`);
      }
    }

    // 6 · Say what is still wrong.
    const findings = await repair.integrityReport();
    if (findings.length) {
      console.log(`\n  REMAINING ISSUES (${findings.length})\n`);
      for (const f of findings) {
        console.log(`    [${f.level.toUpperCase()}] ${f.what}`);
        console.log(`            ${f.why}`);
        console.log(`            fix: ${f.fix}`);
      }
    } else {
      console.log('\n  No integrity issues found.');
    }
  }

  fs.mkdirSync(OUT, { recursive: true });  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `migration-report-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify({
    at: new Date().toISOString(), applied: APPLY, since: SINCE,
    feeds: { awsat: awsatQuotes, tradingview: tvQuotes }, report,
  }, null, 2));
  console.log(`\n  report  ${file}`);

  if (!APPLY) {
    console.log('\n  DRY RUN — nothing written. Re-run with --apply.\n');
  } else {
    console.log('\n  Done. Verify before trusting it:\n');
    console.log('    SELECT count(*), min(trading_date), max(trading_date) FROM awsat_market_quotes;');
    console.log('    SELECT count(*) FROM awsat_order_list WHERE net_value IS NOT NULL;\n');
  }
  await src.end();
  await targetPool.end();
}

main().catch((err) => {
  log.error('migration failed', { err: err.message });
  console.error(`\n  failed: ${err.message}\n`);
  process.exit(1);
});

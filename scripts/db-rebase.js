'use strict';
/**
 * scripts/db-rebase.js — move a database from the pre-rename schema to the
 * production-aligned one.
 *
 * ─── WHY THIS EXISTS ───────────────────────────────────────────────────────
 * 001_init.sql was REPLACED, not amended: the tables were renamed to match the
 * production SPREAD schema (quotes -> live_quotes and so on). A database that
 * applied the old file therefore fails the migrator's checksum check:
 *
 *     migration changed after it was applied: 001_init.sql
 *
 * That check is right and should not be worked around casually — silently
 * re-stamping a ledger is exactly how a database and a repository drift apart
 * without anyone noticing. This script does the transition deliberately and
 * shows its work.
 *
 * ─── IT INSPECTS BEFORE IT TOUCHES ANYTHING ────────────────────────────────
 * Default mode reports what is there and changes nothing. Nothing is dropped
 * until you have seen the row counts, because a trading session cannot be
 * re-scraped: the broker serves today's tape and nothing older.
 *
 *   node scripts/db-rebase.js              inspect only
 *   node scripts/db-rebase.js --migrate    create new tables, copy data across
 *   node scripts/db-rebase.js --migrate --drop-old   ...and drop the old tables
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { config } = require('../src/config');
const { pool, query, close } = require('../src/db/pool');

const MIGRATIONS = path.join(__dirname, '..', 'src', 'db', 'migrations');

/**
 * Tables the old schema owned. scrape_runs is included even though the new
 * schema uses the same NAME: its columns differ (trading_day vs trading_date),
 * and `CREATE TABLE IF NOT EXISTS` would silently keep the old shape and then
 * fail when an index referenced a column that does not exist. Caught by running
 * this against a real copy of the old database.
 */
const OLD_TABLES = ['quotes', 'symbols', 'depth_levels', 'orders', 'daily_prices', 'scrape_runs'];
const NEW_TABLES = [
  'live_quotes', 'instruments', 'order_book_levels',
  'broker_orders', 'daily_bars',
];

const DO_MIGRATE = process.argv.includes('--migrate');
const DROP_OLD = process.argv.includes('--drop-old');
const YES = process.argv.includes('--yes');

async function tableExists(name) {
  const { rows } = await query(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1`, [name]);
  return rows.length > 0;
}

async function countRows(name) {
  if (!await tableExists(name)) return null;
  const { rows } = await query(`SELECT count(*)::int AS c FROM ${name}`);
  return rows[0].c;
}

async function confirm(prompt) {
  if (YES) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) => rl.question(prompt, r));
  rl.close();
  return answer.trim() === 'YES';
}

/**
 * Copy rows across, mapping the renamed columns.
 *
 * live_quotes.market is NOT NULL and part of the dedup key, but the old table
 * had no market column — so old rows are labelled with their source. That keeps
 * them distinguishable from broker rows rather than inventing a market they
 * were never tagged with.
 */
const COPY = [
  {
    from: 'symbols_legacy', to: 'instruments',
    sql: `INSERT INTO instruments (market, symbol, description, first_seen_on, last_seen_on, is_active)
          SELECT COALESCE(market, 'LEGACY'), symbol, name, first_seen_on, last_seen_on, is_active
            FROM symbols_legacy
          ON CONFLICT (symbol) DO NOTHING`,
  },
  {
    from: 'quotes_legacy', to: 'live_quotes',
    sql: `INSERT INTO live_quotes
            (market, symbol, last_price, chg, pct_chg, volume, bid, bid_qty,
             offer, offer_qty, trades, open_price, high_price, low_price,
             trading_date, source, created_at)
          SELECT COALESCE(market, upper(source)), symbol, last_price,
                 change_amount, change_percent, volume, bid, bid_qty,
                 ask, ask_qty, trades_count, open_price, high_price, low_price,
                 trading_day, source, minute_bucket
            FROM quotes_legacy
          ON CONFLICT (market, symbol, created_at) DO NOTHING`,
  },
  {
    from: 'depth_levels_legacy', to: 'order_book_levels',
    sql: `INSERT INTO order_book_levels
            (symbol, level, bid, bid_qty, bid_orders, offer, offer_qty, offer_orders,
             trading_date, created_at)
          SELECT symbol, level, bid, bid_qty, bid_orders, ask, ask_qty, ask_orders,
                 trading_day, captured_at
            FROM depth_levels_legacy
          ON CONFLICT (symbol, level, created_at) DO NOTHING`,
  },
  {
    from: 'orders_legacy', to: 'broker_orders',
    sql: `INSERT INTO broker_orders
            (order_id, symbol, side, order_status, price, quantity,
             filled_quantity, remaining_qty, order_time, trading_date, created_at)
          SELECT order_id, symbol, side, order_status, price, quantity,
                 filled_quantity, remaining_qty, order_time, trading_day, captured_at
            FROM orders_legacy
          ON CONFLICT (order_id, created_at) DO NOTHING`,
  },
  {
    from: 'daily_prices_legacy', to: 'daily_bars',
    sql: `INSERT INTO daily_bars
            (symbol, trade_date, open_price, high_price, low_price, close_price,
             change_value, change_pct, volume, source)
          SELECT symbol, trading_day, open_price, high_price, low_price, close_price,
                 change_amount, change_percent, volume, source
            FROM daily_prices_legacy
          ON CONFLICT (symbol, trade_date) DO NOTHING`,
  },
];

/**
 * OBSOLETE as of migration 011/014.
 *
 * This moved a database from the pre-rename schema to the 002 names —
 * live_quotes, order_book_levels, broker_orders, daily_bars. Every one of those
 * has since been replaced (005) or dropped (008). Running it now would create
 * tables nothing reads and copy data nothing computes from.
 *
 * It is not deleted: a database that never got past 001 still exists in
 * principle, and the column mapping it records is the only written account of
 * how the original names lined up. It refuses to run instead, and points at
 * the tool that IS current.
 */
function refuse() {
  console.log(`\n  db-rebase is OBSOLETE.\n`);
  console.log('  It targets live_quotes, order_book_levels, broker_orders and');
  console.log('  daily_bars — replaced by migration 005 and dropped by 008.\n');
  console.log('  To bring an OLD database forward, use the quote migration, which');
  console.log('  reads a source database and deduplicates into the current schema:\n');
  console.log('      npm run migrate:quotes -- --from=<source url>          (dry run)');
  console.log('      npm run migrate:quotes -- --from=<source url> --apply\n');
  console.log('  The column mapping this script recorded is kept in the source');
  console.log('  above for reference.\n');
  process.exit(1);
}

async function main() {
  refuse();

  const host = (() => {
    try { const u = new URL(config.db.url); return `${u.hostname}:${u.port || 5432}${u.pathname}`; }
    catch { return '(unparseable)'; }
  })();

  console.log(`\n  DATABASE REBASE`);
  console.log(`  target   ${host}`);
  console.log(`  mode     ${DO_MIGRATE ? (DROP_OLD ? 'migrate + drop old' : 'migrate, keep old') : 'INSPECT ONLY — nothing will change'}`);
  console.log(`  ${'─'.repeat(72)}`);

  console.log('\n  old tables');
  let oldTotal = 0;
  for (const t of OLD_TABLES) {
    const c = await countRows(t);
    if (c === null) { console.log(`    ${t.padEnd(26)} absent`); continue; }
    oldTotal += c;
    console.log(`    ${t.padEnd(26)} ${c.toLocaleString()} rows`);
  }

  console.log('\n  new tables');
  for (const t of NEW_TABLES) {
    const c = await countRows(t);
    console.log(`    ${t.padEnd(26)} ${c === null ? 'not created yet' : `${c.toLocaleString()} rows`}`);
  }

  if (!DO_MIGRATE) {
    console.log(`\n  ${'─'.repeat(72)}`);
    console.log(`  ${oldTotal.toLocaleString()} row(s) in the old tables.`);
    console.log('\n  Nothing has been changed. To proceed:');
    console.log('      node scripts/db-rebase.js --migrate              copy data across, keep the old tables');
    console.log('      node scripts/db-rebase.js --migrate --drop-old   ...and drop them afterwards\n');
    await close();
    return;
  }

  // 1 — move the old tables aside FIRST.
  //
  // Renaming rather than dropping: the data is still there and still readable
  // until you say otherwise. It also sidesteps every name and shape collision
  // in one move — scrape_runs exists under both schemas with different columns,
  // and IF NOT EXISTS would quietly keep the old one.
  console.log('\n  renaming the old tables aside ...');
  for (const t of OLD_TABLES) {
    if (!await tableExists(t)) continue;
    await query(`DROP TABLE IF EXISTS ${t}_legacy CASCADE`);
    await query(`ALTER TABLE ${t} RENAME TO ${t}_legacy`);
    console.log(`    ${t} -> ${t}_legacy`);
  }

  // 2 — create the new schema on clean ground.
  const file = path.join(MIGRATIONS, '001_init.sql');
  const sql = fs.readFileSync(file, 'utf8');
  console.log('  creating the new tables ...');
  await query(sql);

  // 3 — copy what exists.
  console.log('  copying data ...');
  for (const step of COPY) {
    if (!await tableExists(step.from)) continue;
    try {
      const res = await query(step.sql);
      console.log(`    ${step.from} -> ${step.to}: ${res.rowCount} row(s)`);
    } catch (err) {
      // One table failing must not abandon the rest; the others are still
      // worth moving and the failure is named rather than swallowed.
      console.log(`    ${step.from} -> ${step.to}: FAILED — ${err.message}`);
    }
  }

  // 4 — re-stamp the ledger to the file that is now applied.
  const checksum = crypto.createHash('sha256').update(sql).digest('hex').slice(0, 16);
  await query(
    `INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)
     ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now()`,
    ['001_init.sql', checksum],
  );
  console.log(`  ledger re-stamped: 001_init.sql -> ${checksum}`);

  // 5 — drop the legacy tables, only on an explicit flag and an explicit yes.
  if (DROP_OLD) {
    console.log(`\n  About to DROP: ${OLD_TABLES.map((t) => `${t}_legacy`).join(', ')}`);
    console.log('  A trading session cannot be re-scraped — the broker serves today only.');
    if (await confirm('  Type YES to drop them: ')) {
      for (const t of OLD_TABLES) {
        await query(`DROP TABLE IF EXISTS ${t}_legacy CASCADE`);
        console.log(`    dropped ${t}_legacy`);
      }
    } else {
      console.log('  Skipped. The old tables are still there.');
    }
  }

  console.log('\n  Done. `npm start` should now boot.\n');
  await close();
}

main().catch(async (err) => {
  console.error(`\n  rebase failed: ${err.message}\n`);
  await close().catch(() => {});
  process.exit(1);
});

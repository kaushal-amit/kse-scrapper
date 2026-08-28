'use strict';
/**
 * scripts/migrate-inspect.js — what is actually in the old database?
 *
 *   node scripts/migrate-inspect.js --from=postgresql://user:pass@host/olddb
 *
 * READ ONLY. It opens no transaction, writes nothing, and creates nothing. Run
 * it against production without hesitation.
 *
 * ─── WHY THIS COMES BEFORE ANY MIGRATION ───────────────────────────────────
 * The column names, the date range, the duplicate count and the NULL rate all
 * decide how the move should work. Guessing any of them produces a migration
 * that runs cleanly and lands the wrong data — which is worse than one that
 * fails, because nothing tells you.
 *
 * It reports per table: row count, date span, and for the tables that matter,
 * the duplicate shape and which columns are entirely empty.
 */

const { Pool } = require('pg');

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : null;
};

const FROM = arg('from') || process.env.MIGRATE_FROM;
const SCHEMA = arg('schema') || 'public';

/** Tables worth looking at closely, and the key their duplicates form on. */
const OF_INTEREST = {
  stock_quotes: ['market', 'symbol', 'created_at'],
  quotes: ['symbol', 'minute_bucket'],
  awsat_market_quotes: ['market', 'symbol', 'created_at'],
  stock_depth: ['symbol', 'level', 'created_at'],
  depth_levels: ['symbol', 'level', 'captured_at'],
  order_list_snapshots: ['order_id', 'created_at'],
  orders: ['order_id', 'captured_at'],
  stock_prices_daily: ['symbol', 'trade_date'],
  daily_prices: ['symbol', 'trading_day'],
};

const line = (l, v) => console.log(`    ${String(l).padEnd(22)} ${v}`);

async function main() {
  if (!FROM) {
    // npm swallows arguments placed before its own `--`, so the most likely
    // reason we are here is a correct command missing one separator. Say that
    // first — "argument required" alone sends people to re-read the argument
    // they already typed.
    console.error('\n  No source database given.\n');
    console.error('  Through npm, the separator is required:\n');
    console.error('      npm run migrate:inspect -- --from=postgresql://user:pass@host:5432/db');
    console.error('                              ^^ npm drops anything before this\n');
    console.error('  Directly:\n');
    console.error('      node scripts/migrate-inspect.js --from=postgresql://user:pass@host:5432/db\n');
    console.error('  Or by environment, which avoids the quoting entirely:\n');
    console.error('      MIGRATE_FROM=postgresql://... npm run migrate:inspect\n');
    console.error('  A password with @ : / or # in it must be percent-encoded,');
    console.error('  or the URL parses with the wrong host.\n');
    process.exit(1);
  }

  const src = new Pool({ connectionString: FROM, statement_timeout: 120_000 });

  console.log(`\n  SOURCE INSPECTION  (read only)`);
  console.log(`  ${FROM.replace(/:[^:@/]*@/, ':***@')}`);
  console.log(`  ${'─'.repeat(72)}`);

  const { rows: who } = await src.query(
    'SELECT current_database() AS db, inet_server_addr()::text AS host, inet_server_port() AS port');
  line('database', `${who[0].db} @ ${who[0].host}:${who[0].port}`);

  const { rows: tables } = await src.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name`, [SCHEMA]);

  if (!tables.length) {
    console.log(`\n  No tables in schema "${SCHEMA}".`);
    console.log('  If the data lives elsewhere, pass --schema=<name>.\n');
    await src.end();
    return;
  }

  console.log(`\n  TABLES (${tables.length})\n`);

  for (const { table_name: t } of tables) {
    let count = 0;
    try {
      ({ rows: [{ count }] } = await src.query(`SELECT count(*)::bigint AS count FROM "${t}"`));
    } catch (err) {
      console.log(`  ${t.padEnd(28)} unreadable: ${err.message.slice(0, 50)}`);
      continue;
    }

    console.log(`  ${t.padEnd(28)} ${Number(count).toLocaleString().padStart(12)} rows`);
    if (Number(count) === 0) continue;

    // Date span, from whichever timestamp column the table has.
    const { rows: cols } = await src.query(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`, [SCHEMA, t]);

    const dateCol = ['trading_date', 'trading_day', 'trade_date', 'created_at',
      'captured_at', 'minute_bucket'].find((c) => cols.some((x) => x.column_name === c));

    if (dateCol) {
      try {
        const { rows: [span] } = await src.query(
          `SELECT min("${dateCol}")::text AS lo, max("${dateCol}")::text AS hi,
                  count(DISTINCT "${dateCol}"::date)::int AS days FROM "${t}"`);
        line('span', `${span.lo} .. ${span.hi}   (${span.days} distinct day(s), by ${dateCol})`);
      } catch { /* not a date after all */ }
    }

    // Duplicate shape on the key this table's rows collide on.
    const key = OF_INTEREST[t];
    if (key && key.every((k) => cols.some((c) => c.column_name === k))) {
      const cs = key.map((k) => `"${k}"`).join(', ');
      try {
        const { rows: [d] } = await src.query(`
          SELECT count(*)::int AS dup_keys, COALESCE(sum(n - 1), 0)::int AS extra_rows
            FROM (SELECT ${cs}, count(*) AS n FROM "${t}" GROUP BY ${cs} HAVING count(*) > 1) g`);
        if (d.dup_keys > 0) {
          line('DUPLICATE KEYS', `${d.dup_keys.toLocaleString()} key(s), `
            + `${d.extra_rows.toLocaleString()} extra row(s) on (${key.join(', ')})`);
        } else {
          line('duplicates', `none on (${key.join(', ')})`);
        }
      } catch { /* skip */ }
    }

    // Columns that are entirely NULL. A column that has never held a value is
    // either a field the feed does not send or an extractor that never mapped
    // it — and the difference matters before anything is copied.
    if (Number(count) > 0 && cols.length <= 60) {
      const checks = cols.map((c) => `count("${c.column_name}")::bigint AS "${c.column_name}"`).join(', ');
      try {
        const { rows: [filled] } = await src.query(`SELECT ${checks} FROM "${t}"`);
        const empty = Object.entries(filled).filter(([, v]) => Number(v) === 0).map(([k]) => k);
        if (empty.length) line('100% NULL', empty.join(', '));
      } catch { /* skip */ }
    }
    console.log('');
  }

  console.log(`  ${'─'.repeat(72)}`);
  console.log('  Nothing was modified.\n');
  console.log('  Next, for the quotes:');
  console.log('      npm run migrate:quotes -- --from=<same url>            (dry run)');
  console.log('      npm run migrate:quotes -- --from=<same url> --apply\n');

  await src.end();
}

main().catch((err) => {
  console.error(`\n  inspection failed: ${err.message}\n`);
  process.exit(1);
});

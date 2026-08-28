'use strict';
/**
 * scripts/seed-instruments.js — fill the symbol registry from what was captured.
 *
 *   node scripts/seed-instruments.js            report only
 *   node scripts/seed-instruments.js --apply
 *
 * ─── WHY IT MATTERS THAT THIS IS EMPTY ─────────────────────────────────────
 * instruments is the reference list. Three things read it and all three fail
 * quietly when it is empty:
 *
 *   · the coverage check has no reference before TradingView's first run,
 *     so it skips instead of comparing
 *   · /depth-symbols JOINs on instruments.market, so an empty registry serves
 *     an EMPTY sweep list and the client falls back to its 8 hardcoded names
 *   · the history job takes its symbol list from here
 *
 * Nothing errors. The system simply covers less than it appears to.
 *
 * The registry is DERIVED, not authored: every symbol either feed has actually
 * seen, with the market the broker assigned it. Deriving it means it cannot
 * drift from the data, and a newly listed stock appears without anyone editing
 * a list.
 */

const { query } = require('../src/db/pool');
const log = require('../src/logger');

const APPLY = process.argv.includes('--apply');

const step = (msg) => console.log(`  ${new Date().toISOString().slice(11, 19)}  ${msg}`);

async function main() {
  console.log(`\n  SEED instruments  ${APPLY ? '(APPLY)' : '(report only)'}`);
  console.log(`  ${'─'.repeat(70)}`);

  // Fail rather than hang. A query with no ceiling gives no way to tell a slow
  // one from a stuck one, and the only recourse is Ctrl-C and a guess.
  await query(`SET statement_timeout = '${Number(process.env.SEED_TIMEOUT_MS || 180000)}'`);

  const { rows: before } = await query('SELECT count(*)::int AS c FROM instruments');
  console.log(`  currently         ${before[0].c} row(s)`);

  /**
   * ANALYZE FIRST.
   *
   * After a bulk migration the planner's statistics are empty — pg_class
   * reports reltuples = -1 — so it plans as though the tables held nothing and
   * picks a shape that is catastrophic on 2.9 million rows. The query below
   * takes seconds with statistics and minutes without.
   *
   * autovacuum gets there eventually. "Eventually" is not much use to someone
   * watching a terminal.
   */
  step('analysing tables (stale statistics after a bulk load)…');
  await query('ANALYZE awsat_market_quotes');
  await query('ANALYZE tradingview_watchlist');
  step('done');

  // The broker knows the market; TradingView knows only the symbol. So the
  // broker feed is the primary source and TradingView fills the gaps — a
  // symbol on the watchlist that the broker board never showed is still a real
  // instrument, it just has no market.
  /**
   * Two simple queries, merged here — not one FULL OUTER JOIN of two
   * DISTINCT ONs.
   *
   * Each side alone is an index-only scan the planner handles well. Joining
   * two of them makes a shape it plans badly on cold statistics, and it was
   * the join that hung. Merging 142 rows in JavaScript costs nothing.
   */
  step('reading the broker board…');
  const { rows: awsatRows } = await query(`
    SELECT DISTINCT ON (symbol) symbol, market, code, description
      FROM awsat_market_quotes
     WHERE symbol IS NOT NULL
     ORDER BY symbol, created_at DESC`);
  step(`  ${awsatRows.length} symbol(s)`);

  step('reading the watchlist…');
  const { rows: tvRows } = await query(`
    SELECT DISTINCT ON (symbol) symbol, company_name
      FROM tradingview_watchlist
     WHERE symbol IS NOT NULL
     ORDER BY symbol, created_at DESC`);
  step(`  ${tvRows.length} symbol(s)`);

  const merged = new Map();
  for (const r of awsatRows) {
    merged.set(r.symbol, {
      symbol: r.symbol,
      market: r.market,
      code: r.code,
      description: r.description || null,
      from_awsat: true,
      from_tv: false,
    });
  }
  for (const r of tvRows) {
    const existing = merged.get(r.symbol);
    if (existing) {
      existing.from_tv = true;
      // The broker's description wins where present; the watchlist name fills
      // the gap. Both name the same company, and one of them is usually blank.
      if (!existing.description) existing.description = r.company_name || null;
    } else {
      merged.set(r.symbol, {
        symbol: r.symbol,
        market: null,
        code: null,
        description: r.company_name || null,
        from_awsat: false,
        from_tv: true,
      });
    }
  }
  const candidates = [...merged.values()].sort((x, y) => x.symbol.localeCompare(y.symbol));

  const withMarket = candidates.filter((c) => c.market);
  const both = candidates.filter((c) => c.from_awsat && c.from_tv);
  const tvOnly = candidates.filter((c) => !c.from_awsat);
  const awsatOnly = candidates.filter((c) => !c.from_tv);

  console.log(`  symbols found     ${candidates.length}`);
  console.log(`    on both feeds   ${both.length}`);
  console.log(`    broker only     ${awsatOnly.length}`);
  console.log(`    TradingView only ${tvOnly.length}`);
  console.log(`    with a market   ${withMarket.length}`);

  if (tvOnly.length) {
    console.log(`\n  On the watchlist but never on the broker board:`);
    console.log(`    ${tvOnly.slice(0, 15).map((c) => c.symbol).join(', ')}`
      + (tvOnly.length > 15 ? ` … +${tvOnly.length - 15}` : ''));
    console.log('    These get no market, so /depth-symbols will not sweep them.');
  }

  if (!APPLY) {
    console.log(`\n  Report only — nothing written. Re-run with --apply.\n`);
    return;
  }

  const values = [];
  const tuples = candidates.map((c, i) => {
    values.push(c.market || 'UNKNOWN', c.symbol, c.code || null, c.description || null);
    return `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`;
  });

  step(`writing ${candidates.length} row(s)…`);
  const res = await query(
    `INSERT INTO instruments (market, symbol, code, description)
     VALUES ${tuples.join(', ')}
     ON CONFLICT (symbol) DO UPDATE SET
         market = EXCLUDED.market,
       code = COALESCE(EXCLUDED.code, instruments.code),
       description = COALESCE(EXCLUDED.description, instruments.description),
       last_seen_on = CURRENT_DATE,
       updated_at = now()
     RETURNING symbol`, values);

  console.log(`\n  ${res.rowCount} row(s) written.`);
  const { rows: after } = await query(
    `SELECT market, count(*)::int AS c FROM instruments GROUP BY market ORDER BY market`);
  for (const r of after) console.log(`    ${String(r.market).padEnd(18)} ${r.c}`);
  console.log('');
  log.info('instruments seeded', { symbols: res.rowCount });
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(`\n  failed: ${err.message}\n`); process.exit(1); });

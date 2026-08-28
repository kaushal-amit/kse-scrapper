'use strict';
/**
 * scripts/fix-markets.js — remove rows from markets we do not collect.
 *
 *   node scripts/fix-markets.js              report only
 *   node scripts/fix-markets.js --apply
 *
 * The auction book carries the SAME symbols at the SAME instants as the main
 * board, so migrating it produced one observation recorded twice: 6,265 rows
 * colliding on (symbol, created_at) while satisfying the unique key, which
 * includes market.
 *
 * Deleting them is safe in a way that deduplicating by value is NOT: an
 * auction row is a market we never intended to collect, whereas two captures
 * of the main board twenty seconds apart are two real looks at a moving book.
 */

const { query } = require('../src/db/pool');

const APPLY = process.argv.includes('--apply');
const KEEP = (process.env.AWSAT_KEEP_MARKETS || 'Premier Market,Main Market')
  .split(',').map((m) => m.trim()).filter(Boolean);

const fmt = (n) => Number(n).toLocaleString();

async function main() {
  console.log(`\n  MARKET CLEANUP  ${APPLY ? '(APPLY)' : '(report only)'}`);
  console.log(`  keeping: ${KEEP.join(', ')}`);
  console.log(`  ${'─'.repeat(70)}`);

  const { rows: before } = await query(
    'SELECT market, count(*)::int AS c FROM awsat_market_quotes GROUP BY market ORDER BY 2 DESC');
  for (const r of before) {
    const keep = KEEP.includes(r.market);
    console.log(`    ${String(r.market).padEnd(20)} ${fmt(r.c).padStart(10)}`
      + (keep ? '' : '   <-- to remove'));
  }

  const { rows: dupBefore } = await query(`
    SELECT COALESCE(sum(n - 1), 0)::int AS extra FROM (
      SELECT count(*) AS n FROM awsat_market_quotes
       GROUP BY symbol, created_at HAVING count(*) > 1) g`);
  console.log(`\n    same-instant collisions now: ${fmt(dupBefore[0].extra)}`);

  if (!APPLY) {
    console.log('\n  Report only — nothing deleted. Re-run with --apply.\n');
    return;
  }

  const { rowCount } = await query(
    'DELETE FROM awsat_market_quotes WHERE NOT (market = ANY($1))', [KEEP]);
  console.log(`\n    deleted ${fmt(rowCount)} row(s)`);

  const { rows: dupAfter } = await query(`
    SELECT COALESCE(sum(n - 1), 0)::int AS extra FROM (
      SELECT count(*) AS n FROM awsat_market_quotes
       GROUP BY symbol, created_at HAVING count(*) > 1) g`);
  console.log(`    same-instant collisions after: ${fmt(dupAfter[0].extra)}`);

  if (Number(dupAfter[0].extra) > 0) {
    console.log('\n    Some collisions remain and are NOT auction rows. Investigate');
    console.log('    before deleting anything else — two captures of the same board');
    console.log('    seconds apart are two real observations, not a duplicate.');
  }
  console.log('');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(`\n  failed: ${e.message}\n`); process.exit(1);
});

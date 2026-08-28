'use strict';
/**
 * scripts/fix-market-labels.js — one symbol, one market.
 *
 *   node scripts/fix-market-labels.js              report only
 *   node scripts/fix-market-labels.js --apply
 *
 * ─── WHAT WENT WRONG ───────────────────────────────────────────────────────
 * 6,265 rows record the same symbol at the same second under BOTH Premier and
 * Main. A stock is listed on one market, so one of each pair is the same
 * observation stored twice under different labels.
 *
 * That is the market-switch bug: the board scraper swept a market, failed to
 * switch, swept the same screen again and filed it under the second market's
 * name. It was fixed in August by refusing to store a sweep whose fingerprint
 * matched the previous market — this data predates the fix.
 *
 * ─── HOW THE TRUE MARKET IS DECIDED ────────────────────────────────────────
 * By WEIGHT OF EVIDENCE, not by picking a side. Across the whole history a
 * symbol appears under its real market on nearly every capture and under the
 * wrong one only when the switch failed. So the market it appears under most
 * often is the real one, and the minority label is the artefact.
 *
 * A symbol whose split is close to even is NOT touched: that is not a failed
 * switch, it is something this script does not understand, and deleting on a
 * coin flip would destroy real data.
 */

const { query } = require('../src/db/pool');

const APPLY = process.argv.includes('--apply');
const arg = (n) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split('=')[1] : null;
};
/** How dominant the majority must be before the minority is called an artefact. */
const CONFIDENCE = Number(arg('confidence') || 0.9);

const fmt = (n) => Number(n).toLocaleString();

async function main() {
  console.log(`\n  MARKET LABEL REPAIR  ${APPLY ? '(APPLY)' : '(report only)'}`);
  console.log(`  a symbol is assigned the market it appears under >= ${(CONFIDENCE * 100).toFixed(0)}% of the time`);
  console.log(`  ${'─'.repeat(72)}`);

  /**
   * Find the ACTUAL collisions first, then look at the symbols involved.
   *
   * An earlier version filtered `WHERE market IN ('Premier Market','Main
   * Market')` before grouping, which excluded any row whose market string is
   * not exactly one of those — and then correctly reported nothing while
   * check:data still counted 6,265. Two tools, two definitions of one fact,
   * two answers.
   *
   * So this asks the same question the check asks: which (symbol, created_at)
   * pairs have more than one row, and what markets are they in. Whatever the
   * market values turn out to be, they are found.
   */
  await query(`SET statement_timeout = '${Number(process.env.FIX_TIMEOUT_MS || 300000)}'`);
  console.log('\n  finding collisions…');

  const { rows: colliding } = await query(`
    SELECT symbol,
           count(*)::int AS pairs,
           array_agg(DISTINCT market ORDER BY market) AS markets
      FROM (
        SELECT symbol, created_at, market
          FROM awsat_market_quotes
         WHERE (symbol, created_at) IN (
           SELECT symbol, created_at FROM awsat_market_quotes
            GROUP BY symbol, created_at HAVING count(*) > 1)
      ) c
     GROUP BY symbol
     ORDER BY symbol`);

  if (!colliding.length) {
    console.log('\n  No (symbol, instant) appears more than once. Nothing to repair.\n');
    return;
  }

  console.log(`  ${colliding.length} symbol(s) involved in collisions\n`);

  // For each of those symbols, how its rows are distributed across markets
  // OVERALL — that is what identifies the real market and the artefact.
  const symbols = colliding.map((c) => c.symbol);
  const { rows: split } = await query(`
    SELECT symbol, market, count(*)::int AS n
      FROM awsat_market_quotes
     WHERE symbol = ANY($1)
     GROUP BY symbol, market
     ORDER BY symbol, n DESC`, [symbols]);

  const byMarket = new Map();
  for (const r of split) {
    if (!byMarket.has(r.symbol)) byMarket.set(r.symbol, []);
    byMarket.get(r.symbol).push({ market: r.market, n: r.n });
  }

  console.log(`    ${'symbol'.padEnd(12)}${'distribution'.padEnd(46)}verdict`);

  const decided = [];
  const unclear = [];

  for (const [symbol, markets] of byMarket) {
    const total = markets.reduce((t, m) => t + m.n, 0);
    const sorted = [...markets].sort((a, b) => b.n - a.n);
    const winner = sorted[0];
    const share = winner.n / total;
    const losers = sorted.slice(1);
    const dist = sorted.map((m) => `${m.market} ${fmt(m.n)}`).join(' · ');

    if (markets.length < 2) continue;

    if (share >= CONFIDENCE) {
      decided.push({
        symbol,
        keep: winner.market,
        drop: losers.map((l) => l.market),
        minority: total - winner.n,
        share,
      });
      console.log(`    ${symbol.padEnd(12)}${dist.padEnd(46)}`
        + `keep ${winner.market.split(' ')[0]} (${(share * 100).toFixed(1)}%)`);
    } else {
      unclear.push({ symbol, share, dist });
      console.log(`    ${symbol.padEnd(12)}${dist.padEnd(46)}TOO CLOSE — skipped`);
    }
  }

  const toDelete = decided.reduce((t, d) => t + d.minority, 0);
  console.log(`\n    ${decided.length} decided, removing ${fmt(toDelete)} minority row(s)`);
  if (unclear.length) {
    console.log(`    ${unclear.length} too close to call — LEFT ALONE:`);
    console.log(`      ${unclear.map((u) => `${u.symbol} ${(u.share * 100).toFixed(0)}%`).join(', ')}`);
    console.log('      An even split is not a failed switch. Investigate before deleting.');
  }

  if (!APPLY) {
    console.log('\n  Report only — nothing deleted. Re-run with --apply.\n');
    return;
  }

  let deleted = 0;
  for (const d of decided) {
    const { rowCount } = await query(
      'DELETE FROM awsat_market_quotes WHERE symbol = $1 AND market = ANY($2)',
      [d.symbol, d.drop]);
    deleted += rowCount;
  }

  const { rows: after } = await query(`
    SELECT COALESCE(sum(n - 1), 0)::int AS extra FROM (
      SELECT count(*) AS n FROM awsat_market_quotes
       GROUP BY symbol, created_at HAVING count(*) > 1) g`);

  console.log(`\n    deleted ${fmt(deleted)} row(s)`);
  console.log(`    same-instant collisions remaining: ${fmt(after[0].extra)}`);
  if (Number(after[0].extra) > 0) {
    console.log('    (the skipped symbols above account for these)');
  }
  console.log('');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(`\n  failed: ${e.message}\n`); process.exit(1);
});

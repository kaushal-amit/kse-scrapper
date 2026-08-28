'use strict';
/**
 * scripts/check-data.js — what is actually wrong with what we hold.
 *
 *   node scripts/check-data.js
 *
 * READ ONLY. Answers the questions that came out of the 26 August review,
 * measuring rather than assuming — the duplicate figure in particular has
 * already changed meaning twice depending on which key it was counted on.
 */

const { query } = require('../src/db/pool');

const head = (t) => console.log(`\n  ${t}\n  ${'─'.repeat(70)}`);
const fmt = (n) => Number(n).toLocaleString();

async function main() {
  const { rows: who } = await query('SELECT current_database() AS db');
  console.log(`\n  DATA CHECK — ${who[0].db}`);

  // ── 1 · duplicates, on every key they could plausibly be counted on ──
  head('AWSAT QUOTES — duplicates by key');
  const keys = [
    ['the UNIQUE constraint', 'market, symbol, created_at, ingest_source'],
    ['without ingest_source', 'market, symbol, created_at'],
    ['symbol + exact instant', 'symbol, created_at'],
    ['symbol + MINUTE', "symbol, date_trunc('minute', created_at)"],
  ];
  for (const [label, cols] of keys) {
    const { rows } = await query(`
      SELECT count(*)::int AS keys, COALESCE(sum(n - 1), 0)::int AS extra
        FROM (SELECT ${cols}, count(*) AS n FROM awsat_market_quotes
               GROUP BY ${cols} HAVING count(*) > 1) g`);
    const r = rows[0];
    console.log(`    ${label.padEnd(24)} ${String(fmt(r.keys)).padStart(9)} key(s), `
      + `${fmt(r.extra).padStart(9)} extra row(s)`);
  }
  console.log('\n    A repeat within a MINUTE is not necessarily a duplicate: the');
  console.log('    scraper captures more than once a minute and the book moves.');
  console.log('    Only rows identical in VALUE are truly redundant:');

  const { rows: identical } = await query(`
    SELECT count(*)::int AS keys, COALESCE(sum(n - 1), 0)::int AS extra
      FROM (
        SELECT symbol, date_trunc('minute', created_at) AS m,
               last_price, bid, bid_qty, offer, offer_qty, volume, trades,
               count(*) AS n
          FROM awsat_market_quotes
         GROUP BY 1,2,3,4,5,6,7,8,9 HAVING count(*) > 1) g`);
  console.log(`    ${'identical in value'.padEnd(24)} `
    + `${String(fmt(identical[0].keys)).padStart(9)} group(s), `
    + `${fmt(identical[0].extra).padStart(9)} redundant row(s)`);

  // Same symbol at the same instant means two MARKETS — the UNIQUE key
  // includes market, so these satisfy it while still being one observation
  // recorded twice. Naming the markets involved turns a count into a cause.
  const { rows: pairs } = await query(`
    SELECT markets, count(*)::int AS n FROM (
      SELECT string_agg(DISTINCT market, ' + ' ORDER BY market) AS markets
        FROM awsat_market_quotes
       GROUP BY symbol, created_at HAVING count(*) > 1
    ) g GROUP BY markets ORDER BY 2 DESC`);
  if (pairs.length) {
    console.log('\n    Same-instant collisions are between these markets:');
    for (const p2 of pairs) console.log(`      ${String(p2.markets).padEnd(34)} ${fmt(p2.n)}`);
    const auction = pairs.filter((x) => /Auction/i.test(x.markets))
      .reduce((t, x) => t + x.n, 0);
    if (auction) {
      console.log(`\n      ${fmt(auction)} of them involve the Auction Market, which`);
      console.log('      should not have been migrated: the spec is Premier + Main.');
      console.log('      Remove with:  npm run fix:markets -- --apply');
    }
  }

  // ── 2 · markets ──
  head('MARKETS');
  const { rows: mk } = await query(
    'SELECT market, count(*)::int AS c FROM awsat_market_quotes GROUP BY market ORDER BY 2 DESC');
  for (const m of mk) {
    const raw = /^[A-Z]$/i.test(String(m.market).trim());
    console.log(`    ${String(m.market).padEnd(20)} ${fmt(m.c).padStart(10)}`
      + (raw ? '   <-- RAW MARKET_ID, not a name' : ''));
  }

  // ── 3 · the reference table ──
  head('REFERENCE');
  const { rows: inst } = await query('SELECT count(*)::int AS c FROM instruments');
  const { rows: syms } = await query(
    'SELECT count(DISTINCT symbol)::int AS c FROM awsat_market_quotes');
  const { rows: tvs } = await query(
    'SELECT count(DISTINCT symbol)::int AS c FROM tradingview_watchlist');
  console.log(`    instruments          ${fmt(inst[0].c).padStart(10)}`
    + (inst[0].c === 0 ? '   <-- EMPTY: run npm run seed:instruments' : ''));
  console.log(`    symbols in quotes    ${fmt(syms[0].c).padStart(10)}`);
  console.log(`    symbols on watchlist ${fmt(tvs[0].c).padStart(10)}`);

  // ── 3b · the ownership mapping ──
  //
  // Three states, and only the middle one is a gap:
  //
  //   columns missing    migration 025 has not run — the pre-flight catches it
  //   columns all NULL   the DATA file has not run  <- this one
  //   partly filled      normal; 74 of ~144 symbols are in the lists
  //
  // The middle state is silent otherwise: every query grouping by owner_group
  // returns NULLs and looks like a market with no ownership structure.
  const { rows: gcols } = await query(
    `SELECT count(*)::int AS c FROM information_schema.columns
      WHERE table_name = 'instruments' AND column_name = 'owner_group'`);

  if (gcols[0].c === 0) {
    console.log(`    ${'owner_group'.padEnd(20)} ${'column missing'.padStart(10)}`
      + '   <-- run: node src/db/migrate.js --to=<this database>');
  } else {
    const { rows: g } = await query(
      `SELECT count(*)::int AS total,
              count(owner_group)::int AS grouped,
              (SELECT count(*)::int FROM instrument_stake) AS stakes
         FROM instruments`);
    const { total, grouped, stakes } = g[0];
    console.log(`    ${'owner_group'.padEnd(20)} ${fmt(grouped).padStart(10)} of ${fmt(total)}`
      + `   stakes ${fmt(stakes)}`);
    if (total > 0 && grouped === 0) {
      console.log('      <-- the COLUMNS exist and are EMPTY: the data file has not run.');
      console.log('          psql <this database> -1 -f sql/groups_mapping.sql');
      console.log('          Until then every query grouping by owner_group returns NULL,');
      console.log('          which looks like a market with no ownership structure.');
    }
  }

  // ── 4 · has anything actually run here ──
  head('ACTIVITY');
  const { rows: runs } = await query('SELECT count(*)::int AS c FROM scrape_runs');
  const { rows: subs } = await query('SELECT count(*)::int AS c FROM client_submissions');
  const { rows: latest } = await query(
    'SELECT max(created_at) AS q FROM awsat_market_quotes');
  /**
   * Rows stuck at RUNNING.
   *
   * finishRun() is called in the catch, not in a finally — so a process killed
   * mid-job, or a container restart, leaves a row that was started and never
   * closed. That is a BETTER signal than no trace at all: the row itself says
   * something died. It just needs something to look.
   */
  const { rows: stuck } = await query(`
    SELECT scraper, count(*)::int AS n, min(started_at) AS oldest
      FROM scrape_runs
     WHERE status = 'RUNNING' AND finished_at IS NULL
       AND started_at < now() - interval '10 minutes'
     GROUP BY scraper ORDER BY 2 DESC`);
  if (stuck.length) {
    console.log('\n    STUCK AT RUNNING for over 10 minutes — a process died mid-job:');
    for (const r of stuck) {
      console.log(`      ${String(r.scraper).padEnd(20)} ${r.n} run(s), oldest `
        + new Date(r.oldest).toISOString());
    }
  }

  console.log(`    scrape_runs          ${fmt(runs[0].c).padStart(10)}`
    + (runs[0].c === 0 ? '   <-- no job has ever run against THIS database' : ''));
  console.log(`    client_submissions   ${fmt(subs[0].c).padStart(10)}`);
  console.log(`    newest quote         ${latest[0].q ? new Date(latest[0].q).toISOString() : 'none'}`);
  if (runs[0].c === 0 && Number(syms[0].c) > 0) {
    console.log('\n    Quotes are present but no run is logged, which means they were');
    console.log('    MIGRATED, not scraped here. The live scrapers are still writing');
    console.log('    somewhere else.');
  }

  // ── 5 · depth coverage ──
  head('DEPTH COVERAGE');
  const { rows: d } = await query(`
    SELECT count(DISTINCT symbol)::int AS symbols, max(level)::int AS deepest,
           count(*) FILTER (WHERE bid_orders IS NOT NULL)::int AS with_orders,
           min(trading_date)::text AS lo, max(trading_date)::text AS hi
      FROM awsat_stock_depth`);
  console.log(`    symbols              ${fmt(d[0].symbols).padStart(10)}`);
  console.log(`    deepest level        ${String(d[0].deepest ?? 0).padStart(10)}`
    + (Number(d[0].deepest) <= 1 ? '   <-- level 1 only: the ladder path never ran' : ''));
  console.log(`    rows with orders     ${fmt(d[0].with_orders).padStart(10)}`);
  console.log(`    span                 ${d[0].lo} .. ${d[0].hi}`);

  console.log('\n');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(`\n  failed: ${e.message}\n`); process.exit(1);
});

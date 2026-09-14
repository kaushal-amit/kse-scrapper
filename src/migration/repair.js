'use strict';
/**
 * src/migration/repair.js — everything that must happen AFTER rows land.
 *
 * ─── WHY THIS IS A MODULE AND NOT THREE SCRIPTS ────────────────────────────
 * check-data and fix-market-labels once asked the same question two different
 * ways and gave contradictory answers: one reported 6,265 collisions while the
 * other reported none. Both were "working". The disagreement was the bug.
 *
 * So every fact about migrated data is defined ONCE, here, and the migration,
 * the checker and the repair tool all call it. Two definitions of one fact is
 * how a system ends up unable to say what is true about itself.
 */

const { query } = require('../db/pool');
const log = require('../logger');

const KEEP_MARKETS = (process.env.AWSAT_KEEP_MARKETS || 'Premier Market,Main Market')
  .split(',').map((m) => m.trim()).filter(Boolean);

/** How dominant a market must be before the minority is called an artefact. */
const LABEL_CONFIDENCE = Number(process.env.LABEL_CONFIDENCE || 0.9);

/**
 * Statistics, before anything else reads these tables.
 *
 * A bulk load leaves pg_class reporting reltuples = -1 — the planner treats a
 * 1.9-million-row table as empty and picks a plan that is catastrophic at real
 * scale. It turned a two-second query into a five-minute one. autovacuum gets
 * there eventually; eventually is after whoever runs the next command has
 * given up.
 */
async function analyse(tables) {
  for (const t of tables) {
    await query(`ANALYZE ${t}`).catch((err) => {
      log.warn('analyze failed', { table: t, err: err.message });
    });
  }
  return { analysed: tables.length };
}

/**
 * Which (symbol, instant) pairs hold more than one row, and in which markets.
 *
 * THE single definition. Asked by looking at what actually collides, not by
 * filtering to expected market names first — filtering before grouping is what
 * made the repair tool blind to the very rows the checker was counting.
 */
async function findCollisions() {
  const { rows } = await query(`
    SELECT symbol,
           count(*)::int AS rows_involved,
           array_agg(DISTINCT market ORDER BY market) AS markets,
           -- F-11 · the DAYS on which the collision actually happened. The
           -- repair is scoped to these; see repairMarketLabels.
           array_agg(DISTINCT trading_date ORDER BY trading_date) AS collision_days
      FROM (
        SELECT symbol, created_at, market, trading_date
          FROM awsat_market_quotes
         WHERE (symbol, created_at) IN (
           SELECT symbol, created_at FROM awsat_market_quotes
            GROUP BY symbol, created_at HAVING count(*) > 1)
      ) c
     GROUP BY symbol ORDER BY symbol`);
  return rows;
}

async function collisionCount() {
  const { rows } = await query(`
    SELECT COALESCE(sum(n - 1), 0)::int AS extra FROM (
      SELECT count(*) AS n FROM awsat_market_quotes
       GROUP BY symbol, created_at HAVING count(*) > 1) g`);
  return Number(rows[0].extra);
}

/**
 * One symbol, one market.
 *
 * A stock is listed on one market, so a symbol recorded under two at the same
 * instant is one observation stored twice — the signature of a board sweep
 * that failed to switch markets and re-read the previous screen.
 *
 * The real market is decided by WEIGHT OF EVIDENCE: across the whole history a
 * symbol appears under its true market on nearly every capture, and under the
 * wrong one only when the switch failed. A symbol whose split is close to even
 * is left alone — that is not a failed switch, it is something this does not
 * understand, and deleting on a coin flip destroys real data.
 */
async function repairMarketLabels({ apply = false, confidence = LABEL_CONFIDENCE } = {}) {
  const colliding = await findCollisions();
  if (!colliding.length) return { symbols: 0, decided: [], unclear: [], deleted: 0 };

  const symbols = colliding.map((c) => c.symbol);
  const daysBySymbol = new Map(colliding.map((c) => [
    /*
     * A `date` now arrives as the text Postgres sent (src/db/pool.js), so this
     * is a slice rather than a conversion.
     *
     * It was `d.toISOString().slice(0, 10)` on a Date — and node-postgres
     * parses a bare `date` at LOCAL midnight, so under TZ=Asia/Kuwait every
     * colliding day shifted back one. THIS ARRAY SCOPES A DELETE. The
     * `trading_date = ANY($3)` clause F-11 added to stop this tool destroying
     * sessions that were never in question became the clause that selected
     * them: --apply deleted the uncontested session BEFORE the collision, left
     * the collision itself in place, and reported success.
     */
    c.symbol, (c.collision_days || []).map((d) => (d instanceof Date
      ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      : String(d).slice(0, 10))),
  ]));

  /*
   * F-11 · THE SPLIT IS MEASURED ON THE COLLIDING DAYS ONLY.
   *
   * It used to be measured over the symbol's LIFETIME, which is the wrong
   * denominator for a symbol that genuinely CHANGED market — the case
   * 026_instruments_symbol_pk.sql documents by name ("DALQANRE x2 same company,
   * market changed Main -> Auction").
   *
   * Concretely: 95,000 rows under Main, 3,000 under Auction after a real move,
   * and ONE botched sweep during the transition week producing a single
   * same-instant duplicate. The lifetime share is 0.969, over the 0.9
   * threshold, so every one of the 3,000 Auction rows was deleted — including
   * every session that never collided. The whole record of the period the stock
   * traded on the auction market, destroyed on the evidence of one bad sweep.
   *
   * On the colliding days the split is what it should be: a sweep that failed
   * to switch screens shows the wrong market a handful of times against the
   * right one many times, ON THOSE DAYS.
   */
  const { rows: split } = await query(`
    SELECT q.symbol, q.market, count(*)::int AS n
      FROM awsat_market_quotes q
      JOIN (SELECT DISTINCT symbol, trading_date
              FROM awsat_market_quotes
             WHERE (symbol, created_at) IN (
               SELECT symbol, created_at FROM awsat_market_quotes
                GROUP BY symbol, created_at HAVING count(*) > 1)) d
        ON d.symbol = q.symbol AND d.trading_date = q.trading_date
     WHERE q.symbol = ANY($1)
     GROUP BY q.symbol, q.market ORDER BY q.symbol, n DESC`, [symbols]);

  const byMarket = new Map();
  for (const r of split) {
    if (!byMarket.has(r.symbol)) byMarket.set(r.symbol, []);
    byMarket.get(r.symbol).push({ market: r.market, n: r.n });
  }

  const decided = [];
  const unclear = [];
  for (const [symbol, markets] of byMarket) {
    if (markets.length < 2) continue;
    const total = markets.reduce((t, m) => t + m.n, 0);
    const sorted = [...markets].sort((a, b) => b.n - a.n);
    const share = sorted[0].n / total;
    const entry = {
      symbol,
      keep: sorted[0].market,
      drop: sorted.slice(1).map((l) => l.market),
      minority: total - sorted[0].n,
      share,
      // The days the repair is allowed to touch. Everything outside them is a
      // session that never collided and is not this tool's business.
      days: daysBySymbol.get(symbol) || [],
      distribution: sorted.map((m) => `${m.market} ${m.n}`).join(' · '),
    };
    if (share >= confidence) decided.push(entry); else unclear.push(entry);
  }

  let deleted = 0;
  if (apply) {
    for (const d of decided) {
      // Scoped to the colliding days. `trading_date = ANY($3)` is what stops
      // this destroying sessions that were never in question.
      const { rowCount } = await query(
        'DELETE FROM awsat_market_quotes WHERE symbol = $1 AND market = ANY($2) AND trading_date = ANY($3)',
        [d.symbol, d.drop, d.days]);
      deleted += rowCount;
    }
  }

  return { symbols: byMarket.size, decided, unclear, deleted };
}

/** Rows from markets we do not collect. Separate from a label collision. */
async function removeUnwantedMarkets({ apply = false } = {}) {
  const { rows: present } = await query(
    'SELECT market, count(*)::int AS c FROM awsat_market_quotes GROUP BY market');
  const unwanted = present.filter((r) => !KEEP_MARKETS.includes(r.market));
  const rows = unwanted.reduce((t, u) => t + u.c, 0);
  if (!apply || !rows) return { markets: unwanted, rows, deleted: 0 };

  const { rowCount } = await query(
    'DELETE FROM awsat_market_quotes WHERE NOT (market = ANY($1))', [KEEP_MARKETS]);
  return { markets: unwanted, rows, deleted: rowCount };
}

/**
 * The symbol registry, derived from what both feeds actually saw.
 *
 * It matters more than it looks: /depth-symbols JOINs on instruments.market,
 * so an empty registry serves an EMPTY sweep list and the client silently
 * falls back to its hardcoded names. Nothing errors; the system just covers
 * less than it appears to.
 *
 * Two simple queries rather than one FULL OUTER JOIN of two DISTINCT ONs —
 * each side alone is an index scan the planner handles well, and the join is
 * the shape that hung on cold statistics.
 */
async function seedInstruments({ apply = false } = {}) {
  const { rows: awsatRows } = await query(`
    SELECT DISTINCT ON (symbol) symbol, market, code, description
      FROM awsat_market_quotes WHERE symbol IS NOT NULL
     ORDER BY symbol, created_at DESC`);
  const { rows: tvRows } = await query(`
    SELECT DISTINCT ON (symbol) symbol, company_name
      FROM tradingview_watchlist WHERE symbol IS NOT NULL
     ORDER BY symbol, created_at DESC`);

  const merged = new Map();
  for (const r of awsatRows) {
    merged.set(r.symbol, {
      symbol: r.symbol, market: r.market, code: r.code,
      description: r.description || null, fromAwsat: true, fromTv: false,
    });
  }
  for (const r of tvRows) {
    const e = merged.get(r.symbol);
    if (e) {
      e.fromTv = true;
      if (!e.description) e.description = r.company_name || null;
    } else {
      merged.set(r.symbol, {
        symbol: r.symbol, market: null, code: null,
        description: r.company_name || null, fromAwsat: false, fromTv: true,
      });
    }
  }

  const candidates = [...merged.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
  const noMarket = candidates.filter((c) => !c.market);
  if (!apply) return { candidates: candidates.length, noMarket, written: 0 };
  if (!candidates.length) return { candidates: 0, noMarket, written: 0 };

  const values = [];
  const tuples = candidates.map((c, i) => {
    values.push(c.market || 'UNKNOWN', c.symbol, c.code || null, c.description || null);
    return `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`;
  });
  const res = await query(
    `INSERT INTO instruments (market, symbol, code, description)
     VALUES ${tuples.join(', ')}
     ON CONFLICT (symbol) DO UPDATE SET
         market = EXCLUDED.market,
       code = COALESCE(EXCLUDED.code, instruments.code),
       description = COALESCE(EXCLUDED.description, instruments.description),
       last_seen_on = CURRENT_DATE, updated_at = now()`, values);

  return { candidates: candidates.length, noMarket, written: res.rowCount };
}

/**
 * What is wrong with what we now hold.
 *
 * Returns findings rather than printing them, so the migration, the checker
 * and any future caller all report the same facts in their own format.
 */
async function integrityReport() {
  const findings = [];

  const collisions = await collisionCount();
  if (collisions > 0) {
    findings.push({
      level: 'error',
      what: `${collisions} same-instant collision(s)`,
      why: 'one symbol recorded under two markets at the same second',
      fix: 'node scripts/fix-market-labels.js --apply',
    });
  }

  const { rows: raw } = await query(`
    SELECT count(*)::int AS c FROM awsat_market_quotes
     WHERE market ~ '^[A-Za-z]$'`);
  if (raw[0].c > 0) {
    findings.push({
      level: 'error',
      what: `${raw[0].c} row(s) with a single-letter market`,
      why: 'a raw MARKET_ID that escaped the name map',
      fix: "UPDATE or DELETE; 'B' is the auction market",
    });
  }

  const { rows: unwanted } = await query(
    'SELECT market, count(*)::int AS c FROM awsat_market_quotes WHERE NOT (market = ANY($1)) GROUP BY market',
    [KEEP_MARKETS]);
  for (const u of unwanted) {
    findings.push({
      level: 'warn',
      what: `${u.c} row(s) in ${u.market}`,
      why: 'a market outside AWSAT_KEEP_MARKETS',
      fix: 'node scripts/fix-markets.js --apply',
    });
  }

  const { rows: inst } = await query('SELECT count(*)::int AS c FROM instruments');
  if (inst[0].c === 0) {
    findings.push({
      level: 'error',
      what: 'instruments is empty',
      why: '/depth-symbols JOINs on it — an empty registry serves an empty sweep list',
      fix: 'node scripts/seed-instruments.js --apply',
    });
  }

  const { rows: orders } = await query(
    'SELECT count(*)::int AS total, count(order_status)::int AS with_status FROM awsat_order_list');
  if (orders[0].total > 0 && orders[0].with_status < orders[0].total) {
    findings.push({
      level: 'warn',
      what: `${orders[0].total - orders[0].with_status} order(s) with no status`,
      why: 'the source keeps it in raw.ordSts, not the column',
      fix: 're-run --only=orders --apply',
    });
  }

  const { rows: runs } = await query('SELECT count(*)::int AS c FROM scrape_runs');
  const { rows: q } = await query('SELECT count(*)::int AS c FROM awsat_market_quotes');
  if (runs[0].c === 0 && q[0].c > 0) {
    findings.push({
      level: 'warn',
      what: 'quotes present but scrape_runs empty',
      why: 'these rows were migrated, not scraped here — the live scrapers write elsewhere',
      fix: 'decide which database is authoritative before the next session',
    });
  }

  return findings;
}

module.exports = {
  analyse, findCollisions, collisionCount, repairMarketLabels,
  removeUnwantedMarkets, seedInstruments, integrityReport,
  KEEP_MARKETS, LABEL_CONFIDENCE,
};

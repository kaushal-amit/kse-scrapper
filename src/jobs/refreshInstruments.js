'use strict';
/**
 * src/jobs/refreshInstruments.js — registry maintenance, not analytics.
 *
 *   npm run run:once -- daily.instruments
 *
 * Runs BEFORE daily.symbolday so the day's rows are computed against a correct
 * registry rather than yesterday's. Its own job because a registry problem
 * should not fail the day's compute.
 *
 * ─── WHAT IT DECIDES, AND WHAT IT DOES NOT ─────────────────────────────────
 * is_primary only. That flag drives behaviour — /depth-symbols must not offer a
 * slot to a phantom, and market_day's denominator must not count one — so it
 * must never be stale, which means it must be computed rather than remembered.
 *
 * superseded_by is NOT touched. Inferring supersession from missing quotes
 * would eventually mark a genuinely suspended stock as superseded by an
 * unrelated one sharing a code: a silent wrong answer, which is worse than a
 * stale one. It stays a human judgement, and an empty one means the history is
 * incomplete rather than that screening is broken.
 */

const { query } = require('../db/pool');
const log = require('../logger');

/**
 * ACTIVITY FIRST, RECENCY SECOND.
 *
 * A symbol with no quotes at all is never primary. That rule alone catches
 * KFIN — one row, one day, price 0, volume 0 — without any recency comparison,
 * and it does not depend on the misparse being recent.
 *
 * Recency only breaks ties among symbols that have actually traded, which is
 * where it means something: the newer of two live tickers on one code is the
 * current one.
 */
async function computePrimary() {
  const { rows } = await query(`
    WITH activity AS (
      SELECT i.symbol,
             i.code,
             i.is_primary AS was_primary,
             i.superseded_by,
             i.broker_status,
             COALESCE(q.n, 0)::bigint AS quote_rows,
             q.last_quote
        FROM instruments i
        LEFT JOIN LATERAL (
          SELECT count(*) AS n, max(trading_date) AS last_quote
            FROM awsat_market_quotes q WHERE q.symbol = i.symbol
        ) q ON true
    ),
    ranked AS (
      SELECT *,
             row_number() OVER (
               PARTITION BY COALESCE(code, symbol)
               ORDER BY
                 -- An explicit human judgement outranks any measurement. It
                 -- must not COMPETE in a ranking it can lose.
                 (superseded_by IS NOT NULL) ASC,
                 -- Traded beats untraded.
                 (quote_rows > 0) DESC,
                 -- THE LAST QUOTE, not instruments.last_seen_on.
                 --
                 -- last_seen_on is a registry artifact: the seeder wrote
                 -- 2026-08-26 on all 142 rows, so it never discriminated and
                 -- the ranking fell through to alphabetical order. KPPC sorts
                 -- before PHC, so the ticker that was RENAMED AWAY won its own
                 -- code and PHC — 1,845 quote rows to 25 August — was demoted.
                 last_quote DESC NULLS LAST,
                 quote_rows DESC,
                 symbol ASC
             ) AS rn
        FROM activity
    )
    SELECT symbol, code, quote_rows, last_quote, was_primary, superseded_by,
           broker_status,
           -- A symbol that has never traded is never primary, even alone under
           -- its code: a phantom with no competitor is still a phantom.
           --
           -- EXCEPT A DELISTED ONE. Delisted means it traded and then stopped —
           -- the opposite of a phantom that never existed. is_primary filters
           -- symbol_day, so demoting it would delete its history from every
           -- query.
           --
           -- And NEVER a superseded one, whatever it measures.
           (superseded_by IS NULL
            AND (broker_status = 'DELISTED' OR (rn = 1 AND quote_rows > 0))) AS should_be_primary
      FROM ranked ORDER BY code NULLS LAST, symbol`);
  return rows;
}

/**
 * REFUSE TO WRITE A CONTRADICTION.
 *
 * ─── PROPOSAL, ASSERT, THEN WRITE ──────────────────────────────────────────
 * A job that writes a contradiction and then complains has already done the
 * damage: the next consumer reads the bad state whether or not anyone saw the
 * log. So the flags are computed, checked, and only then stored — and on abort
 * the previous flags stand, because a stale correct flag beats a fresh wrong
 * one.
 *
 * THE RULE, stated generally: on any code, the primary symbol must not be less
 * recently active than a non-primary symbol on the same code.
 *
 * The narrow version — "CAPTURED non-primary while ABSENT primary" — would have
 * caught the KPPC case and nothing else. A narrow assertion that passes while
 * is_primary is wrong in an unpredicted way is the worse outcome, and that is
 * exactly what the count-based checkpoint did: 142 · 140 · 139 was right while
 * the rows were inverted.
 */
function findContradictions(proposal) {
  const byCode = new Map();
  for (const r of proposal) {
    const key = r.code || r.symbol;
    if (!byCode.has(key)) byCode.set(key, []);
    byCode.get(key).push(r);
  }

  const problems = [];
  for (const [code, members] of byCode) {
    if (members.length < 2) continue;
    const primary = members.filter((m) => m.should_be_primary);
    const others = members.filter((m) => !m.should_be_primary);
    if (!primary.length || !others.length) continue;

    for (const p of primary) {
      // A DELISTED symbol is deliberately primary despite being stale — it
      // kept its history on purpose, so it is not a contradiction.
      if (p.broker_status === 'DELISTED') continue;
      for (const o of others) {
        if (!o.last_quote) continue;
        if (!p.last_quote || new Date(o.last_quote) > new Date(p.last_quote)) {
          problems.push({ code, primary: p, stalerThan: o });
        }
      }
    }
  }
  return problems;
}

async function refreshMarkets() {
  const { rows } = await query(`
    WITH latest AS (
      SELECT DISTINCT ON (symbol) symbol, market, trading_date
        FROM awsat_market_quotes
       WHERE market IS NOT NULL
       ORDER BY symbol, created_at DESC
    )
    UPDATE instruments i
       SET market = l.market,
           market_changed_on = l.trading_date,
           updated_at = now()
      FROM latest l
     WHERE i.symbol = l.symbol AND i.market IS DISTINCT FROM l.market
     RETURNING i.symbol, i.market AS new_market, l.trading_date`);
  for (const r of rows) {
    log.warn('instruments: market changed', {
      symbol: r.symbol, to: r.new_market, on: r.trading_date,
      note: 'only the MOST RECENT transition is retained',
    });
  }
  return rows.length;
}

/**
 * 2 · BROKER STATUS.
 *
 * ─── FIVE SESSIONS WITH DATA, NOT FIVE WITH CLOSES ─────────────────────────
 * ABSENT asks "did the symbol appear at all". computeSymbolDay's reach-back
 * asks "was there a CLOSE" and counts differently — 30 July had quotes for 134
 * symbols and produced zero closes, so it counts here and does not count there.
 *
 * Two rules saying "5 sessions" and counting differently is fine when it is
 * deliberate. It is deliberate. They answer different questions.
 *
 * DELISTED is never set and never cleared here, except by the re-quote flip
 * below. It is a fact about the world, like superseded_by; inferring it from
 * missing quotes would eventually mark a suspended stock as delisted, which is
 * a silent wrong answer rather than a stale one.
 */
async function refreshBrokerStatus(day) {
  const { rows: sessions } = await query(`
    SELECT DISTINCT trading_date FROM awsat_market_quotes
     WHERE trading_date <= $1 ORDER BY trading_date DESC LIMIT 5`, [day]);
  if (!sessions.length) return { changed: [], resumed: [] };
  const cutoff = sessions[sessions.length - 1].trading_date;

  // A DELISTED symbol that starts quoting again. BAREEQ has applied to re-list.
  //
  // Detected HERE and not in the ingest path: ingest sees the same event on
  // every poll and would say so for a whole day. This says it once.
  const { rows: resumed } = await query(`
    UPDATE instruments i
       SET broker_status = 'CAPTURED', broker_status_on = CURRENT_DATE, updated_at = now()
     WHERE i.broker_status = 'DELISTED'
       AND EXISTS (SELECT 1 FROM awsat_market_quotes q
                    WHERE q.symbol = i.symbol AND q.trading_date >= $1
                      AND q.last_price IS NOT NULL AND q.last_price > 0)
     RETURNING i.symbol`, [cutoff]);
  for (const r of resumed) {
    log.warn('instruments: a DELISTED symbol is quoting again', {
      symbol: r.symbol,
      note: 'flipped to CAPTURED. It will now be swept and counted again.',
    });
  }

  const { rows: changed } = await query(`
    WITH seen AS (
      SELECT i.symbol,
             i.broker_status AS was,
             EXISTS (SELECT 1 FROM awsat_market_quotes q
                      WHERE q.symbol = i.symbol AND q.trading_date >= $1) AS recent
        FROM instruments i
       WHERE COALESCE(i.broker_status, '') <> 'DELISTED'
    )
    UPDATE instruments i
       SET broker_status = CASE WHEN s.recent THEN 'CAPTURED' ELSE 'ABSENT' END,
           broker_status_on = CURRENT_DATE,
           updated_at = now()
      FROM seen s
     WHERE i.symbol = s.symbol
       AND i.broker_status IS DISTINCT FROM (CASE WHEN s.recent THEN 'CAPTURED' ELSE 'ABSENT' END)
     RETURNING i.symbol, s.was, i.broker_status AS now_is`, [cutoff]);

  for (const r of changed) {
    log.info('instruments: broker_status changed', {
      symbol: r.symbol, from: r.was || 'unset', to: r.now_is,
      note: r.now_is === 'ABSENT' ? 'no quotes in the last 5 sessions WITH DATA' : undefined,
    });
  }
  return { changed, resumed };
}

/**
 * 5 · TV STATUS.
 *
 * SKIPPED ENTIRELY when the day has no TradingView rows at all. A scraper
 * failure recorded as 142 symbol facts is the same error as marking 141
 * symbols ABSENT during a market-wide outage — it turns one problem into a
 * hundred and forty-two wrong statements.
 */
async function refreshTvStatus(day) {
  const { rows: check } = await query(
    'SELECT count(*)::int AS c FROM tradingview_watchlist WHERE trading_date = $1', [day]);
  if (!check[0].c) {
    log.warn('instruments: no TradingView rows today — tv_status left untouched', {
      day, note: 'a scraper failure is one fact, not 142',
    });
    return { skipped: true, changed: 0 };
  }

  const { rows } = await query(`
    WITH seen AS (
      SELECT i.symbol,
             EXISTS (SELECT 1 FROM tradingview_watchlist t
                      WHERE t.symbol = i.symbol AND t.trading_date = $1) AS present
        FROM instruments i
    )
    UPDATE instruments i
       SET tv_status = CASE WHEN s.present THEN 'CAPTURED' ELSE 'ABSENT' END,
           tv_status_on = CURRENT_DATE, updated_at = now()
      FROM seen s
     WHERE i.symbol = s.symbol
       AND i.tv_status IS DISTINCT FROM (CASE WHEN s.present THEN 'CAPTURED' ELSE 'ABSENT' END)
     RETURNING i.symbol`, [day]);
  return { skipped: false, changed: rows.length };
}

/**
 * 4 · TRADEABLE.
 *
 * Depends on market, broker_status AND is_primary, so it runs last. A symbol is
 * primary but not tradeable for two distinct reasons — auction market, or
 * delisted — and both are correct.
 */
async function refreshTradeable() {
  const { rows } = await query(`
    UPDATE instruments
       SET is_tradeable = (COALESCE(is_primary, true)
                           AND market <> 'Auction Market'
                           AND COALESCE(broker_status, '') <> 'DELISTED'),
           updated_at = now()
     WHERE is_tradeable IS DISTINCT FROM (COALESCE(is_primary, true)
                           AND market <> 'Auction Market'
                           AND COALESCE(broker_status, '') <> 'DELISTED')
     RETURNING symbol, is_tradeable`);
  for (const r of rows) {
    log.warn('instruments: is_tradeable changed', {
      symbol: r.symbol, to: r.is_tradeable,
      note: 'market_day breadth and the depth slots read this',
    });
  }
  return rows.length;
}

async function refresh(runId) {
  const clock = require('../market/clock');
  const day = clock.tradingDay();

  // ORDER MATTERS: is_tradeable reads market, broker_status and is_primary, so
  // it must run after all three.
  const marketsChanged = await refreshMarkets();
  const broker = await refreshBrokerStatus(day);

  const rows = await computePrimary();
  if (!rows.length) {
    log.warn('instruments: registry is empty', { runId });
    return { extracted: 0, inserted: 0, rejected: 0 };
  }

  // ASSERT BEFORE WRITING.
  const contradictions = findContradictions(rows);
  if (contradictions.length) {
    const d = (v) => (v ? new Date(v).toISOString().slice(0, 10) : 'never');
    const lines = contradictions.map((c) =>
      `  code ${c.code}\n`
      + `    ${c.primary.symbol.padEnd(10)} primary=true   last quote ${d(c.primary.last_quote)}`
      + `${c.primary.superseded_by ? `   superseded_by ${c.primary.superseded_by}` : ''}\n`
      + `    ${c.stalerThan.symbol.padEnd(10)} primary=false  last quote ${d(c.stalerThan.last_quote)}`
      + `${c.stalerThan.superseded_by ? `   superseded_by ${c.stalerThan.superseded_by}` : ''}`);

    throw new Error(
      'REFUSING to write — the proposed primary is staler than a non-primary '
      + `symbol on the same code.\n\n${lines.join('\n\n')}\n\n`
      + '  This is the shape of the KPPC/PHC inversion: ranking on last_seen_on, '
      + 'a registry\n  artifact identical across all rows, fell through to '
      + 'alphabetical order and the\n  ticker that had been renamed away won its '
      + 'own code.\n\n  Flags left unchanged. Nothing was written.');
  }

  const changed = rows.filter((r) => r.was_primary !== r.should_be_primary);

  for (const r of changed) {
    await query('UPDATE instruments SET is_primary = $1, updated_at = now() WHERE symbol = $2',
      [r.should_be_primary, r.symbol]);
  }

  // A flag that moves silently is the same failure as one nobody remembers to
  // set — it just moves on its own instead. Every change is named.
  for (const r of changed) {
    log.warn('instruments: is_primary changed', {
      symbol: r.symbol,
      code: r.code,
      from: r.was_primary,
      to: r.should_be_primary,
      quoteRows: Number(r.quote_rows),
      reason: Number(r.quote_rows) === 0 ? 'no quotes at all'
        : r.should_be_primary ? 'most recently seen among traded symbols on this code'
          : 'another symbol on this code was seen more recently',
      supersededBy: r.superseded_by,
    });
  }

  const phantoms = rows.filter((r) => Number(r.quote_rows) === 0);
  if (phantoms.length) {
    log.info('instruments: symbols with no quotes', {
      count: phantoms.length,
      symbols: phantoms.slice(0, 10).map((r) => r.symbol),
      note: 'not primary — they cannot be swept, counted or traded',
    });
  }

  const tv = await refreshTvStatus(day);
  const tradeableChanged = await refreshTradeable();

  const { rows: totals } = await query(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE is_primary)::int AS primary_n,
           count(*) FILTER (WHERE is_tradeable)::int AS tradeable_n
      FROM instruments`);

  log.info('instruments: refreshed', {
    total: totals[0].total,
    primary: totals[0].primary_n,
    tradeable: totals[0].tradeable_n,
    primaryChanged: changed.length,
    marketsChanged,
    brokerStatusChanged: broker.changed.length,
    resumedFromDelisted: broker.resumed.length,
    tvStatusChanged: tv.skipped ? 'skipped' : tv.changed,
    tradeableChanged,
    runId,
  });

  return {
    extracted: totals[0].total,
    inserted: changed.length + marketsChanged + broker.changed.length + tradeableChanged,
    rejected: 0,
  };
}

module.exports = {
  refresh, computePrimary, findContradictions, refreshMarkets, refreshBrokerStatus,
  refreshTvStatus, refreshTradeable,
};

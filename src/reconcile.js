'use strict';
/**
 * Source reconciliation.
 *
 * ─── PRECEDENCE DECIDES THE CANONICAL VALUE, NOT WHAT IS STORED ────────────
 * Every observation is kept. When two collectors see the same board, the row
 * that loses precedence is still written — it just is not the canonical one.
 *
 * That distinction matters. Discarding the loser would throw away the only
 * evidence available when the two disagree, and "which collector was right on
 * the day the numbers looked wrong" is exactly the question worth being able to
 * answer. awsat_market_quotes carries ingest_source in its KEY, so both rows survive,
 * so both observations survive and the canonical view is a query rather than a
 * deletion.
 *
 * Configurable via AWSAT_SOURCE_PRECEDENCE, e.g.
 *     AWSAT_SOURCE_PRECEDENCE=awsat_server:2,awsat_client:1,tradingview:0
 * to trust the server over the client.
 */

const log = require('./logger');

const DEFAULT_PRECEDENCE = {
  // The trader's own authenticated session, reading the socket directly. Fewest
  // moving parts: no separate login to expire, no headless quirks, no eviction.
  awsat_client: 2,
  // Same socket, but through a headless session that can be evicted or stall.
  awsat_server: 1,
  // A different venue's view of the same instruments.
  tradingview: 0,
};

function parsePrecedence(raw) {
  if (!raw) return { ...DEFAULT_PRECEDENCE };

  const out = {};
  for (const part of String(raw).split(',')) {
    const [name, value] = part.split(':').map((x) => (x || '').trim());
    const n = Number(value);
    if (!name || !Number.isInteger(n)) {
      log.warn('ignoring malformed AWSAT_SOURCE_PRECEDENCE entry', { part });
      continue;
    }
    out[name] = n;
  }

  if (!Object.keys(out).length) {
    log.warn('AWSAT_SOURCE_PRECEDENCE parsed to nothing — using defaults', { raw });
    return { ...DEFAULT_PRECEDENCE };
  }

  // A source absent from the override would silently become precedence 0 and
  // could then overwrite a value it should not.
  for (const known of Object.keys(DEFAULT_PRECEDENCE)) {
    if (out[known] === undefined) {
      log.warn('source missing from AWSAT_SOURCE_PRECEDENCE — keeping its default', {
        source: known, precedence: DEFAULT_PRECEDENCE[known],
      });
      out[known] = DEFAULT_PRECEDENCE[known];
    }
  }
  return out;
}

const PRECEDENCE = parsePrecedence(process.env.AWSAT_SOURCE_PRECEDENCE);

function precedenceOf(source) {
  return PRECEDENCE[source] ?? 0;
}

/**
 * SQL for the canonical view: one row per (symbol, minute), highest precedence
 * first, most recent capture breaking a tie.
 *
 * A view rather than a table, so it is always consistent with the observations
 * underneath and cannot drift from them.
 */
function canonicalViewSql() {
  return `
CREATE OR REPLACE VIEW canonical_quotes AS
SELECT DISTINCT ON (symbol, date_trunc('minute', created_at))
       symbol,
       date_trunc('minute', created_at) AS minute,
       market, code, description,
       last_price, chg, pct_chg, volume,
       bid, bid_qty, offer, offer_qty, trades,
       open_price, high_price, low_price, session,
       trading_date, ingest_source, source_precedence, created_at
  FROM awsat_market_quotes
 ORDER BY symbol,
          date_trunc('minute', created_at),
          source_precedence DESC,   -- the trusted collector wins
          created_at DESC;          -- then the freshest observation`;
}

/** Where the two collectors disagree on a value. Reported, never auto-merged. */
function disagreementSql() {
  return `
SELECT a.symbol,
       date_trunc('minute', a.created_at) AS minute,
       a.ingest_source AS source_a, a.last_price AS price_a,
       b.ingest_source AS source_b, b.last_price AS price_b
  FROM awsat_market_quotes a
  JOIN awsat_market_quotes b
    ON a.symbol = b.symbol
   AND date_trunc('minute', a.created_at) = date_trunc('minute', b.created_at)
   AND a.ingest_source < b.ingest_source
 WHERE a.last_price IS DISTINCT FROM b.last_price
 ORDER BY minute DESC
 LIMIT 200`;
}

module.exports = {
  PRECEDENCE, DEFAULT_PRECEDENCE, precedenceOf, parsePrecedence,
  canonicalViewSql, disagreementSql,
};

-- ===========================================================================
--  007_canonical_awsat.sql
--
--  canonical_quotes was built over live_quotes, which migration 005 stopped
--  writing to. It has been returning a frozen snapshot ever since — a view that
--  still answers, with data that stops moving, which is worse than one that
--  errors.
--
--  Rebuilt over awsat_market_quotes, where ingest_source is part of the KEY so
--  both collectors' observations survive and precedence only chooses between
--  them.
-- ===========================================================================

DROP VIEW IF EXISTS canonical_quotes;

CREATE VIEW canonical_quotes AS
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
          created_at DESC;          -- then the freshest observation

COMMENT ON VIEW canonical_quotes IS
  'One AWSAT row per symbol per minute: highest source_precedence wins, '
  'freshest capture breaks ties. Every raw observation stays in '
  'awsat_market_quotes.';

-- ===========================================================================
--  004_canonical_quotes.sql
--
--  A VIEW, not a table. Observations from every collector stay in live_quotes;
--  this picks the canonical one per symbol per minute by precedence, with the
--  freshest capture breaking a tie.
--
--  Deleting the loser would throw away the only evidence available when the two
--  collectors disagree — and "which one was right on the day the numbers looked
--  wrong" is precisely the question worth being able to answer.
-- ===========================================================================

CREATE OR REPLACE VIEW canonical_quotes AS
SELECT DISTINCT ON (symbol, date_trunc('minute', created_at))
       symbol,
       date_trunc('minute', created_at) AS minute,
       market, code, description,
       last_price, chg, pct_chg, volume,
       bid, bid_qty, offer, offer_qty, trades,
       open_price, high_price, low_price, session,
       trading_date, ingest_source, source_precedence, created_at
  FROM live_quotes
 ORDER BY symbol,
          date_trunc('minute', created_at),
          source_precedence DESC,
          created_at DESC;

COMMENT ON VIEW canonical_quotes IS
  'One row per symbol per minute: highest source_precedence wins, freshest '
  'capture breaks ties. Every raw observation remains in live_quotes.';

-- ===========================================================================
--  008_drop_superseded.sql — remove the tables migration 005 replaced
--
--  005 split the shared tables into one per data type and COPIED the rows
--  across, deliberately leaving the originals so the counts could be checked
--  before anything was destroyed. That check has happened; this removes them.
--
--  Two tables kept that might look like candidates, and why:
--
--    instruments        the symbol registry. The history scraper takes its
--                       symbol list from what the live scrapers have actually
--                       seen, so a newly listed stock gets history without a
--                       manual step. Not a duplicate of any quote table.
--
--    client_submissions the idempotency ledger. Holds no market data — it is
--                       what makes a client retry safe, and dropping it would
--                       make every retry insert a second time.
--
--  The compatibility VIEWS from 002 go too. They pointed at tables about to be
--  dropped, so leaving them would leave views that error on use — worse than
--  absent, because the name still resolves.
-- ===========================================================================

-- Views first: they depend on the tables below.
DROP VIEW IF EXISTS market_stock_snapshots;
DROP VIEW IF EXISTS stock_quotes;
DROP VIEW IF EXISTS stock_prices_daily;
DROP VIEW IF EXISTS stock_depth;
DROP VIEW IF EXISTS order_list_snapshots;

-- Superseded by tradingview_watchlist + awsat_market_quotes (005).
DROP TABLE IF EXISTS live_quotes;
-- Superseded by tradingview_history (005).
DROP TABLE IF EXISTS daily_bars;
-- Superseded by awsat_stock_depth (005).
DROP TABLE IF EXISTS order_book_levels;
-- Superseded by awsat_order_list (005).
DROP TABLE IF EXISTS broker_orders;

COMMENT ON TABLE instruments IS
  'Symbol registry: one row per instrument per market. Feeds the history '
  'scraper''s symbol list, so a newly listed stock is picked up automatically.';

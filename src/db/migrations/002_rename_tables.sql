-- ===========================================================================
--  002_rename_tables.sql — names that say what the table holds
--
--  ALTER TABLE ... RENAME, not drop-and-recreate: the data, indexes,
--  constraints and sequences all follow the rename, so nothing collected so
--  far is lost.
--
--    market_stock_snapshots -> instruments
--        It was never snapshots. One row per tradable instrument per market —
--        a registry, updated in place. The old name suggested a time series
--        and invited exactly the confusion it caused.
--
--    stock_quotes           -> live_quotes
--        Intraday quotes captured during the session, from either source.
--        "stock_quotes" did not distinguish it from the daily bars.
--
--    stock_prices_daily     -> daily_bars
--        One OHLCV bar per symbol per day. "prices_daily" read as a variant of
--        stock_quotes; "bars" is what the data actually is.
--
--    stock_depth            -> order_book_levels
--        One row per price level of the book. "depth" is jargon; "levels" says
--        the grain, which is what matters when reading a query.
--
--    order_list_snapshots   -> broker_orders
--        The trader's own orders as the terminal showed them. "order_list"
--        described the screen it was scraped from rather than the contents.
--
--  scrape_runs keeps its name — it already says what it holds.
--
--  NOTE: this diverges from the SPREAD production schema these tables were
--  aligned to. If the backend is ever pointed at this database, it will look
--  for the old names. Views are created below so both work.
-- ===========================================================================

ALTER TABLE IF EXISTS market_stock_snapshots RENAME TO instruments;
ALTER TABLE IF EXISTS stock_quotes           RENAME TO live_quotes;
ALTER TABLE IF EXISTS stock_prices_daily     RENAME TO daily_bars;
ALTER TABLE IF EXISTS stock_depth            RENAME TO order_book_levels;
ALTER TABLE IF EXISTS order_list_snapshots   RENAME TO broker_orders;

-- Constraint names still carry the old table names. PostgreSQL does not rename
-- them with the table, and a constraint violation that reports
-- "stock_quotes_key" against a table called live_quotes is a small mystery at
-- exactly the wrong moment.
ALTER TABLE live_quotes       RENAME CONSTRAINT stock_quotes_key TO live_quotes_key;
ALTER TABLE order_book_levels RENAME CONSTRAINT stock_depth_key  TO order_book_levels_key;
ALTER TABLE broker_orders     RENAME CONSTRAINT ols_key          TO broker_orders_key;

-- ---------------------------------------------------------------------------
-- Compatibility views under the old names.
--
-- Anything already reading the previous names keeps working, and the rename
-- does not have to be coordinated with other services. They are plain views on
-- a single table, so they are updatable — inserts through them still land in
-- the real table.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW market_stock_snapshots AS SELECT * FROM instruments;
CREATE OR REPLACE VIEW stock_quotes           AS SELECT * FROM live_quotes;
CREATE OR REPLACE VIEW stock_prices_daily     AS SELECT * FROM daily_bars;
CREATE OR REPLACE VIEW stock_depth            AS SELECT * FROM order_book_levels;
CREATE OR REPLACE VIEW order_list_snapshots   AS SELECT * FROM broker_orders;

COMMENT ON TABLE instruments       IS 'One row per tradable instrument per market. A registry, not a time series.';
COMMENT ON TABLE live_quotes       IS 'Intraday quotes captured during the session. Insert-only; never revised.';
COMMENT ON TABLE daily_bars        IS 'One OHLCV bar per symbol per day. Upserted, because an exchange can restate a bar.';
COMMENT ON TABLE order_book_levels IS 'One row per price level of the book, per capture.';
COMMENT ON TABLE broker_orders     IS 'The trader''s own orders as the terminal showed them, per capture.';

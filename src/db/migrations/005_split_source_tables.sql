-- ===========================================================================
--  005_split_source_tables.sql — one table per data type, per source group
--
--  Until now TradingView and AWSAT quotes shared live_quotes, separated only by
--  a market label. They are different feeds with different columns, different
--  cadences and different trust, and folding them together meant every query
--  had to remember to filter. This splits them.
--
--    tradingview_watchlist   TradingView board, one row per symbol per capture
--    tradingview_history     intraday history collected during a session and
--                            finalised after the close
--    daily_stock_analysis    per-symbol per-day analytics (DDL as specified)
--    awsat_market_quotes     Main + Premium board, from BOTH collectors
--    awsat_stock_depth       order-book levels, from both collectors
--    awsat_order_list        the trader's own orders, from both collectors
--
--  The three AWSAT tables each carry ingest_source, so server and client rows
--  live side by side and precedence decides the canonical value. Splitting by
--  SOURCE GROUP rather than by collector is deliberate: the two collectors see
--  the same board, so separating them would make reconciliation a join instead
--  of an ordering.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1 · TradingView watchlist — captured every minute
--
-- created_at is supplied by the application for the whole batch, never
-- defaulted: a DEFAULT now() would give every row in one sweep a different
-- timestamp and the key below would deduplicate nothing.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tradingview_watchlist (
  id             bigserial   PRIMARY KEY,
  symbol         text        NOT NULL,
  company_name   text,
  last_price     numeric(18, 4),
  change_value   numeric(18, 4),
  change_pct     numeric(10, 4),
  volume         bigint,
  avg_volume     bigint,
  market_cap     numeric(20, 2),
  trading_date   date        NOT NULL,
  scrape_batch_id uuid,
  run_id         bigint      REFERENCES scrape_runs(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL,

  CONSTRAINT tradingview_watchlist_key UNIQUE (symbol, created_at),
  -- change_value and change_pct are legitimately negative; nothing else is.
  CONSTRAINT tvw_non_negative CHECK (
    (last_price IS NULL OR last_price >= 0)
    AND (volume     IS NULL OR volume     >= 0)
    AND (avg_volume IS NULL OR avg_volume >= 0)
  )
);
CREATE INDEX IF NOT EXISTS tvw_symbol_idx ON tradingview_watchlist (symbol, created_at DESC);
CREATE INDEX IF NOT EXISTS tvw_date_idx   ON tradingview_watchlist (trading_date);

-- ---------------------------------------------------------------------------
-- 2 · TradingView history — finalised after the session closes
--
-- UPSERTed, unlike the watchlist. An exchange can restate a bar after the fact,
-- and the history scraper may run more than once; the watchlist is a live tick
-- log and is never revised. Keeping them apart is what stops a correction
-- overwriting an observation.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tradingview_history (
  symbol       text        NOT NULL,
  trade_date   date        NOT NULL,
  open_price   numeric(18, 4),
  high_price   numeric(18, 4),
  low_price    numeric(18, 4),
  close_price  numeric(18, 4),
  change_value numeric(18, 4),
  change_pct   numeric(10, 4),
  volume       bigint,
  session_finalised_at timestamptz,
  run_id       bigint      REFERENCES scrape_runs(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (symbol, trade_date),
  CONSTRAINT tvh_non_negative CHECK (
    (open_price IS NULL OR open_price >= 0) AND (high_price IS NULL OR high_price >= 0)
    AND (low_price IS NULL OR low_price >= 0) AND (close_price IS NULL OR close_price >= 0)
    AND (volume IS NULL OR volume >= 0)
  ),
  -- high must bound low; when it does not, two columns were crossed, which
  -- produces numbers that look perfectly plausible on their own.
  CONSTRAINT tvh_high_low_sane CHECK (
    high_price IS NULL OR low_price IS NULL OR high_price >= low_price
  )
);
CREATE INDEX IF NOT EXISTS tvh_date_idx ON tradingview_history (trade_date DESC);

-- ---------------------------------------------------------------------------
-- 3 · Daily stock analysis — columns exactly as specified
--
-- The CALCULATIONS are not implemented. No formulas were given for swings, the
-- Fibonacci signals, the buyer/seller split or the timing fields, and inventing
-- them would produce numbers that look authoritative and mean nothing. The
-- table is here and ready; the engine that fills it needs its specification.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS daily_stock_analysis (
  symbol text COLLATE pg_catalog."default" NOT NULL,
  trade_date date NOT NULL,
  day_open numeric(12,3) NOT NULL,
  day_close numeric(12,3) NOT NULL,
  oc_margin numeric(12,3),
  day_high numeric(12,3),
  day_low numeric(12,3),
  day_range numeric(12,3),
  total_volume bigint,
  avg_vol_min numeric(14,2),
  highest_volume bigint,
  vol_spike_count integer,
  bull_swings integer,
  bear_swings integer,
  total_swings integer,
  tradable_bull_swings integer,
  largest_bull_swing numeric(8,3),
  largest_bear_swing numeric(8,3),
  avg_swing_size numeric(8,3),
  avg_time_btwn_swings numeric(8,2),
  longest_bull_run integer,
  longest_bear_run integer,
  fib_signals integer,
  successful_fib integer,
  fib_win_pct numeric(6,2),
  auto_target_fils numeric(6,2),
  avg_profit_fib numeric(8,3),
  avg_loss_fib numeric(8,3),
  avg_time_to_target numeric(8,2),
  best_earning_time text COLLATE pg_catalog."default",
  false_signal_pct numeric(6,2),
  est_buyer_vol bigint,
  est_seller_vol bigint,
  buyer_pct numeric(6,2),
  seller_pct numeric(6,2),
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT daily_stock_analysis_pkey PRIMARY KEY (symbol, trade_date)
);
CREATE INDEX IF NOT EXISTS dsa_date_idx ON daily_stock_analysis (trade_date DESC);

COMMENT ON TABLE daily_stock_analysis IS
  'Per-symbol daily analytics. Columns as specified; the calculations are NOT '
  'implemented — no formulas were provided for the swing, Fibonacci, timing or '
  'buyer/seller fields.';

-- ---------------------------------------------------------------------------
-- 4 · AWSAT market quotes — Main + Premium, both collectors
--
-- ingest_source is part of the KEY, not just a label. Two collectors watching
-- the same board legitimately produce a row for the same symbol at the same
-- second; keying without it would make one silently discard the other, and the
-- disagreement between them is the evidence worth keeping.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS awsat_market_quotes (
  id              bigserial   PRIMARY KEY,
  scrape_batch_id uuid,
  market          text        NOT NULL,
  symbol          text        NOT NULL,
  code            text,
  description     text,
  last_price      numeric(18, 4),
  last_qty        bigint,
  chg             numeric(18, 4),
  pct_chg         numeric(10, 4),
  volume          bigint,
  bid             numeric(18, 4),
  bid_qty         bigint,
  offer           numeric(18, 4),
  offer_qty       bigint,
  trades          integer,
  last_trade_date date,
  last_trade_time text,
  intrinsic_value numeric(18, 4),
  open_price      numeric(18, 4),
  high_price      numeric(18, 4),
  low_price       numeric(18, 4),
  session         text,
  nms             numeric(18, 4),
  trading_date    date        NOT NULL,
  ingest_source   text        NOT NULL,
  source_precedence smallint  NOT NULL DEFAULT 0,
  run_id          bigint      REFERENCES scrape_runs(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL,

  CONSTRAINT awsat_quotes_key UNIQUE (market, symbol, created_at, ingest_source),
  CONSTRAINT awsat_quotes_source_valid
    CHECK (ingest_source IN ('awsat_server', 'awsat_client')),
  CONSTRAINT awsat_quotes_non_negative CHECK (
    (last_price IS NULL OR last_price >= 0) AND (open_price IS NULL OR open_price >= 0)
    AND (high_price IS NULL OR high_price >= 0) AND (low_price IS NULL OR low_price >= 0)
    AND (bid IS NULL OR bid >= 0) AND (offer IS NULL OR offer >= 0)
    AND (volume IS NULL OR volume >= 0)
  )
);
CREATE INDEX IF NOT EXISTS awsat_quotes_symbol_idx ON awsat_market_quotes (symbol, created_at DESC);
CREATE INDEX IF NOT EXISTS awsat_quotes_date_idx   ON awsat_market_quotes (trading_date, market);
CREATE INDEX IF NOT EXISTS awsat_quotes_source_idx ON awsat_market_quotes (ingest_source, created_at DESC);

-- ---------------------------------------------------------------------------
-- 5 · AWSAT stock depth — required every 1 to 1.5 minutes
--
-- The key includes created_at rather than a minute bucket: the book changes
-- many times within a minute, and collapsing that discards the movement that
-- makes depth worth capturing at all.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS awsat_stock_depth (
  id            bigserial   PRIMARY KEY,
  symbol        text        NOT NULL,
  level         smallint    NOT NULL,
  bid           numeric(18, 4),
  bid_qty       bigint,
  bid_orders    integer,
  offer         numeric(18, 4),
  offer_qty     bigint,
  offer_orders  integer,
  trading_date  date        NOT NULL,
  ingest_source text        NOT NULL,
  run_id        bigint      REFERENCES scrape_runs(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL,

  CONSTRAINT awsat_depth_key UNIQUE (symbol, level, created_at, ingest_source),
  CONSTRAINT awsat_depth_source_valid
    CHECK (ingest_source IN ('awsat_server', 'awsat_client')),
  CONSTRAINT awsat_depth_level_range CHECK (level BETWEEN 1 AND 20),
  CONSTRAINT awsat_depth_non_negative CHECK (
    (bid IS NULL OR bid >= 0) AND (offer IS NULL OR offer >= 0)
    AND (bid_qty IS NULL OR bid_qty >= 0) AND (offer_qty IS NULL OR offer_qty >= 0)
  )
);
CREATE INDEX IF NOT EXISTS awsat_depth_symbol_idx ON awsat_stock_depth (symbol, created_at DESC);
CREATE INDEX IF NOT EXISTS awsat_depth_date_idx   ON awsat_stock_depth (trading_date, symbol);

-- ---------------------------------------------------------------------------
-- 6 · AWSAT order list
--
-- symbol is nullable and not a foreign key. An order whose symbol cell fails to
-- parse still carries a real id, price and quantity, and those stay
-- reconcilable — and the terminal only shows today, so a discarded row is gone.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS awsat_order_list (
  id              bigserial   PRIMARY KEY,
  order_id        text        NOT NULL,
  symbol          text,
  side            text,
  order_status    text,
  price           numeric(18, 4),
  quantity        bigint,
  filled_quantity bigint,
  remaining_qty   bigint,
  order_time      timestamptz,
  trading_date    date        NOT NULL,
  ingest_source   text        NOT NULL,
  run_id          bigint      REFERENCES scrape_runs(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL,

  CONSTRAINT awsat_orders_key UNIQUE (order_id, created_at, ingest_source),
  CONSTRAINT awsat_orders_source_valid
    CHECK (ingest_source IN ('awsat_server', 'awsat_client')),
  CONSTRAINT awsat_orders_side_valid
    CHECK (side IS NULL OR side IN ('BUY', 'SELL', 'UNKNOWN')),
  CONSTRAINT awsat_orders_fill_sane CHECK (
    quantity IS NULL OR filled_quantity IS NULL OR filled_quantity <= quantity
  )
);
CREATE INDEX IF NOT EXISTS awsat_orders_date_idx   ON awsat_order_list (trading_date, created_at DESC);
CREATE INDEX IF NOT EXISTS awsat_orders_symbol_idx ON awsat_order_list (symbol, created_at DESC);

-- ---------------------------------------------------------------------------
-- Carry existing rows across, then leave the old tables in place.
--
-- Not dropped: a migration that both moves data and destroys the original has
-- no way back if the mapping is wrong. Verify the counts, then drop by hand.
-- ---------------------------------------------------------------------------
INSERT INTO tradingview_watchlist
       (symbol, company_name, last_price, change_value, change_pct, volume,
        trading_date, run_id, created_at)
SELECT symbol, description, last_price, chg, pct_chg, volume,
       trading_date, run_id, created_at
  FROM live_quotes
 WHERE source = 'tradingview'
ON CONFLICT (symbol, created_at) DO NOTHING;

INSERT INTO awsat_market_quotes
       (scrape_batch_id, market, symbol, code, description, last_price, last_qty,
        chg, pct_chg, volume, bid, bid_qty, offer, offer_qty, trades,
        last_trade_date, last_trade_time, intrinsic_value, open_price,
        high_price, low_price, session, nms, trading_date, ingest_source,
        source_precedence, run_id, created_at)
SELECT scrape_batch_id, market, symbol, code, description, last_price, last_qty,
       chg, pct_chg, volume, bid, bid_qty, offer, offer_qty, trades,
       last_trade_date, last_trade_time, intrinsic_value, open_price,
       high_price, low_price, session, nms, trading_date,
       COALESCE(ingest_source, 'awsat_server'),
       COALESCE(source_precedence, 1), run_id, created_at
  FROM live_quotes
 WHERE source = 'awsat'
ON CONFLICT (market, symbol, created_at, ingest_source) DO NOTHING;

INSERT INTO awsat_stock_depth
       (symbol, level, bid, bid_qty, bid_orders, offer, offer_qty, offer_orders,
        trading_date, ingest_source, run_id, created_at)
SELECT symbol, level, bid, bid_qty, bid_orders, offer, offer_qty, offer_orders,
       trading_date, 'awsat_server', run_id, created_at
  FROM order_book_levels
ON CONFLICT (symbol, level, created_at, ingest_source) DO NOTHING;

INSERT INTO awsat_order_list
       (order_id, symbol, side, order_status, price, quantity, filled_quantity,
        remaining_qty, order_time, trading_date, ingest_source, run_id, created_at)
SELECT order_id, symbol, side, order_status, price, quantity, filled_quantity,
       remaining_qty, order_time, trading_date, 'awsat_server', run_id, created_at
  FROM broker_orders
ON CONFLICT (order_id, created_at, ingest_source) DO NOTHING;

INSERT INTO tradingview_history
       (symbol, trade_date, open_price, high_price, low_price, close_price,
        change_value, change_pct, volume, run_id)
SELECT symbol, trade_date, open_price, high_price, low_price, close_price,
       change_value, change_pct, volume, run_id
  FROM daily_bars
ON CONFLICT (symbol, trade_date) DO NOTHING;

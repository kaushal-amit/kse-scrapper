-- ===========================================================================
--  001_init.sql — schema aligned to the production SPREAD names
--
--  Table names, keys and column names follow the working ingestion service
--  rather than being invented here, so data collected by this scraper is
--  readable by the same queries and engines without a translation layer.
--
--    market_stock_snapshots   the instrument list per market (reference data)
--    stock_quotes             live board rows, one per symbol per capture
--    stock_prices_daily       end-of-day OHLCV history
--    stock_depth              order-book ladder
--    order_list_snapshots     the broker's own order list
--    scrape_runs              one row per scraper execution
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- scrape_runs — the audit trail. Created first: everything references it.
--
-- rows_extracted and rows_inserted are recorded SEPARATELY on purpose. Equal
-- numbers mean new data; extracted-without-inserted means the source is being
-- read and every row is already stored, which is a stalled feed wearing the
-- appearance of a healthy one. One counter cannot tell those apart.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scrape_runs (
  id              bigserial PRIMARY KEY,
  scraper         text        NOT NULL,
  trading_date    date        NOT NULL,
  status          text        NOT NULL DEFAULT 'RUNNING',
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  duration_ms     integer,
  rows_extracted  integer     NOT NULL DEFAULT 0,
  rows_inserted   integer     NOT NULL DEFAULT 0,
  rows_rejected   integer     NOT NULL DEFAULT 0,
  error_message   text,
  error_stack     text,

  CONSTRAINT scrape_runs_status_valid
    CHECK (status IN ('RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED', 'SKIPPED'))
);

CREATE INDEX IF NOT EXISTS scrape_runs_scraper_idx ON scrape_runs (scraper, started_at DESC);
CREATE INDEX IF NOT EXISTS scrape_runs_date_idx    ON scrape_runs (trading_date, scraper);

-- ---------------------------------------------------------------------------
-- market_stock_snapshots — the instrument list, per market
--
-- A symbol belongs to a market (Premier or Main), and the board is scraped one
-- market at a time, so the key is (market, symbol) rather than symbol alone.
-- The broker shows the symbol as "SYMBOL - CODE"; both halves are kept because
-- the code is the stable identifier across a ticker rename.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS market_stock_snapshots (
  market        text        NOT NULL,
  symbol        text        NOT NULL,
  code          text,
  description   text,
  first_seen_on date        NOT NULL DEFAULT CURRENT_DATE,
  last_seen_on  date        NOT NULL DEFAULT CURRENT_DATE,
  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (market, symbol),
  CONSTRAINT mss_symbol_not_blank CHECK (length(trim(symbol)) > 0)
);

CREATE INDEX IF NOT EXISTS mss_symbol_idx ON market_stock_snapshots (symbol);

-- ---------------------------------------------------------------------------
-- stock_quotes — live board rows
--
-- Keyed (market, symbol, created_at), matching production. created_at is
-- supplied by the APPLICATION for the whole capture batch, never defaulted to
-- now(): a DEFAULT would make every retry a distinct row and the key would
-- deduplicate nothing at all.
--
-- Prices are numeric, never float. Kuwait quotes in fils and a half-fil tick
-- matters; binary floating point cannot hold 0.005 exactly and the error
-- compounds through any aggregate.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stock_quotes (
  id               bigserial   PRIMARY KEY,
  scrape_batch_id  uuid,
  market           text        NOT NULL,
  symbol           text        NOT NULL,
  code             text,
  description      text,

  last_price       numeric(18, 4),
  last_qty         bigint,
  chg              numeric(18, 4),
  pct_chg          numeric(10, 4),
  volume           bigint,
  bid              numeric(18, 4),
  bid_qty          bigint,
  offer            numeric(18, 4),
  offer_qty        bigint,
  trades           integer,
  last_trade_date  date,
  last_trade_time  text,
  intrinsic_value  numeric(18, 4),
  open_price       numeric(18, 4),
  high_price       numeric(18, 4),
  low_price        numeric(18, 4),
  session          text,
  nms              numeric(18, 4),

  trading_date     date        NOT NULL,
  source           text        NOT NULL DEFAULT 'awsat',
  run_id           bigint      REFERENCES scrape_runs(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL,

  CONSTRAINT stock_quotes_key UNIQUE (market, symbol, created_at),

  -- A negative price is a parse error, not a market event. chg and pct_chg are
  -- excluded: those are legitimately negative.
  CONSTRAINT stock_quotes_prices_non_negative CHECK (
    (last_price  IS NULL OR last_price  >= 0) AND
    (open_price  IS NULL OR open_price  >= 0) AND
    (high_price  IS NULL OR high_price  >= 0) AND
    (low_price   IS NULL OR low_price   >= 0) AND
    (bid         IS NULL OR bid         >= 0) AND
    (offer       IS NULL OR offer       >= 0)
  ),
  CONSTRAINT stock_quotes_qty_non_negative CHECK (
    (volume  IS NULL OR volume  >= 0) AND
    (bid_qty IS NULL OR bid_qty >= 0) AND
    (offer_qty IS NULL OR offer_qty >= 0) AND
    (trades  IS NULL OR trades  >= 0)
  )
);

CREATE INDEX IF NOT EXISTS stock_quotes_symbol_idx ON stock_quotes (symbol, created_at DESC);
CREATE INDEX IF NOT EXISTS stock_quotes_date_idx   ON stock_quotes (trading_date, market);
CREATE INDEX IF NOT EXISTS stock_quotes_batch_idx  ON stock_quotes (scrape_batch_id);

-- ---------------------------------------------------------------------------
-- stock_prices_daily — end-of-day OHLCV
--
-- UPSERTed on (symbol, trade_date), unlike stock_quotes which is insert-only.
-- An exchange can restate a daily bar after the fact, so a re-scrape must be
-- allowed to overwrite. Letting a history pass rewrite live ticks would be a
-- correction overwriting an observation, which is why the two are separate.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stock_prices_daily (
  symbol       text        NOT NULL,
  trade_date   date        NOT NULL,

  open_price   numeric(18, 4),
  high_price   numeric(18, 4),
  low_price    numeric(18, 4),
  close_price  numeric(18, 4),
  change_value numeric(18, 4),
  change_pct   numeric(10, 4),
  volume       bigint,

  source       text        NOT NULL DEFAULT 'tradingview',
  run_id       bigint      REFERENCES scrape_runs(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (symbol, trade_date),

  CONSTRAINT spd_non_negative CHECK (
    (open_price  IS NULL OR open_price  >= 0) AND
    (high_price  IS NULL OR high_price  >= 0) AND
    (low_price   IS NULL OR low_price   >= 0) AND
    (close_price IS NULL OR close_price >= 0) AND
    (volume      IS NULL OR volume      >= 0)
  ),
  -- high must bound low. When it does not, the parser has crossed two columns —
  -- the most common table-view failure, and one that produces numbers which
  -- look perfectly plausible on their own.
  CONSTRAINT spd_high_low_sane CHECK (
    high_price IS NULL OR low_price IS NULL OR high_price >= low_price
  )
);

CREATE INDEX IF NOT EXISTS spd_date_idx   ON stock_prices_daily (trade_date DESC);
CREATE INDEX IF NOT EXISTS spd_symbol_idx ON stock_prices_daily (symbol, trade_date DESC);

-- ---------------------------------------------------------------------------
-- stock_depth — order-book ladder
--
-- The key includes created_at rather than a minute bucket: the book changes
-- many times within a minute and collapsing that would discard the movement
-- that makes depth worth capturing. created_at is supplied per capture so every
-- level of one book shares it and the ladder can be reassembled exactly.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stock_depth (
  id           bigserial   PRIMARY KEY,
  symbol       text        NOT NULL,
  level        smallint    NOT NULL,
  bid          numeric(18, 4),
  bid_qty      bigint,
  bid_orders   integer,
  offer        numeric(18, 4),
  offer_qty    bigint,
  offer_orders integer,

  trading_date date        NOT NULL,
  run_id       bigint      REFERENCES scrape_runs(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL,

  CONSTRAINT stock_depth_key UNIQUE (symbol, level, created_at),
  CONSTRAINT stock_depth_level_range CHECK (level BETWEEN 1 AND 20),
  CONSTRAINT stock_depth_non_negative CHECK (
    (bid IS NULL OR bid >= 0) AND (offer IS NULL OR offer >= 0) AND
    (bid_qty IS NULL OR bid_qty >= 0) AND (offer_qty IS NULL OR offer_qty >= 0)
  )
);

CREATE INDEX IF NOT EXISTS stock_depth_symbol_idx ON stock_depth (symbol, created_at DESC);
CREATE INDEX IF NOT EXISTS stock_depth_date_idx   ON stock_depth (trading_date, symbol);

-- ---------------------------------------------------------------------------
-- order_list_snapshots — the broker's own order list
--
-- A pure snapshot log: the same order appears in many captures with a changing
-- status, so the key is (order_id, created_at).
--
-- symbol is nullable and NOT a foreign key. An order whose symbol cell fails to
-- parse still carries a real order id, price and quantity, and those remain
-- reconcilable. The terminal only shows today, so a row discarded to protect
-- referential tidiness is gone for good.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_list_snapshots (
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
  run_id          bigint      REFERENCES scrape_runs(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL,

  CONSTRAINT ols_key UNIQUE (order_id, created_at),
  CONSTRAINT ols_side_valid CHECK (side IS NULL OR side IN ('BUY', 'SELL', 'UNKNOWN')),
  -- Filled cannot exceed ordered. When it does, the row parser has drifted a
  -- column — the most common terminal-scraping failure there is.
  CONSTRAINT ols_fill_sane CHECK (
    quantity IS NULL OR filled_quantity IS NULL OR filled_quantity <= quantity
  )
);

CREATE INDEX IF NOT EXISTS ols_date_idx   ON order_list_snapshots (trading_date, created_at DESC);
CREATE INDEX IF NOT EXISTS ols_symbol_idx ON order_list_snapshots (symbol, created_at DESC);

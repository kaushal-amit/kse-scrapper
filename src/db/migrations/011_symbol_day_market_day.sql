-- ===========================================================================
--  011_symbol_day_market_day.sql — TMI Engine 01, steps 1 and 1a
--
--  DDL ONLY. The specification is explicit: "Both are just DDL — no logic yet.
--  The compute jobs come after the quote migration." Nothing here populates
--  anything, and nothing should until the quote migration is deduplicated —
--  6,265 duplicate keys must not carry over.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Correct the session list to the specification.
--
-- 010 used 'Pre-Open', which was my guess. The spec says
-- 'Close Auction Acceptance'. Pre-open prints are indications made BEFORE the
-- auction crosses; counting them toward a close would reintroduce the class of
-- error this rule exists to remove.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION closing_sessions()
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY[
    'Trading',
    'Close Auction Acceptance',
    'Trading at Last',
    'Close-Of-Day'
  ]::text[];
$$;

COMMENT ON FUNCTION closing_sessions() IS
  'Sessions whose prints count toward the close. Trading alone gave two wrong '
  'closes in one week: TIJARA 172 instead of 176, PHC 175 instead of 170.';

-- ---------------------------------------------------------------------------
-- prev_session(d, n) — the specification's signature.
--
-- Market-wide and n sessions back, because chg_5d needs the fifth previous
-- SESSION, not d - 5. Two calendar days a week are not sessions, and 29-30
-- July are missing entirely; an offset walks straight through both.
--
-- The per-symbol form from 010 is kept: a symbol suspended for three days has
-- a different previous session from the market's.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION prev_session(d date, n int DEFAULT 1)
RETURNS date LANGUAGE sql STABLE AS $$
  SELECT trading_date
    FROM (
      SELECT DISTINCT trading_date
        FROM awsat_market_quotes
       WHERE trading_date < d
       ORDER BY trading_date DESC
       LIMIT GREATEST(n, 1)
    ) s
   ORDER BY trading_date ASC
   LIMIT 1
$$;

COMMENT ON FUNCTION prev_session(date, int) IS
  'The n-th previous session that actually has data. Never d - n days: '
  'weekends break it twice a week and 29-30 July are missing entirely.';

-- ---------------------------------------------------------------------------
--  STEP 1 · symbol_day replaces daily_stock_analysis
--
--  daily_stock_analysis is empty, so nothing is lost. Its 37 columns are the
--  retired Fibonacci and swing strategy: 8 Fibonacci, 10 swing, 4 tick-rule
--  flow, and best_earning_time which was never defined. Only the 9 OHLC and
--  volume columns survive, under their new names.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS public.daily_stock_analysis;

CREATE TABLE public.symbol_day (
  symbol                 text        NOT NULL,
  trading_date           date        NOT NULL,

  -- ============ PRICE ============
  open_px                numeric,
  high_px                numeric,
  low_px                 numeric,
  close_px               numeric,     -- from ALL sessions, not Trading alone
  prev_close             numeric,     -- via prev_session(), not date - 1
  chg_fils               numeric,
  chg_1d                 numeric,
  chg_5d                 numeric,
  day_range              numeric,
  series_break           boolean DEFAULT false,   -- rename/suspension boundary

  -- ============ VOLUME ============
  total_volume           bigint,
  trades                 integer,
  avg_trade_size         numeric,
  highest_minute_volume  bigint,
  vol_ratio_5d           numeric,
  trades_baseline_20d    numeric,

  -- ============ MOVEMENT ============
  moves                  integer,     -- price changed minute to minute
  up_moves               integer,
  down_moves             integer,
  moves_2plus            integer,     -- up-moves of 2+ fils
  moves_3plus            integer,

  -- ============ TAPE QUALITY ============
  up_moves_tiny          integer,     -- up-moves on <=100 shares
  down_moves_tiny        integer,
  tiny_pct_up            numeric,     -- THE GATE. Never the blended figure
  tiny_pct_down          numeric,     -- danger flag: bid was empty
  trades_under_100       integer,
  last_qty_p10           numeric,
  last_qty_p50           numeric,
  last_qty_p90           numeric,

  -- ============ THE BOOK ============
  bid_p10                numeric,
  bid_p25                numeric,
  bid_p50                numeric,
  bid_p75                numeric,
  bid_p90                numeric,
  offer_p10              numeric,
  offer_p25              numeric,
  offer_p50              numeric,
  offer_p75              numeric,
  offer_p90              numeric,
  spread_fils_p50        numeric,
  spread_fils_p90        numeric,

  -- ============ CAN I TRADE IT ============
  pct_postable           numeric,     -- % minutes bid_qty 15k-130k
  pct_exitable           numeric,     -- % minutes offer_qty <= 3x my_shares
  pct_both_workable      numeric,     -- both at once
  exitable_best_hour     numeric,     -- the trader needs ONE good hour
  net_per_fil            numeric,     -- (budget/price) - commission
  shares_at_budget       integer,

  -- ============ FLOW · print location, not tick rule ============
  bought_at_offer        bigint,
  sold_at_bid            bigint,
  shares_inside_spread   bigint,
  trades_at_offer        integer,
  trades_at_bid          integer,
  buy_sell_ratio         numeric,     -- >= 5 load · ~1.0 on +5% = distribution
  block_ratio            numeric,     -- old tick rule, kept for 20 sessions

  -- ============ OPERATOR SIGNALS ============
  refill_ratio           numeric,     -- offer refilled / offer price rose
  offer_refilled_n       integer,
  offer_rose_n           integer,
  bid_consumed_n         integer,
  bid_withdrawn_n        integer,
  pct_bid_withdrawn      numeric,     -- MRC ran 29%, TIJARA 0%
  wall_events            integer,     -- offers > 200k
  wall_max_qty           bigint,
  wall_prices            jsonb,       -- {"230": 295, "233": 165} snapshot counts
  bid_age_p50_secs       numeric,     -- how long a level survives

  -- ============ SESSIONS ============
  auction_price          numeric,
  auction_volume         bigint,
  auction_vs_last_bid    numeric,     -- +3, +3, -8 on the record so far
  tal_price              numeric,
  tal_volume             bigint,
  cb_events              integer,     -- circuit breakers
  cb_total_secs          integer,

  -- ============ INTRADAY SHAPE ============
  best_hour              smallint,
  ratio_by_hour          jsonb,       -- {"9":8.0,"10":5.3,"11":10.5,"12":28.8}
  bid_by_hour            jsonb,
  offer_by_hour          jsonb,

  -- ============ CLASSIFICATION ============
  family                 text,        -- CRAWLER GIANT REACHABLE SCALER STARVED QUOTED
  budget_for_queue_kd    numeric,
  max_budget_kd          numeric,

  -- ============ QUALITY ============
  minutes_captured       integer,
  coverage_pct           numeric,
  largest_gap_secs       integer,
  data_quality           text,        -- FULL | PARTIAL | THIN
  source                 text,        -- AWSAT | TRADINGVIEW
  computed_at            timestamptz DEFAULT now(),

  PRIMARY KEY (symbol, trading_date)
);

CREATE INDEX ON public.symbol_day (trading_date);
CREATE INDEX ON public.symbol_day (family, trading_date);

COMMENT ON TABLE public.symbol_day IS
  'Per-symbol per-session analytics for SPREAD. Replaces daily_stock_analysis. '
  'DDL only — nothing populates this until the quote migration is deduplicated.';
COMMENT ON COLUMN public.symbol_day.tiny_pct_up IS
  'UP-MOVES ONLY. The blended figure halves it: up-moves run 43-70% tiny, '
  'down-moves 0-20%. ARABREC read 12 blended and 24 up-only.';
COMMENT ON COLUMN public.symbol_day.buy_sell_ratio IS
  'NULL where pct_at_offer > 90. GFH sits at the offer 98% of minutes and every '
  'trade classifies as buying: the ratio read 52:1, KRE 199:1.';
COMMENT ON COLUMN public.symbol_day.source IS
  'AWSAT or TRADINGVIEW. Any query using trades MUST filter source = AWSAT — '
  'TradingView rows have no trade count, and 11,915 of 14,084 rows were NULL.';
COMMENT ON COLUMN public.symbol_day.block_ratio IS
  'The old tick-rule figure, kept for 20 sessions to compare against '
  'buy_sell_ratio. The two disagreed on DIRECTION on the same session.';

-- ---------------------------------------------------------------------------
--  STEP 1a · market_day — one row per session
--
--  There is no market-level table at all. The two worst trading days were the
--  two worst breadth days and the only winning day was the best breadth day.
-- ---------------------------------------------------------------------------
CREATE TABLE public.market_day (
  trading_date        date PRIMARY KEY,

  -- ============ BREADTH ============
  symbols_traded      integer,
  advancing           integer,
  declining           integer,
  unchanged           integer,
  pct_advancing       numeric,      -- THE GATE
  breadth_5d_avg      numeric,

  -- ============ MOVE ============
  avg_pct_change      numeric,
  median_pct_change   numeric,      -- median, not mean: one +109% gap distorts
  pct_change_p10      numeric,
  pct_change_p90      numeric,

  -- ============ ACTIVITY ============
  total_volume        bigint,
  total_trades        integer,
  volume_vs_20d       numeric,
  symbols_over_3x_pace integer,     -- how many woke up

  -- ============ EVENTS ============
  new_symbols         integer,      -- 3 appeared in 2 weeks, none flagged
  suspended_symbols   integer,      -- session NULL all day
  renamed_symbols     integer,      -- same boursa_code, new symbol
  cb_events_total     integer,      -- circuit breakers across the market

  -- ============ VERDICT ============
  regime              text,         -- RISK_ON | NEUTRAL | RISK_OFF

  computed_at         timestamptz DEFAULT now()
);

COMMENT ON TABLE public.market_day IS
  'One row per session. DDL only — no compute job yet.';
COMMENT ON COLUMN public.market_day.regime IS
  'pct_advancing <35 RISK_OFF, 35-50 NEUTRAL, >50 RISK_ON. WARN-ONLY at first: '
  'display it, and log what blocking would have done for 20 sessions before it '
  'gates anything. Same discipline as CR-35.';
COMMENT ON COLUMN public.market_day.median_pct_change IS
  'Median, not mean. CATTL alone rose 109% in one gap on 24 August; a single '
  'outlier moves the average and says nothing about the market.';

-- ===========================================================================
--  016_step3_align_to_spec.sql — the Step 3 tables exactly as specified
--
--  015 was written from an 18-point summary; the specification differs. The
--  three tables are EMPTY, so they are dropped and recreated rather than
--  patched — an ALTER chain to reach a known target leaves column order and
--  defaults subtly different from the DDL everyone is reading.
--
--  The `slot` table goes entirely: "the `slot` column replaces a separate
--  assignment table". Two records of which symbol holds which slot can
--  disagree, and the signal_log row is the one that gets read.
-- ===========================================================================

DROP TABLE IF EXISTS public.symbol_minute;
DROP TABLE IF EXISTS public.signal_log;
DROP VIEW  IF EXISTS public.position;
DROP TABLE IF EXISTS public.position;
DROP TABLE IF EXISTS public.slot;

-- ---------------------------------------------------------------------------
--  1 · symbol_minute — what the fast loop writes, 8 symbols every 15-20s.
-- ---------------------------------------------------------------------------
CREATE TABLE public.symbol_minute (
  symbol            text        NOT NULL,
  ts                timestamptz NOT NULL,
  trading_date      date        NOT NULL,

  last_price        numeric,
  bid               numeric,
  bid_qty           bigint,
  offer             numeric,
  offer_qty         bigint,

  buyers_per_seller numeric,
  bid_age_secs      integer,     -- how long THIS level has existed
  offer_age_secs    integer,

  bid_change        bigint,
  offer_change      bigint,
  wall_event        text,        -- ADDED | PULLED | TRADED | NULL
  wall_price        numeric,
  wall_qty          bigint,

  volume_delta      bigint,
  is_frozen         boolean,     -- no volume, both sides > 100k

  PRIMARY KEY (symbol, ts)
);

CREATE INDEX ON public.symbol_minute (trading_date, symbol);

-- wall_event is a fixed vocabulary; a typo would be invisible to every filter.
ALTER TABLE public.symbol_minute
  ADD CONSTRAINT symbol_minute_wall_event_valid
  CHECK (wall_event IS NULL OR wall_event IN ('ADDED', 'PULLED', 'TRADED'));

COMMENT ON COLUMN public.symbol_minute.bid_age_secs IS
  'The MRC finding made native: a 150,000 bid one snapshot old is bait, a '
  '132,010 bid that has stood all session is support. Same size, opposite '
  'meaning — only the age separates them.';

-- ---------------------------------------------------------------------------
--  2 · signal_log — the important table. Every alert, scored the same night.
-- ---------------------------------------------------------------------------
CREATE TABLE public.signal_log (
  id            bigserial PRIMARY KEY,
  fired_at      timestamptz NOT NULL,
  trading_date  date        NOT NULL,
  symbol        text        NOT NULL,
  signal        text        NOT NULL,
  slot          smallint,          -- 1-3 pre-day, 4-8 wake-up
  price         numeric,
  bid_qty       bigint,
  offer_qty     bigint,
  ratio         numeric,
  pace          numeric,           -- wake-ups only
  message       text,
  replaced      text,              -- symbol dropped, if a swap

  px_5min       numeric,
  px_15min      numeric,
  px_60min      numeric,
  was_right     boolean,
  scored_at     timestamptz
);

CREATE INDEX ON public.signal_log (trading_date, symbol);
CREATE INDEX ON public.signal_log (signal, was_right);

-- The slot number carries the pre-day / wake-up split, so it has to be a real
-- slot or nothing. A signal in slot 9 belongs to no scheme.
ALTER TABLE public.signal_log
  ADD CONSTRAINT signal_log_slot_range
  CHECK (slot IS NULL OR slot BETWEEN 1 AND 8);

-- One condition on one symbol at one instant is ONE signal. Without this the
-- loop re-firing on an unchanged pair would log the same alert repeatedly and
-- the scoring query would count it as several.
ALTER TABLE public.signal_log
  ADD CONSTRAINT signal_log_once UNIQUE (symbol, signal, fired_at);

CREATE INDEX signal_log_unscored_idx ON public.signal_log (trading_date)
  WHERE scored_at IS NULL;

COMMENT ON TABLE public.signal_log IS
  'Every alert, with what happened next. Nothing in this system has ever been '
  'validated because nothing has ever been logged.';

-- ---------------------------------------------------------------------------
--  3 · position — built from awsat_order_list by order_id.
--
--  A TABLE, not a view: it holds a LIFECYCLE. closed_at, stop_price and
--  is_open are decisions and events, not aggregates of the order list, and a
--  view has nowhere to keep them.
-- ---------------------------------------------------------------------------
CREATE TABLE public.position (
  id            bigserial PRIMARY KEY,
  symbol        text NOT NULL,
  trading_date  date NOT NULL,
  opened_at     timestamptz,
  closed_at     timestamptz,
  shares        integer,
  avg_cost      numeric,
  avg_exit      numeric,
  commission    numeric,
  net_pnl       numeric,
  stop_price    numeric,
  is_open       boolean DEFAULT true
);

-- One open position per symbol per day. A second would make "what do I hold"
-- ambiguous, which is the thing this table exists to end.
CREATE UNIQUE INDEX position_one_open_per_symbol
  ON public.position (symbol, trading_date) WHERE is_open;

CREATE INDEX ON public.position (trading_date, symbol);

COMMENT ON TABLE public.position IS
  'Built from awsat_order_list by order_id. The position had to be '
  'reconstructed by hand and was wrong three times.';

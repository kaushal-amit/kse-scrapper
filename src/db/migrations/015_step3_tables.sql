-- ===========================================================================
--  015_step3_tables.sql — symbol_minute, signal_log, position, slot
--
--  Columns the Step 3 list NAMES are marked [spec]. Columns it does not name
--  are marked [derived] — they are keys, timestamps, or the inputs a named
--  column cannot be computed without. Every [derived] choice is one ALTER to
--  change; none of them invent a metric.
-- ===========================================================================

-- ---------------------------------------------------------------------------
--  symbol_minute — what the fast loop writes, every 15-20s for 8 symbols.
--
--  Named per minute but written several times a minute: captured_at is part of
--  the key so two snapshots inside one minute both survive. Collapsing them
--  would discard exactly the movement the seven checks compare.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.symbol_minute (
  id            bigserial   PRIMARY KEY,
  symbol        text        NOT NULL,              -- [derived] key
  trading_date  date        NOT NULL,              -- [derived] key
  captured_at   timestamptz NOT NULL,              -- [derived] key

  last_price    numeric,
  bid           numeric,
  bid_qty       bigint,
  offer         numeric,
  offer_qty     bigint,
  volume        bigint,                            -- cumulative for the session
  trades        integer,

  -- [derived] The age of the current bid level, in seconds. BAIT BID cannot be
  -- evaluated without it: "large bid" and "large bid placed four minutes ago"
  -- are different signals and the list distinguishes them.
  bid_age_secs  integer,

  source        text        NOT NULL DEFAULT 'awsat_client',

  CONSTRAINT symbol_minute_key UNIQUE (symbol, captured_at),
  CONSTRAINT symbol_minute_source_valid
    CHECK (source IN ('awsat_server', 'awsat_client'))
);

CREATE INDEX IF NOT EXISTS symbol_minute_sym_idx
  ON public.symbol_minute (symbol, captured_at DESC);
CREATE INDEX IF NOT EXISTS symbol_minute_date_idx
  ON public.symbol_minute (trading_date);

COMMENT ON TABLE public.symbol_minute IS
  'Fast-loop snapshots. Several per minute per symbol; captured_at is in the '
  'key so consecutive snapshots both survive — the checks compare them.';

-- ---------------------------------------------------------------------------
--  signal_log — what the checks and the wake-up scan produce.
--
--  px_5min, px_15min and was_right are filled by the NIGHTLY job, not at
--  signal time. They are the record of whether the signal was any good, and
--  they are the only reason to keep a signal nobody acted on.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.signal_log (
  id            bigserial   PRIMARY KEY,
  symbol        text        NOT NULL,              -- [derived] key
  trading_date  date        NOT NULL,              -- [derived] key
  fired_at      timestamptz NOT NULL,              -- [derived] key

  signal        text        NOT NULL,              -- [spec] which of the 7, or WAKEUP
  detail        text,                              -- [derived] human-readable why
  payload       jsonb,                             -- [derived] the numbers behind it

  px_at_signal  numeric,                           -- [derived] baseline for was_right
  px_5min       numeric,                           -- [spec] filled nightly
  px_15min      numeric,                           -- [spec] filled nightly
  was_right     boolean,                           -- [spec] filled nightly

  scored_at     timestamptz,                       -- [derived] NULL until scored
  delivered_at  timestamptz,                       -- [derived] NULL if never pushed

  CONSTRAINT signal_log_key UNIQUE (symbol, signal, fired_at)
);

CREATE INDEX IF NOT EXISTS signal_log_date_idx ON public.signal_log (trading_date, fired_at DESC);
CREATE INDEX IF NOT EXISTS signal_log_unscored_idx
  ON public.signal_log (trading_date) WHERE scored_at IS NULL;

COMMENT ON COLUMN public.signal_log.was_right IS
  'Filled by the nightly job, never at signal time. A signal is only worth '
  'keeping if what happened next is recorded next to it.';

-- ---------------------------------------------------------------------------
--  position — built from awsat_order_list, keyed on order_id [spec 18].
--
--  A VIEW, not a table. The orders table is already one row per order and
--  already upserts; copying it into a second table would create two answers to
--  "what do I hold" that can disagree, and the wrong one would be believed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.position AS
SELECT symbol,
       trading_date,
       sum(CASE WHEN side = 'BUY'  THEN COALESCE(filled_quantity, 0) ELSE 0 END)::bigint AS bought,
       sum(CASE WHEN side = 'SELL' THEN COALESCE(filled_quantity, 0) ELSE 0 END)::bigint AS sold,
       (sum(CASE WHEN side = 'BUY'  THEN COALESCE(filled_quantity, 0) ELSE 0 END)
      - sum(CASE WHEN side = 'SELL' THEN COALESCE(filled_quantity, 0) ELSE 0 END))::bigint AS net_qty,
       -- net_value carries the broker's own figure including fees, so the P&L
       -- is the broker's arithmetic rather than ours.
       sum(CASE WHEN side = 'SELL' THEN COALESCE(net_value, 0) ELSE 0 END)
     - sum(CASE WHEN side = 'BUY'  THEN COALESCE(net_value, 0) ELSE 0 END) AS net_pnl,
       sum(COALESCE(executions, 1))::integer AS executions,
       count(*)::integer AS orders,
       max(last_seen_at) AS last_seen_at
  FROM public.awsat_order_list
 WHERE COALESCE(filled_quantity, 0) > 0
 GROUP BY symbol, trading_date;

COMMENT ON VIEW public.position IS
  'Holdings derived from awsat_order_list, which is already one row per '
  'order_id. A view rather than a table: two stored answers to "what do I '
  'hold" can disagree, and the wrong one would be believed.';

-- ---------------------------------------------------------------------------
--  slot — 3 pre-day, 5 wake-up [spec 7, 8, 9].
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.slot (
  id            bigserial   PRIMARY KEY,
  trading_date  date        NOT NULL,
  kind          text        NOT NULL,              -- [spec] PREDAY | WAKEUP
  slot_no       smallint    NOT NULL,              -- [derived] 1..3 or 1..5
  symbol        text,                              -- NULL until filled

  assigned_at   timestamptz,
  pace          numeric,                           -- [spec] the eviction key
  replaced      text,                              -- [spec] the symbol evicted
  replaced_at   timestamptz,

  CONSTRAINT slot_key UNIQUE (trading_date, kind, slot_no),
  CONSTRAINT slot_kind_valid CHECK (kind IN ('PREDAY', 'WAKEUP')),
  CONSTRAINT slot_no_in_range CHECK (
    (kind = 'PREDAY' AND slot_no BETWEEN 1 AND 3)
    OR (kind = 'WAKEUP' AND slot_no BETWEEN 1 AND 5)
  )
);

COMMENT ON COLUMN public.slot.pace IS
  'The measure the eviction rule compares. The Step 3 list says "replace the '
  'lowest-pace slot" without defining pace; this stores whatever the caller '
  'supplies so the rule works and the definition can be settled separately.';
COMMENT ON COLUMN public.slot.replaced IS
  'The symbol this slot previously held. Kept so a replacement is auditable — '
  'a slot that silently changes hands loses the reason it changed.';

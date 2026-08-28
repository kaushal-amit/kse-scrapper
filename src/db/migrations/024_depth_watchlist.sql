-- ===========================================================================
--  024_depth_watchlist.sql — which symbols the depth scraper is watching
--
--  THE STATE lives here. signal_log.slot records what FIRED — history, not
--  state. Collapsing the two into signal_log gave two answers to "which symbol
--  holds slot 4", and the one that got read was whichever query ran.
--
--  Rows are INSERTED ON CLAIM. An unclaimed slot is an absent row, not a row
--  with a NULL symbol: writing a row to represent an absence puts a fact in the
--  table that is not a measurement, and something would then have to create
--  them nightly.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.depth_watchlist (
  trading_date  date        NOT NULL,
  slot_no       smallint    NOT NULL CHECK (slot_no BETWEEN 1 AND 8),
  symbol        text,
  slot_type     text        NOT NULL CHECK (slot_type IN ('PRE_DAY', 'WAKEUP')),
  assigned_at   timestamptz DEFAULT now(),
  released_at   timestamptz,
  assigned_by   text,
  replaced      text,
  PRIMARY KEY (trading_date, slot_no)
);

-- Slots 1-3 are chosen the night before, 4-8 fill from 09:00. Enforcing the
-- split here means a wake-up cannot take a pre-day slot by accident.
ALTER TABLE public.depth_watchlist
  DROP CONSTRAINT IF EXISTS depth_watchlist_slot_type_range;
ALTER TABLE public.depth_watchlist
  ADD CONSTRAINT depth_watchlist_slot_type_range CHECK (
    (slot_type = 'PRE_DAY' AND slot_no BETWEEN 1 AND 3)
    OR (slot_type = 'WAKEUP' AND slot_no BETWEEN 4 AND 8));

-- One symbol cannot hold two slots on one day.
CREATE UNIQUE INDEX IF NOT EXISTS depth_watchlist_one_slot_per_symbol
  ON public.depth_watchlist (trading_date, symbol)
  WHERE symbol IS NOT NULL AND released_at IS NULL;

CREATE INDEX IF NOT EXISTS depth_watchlist_day_idx
  ON public.depth_watchlist (trading_date, slot_no);

COMMENT ON TABLE public.depth_watchlist IS
  'THE STATE: which symbol holds which depth slot today. /depth-symbols reads '
  'it, the wake-up scan writes it. signal_log.slot is history, not state.';
COMMENT ON COLUMN public.depth_watchlist.replaced IS
  'The symbol evicted from this slot, if any. A slot that changes hands '
  'silently loses the reason it changed.';

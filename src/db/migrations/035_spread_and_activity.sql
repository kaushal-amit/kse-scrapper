-- ===========================================================================
--  035_spread_and_activity.sql — five columns the backend computed and we did not
--
--  Found by comparing spread.symbol_day (53 columns) against ours. Most of its
--  list was the same measurement under a different name — close_fils is
--  close_px, trade_count is trades — but five were real.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The spread, in BOTH units, and why one alone misleads.
--
-- EKTTITAB reads 0.15 fils and looks tightest on the board. It is a 0.1-tick
-- stock, so that is 1.5 ticks — WIDER than GFH at 1.00 fils, which is 1 tick.
-- The raw number conflates tick bands and ranks them backwards.
--
-- avg_spread_pct is what rangeOverCost already divides by, and it is comparable
-- across every symbol. In practice the spread is one fil almost everywhere in
-- the tradeable band, so the percentage is really a PRICE measure: 0.36% at 278
-- fils, 0.54% at 188. Against a 0.30% round trip that is the whole economics in
-- one column.
--
-- Computed from the quotes, so it exists for all 142 symbols — unlike
-- spread_fils_p10..p90, which needs depth and is NULL for 123 of them.
-- ---------------------------------------------------------------------------
ALTER TABLE public.symbol_day
  ADD COLUMN IF NOT EXISTS avg_spread_fils numeric,
  ADD COLUMN IF NOT EXISTS avg_spread_pct  numeric,
  ADD COLUMN IF NOT EXISTS days_active     integer,
  ADD COLUMN IF NOT EXISTS down_days       integer,
  ADD COLUMN IF NOT EXISTS peak_hour       integer;

COMMENT ON COLUMN public.symbol_day.avg_spread_pct IS
  'avg_spread_fils / close_px. THE ONE TO COMPARE ACROSS SYMBOLS: the raw fils '
  'figure ranks a 0.1-tick stock as tighter than a 1-fil stock when it is '
  'wider in ticks. rangeOverCost divides by this.';
COMMENT ON COLUMN public.symbol_day.days_active IS
  'Sessions this symbol traded in the last 20 WITH DATA. A stock active 3 of 20 '
  'is a different proposition from one active 20, and nothing else says so in a '
  'number.';
COMMENT ON COLUMN public.symbol_day.down_days IS
  'Consecutive sessions closing down, this one included. chg_1d gives one day; '
  'a run length needs the sequence.';
COMMENT ON COLUMN public.symbol_day.peak_hour IS
  'The Kuwait hour carrying the most trades. The MRC finding — volume dying '
  'after 10:00 — at hour granularity rather than the two halves.';

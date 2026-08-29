-- ===========================================================================
--  032_close_precedence_and_flow.sql
--
--  Two things: how the close and the range are chosen, and eight columns that
--  describe the shape of a session's trading rather than its totals.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1 · range_source — why a range is what it is
--
-- Fourteen of 29 captured days ended at 12:59 or earlier, so their ranges are
-- as truncated as their closes and nothing said so. Range drives
-- rangeOverCost and several gates, which makes an unmarked short range a wrong
-- gate rather than a cosmetic gap.
-- ---------------------------------------------------------------------------
ALTER TABLE public.symbol_day
  ADD COLUMN IF NOT EXISTS range_source text;

ALTER TABLE public.symbol_day DROP CONSTRAINT IF EXISTS symbol_day_range_source_valid;
ALTER TABLE public.symbol_day ADD CONSTRAINT symbol_day_range_source_valid CHECK (
  range_source IS NULL OR range_source IN ('FULL', 'SHORT', 'CB_ONLY'));

COMMENT ON COLUMN public.symbol_day.range_source IS
  'FULL: continuous trading ran to 13:10. SHORT: it ended early, so this is not '
  'the day''s range. CB_ONLY: the range was set by a circuit-breaker auction. '
  'NULL where there was no usable range at all.';

-- close_source gains the two tiers the precedence walk can now reach.
ALTER TABLE public.symbol_day DROP CONSTRAINT IF EXISTS symbol_day_close_source_valid;
ALTER TABLE public.symbol_day ADD CONSTRAINT symbol_day_close_source_valid CHECK (
  close_source IS NULL OR close_source IN
    ('CLOSE_OF_DAY', 'CLOSING', 'TRADING_AT_LAST', 'AUCTION', 'TRADING'));

-- ---------------------------------------------------------------------------
-- 2 · The shape of the session, not its totals
--
-- ─── WHY VOLUME DELTA AND NOT last_qty ─────────────────────────────────────
-- Measured both. They disagree in SIGN on two of six cases and last_qty gets
-- both backwards:
--
--     TIJARA 16 Aug   173 -> 181, free    delta 4.99    last_qty 0.71
--     MRC    16 Aug   fell that week      delta 0.17    last_qty 2.14
--
-- last_qty is ONE print sampled at capture time; with 60-second polling that is
-- a single trade out of dozens. The volume delta is everything that traded in
-- the interval.
--
-- ─── WHY THE COUNTS ARE STORED ─────────────────────────────────────────────
-- A minimum-count threshold would have discarded the best evidence: MRC on
-- 16 August had 7 up-moves and 9 down — below any sensible minimum, and the
-- case that preceded the fall. Storing n_upticks and n_downticks lets a gate
-- demand ten a side while the analysis can look at seven and know it is seven.
-- Same principle as close_source: record why a number is weak rather than
-- throwing it away.
-- ---------------------------------------------------------------------------
ALTER TABLE public.symbol_day
  ADD COLUMN IF NOT EXISTS avg_uptick_shares    numeric,
  ADD COLUMN IF NOT EXISTS avg_downtick_shares  numeric,
  ADD COLUMN IF NOT EXISTS uptick_ratio         numeric,
  ADD COLUMN IF NOT EXISTS n_upticks            integer,
  ADD COLUMN IF NOT EXISTS n_downticks          integer,
  ADD COLUMN IF NOT EXISTS turnover_kd          numeric,
  ADD COLUMN IF NOT EXISTS first_half_shares_per_min numeric,
  ADD COLUMN IF NOT EXISTS second_half_shares_per_min numeric;

COMMENT ON COLUMN public.symbol_day.uptick_ratio IS
  'avg_uptick_shares / avg_downtick_shares, from VOLUME DELTAS. Under 0.5 looks '
  'like distribution, above 2.0 like accumulation — but that is a HYPOTHESIS '
  'from fifteen observations across five symbols, not a rule. Logged, never '
  'gated, until ten sessions of signal_log say otherwise. '
  'GFH 24-25 Aug read 0.06 where buy_sell_ratio is NULL by design (91% '
  'at-offer), so this is the only flow measure that speaks on such a stock.';

COMMENT ON COLUMN public.symbol_day.n_upticks IS
  'How many volume-bearing steps the up average is built from. MRC on 16 August '
  'had 7 — below any sensible gate, and the case that preceded the fall.';

-- ─── THE SPLIT IS 11:15, NOT NOON ──────────────────────────────────────────
-- The Kuwait session runs 09:00-13:30, so its midpoint is 11:15. Named
-- first_half/second_half rather than am/pm precisely BECAUSE the split is not
-- noon: a column called am_shares_per_min that changes at 11:15 is the
-- moves_2plus mistake again, where the name said one thing and the rule did
-- another.
COMMENT ON COLUMN public.symbol_day.first_half_shares_per_min IS
  'Shares per minute from 09:00 to 11:15 Kuwait — the session midpoint, NOT '
  'noon. Pairs with second_half_shares_per_min: MRC''s volume dying after 10:00 '
  'is invisible in a daily total and visible as a collapse between the halves.';

COMMENT ON COLUMN public.symbol_day.turnover_kd IS
  'Value traded, in KD. Sum of the volume delta times the price at each step.';

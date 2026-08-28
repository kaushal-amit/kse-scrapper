-- ===========================================================================
--  023_market_day_columns.sql — two columns and one rename
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- How many of the day's symbols had a THIN capture.
--
-- THIN rows are INCLUDED in breadth — excluding them would make breadth jump
-- on days with patchy capture, which is worse than a slightly noisy figure.
-- But then a strange reading needs an explanation, and this is it.
-- ---------------------------------------------------------------------------
ALTER TABLE public.market_day
  ADD COLUMN IF NOT EXISTS thin_symbols integer;

COMMENT ON COLUMN public.market_day.thin_symbols IS
  'Symbols whose capture was THIN that day. They still count toward breadth; '
  'this exists so an odd pct_advancing is explainable rather than mysterious.';

-- ---------------------------------------------------------------------------
-- The other denominator, stored alongside rather than instead.
--
-- pct_advancing is advancing / symbols_traded — the number the thresholds were
-- set against, and the more honest one: a day where 60 rise, 50 fall and 26 do
-- not move is not risk-on, and the ratio denominator discards those 26.
--
-- This is advancing / (advancing + declining), kept so the two can be compared
-- over 20 sessions. If the ratio version discriminates better the threshold can
-- move THEN, with evidence rather than by preference.
-- ---------------------------------------------------------------------------
ALTER TABLE public.market_day
  ADD COLUMN IF NOT EXISTS pct_advancing_ratio numeric;

COMMENT ON COLUMN public.market_day.pct_advancing_ratio IS
  'advancing / (advancing + declining). Comparison only — regime is decided by '
  'pct_advancing, which uses the full denominator.';

-- ---------------------------------------------------------------------------
-- "pace" means the intraday scan: trades_today over the median for THIS HOUR
-- across the last 10 sessions. This column is a whole-day proxy against a
-- 5-day average — a different window entirely.
--
-- Two things called pace measuring different windows is how a number gets read
-- as something it is not.
-- ---------------------------------------------------------------------------
ALTER TABLE public.market_day
  RENAME COLUMN symbols_over_3x_pace TO symbols_over_3x_daily;

COMMENT ON COLUMN public.market_day.symbols_over_3x_daily IS
  'Symbols whose trade count was 3x their own 5-day trailing average. A '
  'WHOLE-DAY proxy — not the intraday pace the wake-up scan uses.';

-- ===========================================================================
--  021_symbol_day_gap_and_renames.sql — three corrections before the compute
--                                       job writes a single row
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- How far back chg_5d actually reached, in CALENDAR days.
--
-- prev_session(d, 5) walks five sessions WITH DATA. With 19, 20 and 23 August
-- missing, five sessions back from the 25th lands on the 14th — an eleven-day
-- span called "5d". prev_session_used records WHICH date; this records HOW FAR,
-- so the span is a value someone can filter on rather than a surprise they
-- discover.
-- ---------------------------------------------------------------------------
ALTER TABLE public.symbol_day
  ADD COLUMN IF NOT EXISTS prev_session_gap_days integer;

COMMENT ON COLUMN public.symbol_day.prev_session_gap_days IS
  'Calendar days between trading_date and prev_session_used. A 5-SESSION '
  'change can span 11 calendar days when sessions are missing.';

-- ---------------------------------------------------------------------------
-- Did the price cross the 100-fil tick boundary during the day?
--
-- Below 100 the tick is 0.1 fils; at or above it is 1 fil. A stock that closes
-- at 99 after trading above 100 had TWO tick regimes in one session, so per-fil
-- economics are wrong for part of it.
--
-- A boolean rather than a log line: this is the same class of error that made
-- COAST read "+5.00 a fil" when it was -2.56, and a per-fil calculation on the
-- wrong band is invisibly wrong. Archaeology in a log file does not prevent it;
-- a column you can filter on does.
-- ---------------------------------------------------------------------------
ALTER TABLE public.symbol_day
  ADD COLUMN IF NOT EXISTS tick_band_crossed boolean;

COMMENT ON COLUMN public.symbol_day.tick_band_crossed IS
  'close_px < 100 AND high_px >= 100 — two tick regimes in one session, so '
  'per-fil economics are wrong for part of the day.';

-- ---------------------------------------------------------------------------
-- The names said "moves", the specification said "up-moves".
--
-- Both count UP moves only. Renaming now costs one migration on an empty
-- table; leaving it costs explaining the discrepancy to everyone who reads the
-- column for as long as it exists.
-- ---------------------------------------------------------------------------
ALTER TABLE public.symbol_day RENAME COLUMN moves_2plus TO up_moves_2plus;
ALTER TABLE public.symbol_day RENAME COLUMN moves_3plus TO up_moves_3plus;

COMMENT ON COLUMN public.symbol_day.up_moves_2plus IS
  'UP moves of 2+ fils, on volume-bearing minutes only.';
COMMENT ON COLUMN public.symbol_day.up_moves_3plus IS
  'UP moves of 3+ fils, on volume-bearing minutes only.';

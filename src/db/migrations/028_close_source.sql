-- ===========================================================================
--  028_close_source.sql — say WHICH session the close came from
--
--  14 of 29 captured days have a close_px that is not the official close.
--  Through 27 July the scraper stopped at 12:59 Kuwait — thirty minutes early —
--  so Close-Of-Day, Trading at Last and the closing auction never existed to
--  capture. close_px on those days is the last continuous Trading print, which
--  is precisely the TIJARA 172-instead-of-176 error, systematically, on every
--  symbol.
--
--  ─── RECORD, DO NOT REFUSE ────────────────────────────────────────────────
--  A 12:59 print is wrong by a fil or two, not by a sign, and refusing those
--  days would delete half the history for an error that is usually small.
--
--  But data_quality = THIN only says "something was wrong". close_source says
--  exactly what, and lets anything downstream decide for itself.
-- ===========================================================================

ALTER TABLE public.symbol_day
  ADD COLUMN IF NOT EXISTS close_source text;

ALTER TABLE public.symbol_day DROP CONSTRAINT IF EXISTS symbol_day_close_source_valid;
ALTER TABLE public.symbol_day ADD CONSTRAINT symbol_day_close_source_valid CHECK (
  close_source IS NULL
  OR close_source IN ('CLOSE_OF_DAY', 'TRADING_AT_LAST', 'AUCTION', 'TRADING'));

COMMENT ON COLUMN public.symbol_day.close_source IS
  'Which session close_px came from. CLOSE_OF_DAY is the official close; '
  'TRADING means capture stopped before it and the price is the last '
  'continuous print — the TIJARA 172-vs-176 error. NULL where there was no '
  'close at all: close_px IS NULL already says that, and a fifth value would '
  'only duplicate it.';

-- ---------------------------------------------------------------------------
-- The session functions are CONVENIENCE WRAPPERS, not the definition.
--
-- computeSymbolDay stopped calling prev_session_sym() per symbol when the
-- backfill was taking five minutes a day: it now runs one query for every
-- symbol with the session rule inlined, and a day takes 787ms.
--
-- So a fix applied only to these functions would change nothing that runs.
-- Two definitions of one rule is the risk; naming the authoritative one is the
-- cheapest mitigation available, and several minutes per backfill is not.
-- ---------------------------------------------------------------------------
COMMENT ON FUNCTION public.prev_session_sym(text, date) IS
  'CONVENIENCE WRAPPER for ad-hoc queries. NOT authoritative. The rule that '
  'runs lives in src/jobs/computeSymbolDay.js -> previousCloses(), which also '
  'skips days where the symbol has no close and caps the reach at 5 sessions. '
  'This function does neither.';

COMMENT ON FUNCTION public.prev_session(date, integer) IS
  'CONVENIENCE WRAPPER for ad-hoc queries. NOT authoritative. See '
  'src/jobs/computeSymbolDay.js -> closesFiveSessionsBack().';

COMMENT ON FUNCTION public.session_close(text, date) IS
  'CONVENIENCE WRAPPER for ad-hoc queries. The compute job inlines this rule '
  'and additionally records close_source. See src/jobs/computeSymbolDay.js.';

-- ===========================================================================
--  036_symbol_minute_source.sql — where a minute row came from
--
--  symbol_minute is written every 20 seconds by signals.fast, capturing the
--  book AS IT IS. A backfill reconstructs the same rows from stored quotes at
--  whatever interval the capture happened to run — about 60 seconds.
--
--  Those are not the same thing, and a row that cannot say which it is has to
--  be ASSUMED. Same argument as close_source: bid_age_secs and wall_event are
--  computed from the gap to the previous row, so a reconstructed row carries
--  coarser ages than a live one, and BAIT_BID (which needs an age under 300s)
--  may behave differently.
-- ===========================================================================

ALTER TABLE public.symbol_minute
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'LIVE';

ALTER TABLE public.symbol_minute DROP CONSTRAINT IF EXISTS symbol_minute_source_valid;
ALTER TABLE public.symbol_minute ADD CONSTRAINT symbol_minute_source_valid
  CHECK (source IN ('LIVE', 'BACKFILL'));

COMMENT ON COLUMN public.symbol_minute.source IS
  'LIVE: written by signals.fast during the session, roughly every 20 seconds. '
  'BACKFILL: reconstructed from awsat_market_quotes at the capture interval, '
  'roughly 60 seconds — so ages are coarser and a signal that fires on '
  'backfilled rows may not fire live. A LIVE row is never overwritten by a '
  'backfill.';

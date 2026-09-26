-- ===========================================================================
--  056_drop_range_source.sql — C3 · the column goes
--
--  055 stopped writing it and set every row NULL. This removes it.
--
--  ─── IT WILL REFUSE IF BACKEND 079 HAS NOT BEEN DEPLOYED ───────────────────
--  spread.symbol_day projects range_source, and Postgres will not drop a
--  column a view depends on. That refusal is the safety mechanism, not an
--  obstacle: deploy backend 079 first, which rebuilds the view without it.
--
--  This is the OPPOSITE order from this week's other cross-repo pair. Scraper
--  051 had to precede backend 076, because the view there read something NEW
--  and running it early left broken views. Here the view reads something OLD,
--  so running this early fails loudly and changes nothing. One pair fails
--  safe, the other does not; the difference is which side is adding.
--
--  ─── WHY 053 DID NOT TAKE IT ───────────────────────────────────────────────
--  053 dropped 45 columns that had no writer, and deliberately dropped no view
--  so that Postgres would refuse anything the dependency scan had missed.
--  range_source HAD a writer, so it was not in that set — it was worse than
--  unwritten, it was written wrongly. The scan was right to leave it.
-- ===========================================================================

ALTER TABLE public.symbol_day DROP COLUMN IF EXISTS range_source;

DO $$
DECLARE still int;
BEGIN
  SELECT count(*) INTO still FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'symbol_day'
     AND column_name = 'range_source';
  IF still > 0 THEN
    RAISE EXCEPTION '056 FAILED: range_source is still on public.symbol_day.';
  END IF;
END $$;

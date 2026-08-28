-- ===========================================================================
--  019_depth_captured_at.sql — the snapshot key
--
--  Ten levels of one book share ONE capture moment. Without that column,
--  reconstructing a snapshot depends on ten rows landing in the same
--  millisecond of created_at — which is insert time, not capture time.
--
--  Worse than luck: the migration set created_at from `created_at || captured_at`,
--  so some rows carry capture time and some carry insert time in the same
--  column. Mixed provenance is harder to detect than a uniform mistake.
-- ===========================================================================

ALTER TABLE public.awsat_stock_depth
  ADD COLUMN IF NOT EXISTS captured_at timestamptz;

-- Backfill from created_at so the column is never NULL for existing rows: for
-- migrated data the two are the same instant, and a NULL here would break the
-- unique key below.
UPDATE public.awsat_stock_depth SET captured_at = created_at WHERE captured_at IS NULL;

ALTER TABLE public.awsat_stock_depth ALTER COLUMN captured_at SET NOT NULL;

-- The key becomes the SNAPSHOT, not the insert. Two captures of one symbol a
-- second apart are two books; the old key could not tell them apart if the
-- inserts landed together.
ALTER TABLE public.awsat_stock_depth DROP CONSTRAINT IF EXISTS awsat_depth_key;
ALTER TABLE public.awsat_stock_depth
  ADD CONSTRAINT awsat_depth_key UNIQUE (symbol, level, captured_at, ingest_source);

CREATE INDEX IF NOT EXISTS awsat_depth_snapshot_idx
  ON public.awsat_stock_depth (symbol, captured_at DESC);

COMMENT ON COLUMN public.awsat_stock_depth.captured_at IS
  'When the BOOK was read. Ten levels share one value — this is what groups a '
  'snapshot. created_at is insert time and groups correctly only by accident.';

-- The Boursa numeric code, which the source carries and the target lacked.
-- KPPC->PHC was a rename with both sharing code 624, so the code outlives the
-- ticker and is the only stable identifier across one.
ALTER TABLE public.awsat_stock_depth ADD COLUMN IF NOT EXISTS code text;

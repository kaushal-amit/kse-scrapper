-- ============================================================================
-- 043 · validate 042's constraint — the scan, on its own.
--
-- Separated from 042 so the declaration (cheap, safe any time) and the scan
-- (expensive) are two decisions. VALIDATE CONSTRAINT takes SHARE UPDATE
-- EXCLUSIVE, not ACCESS EXCLUSIVE: it scans the table while INSERTs continue,
-- which is exactly the property that makes it safe to run while a session is
-- live. It still reads every row, so prefer to run it after the close.
--
-- If any existing row violates it this FAILS and the migration stops — which is
-- the right outcome. A lower-case symbol already in the table is a real defect
-- with real consequences downstream (a split history, a join matching nothing),
-- and it needs to be looked at rather than migrated past. Find them with:
--
--   SELECT DISTINCT symbol FROM public.awsat_market_quotes
--    WHERE symbol <> upper(symbol);
-- ============================================================================

ALTER TABLE public.awsat_market_quotes
  VALIDATE CONSTRAINT awsat_quotes_symbol_upper;

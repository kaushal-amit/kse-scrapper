-- ============================================================================
-- 042 · symbols on awsat_market_quotes are UPPER CASE — declared, NOT VALID.
--
-- Every writer upper-cases the symbol (parse.toSymbol, the ingest mapper, the
-- bulk slot endpoint). Nothing enforced it, so the one path that ever forgot
-- would write 'cattl' and it would sit beside 'CATTL' as a different symbol:
-- a separate row in symbol_day, a separate entry in instruments, and a join
-- that silently matches nothing. That is the worst shape of bug here — not an
-- error, a quiet halving of a symbol's history.
--
-- ADDED **NOT VALID**, DELIBERATELY.
--
-- awsat_market_quotes held 838,762 rows at migration 014 and grows every
-- minute of every session. A validating ADD CONSTRAINT takes ACCESS EXCLUSIVE
-- and scans the whole table; run during a session it queues behind any open
-- scraper transaction, and every quote insert then queues behind IT. A trading
-- minute cannot be re-scraped, so a lock that stalls the capture costs data.
--
-- NOT VALID takes a much weaker lock and applies to every NEW row immediately.
-- The scan happens in 043, separately, so the two can be run at different times
-- if the first one has to be done during market hours.
-- ============================================================================

ALTER TABLE public.awsat_market_quotes
  DROP CONSTRAINT IF EXISTS awsat_quotes_symbol_upper;

ALTER TABLE public.awsat_market_quotes
  ADD CONSTRAINT awsat_quotes_symbol_upper
  CHECK (symbol = upper(symbol)) NOT VALID;

COMMENT ON CONSTRAINT awsat_quotes_symbol_upper ON public.awsat_market_quotes IS
  '042 · declared NOT VALID so it binds new rows without an ACCESS EXCLUSIVE '
  'table scan during a session. 043 validates the existing rows.';

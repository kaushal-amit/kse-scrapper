-- ===========================================================================
--  022_quote_lookup_index.sql — the index session_close() has always needed
--
--  session_close(symbol, day) and prev_session_sym(symbol, day) both filter on
--  (symbol, trading_date) and order by created_at. Without an index that is a
--  sequential scan over ~975,000 rows, and computeSymbolDay called them twice
--  per symbol — 272 scans per session.
--
--  That is why the backfill took 87 seconds for 14 July and nearly five
--  minutes for the 15th: each later day has more history to scan through.
-- ===========================================================================

CREATE INDEX IF NOT EXISTS awsat_quotes_symbol_day_idx
  ON public.awsat_market_quotes (symbol, trading_date, created_at DESC);

-- prev_session(d, n) asks the same question market-wide.
CREATE INDEX IF NOT EXISTS awsat_quotes_day_idx
  ON public.awsat_market_quotes (trading_date);

ANALYZE public.awsat_market_quotes;

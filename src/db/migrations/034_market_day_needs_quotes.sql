-- ===========================================================================
--  034_market_day_needs_quotes.sql — a session must have traded
--
--  Two market_day rows describe 28 and 29 August: days on which nothing traded.
--  They were written by the old market-summary endpoint from a panel showing
--  THURSDAY's close, captured after the market shut.
--
--  They are not merely wrong, they are LOAD-BEARING: the endpoint derives
--  trading_date from `market_day WHERE total_volume > 0`, so these rows make
--  the derivation return a non-session day. A wrong row that nothing reads is
--  clutter; a wrong row that something reads is a wrong answer.
-- ===========================================================================

DELETE FROM public.market_day md
 WHERE NOT EXISTS (
   SELECT 1 FROM public.awsat_market_quotes q
    WHERE q.trading_date = md.trading_date);

COMMENT ON TABLE public.market_day IS
  'One row per SESSION. A row may only exist for a date with rows in '
  'awsat_market_quotes — daily.marketday refuses to write otherwise. Without '
  'that guard the market-summary endpoint created rows for days that never '
  'traded, and its own trading_date derivation then read them back.';

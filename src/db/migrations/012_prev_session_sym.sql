-- ===========================================================================
--  012_prev_session_sym.sql — name the two prev_session forms apart
--
--  010 defined prev_session(symbol, day). 011 added the specification's
--  prev_session(date, int). Two functions of the same name with different
--  argument types resolve by overload, and a caller that passes the wrong
--  shape gets the wrong answer SILENTLY — market-wide where it meant
--  per-symbol, or the reverse.
--
--  A symbol suspended for three days has a different previous session from the
--  market's, so both are needed. They just must not share a name.
-- ===========================================================================

CREATE OR REPLACE FUNCTION prev_session_sym(p_symbol text, p_day date)
RETURNS date LANGUAGE sql STABLE AS $$
  SELECT max(trading_date)
    FROM awsat_market_quotes
   WHERE symbol = p_symbol
     AND trading_date < p_day
$$;

COMMENT ON FUNCTION prev_session_sym(text, date) IS
  'The previous session WITH DATA for one symbol. Use prev_session(d, n) for '
  'the market-wide question; a suspended symbol differs from the market.';

DROP FUNCTION IF EXISTS prev_session(text, date);

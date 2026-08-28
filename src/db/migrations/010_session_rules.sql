-- ===========================================================================
--  010_session_rules.sql — the two session rules, as database functions
--
--  These come from the TMI Engine 01 discussion. They are implemented here
--  because both are currently WRONG in this codebase and each has already
--  produced a specific, known error. Neither depends on the symbol_day spec,
--  so neither has to wait for it.
--
--  They are FUNCTIONS, not copied logic, so the close rule and the previous
--  session are computed one way everywhere — the history job, the analysis
--  job, and any ad-hoc query. A rule reimplemented per caller is a rule that
--  will disagree with itself.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- RULE 1 · A close comes from ALL FOUR sessions, not from 'Trading' alone.
--
--   TIJARA read 172 instead of 176.
--
-- Filtering to session = 'Trading' cuts off the closing auction, so the last
-- price seen is the last CONTINUOUS trade rather than the actual close. The
-- difference is small, always in the same direction, and invisible unless
-- checked against the exchange.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION closing_sessions()
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['Trading', 'Trading at Last', 'Close-Of-Day', 'Pre-Open']::text[];
$$;

COMMENT ON FUNCTION closing_sessions() IS
  'Sessions whose prints count toward the close. Excluding the auction reads '
  'the last continuous trade as the close — TIJARA 172 instead of 176.';

-- ---------------------------------------------------------------------------
-- RULE 2 · The previous session is the previous session WITH DATA, never
--          trade_date - 1.
--
--   29-30 July were missing, and date - 1 made a change 6 fils wrong.
--
-- Subtracting a day lands on a weekend, a holiday, or a session that simply
-- was not captured — and the comparison is then against nothing, or against a
-- day two steps back while claiming to be one. Asking the data which session
-- came before cannot make that mistake.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION prev_session(p_symbol text, p_day date)
RETURNS date LANGUAGE sql STABLE AS $$
  SELECT max(trading_date)
    FROM awsat_market_quotes
   WHERE symbol = p_symbol
     AND trading_date < p_day
$$;

COMMENT ON FUNCTION prev_session(text, date) IS
  'The most recent session BEFORE p_day that actually has data for p_symbol. '
  'Never trade_date - 1: that lands on weekends, holidays and uncaptured days.';

-- Same question against the TradingView feed, for symbols the broker missed.
CREATE OR REPLACE FUNCTION prev_session_tv(p_symbol text, p_day date)
RETURNS date LANGUAGE sql STABLE AS $$
  SELECT max(trading_date)
    FROM tradingview_watchlist
   WHERE symbol = p_symbol
     AND trading_date < p_day
$$;

-- ---------------------------------------------------------------------------
-- The close itself, using rule 1.
--
-- DISTINCT ON rather than max(created_at) in a subquery: one scan, and the
-- price returned is provably the one belonging to that timestamp.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION session_close(p_symbol text, p_day date)
RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT last_price
    FROM awsat_market_quotes
   WHERE symbol = p_symbol
     AND trading_date = p_day
     AND last_price IS NOT NULL
     AND (session IS NULL OR session = ANY(closing_sessions()))
   ORDER BY created_at DESC
   LIMIT 1
$$;

COMMENT ON FUNCTION session_close(text, date) IS
  'Closing price using every session that counts. A NULL session is included: '
  'an unlabelled print is more likely a gap in capture than a print that '
  'should be excluded, and dropping it loses a real close.';

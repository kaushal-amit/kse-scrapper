-- ===========================================================================
--  029_delisted_not_tradeable.sql
--
--  A delisted stock is not tradeable, whatever market it sits on and whether or
--  not it is the primary symbol for its code.
--
--  BAREEQ is Main Market and primary, so the rule as written in 026 read it as
--  tradeable. Setting it here rather than leaving it to the first nightly run
--  keeps this to ONE market_day backfill: populating it tomorrow would move
--  pct_advancing again on every row computed today.
--
--    tradeable  140 -> 139
--
--  BAREEQ traded 8 sessions, 14-23 July, so only those days change.
-- ===========================================================================

UPDATE public.instruments
   SET is_tradeable = false, updated_at = now()
 WHERE broker_status = 'DELISTED';

-- is_primary stays TRUE. History does not disappear because a stock stopped
-- trading: BAREEQ keeps its 8 sessions in symbol_day and simply stops counting
-- in breadth.
COMMENT ON COLUMN public.instruments.is_tradeable IS
  'PRIMARY AND TRADEABLE ARE DIFFERENT QUESTIONS and the counts will differ. '
  'symbol_day filters on is_primary; market_day breadth and the depth slots '
  'filter on is_tradeable. '
  'A symbol is primary but NOT tradeable for two distinct reasons: it sits on '
  'the Auction Market, or it is DELISTED. Both are correct, neither is a '
  'discrepancy to be fixed, and they are different reasons for the same fact. '
  'is_primary is never set false by either — a delisted stock keeps its '
  'history.';

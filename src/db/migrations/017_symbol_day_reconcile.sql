-- ===========================================================================
--  017_symbol_day_reconcile.sql — four columns from the count reconciliation
--
--  The "90 columns" headline was stale prose; the DDL had 86 and nothing was
--  lost in transit. Two gaps found while reconciling are worth closing anyway.
--
--  87 -> 91.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- prev_session_used — WHICH session prev_close came from.
--
-- "prev_close is 100" and "prev_close is 100, from 28 July" are different
-- claims, and only the second can be checked. 29-30 July are missing from the
-- history, so a chg_1d computed across that gap is measuring three days while
-- calling itself one — and without this column nothing in the row says so.
--
-- prev_session() already knows the answer; this records it next to the number
-- it produced, which is what makes the number auditable rather than merely
-- present.
-- ---------------------------------------------------------------------------
ALTER TABLE public.symbol_day
  ADD COLUMN IF NOT EXISTS prev_session_used date;

COMMENT ON COLUMN public.symbol_day.prev_session_used IS
  'The session prev_close was taken from. Never assume trading_date - 1: '
  'weekends break it twice a week and 29-30 July are missing entirely. A '
  'chg_1d spanning a gap is measuring three days while calling itself one.';

-- ---------------------------------------------------------------------------
-- The spread percentiles, completed.
--
-- Every other book metric carries the full five points — bid_p10/25/50/75/90,
-- offer_p10/25/50/75/90, last_qty_p10/50/90. spread_fils carried only p50 and
-- p90, so the one distribution a spread-capture strategy cares about most was
-- the least described: p50 and p90 cannot show whether a stock is usually at
-- one fil and occasionally wide, or usually wide.
-- ---------------------------------------------------------------------------
ALTER TABLE public.symbol_day
  ADD COLUMN IF NOT EXISTS spread_fils_p10 numeric,
  ADD COLUMN IF NOT EXISTS spread_fils_p25 numeric,
  ADD COLUMN IF NOT EXISTS spread_fils_p75 numeric;

COMMENT ON COLUMN public.symbol_day.spread_fils_p10 IS
  'The tight end of the spread distribution. With only p50 and p90 there was '
  'no way to tell a stock that is usually one fil from one that is usually '
  'wide — the distinction the whole strategy rests on.';

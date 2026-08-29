-- ===========================================================================
--  033_market_summary_captures.sql — the film, not the photograph
--
--  ─── WHY ONE ROW A DAY WAS WRONG ───────────────────────────────────────────
--  The market summary was folded into market_day, one row per session, last
--  capture winning. The argument was that nothing reads a minute-by-minute
--  breadth series — true that day, false the moment anyone asks WHEN breadth
--  turned.
--
--      09:30   68% advancing     opened strong
--      11:00   52%
--      13:00   38%               sold off all session
--
--  Stored as one row that day reads 38% and looks like it opened weak. Two
--  findings this month came from exactly that shape: CATTL's flow going 12:5 to
--  4:5 across four hours, and MRC's volume dying after 10:00. Neither is
--  visible in a daily figure and both changed a decision.
--
--  260 rows a day. The storage argument was never real.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.awsat_market_summary (
  captured_at    timestamptz NOT NULL,
  trading_date   date        NOT NULL,
  session_state  text        NOT NULL,
  symbols_traded integer,
  advancing      integer,
  declining      integer,
  unchanged      integer,
  total_volume   bigint,
  total_trades   bigint,
  turnover_kd    numeric,
  index_close    numeric,
  index_ytd_pct  numeric,
  fields_found   integer,
  batch_id       text,
  source         text        NOT NULL DEFAULT 'awsat_client',
  received_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (captured_at)
);

-- ---------------------------------------------------------------------------
-- session_state — and why CLOSE is decided by the CLOCK, not by position.
--
--   LIVE    a trading day, captured before 13:30 Kuwait
--   CLOSE   a trading day, captured at or after 13:30
--   STALE   captured on a day that did not trade
--
-- Promoting whatever arrived LAST to CLOSE would make a truncated session look
-- complete: capture stopped at 12:23 on 26 August, and calling that the close
-- is a claim made in hindsight. With this rule that day simply has no CLOSE
-- row, which is the truth — nobody captured the close — and market_day then
-- falls back to computing, which broker_seen_at IS NULL already handles.
--
-- STALE exists because the panel on a shut market shows the LAST session. On
-- Friday it reads Thursday, and that is worth storing and worth marking, not
-- worth discarding or pretending is Friday.
-- ---------------------------------------------------------------------------
ALTER TABLE public.awsat_market_summary
  DROP CONSTRAINT IF EXISTS awsat_market_summary_state_valid;
ALTER TABLE public.awsat_market_summary
  ADD CONSTRAINT awsat_market_summary_state_valid
  CHECK (session_state IN ('LIVE', 'CLOSE', 'STALE'));

CREATE INDEX IF NOT EXISTS awsat_market_summary_session_idx
  ON public.awsat_market_summary (trading_date, captured_at DESC)
  WHERE session_state <> 'STALE';

COMMENT ON TABLE public.awsat_market_summary IS
  'One row per capture. The live screen reads this; market_day reads the last '
  'non-STALE capture of a session. ONE WRITER PER TABLE: the ingest endpoint '
  'writes here and never touches market_day.';
COMMENT ON COLUMN public.awsat_market_summary.trading_date IS
  'The session these figures DESCRIBE. Derived from days that actually traded '
  '— never from whatever rows happen to exist in awsat_market_quotes. The '
  'earlier rule consulted that table and gave two different answers ten minutes '
  'apart, because a quote row arrived in between: a derivation that changes as '
  'unrelated data arrives is not a derivation.';

-- ---------------------------------------------------------------------------
-- Clear broker_seen_at on the two rows written by the old endpoint.
--
-- Both hold Thursday 27 August's panel — captured on Friday, after the close,
-- with no summary row behind them. Leaving the stamp means daily.marketday
-- treats them as authoritative and never corrects them.
-- ---------------------------------------------------------------------------
UPDATE public.market_day
   SET broker_seen_at = NULL
 WHERE broker_seen_at IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.awsat_market_summary s
      WHERE s.trading_date = market_day.trading_date AND s.session_state <> 'STALE');

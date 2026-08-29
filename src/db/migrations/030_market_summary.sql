-- ===========================================================================
--  030_market_summary.sql — the broker's own market summary
--
--  The top panel reports Volume, Turnover, Trades, YTD %, Symbols Traded, UPs,
--  Down and Unchanged. Six of those already exist in market_day as COMPUTED
--  columns, so they are not stored twice — the broker's figures overwrite ours
--  on the same row.
--
--  ─── WHY THE BROKER WINS ───────────────────────────────────────────────────
--  market_day's breadth is a reconstruction from symbol_day. The exchange's own
--  count is not a reconstruction. Same relationship TradingView has to the
--  broker feed: a fallback for when the better source is missing, not a second
--  opinion to reconcile.
--
--  But the computed values are kept ALONGSIDE, because rule 3 asks "do they
--  disagree often" and a WARN in a log that rotates cannot answer that. A fact
--  that exists only where nobody will look is the job_runs mistake in a new
--  shape.
-- ===========================================================================

ALTER TABLE public.market_day
  ADD COLUMN IF NOT EXISTS turnover_kd        numeric,
  ADD COLUMN IF NOT EXISTS index_ytd_pct      numeric,
  ADD COLUMN IF NOT EXISTS index_close        numeric,
  ADD COLUMN IF NOT EXISTS broker_seen_at     timestamptz,
  ADD COLUMN IF NOT EXISTS computed_advancing integer,
  ADD COLUMN IF NOT EXISTS computed_declining integer,
  ADD COLUMN IF NOT EXISTS computed_symbols   integer;

COMMENT ON COLUMN public.market_day.broker_seen_at IS
  'When the broker''s own summary last overwrote the computed breadth. NULL '
  'means every figure on this row is ours. daily.marketday writes the six '
  'shared columns ONLY when this is NULL — otherwise a backfill would silently '
  'replace the exchange''s count with a reconstruction of it.';

COMMENT ON COLUMN public.market_day.computed_advancing IS
  'What OUR rule produced, written every run whatever the source. Kept so '
  '"how often do we disagree with the broker" is a query across every session '
  'rather than a grep through logs that rotate.';

COMMENT ON COLUMN public.market_day.pct_advancing IS
  'ALWAYS advancing / symbols_traded from the STORED row, whichever source '
  'wrote them. When the broker supplies the breadth this is a mix — their '
  'numerator, our denominator rule — and that is deliberate: the denominator '
  'choice is ours and was argued (a day where 60 rise, 50 fall and 26 sit '
  'still is not a risk-on day). regime follows this number.';

COMMENT ON COLUMN public.market_day.turnover_kd IS
  'Value traded in KD. Broker-only — market_day has never computed it.';
COMMENT ON COLUMN public.market_day.index_close IS
  'The headline index level. Broker-only.';

-- ---------------------------------------------------------------------------
-- client_submissions must accept the new kind.
--
-- Without this the CHECK rejects every market-summary row, recordSubmission
-- fails, and replayIfSeen finds nothing — so a retried batch is APPLIED AGAIN
-- rather than replayed. The idempotency the batchId exists for is silently
-- absent, and the failure appears only as a logged warning the client never
-- sees.
-- ---------------------------------------------------------------------------
ALTER TABLE public.client_submissions DROP CONSTRAINT IF EXISTS client_submissions_kind_valid;
ALTER TABLE public.client_submissions ADD CONSTRAINT client_submissions_kind_valid
  CHECK (kind IN ('quotes', 'depth', 'orders', 'market-summary'));

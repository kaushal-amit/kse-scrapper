-- ============================================================================
-- 044 · H11 — a board that stops CHANGING is degraded, not healthy.
--
-- THE FAILURE THIS CATCHES. The heartbeat proves a feed is posting. It cannot
-- prove the feed is posting anything NEW. A terminal whose websocket has died
-- keeps rendering the last board it received: the userscript reads 137 rows
-- every cycle, posts them, the server accepts them, client_heartbeat advances,
-- /health is green — and every price is frozen at whatever it was when the
-- socket dropped.
--
-- That is strictly worse than the feed stopping. A stopped feed leaves a gap
-- anyone can see. A frozen one writes plausible rows all session, and every
-- statistic built on them — the range, the tape quality, the still-rate — is
-- computed from a photograph.
--
-- WHAT THIS STORES. One fingerprint per accepted quotes batch: a hash over
-- (symbol, last_price, volume) for the whole board. Identical consecutive
-- fingerprints mean the board did not move between captures. Three in a row is
-- the threshold — two can happen legitimately in a quiet minute near the close;
-- three across a minute apart cannot, on a board of 137 symbols.
--
-- Deliberately NOT a per-symbol staleness check. Individual symbols DO go quiet
-- for minutes at a time, and flagging those would fire constantly. It is the
-- WHOLE BOARD being identical that is impossible.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.quote_fingerprint (
  id            bigserial PRIMARY KEY,
  trading_date  date        NOT NULL,
  captured_at   timestamptz NOT NULL,
  ingest_source text        NOT NULL,
  -- Hex digest over the board. Not the rows themselves: this table is written
  -- every capture and only ever compared for equality.
  fingerprint   text        NOT NULL,
  row_count     integer     NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS quote_fingerprint_day_idx
  ON public.quote_fingerprint (trading_date, ingest_source, captured_at DESC);

COMMENT ON TABLE public.quote_fingerprint IS
  '044 · one hash per accepted quotes batch. Identical consecutive fingerprints '
  'mean the BOARD did not change — a terminal rendering a dead socket. The '
  'heartbeat cannot see this: the feed is posting, it is just posting the same '
  'photograph.';

-- How many identical consecutive captures count as frozen. Shared with the
-- backend's FROZEN_CAPTURES so the two services agree on the word "degraded".
ALTER TABLE public.quote_fingerprint
  DROP CONSTRAINT IF EXISTS quote_fingerprint_rows_positive;
ALTER TABLE public.quote_fingerprint
  ADD CONSTRAINT quote_fingerprint_rows_positive CHECK (row_count > 0);

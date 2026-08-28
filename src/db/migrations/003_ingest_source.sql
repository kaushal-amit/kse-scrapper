-- ===========================================================================
--  003_ingest_source.sql — the same data from two collectors
--
--  AWSAT is now read two ways: server-side (Playwright, socket tap) and
--  client-side (Tampermonkey in the trader's own logged-in browser). Both see
--  the same board, so the question is not "how do we store both" but "which one
--  do we believe when they disagree".
--
--  RECONCILIATION BY PRECEDENCE, NOT BY DEDUPLICATION.
--
--  Storing only the first arrival would mean whichever collector happened to be
--  faster wins, which is not a decision — it is a race. Storing both would
--  double every row and every aggregate silently.
--
--  So each row records WHICH collector produced it, and a unique key that
--  ignores the collector. A later row from a HIGHER-precedence collector
--  replaces a lower one; a lower one never overwrites a higher.
--
--    awsat_client  precedence 2 — the trader's own authenticated session,
--                  reading the socket directly with no scraping in between
--    awsat_server  precedence 1 — headless session, same socket, but one more
--                  moving part between the exchange and the row
--    tradingview   precedence 0 — a different venue's view entirely
--
--  Client wins because it has strictly fewer failure modes: no separate login
--  to expire, no headless quirks, no session eviction.
-- ===========================================================================

ALTER TABLE live_quotes ADD COLUMN IF NOT EXISTS ingest_source text;
ALTER TABLE live_quotes ADD COLUMN IF NOT EXISTS source_precedence smallint NOT NULL DEFAULT 0;
ALTER TABLE live_quotes ADD COLUMN IF NOT EXISTS captured_at timestamptz;

-- Backfill: existing rows came from the server-side scraper or TradingView.
UPDATE live_quotes
   SET ingest_source = COALESCE(ingest_source,
         CASE WHEN source = 'awsat' THEN 'awsat_server' ELSE source END),
       source_precedence = CASE WHEN source = 'awsat' THEN 1 ELSE 0 END
 WHERE ingest_source IS NULL;

ALTER TABLE live_quotes
  ADD CONSTRAINT live_quotes_ingest_source_valid
  CHECK (ingest_source IS NULL
         OR ingest_source IN ('awsat_server', 'awsat_client', 'tradingview'));

CREATE INDEX IF NOT EXISTS live_quotes_source_idx
  ON live_quotes (ingest_source, trading_date);

-- ---------------------------------------------------------------------------
-- client_submissions — idempotency ledger for the userscript
--
-- The client retries on failure, and a retry that arrives after the original
-- succeeded must not insert a second time. The batch id is the client's own
-- idempotency key: seen once, the whole batch is a no-op and the stored result
-- is replayed, so the client gets the same answer either way.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS client_submissions (
  batch_id      text        PRIMARY KEY,
  ingest_source text        NOT NULL,
  kind          text        NOT NULL,
  captured_at   timestamptz,
  received_at   timestamptz NOT NULL DEFAULT now(),
  rows_offered  integer     NOT NULL DEFAULT 0,
  rows_inserted integer     NOT NULL DEFAULT 0,
  rows_rejected integer     NOT NULL DEFAULT 0,

  CONSTRAINT client_submissions_kind_valid
    CHECK (kind IN ('quotes', 'depth', 'orders'))
);

CREATE INDEX IF NOT EXISTS client_submissions_received_idx
  ON client_submissions (received_at DESC);

COMMENT ON TABLE client_submissions IS
  'Idempotency ledger for client-side submissions. A repeated batch_id replays '
  'the stored counts instead of inserting again, so a retry is always safe.';

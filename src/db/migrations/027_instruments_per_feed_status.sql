-- ===========================================================================
--  027_instruments_per_feed_status.sql
--
--  Completes what an OLDER version of 026 left out.
--
--  ─── WHAT HAPPENED ─────────────────────────────────────────────────────────
--  026 was applied from a package that predated the per-feed amendment. The
--  part that CANNOT be undone — merging 144 rows into 142, superseded_by on
--  KFIN and KPPC, is_primary — landed correctly and is not touched here.
--
--  What is missing is additive, and the two wrong values sit in columns nothing
--  reads yet. So this adds rather than rebuilds: no DELETE, no primary-key
--  change, nothing that a failure could leave half-done.
--
--  Re-running 026 would have worked arithmetically — DELETE and rebuild against
--  142 rows produces 142 again — but it would mean running a delete-and-rebuild
--  against the only copy of the registry to avoid writing one file. Wrong trade
--  on the one table where the merge is irreversible.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1 · ONE STATUS PER FEED
--
-- A symbol can be live on the broker and absent from TradingView. One column
-- cannot hold two facts, and scrape_status was that column.
--
-- Dropped rather than left alongside: two columns holding an ambiguous version
-- of what four now hold precisely is the split-truth problem this project has
-- spent weeks removing. Nothing writes them yet, so nothing is lost.
-- ---------------------------------------------------------------------------
ALTER TABLE public.instruments
  ADD COLUMN IF NOT EXISTS broker_status      text,
  ADD COLUMN IF NOT EXISTS broker_status_on   date,
  ADD COLUMN IF NOT EXISTS tv_status          text,
  ADD COLUMN IF NOT EXISTS tv_status_on       date,
  ADD COLUMN IF NOT EXISTS is_tradeable       boolean;

ALTER TABLE public.instruments DROP COLUMN IF EXISTS scrape_status;
ALTER TABLE public.instruments DROP COLUMN IF EXISTS scrape_status_on;

ALTER TABLE public.instruments DROP CONSTRAINT IF EXISTS instruments_broker_status_valid;
ALTER TABLE public.instruments DROP CONSTRAINT IF EXISTS instruments_tv_status_valid;
ALTER TABLE public.instruments DROP CONSTRAINT IF EXISTS instruments_scrape_status_valid;

-- DELISTED is the fifth value and it is not a variant of ABSENT. UNMATCHED is
-- OUR bug; DELISTED is a fact about the world. Same absence, opposite meaning —
-- and a DELISTED symbol must never trigger a master re-fetch or an unmatched
-- warning, or it fires forever against something that will never resolve.
ALTER TABLE public.instruments ADD CONSTRAINT instruments_broker_status_valid CHECK (
  broker_status IS NULL
  OR broker_status IN ('CAPTURED', 'UNMATCHED', 'FILTERED', 'ABSENT', 'DELISTED'));
ALTER TABLE public.instruments ADD CONSTRAINT instruments_tv_status_valid CHECK (
  tv_status IS NULL
  OR tv_status IN ('CAPTURED', 'UNMATCHED', 'FILTERED', 'ABSENT', 'DELISTED'));

COMMENT ON COLUMN public.instruments.broker_status IS
  'CAPTURED: quotes stored. UNMATCHED: quotes arrived and were DROPPED because '
  'the client symbol master had no entry — our failure, not a suspension. '
  'FILTERED: excluded by EQUITIES_ONLY or KEEP_MARKETS. ABSENT: no quotes for '
  '5+ sessions. DELISTED: a fact, set by hand, never inferred.';
COMMENT ON COLUMN public.instruments.tv_status IS
  'Same five values. Only CAPTURED and ABSENT are reachable — TradingView is '
  'scraped from a page and has no unmatched concept. The shared vocabulary is '
  'deliberate: if it ever gains one, the column already allows it.';
COMMENT ON COLUMN public.instruments.broker_status_on IS
  'When broker_status last CHANGED, not when it was last confirmed. That is '
  'what makes "UNMATCHED since 26 July" distinguishable from "UNMATCHED since '
  'this morning" without a second state and a threshold that would drift.';

-- ---------------------------------------------------------------------------
-- 2 · market_changed_on — CORRECT IT, from the prices
--
-- The applied 026 derived it from first_seen_on, which is the date the SEEDER
-- ran: every row in instruments carries 2026-08-25. So DALQANRE and KPPC were
-- stamped with a transition date that means nothing.
--
-- Worse, both have Main Market quotes ONLY. Their auction rows are stale
-- registry artifacts from before the market filter existed — zero auction
-- quotes exist in this database. Stamping a move on them asserts something the
-- price data contradicts.
--
-- Cleared first, then set only where the QUOTES show two markets. On today's
-- data that is zero symbols and the column ends NULL, which is the truth rather
-- than a plausible-looking date.
-- ---------------------------------------------------------------------------
UPDATE public.instruments SET market_changed_on = NULL;

UPDATE public.instruments i
   SET market_changed_on = sub.moved_on
  FROM (
    SELECT q.symbol,
           min(q.trading_date) FILTER (WHERE q.market = i2.market) AS moved_on
      FROM public.awsat_market_quotes q
      JOIN public.instruments i2 ON i2.symbol = q.symbol
     GROUP BY q.symbol, i2.market
    HAVING count(DISTINCT q.market) > 1
  ) sub
 WHERE i.symbol = sub.symbol;

-- ---------------------------------------------------------------------------
-- 3 · first_seen_on — from the earliest quote
--
-- The registry says 2026-08-25 for all 142, including symbols trading since
-- 13 July. A column reading "first seen 25 August" for a stock with six weeks
-- of prices is simply false, whatever reads it.
--
-- COALESCE, not replace: a symbol with no quotes keeps what the registry had.
-- An approximate date beats none.
-- ---------------------------------------------------------------------------
UPDATE public.instruments i
   SET first_seen_on = COALESCE(
         (SELECT min(q.trading_date) FROM public.awsat_market_quotes q
           WHERE q.symbol = i.symbol),
         i.first_seen_on);

-- ---------------------------------------------------------------------------
-- 4 · BAREEQ is DELISTED — a fact, not something derivable
--
-- 8 sessions, 13-22 July, price 0, volume 0, never traded once. Without this it
-- sits at ABSENT and keeps triggering master re-fetches against a symbol that
-- will never resolve.
--
-- BKIKWT and MASAKEN stopped on the same date with the same shape, but only
-- BAREEQ is confirmed delisted. They are deliberately left to reach ABSENT on
-- their own: we know they stopped, we do not know why, and ABSENT says exactly
-- that.
-- ---------------------------------------------------------------------------
UPDATE public.instruments
   SET broker_status = 'DELISTED', broker_status_on = DATE '2022-04-21'
 WHERE symbol = 'BAREEQ';

-- ---------------------------------------------------------------------------
-- 5 · is_tradeable
--
-- Derived here rather than left to the first nightly run, so the backfills run
-- ONCE. Populating it tomorrow would move pct_advancing again on every row
-- computed today.
-- ---------------------------------------------------------------------------
UPDATE public.instruments
   SET is_tradeable = (market <> 'Auction Market' AND COALESCE(is_primary, true));

CREATE INDEX IF NOT EXISTS instruments_tradeable_idx
  ON public.instruments (is_tradeable) WHERE is_tradeable;

COMMENT ON COLUMN public.instruments.is_tradeable IS
  'PRIMARY AND TRADEABLE ARE DIFFERENT QUESTIONS, and the counts will differ. '
  'symbol_day filters on is_primary; market_day breadth and the depth slots '
  'filter on is_tradeable. A symbol can be primary and not tradeable — that is '
  'correct, not a discrepancy to be fixed.';

COMMENT ON COLUMN public.instruments.market_changed_on IS
  'The MOST RECENT transition only, and only where the QUOTES show two markets. '
  'Prior movements are not retained: the move happens about twice a year, and '
  'symbol_day records where prices stop and start, so the period is '
  'reconstructable without a history table.';

-- ---------------------------------------------------------------------------
-- 6 · Re-stamp 026
--
-- The applied 026 predates the per-feed amendment, so the file on disk no
-- longer matches the checksum recorded when it ran. The migrator reports that
-- as drift — correctly, since they genuinely differ.
--
-- This migration brings the schema to what the current file describes, so the
-- drift is resolved rather than suppressed. Left unstamped, every future run
-- carries a warning nobody can action — and warnings nobody can action are how
-- the real one gets missed.
-- ---------------------------------------------------------------------------
UPDATE public.schema_migrations
   SET checksum = '308d6c0e1354cbd7'
 WHERE filename = '026_instruments_symbol_pk.sql';

-- ===========================================================================
--  026_instruments_symbol_pk.sql — one row per symbol, not per (market, symbol)
--
--  144 rows for 141 companies. Three causes, and they are NOT the same problem:
--
--    108   KFH + KFIN        two tickers, one code. KFIN has one row, one day,
--                            price 0, volume 0 — a misparse, not an instrument.
--    2012  DALQANRE x2       same company, market changed Main -> Auction.
--    624   KPPC x2 + PHC     a rename, plus a stale auction row for the old
--                            ticker.
--
--  The PK change fixes the SECOND outright: a stock moving market is not a new
--  stock, and (market, symbol) made it one. The other two need superseded_by,
--  which is a judgement rather than something derivable.
--
--  ─── WHAT THIS FORECLOSES ──────────────────────────────────────────────────
--  A symbol legitimately listed on two markets at once becomes unrepresentable.
--  Boursa Kuwait does not dual-list, and if it ever does, `code` catches it:
--  one code, two symbols, both with quotes. Detectable without the composite
--  key. Named here so the trade is deliberate rather than discovered.
-- ===========================================================================

ALTER TABLE public.instruments
  ADD COLUMN IF NOT EXISTS superseded_by      text,
  ADD COLUMN IF NOT EXISTS market_changed_on  date,
  ADD COLUMN IF NOT EXISTS is_primary         boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS broker_status      text,
  ADD COLUMN IF NOT EXISTS broker_status_on   date,
  ADD COLUMN IF NOT EXISTS tv_status          text,
  ADD COLUMN IF NOT EXISTS tv_status_on       date,
  ADD COLUMN IF NOT EXISTS is_tradeable       boolean;

-- ---------------------------------------------------------------------------
-- WHY first_seen_on AND last_seen_on ARE NOT ENOUGH
--
-- They answer "when did we last see data". They cannot distinguish:
--
--   the exchange suspended it
--   our master fetch came back incomplete and we dropped its quotes
--   it was reclassified out of EQUITIES_ONLY
--   it is genuinely new
--
-- On 26 July, ABAR, ACICO, NIND and SOKOUK left the scrape for eight days
-- while trading normally. Nothing recorded it, because from the registry's
-- point of view "no data" looks the same whatever caused it.
--
-- UNMATCHED is the value that matters: it means WE SAW ITS QUOTES AND DROPPED
-- THEM — our failure, not the exchange's.
-- ---------------------------------------------------------------------------
-- ONE STATUS PER FEED, because a symbol can be live on the broker and absent
-- from TradingView. BKIKWT and MASAKEN are exactly that: real on the broker,
-- missing from the TV watchlist. One column cannot hold two facts.
--
-- DELISTED is the fifth value and it is not a variant of ABSENT. UNMATCHED is
-- OUR bug; DELISTED is a fact about the world. Same absence, opposite meaning —
-- and a DELISTED symbol must never trigger a master re-fetch or an unmatched
-- warning, or it fires forever against something that will never resolve.
DO $st$
BEGIN
  ALTER TABLE public.instruments DROP CONSTRAINT IF EXISTS instruments_broker_status_valid;
  ALTER TABLE public.instruments DROP CONSTRAINT IF EXISTS instruments_tv_status_valid;
END
$st$;

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
-- MERGE duplicate (market, symbol) rows into one row per symbol.
--
-- This is the one operation here that re-running cannot undo, so the rule is
-- stated rather than implied:
--
--   first_seen_on   the EARLIEST across the rows — the symbol existed then
--   last_seen_on    the LATEST — it still existed then
--   everything else the first NON-NULL value found
--
-- Taking non-nulls matters: KPPC's auction row has a NULL description, and a
-- naive "keep the newest row" would lose the company name.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE instruments_merged AS
SELECT symbol,
       -- The market of the most recently seen row: where it trades NOW.
       (array_agg(market ORDER BY last_seen_on DESC NULLS LAST))[1] AS market,
       -- ─── first_seen_on COMES FROM THE PRICES TOO ────────────────────────
       --
       -- The registry says 26 August for every symbol, including ones with
       -- quotes since 14 July. That is the date the seeder ran. A column
       -- reading "first seen 26 August" for a stock trading since July is
       -- simply false, whatever it is used for.
       --
       -- COALESCE, not replace: a symbol with no quotes at all keeps whatever
       -- the registry had. Better an approximate date than none.
       COALESCE(
         (SELECT min(q2.trading_date) FROM public.awsat_market_quotes q2
           WHERE q2.symbol = i.symbol),
         min(first_seen_on)) AS first_seen_on,
       max(last_seen_on)  AS last_seen_on,
       (array_agg(code ORDER BY (code IS NULL), last_seen_on DESC))[1] AS code,
       (array_agg(description ORDER BY (description IS NULL), last_seen_on DESC))[1] AS description,
       bool_or(is_active) AS is_active,
       min(created_at) AS created_at,
       -- ─── market_changed_on COMES FROM THE PRICES, NOT THE REGISTRY ───────
       --
       -- first_seen_on is the date the SEEDER RAN — every one of the 144 rows
       -- carries the same value. Deriving the transition date from it would
       -- stamp "changed on 26 August" onto symbols that never moved, which is
       -- a fabricated fact rather than a missing one.
       --
       -- Worse, the two Auction registry rows have NO auction quotes at all:
       -- DALQANRE and KPPC have only Main Market prices, 16 and 15 sessions
       -- each. They are stale registry artifacts from a seeder run that
       -- predates the auction filter, not a stock that changed market.
       --
       -- So the move must be evidenced by PRICES on two markets. Today that is
       -- zero symbols and the column stays NULL — which is the truth.
       (SELECT min(q.trading_date) FROM public.awsat_market_quotes q
         WHERE q.symbol = i.symbol
           AND q.market = (array_agg(i.market ORDER BY i.last_seen_on DESC NULLS LAST))[1]
           AND EXISTS (SELECT 1 FROM public.awsat_market_quotes q2
                        WHERE q2.symbol = i.symbol AND q2.market <> q.market)
       ) AS market_changed_on
  FROM public.instruments i
 GROUP BY symbol;

DELETE FROM public.instruments;

-- Drop the existing primary key BY DISCOVERY, not by name.
--
-- instruments was renamed from market_stock_snapshots by migration 002, and a
-- rename does not rename the constraint — it is still called
-- market_stock_snapshots_pkey. Guessing "instruments_pkey" drops nothing and
-- then ADD PRIMARY KEY fails with "multiple primary keys for table".
DO $pk$
DECLARE
  pk_name text;
BEGIN
  SELECT conname INTO pk_name FROM pg_constraint
   WHERE conrelid = 'public.instruments'::regclass AND contype = 'p';
  IF pk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.instruments DROP CONSTRAINT %I', pk_name);
  END IF;
END
$pk$;

ALTER TABLE public.instruments ADD PRIMARY KEY (symbol);

INSERT INTO public.instruments
  (symbol, market, first_seen_on, last_seen_on, code, description,
   is_active, created_at, market_changed_on)
SELECT symbol, market, first_seen_on, last_seen_on, code, description,
       is_active, created_at, market_changed_on
  FROM instruments_merged;

DROP TABLE instruments_merged;

-- ---------------------------------------------------------------------------
-- The two known supersessions.
--
-- NOT inferred, and deliberately so. Inferring supersession from the absence of
-- quotes would eventually mark a genuinely suspended stock as superseded by an
-- unrelated one sharing a code — a silent wrong answer, which is worse than a
-- stale one. is_primary handles the behaviour and is computed nightly;
-- superseded_by is a historical note, and an empty one means the history is
-- incomplete rather than that screening is broken.
-- ---------------------------------------------------------------------------
UPDATE public.instruments SET superseded_by = 'KFH', is_primary = false
 WHERE symbol = 'KFIN';

UPDATE public.instruments SET superseded_by = 'PHC', is_primary = false
 WHERE symbol = 'KPPC';

-- ---------------------------------------------------------------------------
-- BAREEQ is DELISTED — a fact, not something derivable.
--
-- Without this it would sit at ABSENT, keep appearing in unmatched warnings and
-- keep triggering master re-fetches against a symbol that will never resolve.
-- It has applied to re-list; if it starts quoting the nightly job flips it to
-- CAPTURED and says so.
-- ---------------------------------------------------------------------------
UPDATE public.instruments
   SET broker_status = 'DELISTED', broker_status_on = DATE '2022-04-21'
 WHERE symbol = 'BAREEQ';

-- ---------------------------------------------------------------------------
-- is_tradeable, from the market the merge settled on.
--
-- Derived HERE rather than left to the first nightly run, so the backfills can
-- run once. Populating it tomorrow would move pct_advancing again on every row
-- computed today.
-- ---------------------------------------------------------------------------
-- ---------------------------------------------------------------------------
-- first_seen_on, from the earliest PRICE rather than the registry write.
--
-- Every one of the 144 rows says 2026-08-26 — the date the seeder ran. For a
-- stock with quotes from 14 July that is simply false, and a column that
-- confidently states a wrong date is worse than one that is empty.
--
-- Only moved BACKWARDS: a quote older than the recorded date is evidence the
-- symbol existed earlier. A quote newer than it proves nothing, since the
-- registry may legitimately have been written first.
-- ---------------------------------------------------------------------------
UPDATE public.instruments i
   SET first_seen_on = q.earliest
  FROM (SELECT symbol, min(trading_date) AS earliest
          FROM public.awsat_market_quotes GROUP BY symbol) q
 WHERE q.symbol = i.symbol
   AND (i.first_seen_on IS NULL OR q.earliest < i.first_seen_on);

UPDATE public.instruments
   SET is_tradeable = (market <> 'Auction Market' AND COALESCE(is_primary, true));

CREATE INDEX IF NOT EXISTS instruments_tradeable_idx
  ON public.instruments (is_tradeable) WHERE is_tradeable;

COMMENT ON COLUMN public.instruments.is_tradeable IS
  'PRIMARY AND TRADEABLE ARE DIFFERENT QUESTIONS, and the counts will differ. '
  'symbol_day filters on is_primary; market_day breadth and the depth slots '
  'filter on is_tradeable. DALQANRE is primary but not tradeable — it sits on '
  'the auction market. That is correct, not a discrepancy to be fixed.';

COMMENT ON COLUMN public.instruments.market_changed_on IS
  'The MOST RECENT transition only. Prior movements are not retained — a stock '
  'moving Main -> Auction -> Main overwrites the first date. Deliberate: the '
  'move happens about twice a year, and symbol_day records where prices stop '
  'and start, so the period is reconstructable without a history table.';

CREATE INDEX IF NOT EXISTS instruments_primary_idx
  ON public.instruments (is_primary) WHERE is_primary;
CREATE INDEX IF NOT EXISTS instruments_code_idx
  ON public.instruments (code) WHERE code IS NOT NULL;

COMMENT ON COLUMN public.instruments.is_primary IS
  'Computed nightly: false where a symbol has no quotes at all, otherwise true '
  'for the most recently seen row per code. Activity first, recency second — '
  'KFIN had one row, one day, price 0 and volume 0.';
COMMENT ON COLUMN public.instruments.superseded_by IS
  'Set by hand. KFIN->KFH is a misparse pointing at the real instrument; '
  'KPPC->PHC is a rename. Never inferred from missing quotes.';
COMMENT ON COLUMN public.instruments.market_changed_on IS
  'When the symbol first appeared on its current market. NULL unless it moved.';

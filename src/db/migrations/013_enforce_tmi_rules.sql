-- ===========================================================================
--  013_enforce_tmi_rules.sql — make the TMI rules structural, not remembered
--
--  Steps 1 and 1a landed the DDL exactly as specified. This closes the gap
--  between what the six rules REQUIRE and what the schema can ENFORCE.
--
--  Every change here is additive and the tables are empty, so nothing is at
--  risk. The argument is the same one that justified replacing
--  daily_stock_analysis: free now, expensive once there are rows.
--
--  These go BEYOND the DDL as written. If TMI 01 wants any of them reverted,
--  each is a single ALTER — they are separated for exactly that reason.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- RULE 5 · buy_sell_ratio is invalid where a stock sits at the offer.
--
-- The rule names pct_at_offer, and the table had nowhere to put it. Without
-- that column the rule is unauditable: a NULL buy_sell_ratio could mean "the
-- rule fired" or "the job never ran", and test case S5 (GFH = NULL) passes in
-- both cases — including when the job is broken.
--
-- Storing the input makes the NULL explicable, and lets the CHECK below
-- enforce the rule rather than trusting the job to apply it.
-- ---------------------------------------------------------------------------
ALTER TABLE public.symbol_day
  ADD COLUMN IF NOT EXISTS pct_at_offer numeric;

COMMENT ON COLUMN public.symbol_day.pct_at_offer IS
  'Percent of minutes the stock sat at the offer. The input to rule 5 — GFH 98, '
  'KRE 99, whose ratios read 52:1 and 199:1. Stored so a NULL buy_sell_ratio '
  'can be explained rather than merely observed.';

-- The rule itself, enforced by the database. A row that breaks it cannot be
-- written, so "was rule 5 applied?" stops being a question about the job.
ALTER TABLE public.symbol_day
  DROP CONSTRAINT IF EXISTS symbol_day_ratio_invalid_at_offer;
ALTER TABLE public.symbol_day
  ADD CONSTRAINT symbol_day_ratio_invalid_at_offer CHECK (
    pct_at_offer IS NULL
    OR pct_at_offer <= 90
    OR buy_sell_ratio IS NULL
  );

-- ---------------------------------------------------------------------------
-- RULE 6 · source on EVERY row.
--
-- The column was nullable, which asks the compute job to remember. The failure
-- this rule exists to prevent was itself a NULL nobody noticed: 11,915 of
-- 14,084 rows had NULL trades and a 90-day query returned "zero active
-- symbols".
--
-- NOT NULL is free while the table is empty and impossible to add later.
-- ---------------------------------------------------------------------------
ALTER TABLE public.symbol_day
  ALTER COLUMN source SET NOT NULL;

ALTER TABLE public.symbol_day
  DROP CONSTRAINT IF EXISTS symbol_day_source_valid;
ALTER TABLE public.symbol_day
  ADD CONSTRAINT symbol_day_source_valid CHECK (source IN ('AWSAT', 'TRADINGVIEW'));

-- ---------------------------------------------------------------------------
-- Documented enums, constrained.
--
-- Each of these has a fixed set of values written down in the spec. Without a
-- CHECK a typo stores silently and every downstream filter misses that row —
-- the row still exists, so nothing looks wrong.
-- ---------------------------------------------------------------------------
ALTER TABLE public.symbol_day
  DROP CONSTRAINT IF EXISTS symbol_day_quality_valid;
ALTER TABLE public.symbol_day
  ADD CONSTRAINT symbol_day_quality_valid CHECK (
    data_quality IS NULL OR data_quality IN ('FULL', 'PARTIAL', 'THIN'));

ALTER TABLE public.symbol_day
  DROP CONSTRAINT IF EXISTS symbol_day_family_valid;
ALTER TABLE public.symbol_day
  ADD CONSTRAINT symbol_day_family_valid CHECK (
    family IS NULL OR family IN
      ('CRAWLER', 'GIANT', 'REACHABLE', 'SCALER', 'STARVED', 'QUOTED'));

ALTER TABLE public.market_day
  DROP CONSTRAINT IF EXISTS market_day_regime_valid;
ALTER TABLE public.market_day
  ADD CONSTRAINT market_day_regime_valid CHECK (
    regime IS NULL OR regime IN ('RISK_ON', 'NEUTRAL', 'RISK_OFF'));

-- ---------------------------------------------------------------------------
-- The regime rule, as a function.
--
-- WARN-ONLY: this returns a label. It gates nothing. The spec is explicit —
-- display it and log what blocking would have done for 20 sessions first, the
-- same discipline as CR-35, where a direction gate was downgraded to a warning
-- once its base rate turned out to be a coin flip.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION regime_of(pct_advancing numeric)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN pct_advancing IS NULL THEN NULL
    WHEN pct_advancing < 35 THEN 'RISK_OFF'
    WHEN pct_advancing <= 50 THEN 'NEUTRAL'
    ELSE 'RISK_ON'
  END
$$;

COMMENT ON FUNCTION regime_of(numeric) IS
  'pct_advancing <35 RISK_OFF, 35-50 NEUTRAL, >50 RISK_ON. WARN-ONLY: it '
  'labels, it does not gate. 17 Aug at 18 would have blocked every entry.';

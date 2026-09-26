-- ===========================================================================
--  049_session_hours_and_quality_rule.sql
--
--  THE DENOMINATOR STOPS MOVING WITH THE THING IT MEASURES.
--
--  ─── WHAT WAS WRONG ───────────────────────────────────────────────────────
--  symbol_day.coverage_pct and symbol_day.data_quality both divide by
--  marketMedianMinutes(day) — THAT DAY'S OWN median capture length. On a day
--  where capture died early for every symbol at once, the median collapses to
--  the truncated length, every symbol scores ~100% coverage, and the
--  "minutes < 0.80 * median" test can never fire. The absolute floor (60
--  minutes) is the only backstop and nothing realistic goes below it.
--
--  Measured on `kse`, 25 September 2026:
--
--    20 Sep   188 minutes captured   coverage_pct 100.0   data_quality FULL
--    15 Sep   233 minutes captured   coverage_pct  86.3   data_quality PARTIAL
--
--  A SHORTER day scoring HIGHER coverage. And without needing to read any
--  code: 259 minutes scored 96.7% on 13 September and 100% on 23 September.
--  Same length, different verdict — the denominator is not a constant.
--
--  The failure is one-directional and it is the worst direction. A PARTIAL
--  outage — some symbols behind, others fine — is caught, because the symbols
--  disagree and the median stays high. A TOTAL outage is invisible, because
--  everything agrees about being broken. The day you most need the flag is the
--  day it cannot fire.
--
--  Consequence in the data: a study that filtered on data_quality excluded the
--  sixteen honestly-labelled PARTIAL days and KEPT 20 September at 67% of a
--  session. The filter worked against itself.
--
--  ─── WHAT THIS ADDS ───────────────────────────────────────────────────────
--
--  1 · public.market_session_hours — the scheduled capture window per day.
--
--  The denominator now comes from the CALENDAR, not from the data being
--  measured and not from a constant. A constant would be nearly right and
--  would read PARTIAL for ever on a genuine half-day or early close; the
--  calendar gets those right by having a row for them. A day with no row uses
--  the standard window from config (CAPTURE_START_TIME..CAPTURE_END_TIME), and
--  the reader says which of the two it used — an assumed denominator and a
--  known one are not the same measurement.
--
--  2 · symbol_day.quality_rule_version — which rule labelled this row.
--
--  3,496 rows across 27 days carry data_quality = 'PARTIAL', written by a rule
--  that exists nowhere: dataQuality() returns only FULL or THIN on
--  release/2026-09, on amit, and on both deployed commits (b29248f, 4588d10).
--  Those labels are real measurements whose definition is lost. Once the new
--  rule writes, the column would hold two generations with nothing telling
--  them apart, and "133 thin on 14 July" would silently change meaning.
--
--    NULL  rule 1 — the unrecoverable rule. Do not reproduce, do not overwrite.
--    2     rule 2 — minutes against the scheduled window, this migration.
--
--  3 · market_day.partial_symbols, no_prev_close, and the symbol_day
--      fingerprint.
--
--  thin_symbols counts only 'THIN', so 3,365 PARTIAL symbol-days across 26
--  days are invisible to it. partial_symbols is its own column rather than
--  being folded in: a short session and a symbol that fell behind its own
--  market are different failures, and collapsing them to make one column look
--  populated is how the distinction was lost in the first place. It will read
--  0 on every recent day until rule 2 writes, and that is correct and
--  obviously wrong, which is the point.
--
--  no_prev_close already exists — breadth() computes it and computeMarketDay
--  then does `delete row.no_prev_close` because the table has no column for
--  it. A refusal deleted before the write is not a refusal.
--
--  The fingerprint is the guard. market_day is derived from symbol_day rows;
--  sixteen of forty-eight days hold a thin_symbols that disagrees with the
--  symbol_day it counts, and nothing detected it. A computed_at comparison
--  would NOT have caught this one — both tables show 31 August, same backfill,
--  ordering invisible. So each row stores the max(symbol_day.computed_at) it
--  read and the number of rows it aggregated; the check recomputes those two
--  and compares exactly. A fingerprint, not a timestamp race.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1 · the scheduled window, per day
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.market_session_hours (
  trading_date   date PRIMARY KEY,
  capture_open   time NOT NULL,
  capture_close  time NOT NULL,
  -- Why this day differs from the standard window. A half-day, an early close
  -- announced by Boursa, a late open after an incident.
  reason         text,
  -- Where the hours came from, so a wrong one is traceable rather than
  -- arguable — the same rule market_holiday.source follows.
  source         text NOT NULL DEFAULT 'manual',
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT market_session_hours_ordered CHECK (capture_open < capture_close)
);

COMMENT ON TABLE public.market_session_hours IS
  '049 · the SCHEDULED capture window for days that differ from the standard one. '
  'The denominator for symbol_day.coverage_pct and data_quality. A date absent '
  'here uses the standard window from config (CAPTURE_START_TIME..CAPTURE_END_TIME) '
  'and the reader reports that it assumed rather than read it. Empty is the normal '
  'state: only half-days and early closes need a row.';

-- ---------------------------------------------------------------------------
-- 2 · which rule labelled the row
-- ---------------------------------------------------------------------------
ALTER TABLE public.symbol_day
  ADD COLUMN IF NOT EXISTS quality_rule_version smallint;

COMMENT ON COLUMN public.symbol_day.quality_rule_version IS
  'Which rule produced data_quality and coverage_pct. NULL = rule 1, the rule that '
  'wrote the 3,496 PARTIAL rows and exists in no commit — its labels are real '
  'measurements whose definition is lost, so the compute REFUSES to overwrite them. '
  '2 = minutes captured against the scheduled window (049). Without this the column '
  'holds two generations of label with nothing telling them apart.';

-- ---------------------------------------------------------------------------
-- 3 · market_day: the PARTIAL count, the refusal, and the fingerprint
-- ---------------------------------------------------------------------------
ALTER TABLE public.market_day
  ADD COLUMN IF NOT EXISTS partial_symbols integer,
  ADD COLUMN IF NOT EXISTS no_prev_close integer,
  ADD COLUMN IF NOT EXISTS symbol_day_max_computed_at timestamptz,
  ADD COLUMN IF NOT EXISTS symbol_day_rows integer;

COMMENT ON COLUMN public.market_day.partial_symbols IS
  '049 · symbols whose capture was PARTIAL. Separate from thin_symbols on purpose: '
  'a short session and a symbol that fell behind its own market are different '
  'failures. Reads 0 on days labelled by rule 1 because that rule''s PARTIAL rows '
  'are preserved and counted, and 0 on recent days until rule 2 writes — which is '
  'correct and obviously wrong rather than quietly plausible.';

COMMENT ON COLUMN public.market_day.no_prev_close IS
  '049 · symbols with no previous close, so no direction. breadth() has always '
  'computed this and computeMarketDay deleted it before the INSERT because there '
  'was no column. It is the reason 15 September computed 73/49 against the broker''s '
  '60/64 — the 14 September capture stopped at 11:59.';

COMMENT ON COLUMN public.market_day.symbol_day_max_computed_at IS
  '049 · the newest symbol_day.computed_at this row was derived from. With '
  'symbol_day_rows it is the fingerprint of the input. If either has moved, every '
  'derived column here is stale and the row is refused rather than trusted. A '
  'computed_at comparison alone would not have caught the 31 August case: both '
  'tables carried the same date and the ordering inside the backfill was invisible.';

COMMENT ON COLUMN public.market_day.symbol_day_rows IS
  '049 · how many symbol_day rows this row aggregated. The other half of the '
  'fingerprint — a row added or removed changes the aggregate without necessarily '
  'moving max(computed_at).';

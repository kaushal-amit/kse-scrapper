-- ===========================================================================
--  050_session_denominator_and_bar_source.sql
--
--  THE DENOMINATOR IS THE CONTINUOUS SESSION, NOT THE CAPTURE DOOR.
--
--  049 made the denominator a calendar instead of the data's own median. It
--  then used the wrong calendar column: capture_open..capture_close, the INGEST
--  window (08:40-13:20, 280 minutes). The measure exists to tell an analysis
--  whether a day is usable, and analyses consume CONTINUOUS TRADING —
--  09:00-13:00, 240 minutes.
--
--  Counting from 08:40 against a 240-minute session puts 13 September at 108%
--  coverage. A coverage over 100% is not a rounding problem; it is two
--  different questions divided by each other.
--
--  This is a NEW migration rather than an edit to 049 because 049 has been
--  applied: boot-migrate refuses a migration whose checksum has changed, and
--  it is right to.
--
--  ─── WHERE THE BOUNDARIES COME FROM (25 September, measured) ──────────────
--
--  FULL 0.94, PARTIAL 0.50, against the continuous session. 6,557 symbol-days
--  across 47 sessions on `kse`, numerator restricted to 09:00-13:00.
--
--  THE DATA FAILS IN QUANTISED STEPS. This is a fact about the failure mode,
--  not a property of the sample, and it is why the bands below are empty
--  rather than lucky: A CAPTURE DIES AT A MOMENT AND THE WHOLE MARKET LOSES
--  THE SAME TAIL. One client serves every symbol; when it stops they all stop
--  together, on the same minute. So days cluster tightly and the space between
--  the clusters is real. Anyone tuning these numbers later will see a gap and
--  be tempted to read it as a sampling artefact and move the line into it. It
--  is not. It is the shape of the outage.
--
--  The same fact independently justifies PARTIAL and THIN being different
--  columns on market_day: DAY-LEVEL degradation is market-wide by
--  construction, SYMBOL-LEVEL degradation is not. They cannot be one measure.
--
--    coverage band      symbol-days     days
--    98-100%                  3,199       26
--    95-98%                   1,074        9
--    93-95%                       0        0     <- empty
--    90-93%                     683        7
--    85-90%                     530        5
--    60-85%                     952        9
--    52-60%                     117        1
--    50-52%                       0        0     <- empty
--    25-50%                       2        2
--
--  Day medians across the FULL boundary:
--    ... 88.3 · 90.4 · 90.4 · 91.3 · 92.9 · 92.9 · <gap> · 95.0 · 95.0 · 95.8 ...
--
--  Every value in (0.929, 0.950] partitions this sample identically, so the
--  evidence does not choose between them. 0.94 IS THE MIDPOINT OF AN EMPTY
--  BAND, WHICH IS THE MAXIMUM-MARGIN SEPARATOR: the choice that survives the
--  most measurement error in either direction. 0.95 was rejected because it
--  sits EXACTLY on two days' medians (16 Jul and 24 Sep, both 228/240 =
--  95.0%) — one lost minute makes them 94.6% and flips both.
--
--  0.50 is unchanged; the 45-52.5% region is empty. Recorded as a marginal
--  day rather than acted on: 29 JULY AT 52.5%, market-wide, is six lost
--  minutes from flipping the entire day to THIN. If it turns up in a study
--  sample, that is why.
--
--  12 AUGUST SETTLES partial_symbols EMPIRICALLY. It read 95.0 under the old
--  numerator and is a 99.6% day with ONE symbol at 81 minutes — a per-symbol
--  failure presented as a day failure, exactly the conflation those two
--  columns exist to break. The choice was made on reasoning; this is the
--  measured case for it.
--
--  NOT ESTABLISHED, AND IT HAS A TRIGGER RATHER THAN A CAVEAT: all 47 sessions
--  are normal-length, so the short-session branch has NO OBSERVED DATA and the
--  60-minute floor is reasoned, not measured. computeSymbolDay logs
--  `shortSessionFirstObservation` the first time it sees a scheduled session
--  under 240 minutes — check the floor's behaviour then and report. A caveat
--  is read once; this fires on its own.
--
--  The thresholds live in src/config/thresholds.js, NOT in kb_threshold. See
--  the OPEN QUESTION at the foot of this file.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1 · two windows, because they answer two questions
-- ---------------------------------------------------------------------------
ALTER TABLE public.market_session_hours
  ADD COLUMN IF NOT EXISTS session_open  time NOT NULL DEFAULT '09:00',
  ADD COLUMN IF NOT EXISTS session_close time NOT NULL DEFAULT '13:00';

ALTER TABLE public.market_session_hours
  DROP CONSTRAINT IF EXISTS market_session_hours_session_ordered;
ALTER TABLE public.market_session_hours
  ADD CONSTRAINT market_session_hours_session_ordered
  CHECK (session_open < session_close);

-- The session cannot fall outside the door that feeds it, or the denominator
-- would count minutes the ingest layer refuses — coverage capped below 100%
-- for ever, with nothing saying why.
ALTER TABLE public.market_session_hours
  DROP CONSTRAINT IF EXISTS market_session_hours_session_inside_capture;
ALTER TABLE public.market_session_hours
  ADD CONSTRAINT market_session_hours_session_inside_capture
  CHECK (session_open >= capture_open AND session_close <= capture_close);

COMMENT ON TABLE public.market_session_hours IS
  '049/050 · the SCHEDULED windows for days that differ from the standard ones. '
  'capture_* is the ingest door (08:40-13:20); session_* is continuous trading '
  '(09:00-13:00) and is THE DENOMINATOR for symbol_day.coverage_pct and '
  'data_quality. Two windows because they answer two questions: what may reach '
  'the table, and what counts as capture length. Keeping them apart is also what '
  'makes the Close-Of-Day exemption safe — that row is INGESTED and EXCLUDED '
  'FROM THE COUNT, so a 14:43 print does not lengthen the day it closes. A date '
  'absent here uses the standard windows from config and the reader reports that '
  'it assumed rather than read them.';

COMMENT ON COLUMN public.market_session_hours.session_close IS
  '050 · continuous trading ENDS 13:00, not 13:20. SD_RANGE_FULL_HHMM sat at '
  '1310 against a session that ends at 13:00, so range_source could never read '
  'FULL for any day ever captured — a gate that cannot pass is the same defect '
  'as a check that cannot fail.';
-- 2 · public.data_alarm — the table the scraper has been writing to for weeks
--      and which has never existed
--
--  computeMarketDay.js and scheduler.js both `INSERT INTO data_alarm
--  (trading_date, table_name, alarm, detail)`. There is no public.data_alarm in
--  any migration in this repository. The only data_alarm on `kse` is
--  spread.data_alarm — the BACKEND's, whose date column is `trading_day`, not
--  `trading_date` — so the insert fails on the relation or on the column
--  whichever way the search_path falls.
--
--  Both call sites wrap it in `.catch()` and log a warning, because losing an
--  alarm must not lose the row it describes. Correct, and it is why nobody saw
--  this: measured on `kse`, spread.data_alarm holds 20 rows, every one written
--  by the backend (client_heartbeat, config). NOT ONE from the scraper, ever.
--
--  So the scraper's entire alarm path has been a check that cannot fire — the
--  shape this repository has now hit often enough to have a name for. A new
--  alarm built on it would be decoration. The table is this service's own,
--  under public.*, because the rule stands: the capture service must not need
--  the backend's schema to say something is wrong.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.data_alarm (
  id            bigserial PRIMARY KEY,
  raised_at     timestamptz NOT NULL DEFAULT now(),
  trading_date  date,
  table_name    text NOT NULL,
  column_name   text,
  symbol        text,
  alarm         text NOT NULL,
  detail        jsonb,
  resolved_at   timestamptz
);

-- One row per day per alarm per column, so a re-run of a nightly job does not
-- pile up duplicates — and so `ON CONFLICT DO NOTHING` at the call sites means
-- something rather than being a clause that never fires.
CREATE UNIQUE INDEX IF NOT EXISTS data_alarm_once_per_day
  ON public.data_alarm (trading_date, table_name, coalesce(column_name, ''), alarm)
  WHERE trading_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS data_alarm_open
  ON public.data_alarm (raised_at DESC) WHERE resolved_at IS NULL;

COMMENT ON TABLE public.data_alarm IS
  '049 · the SCRAPER''s alarms. Separate from spread.data_alarm (the backend''s) '
  'on purpose: public.* is this service''s schema and a capture service must not '
  'depend on the backend''s to report a problem. Created here because the code '
  'has been inserting into a table that did not exist since before 9 September, '
  'catching the error and warning — so every scraper-side alarm ever raised was '
  'discarded. Empty is not the same as quiet.';

-- 3 · tradingview_history.bar_source — DERIVED, not backfilled as UNKNOWN
--
--  Two different things write this table and nothing recorded which:
--
--    tradingview.history   derives a daily bar by AGGREGATING tradingview_
--                          watchlist minutes — it fetches nothing itself
--    tradingview.backfill  scrapes the CHART, for days that predate collection
--
--  A bar aggregated from minutes is only as complete as that day's minute
--  capture; a chart bar is the venue's own. They are not interchangeable, and
--  a study that mixes them cannot say which it has. The 25 September comparison
--  that put chart coverage at 98% against 25-60% for minute-derived bars is
--  exactly the question this column answers — and it had to be answered by
--  hand, per day, because the table does not say.
--
--  It is DERIVED rather than filled with UNKNOWN: the table already carries
--  run_id, and scrape_runs.scraper names which job produced the run. So every
--  row that has a run_id gets its true source from the data that was there all
--  along. UNKNOWN is reserved for rows whose run_id is null — where it is the
--  honest answer rather than a placeholder standing in for one.
--
--  HOW MUCH THAT ACTUALLY COVERS, MEASURED — because "derivable exactly" was
--  said before it was counted, and the count is most of the story:
--
--      run_id present         4,039   22.2%
--        tradingview.backfill 2,775   CHART    26 Aug - 24 Sep, 136 symbols
--        tradingview.history  1,264   MINUTES  11 Aug - 24 Sep, 140 symbols
--      run_id null           14,191   77.8%    UNKNOWN
--                                     1 Feb - 23 Sep, 139 symbols
--
--  So on the table AS IT STANDS, UNKNOWN is the MAJORITY, not the exception.
--  The gap is back-history: recent inserts carry run_id on 94-100% of rows
--  (25 Sep: 2,061 of 2,061), so the derivation is right going forward and the
--  UNKNOWN block is bars written before run_id was wired.
--
--  AND THE OBVIOUS INFERENCE IS DELIBERATELY NOT MADE. Every bar dated before
--  11 August — the earliest MINUTES-tagged bar — could only have come from the
--  chart, and the whole February-to-July range predates capture entirely. That
--  reasoning is sound and it is still a GUESS about a specific row. Upgrading
--  UNKNOWN to CHART on it would put a derived value in a column whose entire
--  purpose is to say where a value came from.
-- ---------------------------------------------------------------------------
ALTER TABLE public.tradingview_history
  ADD COLUMN IF NOT EXISTS bar_source text;

UPDATE public.tradingview_history h
   SET bar_source = CASE
         WHEN r.scraper = 'tradingview.backfill' THEN 'CHART'
         WHEN r.scraper = 'tradingview.history'  THEN 'MINUTES'
         ELSE 'UNKNOWN'
       END
  FROM public.scrape_runs r
 WHERE r.id = h.run_id
   AND h.bar_source IS DISTINCT FROM CASE
         WHEN r.scraper = 'tradingview.backfill' THEN 'CHART'
         WHEN r.scraper = 'tradingview.history'  THEN 'MINUTES'
         ELSE 'UNKNOWN'
       END;

-- Only where there is genuinely nothing to derive from.
UPDATE public.tradingview_history
   SET bar_source = 'UNKNOWN'
 WHERE bar_source IS NULL AND run_id IS NULL;

ALTER TABLE public.tradingview_history
  DROP CONSTRAINT IF EXISTS tradingview_history_bar_source_known;
ALTER TABLE public.tradingview_history
  ADD CONSTRAINT tradingview_history_bar_source_known
  CHECK (bar_source IS NULL OR bar_source IN ('CHART', 'MINUTES', 'UNKNOWN'));

COMMENT ON COLUMN public.tradingview_history.bar_source IS
  '049 · CHART (tradingview.backfill scraped the venue''s own daily bar) or '
  'MINUTES (tradingview.history aggregated it from tradingview_watchlist, so it '
  'is only as complete as that day''s minute capture). Derived from '
  'run_id -> scrape_runs.scraper, not guessed. UNKNOWN ONLY where run_id is '
  'null — it is the honest answer there, never a placeholder for one.';

-- ---------------------------------------------------------------------------
-- 3b · and it stays derived, for rows written from now on
--
--  Two different call sites insert into this table (jobs/historyFinalise.js and
--  db/repositories.js), and a third could be added tomorrow. Setting a literal
--  at each one means the answer to "which job wrote this bar?" is written down
--  in as many places as there are writers, and is wrong the first time one is
--  copied. The database already knows — run_id names the run, scrape_runs names
--  the job — so it derives it, once, for every writer including the next one.
--
--  A row inserted with no run_id gets UNKNOWN rather than NULL: the column then
--  never holds "nobody has looked", only "there is nothing to look at".
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tradingview_history_bar_source()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s text;
BEGIN
  IF NEW.run_id IS NULL THEN
    NEW.bar_source := 'UNKNOWN';
    RETURN NEW;
  END IF;
  SELECT scraper INTO s FROM public.scrape_runs WHERE id = NEW.run_id;
  NEW.bar_source := CASE
    WHEN s = 'tradingview.backfill' THEN 'CHART'
    WHEN s = 'tradingview.history'  THEN 'MINUTES'
    ELSE 'UNKNOWN'
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS tradingview_history_bar_source_trg ON public.tradingview_history;
CREATE TRIGGER tradingview_history_bar_source_trg
  BEFORE INSERT OR UPDATE OF run_id ON public.tradingview_history
  FOR EACH ROW EXECUTE FUNCTION public.tradingview_history_bar_source();

-- ===========================================================================
--  OPEN QUESTION — the thresholds are NOT kb_threshold rows
--
--  The instruction on 25 September was "both as kb_threshold rows". They are
--  not, and the conflict is deliberate rather than an oversight.
--
--  src/index.js:207, verbatim: "Thresholds come from src/config/thresholds.js
--  — a file, not a table. The scraper no longer reads kb_threshold: a capture
--  service must not refuse to boot because a backend table is missing."
--  kb_threshold lives in the BACKEND's schema. Making the LABEL of a capture
--  depend on it reintroduces exactly the coupling that rule removed, in the one
--  job that runs after the market shuts with nobody watching.
--
--  There is also no kb reader to name: guard 2 requires every kb_threshold row
--  to be quoted by a reader that exists, and a row nothing reads fails it.
--
--  So: implemented in config, flagged rather than decided. If the rows are
--  wanted for the KB's own record, the honest shape is a row in the BACKEND
--  that documents the scraper's value and is verified against it — one source,
--  one copy, and a check that they agree — not two places that can drift.
-- ===========================================================================

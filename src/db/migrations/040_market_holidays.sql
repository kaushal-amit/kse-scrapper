-- ============================================================================
-- 040 · Market holidays — a closed day is a SKIP, not a failure.
--
-- WHAT THIS IS FOR
--
-- The weekday rule (Sunday–Thursday) is not the whole calendar. On an Eid or a
-- national holiday the exchange is shut on a weekday, and every job in this
-- service currently treats that day as a normal session:
--
--   · the AWSAT jobs log in — spending one of the day's TWO login attempts on a
--     terminal that has nothing to show;
--   · the nightly computes run and write a symbol_day / market_day row built
--     from no captures, which is a row that looks like every other one and is
--     made of nothing;
--   · the "previous trading day" reach-back then steps onto that empty day and
--     reports a close of null where there is really a close from the session
--     before.
--
-- A holiday calendar turns all three into one log line.
--
-- WHY A TABLE IN public AND NOT A READ OF spread.trading_day
--
-- The backend owns spread.trading_day and is authoritative when it is present —
-- the read path added alongside this migration consults it first. But this
-- repo has to work against a scraper-only database (currentBudgetKd already
-- guards for exactly that), and a capture service that cannot tell whether the
-- market is open without the backend's schema is coupled the wrong way round.
-- So the scraper owns its own copy of the calendar, and defers to the backend's
-- when there is one.
--
-- ⚠ SEEDED EMPTY, DELIBERATELY.
--
-- I do not have a verified list of Boursa Kuwait's 2026 closures, and a guessed
-- holiday is worse than none: it would silently skip a real session, and a
-- session skipped is a session that cannot be re-scraped. Under this project's
-- rule — make the failure loud rather than the value present — the table is
-- created empty and the boot says so, once, naming the fact that no calendar is
-- loaded. Seed it with:
--
--   INSERT INTO public.market_holiday (holiday_date, name, source) VALUES
--     ('2026-xx-xx', 'Eid al-Fitr', 'boursa-kuwait-2026-calendar');
--
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.market_holiday (
  holiday_date  date PRIMARY KEY,
  name          text,
  -- Where the date came from, so a wrong one can be traced to its source rather
  -- than argued about. 'boursa-kuwait-<year>-calendar' for the published list.
  source        text NOT NULL DEFAULT 'manual',
  created_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.market_holiday IS
  '040 · days the exchange is closed that are not weekends. Empty means "no '
  'calendar loaded", which the boot warns about — it does not mean "no holidays".';

-- A weekend date here would be redundant and is more likely a data-entry error
-- than an intention, so it is refused. Friday = 5, Saturday = 6.
ALTER TABLE public.market_holiday
  DROP CONSTRAINT IF EXISTS market_holiday_not_weekend;
ALTER TABLE public.market_holiday
  ADD CONSTRAINT market_holiday_not_weekend
  CHECK (EXTRACT(dow FROM holiday_date) NOT IN (5, 6));

-- ===========================================================================
--  059_thin_symbols_retired.sql — D7 · a count nobody read, computed twice
--
--  market_day.thin_symbols has ZERO semantic readers. Its only exits were two
--  `SELECT *` accidents — /diag/coverage and the AI market_day tool — and one
--  log line. Nothing filters on it, aggregates it, or displays it.
--
--  Meanwhile spread-backend's review/index.js recomputes the identical THIN
--  count straight from public.symbol_day, and THAT is the figure the frontend
--  shows. Two implementations of one definition, and the stored one is the
--  unused copy. Predictably, 16 of 48 stored values disagree with the
--  symbol_day rows they claim to count: a number nobody reads is a number
--  nobody notices going wrong.
--
--  The 21 NULL days (14 Jul - 10 Aug and 26 Aug) that prompted the question
--  therefore do not need filling. They need the column to stop existing.
--
--  ─── RETIRED HERE, DROPPED LATER, AND THAT IS A DEPLOY DECISION ────────────
--  spread.market_day projects this column, so Postgres refuses the drop until
--  the backend view is rebuilt without it. This deploy already carries one
--  cross-repo ordering constraint — backend 079 before scraper 056 — and a
--  second one on the same day trades a tidier schema for a larger chance of a
--  half-applied deploy, on the morning of the first session anyone has
--  actually watched.
--
--  So: stop writing it, null what is there, and say so on the column. The
--  drop is a follow-up with its own backend view change, and the condition is
--  recorded below rather than remembered.
-- ===========================================================================

UPDATE public.market_day SET thin_symbols = NULL WHERE thin_symbols IS NOT NULL;

COMMENT ON COLUMN public.market_day.thin_symbols IS
  'RETIRED (059, D7). Never written again and NULL on every row. It had no '
  'semantic reader — only two SELECT * accidents and a log line — while '
  'spread-backend review/index.js recomputed the same THIN count from '
  'public.symbol_day, which is the figure the frontend actually shows. 16 of 48 '
  'stored values disagreed with the symbol_day rows they claimed to count. '
  'TO DROP IT: rebuild spread.market_day without it (backend), then ALTER TABLE '
  'public.market_day DROP COLUMN thin_symbols. Not done in this deploy because '
  'it already carries one cross-repo ordering constraint and a second one costs '
  'more than the column does.';

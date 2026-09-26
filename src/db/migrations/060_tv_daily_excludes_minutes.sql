-- ===========================================================================
--  060_tv_daily_excludes_minutes.sql — D8 · a minute bar is not a daily bar
--
--  Measured against symbol_day's official closes, by bar_source:
--
--      CHART      2,493 of 2,493   100%
--      UNKNOWN      393 of   400    98%
--      MINUTES      300 of   781    38%
--
--  A MINUTES bar's close is the last print our ~60-second grid happened to
--  catch before the session ended. That is not the closing auction, so it is
--  not the close — it is a mid-session price with a daily bar's shape, and
--  anything reading tradingview_history for "what did this close at" gets it
--  wrong three times in five.
--
--  bar_source arrived in 050, and is most of why this survived: until then
--  there was nothing to filter on, so the three populations were one table.
--
--  ─── THE VIEW IS THE FIX, NOT A DELETE ─────────────────────────────────────
--  The MINUTES rows are real observations and they are the only record of
--  what we saw on the days they cover. Deleting them would leave a hole
--  wearing no label. tradingview_daily is what anything asking for a DAILY
--  bar reads; tradingview_history stays whole for anyone asking what we
--  captured.
--
--  ─── UNKNOWN IS KEPT, AND THAT IS A JUDGEMENT ──────────────────────────────
--  14,191 rows (1 Feb - 23 Sep) carry UNKNOWN because run_id is null and the
--  source cannot be derived. They agree with the official close 98% of the
--  time. Excluding them would discard the bulk of the history to avoid a 2%
--  error and leave the reader with nothing rather than something imperfect —
--  and unlike MINUTES, there is no reason to believe they are systematically
--  wrong. They are labelled, so a reader who needs certainty can exclude
--  them; the default does not make that choice for them.
--
--  ─── WHAT IS NOT DONE ──────────────────────────────────────────────────────
--  "Replace them with CHART bars where you can" needs a refetch, and the
--  refetch is `tradingview.backfill --date=...`, which is MANUAL until the
--  --date fix is deployed (it ignored the parameter and refetched thirty days,
--  overwriting three weeks of bars). So the replacement is an operator step
--  after this deploy, not a migration — and the days it needs are already on
--  the list: 9, 10, 24 and 25 August.
-- ===========================================================================

CREATE OR REPLACE VIEW public.tradingview_daily AS
SELECT h.*
  FROM public.tradingview_history h
 WHERE COALESCE(h.bar_source, 'UNKNOWN') <> 'MINUTES';

COMMENT ON VIEW public.tradingview_daily IS
  'D8. tradingview_history with the MINUTES bars removed. Against the official '
  'closes, CHART matches 2,493/2,493, UNKNOWN 393/400 and MINUTES 300/781 — a '
  'minute bar''s close is the last print the ~60s grid caught, not the closing '
  'auction. Anything asking "what did this close at" reads THIS view; '
  'tradingview_history stays whole for anyone asking what was captured. UNKNOWN '
  'is deliberately kept: 14,191 rows, 98% correct, and excluding them would '
  'trade the bulk of the history for a 2% error.';

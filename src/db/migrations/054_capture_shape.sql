-- ===========================================================================
--  054_capture_shape.sql — D2 · the session's own shape, recorded per day
--
--  Five sessions in the last five weeks were missed or cut short, and in every
--  case the damage was found weeks later by someone counting rows by hand:
--
--      14 Sep  stopped 11:59  — no closing auction, no Trading at Last, no
--                               close. symbol_day stored the 11:59 prices as
--                               that day's closes, labelled TRADING_AT_LAST.
--      26 Aug  stopped 12:23  — no close.
--      20 Sep  started 10:11  — the first 71 minutes of trading missed.
--      15 Sep  started 09:09  — the open missed.
--      24 Sep  close first captured 14:43, against a usual ~13:15.
--
--  The 14 September stop is the one that shows why this belongs in a column
--  rather than in a runbook. It did not stay on 14 September: prev_close on
--  15 September is wrong on 108 of 134 symbols BECAUSE the previous day's
--  close was a mid-session price wearing a close's label (D3). A capture that
--  stops early is not one bad day, it is a bad day and every day that reads
--  back to it.
--
--  ─── WHY MARKET_DAY AND NOT SYMBOL_DAY ─────────────────────────────────────
--  `largest_gap_secs` used to be a symbol_day column. It was one of the 45
--  dropped in 053 — declared, never written — and putting it back per-symbol
--  would be repeating the original mistake, because the measurement is not
--  per-symbol. ONE client scrapes the whole board, so when capture dies it
--  dies for every symbol at the same instant. 137 copies of one fact, with
--  137 chances to disagree.
--
--  ─── WHAT EACH COLUMN IS FOR ───────────────────────────────────────────────
--  These are not diagnostics for a human to glance at. They are the inputs to
--  the question D3 has to answer every night — IS THIS DAY'S CLOSE A CLOSE? —
--  and close_source cannot be honest without them.
-- ===========================================================================

ALTER TABLE public.market_day
  ADD COLUMN IF NOT EXISTS first_capture_at        timestamptz,
  ADD COLUMN IF NOT EXISTS last_trading_capture_at timestamptz,
  ADD COLUMN IF NOT EXISTS largest_gap_secs        integer,
  ADD COLUMN IF NOT EXISTS largest_gap_at          timestamptz,
  ADD COLUMN IF NOT EXISTS close_of_day_rows       integer,
  ADD COLUMN IF NOT EXISTS session_minutes_captured integer;

COMMENT ON COLUMN public.market_day.first_capture_at IS
  'D2. The first capture of any session that day. The pre-open rule since 19 Sep '
  'is 08:45; it was 08:47 on 21 and 24 Sep and 10:11 on 20 Sep. NULL means no '
  'capture at all, which is not the same as a late one.';

COMMENT ON COLUMN public.market_day.last_trading_capture_at IS
  'D2. The last capture with session = ''Trading''. Continuous trading ends at '
  '13:00 and the grid is ~60 s, so a complete session ends at 12:59 or 13:00 — '
  'anything earlier is a stop, and 14 Sep (11:59) and 26 Aug (12:23) are the two '
  'on record.';

COMMENT ON COLUMN public.market_day.largest_gap_secs IS
  'D2. The longest run with no Trading capture, inside continuous trading only. '
  'Market-wide by construction: one client scrapes the whole board, so a capture '
  'death is the same instant for every symbol. This was a symbol_day column once '
  '— declared, never written, dropped in 053 — and per-symbol was the wrong '
  'shape for it, not just the wrong table.';

COMMENT ON COLUMN public.market_day.largest_gap_at IS
  'D2. When the largest gap STARTED — the timestamp of the last capture before '
  'it. A duration with no position in the day cannot be matched against a deploy, '
  'a restart or a halt, which is the first thing anyone asks.';

COMMENT ON COLUMN public.market_day.close_of_day_rows IS
  'D2/D3. How many Close-Of-Day rows were captured. ZERO IS THE LOAD-BEARING '
  'VALUE: it means this day has no official close, so anything symbol_day stores '
  'as close_px is a mid-session price and close_source must say so. 14 Sep is the '
  'case that made this a column.';

COMMENT ON COLUMN public.market_day.session_minutes_captured IS
  'D2. Distinct minutes inside continuous trading (09:00-13:00) with at least one '
  'capture, out of 240. The denominator is the SESSION, not the capture window — '
  '049''s correction, which had 13 Sep reading 108% coverage by dividing 259 '
  'captured minutes from 08:40 by a 240-minute session.';

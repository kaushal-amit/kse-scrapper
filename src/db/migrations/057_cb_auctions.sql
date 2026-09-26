-- ===========================================================================
--  057_cb_auctions.sql — D4 · counting auctions, not capture rows
--
--  symbol_day.cb_events counted CB Auction CAPTURE ROWS. A halt lasting ten
--  minutes produces ten of them, and one lasting thirty produces thirty, so
--  the column reported the DURATION of halts in units of the capture grid
--  while being named and read as a count of events. It matched the real
--  auction count on 17 of 338 breaker symbol-days — 5%.
--
--  It was dropped in 053 as a column with no writer, which it also was. This
--  is the replacement, under a name that says what it holds.
--
--  ─── THE RULE, AS THE EXCHANGE BEHAVES ─────────────────────────────────────
--  Consecutive CB Auction captures are ONE auction. What separates two
--  auctions inside an unbroken run of CB Auction rows is that VOLUME MOVED
--  between them: the auction cleared, printed, and the stock went back into
--  another one. FUTUREKID had 8 on 3 September, and no gap in the session
--  label anywhere in them.
--
--  Without the volume clause the count is 1 for that day. With only the
--  volume clause and no session transition, a stock that never halts counts
--  an auction every time it trades. Both halves are load-bearing.
--
--  ─── AND cb_events_total IS SUMMED FROM IT ─────────────────────────────────
--  market_day.cb_events_total is NULL on all 48 stored days. It was never
--  written by anything. It becomes the sum of this column, so the market
--  figure and the per-symbol figures cannot disagree — 049's lesson about
--  thin_symbols, where 16 of 48 stored values disagreed with the symbol_day
--  rows they claimed to count.
-- ===========================================================================

ALTER TABLE public.symbol_day
  ADD COLUMN IF NOT EXISTS cb_auctions integer;

COMMENT ON COLUMN public.symbol_day.cb_auctions IS
  'D4. How many circuit-breaker AUCTIONS this symbol went into, not how many CB '
  'Auction rows were captured. A run of consecutive CB Auction captures is ONE '
  'auction unless volume moved between two of them, which means the previous one '
  'cleared and printed: FUTUREKID had 8 on 3 September inside an unbroken run of '
  'the label. The dropped cb_events counted capture rows and so measured halt '
  'DURATION in grid units while being read as a count — it agreed with the real '
  'figure on 17 of 338 breaker symbol-days. NULL means not computed; 0 means '
  'measured and there were none.';

COMMENT ON COLUMN public.market_day.cb_events_total IS
  'D4. The day''s circuit-breaker auctions, summed from symbol_day.cb_auctions so '
  'the market figure cannot disagree with the rows beneath it. NULL on every '
  'stored day before this migration because nothing ever wrote it.';

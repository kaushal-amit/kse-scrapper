-- ===========================================================================
--  055_exchange_reference_close.sql — D3 · stop reconstructing a number the
--                                     exchange publishes
--
--  The board carries `chg` beside `last_price`, computed by the exchange
--  against its own reference: the previous official close. So `last_price -
--  chg` IS that close, published, constant through the day, for every symbol.
--
--  We were rebuilding it instead. previousCloses() reaches back for the last
--  session whose capture ran late enough to be usable, takes its best close by
--  precedence tier, and caps the reach at five sessions. Every rule in that
--  chain is careful and several were hard-won. All of them are answering a
--  question the feed answers directly.
--
--  Measured against the exchange on 26 September, over 6,082 symbol-days:
--
--      1,138 differ            389 by more than 1%        41 by more than 5%
--
--  and they cluster exactly where a reconstruction fails: July, when closes
--  came from the Trading session; the days after the 19-23 August gap; and
--  15 September, where 108 of 134 symbols are wrong for one reason — the
--  14 September capture stopped at 11:59, so a mid-session price was stored as
--  that day's close (labelled TRADING_AT_LAST, for a session never captured)
--  and then carried forward as 15 September's reference.
--
--  ─── WHAT THAT MAKES THE OLD MACHINERY ─────────────────────────────────────
--  Not wrong — SECOND. previousCloses() stays, as the fallback for a symbol
--  with no usable `chg` on the day, and prev_close_source says which answered.
--  A fallback that cannot be distinguished from the primary is how the last
--  four defects survived, so the column is not optional.
--
--  ─── AND THE CLOSE ITSELF, WHERE THERE ISN'T ONE ───────────────────────────
--  The same identity repairs the other half. If a day has no Close-Of-Day
--  capture, its official close is unknown that night — but it is published the
--  NEXT morning, as the next session's reference. 14 September's real close is
--  15 September's `last_price - chg`.
--
--  This is why close_source gains two values rather than one. A close taken
--  from the next session's reference IS the official close and should not be
--  confused with a mid-session print; a day still waiting for that session is
--  not the same as a day that has been repaired.
-- ===========================================================================

ALTER TABLE public.symbol_day
  ADD COLUMN IF NOT EXISTS prev_close_source     text,
  ADD COLUMN IF NOT EXISTS prev_close_ref_spread numeric;

ALTER TABLE public.symbol_day DROP CONSTRAINT IF EXISTS symbol_day_prev_close_source_valid;
ALTER TABLE public.symbol_day ADD CONSTRAINT symbol_day_prev_close_source_valid CHECK (
  prev_close_source IS NULL
  OR prev_close_source IN ('EXCHANGE_REFERENCE', 'CARRIED_FORWARD'));

COMMENT ON COLUMN public.symbol_day.prev_close_source IS
  'D3. EXCHANGE_REFERENCE — taken from last_price - chg on this day''s own '
  'quotes, which is the exchange''s published previous close. CARRIED_FORWARD — '
  'no usable chg on the day, so previousCloses() reached back for it, which is '
  'the rule that disagreed with the exchange on 1,138 of 6,082 symbol-days. '
  'NULL means prev_close is NULL. A fallback nothing can distinguish from the '
  'primary is how four defects survived this month, so this column is not '
  'optional.';

COMMENT ON COLUMN public.symbol_day.prev_close_ref_spread IS
  'D3. The exchange reference is constant through a session by construction, so '
  'this is 0 on every clean day. Non-zero means the feed contradicted itself — a '
  'mislabelled row, or a capture straddling a corporate action — and prev_close '
  'is suspect however plausible it looks. Recorded rather than resolved, because '
  'the disagreement is the finding.';

-- ---------------------------------------------------------------------------
-- close_source gains the two repair states.
-- ---------------------------------------------------------------------------
ALTER TABLE public.symbol_day DROP CONSTRAINT IF EXISTS symbol_day_close_source_valid;
ALTER TABLE public.symbol_day ADD CONSTRAINT symbol_day_close_source_valid CHECK (
  close_source IS NULL
  OR close_source IN (
    'CLOSE_OF_DAY',            -- the official close, captured
    'CLOSING',
    'TRADING_AT_LAST',
    'AUCTION',
    'TRADING',                 -- a mid-session print, and the label says so
    -- D3 · the official close, recovered the next morning from that session's
    -- reference price. This is NOT a downgrade of CLOSE_OF_DAY: it is the same
    -- number from the same authority, arriving a day later because our capture
    -- was not running when it was first published.
    'NEXT_SESSION_REFERENCE',
    -- D3 · this day has no Close-Of-Day capture AND no following session yet,
    -- so close_px is a mid-session price and its real close is not knowable
    -- today. Distinct from TRADING, which describes where the number came
    -- from; this describes what is still owed.
    'AWAITING_NEXT_SESSION'));

COMMENT ON COLUMN public.symbol_day.close_source IS
  'D3. Where close_px came from, in precedence order. The two new states are '
  'repairs: NEXT_SESSION_REFERENCE is the official close recovered from the '
  'following session''s last_price - chg (14 September''s real close is '
  '15 September''s reference), and AWAITING_NEXT_SESSION marks a day whose close '
  'was never captured and whose following session has not arrived yet. A day '
  'with no Close-Of-Day capture must never be labelled as though it had one — '
  'that is what put 11:59 prices in the table as 14 September''s closes.';

-- ---------------------------------------------------------------------------
-- C3 · range_source IS RETIRED, NOT REPAIRED.
--
-- The rule marked a range FULL when continuous trading reached 13:10.
-- Continuous trading ends at 13:00, so it could never fire; 050 moved the
-- threshold to 13:00, and that was still wrong, because captures are 60
-- seconds apart and a COMPLETE session's last capture lands at 12:59. Measured
-- over 48 stored days: 43 end at 12:59, 2 at 13:00, 3 earlier. At 1300 the
-- column would read FULL on two days out of forty-eight.
--
-- Amit, 26 September, on being shown that: the fix is not a third threshold.
-- Once D6 takes high and low from the feed's own high_price/low_price, the
-- range is not sampled at all, so "was our capture long enough to have seen
-- the extremes" stops being a question about the range. The signal that
-- matters — is this day complete — belongs to close_source, which D3 above
-- makes truthful.
--
-- THE COLUMN IS NOT DROPPED HERE. spread.symbol_day (backend) projects it, so
-- Postgres refuses the drop while that view exists. Backend migration 079
-- rebuilds the view without it and MUST BE DEPLOYED FIRST; 056 then drops the
-- column. Stopping the write is done here so that nothing is written under a
-- rule known to be false, even for the length of one deploy.
-- ---------------------------------------------------------------------------
UPDATE public.symbol_day SET range_source = NULL WHERE range_source IS NOT NULL;

COMMENT ON COLUMN public.symbol_day.range_source IS
  'RETIRED (055, C3). Never written again and NULL on every row. The rule asked '
  'whether capture reached 13:10, then 13:00, against a session that ends at '
  '13:00 with a 60-second grid — so a complete day, ending 12:59, read SHORT. '
  'Superseded: D6 takes high and low from the feed''s own extremes, so the range '
  'is no longer sampled and capture length no longer bears on it. Completeness '
  'is close_source''s job now. Dropped by 056, after backend 079 stops '
  'projecting it.';

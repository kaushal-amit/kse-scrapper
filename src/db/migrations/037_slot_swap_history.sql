-- ===========================================================================
--  037_slot_swap_history.sql — what a slot replaced, and why
--
--  ALOLA became INJAZZAT at 09:50 on 2 September. MUNTAZAHAT became SHUAIBA at
--  11:28 the day before. Neither is recorded anywhere, so a week later a symbol
--  with half a session of book data has no explanation — and the obvious
--  reading, that capture broke, is wrong.
--
--  Same argument as close_source: the fact, plus why.
-- ===========================================================================

ALTER TABLE public.depth_watchlist
  ADD COLUMN IF NOT EXISTS replaced_symbol text,
  ADD COLUMN IF NOT EXISTS replaced_at     timestamptz,
  ADD COLUMN IF NOT EXISTS replaced_by     text,
  ADD COLUMN IF NOT EXISTS replaced_reason text;

ALTER TABLE public.depth_watchlist DROP CONSTRAINT IF EXISTS depth_watchlist_replaced_by_valid;
ALTER TABLE public.depth_watchlist ADD CONSTRAINT depth_watchlist_replaced_by_valid
  CHECK (replaced_by IS NULL OR replaced_by IN ('UI', 'WAKEUP', 'SEED'));

COMMENT ON COLUMN public.depth_watchlist.replaced_symbol IS
  'What this slot held before. NULL means the slot was empty — not that nothing '
  'was displaced.';
COMMENT ON COLUMN public.depth_watchlist.replaced_by IS
  'UI: a deliberate swap during the session. WAKEUP: a scan claimed a free '
  'slot. SEED: assigned before the open. A wake-up NEVER displaces an occupied '
  'slot — it would overwrite a choice made ninety seconds earlier and look like '
  'a bug nobody could trace.';

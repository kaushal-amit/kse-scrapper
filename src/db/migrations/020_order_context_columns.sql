-- ===========================================================================
--  020_order_context_columns.sql — four fields the source has and we discard
--
--  code, order_type, exchange and portfolio are on every source row and had
--  nowhere to go. They survive inside `raw`, but a value only reachable by
--  digging through JSON is one nobody will query — and order_type in
--  particular decides whether a fill is comparable to the strategy at all.
-- ===========================================================================

ALTER TABLE public.awsat_order_list
  ADD COLUMN IF NOT EXISTS code       text,
  ADD COLUMN IF NOT EXISTS order_type text,
  ADD COLUMN IF NOT EXISTS exchange   text,
  ADD COLUMN IF NOT EXISTS portfolio  text;

COMMENT ON COLUMN public.awsat_order_list.order_type IS
  'Limit or Market. SPREAD never crosses the spread, so a Market fill is '
  'outside the strategy and must be excluded from its statistics rather than '
  'averaged in.';
COMMENT ON COLUMN public.awsat_order_list.code IS
  'The Boursa numeric code. It outlives a ticker rename — KPPC and PHC share '
  '624 — so it is the only stable identifier across one.';
COMMENT ON COLUMN public.awsat_order_list.portfolio IS
  'The account the order was placed from. Needed the moment a second account '
  'exists; without it two accounts'' fills are indistinguishable.';

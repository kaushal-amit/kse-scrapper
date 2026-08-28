-- ===========================================================================
--  014_order_money_columns.sql — the money columns awsat_order_list lacked
--
--  The P&L had to be reconstructed by hand and was wrong three times. Every
--  value below is already in the JSON the broker sends; the old table simply
--  had nowhere to put it.
-- ===========================================================================

ALTER TABLE public.awsat_order_list
  ADD COLUMN IF NOT EXISTS avg_price     numeric,
  ADD COLUMN IF NOT EXISTS order_value   numeric,
  ADD COLUMN IF NOT EXISTS net_value     numeric,
  ADD COLUMN IF NOT EXISTS status_reason text,
  ADD COLUMN IF NOT EXISTS executions    integer DEFAULT 1,
  ADD COLUMN IF NOT EXISTS raw           jsonb;

COMMENT ON COLUMN public.awsat_order_list.net_value IS
  'THE P&L NUMBER. raw->>''netOrdVal''. The old table had this NULL on all '
  '5,520 rows while the JSON held it on 5,482.';
COMMENT ON COLUMN public.awsat_order_list.executions IS
  'Count of fills. The settlement fee is charged PER EXECUTION, not per order: '
  'a 6,100-share sell filled as 5,350 + 750 was charged 2.285 against a formula '
  'expecting 1.680. Incremented whenever filled_quantity is seen to rise.';
COMMENT ON COLUMN public.awsat_order_list.raw IS
  'Every field the broker sends, kept whole. The old table silently dropped '
  'fields the extractor did not know about — including netOrdVal.';

-- executions must never be zero or negative: it multiplies the fee.
ALTER TABLE public.awsat_order_list
  DROP CONSTRAINT IF EXISTS awsat_orders_executions_positive;
ALTER TABLE public.awsat_order_list
  ADD CONSTRAINT awsat_orders_executions_positive
  CHECK (executions IS NULL OR executions >= 1);

CREATE INDEX IF NOT EXISTS awsat_orders_net_value_idx
  ON public.awsat_order_list (trading_date) WHERE net_value IS NOT NULL;

-- ---------------------------------------------------------------------------
-- last_trade_time is a clock time, not free text.
--
-- NULLIF first: an empty string is not a time and the cast would fail on it,
-- taking the whole migration down over a blank cell.
-- ---------------------------------------------------------------------------
ALTER TABLE public.awsat_market_quotes
  ALTER COLUMN last_trade_time TYPE time
  USING NULLIF(regexp_replace(last_trade_time, '[^0-9:]', '', 'g'), '')::time;

-- ---------------------------------------------------------------------------
-- intrinsic_value was 100% NULL across 838,762 rows.
--
-- A column that has never held a value is not a gap to fill later; it is a
-- field the feed does not send, and keeping it invites someone to read the
-- NULL as "zero" rather than "never provided".
-- ---------------------------------------------------------------------------
ALTER TABLE public.awsat_market_quotes DROP COLUMN IF EXISTS intrinsic_value;

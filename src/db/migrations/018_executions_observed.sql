-- ===========================================================================
--  018_executions_observed.sql — name the number for what it is
--
--  executions was derived by watching filled_quantity rise between sightings.
--  The grid is polled every 60 seconds, so two fills inside one interval are
--  seen as one: the reference 6,100-share sell filling as 5,350 + 750 records
--  executions = 1 if both land in the same minute.
--
--  Commission is charged PER EXECUTION, so an undercount understates the fee —
--  2.285 charged against a formula expecting 1.680. The number is a MINIMUM
--  and its name should say so, because "executions" invites arithmetic that
--  treats it as exact.
-- ===========================================================================

ALTER TABLE public.awsat_order_list
  RENAME COLUMN executions TO executions_observed;

ALTER TABLE public.awsat_order_list
  RENAME CONSTRAINT awsat_orders_executions_positive TO awsat_orders_executions_observed_positive;

COMMENT ON COLUMN public.awsat_order_list.executions_observed IS
  'A LOWER BOUND on the fill count, not the count. Derived from '
  'filled_quantity rising between 60-second sightings, so fills inside one '
  'interval collapse into one. Commission is per execution, so any fee '
  'computed from this is a MINIMUM fee.';

-- ---------------------------------------------------------------------------
-- Where the observed count is provably too low.
--
-- The broker's own numbers give the fee: order_value is the gross, net_value
-- the net, so the difference is what was charged. Divided by the observed
-- count that yields a fee-per-execution — and a value well above the rest is
-- the signature of fills the poll never saw.
--
-- A VIEW, not a stored flag: the threshold will change as the fee schedule is
-- understood, and a stored verdict computed under an old threshold would
-- outlive it silently.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.order_fee_check AS
WITH fees AS (
  SELECT order_id, symbol, trading_date, side, quantity, filled_quantity,
         executions_observed, order_value, net_value,
         abs(COALESCE(net_value, 0) - COALESCE(order_value, 0)) AS fee_charged
    FROM public.awsat_order_list
   WHERE order_value IS NOT NULL AND net_value IS NOT NULL
     AND COALESCE(filled_quantity, 0) > 0
),
per_exec AS (
  SELECT *, fee_charged / GREATEST(executions_observed, 1) AS fee_per_execution
    FROM fees
),
baseline AS (
  SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY fee_per_execution) AS median_fee
    FROM per_exec WHERE fee_charged > 0
)
SELECT p.*,
       b.median_fee,
       -- Above twice the median, the most likely explanation is that the fee
       -- covers more executions than were observed.
       (b.median_fee IS NOT NULL AND b.median_fee > 0
        AND p.fee_per_execution > b.median_fee * 2) AS executions_likely_understated
  FROM per_exec p CROSS JOIN baseline b
 ORDER BY p.fee_per_execution DESC;

COMMENT ON VIEW public.order_fee_check IS
  'Orders whose fee-per-execution is an outlier — the signature of fills the '
  '60-second poll never saw. executions_observed is a floor, so a fee well '
  'above the median per execution means the real count was higher.';

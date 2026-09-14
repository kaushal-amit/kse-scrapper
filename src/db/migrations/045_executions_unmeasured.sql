-- ---------------------------------------------------------------------------
-- 045 · executions_observed tells the truth, including when the truth is
--       "we cannot know" — and order_fee_check is bound to the view again.
--
-- THE SETTLEMENT FEE IS CHARGED PER EXECUTION. executions_observed is money,
-- and 039/041 derived it in a way that was wrong on the most common order shape
-- in the book. Four defects, all in one CTE:
--
--   1 · THE PHANTOM +1. The base `1 +` exists to account for a fill that was
--       already present at the first sighting — but it was added
--       UNCONDITIONALLY, without checking whether the first sighting was
--       filled. An order first seen UNFILLED and then filled once counted its
--       single rise AND the base: two executions for one execution, and a fee
--       reconciliation that quietly doubles.
--
--   2 · GREATEST(1, …) UNCONDITIONAL. An order cancelled having NEVER filled
--       reported one execution. There is nothing to charge a settlement fee on;
--       the honest number is zero.
--
--   3 · A NULL POISONED THE CHAIN. A sighting where the filled cell did not
--       render stored NULL. `prev_filled IS NOT NULL` then failed on the row
--       AFTER it, so a genuine rise across that gap was LOST — an execution we
--       paid for and did not count. A sighting that did not read the fill
--       carries no evidence either way, so it is removed from the chain rather
--       than treated as a reading of zero.
--
--   4 · NO PARTITION BY ingest_source. Two sources observing the same order
--       interleave in observed_at order. A stale reading from one source
--       between two fresh ones from the other reads as a fall and then a second
--       rise — an execution INVENTED by the act of having two sources. Each
--       source is now its own chain.
--
-- THE DECISION (Amit, 14 Sep) — and it is the standing principle applied to
-- money: where a fix has two forms, make the failure loud. When an order is
-- FIRST SIGHTED ALREADY FILLED there is no rise to count and no evidence of how
-- many executions produced that fill. The answer is NULL — unmeasured — not a
-- plausible 1. order_fee_check surfaces it as such and the backend's fee model
-- already treats an unknown count as best-case.
--
-- Across sources, the verdict is the MAX of the measurable ones, never the sum:
-- two sources watching one order are two views of the SAME executions, so
-- summing would double every fill. If no source could measure it, NULL.
-- ---------------------------------------------------------------------------

-- ── the derivation ──────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.awsat_order_list AS
WITH steps AS (
  -- A sighting that did not read filled_quantity is not in the chain at all.
  -- Dropping it is what "skipped, not counted as a fall" means: the next
  -- sighting's prev_filled is the last value actually READ, so a rise across
  -- the gap survives.
  SELECT
    o.order_id,
    o.ingest_source,
    o.filled_quantity,
    lag(o.filled_quantity) OVER (
      PARTITION BY o.order_id, o.ingest_source ORDER BY o.observed_at, o.id) AS prev_filled,
    row_number() OVER (
      PARTITION BY o.order_id, o.ingest_source ORDER BY o.observed_at, o.id) AS rn
  FROM public.awsat_order_obs o
  WHERE o.filled_quantity IS NOT NULL
),
per_source AS (
  SELECT
    order_id,
    ingest_source,
    -- The first reading THIS SOURCE ever got. If it already showed a fill, the
    -- executions behind that fill happened before we were looking.
    bool_or(rn = 1 AND filled_quantity > 0) AS started_filled,
    count(*) FILTER (WHERE prev_filled IS NOT NULL
                       AND filled_quantity > prev_filled)::int AS rises
  FROM steps
  GROUP BY order_id, ingest_source
),
execs AS (
  -- max() skips NULLs, so an order no source could measure yields NULL.
  SELECT
    order_id,
    max(CASE WHEN started_filled THEN NULL ELSE rises END)::int AS executions_observed
  FROM per_source
  GROUP BY order_id
),
complete_capture AS (
  SELECT
    (captured_at AT TIME ZONE 'Asia/Kuwait')::date AS day,
    max(captured_at) AS at
  FROM public.client_submissions
  WHERE kind = 'orders' AND partial = false AND captured_at IS NOT NULL
  GROUP BY 1
),
latest AS (
  SELECT
    o.order_id,
    (array_remove(array_agg(o.symbol ORDER BY o.observed_at DESC, o.id DESC), NULL))[1] AS symbol,
    (array_remove(array_agg(o.side ORDER BY o.observed_at DESC, o.id DESC), NULL))[1] AS side,
    (array_remove(array_agg(o.order_status ORDER BY o.observed_at DESC, o.id DESC), NULL))[1] AS order_status,
    (array_remove(array_agg(o.price ORDER BY o.observed_at DESC, o.id DESC), NULL))[1] AS price,
    (array_remove(array_agg(o.quantity ORDER BY o.observed_at DESC, o.id DESC), NULL))[1] AS quantity,
    (array_remove(array_agg(o.filled_quantity ORDER BY o.observed_at DESC, o.id DESC), NULL))[1] AS filled_quantity,
    (array_remove(array_agg(o.remaining_qty ORDER BY o.observed_at DESC, o.id DESC), NULL))[1] AS remaining_qty,
    (array_remove(array_agg(o.order_time ORDER BY o.observed_at DESC, o.id DESC), NULL))[1] AS order_time,
    (array_remove(array_agg(o.ingest_source ORDER BY o.observed_at DESC, o.id DESC), NULL))[1] AS ingest_source,
    (array_remove(array_agg(o.run_id ORDER BY o.observed_at DESC, o.id DESC), NULL))[1] AS run_id,
    (array_remove(array_agg(o.avg_price ORDER BY o.observed_at DESC, o.id DESC), NULL))[1] AS avg_price,
    (array_remove(array_agg(o.order_value ORDER BY o.observed_at DESC, o.id DESC), NULL))[1] AS order_value,
    (array_remove(array_agg(o.net_value ORDER BY o.observed_at DESC, o.id DESC), NULL))[1] AS net_value,
    (array_remove(array_agg(o.status_reason ORDER BY o.observed_at DESC, o.id DESC), NULL))[1] AS status_reason,
    (array_remove(array_agg(o.code ORDER BY o.observed_at DESC, o.id DESC), NULL))[1] AS code,
    (array_remove(array_agg(o.order_type ORDER BY o.observed_at DESC, o.id DESC), NULL))[1] AS order_type,
    (array_remove(array_agg(o.exchange ORDER BY o.observed_at DESC, o.id DESC), NULL))[1] AS exchange,
    (array_remove(array_agg(o.portfolio ORDER BY o.observed_at DESC, o.id DESC), NULL))[1] AS portfolio,
    (array_remove(array_agg(o.raw ORDER BY o.observed_at DESC, o.id DESC), NULL))[1] AS raw,
    (array_remove(array_agg(o.trading_date ORDER BY o.observed_at DESC, o.id DESC), NULL))[1] AS trading_date,
    min(o.created_at)               AS created_at,
    min(o.observed_at)              AS first_seen_at,
    max(o.observed_at)              AS last_seen_at,
    count(*)::int                   AS sighting_count,
    max(o.updated_at)               AS updated_at
  FROM public.awsat_order_obs o
  GROUP BY o.order_id
)
SELECT
  (SELECT max(id) FROM public.awsat_order_obs x WHERE x.order_id = l.order_id) AS id,
  l.*,
  e.executions_observed,
  CASE WHEN c.at IS NULL THEN NULL ELSE (l.last_seen_at >= c.at) END AS seen_in_latest,
  CASE
    WHEN c.at IS NULL THEN l.order_status
    WHEN l.last_seen_at >= c.at THEN l.order_status
    ELSE 'UNSEEN'
  END AS effective_status
FROM latest l
-- LEFT, not INNER. An order whose every sighting had a NULL filled cell has no
-- row in execs at all; an inner join would DROP THE ORDER rather than report it
-- with an unmeasured execution count.
LEFT JOIN execs e USING (order_id)
LEFT JOIN complete_capture c
  ON c.day = (l.last_seen_at AT TIME ZONE 'Asia/Kuwait')::date;

COMMENT ON VIEW public.awsat_order_list IS
  'CR-10/11 · the latest state of each order, derived from awsat_order_obs. '
  'executions_observed counts filled_quantity rises per ingest_source and is '
  'NULL when the order was first sighted already filled — unmeasured, not 1.';

-- ── order_fee_check, rebound ────────────────────────────────────────────────
--
-- 018 created this view over public.awsat_order_list when that name was a
-- TABLE. 039 renamed that table to awsat_order_obs — and a view's dependency is
-- bound by OID, not by name, so order_fee_check FOLLOWED THE RENAME. Since 039
-- it has been reading the raw append-only observations (one row per sighting,
-- not per order) and their `executions_observed` COLUMN, which 039 itself
-- comments as a legacy accumulator not to be read.
--
-- The instrument that tells us when the broker charged for fills we did not
-- see has been reporting numbers computed over duplicated rows. DROP and
-- recreate over the VIEW, by name, now that the name means the right thing.
DROP VIEW IF EXISTS public.order_fee_check;

CREATE VIEW public.order_fee_check AS
WITH fees AS (
  SELECT order_id, symbol, trading_date, side, quantity, filled_quantity,
         executions_observed, order_value, net_value,
         abs(COALESCE(net_value, 0) - COALESCE(order_value, 0)) AS fee_charged
    FROM public.awsat_order_list
   WHERE order_value IS NOT NULL AND net_value IS NOT NULL
     AND COALESCE(filled_quantity, 0) > 0
),
per_exec AS (
  -- NULL executions_observed divides to NULL, not to fee_charged/1. An order
  -- whose execution count is unmeasured must not enter the baseline as though
  -- it were a single-execution order — that is exactly how an unknown becomes
  -- a plausible-but-wrong number.
  SELECT *,
         CASE WHEN executions_observed > 0
              THEN fee_charged / executions_observed END AS fee_per_execution,
         (executions_observed IS NULL) AS executions_unmeasured
    FROM fees
),
baseline AS (
  SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY fee_per_execution) AS median_fee
    FROM per_exec WHERE fee_charged > 0 AND fee_per_execution IS NOT NULL
)
SELECT p.*,
       b.median_fee,
       (b.median_fee IS NOT NULL AND b.median_fee > 0
        AND p.fee_per_execution > b.median_fee * 2) AS executions_likely_understated
  FROM per_exec p CROSS JOIN baseline b
 ORDER BY p.executions_unmeasured DESC, p.fee_per_execution DESC NULLS LAST;

COMMENT ON VIEW public.order_fee_check IS
  'Orders whose fee-per-execution is an outlier — the signature of fills the '
  'capture did not see. Reads awsat_order_list (the view). Rows with '
  'executions_unmeasured = true have no execution count at all: the order was '
  'already filled when first sighted.';

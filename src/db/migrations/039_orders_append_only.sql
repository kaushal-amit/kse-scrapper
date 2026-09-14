-- ============================================================================
-- 039 · CR-10 / CR-11 — the order list becomes APPEND-ONLY.
--
-- WHAT WAS WRONG
--
-- awsat_order_list was one row per order_id, upserted on every sighting. That
-- makes the table a picture of NOW and destroys the history as it goes: when a
-- fill is observed, the quantity that was there a minute ago is gone, and the
-- only reason we know a second execution happened is that a counter was
-- incremented in the ON CONFLICT clause. Get that clause wrong once — as the
-- row-by-row fallback did for months, omitting net_value entirely — and the
-- number is silently wrong with nothing left to recompute it from.
--
-- The settlement fee is charged PER EXECUTION, so executions_observed is money.
-- A number that is money should be derived from observations, not accumulated
-- in an UPDATE that has to be right every single time.
--
-- WHAT THIS DOES
--
--   · awsat_order_list (table) -> awsat_order_obs, one row per SIGHTING.
--   · awsat_order_list comes back as a VIEW: the latest state of each order,
--     with sighting_count and executions_observed DERIVED from the sightings.
--
-- Every existing reader keeps working: the view carries the same column names.
-- The writer changes to append, which is the one thing a capture service should
-- be doing anyway — a capture is an observation, and observations do not update.
--
-- BACK UP FIRST. This renames a table holding the trader's own order history.
-- ============================================================================

ALTER TABLE IF EXISTS public.awsat_order_list RENAME TO awsat_order_obs;

-- The unique key was (order_id). Append-only means many rows per order.
ALTER TABLE public.awsat_order_obs DROP CONSTRAINT IF EXISTS awsat_orders_order_id_key;

-- WHEN this observation was made. Backfilled from last_seen_at (the sighting
-- the surviving row represents), then created_at, so existing rows keep a
-- truthful timestamp rather than all collapsing onto the migration's clock.
ALTER TABLE public.awsat_order_obs
  ADD COLUMN IF NOT EXISTS observed_at timestamptz;
UPDATE public.awsat_order_obs
   SET observed_at = COALESCE(last_seen_at, created_at, now())
 WHERE observed_at IS NULL;
ALTER TABLE public.awsat_order_obs ALTER COLUMN observed_at SET NOT NULL;

-- Idempotency for a replayed batch: the same order, observed at the same
-- instant, by the same collector, is the same observation. Note this REPLACES
-- upsert-on-order_id — two different instants are two rows, which is the point.
CREATE UNIQUE INDEX IF NOT EXISTS awsat_order_obs_key
  ON public.awsat_order_obs (order_id, observed_at, ingest_source);

CREATE INDEX IF NOT EXISTS awsat_order_obs_order_idx
  ON public.awsat_order_obs (order_id, observed_at DESC);

-- sighting_count and executions_observed are DERIVED by the view now. The
-- columns stay on the observation table (dropping them would rewrite it) but
-- nothing reads them there; the view computes both from the rows themselves.
COMMENT ON COLUMN public.awsat_order_obs.sighting_count IS
  'Legacy accumulator. The view derives sighting_count from the observations; do not read this.';
COMMENT ON COLUMN public.awsat_order_obs.executions_observed IS
  'Legacy accumulator. The view derives executions_observed from filled_quantity rises; do not read this.';

-- ── the view ────────────────────────────────────────────────────────────────
--
-- LATEST NON-NULL WINS, per column. That is deliberately the same rule the old
-- ON CONFLICT clause encoded with COALESCE: a sighting that omits net_value
-- means "the grid did not show it this time", never "it is now nothing".
--
-- executions_observed counts the times filled_quantity ROSE between consecutive
-- sightings, plus one. The grid reports no fill count, but it does report the
-- filled quantity, and every rise is one more execution — the difference
-- between 1.680 and 2.285 KD on a 6,100-share sell that filled as 5,350 + 750.
-- Floored at 1: an order seen once has had at least one execution if it has any
-- fill at all, and zero would understate the fee.

CREATE OR REPLACE VIEW public.awsat_order_list AS
WITH steps AS (
  SELECT
    o.order_id,
    o.filled_quantity,
    lag(o.filled_quantity) OVER (PARTITION BY o.order_id ORDER BY o.observed_at, o.id) AS prev_filled
  FROM public.awsat_order_obs o
),
execs AS (
  SELECT
    order_id,
    GREATEST(1, 1 + count(*) FILTER (
      WHERE prev_filled IS NOT NULL
        AND filled_quantity IS NOT NULL
        AND filled_quantity > prev_filled))::int AS executions_observed
  FROM steps
  GROUP BY order_id
)
SELECT
  max(o.id)                       AS id,
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
  max(o.updated_at)               AS updated_at,
  e.executions_observed
FROM public.awsat_order_obs o
JOIN execs e USING (order_id)
GROUP BY o.order_id, e.executions_observed;

COMMENT ON VIEW public.awsat_order_list IS
  'CR-10/11 · the latest state of each order, derived from awsat_order_obs. '
  'sighting_count and executions_observed are computed from the observations, '
  'not accumulated in an UPDATE. Writers append to awsat_order_obs.';

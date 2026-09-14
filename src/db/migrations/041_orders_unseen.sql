-- ============================================================================
-- 041 · S6 — a live order absent from the latest COMPLETE capture reads UNSEEN.
--
-- THE PROBLEM. The order grid is scrolled. A short scan — the terminal
-- re-rendered, the list moved, the time budget ran out — reads fewer rows than
-- are really there. Under the old upsert that was invisible: the orders it did
-- not see simply kept their last known status, so a CANCELLED order that had
-- already left the grid went on reading `Queued` for the rest of the session,
-- and the slot guard went on refusing to displace the symbol it named.
--
-- Append-only (039) keeps the evidence — the order is simply missing from the
-- later observations — but nothing READ it. This adds the reading.
--
-- TWO PIECES.
--
--   client_submissions.partial   the client says whether its scan was complete.
--                                A short scan is a fact the client knows and the
--                                server cannot infer: the server sees fewer rows
--                                and cannot tell "the grid is shorter" from "I
--                                did not reach the bottom".
--
--   awsat_order_list.seen_in_latest / effective_status
--                                an order whose last sighting predates the most
--                                recent COMPLETE capture of its day was not on
--                                the screen any more. Its stored status is
--                                stale; effective_status says UNSEEN.
--
-- WHY "COMPLETE" MATTERS. Judging absence against a PARTIAL capture would mark
-- every order below the scroll fold as UNSEEN — turning a client-side scroll
-- problem into a wrong status on real orders. Only a capture that claims to
-- have seen the whole grid is evidence of absence.
--
-- An empty grid POSTED (2.8.0) is a complete capture of nothing, which is how
-- "everything is gone" becomes expressible at all. Silence is not.
-- ============================================================================

ALTER TABLE public.client_submissions
  ADD COLUMN IF NOT EXISTS partial boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.client_submissions.partial IS
  'S6 · the client could not read the whole grid this cycle (scroll cut short, '
  'render churn). Absence from a partial capture is NOT evidence an order is gone.';

CREATE INDEX IF NOT EXISTS client_submissions_complete_idx
  ON public.client_submissions (kind, captured_at DESC)
  WHERE partial = false;

-- ── the view, with the two new columns ──────────────────────────────────────
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
),
-- The most recent capture PER DAY that claimed to have read the whole grid.
-- Per day, because yesterday's complete capture says nothing about today's
-- orders, and an order carried overnight must not read UNSEEN on that basis.
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
  /*
   * NULL, not false, when there is no complete capture for that day to judge
   * against. "We have no evidence either way" is a third state, and collapsing
   * it into false would mark every order UNSEEN on a day the client never
   * managed a full scan.
   */
  CASE WHEN c.at IS NULL THEN NULL ELSE (l.last_seen_at >= c.at) END AS seen_in_latest,
  CASE
    WHEN c.at IS NULL THEN l.order_status
    WHEN l.last_seen_at >= c.at THEN l.order_status
    ELSE 'UNSEEN'
  END AS effective_status
FROM latest l
JOIN execs e USING (order_id)
LEFT JOIN complete_capture c
  ON c.day = (l.last_seen_at AT TIME ZONE 'Asia/Kuwait')::date;

COMMENT ON VIEW public.awsat_order_list IS
  'CR-10/11 + S6 · the latest state of each order, derived from awsat_order_obs. '
  'effective_status is UNSEEN when the order was absent from the most recent '
  'COMPLETE capture of its day — its stored status is then stale. seen_in_latest '
  'is NULL when no complete capture exists to judge against.';

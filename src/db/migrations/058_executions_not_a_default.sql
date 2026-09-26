-- ===========================================================================
--  058_executions_not_a_default.sql — D5 · a DEFAULT that reads as a count,
--                                     and a copy that reads as a fill price
--
--  ─── 1 · awsat_order_obs.executions_observed ───────────────────────────────
--  The column carries DEFAULT 1 and NOTHING HAS WRITTEN IT SINCE 039. Every
--  row therefore reads 1: measured on production, 3,010 of 3,046, and 2,102
--  of those orders never filled at all. An order with no fill has had ZERO
--  executions, and the settlement fee is charged per execution, so the column
--  is money and it is a literal.
--
--  039 knew. Its own comment says so:
--
--      'Legacy accumulator. The view derives executions_observed from
--       filled_quantity rises; do not read this.'
--
--  A comment is not a check. This is the fourth time this month a column has
--  been documented as not-to-be-read and then read — the KB team queried it,
--  reasonably, because it is a column in a table with a name that answers
--  their question. The fix for "do not read this" is to remove it.
--
--  The VIEW's executions_observed is unaffected: it is derived in a CTE from
--  filled_quantity rises, and 045 already made it NULL where the order was
--  already filled at first sighting (a count that cannot be established from
--  the observations). That one is honest and stays.
--
--  ─── 2 · avg_price IS A COPY OF THE ORDER PRICE ────────────────────────────
--  It is filled on 55 of 146 filled orders and equals the order price on
--  EVERY one. The GIH buy at 600 on 22 September was entered during a breaker
--  auction that printed 587; its avg_price is 600. A limit price cannot be
--  the average fill price of an auction that cleared 13 fils away.
--
--  So it carries no information about fills, and the name is the whole
--  problem — anything reading `avg_price` is reading what it believes is an
--  execution price. It becomes NULL, and the broker's raw figure is kept as
--  avg_price_reported: kept, because discarding a field the broker sends is
--  how you lose the evidence that it was useless.
--
--  avg_price KEEPS ITS COLUMN POSITION. CREATE OR REPLACE VIEW cannot rename
--  or reorder, only append, and DROP ... CASCADE here would take every
--  dependant with it for a change that does not need one.
--
--  ─── WHAT THIS DOES NOT DO ─────────────────────────────────────────────────
--  It does not produce fill times, fill prices or an exact execution count.
--  Nothing in the database can: the broker grid reports none of them. Whether
--  the platform exposes executions at all is the one open question on D5 and
--  it is answered at a terminal, not here. Until then, NOT COMPUTED is the
--  honest value and exact fees and P&L stay out of reach.
-- ===========================================================================

ALTER TABLE public.awsat_order_obs DROP COLUMN IF EXISTS executions_observed;

CREATE OR REPLACE VIEW public.awsat_order_list AS
WITH steps AS (
         SELECT o.order_id,
            o.ingest_source,
            o.filled_quantity,
            lag(o.filled_quantity) OVER (PARTITION BY o.order_id, o.ingest_source ORDER BY o.observed_at, o.id) AS prev_filled,
            row_number() OVER (PARTITION BY o.order_id, o.ingest_source ORDER BY o.observed_at, o.id) AS rn
           FROM awsat_order_obs o
          WHERE o.filled_quantity IS NOT NULL
        ), per_source AS (
         SELECT steps.order_id,
            steps.ingest_source,
            bool_or(steps.rn = 1 AND steps.filled_quantity > 0) AS started_filled,
            count(*) FILTER (WHERE steps.prev_filled IS NOT NULL AND steps.filled_quantity > steps.prev_filled)::integer AS rises
           FROM steps
          GROUP BY steps.order_id, steps.ingest_source
        ), execs AS (
         SELECT per_source.order_id,
            max(
                CASE
                    WHEN per_source.started_filled THEN NULL::integer
                    ELSE per_source.rises
                END) AS executions_observed
           FROM per_source
          GROUP BY per_source.order_id
        ), complete_capture AS (
         SELECT (client_submissions.captured_at AT TIME ZONE 'Asia/Kuwait'::text)::date AS day,
            max(client_submissions.captured_at) AS at
           FROM client_submissions
          WHERE client_submissions.kind = 'orders'::text AND client_submissions.partial = false AND client_submissions.captured_at IS NOT NULL
          GROUP BY ((client_submissions.captured_at AT TIME ZONE 'Asia/Kuwait'::text)::date)
        ), latest AS (
         SELECT o.order_id,
            (array_remove(array_agg(o.symbol ORDER BY o.observed_at DESC, o.id DESC), NULL::text))[1] AS symbol,
            (array_remove(array_agg(o.side ORDER BY o.observed_at DESC, o.id DESC), NULL::text))[1] AS side,
            (array_remove(array_agg(o.order_status ORDER BY o.observed_at DESC, o.id DESC), NULL::text))[1] AS order_status,
            (array_remove(array_agg(o.price ORDER BY o.observed_at DESC, o.id DESC), NULL::numeric))[1] AS price,
            (array_remove(array_agg(o.quantity ORDER BY o.observed_at DESC, o.id DESC), NULL::bigint))[1] AS quantity,
            (array_remove(array_agg(o.filled_quantity ORDER BY o.observed_at DESC, o.id DESC), NULL::bigint))[1] AS filled_quantity,
            (array_remove(array_agg(o.remaining_qty ORDER BY o.observed_at DESC, o.id DESC), NULL::bigint))[1] AS remaining_qty,
            (array_remove(array_agg(o.order_time ORDER BY o.observed_at DESC, o.id DESC), NULL::timestamp with time zone))[1] AS order_time,
            (array_remove(array_agg(o.ingest_source ORDER BY o.observed_at DESC, o.id DESC), NULL::text))[1] AS ingest_source,
            (array_remove(array_agg(o.run_id ORDER BY o.observed_at DESC, o.id DESC), NULL::bigint))[1] AS run_id,
            NULL::numeric AS avg_price,
            (array_remove(array_agg(o.avg_price ORDER BY o.observed_at DESC, o.id DESC), NULL::numeric))[1] AS avg_price_reported,
            (array_remove(array_agg(o.order_value ORDER BY o.observed_at DESC, o.id DESC), NULL::numeric))[1] AS order_value,
            (array_remove(array_agg(o.net_value ORDER BY o.observed_at DESC, o.id DESC), NULL::numeric))[1] AS net_value,
            (array_remove(array_agg(o.status_reason ORDER BY o.observed_at DESC, o.id DESC), NULL::text))[1] AS status_reason,
            (array_remove(array_agg(o.code ORDER BY o.observed_at DESC, o.id DESC), NULL::text))[1] AS code,
            (array_remove(array_agg(o.order_type ORDER BY o.observed_at DESC, o.id DESC), NULL::text))[1] AS order_type,
            (array_remove(array_agg(o.exchange ORDER BY o.observed_at DESC, o.id DESC), NULL::text))[1] AS exchange,
            (array_remove(array_agg(o.portfolio ORDER BY o.observed_at DESC, o.id DESC), NULL::text))[1] AS portfolio,
            (array_remove(array_agg(o.raw ORDER BY o.observed_at DESC, o.id DESC), NULL::jsonb))[1] AS raw,
            (array_remove(array_agg(o.trading_date ORDER BY o.observed_at DESC, o.id DESC), NULL::date))[1] AS trading_date,
            min(o.created_at) AS created_at,
            min(o.observed_at) AS first_seen_at,
            max(o.observed_at) AS last_seen_at,
            count(*)::integer AS sighting_count,
            max(o.updated_at) AS updated_at
           FROM awsat_order_obs o
          GROUP BY o.order_id
        )
 SELECT ( SELECT max(x.id) AS max
           FROM awsat_order_obs x
          WHERE x.order_id = l.order_id) AS id,
    l.order_id,
    l.symbol,
    l.side,
    l.order_status,
    l.price,
    l.quantity,
    l.filled_quantity,
    l.remaining_qty,
    l.order_time,
    l.ingest_source,
    l.run_id,
    l.avg_price,
    l.order_value,
    l.net_value,
    l.status_reason,
    l.code,
    l.order_type,
    l.exchange,
    l.portfolio,
    l.raw,
    l.trading_date,
    l.created_at,
    l.first_seen_at,
    l.last_seen_at,
    l.sighting_count,
    l.updated_at,
    e.executions_observed,
        CASE
            WHEN c.at IS NULL THEN NULL::boolean
            ELSE l.last_seen_at >= c.at
        END AS seen_in_latest,
        CASE
            WHEN c.at IS NULL THEN l.order_status
            WHEN l.last_seen_at >= c.at THEN l.order_status
            ELSE 'UNSEEN'::text
        END AS effective_status,
    l.avg_price_reported
   FROM latest l
     LEFT JOIN execs e USING (order_id)
     LEFT JOIN complete_capture c ON c.day = (l.last_seen_at AT TIME ZONE 'Asia/Kuwait'::text)::date;;

COMMENT ON VIEW public.awsat_order_list IS
  'CR-10/11 · the latest state of each order, derived from awsat_order_obs. '
  'executions_observed is derived from filled_quantity rises and is NULL where '
  'the order was already filled when first seen (045) — it is a MINIMUM even '
  'when present, because two executions between two captures look like one '
  'rise, and a per-execution fee computed from a minimum can only err downward. '
  'D5/058: avg_price is NULL because the broker''s figure equals the ORDER price '
  'on all 55 orders carrying it, including the GIH buy at 600 entered into an '
  'auction that printed 587; the raw value is avg_price_reported. The legacy '
  'awsat_order_obs.executions_observed accumulator — DEFAULT 1, written by '
  'nothing, reading 1 on 3,010 of 3,046 rows with 2,102 of them unfilled — is '
  'dropped, because "do not read this" in a comment did not stop anyone reading '
  'it.';

DO $$
DECLARE legacy int; av int;
BEGIN
  SELECT count(*) INTO legacy FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'awsat_order_obs'
     AND column_name = 'executions_observed';
  IF legacy > 0 THEN
    RAISE EXCEPTION '058 FAILED: the legacy accumulator is still on awsat_order_obs.';
  END IF;

  SELECT count(*) INTO av FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'awsat_order_list'
     AND column_name = 'avg_price_reported';
  IF av <> 1 THEN
    RAISE EXCEPTION '058 FAILED: avg_price_reported is not on the view, so the '
      'broker''s figure was discarded rather than renamed.';
  END IF;
END $$;

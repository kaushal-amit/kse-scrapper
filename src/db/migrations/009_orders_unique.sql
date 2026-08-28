-- ===========================================================================
--  009_orders_unique.sql — one row per order, not one row per sighting
--
--  awsat_order_list was keyed (order_id, created_at, ingest_source), which made
--  it a SNAPSHOT LOG: every minute the scraper saw an order, it stored another
--  row. Ten live orders over a session became ~2,400 rows, and "how many orders
--  do I have" needed a DISTINCT that nobody would remember to write.
--
--  The requirement is ten orders, ten rows. So the key becomes the order id
--  itself and each sighting UPDATES the row it already has.
--
--  WHAT IS GAINED AND WHAT IS LOST
--  Gained: the table answers the obvious question directly, and a re-run or a
--  double-posted client batch cannot inflate it.
--  Lost: the minute-by-minute history of an order's status. That is recoverable
--  where it matters — first_seen_at, last_seen_at and sighting_count keep the
--  span and frequency, and status transitions are visible through updated_at.
--  A full transition log would be a separate table, and nothing has asked for
--  one.
-- ===========================================================================

-- Collapse existing duplicates first: keep the LATEST sighting of each order,
-- since that carries the most advanced fill state.
DELETE FROM awsat_order_list a
 USING awsat_order_list b
 WHERE a.order_id = b.order_id
   AND (a.created_at < b.created_at
        OR (a.created_at = b.created_at AND a.id < b.id));

ALTER TABLE awsat_order_list ADD COLUMN IF NOT EXISTS first_seen_at timestamptz;
ALTER TABLE awsat_order_list ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
ALTER TABLE awsat_order_list ADD COLUMN IF NOT EXISTS sighting_count integer NOT NULL DEFAULT 1;
ALTER TABLE awsat_order_list ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

UPDATE awsat_order_list
   SET first_seen_at = COALESCE(first_seen_at, created_at),
       last_seen_at  = COALESCE(last_seen_at, created_at)
 WHERE first_seen_at IS NULL OR last_seen_at IS NULL;

-- The old key permitted the duplicates this migration just removed.
ALTER TABLE awsat_order_list DROP CONSTRAINT IF EXISTS awsat_orders_key;

-- ingest_source is deliberately NOT in the key. The same order seen by both
-- collectors is ONE order; keying on the collector would recreate the
-- duplication in a subtler form — two rows that look like two orders.
ALTER TABLE awsat_order_list
  ADD CONSTRAINT awsat_orders_order_id_key UNIQUE (order_id);

CREATE INDEX IF NOT EXISTS awsat_orders_seen_idx
  ON awsat_order_list (last_seen_at DESC);

COMMENT ON TABLE awsat_order_list IS
  'One row per order, updated in place. sighting_count records how many times '
  'the scraper saw it; first_seen_at/last_seen_at bound the span.';

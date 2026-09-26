-- ===========================================================================
--  046_order_id_required.sql — a row in awsat_order_obs must be identifiable.
--
--  ─── THE GUARD THAT WAS BELIEVED TO EXIST ────────────────────────────────
--  The rule "never store an order row without the broker's order number" was
--  being relied on as though the database enforced it. It did not: the only
--  CHECK constraints on this table were on executions_observed, the fill
--  sanity, the side and the ingest source. `order_id` was nullable and
--  unconstrained, so a client bug, a renamed grid column or a hand-written
--  INSERT could put a row here that reconciles against nothing.
--
--  An order row with no id cannot be matched to a fill, cannot be asked about
--  at the broker, and arrives as a NEW order on every capture — so it inflates
--  the order count while telling you nothing.
--
--  ─── WHAT THIS DOES NOT DO ───────────────────────────────────────────────
--  It does NOT refuse a SYNTHESISED id. When the Order List grid lost its
--  clOrdId column on 2 September the userscript kept a row only
--  `if (rec.orderId)` and orders went silent for SIX SESSIONS; the C1 fix and
--  test/suites/order-noid.test.js exist because of that. A synthesised id is
--  stable, reconciles across captures, and is marked `synthetic` on the way
--  in — it is a worse id, not an absent one, and refusing it here would
--  re-create the outage at the database instead of in the client.
--
--  So: present and non-blank. That is the whole rule.
--
--  NOT VALID, deliberately, and validated by 047 — the pattern this schema
--  already uses (042/043). A validating ALTER takes an ACCESS EXCLUSIVE lock
--  for the length of a full table scan, and this table is written every few
--  seconds during the session.
-- ===========================================================================

ALTER TABLE awsat_order_obs
  DROP CONSTRAINT IF EXISTS awsat_orders_order_id_present;

ALTER TABLE awsat_order_obs
  ADD CONSTRAINT awsat_orders_order_id_present
  CHECK (order_id IS NOT NULL AND btrim(order_id) <> '') NOT VALID;

COMMENT ON CONSTRAINT awsat_orders_order_id_present ON awsat_order_obs IS
  'An order row must carry an id: present and non-blank. A SYNTHESISED id is allowed — '
  'it is stable and reconciles across captures, and refusing it would repeat the 2 September '
  'outage where a renamed grid column silenced orders for six sessions. Absent is refused.';

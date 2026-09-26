-- ===========================================================================
--  047_order_id_required_validate.sql — validate 046's constraint.
--
--  Its own file because the migration runner wraps each file in one
--  transaction, and VALIDATE CONSTRAINT takes a SHARE UPDATE EXCLUSIVE lock
--  for a full scan — the same split 042/043 uses, for the same reason.
--
--  If this fails, a row in awsat_order_obs has no order id. That is a finding,
--  not a migration problem: the row cannot be reconciled against the broker
--  and should be looked at before it is deleted.
--
--      SELECT id, trading_date, symbol, side, order_status, created_at
--        FROM awsat_order_obs
--       WHERE order_id IS NULL OR btrim(order_id) = '';
-- ===========================================================================

ALTER TABLE awsat_order_obs VALIDATE CONSTRAINT awsat_orders_order_id_present;

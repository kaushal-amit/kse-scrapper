'use strict';
/**
 * S-06 · CR-10/11 — the order list is append-only, and its derived columns are
 * computed from the observations rather than accumulated in an UPDATE.
 *
 * WHY THIS SHAPE. executions_observed is the per-execution settlement fee
 * multiplier — it is money — and it used to be incremented inside a
 * twenty-column ON CONFLICT clause that had to be correct on every write path,
 * every time. It was not: the row-by-row fallback omitted it and net_value
 * entirely, so one bad row in a batch left the others with a stale P&L and an
 * under-counted fee, with nothing on the table left to recompute them from.
 *
 * Derived from observations, a wrong reading is a wrong ROW and the row beside
 * it still says what was true.
 *
 * The rule the view encodes is LATEST NON-NULL WINS, per column — deliberately
 * the same rule the old COALESCE encoded: a sighting that omits net_value means
 * "the grid did not show it this time", never "it is now nothing".
 */
const { requireTestDb } = require('../dbguard');
requireTestDb('orders-append');

const { query, close } = require('../../src/db/pool');
const repo = require('../../src/db/repositories');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };

const at = (hhmm) => new Date(`2026-09-10T${hhmm}:00+03:00`);
const sighting = (over = {}) => ({
  order_id: 'A1', symbol: 'CATTL', side: 'BUY', order_status: 'Queued',
  price: 176, quantity: 4000, filled_quantity: 0, remaining_qty: 4000,
  trading_date: '2026-09-10', ingest_source: 'awsat_client',
  last_seen_at: at('09:00'),
  ...over,
});

(async () => {
  try {
    await query('DELETE FROM awsat_order_obs');

    // ── the table is the observations; the list is a view ───────────────────
    {
      const { rows } = await query(
        "SELECT table_type FROM information_schema.tables WHERE table_name = 'awsat_order_list'");
      ck('awsat_order_list is a VIEW', rows[0] && rows[0].table_type === 'VIEW', rows[0]);
      const { rows: obs } = await query(
        "SELECT table_type FROM information_schema.tables WHERE table_name = 'awsat_order_obs'");
      ck('awsat_order_obs is a table', obs[0] && obs[0].table_type === 'BASE TABLE', obs[0]);
    }

    // ── every sighting is kept ──────────────────────────────────────────────
    {
      await repo.insertOrders([sighting({ last_seen_at: at('09:00') })]);
      await repo.insertOrders([sighting({ last_seen_at: at('09:05'), order_status: 'Partially Filled', filled_quantity: 1500, remaining_qty: 2500 })]);
      await repo.insertOrders([sighting({ last_seen_at: at('09:10'), order_status: 'Filled', filled_quantity: 4000, remaining_qty: 0, net_value: -94.738 })]);

      const { rows: obs } = await query("SELECT count(*)::int c FROM awsat_order_obs WHERE order_id = 'A1'");
      ck('three sightings are three rows — the history survives', obs[0].c === 3, obs[0]);

      const { rows } = await query("SELECT * FROM awsat_order_list WHERE order_id = 'A1'");
      ck('and the view shows exactly one row per order', rows.length === 1, rows.length);
      ck('with the LATEST status', rows[0].order_status === 'Filled', rows[0].order_status);
      ck('and the latest fill', Number(rows[0].filled_quantity) === 4000, rows[0].filled_quantity);
      ck('sighting_count is derived', Number(rows[0].sighting_count) === 3, rows[0].sighting_count);
      ck('first_seen_at is the FIRST observation', new Date(rows[0].first_seen_at).getTime() === at('09:00').getTime(), rows[0].first_seen_at);
      ck('last_seen_at is the LAST', new Date(rows[0].last_seen_at).getTime() === at('09:10').getTime(), rows[0].last_seen_at);
    }

    // ── executions_observed is derived from filled_quantity rises ───────────
    {
      const { rows } = await query("SELECT executions_observed FROM awsat_order_list WHERE order_id = 'A1'");
      // 0 -> 1500 -> 4000 is two rises, and the order was seen UNFILLED first,
      // so two rises is the whole story. H-A removed the unconditional `1 +`
      // that used to make this three — a phantom execution, and the settlement
      // fee is charged per execution.
      ck('two fill rises count as two executions', Number(rows[0].executions_observed) === 2, rows[0]);

      // The number is money: at 0.5 KD per execution this is the difference
      // between 1.680 and 2.285 on a sell that filled in two parts.
      await query("DELETE FROM awsat_order_obs WHERE order_id = 'ONESHOT'");
      await repo.insertOrders([sighting({ order_id: 'ONESHOT', last_seen_at: at('10:00'), filled_quantity: 4000, remaining_qty: 0, order_status: 'Filled' })]);
      const { rows: one } = await query("SELECT executions_observed FROM awsat_order_list WHERE order_id = 'ONESHOT'");
      // H-A · this order was ALREADY FILLED the only time we looked at it. One
      // execution, or four? The capture cannot say, and a floor of 1 was a
      // plausible-but-wrong number in the one column denominated in money.
      ck('an order first seen already filled is UNMEASURED, not floored at one',
        one[0].executions_observed === null, one[0]);
    }

    // ── latest NON-NULL wins — a later sighting cannot erase the P&L ────────
    {
      // The grid stops showing net_value on a later cycle. The old COALESCE
      // protected this; the view must too.
      await repo.insertOrders([sighting({ last_seen_at: at('09:15'), order_status: 'Filled', filled_quantity: 4000, remaining_qty: 0, net_value: null, symbol: null })]);
      const { rows } = await query("SELECT net_value, symbol, sighting_count FROM awsat_order_list WHERE order_id = 'A1'");
      ck('a later sighting that OMITS net_value does not erase it',
        Number(rows[0].net_value) === -94.738, rows[0]);
      ck('and does not erase the symbol either', rows[0].symbol === 'CATTL', rows[0]);
      ck('but it is still counted as a sighting', Number(rows[0].sighting_count) === 4, rows[0]);
    }

    // ── a replayed batch is a no-op ─────────────────────────────────────────
    {
      const before = await query("SELECT count(*)::int c FROM awsat_order_obs WHERE order_id = 'A1'");
      const res = await repo.insertOrders([sighting({ last_seen_at: at('09:15'), order_status: 'Filled', filled_quantity: 4000, remaining_qty: 0 })]);
      const after = await query("SELECT count(*)::int c FROM awsat_order_obs WHERE order_id = 'A1'");
      ck('the same order at the same instant from the same collector is ONE observation',
        after.rows[0].c === before.rows[0].c, [before.rows[0].c, after.rows[0].c]);
      ck('and the write reports nothing inserted', res.inserted === 0, res);
    }

    // ── two collectors at the same instant are two observations ────────────
    {
      await repo.insertOrders([sighting({ order_id: 'A1', last_seen_at: at('09:15'), ingest_source: 'awsat_server' })]);
      const { rows } = await query(
        "SELECT count(*)::int c FROM awsat_order_obs WHERE order_id = 'A1' AND observed_at = $1", [at('09:15')]);
      ck('ingest_source is part of the observation identity', rows[0].c === 2, rows[0]);
    }

    // ── the writer appends; it does not upsert ──────────────────────────────
    {
      const src = require('fs').readFileSync(require('path').join(__dirname, '../../src/db/repositories.js'), 'utf8');
      const body = src.slice(src.indexOf('async function insertOrders'), src.indexOf('// ─── daily history'));
      ck('insertOrders writes awsat_order_obs', /INSERT INTO awsat_order_obs/.test(body));
      ck('and never writes the view', !/INSERT INTO awsat_order_list/.test(body));
      ck('and carries no DO UPDATE clause at all', !/DO UPDATE/.test(body), body.match(/DO UPDATE/g));
    }

    await query('DELETE FROM awsat_order_obs');
  } catch (e) {
    ck('the suite ran without throwing', false, e.message);
  }

  await close();
  console.log(`\norders append-only: ${p}/${n}`);
  process.exit(p === n ? 0 : 1);
})();

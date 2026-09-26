'use strict';
/**
 * S-04 · insertOrders chunks, and its two write paths cannot drift apart.
 *
 * Two defects, both from the 14 Sep review (F-18):
 *
 *   · insertOrders built ONE statement for the whole batch while every other
 *     insert path in repositories.js chunks. Postgres allows 65535 bind
 *     parameters; at 23 columns that is 2849 orders, and /orders had no batch
 *     cap of its own. Past it the statement fails at BIND with a message that
 *     does not name the limit, and the catch retried the whole batch one row at
 *     a time — thousands of sequential round trips holding a pool connection
 *     while the 15 s cycles queued behind it.
 *
 *   · The row-by-row fallback updated six columns and silently omitted
 *     net_value — migration 014 calls it THE P&L NUMBER — along with
 *     executions_observed, avg_price, order_value, price, quantity and
 *     order_time. One bad row in a batch of ten left the other nine with a
 *     refreshed status and a stale P&L, reported as `rejected: 1`.
 *
 * These are exercised against the real database, because the property under
 * test is what Postgres ends up holding, not what the JS intended.
 */
const { requireTestDb } = require('../dbguard');
requireTestDb('orders-chunking');

const { query, close } = require('../../src/db/pool');
const repo = require('../../src/db/repositories');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };

const order = (over = {}) => ({
  order_id: 'X1', symbol: 'CATTL', side: 'BUY', order_status: 'Queued',
  price: 176, quantity: 4000, filled_quantity: 0, remaining_qty: 4000,
  ingest_source: 'awsat_client', last_seen_at: new Date(), trading_date: '2026-09-10',
  ...over,
});

(async () => {
  try {
    await query('DELETE FROM awsat_order_obs');

    // ── chunking: past the bind-parameter ceiling in ONE call ───────────────
    {
      // 3000 orders × 23 columns = 69,000 binds — past 65535. Before chunking
      // this failed at BIND and fell into 3000 single-row round trips.
      const many = Array.from({ length: 3000 }, (_, i) => order({ order_id: `B${i}`, symbol: 'MANY' }));
      const started = Date.now();
      const res = await repo.insertOrders(many);
      const ms = Date.now() - started;

      ck('a batch past the bind ceiling stores every row', res.inserted === 3000, res);
      ck('and rejects none', res.rejected === 0, res);
      const { rows } = await query("SELECT count(*)::int c FROM awsat_order_list WHERE symbol = 'MANY'");
      ck('and the database agrees', rows[0].c === 3000, rows[0]);
      // Not a benchmark — a shape check. The row-by-row path would be 3000
      // sequential round trips; chunked it is three statements.
      ck('and it did not degrade into row-by-row', ms < 20_000, ms);
      await query("DELETE FROM awsat_order_obs WHERE symbol = 'MANY'");
    }

    // ── the fallback writes the SAME columns as the batch ───────────────────
    {
      // First sighting: a complete order with a P&L.
      await repo.insertOrders([order({
        order_id: 'P1', filled_quantity: 4000, remaining_qty: 0,
        order_status: 'Filled', net_value: -94.738, avg_price: 176, order_value: 704,
      })]);
      const before = await query("SELECT net_value, avg_price, avg_price_reported, order_value FROM awsat_order_list WHERE order_id = 'P1'");
      ck('the P&L was captured', Number(before.rows[0].net_value) === -94.738, before.rows[0]);

      /*
       * Now a batch where ONE row trips a constraint (filled > quantity trips
       * awsat_orders_fill_sane) alongside a good row carrying an UPDATED P&L.
       * The batch fails; the fallback runs; the good row must still get its new
       * net_value. Before the shared clause it kept the old one.
       */
      const res = await repo.insertOrders([
        order({ order_id: 'P1', filled_quantity: 4000, remaining_qty: 0, order_status: 'Filled', net_value: -95.5, avg_price: 177, order_value: 708 }),
        order({ order_id: 'BAD', quantity: 10, filled_quantity: 9999 }),
      ]);
      ck('the bad row is rejected', res.rejected === 1, res);
      ck('and the good row still lands', res.inserted === 1, res);

      const after = await query("SELECT net_value, avg_price, avg_price_reported, order_value, sighting_count FROM awsat_order_list WHERE order_id = 'P1'");
      ck('THE FALLBACK UPDATED net_value — the P&L is not left stale',
        Number(after.rows[0].net_value) === -95.5, after.rows[0]);
      // D5 · avg_price is NULL on the view now; the broker's figure moved to
      // avg_price_reported because it is a copy of the ORDER price, not a
      // fill price. The round-trip being tested here is still the round-trip.
      ck('and avg_price_reported', Number(after.rows[0].avg_price_reported) === 177, after.rows[0]);
      ck('  while avg_price itself stays NOT COMPUTED',
        after.rows[0].avg_price === null, after.rows[0]);
      ck('and order_value', Number(after.rows[0].order_value) === 708, after.rows[0]);
      ck('and the sighting was counted', Number(after.rows[0].sighting_count) >= 2, after.rows[0]);
    }

    // ── executions_observed still increments on the fallback path ───────────
    {
      await query('DELETE FROM awsat_order_obs');
      // The first sighting must be UNFILLED for the count to be measurable at
      // all (H-A): an order already filled when first seen has no rise to count
      // and reports NULL. What is under test here is that the FALLBACK path
      // records the rise, so the fixture starts where the order did — at zero.
      // Explicit, distinct timestamps: sightings are identified by
      // (order_id, observed_at, ingest_source), so two seeded a millisecond
      // apart can collide and silently become one — which would make this
      // suite measure deduplication rather than the fallback path.
      const seen = (hhmm) => new Date(`2026-09-10T${hhmm}:00+03:00`);
      await repo.insertOrders([order({ order_id: 'E1', filled_quantity: 0, remaining_qty: 4000, last_seen_at: seen('09:00') })]);
      await repo.insertOrders([order({ order_id: 'E1', filled_quantity: 1000, remaining_qty: 3000, last_seen_at: seen('09:05') })]);
      const res = await repo.insertOrders([
        order({ order_id: 'E1', filled_quantity: 2500, remaining_qty: 1500, last_seen_at: seen('09:10') }),
        order({ order_id: 'BAD2', quantity: 10, filled_quantity: 9999 }),
      ]);
      ck('the bad row forced the fallback', res.rejected === 1, res);
      const { rows } = await query("SELECT executions_observed FROM awsat_order_list WHERE order_id = 'E1'");
      ck('executions_observed rose on the fallback path too — it is the fee multiplier',
        Number(rows[0].executions_observed) === 2, rows[0]);
    }

    // ── the two SQL paths are literally the same clause ─────────────────────
    {
      const src = require('fs').readFileSync(require('path').join(__dirname, '../../src/db/repositories.js'), 'utf8');
      const body = src.slice(src.indexOf('async function insertOrders'), src.indexOf('// ─── daily history'));
      /*
       * Since 039 (append-only) there is no UPDATE clause left to drift: the
       * batch and the fallback both append with the SAME conflict target, and
       * the columns the fallback used to omit — net_value, executions_observed —
       * are derived by the view from the observations. The invariant worth
       * asserting is therefore that neither statement can update anything.
       */
      const doNothing = (body.match(/ON CONFLICT \(order_id, observed_at, ingest_source\) DO NOTHING/g) || []).length;
      ck('both statements share the same append conflict target', doNothing === 2, doNothing);
      ck('and NEITHER carries a DO UPDATE clause to get wrong', !/DO UPDATE/.test(body),
        (body.match(/DO UPDATE/g) || []).length);
      ck('and the batch is chunked', /chunkSize\(ORDER_COLUMNS\.length\)/.test(body));
    }

    await query('DELETE FROM awsat_order_obs');
  } catch (e) {
    ck('the suite ran without throwing', false, e.message);
  }

  await close();
  console.log(`\norders chunking: ${p}/${n}`);
  process.exit(p === n ? 0 : 1);
})();

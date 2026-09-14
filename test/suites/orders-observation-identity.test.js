'use strict';
/**
 * S-07 · orders userscript 2.7.0 — the OBSERVATION's instant is the client's
 * capturedAt, and a retry is not a second sighting.
 *
 * Since CR-10/11 (039) orders are stored append-only and an observation's
 * identity is (order_id, observed_at, ingest_source). observed_at must
 * therefore be when the GRID WAS READ, not when the request happened to arrive:
 *
 *   · A retry stamped with a fresh clock would be a second, fictitious sighting
 *     of the same screen. It would inflate sighting_count, and because
 *     executions_observed counts filled_quantity rises BETWEEN consecutive
 *     sightings, a duplicated screen is harmless but a REORDERED one is not —
 *     so the instant has to come from the capture, once.
 *   · The settlement fee is charged per execution, so executions_observed is
 *     money. Anything that can manufacture one is a money bug.
 *
 * The client side of that contract is the userscript creating capturedAt once
 * per batch and keeping it across retries; the server side is the ingest path
 * mapping it to observed_at rather than reaching for its own clock.
 */
const fs = require('fs');
const path = require('path');
const { requireTestDb } = require('../dbguard');
requireTestDb('orders-observation-identity');

const { query, close } = require('../../src/db/pool');
const repo = require('../../src/db/repositories');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };

const SCRIPT = fs.readFileSync(path.join(__dirname, '../../userscript/awsat-orders.user.js'), 'utf8');
const INGEST = fs.readFileSync(path.join(__dirname, '../../src/api/ingest.js'), 'utf8');

(async () => {
  try {
    /*
     * The version is checked as "at least 2.7.0" rather than pinned: this
     * suite's subject is the capturedAt contract, which 2.7.0 introduced and
     * every later version keeps. Pinning it here made a version bump look like
     * a broken contract. userscript-version.test.js is where the exact version
     * lives.
     */
    {
      const header = (SCRIPT.match(/@version\s+([\d.]+)/) || [])[1];
      const constant = (SCRIPT.match(/var VERSION = '([\d.]+)'/) || [])[1];
      const atLeast = (v) => {
        const [a, b] = [String(v).split('.').map(Number), [2, 7, 0]];
        for (let i = 0; i < 3; i += 1) { if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i]; }
        return true;
      };
      ck('@version is at least 2.7.0 — where the capturedAt contract starts', atLeast(header), header);
      ck('and the panel constant agrees with the header', header === constant, [header, constant]);
    }

    // ── capturedAt is built ONCE, with the batch ───────────────────────────
    {
      // It must be inside the batch literal — i.e. created with batchId — and
      // must not be recomputed anywhere a retry could reach.
      const batchLiteral = SCRIPT.slice(SCRIPT.indexOf('var batch = {'), SCRIPT.indexOf('heartbeat(rows.length, null)'));
      ck('capturedAt is created with the batch', /capturedAt: new Date\(\)\.toISOString\(\)/.test(batchLiteral), batchLiteral.slice(0, 200));

      const stamps = (SCRIPT.match(/capturedAt:\s*new Date\(\)\.toISOString\(\)/g) || []).length;
      ck('and it is stamped in exactly ONE place — a retry cannot restamp it',
        stamps === 1, stamps);

      // The retry path must push the SAME object, not rebuild one.
      ck('the retry queue holds the original batch object',
        /retryQueue\.push\(batch\)/.test(SCRIPT));
    }

    // ── the server takes the observation's instant from the client ─────────
    {
      ck('the ingest path maps capturedAt to observed_at',
        /observed_at: when\.capturedAt/.test(INGEST));
      ck('and does not reach for its own clock for it',
        !/observed_at:\s*new Date\(\)/.test(INGEST));
    }

    // ── and it behaves: a replay is not a second sighting ──────────────────
    {
      await query("DELETE FROM awsat_order_obs WHERE order_id = 'OBS1'");
      const read = new Date('2026-09-10T09:20:00+03:00');
      const row = {
        order_id: 'OBS1', symbol: 'CATTL', side: 'BUY', order_status: 'Queued',
        price: 176, quantity: 4000, filled_quantity: 0, remaining_qty: 4000,
        trading_date: '2026-09-10', ingest_source: 'awsat_client',
        observed_at: read, last_seen_at: read, created_at: read,
      };

      await repo.insertOrders([row]);
      const first = await query("SELECT count(*)::int c FROM awsat_order_obs WHERE order_id = 'OBS1'");
      ck('the first post is one observation', first.rows[0].c === 1, first.rows[0]);

      // The retry: same capture, sent later. The SERVER's clock has moved on.
      await repo.insertOrders([row]);
      const second = await query("SELECT count(*)::int c FROM awsat_order_obs WHERE order_id = 'OBS1'");
      ck('a retry of the same capture is NOT a second sighting', second.rows[0].c === 1, second.rows[0]);

      const { rows: view } = await query("SELECT sighting_count, executions_observed FROM awsat_order_list WHERE order_id = 'OBS1'");
      ck('so sighting_count is not inflated', Number(view[0].sighting_count) === 1, view[0]);
      // H-A · seen once, unfilled. No rise, no execution. This read 1 before,
      // from an unconditional base that existed to cover a case this is not.
      ck('and no execution is manufactured', Number(view[0].executions_observed) === 0, view[0]);

      // A genuinely later read IS a second sighting.
      await repo.insertOrders([{ ...row, observed_at: new Date('2026-09-10T09:21:00+03:00'), last_seen_at: new Date('2026-09-10T09:21:00+03:00'), filled_quantity: 1000, remaining_qty: 3000 }]);
      const third = await query("SELECT count(*)::int c FROM awsat_order_obs WHERE order_id = 'OBS1'");
      ck('a later read IS a second sighting', third.rows[0].c === 2, third.rows[0]);
      const { rows: v2 } = await query("SELECT sighting_count, executions_observed FROM awsat_order_list WHERE order_id = 'OBS1'");
      ck('and the fill rise counts as THE execution', Number(v2[0].executions_observed) === 1, v2[0]);

      await query("DELETE FROM awsat_order_obs WHERE order_id = 'OBS1'");
    }
  } catch (e) {
    ck('the suite ran without throwing', false, e.message);
  }

  await close();
  console.log(`\norders observation identity: ${p}/${n}`);
  process.exit(p === n ? 0 : 1);
})();

'use strict';
/**
 * S-14 · a live order absent from the latest COMPLETE capture reads UNSEEN
 * (round 3, item S6; migration 041 + orders userscript 2.8.0).
 *
 * THE PROBLEM. The order grid is scrolled, and a short scan reads fewer rows
 * than are really there. Under the old upsert that was invisible: an order the
 * scan missed simply kept its last known status, so a CANCELLED order that had
 * already left the grid went on reading `Queued` for the rest of the session —
 * and the slot guard went on refusing to displace the symbol it named, so the
 * trader could not reassign a depth slot that was holding nothing.
 *
 * Append-only (039) keeps the evidence; this makes something read it.
 *
 * THE THREE PARTS THAT HAVE TO AGREE:
 *
 *   · `partial` — only the CLIENT knows whether it read the whole grid. The
 *     server sees fewer rows and cannot tell "the grid is shorter" from "I did
 *     not reach the bottom".
 *   · absence is judged against the latest COMPLETE capture only. Judged
 *     against a partial one, every order below the scroll fold would read
 *     UNSEEN — turning a client-side scroll problem into a wrong status on live
 *     orders.
 *   · an EMPTY grid is posted (2.8.0). It is a complete capture of nothing, and
 *     it is the only way "everything is gone" is expressible. Silence is not a
 *     capture.
 */
const fs = require('fs');
const path = require('path');
const { requireTestDb } = require('../dbguard');
requireTestDb('orders-unseen');

const { query, close } = require('../../src/db/pool');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };

const SCRIPT = fs.readFileSync(path.join(__dirname, '../../userscript/awsat-orders.user.js'), 'utf8');

const obs = (id, at, status = 'Queued') => query(
  `INSERT INTO awsat_order_obs (order_id, symbol, side, order_status, trading_date,
                                ingest_source, created_at, observed_at)
   VALUES ($1, 'CATTL', 'BUY', $3, '2026-09-10', 'awsat_client', now(), $2)`, [id, at, status]);

const capture = (batch, at, partial) => query(
  `INSERT INTO client_submissions (batch_id, ingest_source, kind, captured_at, partial)
   VALUES ($1, 'awsat_client', 'orders', $2, $3)`, [batch, at, partial]);

const at = (hhmm) => `2026-09-10T${hhmm}:00+03:00`;
const statusOf = async (id) => (await query(
  'SELECT order_status, effective_status, seen_in_latest FROM awsat_order_list WHERE order_id = $1', [id])).rows[0];

(async () => {
  try {
    await query('DELETE FROM awsat_order_obs');
    await query('DELETE FROM client_submissions');

    // ── with no complete capture, nothing is judged ────────────────────────
    {
      await obs('A', at('09:00'));
      const a = await statusOf('A');
      ck('with no complete capture, seen_in_latest is NULL — not false',
        a.seen_in_latest === null, a);
      ck('and effective_status is the stored status, not UNSEEN',
        a.effective_status === 'Queued', a);
    }

    // ── a complete capture makes absence mean something ────────────────────
    {
      await obs('B', at('09:10'));
      await capture('c1', at('09:10'), false);

      const a = await statusOf('A');   // last seen 09:00, before the capture
      const b = await statusOf('B');   // last seen 09:10, in it

      ck('an order absent from the latest COMPLETE capture reads UNSEEN',
        a.effective_status === 'UNSEEN', a);
      ck('and seen_in_latest is false', a.seen_in_latest === false, a);
      ck('its STORED status is untouched — the observation is still what it was',
        a.order_status === 'Queued', a);
      ck('an order present in it keeps its status', b.effective_status === 'Queued', b);
      ck('and seen_in_latest is true', b.seen_in_latest === true, b);
    }

    // ── a PARTIAL capture is not evidence of absence ───────────────────────
    {
      // A later scan that admits it was short must not promote A to UNSEEN on
      // its own, nor demote B.
      await capture('c2', at('09:20'), true);
      const a = await statusOf('A');
      const b = await statusOf('B');
      ck('a partial capture does not change the verdict for an absent order',
        a.effective_status === 'UNSEEN', a);
      ck('and does NOT mark a previously-seen order UNSEEN — that is the whole point',
        b.effective_status === 'Queued', b);
    }

    // ── an EMPTY complete capture retires everything ───────────────────────
    {
      await capture('c3', at('09:30'), false);   // complete, and posted no orders
      const b = await statusOf('B');
      ck('after a complete capture of NOTHING, a live order reads UNSEEN',
        b.effective_status === 'UNSEEN', b);
      ck('which is how "the grid is empty now" becomes expressible at all',
        b.seen_in_latest === false, b);
    }

    // ── yesterday's capture says nothing about today ───────────────────────
    {
      await query('DELETE FROM awsat_order_obs');
      await query('DELETE FROM client_submissions');
      await capture('y1', '2026-09-09T09:30:00+03:00', false);
      await obs('TODAY', at('09:00'));
      const t = await statusOf('TODAY');
      ck("a PRIOR day's complete capture does not retire today's order",
        t.effective_status === 'Queued', t);
      ck('and leaves it unjudged rather than absent', t.seen_in_latest === null, t);
    }

    // ── the client half ────────────────────────────────────────────────────
    {
      // AT LEAST, not exactly: this suite owns the behaviour, not the version
      // number, and pinning the string made every later fix to the script fail
      // an unrelated suite. What must hold is that the build is not older than
      // the one that introduced these behaviours, and that the header and the
      // panel constant AGREE — the failure that actually cost a session.
      const hdr = (SCRIPT.match(/@version\s+(\d+\.\d+\.\d+)/) || [])[1];
      const panel = (SCRIPT.match(/var VERSION = '(\d+\.\d+\.\d+)'/) || [])[1];
      const atLeast = (v, min) => {
        const a = String(v).split('.').map(Number);
        const b = min.split('.').map(Number);
        for (let i = 0; i < 3; i += 1) {
          if (a[i] > b[i]) return true;
          if (a[i] < b[i]) return false;
        }
        return true;
      };
      ck('the userscript is at least 2.8.0', hdr && atLeast(hdr, '2.8.0'), hdr);
      ck('and the panel constant agrees with the header', panel === hdr, [hdr, panel]);
      ck('it sends `partial` on the batch', /partial: stats\.shortBy > 0/.test(SCRIPT));
      ck('it POSTS an empty grid rather than only checking in',
        /AN EMPTY GRID IS POSTED/.test(SCRIPT));
      // The id shape: symbol, side, stamp. Price and quantity are what an amend
      // changes, so they cannot be in the identity.
      ck('the synthetic id is symbol · side · stamp',
        /var parts = \[sym, rec\.side \|\| '', rec\.stamp\];/.test(SCRIPT));
      ck('same-second twins take stable ordinals', /applySyntheticIds/.test(SCRIPT));

      // The server stores what the client says.
      const ing = fs.readFileSync(path.join(__dirname, '../../src/api/ingest.js'), 'utf8');
      ck('the ingest path stores the partial flag', /body\.partial === true/.test(ing));
    }

    await query('DELETE FROM awsat_order_obs');
    await query('DELETE FROM client_submissions');
  } catch (e) {
    ck('the suite ran without throwing', false, e.message);
  }

  await close();
  console.log(`\norders unseen: ${p}/${n}`);
  process.exit(p === n ? 0 : 1);
})();

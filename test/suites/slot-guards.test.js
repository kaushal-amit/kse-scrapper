'use strict';
/**
 * S-05 · the bulk slot endpoint enforces the guards the narrow one does.
 *
 * The defect (14 Sep review, F-18): POST /depth-symbols writes depth_watchlist
 * to the same effect as POST /slots/:n and enforced none of its three guards.
 * It validated the slot number, a non-empty symbol and in-batch duplicates,
 * then released the WHOLE day and reinserted. So one bulk call could release
 * the slot the trader had an open position in — the exact outcome the 409 on
 * the narrow endpoint exists to prevent — and seat a symbol that is in no
 * instruments row, which the sweep would then dutifully request.
 *
 * The guards now live in src/api/slotGuards.js and both endpoints call them.
 *
 * The third block is the one that keeps the fix usable: re-posting a list that
 * KEEPS a protected symbol must still succeed. A guard that refuses the
 * refresh whenever the trader is in a position would be refused exactly when
 * the list is refreshed most.
 */
const { requireTestDb } = require('../dbguard');
requireTestDb('slot-guards');

const { query, close } = require('../../src/db/pool');
const guards = require('../../src/api/slotGuards');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };

const DAY = '2026-09-10';

(async () => {
  try {
    await query('DELETE FROM depth_watchlist WHERE trading_date = $1', [DAY]);
    await query("DELETE FROM awsat_order_obs WHERE symbol IN ('HELDSYM','FREESYM','DEADSYM')");
    await query("DELETE FROM instruments WHERE symbol IN ('HELDSYM','FREESYM','DEADSYM')");
    await query(`INSERT INTO instruments (symbol, market, is_tradeable) VALUES
      ('HELDSYM','Main Market', true), ('FREESYM','Main Market', true), ('DEADSYM','Main Market', false)`);

    // ── symbolIsAssignable ──────────────────────────────────────────────────
    {
      ck('a listed tradeable symbol is assignable', (await guards.symbolIsAssignable('FREESYM')).ok === true);

      const unknown = await guards.symbolIsAssignable('ZZZZ');
      ck('an UNLISTED symbol is refused (SPR-03)', unknown.ok === false && unknown.status === 400, unknown);
      ck('and the refusal names it', /ZZZZ is not a listed symbol/.test(unknown.error), unknown.error);

      const dead = await guards.symbolIsAssignable('DEADSYM');
      ck('a non-tradeable symbol is refused', dead.ok === false, dead);
      ck('and says why a slot on it is wasted', /nobody can act on/.test(dead.detail), dead.detail);
    }

    // ── slotIsDisplaceable ──────────────────────────────────────────────────
    {
      ck('an EMPTY slot is always displaceable', (await guards.slotIsDisplaceable(null, DAY)).ok === true);
      ck('a symbol with nothing live is displaceable',
        (await guards.slotIsDisplaceable('FREESYM', DAY)).ok === true);

      await query(`INSERT INTO awsat_order_obs
        (order_id, symbol, side, order_status, trading_date, ingest_source, last_seen_at, created_at, first_seen_at, observed_at)
        VALUES ('Q1','HELDSYM','BUY','Queued',$1,'awsat_client', now(), now(), now(), now())`, [DAY]);

      const held = await guards.slotIsDisplaceable('HELDSYM', DAY);
      ck('a symbol with a QUEUED order is NOT displaceable', held.ok === false && held.status === 409, held);
      ck('and the refusal names the count', /queued order/.test(held.detail), held.detail);
    }

    // ── checkBulkAssignment — the endpoint's whole check ─────────────────────
    {
      await query(`INSERT INTO depth_watchlist (trading_date, slot_no, symbol, slot_type, assigned_by)
        VALUES ($1, 1, 'HELDSYM', 'PRE_DAY', 'TEST'), ($1, 2, 'FREESYM', 'PRE_DAY', 'TEST')`, [DAY]);

      // The exact scenario from the review: a bulk list that drops the held
      // symbol. Before the guards this returned 200 and the trader went blind.
      const drops = await guards.checkBulkAssignment(
        [{ slot: 1, symbol: 'FREESYM' }, { slot: 2, symbol: 'ZZZZ' }], DAY);
      ck('a bulk list is refused for the UNLISTED symbol first', drops.ok === false, drops);
      ck('and names it', /ZZZZ/.test(drops.error), drops.error);

      const displaces = await guards.checkBulkAssignment([{ slot: 1, symbol: 'FREESYM' }], DAY);
      ck('a bulk list that DROPS the held symbol is refused', displaces.ok === false && displaces.status === 409, displaces);
      ck('and names the slot and the symbol it holds',
        /slot 1 holds HELDSYM/.test(displaces.error), displaces.error);

      // A slot the list does not mention is displaced just as surely, because
      // the bulk write releases the whole day.
      const omits = await guards.checkBulkAssignment([{ slot: 3, symbol: 'FREESYM' }], DAY);
      ck('a slot the list OMITS is still protected — the write releases the whole day',
        omits.ok === false && /HELDSYM/.test(omits.error), omits);
    }

    // ── and the list stays refreshable ──────────────────────────────────────
    {
      const keeps = await guards.checkBulkAssignment(
        [{ slot: 1, symbol: 'HELDSYM' }, { slot: 2, symbol: 'FREESYM' }], DAY);
      ck('re-posting a list that KEEPS the protected symbol is allowed', keeps.ok === true, keeps);

      const moves = await guards.checkBulkAssignment(
        [{ slot: 4, symbol: 'HELDSYM' }, { slot: 1, symbol: 'FREESYM' }], DAY);
      ck('MOVING the protected symbol to another slot is allowed — it is still swept',
        moves.ok === true, moves);
    }

    // ── both endpoints go through the same helpers ──────────────────────────
    {
      const src = require('fs').readFileSync(require('path').join(__dirname, '../../src/api/ingest.js'), 'utf8');
      ck('POST /slots/:n calls the shared symbol guard', /slotGuards\.symbolIsAssignable\(/.test(src));
      ck('POST /slots/:n calls the shared displacement guard', /slotGuards\.slotIsDisplaceable\(/.test(src));
      ck('POST /depth-symbols calls the bulk guard', /slotGuards\.checkBulkAssignment\(/.test(src));
      ck('and no handler re-implements the position query inline',
        !/SELECT count\(\*\)::int FROM position/.test(src));
    }

    await query('DELETE FROM depth_watchlist WHERE trading_date = $1', [DAY]);
    await query("DELETE FROM awsat_order_obs WHERE symbol IN ('HELDSYM','FREESYM','DEADSYM')");
    await query("DELETE FROM instruments WHERE symbol IN ('HELDSYM','FREESYM','DEADSYM')");
  } catch (e) {
    ck('the suite ran without throwing', false, e.message);
  }

  await close();
  console.log(`\nslot guards: ${p}/${n}`);
  process.exit(p === n ? 0 : 1);
})();

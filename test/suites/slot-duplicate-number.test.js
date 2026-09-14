'use strict';
/**
 * H-F · a bulk assignment that names one slot twice can vacate a protected one.
 *
 * THE EXEMPTION IS SOUND. checkBulkAssignment examines every slot the day
 * currently holds, because the bulk write releases the WHOLE day — and it
 * exempts a held symbol that appears anywhere in the incoming list, because a
 * symbol that merely MOVES slot is still swept, so displacing it from the old
 * one costs nothing:
 *
 *   if (wanted.has(holding)) continue;      // moved, still swept
 *
 * IT IS ONLY SOUND IF EVERY SYMBOL IN `wanted` ACTUALLY LANDS. With a repeated
 * slot number it does not. `[{slot: 1, HELDSYM}, {slot: 1, FREESYM}]` puts
 * HELDSYM in `wanted`, which exempts HELDSYM's current slot from
 * slotIsDisplaceable — the guard that refuses to displace a slot holding a live
 * order or an open position. Then the write seats only one symbol in slot 1.
 * The protected slot is released and the symbol that was supposed to carry it
 * forward was never written: the trader goes blind on a position because two
 * rows of one request disagreed.
 *
 * Refused, not resolved. Last-wins and first-wins are both defensible and
 * neither is what the caller meant; a list naming the same slot twice is a
 * malformed list, and the loud answer is a 400 that says so.
 */
const { requireTestDb } = require('../dbguard');
requireTestDb('slot-duplicate-number');

const { query, close } = require('../../src/db/pool');
const guards = require('../../src/api/slotGuards');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };

const DAY = '2026-09-11';
const SYMS = ['DUPHELD', 'DUPFREE', 'DUPOTHER'];

(async () => {
  try {
    await query('DELETE FROM depth_watchlist WHERE trading_date = $1', [DAY]);
    await query('DELETE FROM awsat_order_obs WHERE symbol = ANY($1)', [SYMS]);
    await query('DELETE FROM instruments WHERE symbol = ANY($1)', [SYMS]);
    await query(`INSERT INTO instruments (symbol, market, is_tradeable) VALUES
      ('DUPHELD','Main Market', true), ('DUPFREE','Main Market', true),
      ('DUPOTHER','Main Market', true)`);

    // DUPHELD sits in slot 1 and has a LIVE QUEUED ORDER — the case the
    // displacement guard exists for.
    await query(
      `INSERT INTO depth_watchlist (slot_no, symbol, trading_date, slot_type)
       VALUES (1, 'DUPHELD', $1, 'PRE_DAY'), (2, 'DUPOTHER', $1, 'PRE_DAY')`,
      [DAY]);
    await query(`INSERT INTO awsat_order_obs
      (order_id, symbol, side, order_status, trading_date, ingest_source, last_seen_at, created_at, first_seen_at, observed_at)
      VALUES ('DUP-Q1','DUPHELD','BUY','Queued',$1,'awsat_client', now(), now(), now(), now())`, [DAY]);

    // ── the guard it depends on is actually armed ─────────────────────────
    {
      const d = await guards.slotIsDisplaceable('DUPHELD', DAY);
      ck('DUPHELD cannot be displaced — it has a live order', d.ok === false, d);
    }

    // ── THE HOLE · one slot named twice ───────────────────────────────────
    {
      const verdict = await guards.checkBulkAssignment(
        [{ slot: 1, symbol: 'DUPHELD' }, { slot: 1, symbol: 'DUPFREE' }], DAY);

      ck('a list naming slot 1 twice is REFUSED', verdict.ok === false, verdict);
      ck('with a 400 — this is a malformed request, not a conflict',
        verdict.status === 400, verdict);
      ck('and the refusal names the slot', /slot 1 is named twice/.test(verdict.error), verdict.error);
      ck('and both symbols, so the caller can see which two rows disagreed',
        /DUPHELD/.test(verdict.detail) && /DUPFREE/.test(verdict.detail), verdict.detail);
      ck('and says WHY it matters — a guard satisfied by a symbol that never lands',
        /never landed/.test(verdict.detail), verdict.detail);
    }

    // ── the duplicate check runs BEFORE the exemption can be abused ───────
    {
      // Order reversed: the protected symbol is the SECOND of the pair. It must
      // still be refused, and refused for the duplicate rather than squeaking
      // through on the exemption.
      const verdict = await guards.checkBulkAssignment(
        [{ slot: 1, symbol: 'DUPFREE' }, { slot: 1, symbol: 'DUPHELD' }], DAY);
      ck('the refusal does not depend on which row comes first',
        verdict.ok === false && /named twice/.test(verdict.error), verdict);
    }

    // ── and the state is untouched — a refusal writes nothing ─────────────
    {
      const { rows } = await query(
        `SELECT slot_no, symbol FROM depth_watchlist
          WHERE trading_date = $1 AND released_at IS NULL ORDER BY slot_no`, [DAY]);
      ck('the protected slot still holds its symbol',
        rows.length === 2 && rows[0].symbol === 'DUPHELD', rows);
    }

    // ── THE EXEMPTION STILL WORKS when the symbol really does land ────────
    {
      // DUPHELD genuinely moves from slot 1 to slot 3. It is still swept, so
      // releasing slot 1 costs nothing and the guard must not refuse.
      const verdict = await guards.checkBulkAssignment(
        [{ slot: 3, symbol: 'DUPHELD' }, { slot: 1, symbol: 'DUPFREE' }], DAY);
      ck('a genuine MOVE of a protected symbol is still allowed — the fix did '
        + 'not make the list unrefreshable', verdict.ok === true, verdict);
    }

    // ── re-posting the current list is still allowed ──────────────────────
    {
      const verdict = await guards.checkBulkAssignment(
        [{ slot: 1, symbol: 'DUPHELD' }, { slot: 2, symbol: 'DUPOTHER' }], DAY);
      ck('re-posting the list unchanged is allowed', verdict.ok === true, verdict);
    }

    // ── and a genuine displacement is still refused ───────────────────────
    {
      const verdict = await guards.checkBulkAssignment(
        [{ slot: 1, symbol: 'DUPFREE' }, { slot: 2, symbol: 'DUPOTHER' }], DAY);
      ck('dropping the protected symbol entirely is still REFUSED',
        verdict.ok === false, verdict);
      ck('and the refusal is the displacement one, not the duplicate one',
        /cannot be displaced/.test(verdict.error), verdict.error);
    }

    // ── a slot number given as a string is the same slot ──────────────────
    {
      const verdict = await guards.checkBulkAssignment(
        [{ slot: '1', symbol: 'DUPHELD' }, { slot: 1, symbol: 'DUPFREE' }], DAY);
      ck("'1' and 1 are the same slot — the comparison is numeric",
        verdict.ok === false && /named twice/.test(verdict.error), verdict);
    }

    await query('DELETE FROM depth_watchlist WHERE trading_date = $1', [DAY]);
    await query('DELETE FROM awsat_order_obs WHERE symbol = ANY($1)', [SYMS]);
    await query('DELETE FROM instruments WHERE symbol = ANY($1)', [SYMS]);
  } catch (e) {
    ck('the suite ran without throwing', false, e.message);
  }

  await close();
  console.log(`\nslot duplicate number: ${p}/${n}`);
  process.exit(p === n ? 0 : 1);
})();

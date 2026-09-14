'use strict';
/**
 * src/api/slotGuards.js — the rules that decide whether a depth slot may be
 * assigned, in one place, so BOTH endpoints that assign slots enforce them.
 *
 * Rebuilt from claude/spread-fix-delivery-2026-09-10.md ("bulk-slot guards").
 *
 * WHY THIS FILE EXISTS. `POST /slots/:n` carried three guards, each added after
 * something went wrong:
 *
 *   · SPR-03 — a symbol not in `instruments` is refused, not assigned. A typo
 *     like ZZZZ used to fall straight through and evict a live slot silently.
 *   · a non-tradeable symbol is refused — a slot on it sweeps a book nobody
 *     can act on.
 *   · a slot holding an open position or a live order CANNOT be displaced.
 *     Losing the book on a symbol you are IN is the one case where a swap
 *     costs more than it gains: you are blind on the position while watching
 *     something you are not in.
 *
 * `POST /depth-symbols` writes the same table to the same effect and enforced
 * none of them. It validated the slot number, a non-empty symbol and in-batch
 * duplicates, then released the whole day and reinserted — so a single bulk
 * call could release the slot the trader had a position in, and seat an unknown
 * symbol the sweep would then dutifully request. The narrow endpoint refused
 * with 409 what the wide one accepted with 200.
 *
 * Extracting them is the point: a guard that lives inside one handler is a
 * guard the next handler will not have.
 */

const { query } = require('../db/pool');

/**
 * Is this symbol allowed to occupy a slot at all?
 *
 * Returns { ok: true } or { ok: false, status, error, detail }.
 */
async function symbolIsAssignable(symbol) {
  const { rows } = await query(
    'SELECT is_tradeable, broker_status FROM instruments WHERE symbol = $1', [symbol]);

  if (!rows.length) {
    return {
      ok: false,
      status: 400,
      error: `${symbol} is not a listed symbol`,
      detail: 'not in the instruments list — check the spelling before displacing a live slot.',
    };
  }
  if (rows[0].is_tradeable === false) {
    return {
      ok: false,
      status: 400,
      error: `${symbol} is not tradeable`,
      detail: `broker_status ${rows[0].broker_status || 'unknown'} — a slot on it `
        + 'would sweep a book nobody can act on.',
    };
  }
  return { ok: true };
}

/**
 * May the symbol currently in a slot be displaced?
 *
 * `holding` is the symbol the slot holds right now, or null for an empty slot
 * (which is always displaceable). The backend's own record is consulted when
 * its schema is present — reads of spread.* are allowed across the seam, writes
 * are not — and a scraper-only database simply falls back to the public tables.
 */
async function slotIsDisplaceable(holding, day) {
  if (!holding) return { ok: true };

  /*
   * S6 · effective_status, not order_status.
   *
   * An order that has left the grid keeps its last stored status for ever — a
   * cancelled order a short scan missed still reads Queued. Reading the stored
   * status here meant the guard went on refusing to displace a slot holding
   * nothing, and the trader could not reassign it. The view reports UNSEEN once
   * an order is absent from a COMPLETE capture, which is the only honest answer
   * to "is this order still live?".
   */
  const { rows: busy } = await query(`
    SELECT
      (SELECT count(*)::int FROM position
        WHERE symbol = $1 AND is_open) AS open_positions,
      (SELECT count(*)::int FROM awsat_order_list
        WHERE symbol = $1 AND trading_date = $2
          AND effective_status IN ('Queued', 'Pending', 'Partially Filled')) AS queued`,
  [holding, day]);

  let backendHeld = 0;
  const hasBackend = await query(`SELECT to_regclass('spread.order_leg') AS t`)
    .then((r) => !!r.rows[0].t).catch(() => false);
  if (hasBackend) {
    const { rows: bk } = await query(`
      SELECT (SELECT count(*)::int FROM spread.order_leg
                WHERE symbol = $1 AND status IN ('FILLED','CARRIED','POSTED')) AS legs,
             (SELECT count(*)::int FROM spread.claim WHERE symbol = $1) AS claims`,
    [holding]).catch(() => ({ rows: [{ legs: 0, claims: 0 }] }));
    backendHeld = Number(bk[0].legs || 0) + Number(bk[0].claims || 0);
  }

  if (busy[0].open_positions > 0 || busy[0].queued > 0 || backendHeld > 0) {
    return {
      ok: false,
      status: 409,
      error: `${holding} cannot be displaced`,
      detail: busy[0].open_positions > 0 || backendHeld > 0
        ? `${holding} has an open position or order the backend is tracking — `
          + 'losing its book would leave you blind on a symbol you are in.'
        : `${holding} has ${busy[0].queued} queued order(s).`,
      holding,
    };
  }
  return { ok: true };
}

/**
 * The whole check for one bulk assignment: every symbol assignable, and every
 * slot the list would disturb displaceable.
 *
 * `slots` is [{ slot, symbol }] already normalised. Returns the first refusal,
 * because the bulk write is all-or-nothing and a partial list would leave the
 * sweep inconsistent — so there is nothing to gain from collecting more.
 *
 * IMPORTANT: a symbol staying in the slot it already holds is NOT a
 * displacement. Re-posting the current list must not be refused by the very
 * guard that protects it — that would make the list unrefreshable exactly when
 * the trader is in a position, which is when it is refreshed most.
 */
async function checkBulkAssignment(slots, day) {
  const { rows: current } = await query(
    `SELECT slot_no, symbol FROM depth_watchlist
      WHERE trading_date = $1 AND released_at IS NULL`, [day]);
  const held = new Map(current.map((r) => [Number(r.slot_no), r.symbol]));

  /*
   * H-F · A REPEATED SLOT NUMBER IS REFUSED BEFORE ANYTHING ELSE IS DECIDED.
   *
   * The `wanted.has(holding)` exemption below is sound on its own: a symbol
   * that moves to a different slot is still swept, so displacing it from the
   * old one costs nothing. It is only sound if every symbol in `wanted`
   * actually LANDS.
   *
   * With a duplicate slot number it does not. `[{slot: 1, AAA}, {slot: 1, BBB}]`
   * puts AAA in `wanted`, which exempts AAA's current slot from
   * slotIsDisplaceable — and then the write seats only BBB in slot 1. The slot
   * holding the live position is released, and the symbol that was supposed to
   * carry it forward was never written. The trader goes blind on a position
   * because two rows of one request disagreed.
   *
   * This is refused rather than resolved: last-wins and first-wins are both
   * defensible and neither is what the caller meant. A list that names the same
   * slot twice is a malformed list.
   */
  const seenSlots = new Map();
  for (const s of slots) {
    const slotNo = Number(s.slot);
    if (seenSlots.has(slotNo)) {
      return {
        ok: false,
        status: 400,
        error: `slot ${slotNo} is named twice`,
        detail: `slot ${slotNo} is assigned to both ${seenSlots.get(slotNo)} and `
          + `${s.symbol}. Only one of them could be seated, and the guards that `
          + 'protect the displaced slots would have been satisfied by a symbol '
          + 'that never landed.',
        slot: slotNo,
        symbol: s.symbol,
      };
    }
    seenSlots.set(slotNo, s.symbol);
  }

  // Built AFTER the duplicate check, so it can only contain symbols that will
  // actually be seated.
  const wanted = new Set(slots.map((s) => s.symbol));

  for (const s of slots) {
    const verdict = await symbolIsAssignable(s.symbol);
    if (!verdict.ok) return { ...verdict, slot: s.slot, symbol: s.symbol };
  }

  // Every slot the day currently holds is examined, not only the ones named in
  // the request: the bulk write releases the WHOLE day, so a slot the list
  // omits is displaced just as surely as one it overwrites.
  for (const [slotNo, holding] of held) {
    const wanting = slots.find((s) => Number(s.slot) === slotNo);
    if (wanting && wanting.symbol === holding) continue;      // unchanged
    if (wanted.has(holding)) continue;                        // moved, still swept
    const verdict = await slotIsDisplaceable(holding, day);
    if (!verdict.ok) {
      return {
        ...verdict,
        slot: slotNo,
        error: `slot ${slotNo} holds ${holding}, which cannot be displaced`,
      };
    }
  }

  return { ok: true };
}

module.exports = { symbolIsAssignable, slotIsDisplaceable, checkBulkAssignment };

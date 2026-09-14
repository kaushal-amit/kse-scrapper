'use strict';
/**
 * src/config/slots.js — ONE definition of the depth-slot address space.
 *
 * P2 · THERE WERE THREE, AND THEY DISAGREED.
 *
 *   · src/api/ingest.js published SLOT_COUNT (default 5) and validated both
 *     POSTs against it, above a comment that is explicit about why: "An
 *     operator who widens the sweep sets SLOT_COUNT, and the GET, both POSTs,
 *     and the backend's stale check all follow the published number — never a
 *     literal."
 *   · src/wakeup.js had `const WAKEUP_SLOTS = [4, 5, 6, 7, 8]` — that literal,
 *     not following the published number.
 *   · migration 024 permits slot_no 1-8, so the writes succeeded.
 *   · the depth userscript truncates the list it is served at LADDER_MAX_SAFE.
 *
 * WHAT THAT COST. Slots 1-3 pre-day, wake-ups fill 4 and 5, a third symbol
 * fires at 11:20. The wake-up scan takes slot 6, writes the depth_watchlist
 * row, writes a WAKEUP row to signal_log, and reports `promoted: 1` on a
 * SUCCESS run. GET /depth-symbols had no slot_no bound at all, so it served six
 * entries; the client swept five and dropped the new symbol. Its ladder was
 * never captured for the rest of the session — unrecoverable — while every
 * server-side record said it was promoted.
 *
 * And it could not be undone through either documented path: POST /slots/6
 * answers `400 slot must be 1-5`, and the bulk POST rejects any list containing
 * slot 6. Only direct SQL could clear it.
 *
 * So: one module, read by the router and by the wake-up scan.
 */

/** The migration's CHECK. Nothing here may exceed it — the INSERT would fail. */
const SCHEMA_MAX = 8;

/**
 * How many slots the sweep actually has. The published number.
 *
 * Not a threshold in src/config/thresholds.js: that file holds numbers ABOUT
 * THE MARKET or the strategy, and this is the size of a work budget — the same
 * category as DEPTH_SYMBOLS and HISTORY_DAYS, which live in the environment.
 * no-threshold-literals.test.js lists SLOT_COUNT for exactly that reason.
 */
function slotCount(env = process.env) {
  const raw = Number(env.SLOT_COUNT || 5);
  const n = Number.isFinite(raw) ? Math.floor(raw) : 5;
  return Math.min(SCHEMA_MAX, Math.max(1, n));
}

/**
 * The pre-day picks: slots 1-3, per migration 024's CHECK, and never more than
 * the sweep has.
 */
function preDaySlots(env = process.env) {
  const count = slotCount(env);
  const out = [];
  for (let s = 1; s <= Math.min(3, count); s += 1) out.push(s);
  return out;
}

/**
 * The slots a wake-up may take: everything above the pre-day block, up to the
 * published count.
 *
 * With SLOT_COUNT=5 this is [4, 5] — which is what the sweep can reach. It was
 * [4, 5, 6, 7, 8].
 */
function wakeupSlots(env = process.env) {
  const count = slotCount(env);
  const out = [];
  for (let s = 4; s <= count; s += 1) out.push(s);
  return out;
}

/** Every assignable slot, in sweep order. */
function allSlots(env = process.env) {
  const out = [];
  for (let s = 1; s <= slotCount(env); s += 1) out.push(s);
  return out;
}

module.exports = { SCHEMA_MAX, slotCount, preDaySlots, wakeupSlots, allSlots };

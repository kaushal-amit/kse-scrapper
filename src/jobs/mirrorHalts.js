'use strict';
/**
 * ============================================================================
 *  jobs/mirrorHalts.js — the halt seam (B4, spec §6/§7)
 * ============================================================================
 * The BACKEND detects halts and writes spread.halt_event; the backend may not
 * write public.* (lint-enforced), and the scraper may not write spread.*. So the
 * scraper MIRRORS each halt-resume firing into public.signal_log with
 * signal = 'HALT_RESUME', and signals.score then scores it like every other
 * signal (px_5min / px_15min / px_60min / was_right).
 *
 * TIMING, stated and checked: the mirror runs as the FIRST STEP of signals.score
 * (nightly, 17:45), so every halt of the day is in signal_log before scoring. It
 * is NOT real-time — the alert path is spread:halt, not signal_log — and nothing
 * depends on it being so.
 *
 * THE CHECK: after the mirror, count(halt_event RESUME for the day) must equal
 * count(signal_log HALT_RESUME for the day). A mismatch FAILS the job loudly —
 * scoring does not proceed against a half-mirrored day.
 *
 * A firing is a RESUME (it carries resume_price_fils, the baseline was_right is
 * graded from); a HALT without a resume is not a firing and is not mirrored.
 * ============================================================================
 */
const { query } = require('../db/pool');
const clock = require('../market/clock');
const log = require('../logger');

/** Does spread.halt_event exist? A scraper-only database (no backend schema) has
 *  no halts to mirror — that is a skip, not a failure. */
async function haltEventExists() {
  const { rows } = await query(
    `SELECT to_regclass('spread.halt_event') AS t`);
  return !!rows[0].t;
}

async function mirror(tradingDay) {
  const day = tradingDay || clock.tradingDay();
  if (!(await haltEventExists())) {
    log.info('halt mirror: spread.halt_event absent — skipped', { day });
    return { skipped: true, copied: 0, present: 0 };
  }

  // Each RESUME firing → one signal_log row. ON CONFLICT keeps it once and only
  // once, so a re-run copies nothing new (idempotent).
  const { rows: before } = await query(
    `SELECT count(*)::int AS n FROM signal_log
      WHERE trading_date = $1 AND signal = 'HALT_RESUME'`, [day]);

  await query(`
    INSERT INTO signal_log (fired_at, trading_date, symbol, signal, price, message)
    SELECT h.detected_at, h.trading_day, h.symbol, 'HALT_RESUME',
           h.resume_price_fils,
           COALESCE(h.verdict, '') || CASE WHEN h.verdict_detail IS NOT NULL THEN ' · ' || h.verdict_detail ELSE '' END
      FROM spread.halt_event h
     WHERE h.trading_day = $1 AND h.kind = 'RESUME'
    ON CONFLICT (symbol, signal, fired_at) DO NOTHING`, [day]);

  const { rows: after } = await query(
    `SELECT count(*)::int AS n FROM signal_log
      WHERE trading_date = $1 AND signal = 'HALT_RESUME'`, [day]);
  const { rows: src } = await query(
    `SELECT count(*)::int AS n FROM spread.halt_event
      WHERE trading_day = $1 AND kind = 'RESUME'`, [day]);

  const copied = after[0].n - before[0].n;
  const present = before[0].n;
  log.info(`halt mirror: ${copied} copied, ${present} already present`, { day });

  // The equality check — a mismatch means a firing did not mirror; fail loudly
  // rather than scoring a half-mirrored day.
  if (after[0].n !== src[0].n) {
    throw new Error(
      `halt mirror mismatch on ${day}: ${src[0].n} halt_event RESUME rows but `
      + `${after[0].n} signal_log HALT_RESUME rows — not scoring a half-mirrored day`);
  }
  return { skipped: false, copied, present, total: after[0].n };
}

module.exports = { mirror, haltEventExists };

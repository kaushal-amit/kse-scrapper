'use strict';
/**
 * src/config/thresholds.js — the nine numbers the SCRAPER reads.
 *
 * ─── WHY NOT kb_threshold ──────────────────────────────────────────────────
 * The scraper read thirty keys from that table and asserted on all thirty
 * while using eight. The other twenty-two are sizing and gating — my_pct_min,
 * reserve_pct, commission_rate — which are the backend's concern.
 *
 * Worse, the assertion was strict, so the scraper REFUSED TO BOOT when the
 * table was missing. A capture service that will not start unless a backend
 * table exists is backwards coupling: the thing that must run during a session
 * depending on the thing that reads what it captured.
 *
 * kb_threshold stays where it belongs — the backend, as spread.kb_threshold.
 * Nothing here reads it.
 *
 * ─── WHY A FILE AND NOT ENV VARS ───────────────────────────────────────────
 * Env vars lose the provenance. `SIG_BUYERS_RATIO=1.6` says nothing about why
 * 1.6, when it changed, or what evidence set it — and provenance is the whole
 * reason kb_threshold was worth building. Each constant below carries its CR.
 *
 * Every one takes an env override, so a value can still be changed for one run
 * without editing code.
 */

const num = (envVar, fallback) => {
  const raw = process.env[envVar];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

const THRESHOLDS = {
  /** NO PROTECTION: a touch bid smaller than this has nothing beneath it. CR-37 */
  sig_no_protection_bid: num('SIG_NO_PROTECTION_BID', 20_000),

  /** BUYERS 8:5 fires at or above this ratio AND with the price rising. CR-41 */
  sig_buyers_ratio: num('SIG_BUYERS_RATIO', 1.6),

  /** FROZEN: both sides above this with zero volume between snapshots. CR-68 */
  sig_big_qty: num('SIG_BIG_QTY', 100_000),

  /** BAIT BID: large, and younger than this. CR-50 */
  sig_bait_max_age_secs: num('SIG_BAIT_MAX_AGE_SECS', 300),

  /** A print at or below this is tiny. CR-40 */
  sig_tiny_trade_shares: num('SIG_TINY_TRADE_SHARES', 100),

  /** Size at a level worth calling a wall. CR-51 */
  sig_wall_qty: num('SIG_WALL_QTY', 200_000),

  /** Trades today over the median for this hour across ten sessions. CR-46 */
  wakeup_pace_min: num('WAKEUP_PACE_MIN', 3),

  /** Below this trade count the pace ratio is noise. CR-46 */
  wakeup_trades_min: num('WAKEUP_TRADES_MIN', 20),

  // ── B2 · the movement test (Item 4) ──────────────────────────────────────
  // ACTIVITY is one of three; MOVEMENT and an absolute-volume floor are both
  // required. The wake-up finds stocks to WATCH, so the movement bar matters
  // more than raw pace. Every number here, never a literal in wakeup.js.
  /** ACTIVITY (a): pace ≥ this × the session baseline. */
  wakeup_pace_mult: num('WAKEUP_PACE_MULT', 2),
  /** ACTIVITY (b): today's volume ≥ this × the symbol's own average. */
  wakeup_vol_mult: num('WAKEUP_VOL_MULT', 3),
  /** ACTIVITY (c): moved at least this many fils from the open. */
  wakeup_move_open_fils: num('WAKEUP_MOVE_OPEN_FILS', 15),
  /** MOVEMENT: the day's high−low range must be at least this many fils. */
  wakeup_range_min_fils: num('WAKEUP_RANGE_MIN_FILS', 8),
  /** MOVEMENT: an up-move of at least this many fils must have happened. */
  wakeup_upmove_fils: num('WAKEUP_UPMOVE_FILS', 3),
  /** The screen's absolute-volume floor is this × shares-at-budget (300 × shares). */
  wakeup_abs_vol_floor_shares: num('WAKEUP_ABS_VOL_FLOOR_SHARES', 300),
  /** A fraction of the screen floor for the WATCH threshold — the dry-run lowers
   *  it toward 1/3 if the full floor fires under one symbol a session. */
  wakeup_abs_vol_floor_frac: num('WAKEUP_ABS_VOL_FLOOR_FRAC', 1),

  /**
   * A close from before this hour is not a close. CR-64
   *
   * Capture end times cluster at 12:59 — ten July days, half an hour early,
   * missing only the closing auction. Two days sit far below: 30 July at 10:14
   * and 26 August at 12:23. 12:30 falls in the empty gap between the groups, so
   * it is the midpoint of a real discontinuity rather than a number tuned to
   * the data.
   *
   * A session whose last capture is earlier than this is skipped for prev_close
   * AND for chg_5d — one meaning of "usable for a close".
   */
  close_capture_min_hhmm: num('CLOSE_CAPTURE_MIN_HHMM', 1230),
};

/** Throws rather than returning undefined: a gate comparing against undefined
 *  evaluates false and never fires, which looks exactly like a quiet market. */
function get(key) {
  const v = THRESHOLDS[key];
  if (v === undefined) throw new Error(`unknown scraper threshold: ${key}`);
  return v;
}

function all() { return { ...THRESHOLDS }; }

/** Printed at boot. A green line saying "I looked" beats silence. */
function summary() {
  return `${Object.keys(THRESHOLDS).length} thresholds from src/config/thresholds.js`;
}

module.exports = { get, all, summary, THRESHOLDS };

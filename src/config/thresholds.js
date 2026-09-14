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
  /**
   * MOVEMENT: how many such up-moves. F-12 — this was a literal `>= 1` in
   * wakeup.js, the only term in that verdict that was not read from here,
   * under a header in this file that says "Every number here, never a literal
   * in wakeup.js."
   */
  wakeup_upmoves_min: num('WAKEUP_UPMOVES_MIN', 1),
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

  /* ── F-12 · the sixteen that lived in six other files ───────────────────
   *
   * Each of these was a `const X = Number(process.env.Y || literal)` in the
   * file that used it. That is the shape a threshold takes here — a value
   * somebody decided, named and made configurable — and it is the shape that
   * DRIFTS, because two files can each define one and disagree. The pair that
   * had teeth: writeSymbolMinute.js defined its own BIG_QTY/WALL_QTY while
   * signals.js read these, so setting one and not the other made
   * symbol_minute.is_frozen (persisted, read by the backend) and
   * signals.frozen() (fires the alert) disagree about "big" in the same row.
   *
   * no-threshold-literals.test.js fails if a new one appears anywhere in src/.
   */

  /** symbol_day: a print at or under this many shares is a "tiny" one. */
  sd_at_offer_invalidates_pct: num('SD_AT_OFFER_MAX', 90),
  /** symbol_day: fewer minutes than this and the session is THIN outright. */
  sd_thin_absolute_minutes: num('SD_THIN_MINUTES', 60),
  /** symbol_day: …or under this fraction of the market's median minutes. */
  sd_thin_median_fraction: num('SD_THIN_FRACTION', 0.80),
  /** symbol_day: above this price the 0.1-fil "crawler" pattern cannot occur. */
  sd_crawler_max_price_fils: num('SD_CRAWLER_MAX_PX', 100),
  /**
   * symbol_day: the session midpoint, for the first-half / second-half pace
   * split. A CLOCK TIME, and it was `11 * 60 + 15` in the code — wrong the
   * moment the session's hours change, which END_TIME has already done once.
   */
  sd_session_midpoint_hhmm: num('SD_SESSION_MIDPOINT_HHMM', 1115),
  /** symbol_day: a capture at or after this makes the day's range FULL. */
  sd_range_full_hhmm: num('SD_RANGE_FULL_HHMM', 1310),
  /**
   * symbol_day: how many usable sessions back previousCloses may reach for a
   * prev_close. H-K.
   *
   * Its own docblock has always said "CAPPED AT 5 SESSIONS: a previous close
   * from two weeks ago is not one" — and nothing capped it. The query took the
   * most recent session that produced a close however far back that was, so a
   * symbol suspended for three weeks came back with chg_fils measured against
   * its pre-suspension price, and that number reached down_days, the breadth
   * count and the signal scoring as though it were a day's move.
   *
   * Beyond this reach prev_close stays NULL and the symbol is simply not
   * measured, which is what prev_session_gap_days was added to make visible.
   */
  sd_prev_close_max_sessions_back: num('SD_PREV_CLOSE_MAX_SESSIONS', 5),
  /** symbol_day: how many sessions back chg_5d measures from. The 5 in its name. */
  sd_chg5d_sessions_back: num('SD_CHG5D_SESSIONS', 5),
  /**
   * symbol_day: how many usable MARKET sessions back the chg_5d base may be
   * found in. P2.
   *
   * `back = 5` counts the SYMBOL's own closes, not market sessions — the same
   * distinction H-K drew for chg_1d. A symbol that printed on five of the last
   * forty sessions had its chg_5d measured against a close two months old, in a
   * column named for five sessions, with no gap column to say so.
   *
   * Ten, not five: chg_5d legitimately reaches further than chg_1d, and a
   * symbol that missed a session or two inside the window should still get an
   * answer. Beyond it, no answer.
   */
  sd_chg5d_max_sessions_back: num('SD_CHG5D_MAX_SESSIONS', 10),

  /** market_day: below this percent advancing the regime is RISK_OFF. */
  md_regime_risk_off_pct: num('MD_REGIME_RISK_OFF_PCT', 35),
  /** market_day: at or below this it is NEUTRAL; above it, RISK_ON. */
  md_regime_neutral_pct: num('MD_REGIME_NEUTRAL_PCT', 50),
  /** market_day: the multiple of trailing volume that counts as "over N×". */
  md_over_multiple: num('MD_OVER_MULTIPLE', 3),
  /**
   * market_day: the share of traded symbols whose direction must actually be
   * MEASURED before breadth is reported at all. H-J.
   *
   * pct_advancing is advancing over the symbols that HAVE a direction. On a
   * session where most symbols have no previous close — the day after a gap in
   * the capture, or a backfill's first day — that leaves a percentage computed
   * over a handful of stocks and presented with the same authority as one
   * computed over 136. Below this share the honest answer is NOT COMPUTED, and
   * regime with it: an unmeasured market is not a RISK_OFF one.
   *
   * 0.5 is deliberately permissive. It is not a calibration — it is the point
   * below which the number stops describing the market at all.
   */
  md_breadth_min_measured_frac: num('MD_BREADTH_MIN_MEASURED_FRAC', 0.5),

  /** tradingview_history: fewer captures than this cannot make an honest bar. */
  history_min_captures: num('HISTORY_MIN_CAPTURES', 10),

  /** signal scoring: the move, in fils, that counts as the signal being right. */
  score_min_move_fils: num('SCORE_MIN_MOVE_FILS', 1),
  /**
   * signal scoring: how far past the target a capture may be and still answer
   * "the price N minutes later". Beyond it the answer is NOT COMPUTED — a
   * capture 40 minutes late is not a late answer, it is a different question.
   */
  score_forward_tolerance_min: num('SCORE_FORWARD_TOLERANCE_MIN', 10),

  /** wake-up: how many SESSIONS of baseline the volume comparison reads. */
  wakeup_baseline_sessions: num('WAKEUP_BASELINE_DAYS', 10),
  /** wake-up: the board lot, for shares-at-budget. */
  wakeup_lot_shares: num('WAKEUP_LOT', 100),
  /**
   * wake-up: the budget used when spread.gate_config cannot be read. A
   * FALLBACK, announced at the point of use — see currentBudgetKd.
   */
  wakeup_budget_fallback_kd: num('WAKEUP_BUDGET_KD', 2000),
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

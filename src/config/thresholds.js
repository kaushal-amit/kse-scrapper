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
  /*
   * How long after the close the nightly catch-up keeps trying before it
   * gives up and raises a NIGHTLY_JOB_MISSING alarm instead. A job that has
   * failed for four hours does not need another attempt; it needs somebody to
   * look at it. Here rather than in the scheduler because a number that
   * decides when a gate stops trying is a threshold like any other.
   */
  catchup_give_up_mins: num('CATCHUP_GIVE_UP_MINUTES', 240),

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
  /*
   * ─── RULE 2 · CAPTURE QUALITY AGAINST THE SCHEDULED WINDOW (049) ────────
   *
   * These live HERE and not in spread.kb_threshold, deliberately, and against
   * the project's usual "every threshold is a kb row". src/index.js:207 and
   * this file's own header give the reason: a capture service must not refuse
   * to capture because a KB row is missing. Making the LABEL of a capture
   * depend on the backend's schema reintroduces exactly that coupling, in the
   * one job that runs after the market shuts with nobody watching.
   *
   * Rule 1 — whatever wrote the 3,496 PARTIAL rows — divided by that day's own
   * median, so a day where every symbol stopped together scored 100%. Rule 2
   * divides by the SCHEDULED window (public.market_session_hours, falling back
   * to CAPTURE_START_TIME..CAPTURE_END_TIME), which cannot collapse with the
   * thing it measures.
   */
  /**
   * FULL at or above this fraction of the SCHEDULED CONTINUOUS SESSION.
   *
   * 0.94 is the MAXIMUM-MARGIN SEPARATOR, not a round number. Measured 25
   * September over 6,557 symbol-days in 47 sessions, numerator restricted to
   * 09:00-13:00: the 93-95% band is EMPTY, and so is 50-52%. Every value in
   * (0.929, 0.950] partitions the sample identically, so the evidence does not
   * choose between them — the midpoint of the empty band is the choice that
   * survives the most measurement error in either direction.
   *
   * 0.95 was rejected because it sits EXACTLY on two days' medians (16 Jul and
   * 24 Sep, both 228/240 = 95.0%): one lost minute flips both to PARTIAL.
   *
   * The bands are empty because the data fails in quantised steps — one client
   * serves every symbol, so a capture dies at a moment and the whole market
   * loses the same tail. See migration 049's header. A different failure mode
   * (slow degradation rather than a clean cut) would populate them, which is
   * why computeSymbolDay raises a data_alarm on any value landing inside one.
   */
  sd_full_min_fraction: num('SD_FULL_FRACTION', 0.94),
  /** PARTIAL down to this fraction of it; below, the session is THIN. */
  sd_partial_min_fraction: num('SD_PARTIAL_FRACTION', 0.50),
  /**
   * The empty bands either side of the two boundaries above, as measured. A
   * symbol-day landing INSIDE one does not mean the threshold is wrong — it
   * means the failure mode changed, and that is worth knowing the day it
   * happens rather than at the next audit. The loud form of a robustness
   * choice. Half-open, matching the comparisons: (lo, hi].
   */
  sd_full_band_lo: num('SD_FULL_BAND_LO', 0.929),
  sd_partial_band_hi: num('SD_PARTIAL_BAND_HI', 0.525),
  /** symbol_day: fewer minutes than this and the session is THIN outright. */
  sd_thin_absolute_minutes: num('SD_THIN_MINUTES', 60),
  /**
   * symbol_day: …or under this fraction of the market's median minutes.
   *
   * RULE 1's median test, kept because it still catches the case rule 2
   * cannot: one symbol falling behind a market that is otherwise fine. It is
   * no longer the load-bearing test — a uniform outage makes it unfireable —
   * and the absolute floor below it is now a true last resort rather than the
   * only backstop.
   */
  sd_thin_median_fraction: num('SD_THIN_FRACTION', 0.80),
  /** symbol_day: above this price the 0.1-fil "crawler" pattern cannot occur. */
  sd_crawler_max_price_fils: num('SD_CRAWLER_MAX_PX', 100),
  /**
   * symbol_day: the session midpoint, for the first-half / second-half pace
   * split. A CLOCK TIME, and it was `11 * 60 + 15` in the code — wrong the
   * moment the session's hours change, which END_TIME has already done once.
   */
  sd_session_midpoint_hhmm: num('SD_SESSION_MIDPOINT_HHMM', 1115),
  /**
   * symbol_day: a capture at or after this makes the day's range FULL.
   *
   * 1300, not 1310. CONTINUOUS TRADING ENDS AT 13:00, so a threshold of 1310
   * demanded a capture from a session that no longer exists — range_source
   * could never read FULL for any day ever captured, and nobody noticed
   * because the column is only ever read as "is it FULL", which was always
   * false. A gate that can never pass is the same defect as a check that can
   * never fail.
   */
  sd_range_full_hhmm: num('SD_RANGE_FULL_HHMM', 1300),
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

  // ── P6 · the capture-honesty numbers ─────────────────────────────────────
  /**
   * A board below this percentage of the reference universe is a PARTIAL run,
   * not a SUCCESS: a scroll that stopped at 60 of 137 symbols used to be
   * recorded as a complete market. P6-TV-3 / P6-AWS-8.
   */
  board_coverage_min_pct: num('BOARD_COVERAGE_MIN_PCT', 80),
  /**
   * How long a failed AWSAT login stops further attempts in this worker. The
   * broker's daily attempt budget is loginGuard's job; this only prevents a
   * hot loop. It used to be "for the rest of the process". P6-AWS-1.
   */
  awsat_login_retry_cooldown_ms: num('AWSAT_LOGIN_RETRY_COOLDOWN_MS', 600_000),
  /**
   * No frame on the price socket for this long means the feed is dead, and the
   * rows still in the tap are its last ones — storing them would record a dead
   * feed as a live board. P6-AWS-2.
   */
  awsat_socket_max_frame_age_ms: num('AWSAT_SOCKET_MAX_FRAME_AGE_MS', 180_000),
  /**
   * The depth sweep returns what it has at this point rather than being killed
   * by the worker timeout with every book still in memory. P6-AWS-7.
   */
  awsat_depth_sweep_ms: num('AWSAT_DEPTH_SWEEP_MS', 240_000),
  /**
   * One symbol's history scroll, before it gives up its remaining scrolls so
   * the rest of the run survives. P6-TV-2.
   */
  history_symbol_ms: num('HISTORY_SYMBOL_MS', 90_000),
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

'use strict';
/**
 * Nightly scoring — Step 3, item 6.
 *
 * Fills px_5min, px_15min and was_right on signals fired today. A signal is
 * only worth keeping if what happened next sits next to it; without this the
 * log accumulates alerts nobody can grade.
 *
 * ─── was_right ─────────────────────────────────────────────────────────────
 * The list does not define it. Implemented as: the price at +5 minutes moved
 * in the signal's own direction by at least one fil.
 *
 * DIRECTION MATTERS, and it is not the same for every signal. BUYERS_8_5 and
 * WALL_PULLED are reasons to expect a rise; NO_PROTECTION, BID_EMPTY and
 * BAIT_BID are warnings, and they are "right" when the price FALLS. Scoring
 * every signal as though it predicted a rise would mark a correct warning as a
 * failure, which is worse than not scoring at all.
 *
 * FROZEN predicts neither, so it is left NULL rather than forced into a verdict.
 */

const { query } = require('../db/pool');
const clock = require('../market/clock');
const log = require('../logger');

/*
 * ─── THE SCORING RULE, in one place (B1) ─────────────────────────────────────
 * `was_right` is graded at +5 MINUTES on the signal's OWN claim, by at least
 * MIN_MOVE_FILS. The claim differs by signal, and grading them all as "expects
 * a rise" would mark a correct warning as a failure:
 *
 *   'up'    the signal expects a RISE   — right when px rose  ≥ MIN_MOVE
 *   'down'  the signal is a WARNING     — right when px FELL  ≥ MIN_MOVE
 *   'still' the signal says NOTHING WILL — right when px stayed within MIN_MOVE
 *           MOVE (FROZEN: both sides walled, zero volume). It IS gradable — the
 *           freeze either held or it broke — it is just not directional.
 *   'none'  no forward claim (PREDAY, a pre-session marker) → left NULL.
 *
 * px_5min / px_15min / px_60min are all filled (a signal can be right at five
 * minutes and wrong at sixty); was_right is the 5-minute grade, and pct_right at
 * all three horizons is reported by scoringReport() from the px columns.
 * HALT_RESUME is scored 'up' — a down-halt resume is a bounce play (B4).
 */
const MODE = {
  BUYERS_8_5: 'up',
  WALL_PULLED: 'up',
  WAKEUP: 'up',
  HALT_RESUME: 'up',
  PREDAY: 'none',
  NO_PROTECTION: 'down',
  BID_EMPTY: 'down',
  BAIT_BID: 'down',
  WALL_PLACED: 'down',
  FROZEN: 'still',
};

/**
 * How far past the target a capture may be and still answer the question.
 *
 * The grid is ~60 s, so a few minutes of tolerance absorbs an ordinary gap. A
 * capture 40 minutes late is not "the price 5 minutes later" by any reading,
 * and treating it as one is how a quiet hour becomes a measured move.
 */
const FORWARD_TOLERANCE_MIN = require('../config/thresholds').get('score_forward_tolerance_min');

/** The Kuwait trading day a signal's timestamp belongs to. */
function tradingDayOf(at) {
  return clock.tradingDay(at instanceof Date ? at : new Date(at));
}

const MIN_MOVE_FILS = require('../config/thresholds').get('score_min_move_fils');

/**
 * Grade one horizon's price against the signal's claim. null = not gradable.
 *
 * P5 · ZERO IS NOT A PRICE ON EITHER SIDE OF THE SUBTRACTION.
 *
 * P4 guarded the FORWARD price — both branches of priceAfter now require
 * `last_price > 0` — and left the other operand of the same subtraction
 * unguarded. signal_log.price comes from jobs.js writing now.last_price with no
 * floor into a bare numeric column with no CHECK, and validate.js rejects only
 * a NEGATIVE price, so a zero is storable.
 *
 * Two signals reach here without reading last_price at all: WALL_PULLED and
 * NO_PROTECTION are computed from the depth ladder, which latestObservation
 * takes from the depth capture while the price comes from the quotes capture.
 * So a row whose quote grid had gone empty — last_price 0 — still fires them.
 *
 * grade(0, 204, 'up') was TRUE: a 204-fil rise recorded for a stock that did
 * not move, on WALL_PULLED, BUYERS_8_5 and HALT_RESUME. The exact mirror of the
 * defect P4 fixed for the four 'down' families, in the same column, in the same
 * evidence base. mirrorHalts inserts resume_price_fils as `price` with no floor
 * either, so HALT_RESUME — the one setup the strategy is built on — takes the
 * same route from the backend's side.
 *
 * Guarding one operand of a difference is not guarding the difference.
 */
function grade(base, px, mode) {
  if (base == null || px == null || !mode || mode === 'none') return null;
  if (Number(base) <= 0 || Number(px) <= 0) return null;
  const move = Number(px) - Number(base);
  if (mode === 'up') return move >= MIN_MOVE_FILS;
  if (mode === 'down') return -move >= MIN_MOVE_FILS;
  if (mode === 'still') return Math.abs(move) < MIN_MOVE_FILS;
  return null;
}

/**
 * The price a given number of minutes after a moment, WITHIN THE SAME SESSION.
 *
 * The FIRST capture at or after the target, not the nearest — "the price five
 * minutes later" must not be satisfied by a print from four minutes later
 * because it happens to be closer.
 *
 * F-15 · BOUNDED TO THE SIGNAL'S OWN TRADING DAY, AND TO A WINDOW.
 *
 * Neither query used to bound the forward search at all. A signal firing at
 * 13:05 with a 60-minute horizon looked for the first capture at or after
 * 14:05 — and continuous trading ends at 13:30, so it returned the NEXT
 * SESSION'S OPENING PRINT. On a Thursday that is three calendar days and a
 * weekend later, gap included.
 *
 * `was_right` then recorded a win that measures an overnight gap rather than a
 * 60-minute book signal. And because halts cluster late in the session, this
 * preferentially corrupted the HALT_RESUME family — the one setup the strategy
 * is actually built on. These numbers are the evidence base for deciding
 * whether any of these signals work at all.
 *
 * A signal whose horizon runs past the close is NOT COMPUTED. That is the
 * honest answer: the session ended before the question could be asked, and a
 * cross-session price is not a late answer to it — it is an answer to a
 * different question.
 */
async function priceAfter(symbol, from, minutes) {
  // symbol_minute FIRST — it is the finest grid, but it exists only for the 8–17
  // depth-slot symbols (signals.fast writes it). A WAKEUP fires on any of ~137
  // symbols, so for all but the slotted few symbol_minute has no row and the
  // forward price was never filled (1 of 15 WAKEUP rows). Fall back to the
  // board-wide awsat_market_quotes (~60 s, every symbol) so every signal gets a
  // forward price.
  //
  // Both are bounded the same way: at or after the target, on the SAME trading
  // day, and within a tolerance of the target so a long capture gap does not
  // silently answer with a much later print.
  const { rows } = await query(
    `SELECT last_price FROM symbol_minute
      WHERE symbol = $1
        AND ts >= $2::timestamptz + ($3 || ' minutes')::interval
        AND ts <  $2::timestamptz + (($3::int + $5::int) || ' minutes')::interval
        AND trading_date = $4::date
        -- P4 · "> 0", which the quotes fallback below has always had and this
        -- branch did not — and this branch is consulted FIRST and returns on
        -- any non-null row, so the guarded fallback never ran.
        --
        -- Zero is stored as a measurement on purpose: validate.js rejects only
        -- a NEGATIVE price, and negative-prices.test.js asserts "zero is a
        -- measurement and survives". latestObservation copies last_price
        -- through num() with no floor, so a zero reaches symbol_minute whenever
        -- a slotted symbol's book goes empty — the 398-row shape
        -- empty-books.test.js documents.
        --
        -- A zero five minutes after a signal made px_5min = 0 and graded a
        -- 200-fil FALL that never happened, so the four 'down' families —
        -- NO_PROTECTION, BID_EMPTY, BAIT_BID, WALL_PLACED — were recorded as
        -- RIGHT in the evidence base the strategy is judged on, precisely when
        -- the book they warn about had emptied.
        --
        -- Same class as the zero book in symbolDayMetrics: zero is not a price.
        AND last_price IS NOT NULL AND last_price > 0
      ORDER BY ts ASC LIMIT 1`, [symbol, from, minutes, tradingDayOf(from), FORWARD_TOLERANCE_MIN],
  );
  if (rows.length) return Number(rows[0].last_price);
  const { rows: q } = await query(
    `SELECT last_price FROM awsat_market_quotes
      WHERE symbol = $1
        AND created_at >= $2::timestamptz + ($3 || ' minutes')::interval
        AND created_at <  $2::timestamptz + (($3::int + $5::int) || ' minutes')::interval
        AND trading_date = $4::date
        AND last_price IS NOT NULL AND last_price > 0
      ORDER BY created_at ASC LIMIT 1`, [symbol, from, minutes, tradingDayOf(from), FORWARD_TOLERANCE_MIN],
  );
  return q.length ? Number(q[0].last_price) : null;
}

async function score(tradingDay, runId) {
  const day = tradingDay || clock.tradingDay();

  const { rows: pending } = await query(
    `SELECT id, symbol, signal, fired_at, price
       FROM signal_log
      WHERE trading_date = $1 AND scored_at IS NULL
      ORDER BY fired_at`, [day],
  );

  if (!pending.length) {
    log.info('scoring: nothing unscored', { day });
    return { extracted: 0, inserted: 0, rejected: 0 };
  }

  let scored = 0;
  let unscorable = 0;

  for (const s of pending) {
    const px5 = await priceAfter(s.symbol, s.fired_at, 5);
    const px15 = await priceAfter(s.symbol, s.fired_at, 15);
    // px_60min is in the spec: a signal can be right at 5 minutes and wrong an
    // hour later, and only keeping both shows which.
    const px60 = await priceAfter(s.symbol, s.fired_at, 60);
    const base = s.price === null ? null : Number(s.price);

    // was_right is the 5-minute grade on the signal's own claim (see MODE).
    const mode = MODE[s.signal];
    const wasRight = grade(base, px5, mode);

    // scored_at is stamped even when was_right stays NULL: the signal HAS been
    // looked at, and leaving it unscored would make the job retry it nightly
    // for ever against data that is never going to arrive.
    await query(
      `UPDATE signal_log SET px_5min = $1, px_15min = $2, px_60min = $3,
              was_right = $4, scored_at = now()
        WHERE id = $5`, [px5, px15, px60, wasRight, s.id],
    );

    if (wasRight === null) unscorable += 1; else scored += 1;
  }

  const { rows: tally } = await query(
    `SELECT signal,
            count(*) FILTER (WHERE was_right) AS right_n,
            count(*) FILTER (WHERE was_right IS NOT NULL) AS graded
       FROM signal_log WHERE trading_date = $1 GROUP BY signal ORDER BY signal`, [day],
  );

  log.info('scoring: complete', {
    day, runId, graded: scored, unscorable,
    bySignal: tally.map((t) => `${t.signal} ${t.right_n}/${t.graded}`),
  });

  return { extracted: pending.length, inserted: scored, rejected: unscorable };
}

/**
 * B1 · score EVERY day that still has unscored rows, oldest first — not only
 * today. The nightly job scored `trading_date = today`, so any day the 17:45 run
 * was missed (a restart, a deploy, the process down) left its rows unscored for
 * ever: 4,507 accumulated. This backfills them. Idempotent — a scored row is
 * never revisited (scored_at IS NOT NULL).
 */
async function scoreBackfill(runId) {
  const { rows: days } = await query(
    `SELECT DISTINCT trading_date FROM signal_log
      WHERE scored_at IS NULL ORDER BY trading_date`);
  let total = 0, graded = 0;
  for (const d of days) {
    const r = await score(d.trading_date, runId);
    total += r.extracted; graded += r.inserted;
  }
  log.info('scoring: backfill complete', { days: days.length, total, graded });
  return { days: days.length, total, graded };
}

/**
 * B1 · pct_right at 5, 15 and 60 minutes SEPARATELY, per signal — the table the
 * delivery note carries. Computed from the px columns and each signal's MODE, so
 * it re-grades at every horizon rather than only the stored 5-minute was_right.
 * fired = rows that fired; scored = rows with a forward price at that horizon.
 */
async function scoringReport(day) {
  const d = day || clock.tradingDay();
  const { rows } = await query(
    `SELECT signal, price, px_5min, px_15min, px_60min FROM signal_log
      WHERE trading_date = $1`, [d]);
  const acc = {};
  for (const r of rows) {
    const mode = MODE[r.signal] || 'none';
    const a = acc[r.signal] || (acc[r.signal] = { fired: 0, h: { 5: { n: 0, right: 0 }, 15: { n: 0, right: 0 }, 60: { n: 0, right: 0 } } });
    a.fired += 1;
    for (const [h, px] of [[5, r.px_5min], [15, r.px_15min], [60, r.px_60min]]) {
      const g = grade(r.price, px, mode);
      if (g !== null) { a.h[h].n += 1; if (g) a.h[h].right += 1; }
    }
  }
  const pct = (o) => (o.n ? Math.round((100 * o.right) / o.n) : null);
  return Object.entries(acc).map(([signal, a]) => ({
    signal, mode: MODE[signal] || 'none', fired: a.fired,
    scored5: a.h[5].n, pctRight5: pct(a.h[5]),
    scored15: a.h[15].n, pctRight15: pct(a.h[15]),
    scored60: a.h[60].n, pctRight60: pct(a.h[60]),
  })).sort((x, y) => x.signal.localeCompare(y.signal));
}

module.exports = { score, scoreBackfill, scoringReport, priceAfter, grade, MODE, MIN_MOVE_FILS };

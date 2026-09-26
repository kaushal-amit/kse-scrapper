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
const STALE_TOLERANCE_MIN = require('../config/thresholds').get('score_stale_tolerance_min');
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
 * P4 guarded the FORWARD price — both branches of priceInForceAt now require
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
 * The price IN FORCE at a given number of minutes after a moment, within the
 * same session: the LAST capture at or before the mark.
 *
 * ─── C1 · THIS USED TO REACH PAST THE MARK, AND THAT IS LOOKAHEAD ──────────
 *
 * The rule here was "the FIRST capture at or after the target, not the
 * nearest", defended on the grounds that a print from four minutes later must
 * not answer the five-minute question. The defence is wrong, and it is wrong
 * in the one direction that biases everything downstream.
 *
 * Signals fire within seconds of a capture — they are computed FROM one — and
 * the grid is ~60 s. So the capture five minutes after a signal lands just
 * BEFORE fired_at + 5 min, and "the first at or after the mark" is the one
 * after that: systematically about a minute late. Measured by the KB team over
 * the last 400 signals (14-24 Sep 2026):
 *
 *   · 232 of 400 — the first capture at or after the mark is more than 50 s
 *     past it;
 *   · of the 139 where the captures either side of the mark differ in price,
 *     px_5min held the LATER one in 93 and the earlier one in 46.
 *
 * The decisive objection is not the lateness; it is what the lateness is made
 * of. Grading against a print that had not happened at the mark uses
 * information unavailable at the moment being graded. That is LOOKAHEAD, in
 * the evidence base the strategy is judged on, and it does not average out,
 * because it is one-sided: every horizon is answered with a price from the
 * future relative to that horizon.
 *
 * The price in force at the mark is what a desk could have transacted at. It
 * may be up to one grid interval old, and that is not an approximation of the
 * right answer — it IS the right answer. A price observed after the mark is
 * not a better version of it; it is the answer to a different question.
 *
 * Bounded on BOTH sides, and the lower bound is new:
 *
 *   · STRICTLY AFTER fired_at. If no capture arrived between the signal and
 *     the mark, the last one at or before the mark predates the signal — and
 *     grading forward movement against a pre-signal price measures nothing at
 *     all. It is also the exact price in signal_log.price, so every such row
 *     would grade as "no move": FROZEN right, the four 'down' families wrong,
 *     uniformly and invisibly. NOT COMPUTED.
 *   · NOT STALER than score_stale_tolerance_min before the mark, so a capture
 *     gap cannot answer the 5-minute question with a print from hours
 *     earlier.
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
async function priceInForceAt(symbol, from, minutes) {
  // symbol_minute FIRST — it is the finest grid, but it exists only for the 8–17
  // depth-slot symbols (signals.fast writes it). A WAKEUP fires on any of ~137
  // symbols, so for all but the slotted few symbol_minute has no row and the
  // forward price was never filled (1 of 15 WAKEUP rows). Fall back to the
  // board-wide awsat_market_quotes (~60 s, every symbol) so every signal gets a
  // forward price.
  //
  // Both are bounded the same way: the LAST capture at or before the mark, on
  // the SAME trading day, strictly after the signal fired, and no staler than
  // the tolerance. ORDER BY ... DESC is the whole change from the old rule;
  // the two bounds around it are what stop DESC finding something absurd.
  const { rows } = await query(
    `SELECT last_price FROM symbol_minute
      WHERE symbol = $1
        AND ts <= $2::timestamptz + ($3 || ' minutes')::interval
        AND ts >  $2::timestamptz
        AND ts >= $2::timestamptz + (($3::int - $5::int) || ' minutes')::interval
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
      ORDER BY ts DESC LIMIT 1`, [symbol, from, minutes, tradingDayOf(from), STALE_TOLERANCE_MIN],
  );
  if (rows.length) return Number(rows[0].last_price);
  const { rows: q } = await query(
    `SELECT last_price FROM awsat_market_quotes
      WHERE symbol = $1
        AND created_at <= $2::timestamptz + ($3 || ' minutes')::interval
        AND created_at >  $2::timestamptz
        AND created_at >= $2::timestamptz + (($3::int - $5::int) || ' minutes')::interval
        AND trading_date = $4::date
        AND last_price IS NOT NULL AND last_price > 0
      ORDER BY created_at DESC LIMIT 1`, [symbol, from, minutes, tradingDayOf(from), STALE_TOLERANCE_MIN],
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
    const px5 = await priceInForceAt(s.symbol, s.fired_at, 5);
    const px15 = await priceInForceAt(s.symbol, s.fired_at, 15);
    // px_60min is in the spec: a signal can be right at 5 minutes and wrong an
    // hour later, and only keeping both shows which.
    const px60 = await priceInForceAt(s.symbol, s.fired_at, 60);
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
/**
 * ─── C1 · RE-SCORING WHAT THE OLD RULE ALREADY GRADED ───────────────────────
 *
 * Changing priceInForceAt fixes signals scored from here on. It does nothing
 * for the rows already in signal_log: `score()` only looks at `scored_at IS
 * NULL`, so every existing grade keeps the lookahead price that produced it —
 * and those rows ARE the evidence base the strategy is judged on.
 *
 * This is the gap Amit named on 26 September from the other direction: a
 * threshold moved in code while every stored row kept the old verdict,
 * because nothing recomputes on an edit. "The code says X" and "the rows say
 * X" are different claims, and only the second one is the fix. So the rule
 * change ships WITH the re-score, not ahead of it.
 *
 * It CLEARS scored_at rather than recomputing in place, so the work goes
 * through exactly the path a nightly run takes — no second implementation of
 * the scoring rule that can drift from the first.
 *
 * Expect the totals to move, and expect some of them to move to NULL: a row
 * whose horizon is now NOT COMPUTED loses its was_right, because part of what
 * the log currently calls a graded outcome was never measurable. A smaller
 * denominator that means something beats a larger one that does not.
 */
async function rescoreAll(runId, { from = null } = {}) {
  const { rowCount } = await query(
    `UPDATE signal_log
        SET scored_at = NULL, was_right = NULL,
            px_5min = NULL, px_15min = NULL, px_60min = NULL
      WHERE ($1::date IS NULL OR trading_date >= $1::date)`, [from]);
  log.warn('scoring: RE-SCORE — clearing grades made under the pre-C1 rule, which '
    + 'read the first capture AFTER the mark and so graded against a price the '
    + 'mark could not have known', { rows: rowCount, from: from || 'all history' });
  const out = await scoreBackfill(runId);
  return { cleared: rowCount, ...out };
}

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

module.exports = {
  score, scoreBackfill, rescoreAll, scoringReport,
  priceInForceAt, grade, MODE, MIN_MOVE_FILS, STALE_TOLERANCE_MIN,
};

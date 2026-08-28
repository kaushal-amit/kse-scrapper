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

/** +1 expects a rise, -1 expects a fall, 0 has no directional claim. */
const DIRECTION = {
  BUYERS_8_5: 1,
  WALL_PULLED: 1,
  WAKEUP: 1,
  PREDAY: 0,
  NO_PROTECTION: -1,
  BID_EMPTY: -1,
  BAIT_BID: -1,
  WALL_PLACED: -1,
  FROZEN: 0,
};

const MIN_MOVE_FILS = Number(process.env.SCORE_MIN_MOVE_FILS || 1);

/**
 * The price a given number of minutes after a moment.
 *
 * The FIRST capture at or after the target, not the nearest — "the price five
 * minutes later" must not be satisfied by a print from four minutes later
 * because it happens to be closer.
 */
async function priceAfter(symbol, from, minutes) {
  const { rows } = await query(
    `SELECT last_price FROM symbol_minute
      WHERE symbol = $1 AND ts >= $2::timestamptz + ($3 || ' minutes')::interval
        AND last_price IS NOT NULL
      ORDER BY ts ASC LIMIT 1`, [symbol, from, minutes],
  );
  return rows.length ? Number(rows[0].last_price) : null;
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

    let wasRight = null;
    const dir = DIRECTION[s.signal];
    if (base !== null && px5 !== null && dir) {
      const move = (px5 - base) * dir;
      wasRight = move >= MIN_MOVE_FILS;
    }

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

module.exports = { score, priceAfter, DIRECTION, MIN_MOVE_FILS };

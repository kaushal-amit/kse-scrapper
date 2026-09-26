'use strict';
/**
 * ============================================================================
 *  D2/D3 · THE SHAPE OF THE SESSION'S CAPTURE, MEASURED ONCE PER DAY
 * ============================================================================
 * One question, asked of the raw quotes rather than of anything derived from
 * them: WHAT DID WE ACTUALLY SEE TODAY?
 *
 *   · when the first capture arrived, and the last Trading one
 *   · the longest run inside continuous trading with nothing at all
 *   · how many distinct session minutes were covered, out of 240
 *   · whether ANY Close-Of-Day row exists
 *
 * The last one is the load-bearing one and the reason this is not a
 * diagnostic. close_of_day_rows = 0 means the day has no official close, so
 * whatever symbol_day stores as close_px is a mid-session price and
 * close_source must say so. On 14 September the capture stopped at 11:59 and
 * symbol_day recorded the 11:59 prices as that day's closes under the label
 * TRADING_AT_LAST — a session that was never captured. 15 September's
 * prev_close is wrong on 108 of 134 symbols as a direct consequence.
 *
 * ─── MARKET-WIDE, NOT PER SYMBOL ───────────────────────────────────────────
 * One client scrapes the whole board, so capture dies for every symbol at the
 * same instant. Measuring the gap per symbol would store 137 copies of one
 * fact and give them 137 chances to disagree — which is what the dropped
 * symbol_day.largest_gap_secs would have done, had anything ever written it.
 * ============================================================================
 */
const { query } = require('../db/pool');
const { config } = require('../config');

/**
 * @returns {{first_capture_at, last_trading_capture_at, largest_gap_secs,
 *            largest_gap_at, close_of_day_rows, session_minutes_captured}}
 */
async function captureShape(day) {
  const open = config.market.sessionStartMinutes;
  const close = config.market.sessionEndMinutes;

  const { rows } = await query(
    `
    WITH q AS (
      SELECT created_at, session,
             (EXTRACT(hour FROM created_at AT TIME ZONE 'Asia/Kuwait') * 60
            + EXTRACT(minute FROM created_at AT TIME ZONE 'Asia/Kuwait'))::int AS mod
        FROM awsat_market_quotes
       WHERE trading_date = $1::date
    ),
    /*
     * THE GAP IS MEASURED ON DISTINCT CAPTURE INSTANTS, not on rows. ~137
     * symbols land per sweep with created_at within milliseconds of each
     * other; lag() over the rows would compare a symbol to its neighbour in
     * the same sweep and report every gap as zero.
     */
    sweeps AS (
      SELECT DISTINCT created_at, mod FROM q
       WHERE session = 'Trading' AND mod >= $2 AND mod <= $3
    ),
    stepped AS (
      SELECT created_at, mod,
             lag(created_at) OVER (ORDER BY created_at) AS prev_at
        FROM sweeps
    ),
    gaps AS (
      /*
       * The run from the OPEN to the first capture is a gap too — the 20
       * September shape, where nothing arrived until 10:11. Without this row
       * a session that started 71 minutes late reports its largest gap as
       * whatever happened afterwards, which on a clean afternoon is 60
       * seconds.
       */
      SELECT EXTRACT(epoch FROM (created_at - prev_at))::int AS secs, prev_at AS at
        FROM stepped WHERE prev_at IS NOT NULL
      UNION ALL
      SELECT ((SELECT min(mod) FROM sweeps) - $2) * 60,
             ($1::date + make_interval(mins => $2)) AT TIME ZONE 'Asia/Kuwait'
       WHERE EXISTS (SELECT 1 FROM sweeps)
      UNION ALL
      /*
       * And the run from the last capture to the CLOSE. 14 September stopped
       * at 11:59: without this row its largest gap is the ordinary 60 seconds
       * between two morning sweeps, and the hour of missing afternoon — the
       * entire defect — is invisible.
       */
      SELECT ($3 - (SELECT max(mod) FROM sweeps)) * 60,
             (SELECT max(created_at) FROM sweeps)
       WHERE EXISTS (SELECT 1 FROM sweeps)
    ),
    worst AS (
      SELECT secs, at FROM gaps WHERE secs IS NOT NULL ORDER BY secs DESC LIMIT 1
    )
    SELECT
      (SELECT min(created_at) FROM q)                                   AS first_capture_at,
      (SELECT max(created_at) FROM q WHERE session = 'Trading')         AS last_trading_capture_at,
      (SELECT secs FROM worst)                                          AS largest_gap_secs,
      (SELECT at   FROM worst)                                          AS largest_gap_at,
      (SELECT count(*)::int FROM q WHERE session = 'Close-Of-Day')      AS close_of_day_rows,
      (SELECT count(DISTINCT mod)::int FROM q
        WHERE session = 'Trading' AND mod >= $2 AND mod <= $3)          AS session_minutes_captured
    `, [day, open, close]);

  const r = rows[0] || {};
  return {
    first_capture_at: r.first_capture_at || null,
    last_trading_capture_at: r.last_trading_capture_at || null,
    /*
     * NULL, not 0, when there were no sweeps at all. A day with no capture
     * did not have a zero-second largest gap — that reads as a perfect
     * session, and it is the exact inversion of the truth.
     */
    largest_gap_secs: r.largest_gap_secs == null ? null : Number(r.largest_gap_secs),
    largest_gap_at: r.largest_gap_at || null,
    close_of_day_rows: Number(r.close_of_day_rows || 0),
    session_minutes_captured: Number(r.session_minutes_captured || 0),
  };
}

/** Total minutes in continuous trading — the denominator, 049's correction. */
function sessionMinutes() {
  return config.market.sessionEndMinutes - config.market.sessionStartMinutes;
}

module.exports = { captureShape, sessionMinutes };

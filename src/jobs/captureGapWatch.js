'use strict';
/**
 * ============================================================================
 *  D2 · NO TRADING CAPTURE FOR FIVE MINUTES, WHILE IT IS STILL HAPPENING
 * ============================================================================
 * Every capture failure this quarter was found afterwards, by someone
 * counting rows:
 *
 *     14 Sep  stopped 11:59   no close at all, and 15 Sep's prev_close is
 *                             wrong on 108 of 134 symbols because of it
 *     26 Aug  stopped 12:23   no close
 *     20 Sep  started 10:11   71 minutes of trading missed
 *     15 Sep  started 09:09   the open missed
 *
 * Nothing was watching WHILE the session ran. The heartbeat says a script is
 * alive; a script can be alive, logged in, and returning an empty grid.
 * scrape_runs says a job started and finished; both of those are true of a
 * run that inserted nothing. The only fact that settles it is whether ROWS
 * ARE STILL ARRIVING, and until now nothing asked.
 *
 * ─── WHY THE ALARM IS WORTH MORE THAN THE NIGHTLY REPORT ───────────────────
 * A gap detected at 11:59 on 14 September is recoverable: somebody restarts
 * the client and the close is captured. The same gap detected that night is a
 * permanent hole, and it propagates — 15 September inherited it. The value of
 * this job is entirely in the minutes, not in the record.
 *
 * ─── WHAT IT DOES NOT DO ───────────────────────────────────────────────────
 * It does not restart anything. A detector that also remediates hides the
 * frequency of the thing it is remediating, and the frequency is the finding.
 * ============================================================================
 */
const { query } = require('../db/pool');
const alarm = require('../db/alarm');
const clock = require('../market/clock');
const { config } = require('../config');
const T = require('../config/thresholds');
const log = require('../logger');

const ALARM = 'CAPTURE_GAP';

/** Minutes of day, Kuwait, for a Date. */
function minuteOfDay(d) {
  const p = clock.parts(d);
  return p.hour * 60 + p.minute;
}

/**
 * One check. Returns a description of what it found, so the suite can assert
 * on the decision rather than on a side effect.
 */
async function checkOnce({ now = clock.now(), day = null } = {}) {
  const trading = day || clock.tradingDay(now);
  const mod = minuteOfDay(now);

  /*
   * ONLY INSIDE CONTINUOUS TRADING. Before 09:00 there is nothing to miss —
   * pre-open capture is useful and its absence is not a data failure (049) —
   * and after 13:00 a quiet board is the market being closed. An alarm that
   * fires every evening is an alarm nobody reads by the second week.
   */
  const open = config.market.sessionStartMinutes;
  const close = config.market.sessionEndMinutes;
  if (mod < open || mod > close) {
    return { checked: false, why: 'outside continuous trading', mod, open, close };
  }

  // isTradingDay is synchronous and takes a Date, not a day string.
  if (!clock.isTradingDay(now)) {
    return { checked: false, why: 'not a trading day', day: trading };
  }

  const { rows } = await query(
    `SELECT max(created_at) AS last_at FROM awsat_market_quotes
      WHERE trading_date = $1::date AND session = 'Trading'`, [trading]);
  const lastAt = rows[0] && rows[0].last_at ? new Date(rows[0].last_at) : null;

  const limitSecs = T.get('capture_gap_alarm_secs');

  /*
   * NO CAPTURE AT ALL IS NOT A ZERO-SECOND GAP.
   *
   * On 20 September the first capture was 10:11, so between 09:00 and 10:11
   * `max(created_at)` was NULL. Treating NULL as "no gap" is precisely the
   * failure that let those 71 minutes pass unremarked — the quiet case and
   * the broken case look identical from the outside, and only the clock
   * separates them. Measure from the OPEN instead.
   */
  const sinceSecs = lastAt === null
    ? (mod - open) * 60
    : Math.round((now.getTime() - lastAt.getTime()) / 1000);

  if (sinceSecs < limitSecs) {
    return { checked: true, ok: true, sinceSecs, limitSecs, lastAt };
  }

  /*
   * Once per episode, not once per minute. A five-minute outage that runs an
   * hour would otherwise write 55 rows, and the row that matters — the first
   * one — becomes the hardest to find.
   */
  if (await alarm.alreadyRaised(trading, ALARM, { sinceMinutes: Math.ceil(limitSecs / 60) * 2 })) {
    return { checked: true, ok: false, sinceSecs, suppressed: true, lastAt };
  }

  const detail = lastAt === null
    ? `NO Trading capture at all today, and continuous trading opened `
      + `${Math.round(sinceSecs / 60)} minutes ago. This is the 20 September shape — `
      + 'the board is being scraped into nothing and every minute lost is lost for good.'
    : `No Trading capture for ${Math.round(sinceSecs / 60)} minutes (last at `
      + `${lastAt.toISOString()}). Continuous trading is open. If this is a stop rather `
      + 'than a pause, the close will be missed, and tomorrow\'s prev_close with it — '
      + '14 September stopped at 11:59 and 15 September was wrong on 108 of 134 symbols.';

  /*
   * `raised` REPORTS THE WRITE, NOT THE INTENT.
   *
   * The first version of this line returned `raised: true` unconditionally,
   * having ignored what raise() returned — so a failed insert (the detail
   * column is jsonb; a bare string is rejected) reported a raised alarm that
   * did not exist. Caught by this job's own suite on the first run, which is
   * the only reason it is not in the same list as the other four.
   *
   * It is the week's defect class committed while fixing the week's defect
   * class: declared, with nothing checking it arrived.
   */
  const written = await alarm.raise({
    day: trading, table: 'awsat_market_quotes', alarm: ALARM, detail,
  });
  log.error('CAPTURE GAP', { day: trading, sinceSecs, limitSecs, lastAt, written });
  return { checked: true, ok: false, sinceSecs, limitSecs, raised: written, lastAt };
}

/** The job entry point. Never throws — a watchdog that can die is not one. */
async function captureGapWatch() {
  try {
    const r = await checkOnce();
    return { extracted: r.checked ? 1 : 0, inserted: r.raised ? 1 : 0, rejected: 0 };
  } catch (e) {
    log.error('capture gap watch failed', { error: e.message });
    return { extracted: 0, inserted: 0, rejected: 0 };
  }
}

module.exports = { captureGapWatch, checkOnce, ALARM };

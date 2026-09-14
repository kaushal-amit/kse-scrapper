'use strict';
/**
 * The scheduler: fires every minute, and runs the enabled jobs only inside the
 * trading window.
 *
 * ─── WHY THE WINDOW IS CHECKED TWICE ───────────────────────────────────────
 * node-cron is given a Kuwait timezone AND a day-of-week restriction, so the
 * tick itself does not arrive outside the window. `clock.isWithinWindow()` is
 * then checked again inside the handler.
 *
 * That is deliberate belt-and-braces. The cron expression and the config are
 * two separate statements of the same rule, and if they ever disagree — someone
 * edits START_TIME but the cron string is built from a stale value, a process
 * survives across midnight, a container's clock jumps — the explicit check is
 * the one that decides. The rule that matters is the one in clock.js; cron is
 * only an optimisation that avoids waking up pointlessly.
 *
 * ─── STAGGERED SECONDS ─────────────────────────────────────────────────────
 * The jobs do not all fire at :00. They share one browser and are serialised,
 * so starting together would just queue them; spreading them out means each
 * gets a clear slot and the minute's data is captured closer to the moment it
 * was meant to represent.
 */

const cron = require('node-cron');
const { config } = require('./config');
const clock = require('./market/clock');
const jobs = require('./jobs');
const log = require('./logger');

/**
 * Second-of-minute for each job. Depth is given :30 because it is the longest
 * running, and orders :45 so it lands after the board it relates to.
 */
const OFFSETS = {
  'tradingview.quotes': 5,
  'awsat.board': 15,
  'awsat.depth': 30,
  'awsat.orders': 45,
};


/**
 * Jobs that run OUTSIDE the trading window, each on its own cron.
 *
 *   tradingview.history  17:00 — after the session, finalises the day's bars
 *   daily.analysis       08:15 — before the next session, analyses YESTERDAY
 *
 * Both are guarded: they refuse to run inside the window, so a mistimed cron
 * cannot analyse a half-finished day and store it as final.
 */
/**
 * S8 · THE AFTER-CLOSE TIMES ARE DERIVED FROM END_TIME, NOT WRITTEN DOWN.
 *
 * They used to be literal hours — `0 25 13`, `0 30 13`, `0 40 13` — with only
 * the weekday list taken from config. A hardcoded after-close hour is wrong the
 * moment END_TIME moves: set END_TIME=14:00 and 13:25, 13:30 and 13:40 all fall
 * INSIDE the window, the after-close guard rejects them at every tick, and
 * symbol_day and market_day simply stop being computed — silently, because a
 * guard doing its job looks exactly like a job that was never scheduled.
 *
 * `defaultHistoryCron()` was written to fix this and never called (S13). This
 * is the fix: an offset in minutes past the close, resolved against
 * config.market.endMinutes, so the chain follows the window automatically.
 *
 *   +1   daily.instruments  the registry, BEFORE symbolday — the day's rows
 *                           must be computed against a correct registry, not
 *                           yesterday's.
 *   +5   daily.symbolday    after Close-Of-Day; earlier would compute a close
 *                           from a session that has not closed.
 *   +12  daily.marketday    reads symbol_day, so it must not race it.
 *
 * tradingview.history (17:00) and signals.score (17:45) stay on absolute
 * clocks: they wait for the venue's own settlement and for the +15-minute
 * forward prices, neither of which moves with our capture window. daily.analysis
 * runs the NEXT morning. All three are still overridable, and all three are
 * still checked against the window at startup.
 */
function afterClose(minutesPastEnd) {
  const total = config.market.endMinutes + minutesPastEnd;
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `0 ${m} ${h} * * ${config.market.tradingDays.join(',')}`;
}

const AFTER_CLOSE_JOBS = {
  'tradingview.history': process.env.HISTORY_CRON
    || `0 0 17 * * ${config.market.tradingDays.join(',')}`,
  'daily.analysis': process.env.ANALYSIS_CRON
    || `0 15 8 * * ${config.market.tradingDays.join(',')}`,
  'daily.instruments': process.env.INSTRUMENTS_CRON || afterClose(1),
  'daily.symbolday': process.env.SYMBOLDAY_CRON || afterClose(5),
  'daily.marketday': process.env.MARKETDAY_CRON || afterClose(12),
  'signals.score': process.env.SCORE_CRON
    || `0 45 17 * * ${config.market.tradingDays.join(',')}`,
};

const tasks = [];

/**
 * Cron expression for one job.
 *
 * Six fields: second minute hour day month weekday. The hour range and the
 * weekday list come from config, so changing START_TIME or TRADING_DAYS moves
 * the schedule without touching this file.
 *
 * The hour range is inclusive of the end hour on purpose: with END_TIME 13:00
 * the ticks at 13:00-13:59 still fire, and isWithinWindow() rejects them. That
 * costs one wake-up a minute and keeps the truth in exactly one place.
 */
/**
 * Jobs that run MORE THAN ONCE A MINUTE.
 *
 * The Step 3 list says 15-20 seconds for the fast loop; 20 is chosen. The
 * checks compare CONSECUTIVE symbol_minute rows, so the loop must not outrun
 * the client writing them — re-evaluating the same pair yields no signal but
 * costs a full pass over every slotted symbol.
 */
/*
 * S8 · the SIGNAL jobs stop at SIGNALS_END_TIME, not at END_TIME.
 *
 * Capture runs to the close because the closing prints are data. These two do
 * not: they raise alerts a human is expected to act on, and there is no acting
 * on one raised at 13:29 when continuous trading ends at 13:30. The last half
 * hour is captured and not alerted on.
 */
const SIGNAL_END_HOUR = Math.ceil(config.market.signalsEndMinutes / 60) - 1;

const SUB_MINUTE_JOBS = {
  // Every 15 minutes over all 137, from the quotes grid. It needs no depth, so
  // it never competes for the 8 slots.
  'signals.wakeup': process.env.WAKEUP_CRON
    || `0 */15 ${Math.floor(config.market.startMinutes / 60)}`
       + `-${SIGNAL_END_HOUR} * * ${config.market.tradingDays.join(',')}`,
  'signals.fast': process.env.FAST_LOOP_CRON
    || `*/20 * ${Math.floor(config.market.startMinutes / 60)}`
       + `-${SIGNAL_END_HOUR} * * ${config.market.tradingDays.join(',')}`,
};

/** The signal jobs' own window check — the hour range alone is too coarse. */
const SIGNAL_JOBS = new Set(['signals.wakeup', 'signals.fast']);

function expressionFor(second) {
  const startHour = Math.floor(config.market.startMinutes / 60);
  // endMinutes - 1 because the window is half-open: with END_TIME 13:00 the last
  // minute that can run is 12:59, so hour 13 need never be woken at all. Using
  // endMinutes directly costs 60 pointless wake-ups every trading day.
  const endHour = Math.floor((config.market.endMinutes - 1) / 60);
  const days = config.market.tradingDays.join(',');
  return `${second} * ${startHour}-${endHour} * * ${days}`;
}

function start() {
  const enabled = config.scrapers.enabled.filter((name) => {
    if (jobs.JOBS[name]) return true;
    log.warn('ignoring unknown scraper in ENABLED_SCRAPERS', { name, known: jobs.jobNames });
    return false;
  });

  if (!enabled.length) {
    log.warn('no scrapers enabled — nothing will be collected');
    return;
  }

  // After-close jobs first: they use their own expression and their own guard.
  for (const name of enabled.filter((n) => AFTER_CLOSE_JOBS[n])) {
    const expression = AFTER_CLOSE_JOBS[name];

    const task = cron.schedule(expression, () => {
      // Not the window guard — this job exists precisely because the window has
      // closed. What still matters is that it is a trading day (no Friday or
      // Saturday run) and that the session really is over, so a mistimed cron
      // cannot scrape a half-finished day and store it as final.
      if (!clock.isTradingDay()) return;
      if (clock.isWithinWindow()) {
        log.warn('after-close job fired while the market is still open — skipping', {
          job: name, status: clock.windowStatus(),
        });
        return;
      }

      jobs.run(name).catch((err) => {
        log.error('unhandled after-close job error', { job: name, err: log.serializeError(err) });
      });
    }, { scheduled: true, timezone: config.market.timezone });

    // An explicit HISTORY_CRON inside the window would be rejected on every
    // tick by the guard above, so say so at startup rather than at 13:30.
    const m = /^\S+\s+(\d+)\s+(\d+)\s/.exec(expression);
    if (m) {
      const at = Number(m[2]) * 60 + Number(m[1]);
      if (at >= config.market.startMinutes && at < config.market.endMinutes) {
        log.error('after-close job is scheduled INSIDE the trading window — it '
          + 'will be skipped every day', {
          job: name, expression,
          window: `${config.market.startTime}-${config.market.endTime}`,
          fix: 'set HISTORY_CRON after END_TIME, or unset it to use the default',
        });
      }
    }

    tasks.push(task);
    log.info('scheduled (after close)', { job: name, expression, timezone: config.market.timezone });
  }

  for (const name of enabled.filter((n) => !AFTER_CLOSE_JOBS[n])) {
    // Jobs with their OWN cadence override the once-a-minute default. The fast
    // loop compares consecutive snapshots, so a minute between ticks would make
    // every comparison a minute wide and the checks would describe a different
    // market from the one they were designed for.
    const second = OFFSETS[name] ?? 0;
    const expression = SUB_MINUTE_JOBS[name] || expressionFor(second);

    const task = cron.schedule(expression, () => {
      // The authoritative check. See the note at the top of the file.
      if (!clock.isWithinWindow()) return;

      /*
       * The cron hour range can only stop at an hour boundary, so with
       * SIGNALS_END_TIME=13:00 the range ends at hour 12 and this is redundant —
       * but with 13:15 it would fire until 13:59. The minute check is what
       * actually holds the rule.
       */
      if (SIGNAL_JOBS.has(name) && !clock.isBeforeSignalsEnd()) return;

      // Fire and forget: awaiting here would hold the cron callback and delay
      // the next tick behind a slow scrape.
      jobs.run(name).catch((err) => {
        log.error('unhandled job error', { job: name, err: log.serializeError(err) });
      });
    }, {
      scheduled: true,
      timezone: config.market.timezone,
    });

    tasks.push(task);
    log.info('scheduled', { job: name, expression, timezone: config.market.timezone });
  }

  // A heartbeat once an hour, so a process that is correctly idle (weekend,
  // out of hours) still shows it is alive and explains why it is quiet.
  const heartbeat = cron.schedule('0 0 * * * *', () => {
    log.info('heartbeat', clock.windowStatus());
  }, { scheduled: true, timezone: config.market.timezone });
  tasks.push(heartbeat);

  log.info('scheduler started', {
    jobs: enabled,
    window: `${config.market.startTime}-${config.market.endTime}`,
    timezone: config.market.timezone,
    tradingDays: config.market.tradingDays,
  });
}

function stop() {
  for (const t of tasks) {
    try { t.stop(); } catch { /* already stopped */ }
  }
  tasks.length = 0;
  log.info('scheduler stopped');
}

module.exports = { start, stop, expressionFor, AFTER_CLOSE_JOBS, SUB_MINUTE_JOBS, afterClose };

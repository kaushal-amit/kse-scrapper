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
  /*
   * +8 · symbol_minute_sample. It reads public.quotes_clean and the depth
   * captures, so it does NOT depend on symbol_day and could run alongside it —
   * but it is placed between symbolday (+5) and marketday (+12) because
   * marketday runs the column-coverage check last, and a derive that lands
   * after that check would not be seen by it until the next session.
   */
  'daily.minutesample': process.env.MINUTESAMPLE_CRON || afterClose(8),
  'daily.marketday': process.env.MARKETDAY_CRON || afterClose(12),
  'signals.score': process.env.SCORE_CRON
    || `0 45 17 * * ${config.market.tradingDays.join(',')}`,
};

/**
 * ============================================================================
 *  THE AFTER-CLOSE JOBS ARE SPACED ON THE CLOCK. ONE OF THEM MUST BE CHAINED.
 * ============================================================================
 * 13:31 -> 13:35 -> 13:38 -> 13:42 are four independent cron entries. Each
 * fires at its time and runs, whatever the one before it is doing. Four
 * minutes is enough on a normal day, and a backfill range or a slow session is
 * not a normal day: daily.symbolday over several dates overruns, and
 * daily.marketday starts anyway and aggregates a symbol_day that is still
 * being written.
 *
 * That is the same drift the market_day fingerprint was built for — sixteen
 * days of thin_symbols disagreeing with the symbol_day they count — arriving
 * through the scheduler instead of through a stale recompute. The fingerprint
 * DETECTS it afterwards. This prevents it.
 *
 * ─── ONLY ONE EDGE IS REAL, AND DECLARING MORE WOULD BE WORSE ─────────────
 *
 * daily.marketday reads symbol_day, so it waits for daily.symbolday.
 *
 * Nothing else here does:
 *   daily.minutesample  reads public.quotes_clean and the depth captures, not
 *                       symbol_day. It CANNOT aggregate an incomplete
 *                       symbol_day, so chaining it would serialise a job that
 *                       does not care and let a slow symbolday delay it for no
 *                       reason.
 *   daily.instruments   symbol metadata, independent.
 *   daily.analysis      reads tradingview_watchlist (checked), and runs the
 *                       next morning regardless.
 *   tradingview.history, signals.score  their own absolute clocks and their
 *                       own inputs.
 *
 * A false dependency costs as much as a missing one: it makes a job look
 * blocked when nothing is wrong, and the next person deletes the gate rather
 * than the edge.
 *
 * ─── WHAT COUNTS AS DONE ──────────────────────────────────────────────────
 *
 * A SUCCESS row in scrape_runs for that job and that trading day. Not "the
 * process is not running" — that is true before it starts as well as after it
 * finishes, and this whole file exists because those two were confused.
 *
 * A blocked job is SKIPPED and recorded, so it is visible in scrape_runs
 * rather than only in a log, and the catch-up picks it up on its next tick
 * once the predecessor lands. A skip that leaves no trace is the defect this
 * scheduler already fixed once.
 */
const AFTER_CLOSE_REQUIRES = {
  'daily.marketday': 'daily.symbolday',
};

async function predecessorDone(name, day) {
  const needs = AFTER_CLOSE_REQUIRES[name];
  if (!needs) return { ok: true, needs: null };
  const { pool } = require('./db/pool');
  try {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM scrape_runs
        WHERE scraper = $1 AND trading_date = $2 AND status = 'SUCCESS';`, [needs, day]);
    return { ok: Number(rows[0] && rows[0].n) > 0, needs };
  } catch (e) {
    /*
     * A read that FAILED is not "the predecessor finished". Treated as NOT
     * done, so the job waits and the catch-up retries — the same rule the
     * catch-up applies to its own probe, and the opposite of the silence this
     * file keeps removing.
     */
    log.warn('could not check whether the predecessor had finished — treating it as not done',
      { job: name, needs, day, err: e.message });
    return { ok: false, needs, unread: true };
  }
}

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


/**
 * Record a skipped after-close job in scrape_runs.
 *
 * Best-effort and never throws: the skip is still correct if it cannot be
 * recorded, and swallowing the REASON is how a diagnostic disappears — so a
 * failure to record says so in the log, exactly as the lock skip does.
 */

/*
 * The after-close jobs whose OUTPUT can be checked, and how to check it. A job
 * is "done" when its row exists for the day — not when a cron fired, and not
 * when a Set in memory says so, because neither survives a restart.
 */
const CATCH_UP_JOBS = {
  'daily.symbolday': {
    sql: 'SELECT count(*)::int AS n FROM symbol_day WHERE trading_date = $1',
    what: 'the day\'s per-symbol statistics',
  },
  'daily.minutesample': {
    sql: 'SELECT count(*)::int AS n FROM symbol_minute_sample WHERE trading_date = $1',
    what: 'the day\'s minute-by-minute board samples',
  },
  'daily.marketday': {
    sql: 'SELECT count(*)::int AS n FROM market_day WHERE trading_date = $1',
    what: 'the day\'s market breadth row',
  },
  /*
   * ─── signals.score, AND WHY IT NEEDED THE notBefore RULE FIRST ───────────
   *
   * Scoring missed 24 September and nobody noticed until the rows were
   * counted by hand. It belongs here — but adding it naively would have made
   * scoring WORSE, not better.
   *
   * The catch-up fires as soon as it sees a job's rows missing after the
   * CLOSE (13:30). signals.score is scheduled at 17:45 on an absolute clock,
   * because it needs the +15 and +60 minute forward prices that do not exist
   * yet. A catch-up at 13:31 would have run it four hours early, scored every
   * signal against prices that had not happened, and then found rows present
   * and never run it again.
   *
   * So the loop now refuses to run any job before its OWN scheduled time,
   * read from AFTER_CLOSE_JOBS rather than restated here.
   *
   * `n` is the count of SCORED rows, not of signals: a day where scoring never
   * ran has zero. It stays >0 for a partially scored day, which is correct —
   * every session leaves 150-270 signals unscorable because they fired too
   * close to the bell for a forward price, so "fully scored" is not a state
   * that exists.
   */
  'signals.score': {
    sql: 'SELECT count(*)::int AS n FROM signal_log '
       + 'WHERE trading_date = $1 AND was_right IS NOT NULL',
    what: 'the day\'s signal outcomes',
  },
};

/**
 * The minute of day a job is actually scheduled for, from its own cron.
 *
 * Read from AFTER_CLOSE_JOBS rather than restated, so a job whose schedule
 * moves takes its catch-up floor with it. A six-field cron is
 * `sec min hour dom mon dow`; anything this cannot parse returns null and the
 * caller falls back to the old behaviour rather than blocking the catch-up on
 * a parse it did not understand.
 */
function scheduledMinuteOfDay(name) {
  const expr = AFTER_CLOSE_JOBS[name];
  if (!expr) return null;
  const f = String(expr).trim().split(/\s+/);
  if (f.length < 3) return null;
  const m = Number(f[1]); const h = Number(f[2]);
  if (!Number.isInteger(m) || !Number.isInteger(h)) return null;
  return h * 60 + m;
}

/*
 * Minutes past the close before the catch-up gives up and raises an alarm.
 * From the threshold store, never a literal here: this file's own lint rule
 * is that a number deciding a gate lives in src/config/thresholds.js.
 */
const { THRESHOLDS } = require('./config/thresholds');
const CATCH_UP_GIVE_UP_MINS = THRESHOLDS.catchup_give_up_mins;

const gaveUp = new Set();   // `${day} ${job}` — one alarm per job per day

async function catchUpAfterClose(enabled) {
  if (!clock.isTradingDay() || clock.isWithinWindow()) return;
  const day = clock.tradingDay();
  const { pool } = require('./db/pool');
  // clock.parts() is the one place a Kuwait minute-of-day is derived; deriving
  // it here would be a second clock, which is the defect this codebase keeps
  // removing from its own schedulers.
  const pastClose = clock.parts().minutesOfDay - config.market.endMinutes;

  for (const name of Object.keys(CATCH_UP_JOBS)) {
    if (!enabled.includes(name)) continue;
    /*
     * NEVER BEFORE THE JOB'S OWN TIME. signals.score runs at 17:45 because it
     * needs forward prices that do not exist at 13:31; running it early does
     * not catch it up, it scores the day against prices that had not happened
     * and then looks done. See the note on that entry.
     */
    const due = scheduledMinuteOfDay(name);
    if (due != null && clock.parts().minutesOfDay < due) continue;
    // ...and never ahead of its predecessor. The catch-up exists to run a job
    // that did not, and running marketday before symbolday lands would produce
    // exactly the wrong rows it is trying to restore.
    // eslint-disable-next-line no-await-in-loop
    const pre = await predecessorDone(name, day);
    if (!pre.ok) continue;
    const spec = CATCH_UP_JOBS[name];
    let n;
    try {
      const { rows } = await pool.query(spec.sql, [day]);
      n = Number(rows[0] && rows[0].n);
    } catch (err) {
      /*
       * A read that FAILED is not "the rows are there". It is logged and the
       * job is left for the next tick — never treated as done, which would be
       * the same silence this whole block exists to remove.
       */
      log.warn('catch-up could not check whether the job had run', { job: name, day, err: err.message });
      continue;
    }
    if (n > 0) continue;

    const key = `${day} ${name}`;
    if (pastClose > CATCH_UP_GIVE_UP_MINS) {
      if (!gaveUp.has(key)) {
        gaveUp.add(key);
        log.error('NIGHTLY JOB STILL MISSING — giving up and raising an alarm', {
          job: name, day, what: spec.what, minutesPastClose: pastClose,
          note: 'the catch-up has been retrying since the close and the rows are still not there',
        });
        await raiseMissingAlarm(name, day, spec.what, pastClose).catch((e) => log.warn('could not raise the alarm', { err: e.message }));
      }
      continue;
    }

    log.warn('CATCH-UP · the nightly job has not run for this day — running it now', {
      job: name, day, what: spec.what,
      note: 'a missed cron tick is not replayed, so the table is what decides',
    });
    // jobs.run records the attempt, takes the advisory lock and reports its own
    // failure; nothing here needs to interpret it.
    // eslint-disable-next-line no-await-in-loop
    await jobs.run(name).catch((err) => {
      log.error('the catch-up run failed', { job: name, day, err: log.serializeError(err) });
    });
  }
}

/** A day whose statistics never arrived is a data alarm, not a log line. */
async function raiseMissingAlarm(job, day, what, minutesPastClose) {
  const { pool } = require('./db/pool');
  await pool.query(
    `INSERT INTO data_alarm (trading_date, table_name, alarm, detail)
     VALUES ($1, $2, 'NIGHTLY_JOB_MISSING', $3)
     ON CONFLICT DO NOTHING;`,
    [day, job.replace('daily.', ''), JSON.stringify({
      job, what, minutesPastClose,
      note: 'the cron did not fire and the catch-up could not produce the rows either. '
        + 'The board for this day has a hole in it until this is run by hand.',
    })]).catch((e) => {
    // The alarm table belongs to the scraper's own schema; a host without it
    // still gets the log line above, which is the part that cannot be lost.
    log.warn('data_alarm insert failed', { job, day, err: e.message });
  });
}

function recordSkip(name, reason) {
  (async () => {
    try {
      const repo = require('./db/repositories');
      const id = await repo.startRun(name, clock.tradingDay());
      await repo.finishRun(id, { status: 'SKIPPED', startedAt: Date.now(), error: new Error(reason) });
    } catch (e) {
      log.warn('could not record the after-close skip', { job: name, err: e.message });
    }
  })();
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
        /*
         * ─── A SKIP THAT LEFT NO TRACE ANYWHERE BUT A LOG ────────────────────
         *
         * On 24 September daily.symbolday and daily.marketday produced NO ROW
         * IN scrape_runs — not SUCCESS, not FAILED, not SKIPPED — while every
         * prior session has both. A skip here returned before any row was
         * opened, so the only evidence a nightly job had stopped was a row that
         * was not there, six hours later, in a different table.
         *
         * That is this repository's own rule broken in its own scheduler: the
         * advisory-lock skip forty lines below is recorded precisely so "the
         * skip is VISIBLE in scrape_runs rather than silent". This one was not.
         *
         * It matters most in exactly the case that fires it: the guard rejects
         * an after-close job that falls INSIDE the window, which is what
         * happens the moment END_TIME moves — and the comment at the top of
         * this file already warns that then "symbol_day and market_day simply
         * stop being computed, silently, because a guard doing its job looks
         * exactly like a job that was never scheduled".
         */
        log.warn('after-close job fired while the market is still open — skipping', {
          job: name, status: clock.windowStatus(),
        });
        recordSkip(name, `fired at ${clock.windowStatus()} — an after-close job inside the `
          + `trading window is skipped every day it fires. Move ${name === 'daily.symbolday' ? 'SYMBOLDAY_CRON' : name === 'daily.marketday' ? 'MARKETDAY_CRON' : 'its cron'} `
          + `after END_TIME (${config.market.endTime}), or unset it to use the default`);
        return;
      }

      (async () => {
        const day = clock.tradingDay();
        const pre = await predecessorDone(name, day);
        if (!pre.ok) {
          log.warn('after-close job BLOCKED — its predecessor has not finished this day', {
            job: name, waitingFor: pre.needs, day,
            note: pre.unread
              ? 'the check itself could not be read, which is not the same as done'
              : 'spacing on the clock is not sequencing; the catch-up will run this once '
                + 'the predecessor records SUCCESS',
          });
          recordSkip(name, `blocked: ${pre.needs} has no SUCCESS row for ${day}. Four minutes `
            + 'of clock spacing is not a dependency, and aggregating a symbol_day that is '
            + 'still being written is how market_day and symbol_day disagreed for sixteen days');
          return;
        }
        await jobs.run(name);
      })().catch((err) => {
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

  /*
   * ─── THE CATCH-UP · A MISSED NIGHTLY JOB REPAIRS ITSELF ────────────────────
   *
   * node-cron does not replay a tick that was missed. So a restart across
   * 13:30 — a deploy, a container reclaim, a crash — loses symbol_day and
   * market_day for that day PERMANENTLY, and nothing says so until someone
   * reads a board with a hole in it days later. That is what happened on 24
   * September: daily.analysis ran at 08:15, the two after-close jobs left no
   * row at all, and the session's statistics were simply absent.
   *
   * A cron is a good way to start a job on time and a bad way to guarantee it
   * ran. So the clock is no longer the only thing that decides: every ten
   * minutes after the close, on a trading day, this asks the TABLE whether the
   * day's rows exist and runs whichever is missing. Due-from-onward,
   * done-when-the-table-says-so — the same shape the trading backend uses for
   * the same class of job, and for the same reason.
   *
   * It is cheap and idempotent: the advisory lock in jobs.run() already stops
   * two processes computing the same rows, and a day that is already computed
   * costs one COUNT(*) per job per ten minutes.
   *
   * Past CATCHUP_GIVE_UP_MINUTES it stops trying and raises a data alarm
   * instead, because a job that has failed for four hours is not a job that
   * needs another attempt — it is a job somebody has to look at.
   */
  if (enabled.some((n) => CATCH_UP_JOBS[n])) {
    const catchUp = cron.schedule('0 */10 * * * *', () => {
      catchUpAfterClose(enabled).catch((err) => {
        log.error('the nightly catch-up failed', { err: log.serializeError(err) });
      });
    }, { scheduled: true, timezone: config.market.timezone });
    tasks.push(catchUp);
    log.info('scheduled', { job: 'daily.catchup', expression: '0 */10 * * * *',
      watches: Object.keys(CATCH_UP_JOBS).filter((n) => enabled.includes(n)) });
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

module.exports = { start, stop, expressionFor, AFTER_CLOSE_JOBS, SUB_MINUTE_JOBS, afterClose,
  AFTER_CLOSE_REQUIRES, predecessorDone };

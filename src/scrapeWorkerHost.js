'use strict';
/**
 * Running scrapers OFF the main thread.
 *
 * ─── WHY ───────────────────────────────────────────────────────────────────
 * The main thread owns the scheduler and the database pool. A scrape is a long
 * task driving a browser, parsing a few hundred rows, and occasionally hanging
 * on a page that never settles. Anything that blocks or crashes while doing
 * that takes the scheduler down with it, and a scheduler that dies at 09:12
 * loses the rest of the session silently.
 *
 * So each scrape runs in a worker thread. The worker does the browser work and
 * the parsing and hands back plain objects; the main thread keeps the schedule
 * and does every database write. A hung scrape can then be terminated without
 * touching anything else.
 *
 * ─── ONE PERSISTENT WORKER PER SOURCE, NOT ONE PER RUN ─────────────────────
 * Spawning a worker per minute would mean launching Chromium per minute — and
 * for AWSAT it would mean LOGGING IN per minute, against a terminal that locks
 * the account after a few attempts a day. That single constraint decides the
 * design: one worker per source, kept alive, reused, holding one browser and
 * one session.
 *
 * Terminating an AWSAT worker therefore costs a login. It happens only on a
 * hard timeout, and it says so in the log.
 */

const path = require('path');
const { Worker } = require('worker_threads');
const log = require('./logger');

const WORKER_FILE = path.join(__dirname, 'scrapeWorker.js');

/** job name -> which source's worker owns it. */
const SOURCE_OF = {
  'tradingview.quotes': 'tradingview',
  'tradingview.backfill': 'tradingview',
  'awsat.board': 'awsat',
  'awsat.depth': 'awsat',
  'awsat.orders': 'awsat',
};

/**
 * Per-job timeouts. A depth sweep walks several symbols, so it is given longer.
 * Beyond this the worker is assumed hung and is terminated.
 */
const TIMEOUT_MS = {
  /*
   * P6-TV-6 · LONGER THAN THE SCRAPE'S OWN WORST CASE.
   *
   * tradingview.quotes budgets goto 60s + settle 2s + waitForSelector 30s +
   * a 90s scroll deadline (TV_SCRAPE_TIMEOUT_MS) ≈ 185s, against a 120s kill.
   * On a slow morning the worker was terminated while the page was working:
   * Chromium died, the run was recorded FAILED, and the next minute paid for a
   * relaunch. The kill is the LAST resort and must sit above the budget the
   * job gives itself, not inside it.
   */
  'tradingview.quotes': 240_000,
  // One chart page per symbol; this is a long job by nature, not a hung one.
  'tradingview.backfill': 45 * 60_000,
  // Login alone measured ~65s on the live terminal; two market sweeps follow.
  // At 120s the timeout fired mid-login, killed the worker and threw away the
  // session — which then blocked every other AWSAT job behind the cooldown.
  'awsat.board': 300_000,
  'awsat.depth': 300_000,
  'awsat.orders': 180_000,
};

const workers = new Map();      // source -> { worker, pending, queue, inFlight, nextId }

/**
 * Raised when a job never got to run. NOT a failure — the scraper was never
 * asked to do anything, so recording it as FAILED would inflate the failure
 * count and fire alerts for a queue working exactly as intended.
 */
class SkippedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SkippedError';
    this.skipped = true;
  }
}

/**
 * How long a queued job may wait before it is no longer worth running.
 *
 * S2 · A WALL-CLOCK DEADLINE, NEVER BELOW THE BLOCKING JOB'S OWN TIMEOUT.
 *
 * This used to be a flat 60 s — the job's own cadence, on the reasoning that a
 * one-minute scraper starting ninety seconds late stamps its rows with a minute
 * that has already passed. That reasoning is right, and the number was set
 * without reference to the 300 s timeout on the SAME SHARED BROWSER.
 *
 * The three AWSAT jobs are serialised behind one browser. Login alone measures
 * ~65 s on the live terminal, so a board run of ~90 s is the normal case — and
 * anything queued behind it was already past a 60 s deadline before pump() even
 * looked at it. Both queued jobs were then rejected as SkippedError, which by
 * design does not count toward consecutive_failures. Every minute, for four
 * hours: awsat_stock_depth and the order list received ZERO rows for a whole
 * session, with no alarm anywhere. (Review F-03.)
 *
 * So the floor is the blocking job's own timeout plus a margin. A queued job
 * that waits that long has genuinely lost its minute; one that waits 70 s
 * behind a normal login has not.
 */
const QUEUE_MARGIN_MS = 5 * 60_000;

/*
 * Jobs that are long BY NATURE, not by malfunction. They are exempt from the
 * staleness rule themselves, and they do not raise the floor for their
 * neighbours: a quotes tick queued behind a 45-minute backfill genuinely HAS
 * lost its minute, and the next tick will capture the current one properly.
 * Cancelling it is right. The floor exists to stop a NORMAL job being cancelled
 * for waiting less than the job in front of it is allowed to take.
 */
const LONG_JOBS = new Set(['tradingview.backfill']);

function staleAfterMs(job, source) {
  // Runs once, and has no minute to be late for.
  if (LONG_JOBS.has(job)) return 6 * 60 * 60_000;

  const configured = Number(process.env.SCRAPE_STALE_AFTER_MS) || 60_000;

  /*
   * The floor: the longest a job on this browser may RUN, plus the margin. Any
   * shorter and the queue cancels work for being late by less than the thing in
   * front of it is allowed to take — which is not a staleness rule, it is a
   * guarantee that the second job never runs.
   */
  const longestOnThisBrowser = Math.max(
    0,
    ...Object.entries(TIMEOUT_MS)
      .filter(([j]) => SOURCE_OF[j] === source && !LONG_JOBS.has(j))
      .map(([, ms]) => ms),
  );
  const floor = longestOnThisBrowser ? longestOnThisBrowser + QUEUE_MARGIN_MS : 0;

  if (configured < floor) {
    warnOnce(`queue-stale-${source}`,
      'SCRAPE_STALE_AFTER_MS is shorter than the longest job on this browser can run — '
      + 'raising it, or a queued job could never start',
      { source, configured, longestOnThisBrowser, using: floor });
    return floor;
  }
  return configured;
}

const _warned = new Set();
function warnOnce(key, message, data) {
  if (_warned.has(key)) return;
  _warned.add(key);
  log.warn(message, data);
}

function spawn(source) {
  const worker = new Worker(WORKER_FILE, { workerData: { source } });
  const state = { worker, pending: new Map(), queue: [], inFlight: null, nextId: 1 };

  worker.on('message', (msg) => {
    const entry = state.pending.get(msg.id);
    if (!entry) return;
    state.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (state.inFlight === msg.id) state.inFlight = null;
    // Start the next queued job as soon as this one is off the browser.
    setImmediate(() => pump(state));

    if (msg.ok) {
      entry.resolve(msg.result);
    } else {
      const err = new Error(msg.error.message);
      err.stack = msg.error.stack;
      entry.reject(err);
    }
  });

  // A worker that dies takes its in-flight job with it. Reject rather than
  // leave the caller waiting for a reply that will never come.
  const failAll = (reason) => {
    for (const [, entry] of state.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    state.pending.clear();
    // Anything still waiting never ran, so it is skipped rather than failed.
    for (const q of state.queue) q.reject(new SkippedError(reason));
    state.queue.length = 0;
    state.inFlight = null;
    workers.delete(source);
  };

  worker.on('error', (err) => {
    log.error('scrape worker errored', { source, err: log.serializeError(err) });
    failAll(`scrape worker for ${source} errored: ${err.message}`);
  });

  worker.on('exit', (code) => {
    if (code !== 0) log.warn('scrape worker exited', { source, code });
    failAll(`scrape worker for ${source} exited with code ${code}`);
  });

  // Do not hold the process open on the worker's account; shutdown is explicit.
  worker.unref();

  log.info('scrape worker started', { source });
  workers.set(source, state);
  return state;
}

function getWorker(source) {
  const existing = workers.get(source);
  if (existing) return existing;
  return spawn(source);
}

/**
 * Send the next queued job, if the worker is free.
 *
 * SERIALISED BUT NOT DROPPED. All AWSAT jobs share one browser and one login,
 * so exactly one may run at a time — but the previous version REJECTED a job
 * that arrived while another was running, and the caller recorded that as a
 * failure. Seen in production: awsat.orders spent ~30s logging in, awsat.board
 * came due mid-login, and was thrown away and alerted on. The collision was the
 * design working; discarding the job was not.
 */
function pump(state) {
  if (state.inFlight || !state.queue.length) return;

  const next = state.queue.shift();

  // Too late to be worth running — see staleAfterMs().
  if (Date.now() > next.deadline) {
    const waited = Date.now() - next.enqueuedAt;
    log.warn('queued scrape skipped — waited past its own cadence', {
      job: next.job, waitedMs: waited,
    });
    next.reject(new SkippedError(
      `${next.job} waited ${waited}ms behind another job on the same browser `
      + 'and would have stamped a minute that has already passed',
    ));
    return pump(state);
  }

  const id = state.nextId;
  state.nextId += 1;
  state.inFlight = id;

  const timeoutMs = TIMEOUT_MS[next.job] || 120_000;
  const timer = setTimeout(() => {
    state.pending.delete(id);
    state.inFlight = null;
    log.error('scrape timed out — terminating the worker', {
      job: next.job,
      source: next.source,
      timeoutMs,
      note: next.source === 'awsat'
        ? 'this discards the broker session and the next run must log in again, '
          + 'which spends one of the day\'s limited login attempts'
        : undefined,
    });
    state.worker.terminate().catch(() => {});
    workers.delete(next.source);
    next.reject(new Error(`${next.job} timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  state.pending.set(id, { resolve: next.resolve, reject: next.reject, timer });
  state.worker.postMessage({ id, job: next.job, runId: next.runId, args: next.args });
}

/**
 * Queue one scrape for its source's worker.
 * @returns {Promise<object>} whatever the scraper returned, as plain data
 */
function runScrape(job, runId, args = null) {
  const source = SOURCE_OF[job];
  if (!source) return Promise.reject(new Error(`unknown job: ${job}`));

  const state = getWorker(source);

  return new Promise((resolve, reject) => {
    const now = Date.now();
    state.queue.push({
      job, runId, source, args, resolve, reject,
      enqueuedAt: now,
      deadline: now + staleAfterMs(job, source),
    });

    if (state.inFlight) {
      log.info('scrape queued behind another job on the same browser', {
        job, source, queued: state.queue.length,
      });
    }
    pump(state);
  });
}

/** Stop every worker. Called during shutdown. */
async function stopAll() {
  const all = [...workers.entries()];
  workers.clear();

  await Promise.all(all.map(async ([source, state]) => {
    for (const [, entry] of state.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('shutting down'));
    }
    state.pending.clear();
    try {
      // Ask politely first so the worker can close its browser cleanly.
      state.worker.postMessage({ shutdown: true });
      await new Promise((r) => setTimeout(r, 1_500));
      await state.worker.terminate();
    } catch { /* already gone */ }
    log.info('scrape worker stopped', { source });
  }));
}

module.exports = { runScrape, stopAll, SkippedError, SOURCE_OF, TIMEOUT_MS, staleAfterMs, QUEUE_MARGIN_MS };

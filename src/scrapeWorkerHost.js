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
  'tradingview.quotes': 120_000,
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
 * Defaults to the job's own cadence. A one-minute scraper that finally starts
 * ninety seconds late would stamp its rows with a minute that has already
 * passed — and the next run is about to capture the current one properly. Late
 * data is not better than no data here; it is a wrong row that looks right.
 */
function staleAfterMs(job) {
  // The daily history job runs once and has no minute to be late for, so the
  // staleness rule that protects minute-cadence scrapers would only cancel it.
  if (job === 'tradingview.backfill') return 6 * 60 * 60_000;
  return Number(process.env.SCRAPE_STALE_AFTER_MS) || 60_000;
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
      deadline: now + staleAfterMs(job),
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

module.exports = { runScrape, stopAll, SkippedError, SOURCE_OF, TIMEOUT_MS };

'use strict';
/**
 * The bridge between "a scraper produced rows" and "the rows are in the
 * database".
 *
 * Each job does the same five things, which is why they are written once here
 * rather than repeated in every scraper:
 *
 *   1  refuse to start if the same job is still running
 *   2  open a row in scrape_runs
 *   3  run the scraper
 *   4  register symbols, then persist the rows
 *   5  close the run — SUCCESS or FAILED, always
 *
 * Step 5 runs in a finally block. A run left as RUNNING for ever is how a crash
 * disguises itself as a job that is merely slow.
 */

const { config } = require('./config');
const repo = require('./db/repositories');
const clock = require('./market/clock');
// The scrapers are NOT required here. They run in worker threads; this file
// stays on the main thread with the scheduler and the database pool.
const workerHost = require('./scrapeWorkerHost');
const validate = require('./validate');
const log = require('./logger');

/**
 * In-process guard. A scrape that overruns its minute must not have a second
 * copy started on top of it: both would drive the same browser and each would
 * read the other's page.
 */
const running = new Set();

/**
 * The PROMISES of jobs currently in flight, so shutdown can drain them.
 *
 * F-16 · the scheduler fires and forgets by design — awaiting in a cron
 * callback would hold the tick behind a slow scrape — so nothing anywhere held
 * a reference to a running job. `scheduler.stop()` therefore only stopped NEW
 * ticks: a SIGTERM landing inside `repo.insertQuotes` tore the connection out
 * from under it, the insert threw, `finishRun` threw on the closed pool and was
 * swallowed, and the run row was left RUNNING for ever. That minute's ~137
 * quotes were gone, and a trading minute cannot be re-scraped.
 */
const inFlight = new Set();

/** How many jobs are running, and which. For the shutdown log. */
function inFlightJobs() { return [...running]; }

/**
 * Wait for every in-flight job, or until `timeoutMs`.
 *
 * Bounded, because a drain that can hang for ever is worse than a lost write:
 * the supervisor's SIGKILL then takes the process with the browsers still
 * attached, and nothing is flushed anyway. Returns what was still running when
 * it gave up, so the log can name it.
 */
async function drain(timeoutMs = 20_000) {
  if (!inFlight.size) return { drained: true, waitedMs: 0, stillRunning: [] };
  const started = Date.now();
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); });
  await Promise.race([
    Promise.allSettled([...inFlight]),
    deadline,
  ]);
  clearTimeout(timer);
  return {
    drained: inFlight.size === 0,
    waitedMs: Date.now() - started,
    stillRunning: [...running],
  };
}

/**
 * AWSAT server jobs run only in server mode.
 *
 * Reported as SKIPPED, not FAILED — a job that is off by configuration is not a
 * fault, and counting it as one would inflate consecutive_failures and fire
 * alerts for a system behaving exactly as configured.
 */
function awsatServerAllowed(name) {
  if (!name.startsWith('awsat.')) return null;
  const { mode } = config.awsat;
  if (mode === 'server') return null;
  return `AWSAT_MODE=${mode} — server-side AWSAT scraping is disabled`
    + (mode === 'client' ? '; the Tampermonkey scripts collect instead' : '');
}

/**
 * A stable 32-bit key from the job name.
 *
 * pg_advisory_lock takes an integer, not a string, and the key must be the
 * same in every process — so it is derived from the name rather than assigned.
 */
function hashJobName(name) {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) {
    h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  }
  return h;
}

async function runJob(name, fn, args) {
  const blocked = awsatServerAllowed(name);
  if (blocked) {
    log.info('job skipped by configuration', { job: name, reason: blocked });
    return { status: 'SKIPPED', reason: blocked };
  }

  if (running.has(name)) {
    log.warn('skipped — previous run still in progress', { job: name });
    return { status: 'SKIPPED' };
  }

  /**
   * ─── ONE PROCESS PER JOB, ACROSS EVERY PROCESS ─────────────────────────────
   *
   * `running` is a Set in memory — it stops one process overlapping ITSELF and
   * knows nothing about another. Two schedulers were pointed at the same
   * database: the deployed server and a local one. At 13:30 both would call
   * daily.symbolday, compute the same rows, and if they ever disagreed there
   * would be no way to tell which won.
   *
   * A config flag on one of them would fix it and be reversed by accident in a
   * month. An advisory lock survives a third process, needs no coordination,
   * and the skip is VISIBLE in scrape_runs rather than silent.
   *
   * pg_try_advisory_lock returns false rather than waiting: a job that queues
   * behind another for twenty minutes is worse than one that skips and says so.
   * The lock is released when the connection closes, so a crashed process does
   * not hold it forever.
   */
  const lockKey = hashJobName(name);
  // A DEDICATED connection: an advisory lock is held by the session that took
  // it, so a pooled query would release it the moment the client went back.
  const { pool } = require('./db/pool');

  /*
   * F-04 · NEITHER FAILURE PATH IS SWALLOWED ANY MORE.
   *
   * Both used to be silent, and each lied in its own way:
   *
   *   · `pool.connect().catch(() => null)` — a rejection meant lockClient was
   *     null, the whole `if (lockClient)` block was skipped, and the job then
   *     RAN WITH NO LOCK AT ALL, with not one log line. The protection the
   *     block exists for was simply off. Concretely: the pool is exhausted at
   *     13:31 because daily.instruments is still running when daily.symbolday
   *     fires; connect() times out; both the deployed scheduler and a local one
   *     take the null path and compute symbol_day for the same date
   *     concurrently — the exact case this comment block warns about, where "if
   *     they ever disagreed there would be no way to tell which won".
   *
   *   · `catch { holdsLock = false; }` on the query — a Postgres restart
   *     invalidates the session holding the lock and makes this throw. The job
   *     was then recorded as "another process holds the advisory lock", which
   *     is FALSE, and costs an operator an afternoon looking for a second
   *     scheduler that does not exist.
   *
   * Now: a job that cannot take its lock does not run. Refusing is the loud
   * option, and the alternative is two processes writing the same rows.
   */
  let lockClient = null;
  try {
    lockClient = await pool.connect();
  } catch (err) {
    log.error('REFUSING to run — could not take a connection for the advisory lock', {
      job: name, err: err.message,
      note: 'running unlocked risks a second process computing the same rows, and '
        + 'if they disagreed there would be no way to tell which won',
    });
    return { status: 'SKIPPED', reason: 'no connection for the advisory lock' };
  }

  let holdsLock = false;
  let lockError = null;
  {
    try {
      const { rows } = await lockClient.query('SELECT pg_try_advisory_lock($1) AS got', [lockKey]);
      holdsLock = rows[0].got === true;
    } catch (err) {
      lockError = err;
      holdsLock = false;
    }

    if (lockError) {
      lockClient.release();
      log.error('REFUSING to run — the advisory lock could not be taken', {
        job: name, err: lockError.message,
        note: 'NOT "another process holds it" — the lock query itself failed. A '
          + 'Postgres restart invalidates the session that held the lock and '
          + 'produces exactly this.',
      });
      return { status: 'SKIPPED', reason: `advisory lock query failed: ${lockError.message}` };
    }

    if (!holdsLock) {
      lockClient.release();
      log.warn('skipped — another process holds this job', {
        job: name,
        note: 'a second scheduler is pointed at this database; only one computes',
      });
      // Recorded, so the skip is visible in scrape_runs rather than only in a
      // log line nobody reads.
      try {
        const id = await repo.startRun(name, clock.tradingDay());
        // finishRun expects an ERROR OBJECT, not a string: it reads .message
        // and .stack. A string leaves error_message NULL and the row reads as
        // an ordinary skip with no reason.
        await repo.finishRun(id, {
          status: 'SKIPPED',
          startedAt: Date.now(),
          error: new Error('another process holds the advisory lock for this job'),
        });
      } catch (e) {
        // The skip is still correct if it cannot be recorded, but swallowing
        // the reason is how a diagnostic disappears.
        log.warn('could not record the lock skip', { job: name, err: e.message });
      }
      return { status: 'SKIPPED', reason: 'held by another process' };
    }
  }

  running.add(name);

  const startedAt = Date.now();
  const tradingDay = clock.tradingDay();
  let runId = null;

  try {
    runId = await repo.startRun(name, tradingDay);
    log.info('job started', { job: name, runId });

    const result = await fn(runId, args);
    const { extracted, inserted, rejected = 0 } = result;

    /*
     * F-04 · THE JOB'S OWN STATUS IS FORWARDED.
     *
     * `status` was neither destructured nor consulted — every completed run was
     * written SUCCESS. fastLoop returns PARTIAL in two places, and
     * 001_init.sql's CHECK has allowed PARTIAL since the beginning, so the
     * schema was built for this and the writer never used it.
     *
     * What that cost: a writer/schema mismatch makes signals.evaluate throw
     * shapeError for every symbol; fastLoop returns
     * {extracted: 0, inserted: 0, status: 'PARTIAL', shapeErrors: 8}; the run
     * is recorded SUCCESS with zero rows, and the boot report prints
     * "signals.fast: SUCCESS". Seven checks are dead for the session and every
     * dashboard is green — the exact "silence looks identical to success" mode
     * this file's header says it exists to prevent.
     *
     * Only the values the CHECK constraint allows are honoured, and anything
     * else is a bug in the job rather than a reason to write an illegal row.
     */
    const ALLOWED = new Set(['SUCCESS', 'PARTIAL']);
    let status = 'SUCCESS';
    if (result.status && result.status !== 'SUCCESS') {
      if (ALLOWED.has(result.status)) {
        status = result.status;
      } else {
        log.error('job returned a status finishRun cannot store — recording SUCCESS', {
          job: name, returned: result.status, allowed: [...ALLOWED],
        });
      }
    }

    await repo.finishRun(runId, {
      status, rowsExtracted: extracted, rowsInserted: inserted, startedAt,
    });

    // A PARTIAL run is a degraded one. It must be as visible as a failure in
    // the log, because in scrape_runs it is only one word different.
    if (status === 'PARTIAL') {
      log.error('job completed PARTIAL — some of its work did not run', {
        job: name, runId, ...(result.skipped ? { skipped: result.skipped } : {}),
        ...(result.shapeErrors ? { shapeErrors: result.shapeErrors } : {}),
      });
    }

    // Extracted rows that reached neither the database nor a duplicate are lost
    // data, and a trading minute cannot be re-scraped. Say so at error level.
    if (rejected > 0) {
      log.error('rows were extracted but could not be stored', {
        job: name, runId, rejected, extracted,
      });
    }

    // extracted and inserted are logged separately on purpose. Equal numbers
    // mean new data; extracted without inserted means every row was already
    // stored, which is a stalled feed wearing the appearance of a healthy one.
    log.info('job finished', {
      job: name, runId, extracted, inserted, rejected, ms: Date.now() - startedAt,
    });
    /*
     * P2 · `status`, NOT THE LITERAL 'SUCCESS'.
     *
     * F-04 computed this status and passed it to finishRun, so scrape_runs
     * recorded PARTIAL correctly — and then this line discarded it. The row
     * said PARTIAL and the return value said SUCCESS.
     *
     * src/runOnce.js exits `result.status === 'SUCCESS' ? 0 : 1`, so
     * `npm run run:once -- signals.fast` exited 0, printed as a success, for a
     * run in which the shape-error limit had disabled evaluation and the checks
     * never executed. Any deploy or CI step gating on that exit code saw green.
     */
    return { status, extracted, inserted, rejected };
  } catch (err) {
    // A job that never got onto the browser is SKIPPED, not FAILED. Recording
    // it as a failure inflates consecutive_failures and fires alerts for a
    // queue behaving exactly as designed — which is how a monitoring system
    // teaches people to ignore it.
    if (err && err.skipped) {
      log.warn('job skipped', { job: name, runId, reason: err.message });
      if (runId) {
        await repo.finishRun(runId, { status: 'SKIPPED', startedAt })
          .catch((e) => log.error('could not record skip', { err: log.serializeError(e) }));
      }
      return { status: 'SKIPPED', reason: err.message };
    }

    log.error('job failed', { job: name, runId, err: log.serializeError(err) });
    if (runId) {
      await repo.finishRun(runId, {
        status: 'FAILED', error: err, startedAt,
      }).catch((e) => log.error('could not record failure', { err: log.serializeError(e) }));
    }
    return { status: 'FAILED', error: err };
  } finally {
    running.delete(name);
    if (lockClient) {
      if (holdsLock) {
        await lockClient.query('SELECT pg_advisory_unlock($1)', [lockKey]).catch(() => {});
      }
      lockClient.release();
    }
  }
}

// ─── job definitions ────────────────────────────────────────────────────────

/**
 * Shared path for both quote sources.
 *
 * Symbols are registered FIRST because quotes.symbol is a foreign key. Any
 * quote whose symbol did not register is then dropped rather than offered: one
 * unknown ticker would otherwise fail its whole chunk and cost the good rows a
 * row-by-row retry.
 */
async function persistQuotes(quotes, symbols, extractedCount) {
  const checked = validate.validateAll(quotes, validate.validateQuote, 'quotes');

  // Reference data first. The quote tables have no foreign key to
  // instruments — the board is the source of truth for what exists,
  // and refusing a quote for a symbol not yet in the reference list would
  // discard a newly listed stock on the very sweep that discovered it.
  await repo.upsertSymbols(symbols);

  const res = await repo.insertQuotes(checked.rows);
  return {
    extracted: extractedCount,
    inserted: res.inserted,
    rejected: checked.rejected + res.rejected,
  };
}

/*
 * P6-TV-3 / P6-AWS-8 · A TRUNCATED BOARD IS PARTIAL, NOT SUCCESS.
 *
 * Neither board job compared what it captured against the universe it is
 * supposed to cover, so a scroll that stopped at 60 of 137 symbols — an early
 * `unchanged >= 3` exit, a scrape deadline, a render pause — was written
 * SUCCESS. On the TradingView side that is worse than a gap: the watchlist is
 * the REFERENCE the AWSAT reconciliation measures itself against, so a short
 * TradingView sweep silently lowers the bar for everything downstream.
 *
 * The floor is a fraction of the reference universe, configurable, and the
 * run is PARTIAL below it — which finishRun already stores and logs as a
 * degraded run (F-04).
 */
const COVERAGE_MIN_PCT = require('./config/thresholds').get('board_coverage_min_pct');

async function coverageStatus(symbolSet, source) {
  const r = await require('./reconcileSymbols')
    .check(symbolSet, { source })
    .catch((err) => { log.warn('symbol reconciliation failed', { err: err.message }); return null; });
  if (!r || r.checked === false) return null;   // nothing to compare against yet
  if (r.coveragePct < COVERAGE_MIN_PCT) {
    log.error('board coverage is below the floor — recording PARTIAL', {
      source, ...r, floorPct: COVERAGE_MIN_PCT, missingSymbols: undefined,
    });
    return 'PARTIAL';
  }
  return null;
}

/**
 * ─── THE CAPTURE JOBS DO NOT WRITE INTO A *_test DATABASE (26 Sep) ────────
 *
 * kse_test could not be rebuilt from kse because a live TradingView process
 * kept writing into it — a deployment pointed at the wrong DATABASE_URL, which
 * no amount of care at the far end prevents. Stopping it is an
 * ENABLED_SCRAPERS change, and a config change is exactly the kind of thing
 * that comes back after a rebuild.
 *
 * So the refusal lives here, where the write is. This is the scraper's side of
 * the rule test/dbguard.js already enforces for the backend suites: a name
 * ending in `_test` is a database somebody expects to be able to DROP, and a
 * capture job filling it is silently making that untrue.
 *
 * It REFUSES rather than warning, because a warning on a job that runs every
 * five minutes is a line nobody reads twice. And it names the database, so the
 * reason is in the error rather than in somebody's memory of this comment.
 *
 * To seed a test database deliberately, run the job with
 * ALLOW_TEST_DB_WRITES=1 — stated out loud in the environment rather than
 * discovered by the job not complaining.
 */
function refuseTestDatabase(job) {
  if (process.env.ALLOW_TEST_DB_WRITES === '1') return null;
  const url = process.env.DATABASE_URL || '';
  let name = '';
  try { name = decodeURIComponent(new URL(url).pathname.replace(/^\//, '')); } catch { name = ''; }
  if (!/_test$/i.test(name)) return null;
  return `${job} REFUSES to write to "${name}": a database whose name ends in _test is one `
    + 'somebody expects to be able to drop and rebuild, and a capture job filling it makes '
    + 'that quietly untrue — this is why kse_test could not be rebuilt from kse. Point '
    + 'DATABASE_URL at the real database, or set ALLOW_TEST_DB_WRITES=1 to seed it on purpose.';
}

async function tradingviewQuotes(runId) {
  const refusal = refuseTestDatabase('tradingview.quotes');
  if (refusal) { log.error(refusal); throw new Error(refusal); }
  const { quotes, symbols } = await workerHost.runScrape('tradingview.quotes', runId);
  if (!quotes.length) return { extracted: 0, inserted: 0, rejected: 0 };
  const result = await persistQuotes(quotes, symbols, quotes.length);
  const status = await coverageStatus(new Set(quotes.map((q) => q.symbol)), 'tradingview');
  return status ? { ...result, status } : result;
}

async function awsatBoard(runId) {
  const { quotes, symbols, truncated } = await workerHost.runScrape('awsat.board', runId);
  if (!quotes.length) return { extracted: 0, inserted: 0, rejected: 0 };

  const result = await persistQuotes(quotes, symbols, quotes.length);

  // Same check the client path runs, so coverage is reported whichever
  // collector is active — and P6-AWS-8: below the floor the run is PARTIAL,
  // not a SUCCESS with two thirds of the market missing.
  const status = await coverageStatus(new Set(quotes.map((q) => q.symbol)), 'awsat_server');

  // P6-AWS-4 · a sweep that stalled before the bottom of the list is partial
  // whatever the coverage check says (the reference itself can be short).
  const finalStatus = truncated ? 'PARTIAL' : status;

  return finalStatus ? { ...result, status: finalStatus } : result;
}

async function awsatDepth(runId) {
  const { levels, symbols, wanted } = await workerHost.runScrape('awsat.depth', runId);
  /*
   * P6-AWS-3 · DEPTH WITH NO ROWS IS NOT A SUCCESS.
   *
   * Every per-symbol failure inside scrapeDepth is a `continue` — an overlay
   * back on screen, a moved search box, a renamed panel — so a sweep in which
   * EVERY slot failed returned `{levels: []}` and was recorded SUCCESS with
   * zero rows. "There is no book" and "we could not read the book" then look
   * identical in scrape_runs, which is the one thing this repository's own
   * header says must never be true.
   */
  if (!levels.length) {
    const asked = Array.isArray(wanted) ? wanted.length : 0;
    if (asked > 0) {
      log.error('depth swept every slot and produced NO levels — recording PARTIAL',
        { slots: asked });
      return { extracted: 0, inserted: 0, rejected: 0, status: 'PARTIAL', skipped: asked };
    }
    return { extracted: 0, inserted: 0, rejected: 0 };
  }

  const checked = validate.validateAll(levels, validate.validateDepthLevel, 'awsat_stock_depth');
  if (symbols && symbols.length) await repo.upsertSymbols(symbols);

  const res = await repo.insertDepth(checked.rows);
  return {
    extracted: levels.length,
    inserted: res.inserted,
    rejected: checked.rejected + res.rejected,
  };
}

async function awsatOrders(runId) {
  const { orders } = await workerHost.runScrape('awsat.orders', runId);
  if (!orders.length) return { extracted: 0, inserted: 0, rejected: 0 };

  // orders.symbol is deliberately not a foreign key, so no registration step.
  const checked = validate.validateAll(orders, validate.validateOrder, 'orders');
  const res = await repo.insertOrders(checked.rows);
  return {
    extracted: orders.length,
    inserted: res.inserted,
    rejected: checked.rejected + res.rejected,
  };
}

/**
 * Every job, keyed by the name used in ENABLED_SCRAPERS and stored in
 * scrape_runs.scraper.
 */
/**
 * Daily history, after the close.
 *
 * Symbols come from the database rather than a config list, so whatever the
 * live board discovered today is what gets historical bars tonight — a newly
 * listed stock needs no manual step.
 */
/**
 * Daily history: aggregate the session's own minute rows.
 *
 * Not a scrape. See src/jobs/historyFinalise.js for why — the short version is
 * that a day's OHLCV is an aggregate of its minutes, we already have the
 * minutes, and 137 chart navigations is 25-35 minutes of independently
 * failing steps.
 */
async function tradingviewHistory(runId, args) {
  return require('./jobs/historyFinalise')
    .finalise((args && args.date) || clock.tradingDay(), runId);
}

/**
 * Daily analysis for a trading day. Runs the morning AFTER the session, so the
 * day it analyses is yesterday unless one is named.
 */
/**
 * Fast loop — every 15-20s over the slotted symbols (Step 3, item 4).
 *
 * Reads the newest two symbol_minute snapshots per slotted symbol, runs the
 * seven checks, writes what fires to signal_log and pushes it.
 *
 * It does NOT scrape: the client writes symbol_minute. This is the evaluation
 * half, so a change to the checks never touches the capture path.
 */
async function fastLoop(runId) {
  const wakeup = require('./wakeup');
  const signals = require('./signals');
  const notify = require('./notify');
  const writer = require('./jobs/writeSymbolMinute');
  const { query } = require('./db/pool');

  // The 8 slots, read from depth_watchlist — there is no slot table.
  const held = await wakeup.slottedSymbols();
  if (!held.length) {
    fastLoopSkip('no slots held — seed pre-day slots or wait for a wake-up');
    return { extracted: 0, inserted: 0, rejected: 0 };
  }

  /**
   * WRITE FIRST, THEN COMPARE.
   *
   * The checks need two consecutive symbol_minute rows. Nothing wrote that
   * table, so the loop ran every 20 seconds for a whole session and did
   * nothing — and a job that runs and does nothing reads as a working one.
   *
   * The writer is called here rather than scheduled separately because
   * "snapshot, then compare" is one operation: two crons on the same tick can
   * drift, and the comparison would then run against a snapshot that does not
   * exist yet.
   */
  const written = await writer.writeTick(runId);

  let fired = 0;
  let snapshots = 0;
  /*
   * F-18 · shapeErrors is PROCESS state, not per-invocation state.
   *
   * It was a local, re-initialised on every tick, and incremented once per
   * symbol in a loop bounded by the depth slots — at most 8. The limit is 20.
   * So `evaluationDisabled` was UNREACHABLE, and the limiter that exists to
   * stop a shape mismatch printing 24 error lines a minute for four hours
   * (~5,760 identical lines, burying every other log line in the session — the
   * exact outcome its own comment describes) never once fired.
   *
   * Counting consecutively ACROSS ticks is what the limit was always meant to
   * mean: twenty consecutive failures is a broken writer, not a bad minute.
   */
  const toPush = [];

  // Evaluation is off for this process — a shape mismatch does not fix itself
  // mid-session. The writer above still ran.
  if (evaluationDisabled) {
    return {
      extracted: 0, inserted: 0, rejected: 0,
      status: 'PARTIAL',
      skipped: 'evaluation disabled after repeated shape errors',
    };
  }

  for (const { symbol, slot } of held) {
    const { rows } = await query(
      `SELECT *, ts AS captured_at FROM symbol_minute
        WHERE symbol = $1 AND trading_date = $2
        ORDER BY ts DESC LIMIT 2`, [symbol, clock.tradingDay()],
    );
    snapshots += rows.length;
    if (rows.length < 2) continue;          // nothing to compare yet
    const [now, prev] = rows;

    /**
     * A SHAPE ERROR MEANS THE CHECKS ARE MEANINGLESS.
     *
     * It throws rather than degrading, because a row of the wrong shape makes
     * every check silently return null — which is how three of the seven could
     * not fire for weeks while the system looked normal.
     *
     * But a shape mismatch needs a redeploy to fix, so retrying it every 20
     * seconds is 810 identical failures in one session, burying every other log
     * line. After 20 consecutive, evaluation stops for THIS PROCESS: one loud
     * line naming the column, then silence.
     *
     * The writer keeps running. symbol_minute still fills, so nothing is lost
     * from the record — only the evaluation of it.
     */
    let hits;
    try {
      hits = signals.evaluate(prev, now);
      // One success clears the run: the mismatch was transient, or fixed.
      shapeErrors = 0;
    } catch (err) {
      if (!err.shapeError) throw err;
      shapeErrors += 1;
      lastShapeError = err;
      if (shapeErrors >= SHAPE_ERROR_LIMIT) {
        evaluationDisabled = true;
        log.error('signals.fast: evaluation DISABLED for this process after '
          + `${SHAPE_ERROR_LIMIT} consecutive shape errors. symbol_minute rows `
          + `are still being written.\n  Missing column: ${(err.missingColumns || []).join(', ')}`
          + `\n  Last error: ${err.message}`
          + '\n  Restart after fixing the writer.');
      }
      continue;
    }

    for (const hit of hits) {
      // ON CONFLICT DO NOTHING: the loop may see the same pair twice if a
      // capture is late, and one condition is one signal.
      const res = await query(
        `INSERT INTO signal_log
           (fired_at, trading_date, symbol, signal, slot, price, bid_qty,
            offer_qty, ratio, message)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (symbol, signal, fired_at) DO NOTHING RETURNING id`,
        [now.ts, clock.tradingDay(), symbol, hit.signal, slot, now.last_price,
          now.bid_qty, now.offer_qty, hit.ratio ?? null, hit.detail],
      );
      if (res.rowCount) { fired += 1; toPush.push(hit); }
    }
  }

  if (!snapshots) {
    fastLoopSkip('symbol_minute empty, nothing to compare', { written: written.inserted });
  } else {
    fastLoopEmptyRuns = 0;
  }

  if (toPush.length) {
    const sent = await notify.pushAll(toPush);
    log.info('fast loop: signals fired', { symbols: held.length, fired, ...sent });
  }

  /**
   * extracted is the SNAPSHOT count, not the number of symbols watched.
   *
   * Those are different failures and they must look different in scrape_runs:
   *
   *   extracted 8, inserted 0   the loop is working, nothing fired
   *   extracted 0, inserted 0   the writer is broken
   *
   * With held.length there, both read as "8 examined, none fired" and a dead
   * writer is indistinguishable from a quiet market.
   */
  return {
    extracted: snapshots,
    inserted: fired,
    rejected: 0,
    ...(shapeErrors ? { status: 'PARTIAL', shapeErrors } : {}),
  };
}

/**
 * Why the fast loop did nothing, without saying it 810 times.
 *
 * ─── THE ESCALATION ────────────────────────────────────────────────────────
 *   first empty run        the reason, once
 *   20 consecutive         WARN — about 7 minutes at a 20s tick
 *   every 180 after        WARN — roughly hourly, for as long as it lasts
 *
 * A single line at 09:00 is easy to scroll past; a warning at 09:07 is not.
 * The count carries the time, so no clock is needed — at 20 seconds a tick, 180
 * runs IS an hour.
 */
/**
 * Shape-error state, per process.
 *
 * PARTIAL rather than SKIPPED when disabled: the writer ran and evaluation did
 * not, which is exactly what PARTIAL means. SKIPPED already means "outside the
 * window or wrong mode", and overloading it would make "why did signals skip"
 * a two-answer question.
 */
const SHAPE_ERROR_LIMIT = Number(process.env.SIG_SHAPE_ERROR_LIMIT || 20);
let evaluationDisabled = false;
// Consecutive shape errors ACROSS invocations. See the note in fastLoop.
let shapeErrors = 0;
let lastShapeError = null;

let fastLoopEmptyRuns = 0;
const fastLoopSeenToday = new Map();

function fastLoopSkip(reason, extra = {}) {
  fastLoopEmptyRuns += 1;
  const today = clock.tradingDay();

  // Once per calendar day per reason. Once per PROCESS would hide it after a
  // 09:00 restart, which is exactly when it matters.
  const key = `${today}|${reason}`;
  if (!fastLoopSeenToday.has(key)) {
    fastLoopSeenToday.clear();          // yesterday's keys are of no use
    fastLoopSeenToday.set(key, true);
    log.info('fast loop: nothing to do', { reason, ...extra });
    return;
  }

  if (fastLoopEmptyRuns === 20 || fastLoopEmptyRuns % 180 === 0) {
    log.warn('fast loop has produced nothing for many consecutive runs', {
      reason,
      consecutiveRuns: fastLoopEmptyRuns,
      approxMinutes: Math.round((fastLoopEmptyRuns * 20) / 60),
      ...extra,
    });
  }
}

/** Registry maintenance. Runs BEFORE symbolday so the day computes correctly. */
async function refreshInstruments(runId) {
  return require('./jobs/refreshInstruments').refresh(runId);
}

/** symbol_day for one session (Step 3 of the TMI order of work). */
async function symbolDay(runId, args) {
  return require('./jobs/computeSymbolDay')
    .compute((args && args.date) || clock.tradingDay(), runId);
}

/**
 * symbol_minute_sample for one session. Reads public.quotes_clean and the
 * depth captures, so it runs after the day is closed — but before market_day,
 * which is the job that means "the day is finished".
 */
async function minuteSample(runId, args) {
  return require('./jobs/computeMinuteSample')
    .compute((args && args.date) || clock.tradingDay(), runId);
}

/** market_day for one session. Reads symbol_day, so it runs after it. */
async function marketDay(runId, args) {
  return require('./jobs/computeMarketDay')
    .compute((args && args.date) || clock.tradingDay(), runId);
}

/** Wake-up scan — every 15 minutes over all 137, from the quotes grid. */
async function wakeupScan(runId) {
  const r = await require('./wakeup').scan();
  return { extracted: r.examined, inserted: r.promoted, rejected: 0 };
}

/** Nightly scoring of today's signals (Step 3, item 6). */
async function scoreSignals(runId, args) {
  const day = (args && args.date) || clock.tradingDay();
  // B4 · the halt mirror is the FIRST step: every halt-resume of the day lands
  // in signal_log (once) before scoring, and the count-equality check fails the
  // job loudly rather than scoring a half-mirrored day.
  await require('./jobs/mirrorHalts').mirror(day);
  return require('./jobs/scoreSignals').score(day, runId);
}

async function dailyAnalysis(runId, args) {
  const day = (args && args.date) || require('./jobs/dailyAnalysis').previousTradingDay();
  return require('./jobs/dailyAnalysis').analyse(day, runId);
}

/**
 * Backfill from TradingView charts.
 *
 * For days that PREDATE collection, where there are no minutes to aggregate.
 * Deliberately not on the schedule: it is slow, it is fragile, and it should be
 * run knowingly for a named range rather than every evening.
 */
/*
 * ─── `--date` WAS ACCEPTED, PARSED, AND THROWN AWAY ────────────────────────
 *
 * This took `(runId)` where every other dated job in this file takes
 * `(runId, args)`: tradingviewHistory, symbolDay, marketDay, dailyAnalysis.
 * The runner parsed `--date`, built `args` and passed it in; the parameter
 * list dropped it on the floor. So
 *
 *     tradingview.backfill --date=2026-08-09
 *
 * silently refetched the last 30 days instead, reported success, and left
 * 9 August exactly as missing as before. A flag that is accepted and ignored
 * is worse than one that is rejected, because the operator has no way to tell
 * the difference from the outside.
 *
 * `--date` fetches that ONE day; `--from`/`--to` fetch a range; neither keeps
 * the old rolling window, so the scheduled behaviour is unchanged. The window
 * is logged either way, naming which of the three decided it.
 */
async function tradingviewBackfill(runId, args) {
  const symbols = await repo.activeSymbols(Number(process.env.HISTORY_MAX_SYMBOLS) || 500);
  if (!symbols.length) {
    log.warn('backfill: no symbols known yet — the live scraper must run first');
    return { extracted: 0, inserted: 0, rejected: 0 };
  }
  const days = Number(process.env.HISTORY_DAYS) || 30;
  // P6-TV-9 · both ends in the SAME timezone. endDay is the Kuwait trading day
  // and startDay was a UTC slice, so near UTC midnight the window was a day
  // wider at one end than at the other.
  const rolling = {
    startDay: clock.tradingDay(new Date(Date.now() - days * 86400_000)),
    endDay: clock.tradingDay(),
  };
  const named = (() => {
    if (args && args.date) return { startDay: args.date, endDay: args.date, why: `--date=${args.date}` };
    if (args && (args.from || args.to)) {
      return {
        startDay: args.from || rolling.startDay,
        endDay: args.to || rolling.endDay,
        why: `--from=${args.from || '(rolling start)'} --to=${args.to || '(today)'}`,
      };
    }
    return null;
  })();
  const { startDay, endDay } = named || rolling;
  if (startDay > endDay) {
    throw new Error(`backfill: ${named ? named.why : 'the rolling window'} gives an empty range `
      + `(${startDay} > ${endDay}) — refusing rather than fetching nothing and reporting success`);
  }
  log.info('backfill: window', {
    startDay, endDay, source: named ? named.why : `rolling ${days} days (no --date/--from/--to)`,
  });

  const { rows, failures, skipped } = await workerHost.runScrape('tradingview.backfill', runId, {
    symbols, startDay, endDay,
  });
  /*
   * P6-TV-1 · A BACKFILL THAT FAILED MOST OF ITS SYMBOLS IS NOT A SUCCESS.
   *
   * scrape() only throws when EVERY symbol produced nothing; the per-symbol
   * failure list came back and was thrown away, so 130 of 137 symbols failing
   * their context menu was recorded SUCCESS with rejected: 0 and seven symbols
   * of history. The failures are counted as rejected and the run is PARTIAL.
   */
  const failed = Array.isArray(failures) ? failures.length : 0;
  if (failed) {
    log.error('backfill: symbols that produced no history', {
      count: failed, of: symbols.length, symbols: (failures || []).slice(0, 20),
    });
  }
  if (!rows.length) {
    return { extracted: 0, inserted: 0, rejected: failed, ...(failed ? { status: 'PARTIAL' } : {}) };
  }
  const res = await repo.upsertDailyPrices(rows);
  return {
    extracted: rows.length,
    inserted: res.inserted,
    rejected: res.rejected + failed,
    ...(failed ? { status: 'PARTIAL', skipped: skipped || failed } : {}),
  };
}

const JOBS = {
  'tradingview.quotes': tradingviewQuotes,
  'tradingview.history': tradingviewHistory,
  'tradingview.backfill': tradingviewBackfill,
  'daily.analysis': dailyAnalysis,
  'daily.instruments': refreshInstruments,
  'daily.symbolday': symbolDay,
  'daily.minutesample': minuteSample,
  'daily.marketday': marketDay,
  'signals.fast': fastLoop,
  'signals.wakeup': wakeupScan,
  'signals.score': scoreSignals,
  'awsat.board': awsatBoard,
  'awsat.depth': awsatDepth,
  'awsat.orders': awsatOrders,
};

/** Run one job by name. Returns a result rather than throwing. */
async function run(name, args) {
  const fn = JOBS[name];
  if (!fn) {
    log.error('unknown job', { job: name, known: Object.keys(JOBS) });
    return { status: 'FAILED' };
  }
  /*
   * F-16 · REGISTERED WHILE IT RUNS, so shutdown can wait for it.
   *
   * The scheduler fires and forgets — correctly, because awaiting inside a cron
   * callback holds the next tick behind a slow scrape — so this is the only
   * place with a reference to the promise.
   */
  const promise = runJob(name, fn, args);
  inFlight.add(promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(promise);
  }
}

module.exports = {
  run,
  JOBS,
  jobNames: Object.keys(JOBS),
  // Exported for the lock test: two callers racing one job name.
  _runJob: runJob,
  _hashJobName: hashJobName,
  /*
   * F-18 · the shape-error state, readable. `lastShapeError` was assigned and
   * never read anywhere in the repo — the one captured diagnostic was thrown
   * away. It and the counter are now both reachable, so /health and the tests
   * can say WHY evaluation stopped rather than only that it did.
   */
  // F-16 · shutdown drains these before closing the pool.
  drain,
  inFlightJobs,
  _signalHealth: () => ({
    evaluationDisabled,
    shapeErrors,
    limit: SHAPE_ERROR_LIMIT,
    lastShapeError: lastShapeError ? {
      message: lastShapeError.message,
      missingColumns: lastShapeError.missingColumns || [],
    } : null,
  }),
  _resetSignalHealth: () => { evaluationDisabled = false; shapeErrors = 0; lastShapeError = null; },
};

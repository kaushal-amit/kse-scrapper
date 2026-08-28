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
  running.add(name);

  const startedAt = Date.now();
  const tradingDay = clock.tradingDay();
  let runId = null;

  try {
    runId = await repo.startRun(name, tradingDay);
    log.info('job started', { job: name, runId });

    const { extracted, inserted, rejected = 0 } = await fn(runId, args);

    await repo.finishRun(runId, {
      status: 'SUCCESS', rowsExtracted: extracted, rowsInserted: inserted, startedAt,
    });

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
    return { status: 'SUCCESS', extracted, inserted, rejected };
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

async function tradingviewQuotes(runId) {
  const { quotes, symbols } = await workerHost.runScrape('tradingview.quotes', runId);
  if (!quotes.length) return { extracted: 0, inserted: 0, rejected: 0 };
  return persistQuotes(quotes, symbols, quotes.length);
}

async function awsatBoard(runId) {
  const { quotes, symbols } = await workerHost.runScrape('awsat.board', runId);
  if (!quotes.length) return { extracted: 0, inserted: 0, rejected: 0 };

  const result = await persistQuotes(quotes, symbols, quotes.length);

  // Same check the client path runs, so coverage is reported whichever
  // collector is active.
  await require('./reconcileSymbols')
    .check(new Set(quotes.map((q) => q.symbol)), { source: 'awsat_server' })
    .catch((err) => log.warn('symbol reconciliation failed', { err: err.message }));

  return result;
}

async function awsatDepth(runId) {
  const { levels, symbols } = await workerHost.runScrape('awsat.depth', runId);
  if (!levels.length) return { extracted: 0, inserted: 0, rejected: 0 };

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
  const toPush = [];

  for (const { symbol, slot } of held) {
    const { rows } = await query(
      `SELECT *, ts AS captured_at FROM symbol_minute
        WHERE symbol = $1 AND trading_date = $2
        ORDER BY ts DESC LIMIT 2`, [symbol, clock.tradingDay()],
    );
    snapshots += rows.length;
    if (rows.length < 2) continue;          // nothing to compare yet
    const [now, prev] = rows;

    for (const hit of signals.evaluate(prev, now)) {
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
  return { extracted: snapshots, inserted: fired, rejected: 0 };
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
  return require('./jobs/scoreSignals')
    .score((args && args.date) || clock.tradingDay(), runId);
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
async function tradingviewBackfill(runId) {
  const symbols = await repo.activeSymbols(Number(process.env.HISTORY_MAX_SYMBOLS) || 500);
  if (!symbols.length) {
    log.warn('backfill: no symbols known yet — the live scraper must run first');
    return { extracted: 0, inserted: 0, rejected: 0 };
  }
  const endDay = clock.tradingDay();
  const days = Number(process.env.HISTORY_DAYS) || 30;
  const startDay = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);

  const { rows } = await workerHost.runScrape('tradingview.backfill', runId, {
    symbols, startDay, endDay,
  });
  if (!rows.length) return { extracted: 0, inserted: 0, rejected: 0 };
  const res = await repo.upsertDailyPrices(rows);
  return { extracted: rows.length, inserted: res.inserted, rejected: res.rejected };
}

const JOBS = {
  'tradingview.quotes': tradingviewQuotes,
  'tradingview.history': tradingviewHistory,
  'tradingview.backfill': tradingviewBackfill,
  'daily.analysis': dailyAnalysis,
  'daily.instruments': refreshInstruments,
  'daily.symbolday': symbolDay,
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
  return runJob(name, fn, args);
}

module.exports = { run, JOBS, jobNames: Object.keys(JOBS) };

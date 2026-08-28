'use strict';
/**
 * The worker thread that actually scrapes.
 *
 * It owns a browser for the life of the thread and answers one job at a time.
 * It NEVER touches the database: the main thread holds the pool and does all
 * writes, so there is one pool for the process rather than one per thread.
 *
 * Results cross the thread boundary by structured clone. Plain objects and
 * Dates survive that; class instances and functions do not, which is why the
 * scrapers return plain data.
 */

const { parentPort, workerData } = require('worker_threads');
const log = require('./logger');

const { source } = workerData;

// Loaded lazily so a require-time failure in one source's scraper cannot stop
// the other's worker from starting.
const SCRAPERS = {
  'tradingview.quotes': () => require('./scrapers/tradingview').scrape,
  'tradingview.backfill': () => require('./scrapers/tradingviewHistory').scrape,
  'awsat.board': () => require('./scrapers/awsat').scrapeBoard,
  'awsat.depth': () => require('./scrapers/awsat').scrapeDepth,
  'awsat.orders': () => require('./scrapers/awsat').scrapeOrders,
};

let busy = false;

parentPort.on('message', async (msg) => {
  if (msg.shutdown) {
    try {
      // Close the shared AWSAT page first so its context releases cleanly.
      const a = require.cache[require.resolve('./scrapers/awsat')];
      if (a) await a.exports.closeSession().catch(() => {});
      await require('./browser/browser').closeBrowser();
    } catch { /* nothing to close */ }
    process.exit(0);
    return;
  }

  const { id, job, runId, args } = msg;

  // One job at a time per worker. Two scrapes sharing a browser would drive the
  // same page and each would read the other's screen.
  if (busy) {
    parentPort.postMessage({
      id, ok: false,
      error: { message: `worker for ${source} is still running a previous job`, stack: '' },
    });
    return;
  }

  busy = true;
  try {
    const load = SCRAPERS[job];
    if (!load) throw new Error(`worker ${source} cannot run job ${job}`);

    const result = await load()({ runId, ...(args || {}) });
    parentPort.postMessage({ id, ok: true, result });
  } catch (err) {
    parentPort.postMessage({
      id, ok: false,
      error: { message: err.message, stack: err.stack },
    });
  } finally {
    busy = false;
  }
});

process.on('uncaughtException', (err) => {
  log.error('scrape worker uncaught exception', { source, err: log.serializeError(err) });
  process.exit(1);
});

log.debug('scrape worker ready', { source });

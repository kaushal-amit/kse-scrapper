'use strict';
/**
 * Entry point.
 *
 * Startup order matters: verify the database is reachable and migrated BEFORE
 * scheduling anything. A scraper that runs against a missing table produces a
 * failure every minute for four hours, and the first of those errors is buried
 * by the time anyone looks.
 */

const { config } = require('./config');
const clock = require('./market/clock');
const db = require('./db/pool');
const { migrate } = require('./db/migrate');
const repo = require('./db/repositories');
const scheduler = require('./scheduler');
const workerHost = require('./scrapeWorkerHost');
const log = require('./logger');

/**
 * The ingest API is only started when INGEST_TOKEN is set.
 *
 * An unauthenticated write endpoint accepting market data is worse than no
 * endpoint, so absence of the token disables the whole surface rather than
 * defaulting to open.
 */
function startIngestApi() {
  const token = process.env.INGEST_TOKEN;
  if (!token) {
    log.info('ingest API not started — INGEST_TOKEN is not set');
    return null;
  }
  if (token.length < 24) {
    log.warn('INGEST_TOKEN is short; use at least 24 random characters');
  }

  const express = require('express');
  const app = express();
  /**
   * CORS FIRST — before body parsing, before routing.
   *
   * It used to live inside the ingest router, which is too late. express.json
   * rejects a malformed or oversized body BEFORE any router runs, and that
   * response carried no Access-Control-Allow-Origin — so the browser reported a
   * CORS error for what was actually a 413 or a parse failure. Depth is the
   * largest payload sent, which is why depth was the endpoint that showed it.
   */
  const ORIGIN = process.env.INGEST_ORIGIN || '*';
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', ORIGIN);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-ingest-token');
    res.set('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') return res.status(204).end();
    return next();
  });

  const limit = process.env.INGEST_BODY_LIMIT || '8mb';
  app.use(express.json({ limit }));
  // text/plain avoids the CORS preflight entirely — see the note in the router.
  app.use(express.text({ limit, type: ['text/plain', 'text/*'] }));
  /**
   * Mounted at BOTH paths.
   *
   * The userscripts post to /depth, /quotes and /orders — that is what the
   * existing bridge host serves — while this API was written under /ingest.
   * Pointing the scripts at this server therefore produced a 404 per request,
   * which reads as "the API is down" rather than "the prefix differs".
   *
   * Serving both is one line and means neither side has to be edited to match
   * the other. /ingest stays the documented path; the bare paths are the
   * compatibility surface.
   */
  const ingest = require('./api/ingest');
  app.use('/ingest', ingest.createRouter());
  app.use('/', ingest.createRouter());

  /**
   * Error handler. Re-sets the headers because an error thrown by the body
   * parser can bypass the middleware above on some paths, and an error the
   * browser cannot read is reported as a CORS failure rather than as the 413 or
   * parse error it actually is.
   */
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    res.set('Access-Control-Allow-Origin', ORIGIN);
    res.set('Vary', 'Origin');
    const tooBig = err.type === 'entity.too.large' || err.status === 413;
    log.error('ingest request rejected', {
      path: req.path, type: err.type, status: err.status, message: err.message,
    });
    res.status(tooBig ? 413 : 400).json({
      ok: false,
      error: tooBig
        ? `payload larger than ${limit} — raise INGEST_BODY_LIMIT or send smaller batches`
        : `could not read the request body: ${err.message}`,
    });
  });
  app.use((req, res) => res.status(404).json({ ok: false, error: 'not found' }));

  const port = Number(process.env.INGEST_PORT || 8787);
  const server = app.listen(port, () => {
    log.info('ingest API listening', {
      port,
      routes: ['/ingest/health', '/ingest/quotes', '/ingest/depth', '/ingest/orders'],
      cors: process.env.INGEST_ORIGIN || '*',
    });

    // MIXED CONTENT is the other half of "NetworkError" and CORS does not fix
    // it: an https:// page may not fetch http://. The terminal is served over
    // TLS, so a plain-http ingest endpoint is blocked by the browser before any
    // request is made — invisible from here, because nothing arrives.
    //
    // Chrome exempts http://localhost as a trustworthy origin; Firefox does
    // not, and the uploaded panels are Firefox.
    log.warn('the terminal is served over HTTPS — a plain-http endpoint is '
      + 'blocked as mixed content by Firefox', {
      workaround: [
        `point the userscript at http://localhost:${port} AND use Chrome`,
        'or put the API behind the https host the scripts already use',
        'or run it behind any TLS terminator',
      ],
    });
  });
  return server;
}

let shuttingDown = false;
let ingestServer = null;

async function main() {
  log.info('starting', {
    window: `${config.market.startTime}-${config.market.endTime}`,
    timezone: config.market.timezone,
    tradingDays: config.market.tradingDays,
    scrapers: config.scrapers.enabled,
  });

  const health = await db.healthCheck();
  log.info('database reachable', { version: health.version });

  /**
   * THE THRESHOLDS, BEFORE ANYTHING READS THEM.
   *
   * Loaded once here rather than per query: the fast loop would otherwise ask
   * for the same thirty numbers 1,440 times a session.
   *
   * A missing key FAILS THE BOOT even where a fallback exists. A gate running
   * on a fallback nobody chose is a gate nobody decided — and it looks exactly
   * like a gate that is working.
   */
  await require('./kb/thresholds').load({ strict: true });

  // Applying migrations at boot keeps environments consistent; it is a no-op
  // when everything is already applied.
  await migrate();

  // Say plainly whether the market is open and, if not, why. An idle process
  // that explains itself does not get mistaken for a hung one.
  const status = clock.windowStatus();
  log.info(`market ${status.open ? 'OPEN' : 'CLOSED'} — ${status.reason}`, status);

  // Show the AWSAT login budget BEFORE any job runs. A lockout otherwise
  // announces itself one failed job at a time, three times a minute.
  try {
    const g = require('./scrapers/loginGuard').summary();
    if (g.lockedOut) {
      log.error('AWSAT login is DISABLED — every AWSAT job will fail until cleared', {
        ...g, clearWith: 'npm run awsat:login-state -- --reset-lockout',
      });
    } else {
      log.info('awsat login budget', g);
    }
  } catch (err) {
    log.warn('could not read the AWSAT login guard', { err: err.message });
  }

  const last = await repo.recentRuns();
  if (last.length) {
    for (const r of last) {
      log.info('last run', {
        scraper: r.scraper, status: r.status,
        extracted: r.rows_extracted, inserted: r.rows_inserted,
        at: r.started_at,
      });
    }
  }

  ingestServer = startIngestApi();

  scheduler.start();
  log.info('ready');
}

/**
 * Ordered shutdown: stop taking new work, then release resources. Stopping the
 * scheduler first means nothing new starts while the browser is closing.
 */
async function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutting down', { signal });

  try {
    scheduler.stop();
    if (ingestServer) await new Promise((r) => ingestServer.close(r));
    // Workers own the browsers; stopping them closes those too.
    await workerHost.stopAll();
    await db.close();
    log.info('shutdown complete');
    process.exit(exitCode);
  } catch (err) {
    log.error('error during shutdown', { err: log.serializeError(err) });
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection', { err: log.serializeError(reason) });
});
process.on('uncaughtException', (err) => {
  // Exit NON-ZERO. Exiting 0 after a crash tells systemd, Docker or any other
  // supervisor that the process finished its work successfully, so the restart
  // policy never fires and the scraper simply stays down for the session.
  log.error('uncaught exception — exiting', { err: log.serializeError(err) });
  shutdown('uncaughtException', 1);
});

main().catch(async (err) => {
  log.error('failed to start', { err: log.serializeError(err) });
  await db.close().catch(() => {});
  process.exit(1);
});

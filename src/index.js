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
const holidays = require('./market/holidays');
const db = require('./db/pool');
const { migrate } = require('./db/migrate');
const repo = require('./db/repositories');
const scheduler = require('./scheduler');
const jobs = require('./jobs');
const workerHost = require('./scrapeWorkerHost');
const security = require('./api/ingestSecurity');
const log = require('./logger');
const { shouldMigrateOnBoot } = require('./db/migrateOnBoot');
const thresholdParity = require('./db/thresholdParity');

/**
 * The ingest API is only started when INGEST_TOKEN is set.
 *
 * An unauthenticated write endpoint accepting market data is worse than no
 * endpoint, so absence of the token disables the whole surface rather than
 * defaulting to open.
 */
function startIngestApi() {
  const token = process.env.INGEST_TOKEN;
  /*
   * A SHORT token used to be a log.warn and the API came up anyway. A warning
   * at boot is read once, on the day it is added, by the person who already
   * knows — and what it was guarding is anyone being able to write to the
   * market-data tables, which noticing later does not undo. It now refuses.
   */
  const policy = security.assertTokenPolicy(token);   // throws on a short token
  if (!policy.start) {
    log.info(`ingest API not started — ${policy.reason}`);
    return null;
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
  /*
   * INGEST_ORIGIN is now a comma LIST, and the caller's own origin is echoed
   * back when it matches. Sending the first entry of a list to every caller
   * would allow exactly one of them. '*' is still accepted and still the
   * documented fallback.
   */
  const ALLOW = security.parseOrigins(process.env.INGEST_ORIGIN);
  if (ALLOW.any) {
    log.warn('INGEST_ORIGIN is not set — any browser origin may post. '
      + 'Set it to the broker page and the terminal, comma separated.');
  } else {
    log.info('ingest origin allowlist', { origins: ALLOW.list });
  }

  const limiter = security.createRateLimiter();
  log.info('ingest rate limit', { max: limiter.max, windowMs: limiter.windowMs });

  app.use((req, res, next) => {
    const origin = security.resolveOrigin(req.get('origin'), ALLOW);
    if (origin === null) {
      /*
       * The browser will only ever see a missing header — it discards the
       * response and reports "NetworkError", with nothing in its console
       * naming the cause. So the refusal is loud HERE, where someone can read
       * it, naming the origin that was turned away and what to add.
       */
      log.warn('ingest: origin refused by the allowlist', {
        origin: req.get('origin'), path: req.path, allowed: ALLOW.list,
      });
      return res.status(403).json({
        ok: false,
        error: `origin ${req.get('origin')} is not in INGEST_ORIGIN`,
        hint: 'add it to INGEST_ORIGIN on the server (comma separated) and restart',
      });
    }
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-ingest-token, x-request-id');
    res.set('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') return res.status(204).end();

    /*
     * Rate limit AFTER the preflight answer and BEFORE body parsing, so a
     * client in a tight retry loop cannot make the process parse 8 MB a time.
     * /health is exempt: it is how you find out the service is being
     * rate-limited.
     */
    if (req.path !== '/health') {
      const verdict = limiter.check(req.ip || 'unknown');
      if (!verdict.allowed) {
        log.warn('ingest: rate limited', {
          ip: req.ip, path: req.path, count: verdict.count, max: verdict.max,
        });
        res.set('Retry-After', String(verdict.retryAfterSec));
        return res.status(429).json({
          ok: false,
          error: `too many requests: ${verdict.count} in the last ${Math.round(limiter.windowMs / 1000)}s (max ${verdict.max})`,
          retryAfterSec: verdict.retryAfterSec,
        });
      }
    }
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
    res.set('Access-Control-Allow-Origin', security.resolveOrigin(req.get('origin'), ALLOW) || '*');
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

  // Thresholds come from src/config/thresholds.js — a file, not a table. The
  // scraper no longer reads kb_threshold: a capture service must not refuse to
  // boot because a backend table is missing.
  log.info('thresholds', { source: require('./config/thresholds').summary() });

  /*
   * S5 · MIGRATE_ON_BOOT — off unless somebody said otherwise. See
   * shouldMigrateOnBoot, below this function, for H-E and why the default
   * inverted.
   *
   * Applying migrations at boot keeps a developer's environment consistent and
   * is a no-op once everything is applied. In production it is the wrong shape:
   * a deploy that restarts the process also, silently, changes the schema — so
   * a migration renaming a table holding the trader's order history (039) runs
   * unattended, with no backup taken and nobody watching. The failure mode is
   * not "the migration is wrong"; it is "nobody decided when it ran".
   *
   * In production the deploy step is: back up, `npm run migrate`, restart. If a
   * migration is pending at boot the process REFUSES to start and names it,
   * because starting against a schema the code does not match is how you get a
   * scraper writing to a column that is not there — every minute, for four
   * hours, with the first error long since scrolled away.
   */
  const migrateOnBoot = shouldMigrateOnBoot(process.env);

  if (migrateOnBoot) {
    log.info('MIGRATE_ON_BOOT is on — applying migrations at boot');
    await migrate();
  } else {
    const status = await migrate({ statusOnly: true });
    if (status.pending.length) {
      log.error('REFUSING TO START — migrations are pending and MIGRATE_ON_BOOT is off', {
        pending: status.pending,
        fix: 'back up the database, run `npm run migrate`, then start again',
      });
      throw new Error(
        `${status.pending.length} migration(s) pending: ${status.pending.join(', ')}. `
        + 'Back up, run `npm run migrate`, then start. '
        + 'Set MIGRATE_ON_BOOT=true to apply them at boot instead (not for production).');
    }
    log.info('MIGRATE_ON_BOOT is off — schema is up to date', { applied: status.skipped.length });
  }

  /*
   * P2 · THE DATABASE'S NUMBERS AND THE CODE'S NUMBERS MUST BE THE SAME.
   *
   * Migration 013 hardcodes the at-offer cutoff and the two regime cutoffs,
   * while src/config/thresholds.js makes all three configurable. Set
   * SD_AT_OFFER_MAX=95 and the compute job writes rows the CHECK rejects,
   * failing the whole chunked INSERT and so the day's compute — at 13:35, on a
   * constraint violation nobody is watching for. Move a regime cutoff and there
   * are two live definitions of market_day.regime, the column the trading
   * backend reads to decide whether to trade at all.
   *
   * Checked here rather than left to discovery. See src/db/thresholdParity.js
   * for why the numbers have to be written twice.
   */
  await thresholdParity.assertThresholdParity();

  /*
   * 040 · load the holiday calendar BEFORE the window status is reported, or
   * the boot line would say "market OPEN" on a day the calendar knows is shut.
   */
  await holidays.load();

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
/**
 * How long shutdown may take in total before it stops being polite.
 *
 * F-16 · there was NO timeout anywhere in here, and two of the steps can block
 * for ever: `server.close()` waits for every keep-alive socket, and
 * `pool.end()` waits for every checked-out client — including the dedicated one
 * a running job holds for its advisory lock. Either could park the process
 * until the supervisor's SIGKILL, at which point nothing is flushed anyway and
 * the Chromium children may be orphaned.
 */
const SHUTDOWN_BUDGET_MS = Number(process.env.SHUTDOWN_BUDGET_MS || 30_000);

async function shutdown(signal, exitCode = 0) {
  if (shuttingDown) {
    /*
     * F-16 · the re-entrancy guard is right for a second SIGNAL and wrong for a
     * CRASH during shutdown. It used to return here unconditionally, so an
     * unrelated async throw while shutdown was parked on server.close() meant
     * the uncaughtException handler returned immediately, the original shutdown
     * never resumed, and process.exit was never reached — the process simply
     * stayed alive, with no exit code for the restart policy to see.
     */
    if (exitCode !== 0) {
      log.error('crashed while already shutting down — exiting now', { signal });
      process.exit(exitCode);
    }
    return;
  }
  shuttingDown = true;
  log.info('shutting down', { signal });

  // The whole sequence is bounded. Whatever is stuck, the process leaves.
  const hardStop = setTimeout(() => {
    log.error('shutdown exceeded its budget — exiting anyway', {
      budgetMs: SHUTDOWN_BUDGET_MS, stillRunning: jobs.inFlightJobs(),
    });
    process.exit(exitCode || 1);
  }, SHUTDOWN_BUDGET_MS);
  hardStop.unref();

  try {
    scheduler.stop();

    /*
     * DRAIN BEFORE CLOSING ANYTHING. A job mid-write must be allowed to finish:
     * closing the pool under it loses that minute's captures, leaves its
     * scrape_runs row RUNNING for ever (finishRun throws on the closed pool and
     * is swallowed), and a trading minute cannot be re-scraped.
     */
    const drained = await jobs.drain(Math.floor(SHUTDOWN_BUDGET_MS / 2));
    if (drained.drained) {
      if (drained.waitedMs) log.info('in-flight jobs finished', { waitedMs: drained.waitedMs });
    } else {
      log.warn('in-flight jobs did not finish in time — closing anyway', {
        waitedMs: drained.waitedMs, stillRunning: drained.stillRunning,
        note: 'their writes may be incomplete and their scrape_runs rows left RUNNING',
      });
    }

    if (ingestServer) {
      /*
       * closeIDLEConnections, not closeAllConnections.
       *
       * The problem stated here is idle sockets: server.close() waits for every
       * open keep-alive connection, so one userscript tab sitting idle stalls
       * the whole shutdown before stopAll() or db.close() are reached.
       *
       * P2 · AND THE CALL WAS THE OTHER ONE. Node's closeAllConnections()
       * destroys ALL connections, INCLUDING those currently serving a request.
       * A SIGTERM at 13:05 — a deploy, a container restart — landing while
       * POST /ingest/quotes is inside repo.insertQuotes tore that request's
       * socket out: the client saw a network error for a batch that may or may
       * not have landed, and recordSubmission may not have written the
       * client_submissions row that makes the retry a replay rather than a
       * duplicate. That minute's ~137 quotes cannot be re-scraped.
       *
       * jobs.drain() above does not cover it — it tracks SCHEDULED jobs, and an
       * HTTP handler is not one. Idle sockets are closed, in-flight requests
       * are allowed to finish, and SHUTDOWN_BUDGET_MS is still the backstop if
       * one never does.
       */
      if (typeof ingestServer.closeIdleConnections === 'function') {
        ingestServer.closeIdleConnections();
      }
      await new Promise((r) => ingestServer.close(r));
    }
    // Workers own the browsers; stopping them closes those too.
    await workerHost.stopAll();
    await db.close();
    clearTimeout(hardStop);
    log.info('shutdown complete');
    process.exit(exitCode);
  } catch (err) {
    clearTimeout(hardStop);
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

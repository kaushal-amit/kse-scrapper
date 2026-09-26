'use strict';
/**
 * All configuration in one place, read from the environment once at startup.
 *
 * Values are validated here rather than at the point of use, so a bad setting
 * fails immediately with a clear message instead of surfacing mid-session as a
 * confusing runtime error.
 */

require('dotenv').config();

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

function bool(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v === 'true' || v === '1';
}

/**
 * A comma list from the environment.
 *
 * F-18 · UNSET and EXPLICITLY EMPTY are different things.
 *
 * This returned the fallback for both, so an operator writing
 * `ENABLED_SCRAPERS=` — the natural way to say "run nothing" — got all thirteen
 * jobs instead, including the AWSAT ones. The worker launched Chromium, logged
 * in, and spent one of the day's TWO login attempts doing the exact opposite of
 * what was asked. And `scheduler.js`'s "no scrapers enabled" warning never
 * fired, because thirteen were.
 *
 * Unset means "no opinion, use the default". Empty means "none", and the two
 * cannot share an answer when getting it wrong costs a login attempt.
 */
function list(name, fallback) {
  const v = process.env[name];
  if (v === undefined) return fallback;
  if (v.trim() === '') return [];
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

/** 'HH:MM' -> minutes since midnight. Rejects anything malformed. */
function parseTime(name, fallback) {
  // F-18 · an explicitly empty START_TIME=/END_TIME= is a mistake, not a
  // request for the default: it silently moved the capture window. Same class
  // as list() above, lower cost.
  if (process.env[name] !== undefined && String(process.env[name]).trim() === '') {
    throw new Error(`${name} is set but empty. Remove it to use the default (${fallback}), `
      + 'or give it a value — an empty setting silently moved the capture window.');
  }
  const raw = process.env[name] || fallback;
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!m) throw new Error(`${name} must be HH:MM (got "${raw}")`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`${name} is not a valid time: "${raw}"`);
  return { text: `${String(h).padStart(2, '0')}:${m[2]}`, minutes: h * 60 + min };
}

let config;
try {
  config = buildConfig();
} catch (err) {
  // A configuration mistake is the most common way this process fails to start,
  // and a raw stack trace pointing at config.js tells an operator nothing about
  // which variable is wrong. Fail with the sentence they need instead.
  process.stderr.write(`\nConfiguration error: ${err.message}\n`);
  process.stderr.write('Check your .env file against .env.example.\n\n');
  process.exit(1);
}

function buildConfig() {
  const start = parseTime('START_TIME', '09:00');
  /*
   * S8 · 13:30, not 13:00.
   *
   * Boursa Kuwait's continuous trading runs to 13:30. A 13:00 window stopped
   * half an hour before the close and never captured the closing prints, so the
   * day's high, low and close were built from a session that was still running.
   */
  const end = parseTime('END_TIME', '13:30');

  /*
   * S8 · THE SIGNAL WINDOW IS NOT THE CAPTURE WINDOW.
   *
   * Capture runs to the close because the closing prints are data. The fast
   * loop and the wake-up scan must NOT: they fire alerts a human is expected to
   * act on, and there is no acting on a signal raised at 13:29 when continuous
   * trading ends at 13:30. Defaults to 13:00 — the last half hour is captured
   * and not alerted on.
   *
   * Defaults to END_TIME when that is earlier, so a narrowed capture window
   * cannot leave the signal window hanging past it.
   */
  /*
   * ─── THE CAPTURE WINDOW IS NOT THE SESSION WINDOW ────────────────────────
   *
   * START_TIME/END_TIME drive the SCHEDULER, and the after-close jobs are
   * derived from END_TIME at +1, +5 and +12 minutes. Moving END_TIME to 13:20
   * to stop capture would move daily.instruments, daily.symbolday and
   * daily.marketday with it — the exact trap src/scheduler.js's own header
   * warns about, and the reason those two jobs did not run on 24 September.
   *
   * So the window the INGEST enforces is its own pair:
   *
   *   08:40  nothing earlier. A pre-open capture with no session label carries
   *          the PREVIOUS session's cumulative totals — 20 September stored
   *          1,022 such rows and 79 of 140 symbols still read 17 September's
   *          trades and volume.
   *   13:20  nothing at or after. Close-Of-Day starts 13:15, so the final
   *          print is in; on 24 September the client was still saving at
   *          16:22, 17,640 price rows and 16,086 depth rows past the close.
   */
  const captureStart = parseTime('CAPTURE_START_TIME', '08:40');
  const captureEnd = parseTime('CAPTURE_END_TIME', '13:20');
  /*
   * ─── THE CONTINUOUS SESSION, WHICH IS NOT THE CAPTURE WINDOW (049) ────────
   *
   * Continuous trading runs 09:00-13:00: 240 minutes. The capture door is
   * 08:40-13:20: 280. They are different questions — what may reach the table
   * versus what counts as capture length — and symbol_day.coverage_pct is the
   * second one, because the analyses that consume it consume the continuous
   * session. Pre-open capture is useful and its absence is not a data-quality
   * failure for anything downstream.
   *
   * Conflating them put 13 September at 108% coverage: 259 captured minutes
   * counted from 08:40, divided by a 240-minute session.
   */
  const sessionStart = parseTime('SESSION_START_TIME', '09:00');
  const sessionEnd = parseTime('SESSION_END_TIME', '13:00');
  /*
   * ─── 051 · THE CLOSE-OF-DAY BACKSTOP ─────────────────────────────────────
   *
   * The ingest door shuts at 13:20 for the board and opens for the FIRST
   * Close-Of-Day row per symbol, because the closing print is not reliably in
   * by then. Measured: 13:15 on 23 September (the one day captured
   * continuously through the transition), 13:25 on 13 August, 14:43 on 24
   * September — the last two on the far side of a 15- and a 92-minute gap in
   * our own capture, so they are LOOKING times, not publication times.
   *
   * "Whenever it arrives" is unbounded and a stuck page would deliver a stale
   * board at 22:00, so it is bounded. The number is set from the one OBSERVED
   * publication time, 13:15, and NOT from 14:43 — picking a threshold from an
   * artefact is picking another 13:20 with worse evidence.
   *
   * It is deliberately loose because the two errors do not cost the same: a
   * genuine late publication refused leaves a day with no close at all, while
   * a stale board accepted arrives marked cod_late and alarmed.
   */
  const codBackstop = parseTime('COD_BACKSTOP_TIME', '15:00');
  if (captureStart.minutes >= captureEnd.minutes) {
    throw new Error(`CAPTURE_START_TIME (${captureStart.text}) must be before `
      + `CAPTURE_END_TIME (${captureEnd.text}) — an empty capture window stores nothing at all`);
  }

  const signalsEnd = parseTime('SIGNALS_END_TIME', '13:00');
  if (signalsEnd.minutes > end.minutes) {
    throw new Error(
      `SIGNALS_END_TIME (${signalsEnd.text}) is after END_TIME (${end.text}) — `
      + 'the fast loop would be scheduled past the capture window and evaluate '
      + 'minutes nothing was captured for.');
  }

  if (end.minutes <= start.minutes) {
    throw new Error(`END_TIME (${end.text}) must be after START_TIME (${start.text})`);
  }

  const tradingDays = list('TRADING_DAYS', ['0', '1', '2', '3', '4']).map(Number);
  for (const d of tradingDays) {
    if (!Number.isInteger(d) || d < 0 || d > 6) {
      throw new Error(`TRADING_DAYS must be integers 0-6 (0=Sunday); got "${d}"`);
    }
  }

  // Boursa Kuwait's weekend is FRIDAY and SATURDAY. Including either is almost
  // always a typo carried over from a Mon-Fri week, and it fails silently: the
  // scraper simply runs on a day the exchange is shut, logs into the broker
  // (spending one of the day's limited attempts), and stores a board that never
  // changes. Seen live — a Friday run reported "market OPEN".
  const WEEKEND = { 5: 'Friday', 6: 'Saturday' };
  const onWeekend = tradingDays.filter((d) => WEEKEND[d]);
  if (onWeekend.length) {
    const names = onWeekend.map((d) => `${d}=${WEEKEND[d]}`).join(', ');
    if (process.env.ALLOW_WEEKEND_TRADING === 'true') {
      // Once per process, and not in worker threads: each worker re-loads this
      // module, so an unconditional warning printed four more times per run and
      // interleaved with the logs.
      let isWorker = false;
      try { isWorker = !require('worker_threads').isMainThread; } catch { /* older node */ }
      if (!isWorker) {
        process.stderr.write(
          `\nWARNING: TRADING_DAYS includes ${names}, which is the Kuwaiti weekend.\n`
          + '  Allowed because ALLOW_WEEKEND_TRADING=true.\n\n',
        );
      }
    } else {
      throw new Error(
        `TRADING_DAYS includes ${names} — the Kuwaiti weekend.\n`
        + '  Boursa Kuwait trades Sunday to Thursday, so this should be:\n'
        + '      TRADING_DAYS=0,1,2,3,4\n'
        + '  Running on a closed day logs into the broker for nothing, which spends\n'
        + '  one of the day\'s limited login attempts.\n'
        + '  Set ALLOW_WEEKEND_TRADING=true if this is deliberate (another exchange).',
      );
    }
  }

  // A timezone typo must not silently fall back to the server's own zone, which
  // would put the whole schedule hours out with nothing to show for it.
  const timezone = process.env.MARKET_TIMEZONE || 'Asia/Kuwait';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new Error(`MARKET_TIMEZONE is not a valid IANA timezone: "${timezone}"`);
  }

  return {
  db: {
    url: required('DATABASE_URL'),
    // TLS is resolved in src/db/sslMode.js from DB_SSL_MODE (DB_SSL is the
    // deprecated boolean). It deliberately does NOT live here: pool.js is the
    // only consumer, and a second copy of the decision is how the old hardcoded
    // `rejectUnauthorized: false` came to override the config without anyone
    // noticing the config was still being computed.
    sslMode: process.env.DB_SSL_MODE || null,
  },

  market: {
    timezone,
    startTime: start.text,
    endTime: end.text,
    startMinutes: start.minutes,
    endMinutes: end.minutes,
    // The INGEST's window (08:40-13:20), separate from the scheduler's above.
    captureStartTime: captureStart.text,
    captureEndTime: captureEnd.text,
    captureStartMinutes: captureStart.minutes,
    captureEndMinutes: captureEnd.minutes,
    // CONTINUOUS TRADING (09:00-13:00) — the denominator for capture quality.
    // Not the ingest door above; see the block beside parseTime.
    sessionStartTime: sessionStart.text,
    sessionEndTime: sessionEnd.text,
    sessionStartMinutes: sessionStart.minutes,
    sessionEndMinutes: sessionEnd.minutes,
    // 051 · the latest a closing print may cross the shut door.
    codBackstopTime: codBackstop.text,
    codBackstopMinutes: codBackstop.minutes,
    signalsEndTime: signalsEnd.text,
    signalsEndMinutes: signalsEnd.minutes,
    tradingDays,
  },

  scrapers: {
    /**
     * Every job, unless ENABLED_SCRAPERS narrows it.
     *
     * tradingview.history and daily.analysis were added later and never got
     * into this list, so on a fresh install with no ENABLED_SCRAPERS set they
     * were silently absent from the schedule — the boot log showed four jobs
     * and nobody would look for a fifth that had never appeared.
     */
    enabled: list('ENABLED_SCRAPERS', [
      'tradingview.quotes', 'tradingview.history', 'daily.analysis',
      'awsat.board', 'awsat.depth', 'awsat.orders',
      // Step 3. A job added without being listed here is never scheduled, and
      // nothing says so — the boot log simply shows one fewer job than
      // expected. That has now happened twice.
      'signals.fast', 'signals.wakeup', 'signals.score',
      'daily.instruments', 'daily.symbolday', 'daily.minutesample', 'daily.marketday',
      // D2 · the watchdog. It runs DURING the session, which is the only time
      // a capture stop can still be fixed rather than recorded.
      'session.gapwatch',
    ]),
  },

  tradingview: {
    url: process.env.TRADINGVIEW_URL
      || 'https://www.tradingview.com/markets/stocks-kuwait/market-movers-all-stocks/',
  },

  awsat: {
    /**
     * WHERE AWSAT DATA COMES FROM. One knob, three values.
     *
     *   server  Chromium logs in and scrapes. The ingest API REFUSES AWSAT
     *           writes, so a userscript left running cannot also contribute.
     *   client  Only the Tampermonkey scripts collect. The scheduled AWSAT
     *           jobs are skipped, and no login attempt is spent.
     *   off     Neither.
     *
     * A single setting rather than two booleans, because two booleans can both
     * be true. The requirement is that the same data is never collected from
     * both sides at once, and the cheapest way to guarantee that is to make the
     * contradictory state unrepresentable.
     */
    mode: (() => {
      const raw = (process.env.AWSAT_MODE || 'server').trim().toLowerCase();
      if (!['server', 'client', 'off'].includes(raw)) {
        throw new Error(`AWSAT_MODE must be server, client or off (got "${raw}")`);
      }
      return raw;
    })(),
    url: process.env.AWSAT_URL || 'https://www.awsatbroker.com',
    user: process.env.AWSAT_USER || '',
    pass: process.env.AWSAT_PASS || '',
    // Depth cannot cover the whole market every minute through one terminal.
    // Empty means the depth scraper stays off rather than half-covering.
    depthSymbols: list('DEPTH_SYMBOLS', []),
  },

  runtime: {
    headless: bool('HEADLESS', true),
    logLevel: process.env.LOG_LEVEL || 'info',
  },
  };
}

module.exports = { config };

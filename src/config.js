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

function list(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return fallback;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

/** 'HH:MM' -> minutes since midnight. Rejects anything malformed. */
function parseTime(name, fallback) {
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
  const end = parseTime('END_TIME', '13:00');

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
    ssl: bool('DB_SSL', false),
  },

  market: {
    timezone,
    startTime: start.text,
    endTime: end.text,
    startMinutes: start.minutes,
    endMinutes: end.minutes,
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
      'daily.instruments', 'daily.symbolday', 'daily.marketday',
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

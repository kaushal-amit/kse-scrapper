'use strict';
/**
 * F-12 · THE GUARD FOR THE WHOLE CLASS — no threshold lives outside
 * src/config/thresholds.js.
 *
 * scraper-thresholds.test.js asserts the positive: the sanctioned file holds
 * the keys it should and nothing reads kb_threshold. This is its inverse, and
 * it is the one that stops the problem recurring: it FAILS when someone
 * introduces a new `const SOMETHING = Number(process.env.X || 42)` anywhere in
 * src/.
 *
 * WHY THAT PATTERN AND NOT "any number in the code". A magic number in an
 * expression is a different, much noisier problem. The `env || literal`
 * constant is the specific shape a THRESHOLD takes in this codebase — a value
 * somebody decided, given a name, and made configurable — and it is the shape
 * that drifts, because two files can each define one and disagree.
 *
 * The 14 Sep review found sixteen of them across six files, and the one with
 * teeth was writeSymbolMinute.js defining SIG_BIG_QTY / SIG_WALL_QTY as its own
 * literals while signals.js read the same two concepts from the threshold file:
 * set one and not the other and `symbol_minute.is_frozen` (persisted, read by
 * the backend) and `signals.frozen()` (fires the alert) disagreed about what
 * "big" means, in the same row.
 *
 * ALLOWED lists what is NOT a threshold, each with a reason. Adding to it is
 * meant to be a deliberate act — the list is the argument.
 */
const fs = require('fs');
const path = require('path');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };

const SRC = path.join(__dirname, '..', '..', 'src');

/**
 * Environment variables that configure the RUNTIME rather than a market rule.
 * A threshold is a number about the market or the strategy; these are about
 * the machine, the deployment or a test harness.
 */
const ALLOWED = new Set([
  // Connection, process, deployment.
  'DATABASE_URL', 'DB_SSL', 'DB_SSL_MODE', 'DB_SSL_CA_FILE', 'NODE_ENV', 'TZ',
  'MIGRATE_ON_BOOT', 'SHUTDOWN_BUDGET_MS', 'LOG_LEVEL', 'LOG_FORMAT',
  'INGEST_PORT', 'INGEST_TOKEN', 'INGEST_ORIGIN', 'INGEST_BODY_LIMIT',
  'INGEST_MAX_ROWS', 'INGEST_RATE_MAX', 'INGEST_RATE_WINDOW_MS',
  'INGEST_TOKEN_MIN_LENGTH', 'DEBUG_MAX_ITEMS', 'DEBUG_MAX_BYTES', 'DEBUG_KEEP',
  // Browser and scraping mechanics — how to drive a page, not what to conclude.
  'HEADLESS', 'CHROMIUM_PATH', 'CHROMIUM_SINGLE_PROCESS', 'AWSAT_URL', 'AWSAT_USER',
  'AWSAT_PASS', 'AWSAT_MODE', 'AWSAT_MARKETS', 'AWSAT_KEEP_MARKETS', 'AWSAT_BOARD_MODE',
  'AWSAT_SOCKET_WAIT_MS', 'AWSAT_SOCKET_MIN_ROWS', 'AWSAT_SETTLE_MS', 'AWSAT_DATA_WAIT_MS',
  'AWSAT_MAX_STALLS', 'AWSAT_SCROLL_CAP', 'AWSAT_WHEEL_DELTA', 'AWSAT_ALLOW_HEADLESS',
  'AWSAT_LOGIN_STATE', 'AWSAT_MAX_LOGIN_ATTEMPTS', 'AWSAT_LOGIN_COOLDOWN_MS',
  'AWSAT_SOURCE_PRECEDENCE', 'AWSAT_STALE_AFTER_MS',
  'TRADINGVIEW_URL', 'TRADINGVIEW_EXCHANGE', 'TRADINGVIEW_MARKET', 'TRADINGVIEW_COOKIES',
  'TRADINGVIEW_LOGIN_URL', 'TRADINGVIEW_INTERVAL', 'TV_MAX_SCROLLS', 'TV_SCRAPE_TIMEOUT_MS',
  'DISCOVER_WATCH_MS', 'SCRAPE_STALE_AFTER_MS', 'MARKET_TIMEZONE',
  // Schedules and windows — clock CONFIGURATION, and every one of them is
  // already derived from START_TIME/END_TIME rather than written twice.
  'START_TIME', 'END_TIME', 'SIGNALS_END_TIME', 'TRADING_DAYS', 'ALLOW_WEEKEND_TRADING',
  'HISTORY_CRON', 'ANALYSIS_CRON', 'INSTRUMENTS_CRON', 'SYMBOLDAY_CRON', 'MARKETDAY_CRON',
  'SCORE_CRON', 'FAST_LOOP_CRON', 'WAKEUP_CRON', 'ENABLED_SCRAPERS', 'EXPECTED_SCRIPTS',
  // Sizes and budgets of WORK, not of the market.
  'HISTORY_DAYS', 'HISTORY_MAX_SYMBOLS', 'DEPTH_SYMBOLS', 'DEPTH_MAX_SYMBOLS', 'SLOT_COUNT',
  'NOTIFY_URL', 'NOTIFY_TOKEN', 'NOTIFY_TIMEOUT_MS', 'NOTIFY_MIN_GAP_MS',
  'MIGRATE_FROM', 'MIGRATE_TO', 'RUN_DATE', 'LABEL_CONFIDENCE', 'FIX_TIMEOUT_MS',
  'SEED_TIMEOUT_MS', 'SIG_SHAPE_ERROR_LIMIT', 'FROZEN_CAPTURES',
]);

function walk(dir, acc = []) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const q = path.join(dir, f.name);
    if (f.isDirectory()) { if (!/migrations|node_modules/.test(q)) walk(q, acc); }
    else if (f.name.endsWith('.js')) acc.push(q);
  }
  return acc;
}

const files = walk(SRC);
ck('there are source files to check', files.length > 20, files.length);

/**
 * `Number(process.env.X || 42)` / `process.env.X || 42` / `?? 42` bound to a
 * name. The literal is what makes it a threshold rather than a passthrough.
 */
const PATTERN = /process\.env\.([A-Z0-9_]+)\s*(?:\|\||\?\?)\s*(-?\d[\d_.]*)/g;

const offenders = [];
for (const file of files) {
  const rel = path.relative(path.join(SRC, '..'), file);
  // The sanctioned home is allowed to be exactly this shape — that is its job.
  if (rel === 'src/config/thresholds.js') continue;

  const text = fs.readFileSync(file, 'utf8');
  // Live code only. A comment explaining a removed threshold is not one.
  const live = text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  for (const m of live.matchAll(PATTERN)) {
    const [, name, literal] = m;
    if (ALLOWED.has(name)) continue;
    offenders.push(`${rel}: ${name} || ${literal}`);
  }
}

ck('NO threshold literal lives outside src/config/thresholds.js',
  offenders.length === 0, offenders);

// ── and the sanctioned file is reachable and complete ───────────────────────
{
  const T = require('../../src/config/thresholds');
  ck('the threshold file exports its keys', Object.keys(T.all()).length > 10, Object.keys(T.all()).length);
  ck('an unknown key THROWS rather than returning undefined — undefined makes a '
    + 'gate never fire', (() => { try { T.get('nope'); return false; } catch { return true; } })());
}

// ── the specific divergence the review found ────────────────────────────────
{
  const writer = fs.readFileSync(path.join(SRC, 'jobs/writeSymbolMinute.js'), 'utf8');
  const live = writer.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  ck('writeSymbolMinute no longer defines its own BIG_QTY',
    !/SIG_BIG_QTY\s*\|\|/.test(live), (live.match(/.*SIG_BIG_QTY.*/) || [])[0]);
  ck('nor its own WALL_QTY',
    !/SIG_WALL_QTY\s*\|\|/.test(live), (live.match(/.*SIG_WALL_QTY.*/) || [])[0]);
  ck('and it reads the same source signals.js does',
    /config\/thresholds/.test(writer), 'writeSymbolMinute does not read the threshold file');
}

console.log(`\nno threshold literals: ${p}/${n}`);
process.exit(p === n ? 0 : 1);

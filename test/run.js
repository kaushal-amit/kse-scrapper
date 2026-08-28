'use strict';
/**
 * The test suite.
 *
 *   node test/run.js
 *
 * Needs a reachable PostgreSQL (DATABASE_URL) and applied migrations. It writes
 * to the configured database using a distinct source tag and cleans up after
 * itself, so it is safe to run against a development database.
 *
 * Deliberately plain Node with no test framework: the assertions are simple and
 * a dependency here would buy reporters nobody has asked for.
 */

const assert = require('assert');
const clock = require('../src/market/clock');
const parse = require('../src/scrapers/parse');
const transform = require('../src/scrapers/transform');
const validate = require('../src/validate');
const repo = require('../src/db/repositories');
const db = require('../src/db/pool');
const { config } = require('../src/config');

const TAG = 'selftest';
let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    const r = fn();
    if (r instanceof Promise) return r.then(() => { passed += 1; }, (e) => { failed += 1; failures.push([name, e]); });
    passed += 1;
  } catch (e) {
    failed += 1;
    failures.push([name, e]);
  }
  return Promise.resolve();
}

// ── 1. schedule ─────────────────────────────────────────────────────────────
// The requirement is Sunday-Thursday, 09:00-13:00 Asia/Kuwait, independent of
// where the server itself is. Each case is a UTC instant; Kuwait is UTC+3.

async function scheduleTests() {
  const cases = [
    ['2026-08-16T05:59:59Z', false, 'Sun 08:59:59 — one second before open'],
    ['2026-08-16T06:00:00Z', true, 'Sun 09:00:00 — open boundary is inclusive'],
    ['2026-08-16T09:59:59Z', true, 'Sun 12:59:59 — final second'],
    ['2026-08-16T10:00:00Z', false, 'Sun 13:00:00 — close boundary is exclusive'],
    ['2026-08-17T08:00:00Z', true, 'Mon 11:00'],
    ['2026-08-18T08:00:00Z', true, 'Tue 11:00'],
    ['2026-08-19T08:00:00Z', true, 'Wed 11:00'],
    ['2026-08-20T08:00:00Z', true, 'Thu 11:00 — last trading day'],
    ['2026-08-21T08:00:00Z', false, 'FRIDAY 11:00 — weekend'],
    ['2026-08-22T08:00:00Z', false, 'SATURDAY 11:00 — weekend'],
    ['2026-08-16T21:00:00Z', false, 'Mon 00:00 — midnight rollover'],
    ['2026-08-16T20:00:00Z', false, 'Sun 23:00 — late evening'],
  ];

  for (const [iso, want, desc] of cases) {
    await test(`schedule: ${desc}`, () => {
      assert.strictEqual(clock.isWithinWindow(new Date(iso)), want, desc);
    });
  }

  await test('schedule: trading day is the Kuwait date, not the UTC date', () => {
    // 21:30 UTC Sunday is 00:30 Monday in Kuwait.
    assert.strictEqual(clock.tradingDay(new Date('2026-08-16T21:30:00Z')), '2026-08-17');
  });

  await test('schedule: does not depend on the server timezone', () => {
    // TZ is read by Date's local methods, not by Intl with an explicit zone.
    const before = process.env.TZ;
    try {
      for (const tz of ['UTC', 'America/New_York', 'Asia/Tokyo', 'Pacific/Kiritimati']) {
        process.env.TZ = tz;
        assert.strictEqual(
          clock.isWithinWindow(new Date('2026-08-16T06:00:00Z')), true,
          `open instant misread under TZ=${tz}`,
        );
        assert.strictEqual(
          clock.isWithinWindow(new Date('2026-08-21T08:00:00Z')), false,
          `Friday misread under TZ=${tz}`,
        );
      }
    } finally {
      if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
    }
  });

  await test('schedule: minute buckets are aligned', () => {
    const b = clock.minuteBucket(new Date('2026-08-16T06:30:47.913Z'));
    assert.strictEqual(b.getSeconds(), 0);
    assert.strictEqual(b.getMilliseconds(), 0);
  });

  await test('schedule: cron hour range stops before the close hour', () => {
    const { expressionFor } = require('../src/scheduler');
    const expr = expressionFor(5);
    const endHour = Math.floor((config.market.endMinutes - 1) / 60);
    assert.ok(expr.includes(`-${endHour}`), `expected range ending at ${endHour}, got "${expr}"`);
    assert.ok(require('node-cron').validate(expr), `invalid cron: ${expr}`);
  });
}

// ── 2. parsing and transformation ───────────────────────────────────────────

async function transformTests() {
  await test('parse: human-formatted numbers', () => {
    assert.strictEqual(parse.toNumber('1,234.50'), 1234.5);
    assert.strictEqual(parse.toNumber('(45.2)'), -45.2);      // accounting negative
    assert.strictEqual(parse.toNumber('1.24M'), 1240000);
    assert.strictEqual(parse.toNumber('12.5%'), 12.5);
    assert.strictEqual(parse.toNumber('0'), 0);               // zero is not "missing"
  });

  await test('parse: absent values become null, never NaN or 0', () => {
    for (const blank of ['', '-', '—', 'N/A', null, undefined, 'abc']) {
      assert.strictEqual(parse.toNumber(blank), null, `"${blank}" should parse to null`);
    }
  });

  await test('parse: symbols normalise across both sources', () => {
    assert.strictEqual(parse.toSymbol('KSE:ABAR'), 'ABAR');
    assert.strictEqual(parse.toSymbol('ABAR  Al Arabi'), 'ABAR');
    assert.strictEqual(parse.toSymbol('  zain '), 'ZAIN');
  });

  const header = ['Symbol', 'Name', 'Price', 'Chg', 'Chg %', 'Vol'];
  const meta = {
    minuteBucket: clock.minuteBucket(new Date()),
    tradingDay: clock.tradingDay(),
    capturedAt: new Date(),
    source: TAG,
    runId: null,
  };
  const ALIASES = {
    last: ['price', 'last'], change_amount: ['chg', 'change'],
    change_percent: ['chg %', 'change %'], volume: ['vol', 'volume'],
  };

  await test('transform: header row is never stored as an instrument', () => {
    const out = transform.buildQuotes(header, [header, ['ABAR', 'Al Arabi', '176', '+2', '+1.2%', '1.2M']], ALIASES, meta);
    assert.strictEqual(out.quotes.length, 1);
    assert.strictEqual(out.quotes[0].symbol, 'ABAR');
  });

  await test('transform: exact header match beats a prefix match', () => {
    // "chg" must not capture the "chg %" column.
    const idx = transform.resolveColumns(header, ALIASES);
    assert.strictEqual(idx.change_amount, 3);
    assert.strictEqual(idx.change_percent, 4);
  });

  await test('transform: a column inserted upstream does not shift the data', () => {
    const h2 = ['Symbol', 'Name', 'NEW', 'Price', 'Chg', 'Chg %', 'Vol'];
    const out = transform.buildQuotes(h2, [h2, ['ABAR', 'Al Arabi', 'x', '176', '+2', '+1.2%', '1.2M']], ALIASES, meta);
    assert.strictEqual(out.quotes[0].last_price, 176);
  });

  await test('transform: a suspended symbol with no prices is KEPT, not dropped', () => {
    // Regression: an all-blank row was being mistaken for a header and silently
    // discarded, losing exactly the rows most worth noticing.
    const out = transform.buildQuotes(header, [header, ['ABAR', 'Al Arabi', '—', '', '—', '']], ALIASES, meta);
    assert.strictEqual(out.quotes.length, 1);
    assert.strictEqual(out.quotes[0].last_price, null);
  });

  await test('transform: price coverage detects selector drift', () => {
    const good = transform.buildQuotes(header, [header, ['A', 'x', '1', '', '', '']], ALIASES, meta);
    assert.strictEqual(transform.priceCoverage(good.quotes), 1);
    const drifted = transform.buildQuotes([], [['A', 'x', '—', '—', '—', '—']], ALIASES, meta);
    assert.strictEqual(transform.priceCoverage(drifted.quotes), 0);
  });

  await test('transform: depth levels number sequentially and cap at 20', () => {
    const rows = Array.from({ length: 30 }, (_, i) => [`${i * 10}`, `${100 - i}`, `${200 + i}`, `${i * 5}`]);
    const levels = transform.buildDepthLevels(rows, 'ABAR', meta);
    assert.strictEqual(levels.length, 20);
    assert.strictEqual(levels[0].level, 1);
    assert.strictEqual(levels[19].level, 20);
  });

  await test('transform: an order without an id is dropped, one without a symbol is kept', () => {
    const rows = [
      ['A1', 'ABAR', 'Buy', 'FILLED', '176', '1000', '1000'],
      ['', 'ABAR', 'Buy', 'OPEN', '176', '10', '0'],
      ['A3', '', 'Sell', 'OPEN', '177', '500', '0'],
    ];
    const orders = transform.buildOrders(rows, meta);
    assert.strictEqual(orders.length, 2);
    assert.strictEqual(orders[0].remaining_qty, 0);
    assert.strictEqual(orders[1].symbol, null);
  });
}

// ── 3. validation ───────────────────────────────────────────────────────────

async function validationTests() {
  const base = {
    symbol: 'ABAR', market: 'Premier Market',
    trading_date: clock.tradingDay(), created_at: new Date(), source: TAG,
  };

  await test('validate: a negative price rejects the row', () => {
    assert.strictEqual(validate.validateQuote({ ...base, last_price: -5 }).ok, false);
  });

  await test('validate: an absurd price rejects the row', () => {
    assert.strictEqual(validate.validateQuote({ ...base, last_price: 9e9 }).ok, false);
  });

  await test('validate: a bad volume is nulled, not fatal to the price', () => {
    const r = validate.validateQuote({ ...base, last_price: 176, volume: -3 });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.row.volume, null);
    assert.strictEqual(r.row.last_price, 176);
  });

  await test('validate: a missing market rejects the row', () => {
    // awsat_market_quotes is keyed on market; without one the
    // row cannot be deduplicated and would duplicate on every sweep.
    assert.strictEqual(validate.validateQuote({ ...base, market: null }).ok, false);
  });

  await test('validate: filled > quantity keeps the order but drops the pair', () => {
    const r = validate.validateOrder({
      order_id: 'X', created_at: new Date(), quantity: 100, filled_quantity: 500,
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.row.filled_quantity, null);
  });
}

// ── 4. persistence (production table names) ────────────────────────────────

async function persistenceTests() {
  const day = clock.tradingDay();
  const createdAt = new Date();
  const runId = await repo.startRun(`${TAG}.job`, day);

  const q = (market, symbol, price) => ({
    scrape_batch_id: null, market, symbol, code: '1', description: 'test',
    last_price: price, chg: -2.5, pct_chg: -1.1, volume: 1000,
    bid: price - 1, offer: price + 1, trades: 5,
    trading_date: day, source: TAG, run_id: runId, created_at: createdAt,
  });

  await test('persist: reference data upserts per market', async () => {
    const r = await repo.upsertSymbols([
      { market: 'Premier Market', symbol: 'TSTA' },
      { market: 'Main Market', symbol: 'TSTA' },
      { market: 'Premier Market', symbol: 'TSTA' },
    ]);
    // ONE row since migration 026: a stock moving Main -> Auction is the same
    // stock, and (market, symbol) made it a second one. All three collapse to
    // a single symbol, and the last market wins.
    assert.strictEqual(r.offered, 1);
  });

  await test('persist: awsat_market_quotes stores both markets', async () => {
    const r = await repo.insertQuotes([q('Premier Market', 'TSTA', 176), q('Main Market', 'TSTB', 540)]);
    assert.strictEqual(r.inserted, 2);
  });

  await test('persist: re-scraping the same capture inserts nothing new', async () => {
    const r = await repo.insertQuotes([q('Premier Market', 'TSTA', 999)]);
    assert.strictEqual(r.inserted, 0);
  });

  await test('persist: the original values survive a duplicate scrape', async () => {
    const { rows } = await db.query(
      'SELECT last_price, chg FROM awsat_market_quotes WHERE symbol = $1', ['TSTA']);
    assert.strictEqual(Number(rows[0].last_price), 176);
    assert.strictEqual(Number(rows[0].chg), -2.5, 'a negative change must survive');
  });

  await test('persist: ONE bad row does not destroy the batch', async () => {
    const later = new Date(createdAt.getTime() + 60_000);
    const at = (s, p) => ({ ...q('Premier Market', s, p), created_at: later });
    const r = await repo.insertQuotes([at('TSTA', 176), at('TSTB', -5)]);
    assert.strictEqual(r.inserted, 1, 'the good row must be stored');
    assert.strictEqual(r.rejected, 1, 'the bad row must be reported, not hidden');
  });

  await test('persist: awsat_stock_depth deduplicates per capture', async () => {
    const at = new Date();
    const levels = [1, 2, 3].map((level) => ({
      symbol: 'TSTA', level, bid: 176 - level, bid_qty: 1000, bid_orders: null,
      offer: 177 + level, offer_qty: 900, offer_orders: null,
      trading_date: day, run_id: runId, created_at: at,
    }));
    assert.strictEqual((await repo.insertDepth(levels)).inserted, 3);
    assert.strictEqual((await repo.insertDepth(levels)).inserted, 0);
  });

  await test('persist: awsat_order_list keeps ONE row per order', async () => {
    // Orders are upserted on order_id, so re-seeing an order updates it rather
    // than logging another sighting. Ten orders means ten rows, however many
    // times the scraper runs.
    const at = new Date();
    const orders = [
      { order_id: `${TAG}-1`, symbol: 'TSTA', side: 'BUY', order_status: 'OPEN', price: 176, quantity: 1000, filled_quantity: 0, remaining_qty: 1000, order_time: null, trading_date: day, run_id: runId, created_at: at },
      // symbol nullable on purpose: an order whose symbol cell fails to parse
      // still carries a real id, price and quantity.
      { order_id: `${TAG}-2`, symbol: null, side: 'SELL', order_status: 'OPEN', price: 177, quantity: 500, filled_quantity: 0, remaining_qty: 500, order_time: null, trading_date: day, run_id: runId, created_at: at },
    ];
    assert.strictEqual((await repo.insertOrders(orders)).inserted, 2);

    // Seen again a minute later: still two rows, not four.
    const later = orders.map((o) => ({ ...o, created_at: new Date(at.getTime() + 60_000) }));
    await repo.insertOrders(later);
    const { rows } = await db.query(
      'SELECT count(*)::int AS c FROM awsat_order_list WHERE order_id LIKE $1', [`${TAG}%`]);
    assert.strictEqual(rows[0].c, 2, 'a repeat sighting must not add a row');
  });

  await test('persist: tradingview_history upserts a restated bar', async () => {
    const bar = { symbol: 'TSTA', trade_date: '2026-08-19', open_price: 176, high_price: 180, low_price: 175, close_price: 178, change_value: -2, change_pct: null, volume: 1000, source: TAG, run_id: runId };
    assert.strictEqual((await repo.upsertDailyPrices([bar])).inserted, 1);
    await repo.upsertDailyPrices([{ ...bar, close_price: 183 }]);
    const { rows } = await db.query("SELECT close_price FROM tradingview_history WHERE symbol='TSTA'");
    assert.strictEqual(Number(rows[0].close_price), 183);
  });

  await test('persist: the run is recorded with its counts', async () => {
    await repo.finishRun(runId, { status: 'SUCCESS', rowsExtracted: 3, rowsInserted: 2, startedAt: Date.now() - 1200 });
    const { rows } = await db.query('SELECT status, duration_ms FROM scrape_runs WHERE id = $1', [runId]);
    assert.strictEqual(rows[0].status, 'SUCCESS');
    assert.ok(rows[0].duration_ms >= 1200);
  });
}

// ── 5. schema ───────────────────────────────────────────────────────────────

async function schemaTests() {
  await test('schema: the production tables exist', async () => {
    const { rows } = await db.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`);
    const names = rows.map((r) => r.table_name);
    // The six data tables the requirements name, plus the registry and audit
    // trail. Anything superseded by migration 005 was dropped by 008.
    for (const t of ['tradingview_watchlist', 'tradingview_history',
      'symbol_day', 'market_day', 'awsat_market_quotes', 'awsat_stock_depth',
      'awsat_order_list', 'instruments', 'scrape_runs']) {
      assert.ok(names.includes(t), `missing table: ${t}`);
    }
  });

  await test('schema: the deduplication keys match production', async () => {
    const { rows } = await db.query(
      `SELECT conname FROM pg_constraint WHERE contype IN ('u','p')
         AND conrelid::regclass::text IN
           ('awsat_market_quotes','awsat_stock_depth','awsat_order_list',
            'tradingview_watchlist','tradingview_history')`);
    const names = rows.map((r) => r.conname).join(' ');
    // Renamed alongside their tables by 002. A violation reporting
    // a key named after a table that no longer exists is a small mystery
    // at exactly the wrong moment.
    assert.match(names, /tradingview_watchlist_key/);
    assert.match(names, /awsat_quotes_key/);
    assert.match(names, /awsat_depth_key/);
    assert.match(names, /awsat_orders_order_id_key/);
  });

  await test('schema: prices are numeric, not floating point', async () => {
    const { rows } = await db.query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_name = 'awsat_market_quotes' AND column_name = 'last_price'`);
    assert.strictEqual(rows[0].data_type, 'numeric');
  });
}

// ── run ─────────────────────────────────────────────────────────────────────

async function cleanup() {
  for (const t of ['tradingview_watchlist', 'awsat_market_quotes', 'awsat_stock_depth',
    'awsat_order_list', 'tradingview_history']) {
    await db.query(`DELETE FROM ${t} WHERE symbol LIKE 'TST%'`);
  }
  await db.query("DELETE FROM awsat_order_list WHERE order_id LIKE 'selftest%'");
  await db.query('DELETE FROM scrape_runs WHERE scraper LIKE $1', [`${TAG}%`]);
  await db.query('DELETE FROM instruments WHERE symbol LIKE $1', ['TST%']);
}

async function main() {
  console.log('\n  running tests\n  ' + '─'.repeat(66));

  await scheduleTests();
  await transformTests();
  await validationTests();

  try {
    await db.healthCheck();
  } catch (err) {
    console.error(`\n  cannot reach the database: ${err.message}`);
    console.error('  Set DATABASE_URL and run `npm run setup` first.\n');
    process.exit(1);
  }

  await cleanup();
  await schemaTests();
  await persistenceTests();
  await cleanup();

  console.log(`  ${'─'.repeat(66)}`);
  if (failures.length) {
    for (const [name, err] of failures) {
      console.log(`  FAIL  ${name}\n        ${err.message}`);
    }
  }
  console.log(`\n  ${passed} passed, ${failed} failed\n`);

  await db.close();
  process.exit(failed ? 1 : 0);
}

main().catch(async (err) => {
  console.error('test run crashed:', err);
  await db.close().catch(() => {});
  process.exit(1);
});

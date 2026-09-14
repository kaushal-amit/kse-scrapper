'use strict';
/**
 * P2-DATE · a `date` is a calendar day, and turning it into an instant is what
 * made three separate pieces of code read the wrong one.
 *
 * node-postgres parses a bare `date` into a JS Date at LOCAL midnight. On a
 * server in Kuwait, '2026-04-20'::date becomes 2026-04-19T21:00:00Z — so every
 * place that rendered it with getUTC* or toISOString() read the day BEFORE the
 * one stored. Three places did:
 *
 *   · src/market/holidays.js — the calendar loaded one day early. The scraper
 *     skipped a REAL session, which cannot be re-scraped, and then ran on the
 *     actual holiday: one of the day's two login attempts spent on a shut
 *     terminal, and a symbol_day computed from no captures.
 *   · src/migration/repair.js — collision_days shifted back a day, and that
 *     array SCOPES A DELETE. `--apply` deleted the uncontested session BEFORE
 *     the collision, left the collision in place, and reported success. The
 *     clause F-11 added to stop the tool destroying sessions that were never in
 *     question became the clause that selected them.
 *   · scripts/fix-tradingview-dates.js — the dry run printed the evidence for
 *     --from one day early, so the operator bounds the repair a day too wide
 *     and shifts a day of correct history.
 *
 * Fixed at the type rather than at the three call sites: src/db/pool.js hands
 * a `date` back as the text Postgres sent. timestamptz is untouched — those ARE
 * instants and a Date is the right shape for them.
 *
 * THE SUITE RUNS ITS CHECKS IN CHILD PROCESSES UNDER THREE TIMEZONES. A
 * timezone bug tested only on the machine that has the convenient timezone is
 * not tested — the same reason order-time-tz.test.js is built this way.
 */
const { requireTestDb } = require('../dbguard');
requireTestDb('date-type-parser');

const path = require('path');
const { execFileSync } = require('child_process');
const { query, close } = require('../../src/db/pool');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };

const REPO = path.join(__dirname, '..', '..');
const ZONES = ['UTC', 'Asia/Kuwait', 'America/New_York', 'Pacific/Kiritimati'];

/** Run a snippet under a given TZ and return its last line of output. */
function under(tz, body) {
  return execFileSync(process.execPath, ['-e', body], {
    encoding: 'utf8', cwd: REPO,
    env: { ...process.env, TZ: tz },
  });
}

/**
 * Pull the answer out of a child's output.
 *
 * The child requires the pool, which logs its TLS line, and close() logs
 * another — so the answer is fenced rather than taken from a line position.
 */
const fenced = (out) => {
  const m = String(out).match(/<<<([\s\S]*?)>>>/);
  return m ? m[1] : `NO ANSWER IN: ${String(out).slice(0, 120)}`;
};

(async () => {
  try {
    // ── the type, at the source ───────────────────────────────────────────
    {
      const body = `
        const { query, close } = require('./src/db/pool');
        (async () => {
          const { rows } = await query("SELECT '2026-04-20'::date AS d");
          process.stdout.write("<<<" + String(rows[0].d) + ">>>");
          await close();
        })();`;
      for (const tz of ZONES) {
        const got = fenced(under(tz, body));
        ck(`TZ=${tz}: a date column comes back as its own text`, got === '2026-04-20', got);
      }
    }

    // ── and a timestamptz is STILL an instant ─────────────────────────────
    {
      const body = `
        const { query, close } = require('./src/db/pool');
        (async () => {
          const { rows } = await query("SELECT '2026-04-20 13:05:00+03'::timestamptz AS t");
          process.stdout.write("<<<" + (rows[0].t instanceof Date
            ? rows[0].t.toISOString() : 'NOT A DATE: ' + String(rows[0].t)) + ">>>");
          await close();
        })();`;
      for (const tz of ZONES) {
        const got = fenced(under(tz, body));
        ck(`TZ=${tz}: a timestamptz is still a Date at the right instant`,
          got === '2026-04-20T10:05:00.000Z', got);
      }
    }

    // ── THE HOLIDAY CALENDAR · the day that was seeded is the day that closes ─
    {
      await query("DELETE FROM public.market_holiday WHERE name = 'ZZ-TEST'");
      // 20 April 2026 is a Monday — a trading day but for the holiday.
      await query(
        "INSERT INTO public.market_holiday (holiday_date, name) VALUES ('2026-04-20', 'ZZ-TEST')");

      const body = `
        const holidays = require('./src/market/holidays');
        const clock = require('./src/market/clock');
        const { close } = require('./src/db/pool');
        (async () => {
          await holidays.load();
          process.stdout.write("<<<" + JSON.stringify({
            mon: holidays.isHoliday('2026-04-20'),
            sun: holidays.isHoliday('2026-04-19'),
            monTrades: clock.isTradingDay(new Date('2026-04-20T09:30:00+03:00')),
          }) + ">>>");
          await close();
        })();`;

      for (const tz of ZONES) {
        const got = JSON.parse(fenced(under(tz, body)));
        ck(`TZ=${tz}: the seeded Monday IS the holiday`, got.mon === true, got);
        ck(`TZ=${tz}: and the day before it is NOT`, got.sun === false, got);
        ck(`TZ=${tz}: so the scraper does not run that Monday`, got.monTrades === false, got);
      }

      await query("DELETE FROM public.market_holiday WHERE name = 'ZZ-TEST'");
    }

    // ── THE REPAIR · the day it deletes is the day that collided ──────────
    {
      const SYM = 'ZZDATE';
      await query('DELETE FROM awsat_market_quotes WHERE symbol = $1', [SYM]);

      // A clean Main Market session on Sunday, and a collision on Monday.
      const clean = '2026-04-19';
      const clash = '2026-04-20';
      const put = (market, at, day) => query(
        `INSERT INTO awsat_market_quotes (symbol, market, created_at, trading_date, ingest_source, last_price)
         VALUES ($1, $2, $3, $4, 'awsat_client', 100)`, [SYM, market, at, day]);

      for (let i = 0; i < 20; i += 1) {
        await put('Main Market', new Date(`${clean}T09:${String(i).padStart(2, '0')}:00+03:00`), clean);
      }
      for (let i = 0; i < 20; i += 1) {
        await put('Main Market', new Date(`${clash}T09:${String(i).padStart(2, '0')}:00+03:00`), clash);
      }
      // The botched sweep: the same instant stored under both markets.
      const both = new Date(`${clash}T10:00:00+03:00`);
      await put('Main Market', both, clash);
      await put('Auction Market', both, clash);

      const repair = require('../../src/migration/repair');
      const dry = await repair.repairMarketLabels({ apply: false });
      const entry = dry.decided.find((d) => d.symbol === SYM);

      ck('the collision is found', !!entry, dry.decided.map((d) => d.symbol));
      ck('and the day named is the day it happened on, not the day before',
        entry && entry.days.length === 1 && entry.days[0] === clash, entry && entry.days);
      ck('specifically NOT the uncontested session before it',
        !(entry && entry.days.includes(clean)), entry && entry.days);

      const before = await query(
        'SELECT count(*)::int c FROM awsat_market_quotes WHERE symbol = $1 AND trading_date = $2',
        [SYM, clean]);
      await repair.repairMarketLabels({ apply: true });
      const after = await query(
        'SELECT count(*)::int c FROM awsat_market_quotes WHERE symbol = $1 AND trading_date = $2',
        [SYM, clean]);
      ck('APPLYING IT LEAVES THE UNCONTESTED SESSION INTACT',
        after.rows[0].c === before.rows[0].c && before.rows[0].c === 20,
        [before.rows[0].c, after.rows[0].c]);

      const left = await query(
        `SELECT market, count(*)::int c FROM awsat_market_quotes
          WHERE symbol = $1 AND trading_date = $2 GROUP BY market ORDER BY market`,
        [SYM, clash]);
      ck('and the collision itself IS repaired', left.rows.length === 1, left.rows);

      await query('DELETE FROM awsat_market_quotes WHERE symbol = $1', [SYM]);
    }

    // ── and no live code renders a date through getUTC* any more ──────────
    {
      const fs = require('fs');
      const files = [
        'src/market/holidays.js',
        'src/migration/repair.js',
        'scripts/fix-tradingview-dates.js',
      ];
      for (const rel of files) {
        const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
        const live = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
        ck(`${rel}: no getUTCFullYear on a calendar day`,
          !/getUTCFullYear/.test(live), (live.match(/.*getUTC.*/g) || []));
        ck(`${rel}: and no toISOString().slice(0, 10) either`,
          !/toISOString\(\)\.slice\(0, 10\)/.test(live), (live.match(/.*toISOString.*/g) || []));
      }

      const pool = fs.readFileSync(path.join(REPO, 'src/db/pool.js'), 'utf8');
      ck('the pool sets the DATE type parser', /types\.setTypeParser\(1082/.test(pool));
      ck('and does NOT touch timestamptz', !/setTypeParser\(1184/.test(pool));
    }
  } catch (e) {
    ck('the suite ran without throwing', false, e.message);
  }

  await close();
  console.log(`\ndate type parser: ${p}/${n}`);
  process.exit(p === n ? 0 : 1);
})();

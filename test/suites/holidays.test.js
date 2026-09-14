'use strict';
/**
 * S-08 · a closed weekday is a SKIP, not a session (migration 040).
 *
 * The weekday rule (Sunday–Thursday) is not the whole calendar. On an Eid the
 * exchange is shut on a weekday, and without a calendar every job treats it as
 * a normal session:
 *
 *   · the AWSAT jobs log in, spending one of the day's TWO attempts on a
 *     terminal with nothing to show;
 *   · the nightly computes write a symbol_day / market_day row built from no
 *     captures — a row that looks like every other one and is made of nothing;
 *   · the "previous trading day" reach-back then steps onto that empty day and
 *     reports a null close where the session before has a real one.
 *
 * THE EMPTY CASE IS THE IMPORTANT ONE. The table ships empty, because a guessed
 * holiday would silently skip a REAL session and a session skipped cannot be
 * re-scraped. Empty must therefore behave exactly as before — every weekday a
 * session — while the boot says loudly that no calendar is loaded.
 */
const { requireTestDb } = require('../dbguard');
requireTestDb('holidays');

const { query, close } = require('../../src/db/pool');
const holidays = require('../../src/market/holidays');
const clock = require('../../src/market/clock');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };

// 2026-09-08 is a Tuesday, 2026-09-09 a Wednesday, 2026-09-11 a Friday.
const TUE = new Date('2026-09-08T10:00:00+03:00');
const WED = new Date('2026-09-09T10:00:00+03:00');
const FRI = new Date('2026-09-11T10:00:00+03:00');

(async () => {
  try {
    await query('DELETE FROM public.market_holiday');

    // ── the table exists and refuses a weekend date ────────────────────────
    {
      const { rows } = await query(
        "SELECT table_type FROM information_schema.tables WHERE table_name = 'market_holiday'");
      ck('market_holiday exists', rows.length === 1 && rows[0].table_type === 'BASE TABLE', rows[0]);

      let refused = false;
      try {
        await query("INSERT INTO public.market_holiday (holiday_date, name) VALUES ('2026-09-11','a Friday')");
      } catch { refused = true; }
      ck('a WEEKEND date is refused — redundant, and more likely a typo than an intention', refused);
    }

    // ── empty calendar behaves exactly as before ───────────────────────────
    {
      holidays._setForTest([]);
      ck('with no calendar, a Tuesday is a trading day', clock.isTradingDay(TUE) === true);
      ck('with no calendar, a Wednesday is a trading day', clock.isTradingDay(WED) === true);
      ck('and a Friday is still not — the weekday rule is untouched', clock.isTradingDay(FRI) === false);
      ck('isHoliday is false for everything', holidays.isHoliday('2026-09-08') === false);
    }

    // ── a loaded holiday closes that weekday, and only that one ────────────
    {
      holidays._setForTest(['2026-09-08']);
      ck('the holiday weekday is NOT a trading day', clock.isTradingDay(TUE) === false);
      ck('the next weekday still is', clock.isTradingDay(WED) === true);
      ck('and the window is closed on it', clock.isWithinWindow(TUE) === false);
      ck('while it is open on the next', clock.isWithinWindow(WED) === true);
    }

    // ── load() reads the table ─────────────────────────────────────────────
    {
      await query(`INSERT INTO public.market_holiday (holiday_date, name, source)
                   VALUES ('2026-09-08', 'test closure', 'suite')`);
      const res = await holidays.load();
      ck('load() picks the row up', res.days === 1, res);
      ck('and names where it came from', /market_holiday/.test(res.from), res.from);
      ck('and the clock agrees', clock.isTradingDay(TUE) === false);

      const st = holidays.status();
      ck('status reports the dates', st.dates.includes('2026-09-08'), st);
    }

    // ── an empty table loads cleanly and reports "none" ────────────────────
    {
      await query('DELETE FROM public.market_holiday');
      const res = await holidays.load();
      ck('an empty calendar is not an error', res.days === 0, res);
      ck('and it is reported as none, not as zero holidays', res.from === 'none', res);
      ck('and every weekday is a session again', clock.isTradingDay(TUE) === true);
    }

    // ── a date string and a Date agree ─────────────────────────────────────
    {
      /*
       * A LOCAL-MIDNIGHT Date, which is the only Date a calendar day can
       * honestly be. The fixture used `new Date('2026-09-08T00:00:00Z')` — an
       * INSTANT — and that is the ambiguity the whole finding was about: it is
       * the 8th in Kuwait and the 7th in New York, and dayKey cannot be right
       * for both.
       *
       * Production no longer passes a Date at all: `date` columns arrive as the
       * text Postgres sent (src/db/pool.js). This block exists only to pin what
       * the Date branch means, so it is exercised with a Date that means one
       * day rather than one instant.
       */
      holidays._setForTest([new Date(2026, 8, 8)]);   // month is 0-based: September
      ck('a local-midnight Date and a string key the same way',
        holidays.isHoliday('2026-09-08') === true);
      holidays._setForTest([]);
    }

    // ── the boot loads it BEFORE reporting the window ──────────────────────
    {
      const src = require('fs').readFileSync(require('path').join(__dirname, '../../src/index.js'), 'utf8');
      const loadAt = src.indexOf('holidays.load()');
      const statusAt = src.indexOf('clock.windowStatus()');
      ck('the calendar is loaded before the market status is announced',
        loadAt > 0 && statusAt > 0 && loadAt < statusAt, [loadAt, statusAt]);
    }
  } catch (e) {
    ck('the suite ran without throwing', false, e.message);
  }

  await close();
  console.log(`\nholidays: ${p}/${n}`);
  process.exit(p === n ? 0 : 1);
})();

'use strict';
/**
 * F-13 and F-14 — an unmeasured value must not become a permissive number, and
 * the same command must produce the same answer twice.
 *
 * F-14 · THE STREAKS WERE NOT IDEMPOTENT.
 * activityBlock read `symbol_day WHERE trading_date <= $1` — including today —
 * and ran BEFORE today's row was written. So:
 *
 *   ARABREC falls on 8, 9, 10 and 11 September. First run of
 *   `daily.symbolday --date=2026-09-11`: no row for the 11th yet, `back = 1` is
 *   the 10th, down_days is written as 3. Re-run an hour later: today's row
 *   exists, `back = 1` is the 11th, and the SAME COMMAND writes 4.
 *
 * Same command, same data, two different numbers, in a column the backend reads
 * as a run length — and the first-run value is yesterday's streak wearing
 * today's date. The file's own header claims "Idempotent: re-running a day
 * corrects it rather than duplicating."
 *
 * F-13 · A NULL PRICE BECAME A FLOOR OF ZERO.
 * `m.price > 0 ? … : 0` — `null > 0` is false, so sharesAtBudget was 0, the
 * floor was 0, and `absVol` was `volumeToday >= 0`: always true. The most
 * permissive possible answer, produced by the ABSENCE of the number the test is
 * built on. A thinly-quoted symbol could claim a depth slot ahead of a real
 * candidate on a floor of zero shares.
 */
const { requireTestDb } = require('../dbguard');
requireTestDb('compute-idempotency');

const { query, close } = require('../../src/db/pool');
const csd = require('../../src/jobs/computeSymbolDay');
const wakeup = require('../../src/wakeup');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };

const SYM = 'IDEMP';
const DAYS = ['2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10'];

/*
 * A session needs a capture at or after close_capture_min_hhmm (12:30) for its
 * close to count — otherwise prev_close is null and chg_fils with it, and the
 * streak has nothing to read. Seed a morning print and a late one.
 */
const seedQuotes = async (day, close_) => {
  // A real session's worth: every 15 minutes from the open to past the capture
  // cutoff. Two captures make a THIN day with no close_px, and then chg_fils is
  // null and the streak has nothing to read — the production rules doing their
  // job on a fixture that was not a session.
  for (let m = 9 * 60; m <= 13 * 60 + 25; m += 15) {
    const hh = String(Math.floor(m / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    await query(
      `INSERT INTO awsat_market_quotes (symbol, market, created_at, trading_date, ingest_source, last_price, volume, trades, session)
       VALUES ($1, 'Main Market', $2, $3, 'awsat_client', $4, 1000, 10, $5)`,
      // `session` decides the close TIER. A capture with no session is a
      // Friday read and carries no close at all — which is why the two-capture
      // fixture produced close_px null, chg_fils null and no streak.
      [SYM, new Date(`${day}T${hh}:${mm}:00+03:00`), day, close_,
        m >= 13 * 60 + 20 ? 'Close-Of-Day' : 'Trading']);
  }
};

const rowFor = async (day) => (await query(
  'SELECT down_days, days_active, chg_fils FROM symbol_day WHERE symbol = $1 AND trading_date = $2',
  [SYM, day])).rows[0];

(async () => {
  try {
    await query('DELETE FROM symbol_day WHERE symbol = $1', [SYM]);
    await query('DELETE FROM awsat_market_quotes WHERE symbol = $1', [SYM]);
    await query('DELETE FROM instruments WHERE symbol = $1', [SYM]);
    await query("INSERT INTO instruments (symbol, market, is_primary, is_tradeable) VALUES ($1,'Main Market',true,true)", [SYM]);

    // A falling sequence: 110, 108, 106, 104, 102 — four consecutive down days.
    const closes = [110, 108, 106, 104, 102];
    for (let i = 0; i < DAYS.length; i += 1) {
      await seedQuotes(DAYS[i], closes[i]);
      await csd.compute(DAYS[i], null);
    }

    const last = DAYS[DAYS.length - 1];

    // ── the property: run it again, get the same answer ───────────────────
    {
      const first = await rowFor(last);
      ck('the day computed', !!first, first);
      ck('and it fell', Number(first.chg_fils) < 0, first);

      await csd.compute(last, null);
      const second = await rowFor(last);

      ck('RE-RUNNING THE SAME DAY GIVES THE SAME down_days',
        String(first.down_days) === String(second.down_days), [first.down_days, second.down_days]);
      ck('and the same days_active',
        String(first.days_active) === String(second.days_active), [first.days_active, second.days_active]);

      // A third time, for good measure — the old bug alternated.
      await csd.compute(last, null);
      const third = await rowFor(last);
      ck('and a third run agrees too',
        String(first.down_days) === String(third.down_days), [first.down_days, third.down_days]);
    }

    // ── and the answer is the RIGHT one: today is counted ─────────────────
    {
      const r = await rowFor(last);
      // 4 consecutive down sessions ending today (07, 08, 09, 10 each fell
      // against the day before; the 6th has no prior close).
      ck('the streak includes TODAY — it is not yesterday\'s answer',
        Number(r.down_days) === 4, r.down_days);
      ck('days_active counts today too', Number(r.days_active) === 5, r.days_active);
    }

    // ── a day that did NOT fall ends the run ──────────────────────────────
    {
      const up = '2026-09-13';
      await seedQuotes(up, 120);
      await csd.compute(up, null);
      const r = await rowFor(up);
      ck('a rising day ends the down streak at zero', Number(r.down_days) === 0, r);
      await csd.compute(up, null);
      ck('and says so again on a re-run', Number((await rowFor(up)).down_days) === 0);
    }

    await query('DELETE FROM symbol_day WHERE symbol = $1', [SYM]);
    await query('DELETE FROM awsat_market_quotes WHERE symbol = $1', [SYM]);
    await query('DELETE FROM instruments WHERE symbol = $1', [SYM]);

    // ── F-13 · an unmeasured price does not become a permissive floor ─────
    {
      const V = wakeup._movementVerdict || wakeup.movementVerdict;
      if (typeof V !== 'function') {
        ck('movementVerdict is reachable for testing', false, Object.keys(wakeup));
      } else {
        const base = {
          price: 250, volumeToday: 10_000_000, rangeFils: 12, upMoves: 3,
          volAvg: 1_000_000, moveFromOpen: 9,
        };
        const withPrice = await V({ ...base }, 5, 600);
        ck('with a price, the floor is a real number', typeof withPrice.floor === 'number' && withPrice.floor > 0, withPrice);

        const noPrice = await V({ ...base, price: null }, 5, 600);
        ck('WITHOUT a price the floor is NOT COMPUTED, not zero', noPrice.floor === null, noPrice);
        ck('and absVol is false rather than trivially true', noPrice.absVol === false, noPrice);
        ck('so the symbol does not fire', noPrice.fires === false, noPrice);
        ck('and the verdict names the missing term',
          Array.isArray(noPrice.notComputed) && noPrice.notComputed.includes('price'), noPrice);

        // The regression in one line: a tiny volume used to clear a floor of 0.
        const tiny = await V({ ...base, price: null, volumeToday: 1 }, 5, 600);
        ck('one share does not clear an uncomputable floor', tiny.absVol === false, tiny);
      }
    }
  } catch (e) {
    ck('the suite ran without throwing', false, e.message);
  }

  await close();
  console.log(`\ncompute idempotency: ${p}/${n}`);
  process.exit(p === n ? 0 : 1);
})();

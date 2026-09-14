'use strict';
/**
 * P2 · symbol_day contradicted itself about the close, and pct_at_offer counted
 * steps whose book was never read.
 *
 * ─── ONE CLOSE RULE, NOT TWO ───────────────────────────────────────────────
 * symbolDayMetrics abandoned "session list + latest by created_at" and says why
 * by name:
 *
 *   "A list plus 'latest by created_at' picks whichever session happened to be
 *    captured last, which is not the same as the best available close. CABLE on
 *    2 August has a Close-Of-Day at 1650 captured at 10:17 and an auction print
 *    at 1648 captured later in the file — ordering by time reaches the auction
 *    and never gets to the official close."
 *
 * closeRow() became a PRECEDENCE ORDER. previousCloses() — and the chg_5d
 * lookback — were not changed, and their docblock defended them as "the same
 * DISTINCT ON that session_close() performs", which is true and is the
 * superseded rule.
 *
 * So the row for 2 August said close_px 1650, close_source CLOSE_OF_DAY, and
 * the row for 3 August said prev_close 1648. chg_fils measured from a base the
 * table itself denies — and it feeds breadth, pct_advancing, market_day.regime,
 * down_days and the signal-scoring evidence base. Two fils is enough to flip a
 * symbol between advancing and declining.
 *
 * ─── AND THE FLOW DENOMINATOR ──────────────────────────────────────────────
 *   const priced = atOffer + atBid + (steps.length - atOffer - atBid);
 *
 * which reduces to steps.length. A step whose bid/offer did not render is
 * counted as inside the spread, can never reach the atOffer numerator, and was
 * in the denominator. A symbol at the offer on every readable step, with half
 * its steps unbooked, reported 50 instead of ~100 — so buySellRatio did not
 * trip the at-offer invalidation, and migration 013's CHECK accepted the row
 * because the stored number was the wrong one it was checking.
 */
const { requireTestDb } = require('../dbguard');
requireTestDb('close-rule-and-flow');

const fs = require('fs');
const path = require('path');
const { query, close } = require('../../src/db/pool');
const csd = require('../../src/jobs/computeSymbolDay');
const M = require('../../src/jobs/symbolDayMetrics');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };

const REPO = path.join(__dirname, '..', '..');

// ── THE FLOW DENOMINATOR, in isolation ─────────────────────────────────────
{
  // Ten volume-bearing steps. Five have a book and every one of them prints at
  // the offer; five have no book at all.
  const at = (m) => new Date(`2026-09-10T${String(9 + Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00+03:00`);
  const rows = [];
  let vol = 0;
  rows.push({ created_at: at(0), volume: 0, last_price: 100, bid: 99, offer: 100, session: 'Trading' });
  for (let i = 1; i <= 5; i += 1) {
    vol += 1000;
    rows.push({ created_at: at(i), volume: vol, last_price: 100, bid: 99, offer: 100, session: 'Trading' });
  }
  for (let i = 6; i <= 10; i += 1) {
    vol += 1000;
    // The book did not render. Not a print between the bid and the offer — no
    // bid and no offer at all.
    rows.push({ created_at: at(i), volume: vol, last_price: 100, bid: null, offer: null, session: 'Trading' });
  }

  const f = M.movementBlock(rows);
  ck('all ten steps are counted as steps', f.steps === 10, f.steps);
  ck('five of them printed at the offer', f.trades_at_offer === 5, f);
  ck('and only five had a readable book', f.priced_steps === 5, f);
  ck('the five without one are reported as unbooked', f.unbooked_steps === 5, f);

  ck('PCT_AT_OFFER IS 100 — measured over the steps that were measurable',
    f.pct_at_offer === 100, f.pct_at_offer);
  ck('and NOT 50, which is what dividing by steps.length gave',
    f.pct_at_offer !== 50, f.pct_at_offer);

  // The consequence, stated as the gate it drives.
  const T = require('../../src/config/thresholds');
  const limit = T.get('sd_at_offer_invalidates_pct');
  ck('the honest number trips the at-offer invalidation', f.pct_at_offer > limit,
    [f.pct_at_offer, limit]);
  ck('the diluted one would not have — and migration 013\'s CHECK would have '
    + 'accepted the row on the same wrong number', !(50 > limit), limit);

  // A genuine inside-the-spread print is still in the denominator.
  const inside = [
    { created_at: at(0), volume: 0, last_price: 100, bid: 99, offer: 101, session: 'Trading' },
    { created_at: at(1), volume: 1000, last_price: 100, bid: 99, offer: 101, session: 'Trading' },
    { created_at: at(2), volume: 2000, last_price: 101, bid: 99, offer: 101, session: 'Trading' },
  ];
  const g = M.movementBlock(inside);
  ck('a real inside-the-spread print IS in the denominator — it was measured, '
    + 'it just was not at the touch', g.priced_steps === 2, g);
  ck('so one of two at the offer reads 50', g.pct_at_offer === 50, g);
  ck('and nothing is reported as unbooked', g.unbooked_steps === 0, g);
}

// ── and the tautology is gone from the source ──────────────────────────────
{
  const src = fs.readFileSync(path.join(REPO, 'src/jobs/symbolDayMetrics.js'), 'utf8');
  const live = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  ck('priced is no longer steps.length wearing a name',
    !/atOffer \+ atBid \+ \(steps\.length - atOffer - atBid\)/.test(live),
    (live.match(/.*const priced =.*/g) || []));
  ck('it counts the steps that had a book', /const priced = atOffer \+ atBid \+ insideSpreadSteps;/.test(live));
}

(async () => {
  try {
    // ── THE CLOSE RULE · CABLE's own shape ────────────────────────────────
    {
      const SYM = 'ZZCABLE';
      await query('DELETE FROM symbol_day WHERE symbol = $1', [SYM]);
      await query('DELETE FROM awsat_market_quotes WHERE symbol = $1', [SYM]);
      await query('DELETE FROM instruments WHERE symbol = $1', [SYM]);
      await query("INSERT INTO instruments (symbol, market, is_primary, is_tradeable) VALUES ($1,'Main Market',true,true)", [SYM]);

      const D1 = '2026-08-02';
      const D2 = '2026-08-03';
      const put = (day, capturedAt, px, session) => query(
        `INSERT INTO awsat_market_quotes (symbol, market, created_at, trading_date, ingest_source, last_price, volume, trades, session)
         VALUES ($1, 'Main Market', $2, $3, 'awsat_client', $4, 1000, 10, $5)`,
        [SYM, new Date(`${day}T${capturedAt}:00+03:00`), day, px, session]);

      // A full session on D1, and the CABLE shape at the end of it: the
      // OFFICIAL close captured at 10:17, an auction print captured LATER.
      for (let m = 9 * 60; m <= 12 * 60 + 50; m += 15) {
        const hh = String(Math.floor(m / 60)).padStart(2, '0');
        const mm = String(m % 60).padStart(2, '0');
        await put(D1, `${hh}:${mm}`, 1640, 'Trading');
      }
      await put(D1, '13:17', 1650, 'Close-Of-Day');               // the official close
      await put(D1, '13:25', 1648, 'Close Auction Acceptance');   // captured later

      // A full session on D2 so it computes at all.
      for (let m = 9 * 60; m <= 12 * 60 + 50; m += 15) {
        const hh = String(Math.floor(m / 60)).padStart(2, '0');
        const mm = String(m % 60).padStart(2, '0');
        await put(D2, `${hh}:${mm}`, 1660, 'Trading');
      }
      await put(D2, '13:20', 1660, 'Close-Of-Day');

      await csd.compute(D1, null);
      await csd.compute(D2, null);

      const d1 = (await query(
        'SELECT close_px, close_source FROM symbol_day WHERE symbol = $1 AND trading_date = $2',
        [SYM, D1])).rows[0];
      const d2 = (await query(
        'SELECT prev_close, chg_fils FROM symbol_day WHERE symbol = $1 AND trading_date = $2',
        [SYM, D2])).rows[0];

      ck('the close is the OFFICIAL one, not the later-captured auction',
        Number(d1.close_px) === 1650, d1);
      ck('and it says which tier it came from', d1.close_source === 'CLOSE_OF_DAY', d1);

      ck('THE NEXT DAY MEASURES FROM THE SAME NUMBER THE TABLE STORED',
        Number(d2.prev_close) === 1650, d2);
      ck('not from the auction print the old rule reached first',
        Number(d2.prev_close) !== 1648, d2);
      ck('so chg_fils is measured from a base the table agrees with',
        Number(d2.chg_fils) === 1660 - 1650, d2);

      // The property, stated generally: yesterday's close_px IS today's
      // prev_close. That is what the two rules disagreeing broke.
      const both = (await query(
        `SELECT a.close_px AS yesterday, b.prev_close AS today
           FROM symbol_day a JOIN symbol_day b
             ON b.symbol = a.symbol AND b.trading_date = $3
          WHERE a.symbol = $1 AND a.trading_date = $2`, [SYM, D1, D2])).rows[0];
      ck('symbol_day no longer contradicts itself across two rows',
        Number(both.yesterday) === Number(both.today), both);

      await query('DELETE FROM symbol_day WHERE symbol = $1', [SYM]);
      await query('DELETE FROM awsat_market_quotes WHERE symbol = $1', [SYM]);
      await query('DELETE FROM instruments WHERE symbol = $1', [SYM]);
    }

    // ── the two rules read ONE list ───────────────────────────────────────
    {
      const src = fs.readFileSync(path.join(REPO, 'src/jobs/computeSymbolDay.js'), 'utf8');
      const live = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|\s*--|\s*\*)/.test(l)).join('\n');

      ck('neither query uses the superseded session list',
        !/session = ANY\(closing_sessions\(\)\)/.test(live),
        (live.match(/.*closing_sessions.*/g) || []));
      ck('both order by the tier precedence',
        (live.match(/array_position\(\$\d::text\[\], q\.session\)/g) || []).length === 4,
        (live.match(/array_position\(\$\d::text\[\], q\.session\)/g) || []).length);
      ck('the tier order is DERIVED from CLOSE_TIERS, not restated',
        /\[\.\.\.M\.CLOSE_TIERS\.entries\(\)\]/.test(live));

      // And it really is the same order.
      const order = [...M.CLOSE_TIERS.entries()].sort((a, b) => a[1] - b[1]).map(([s]) => s);
      ck('Close-Of-Day outranks the closing auction',
        order.indexOf('Close-Of-Day') < order.indexOf('Close Auction Acceptance'), order);
      ck('and continuous trading is the last resort',
        order.indexOf('Trading') === order.length - 2 || order.indexOf('Trading') === order.length - 1,
        order);
    }
  } catch (e) {
    ck('the suite ran without throwing', false, e.message);
  }

  await close();
  console.log(`\nclose rule and flow: ${p}/${n}`);
  process.exit(p === n ? 0 : 1);
})();

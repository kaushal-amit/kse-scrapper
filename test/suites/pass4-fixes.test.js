'use strict';
/**
 * P4 · four findings, and TWO OF THEM ARE IN YESTERDAY'S FIXES.
 *
 * That is the point of this suite and worth stating plainly. Each P3 fix was
 * correct about the case it was written for and stopped at the edge of it:
 *
 *   · the session filter was added to volumeBlock, and movementBlock,
 *     flowBlock, spreadBlock and peakHour went on reading the rows it excludes
 *     — four of the five places the rule lives;
 *   · bid_age_secs was made NULL on the FIRST row, and the second row turned
 *     that NULL back into 0 + elapsed, so the honest answer survived one tick;
 *   · and the zero-is-not-a-price rule was applied in symbolDayMetrics while
 *     scoreSignals' first branch still accepted a zero as a forward price.
 *
 * So these fixes are written at the CHOKE POINT rather than at the symptom:
 * the session filter goes inside volumeSteps, which every step-derived number
 * passes through, and the age carries its own null forward rather than being
 * repaired once at the start.
 */
const { requireTestDb } = require('../dbguard');
requireTestDb('pass4-fixes');

const fs = require('fs');
const path = require('path');
const { query, close } = require('../../src/db/pool');
const M = require('../../src/jobs/symbolDayMetrics');
const score = require('../../src/jobs/scoreSignals');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };

const REPO = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const liveOf = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const at = (m) => new Date(`2026-09-10T${String(9 + Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00+03:00`);

// ── 1 · THE SESSION FILTER REACHES EVERY BLOCK ─────────────────────────────
{
  // A real session, plus ONE stray unlabelled read carrying the previous
  // session's cumulative totals. This is the fixture pass3-fixes.test.js
  // already builds — it just never asked the other four blocks about it.
  const session = [
    { created_at: at(0), volume: 1000, trades: 10, last_price: 200, bid: 199, offer: 201, session: 'Trading' },
    { created_at: at(1), volume: 5000, trades: 40, last_price: 201, bid: 200, offer: 202, session: 'Trading' },
    { created_at: at(2), volume: 9000, trades: 70, last_price: 202, bid: 201, offer: 203, session: 'Close-Of-Day' },
  ];
  const stray = {
    created_at: new Date('2026-09-11T14:13:00+03:00'),
    volume: 99999999, trades: 9999, last_price: 202, bid: 201, offer: 203, session: null,
  };
  const mixed = [...session, stray];

  const cleanSteps = M.volumeSteps(session);
  const mixedSteps = M.volumeSteps(mixed);
  ck('volumeSteps itself drops the unlabelled read',
    mixedSteps.length === cleanSteps.length, [mixedSteps.length, cleanSteps.length]);
  ck('and the steps it keeps are the session\'s own',
    mixedSteps.every((s) => s.traded <= 4000), mixedSteps.map((s) => s.traded));

  // Every block, on both inputs. Each one must agree with the clean session.
  const blocks = {
    volumeBlock: (r) => M.volumeBlock(r),
    movementBlock: (r) => M.movementBlock(r),
    flowBlock: (r) => M.flowBlock(r),
    spreadBlock: (r) => M.spreadBlock(r, 202),
    peakHour: (r) => ({ peak_hour: M.peakHour(r) }),
  };
  for (const [name, fn] of Object.entries(blocks)) {
    ck(`${name} gives the same answer with the stray read as without it`,
      JSON.stringify(fn(mixed)) === JSON.stringify(fn(session)),
      { mixed: fn(mixed), clean: fn(session) });
  }

  // The specific numbers the third pass measured, named so a regression is
  // recognisable rather than merely unequal.
  const f = M.flowBlock(mixed);
  ck('turnover_kd is the session\'s, not 20 million',
    Number(f.turnover_kd) < 100_000, f.turnover_kd);
  ck('and the second half is not 99,990,999 shares a minute',
    f.second_half_shares_per_min === null || f.second_half_shares_per_min < 1_000_000,
    f.second_half_shares_per_min);
  ck('peak_hour is a trading hour, not 14 — which is after END_TIME',
    M.peakHour(mixed) === 9, M.peakHour(mixed));
  const mv = M.movementBlock(mixed);
  ck('shares_inside_spread is not 99,998,999', mv.shares_inside_spread < 100_000, mv.shares_inside_spread);
  ck('and priced_steps does not count a step volumeBlock refuses',
    mv.priced_steps === M.movementBlock(session).priced_steps, mv.priced_steps);

  // The fix is at the choke point, not repeated per block.
  const live = liveOf(read('src/jobs/symbolDayMetrics.js'));
  ck('volumeSteps applies the filter', /const sorted = ordered\(ownSession\(rows\)\);/.test(live));
  ck('and there is ONE definition of it', (live.match(/function ownSession\(/g) || []).length === 1);
  ck('volumeBlock reads that one, not a second rule',
    /const own = ownSession\(rows\);/.test(live));
  ck('no bespoke RANGE_SESSIONS-or-CLOSE_TIERS filter survives in volumeBlock',
    !/RANGE_SESSIONS\.has\(String\(r\.session\)\.trim\(\)\)\s*\|\|/.test(live));
}

// ── the filter keeps what it should ────────────────────────────────────────
{
  // An empty-string session is a July capture defect on continuous-trading
  // rows, not an exchange state. It must be KEPT.
  const blank = [
    { created_at: at(0), volume: 1000, trades: 10, last_price: 200, session: '' },
    { created_at: at(1), volume: 4000, trades: 30, last_price: 201, session: '' },
  ];
  ck('an empty-string session is kept — it is a capture defect, not a state',
    M.volumeBlock(blank).total_volume === 4000, M.volumeBlock(blank));

  // A labelled session we do not otherwise recognise is still a session.
  const odd = [
    { created_at: at(0), volume: 1000, trades: 10, last_price: 200, session: 'CB Auction' },
    { created_at: at(1), volume: 6000, trades: 30, last_price: 201, session: 'CB Auction' },
  ];
  ck('a circuit-breaker auction counts toward volume — it is real trading',
    M.volumeBlock(odd).total_volume === 6000, M.volumeBlock(odd));
  ck('and its steps reach the flow blocks',
    M.volumeSteps(odd).length === 1, M.volumeSteps(odd));
}

// ── 2 · AN UNMEASURED AGE STAYS UNMEASURED ─────────────────────────────────
{
  const live = liveOf(read('src/jobs/writeSymbolMinute.js'));
  ck('the first row is NULL', /if \(!prev\) return null;/.test(live));
  ck('and a null prior age CARRIES FORWARD rather than becoming 0 + elapsed',
    /if \(prevAge === null \|\| prevAge === undefined\) return null;/.test(live));
  ck('the old repair is gone',
    !/prevAge === null \|\| prevAge === undefined \? 0 : Number\(prevAge\)/.test(live),
    (live.match(/.*prevAge.*/g) || []));
  ck('a price that MOVED is still zero seconds old — the one place zero is a '
    + 'measurement', /!== price\) return 0;/.test(live));
}

// ── the age rule, exercised ────────────────────────────────────────────────
{
  // The shipped expression, run over the wake-up promotion sequence.
  const ageOf = (prev, prevPrice, prevAge, price, elapsed) => {
    if (price === null) return null;
    if (!prev) return null;
    if (prevPrice === null || Number(prevPrice) !== price) return 0;
    if (prevAge === null || prevAge === undefined) return null;
    return Number(prevAge) + Math.max(0, elapsed);
  };

  // A bid that has stood all morning, first seen at 11:30.
  let age = ageOf(null, null, null, 250, 0);
  ck('tick 1 of a mid-session promotion is unmeasured', age === null, age);
  age = ageOf(true, 250, age, 250, 20);
  ck('TICK 2 IS STILL UNMEASURED — this is the one that used to read 20',
    age === null, age);
  age = ageOf(true, 250, age, 250, 20);
  ck('and tick 3, which used to read 40', age === null, age);

  // Until the level actually moves — then it is genuinely new.
  age = ageOf(true, 250, age, 251, 20);
  ck('when the price MOVES the level is new and its age is 0', age === 0, age);
  age = ageOf(true, 251, age, 251, 20);
  ck('and from there it accumulates normally', age === 20, age);
  age = ageOf(true, 251, age, 251, 25);
  ck('adding each gap', age === 45, age);
}

// ── 3 · ZERO IS NOT A FORWARD PRICE ────────────────────────────────────────
{
  const src = read('src/jobs/scoreSignals.js');
  const live = liveOf(src);
  const guards = (live.match(/last_price IS NOT NULL AND last_price > 0/g) || []).length;
  ck('BOTH branches of priceInForceAt guard against zero', guards === 2, guards);
  ck('and neither settles for a bare NOT NULL',
    !/AND last_price IS NOT NULL\n\s+ORDER BY/.test(live));
}

(async () => {
  try {
    // ── the zero price, through the real query ────────────────────────────
    {
      const SYM = 'ZZZERO';
      const DAY = '2026-09-10';
      await query('DELETE FROM symbol_minute WHERE symbol = $1', [SYM]);
      await query('DELETE FROM awsat_market_quotes WHERE symbol = $1', [SYM]);

      const from = new Date(`${DAY}T10:00:00+03:00`);
      // Five minutes later the book has gone empty and last_price is 0 — the
      // shape empty-books.test.js documents, stored because validate.js rejects
      // only a NEGATIVE price.
      await query(
        `INSERT INTO symbol_minute (symbol, ts, trading_date, last_price, source)
         VALUES ($1, $2, $3, 0, 'BACKFILL')`,
        [SYM, new Date(`${DAY}T10:05:00+03:00`), DAY]);

      const px = await score.priceInForceAt(SYM, from, 5);
      ck('a zero in symbol_minute is NOT returned as the forward price',
        px !== 0, px);
      ck('and with nothing else to read, the answer is NOT COMPUTED',
        px === null, px);

      // A real price in the quotes fallback is still found — the guarded
      // branch used to be unreachable because the first one returned the zero.
      await query(
        `INSERT INTO awsat_market_quotes (symbol, market, created_at, trading_date, ingest_source, last_price)
         VALUES ($1, 'Main Market', $2, $3, 'awsat_client', 205)`,
        [SYM, new Date(`${DAY}T10:04:00+03:00`), DAY]);
      const px2 = await score.priceInForceAt(SYM, from, 5);
      ck('THE FALLBACK IS REACHABLE NOW and finds the real print',
        px2 === 205, px2);

      // And a real symbol_minute price still wins, as it should.
      await query(
        `INSERT INTO symbol_minute (symbol, ts, trading_date, last_price, source)
         VALUES ($1, $2, $3, 204, 'BACKFILL')`,
        [SYM, new Date(`${DAY}T10:04:30+03:00`), DAY]);
      ck('a real symbol_minute price is still preferred',
        await score.priceInForceAt(SYM, from, 5) === 204);

      await query('DELETE FROM symbol_minute WHERE symbol = $1', [SYM]);
      await query('DELETE FROM awsat_market_quotes WHERE symbol = $1', [SYM]);
    }

    // ── 4 · the master pull does not give up ──────────────────────────────
    {
      const live = liveOf(read('src/scrapers/awsatSocketTap.js'));
      ck('there is no try cap on the full-master fetch',
        !/tap\.masterTries >= 8/.test(live), (live.match(/.*masterTries.*/g) || []));
      ck('it backs off instead of hammering', /tap\.masterTries % 15 !== 0/.test(live));
      ck('and it still stops once a master has actually arrived',
        /if \(tap\.fullMasterFetched \|\| !tap\.sampleUrl\) return;/.test(live));
    }

    // ── and both heartbeats respect the placeholder token ─────────────────
    {
      for (const rel of ['userscript/awsat-capture.user.js',
        'userscript/awsat-market-summary.user.js']) {
        const live = liveOf(read(rel));
        const hb = live.slice(live.indexOf('function heartbeat('),
          live.indexOf('function heartbeat(') + 400);
        ck(`${path.basename(rel)}: the heartbeat is gated too`,
          /if \(TOKEN_PLACEHOLDER\) return;/.test(hb), hb.slice(0, 120));
      }
    }
  } catch (e) {
    ck('the suite ran without throwing', false, e.message);
  }

  await close();
  console.log(`\npass4 fixes: ${p}/${n}`);
  process.exit(p === n ? 0 : 1);
})();

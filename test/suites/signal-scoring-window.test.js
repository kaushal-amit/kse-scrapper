'use strict';
/**
 * F-11 and F-15 — two ways a tool quietly answered the wrong question.
 *
 * F-15 · THE FORWARD PRICE CROSSED SESSIONS, and C1 · IT READ THE WRONG SIDE
 * OF THE MARK.
 *
 * F-15: neither of the queries bounded the search. A signal firing at 13:05
 * with a 60-minute horizon looked for the first capture at or after 14:05 —
 * continuous trading ends at 13:30, so it returned the NEXT SESSION'S OPENING
 * PRINT. `was_right` then recorded a win measuring an overnight gap.
 *
 * C1: bounding it left the DIRECTION wrong. "The first capture at or after
 * the mark" reaches past the moment being graded, and on a 60-second grid it
 * does so on most signals — 232 of the last 400 by more than 50 seconds. A
 * price that had not happened at the mark is lookahead, not a late answer.
 * The price IN FORCE at the mark — the last capture at or before it — is
 * what a desk could have transacted at, and it is the answer rather than an
 * approximation of one.
 *
 * F-11 · THE MARKET-LABEL REPAIR DELETED WHOLE HISTORIES, UNATTENDED.
 * The share was measured over a symbol's LIFETIME — the wrong denominator for a
 * symbol that genuinely CHANGED market, which 026 documents by name. And
 * migrate-all called it with `{ apply: true }`, so it ran with nobody watching.
 */
const { requireTestDb } = require('../dbguard');
requireTestDb('signal-scoring-window');

const fs = require('fs');
const path = require('path');
const { query, close } = require('../../src/db/pool');
const score = require('../../src/jobs/scoreSignals');
const repair = require('../../src/migration/repair');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };

const REPO = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

// Thursday 10 Sep 2026 and the following Sunday.
const THU = (hhmm) => new Date(`2026-09-10T${hhmm}:00+03:00`);
const SUN = (hhmm) => new Date(`2026-09-13T${hhmm}:00+03:00`);

const quote = (symbol, at, day, px) => query(
  `INSERT INTO awsat_market_quotes (symbol, market, created_at, trading_date, ingest_source, last_price)
   VALUES ($1, 'Main Market', $2, $3, 'awsat_client', $4)`, [symbol, at, day, px]);

(async () => {
  try {
    await query("DELETE FROM awsat_market_quotes WHERE symbol LIKE 'SCORE%' OR symbol LIKE 'LABEL%'");

    // ── C1 · THE MARK IS A CEILING, NOT A FLOOR ───────────────────────────
    /*
     * The rule F-15 bounded was itself wrong about which side of the mark to
     * read. Signals fire seconds after a capture and the grid is ~60 s, so
     * "the first capture at or after fired_at + 5 min" is systematically
     * about a minute late — 232 of the last 400 signals by more than 50 s —
     * and it grades against a print that had not happened at the mark. That
     * is lookahead, one-sided, in the evidence base the strategy is judged
     * on.
     *
     * The price in force at the mark is the last capture at or before it.
     * This block is the direct test of that: two captures straddling the
     * mark, at different prices, and the earlier one is the answer.
     */
    {
      await quote('SCOREC', THU('09:00'), '2026-09-10', 100);   // the signal's own capture
      await quote('SCOREC', THU('09:04'), '2026-09-10', 103);   // IN FORCE at the 09:05 mark
      await quote('SCOREC', THU('09:06'), '2026-09-10', 117);   // after it: not yet knowable

      const at5 = await score.priceInForceAt('SCOREC', THU('09:00'), 5);
      ck('the capture IN FORCE at the mark answers, not the one after it',
        at5 === 103, at5);
      ck('  and specifically NOT the later print, which is lookahead — a '
        + '17-fil move graded from information the mark did not have',
      at5 !== 117, at5);
    }

    // ── the signal's own capture is not an answer to its own horizon ──────
    {
      /*
       * If nothing arrives between the signal and the mark, the last capture
       * at or before the mark is the one the signal was computed FROM. Its
       * price is exactly signal_log.price, so grading it yields "no move" for
       * every family — FROZEN right, the four warnings wrong — uniformly and
       * invisibly. NOT COMPUTED is the only honest answer.
       */
      await quote('SCORED', THU('09:00'), '2026-09-10', 100);
      const at5 = await score.priceInForceAt('SCORED', THU('09:00'), 5);
      ck('with no capture between the signal and the mark, NOT COMPUTED — '
        + 'not the signal\'s own price graded against itself',
      at5 === null, at5);
    }

    // ── F-15 · the cross-session read, still refused ──────────────────────
    {
      // The signal's own session: a print at 13:05 and the last one at 13:29.
      await quote('SCOREA', THU('13:05'), '2026-09-10', 204);
      await quote('SCOREA', THU('13:09'), '2026-09-10', 205);   // in force at the 13:10 mark
      await quote('SCOREA', THU('13:29'), '2026-09-10', 206);   // the session's last print
      // The next session opens higher — the gap that used to be scored as a win.
      await quote('SCOREA', SUN('09:00'), '2026-09-13', 211);

      const at5 = await score.priceInForceAt('SCOREA', THU('13:05'), 5);
      ck('a horizon INSIDE the session is answered', at5 === 205, at5);

      const at60 = await score.priceInForceAt('SCOREA', THU('13:05'), 60);
      ck('a horizon PAST THE CLOSE is NOT COMPUTED, not the next session',
        at60 === null, at60);
      ck('and specifically it is not the next session opening print',
        at60 !== 211, at60);
      /*
       * Worth stating: under the new rule the 14:05 mark is refused by
       * STALENESS — the last capture before it is 13:29, 36 minutes back —
       * before the trading_date bound is even consulted. Both bounds are
       * kept. F-15's was the only one there before, and a rule with one
       * bound is one edit away from the bug it fixed.
       */
      ck('  and it is not the session\'s own last print either, which is 36 '
        + 'minutes stale at that mark',
      at60 !== 206, at60);
    }

    // ── a long capture gap does not silently answer a different question ──
    {
      await quote('SCOREB', THU('09:00'), '2026-09-10', 100);
      // A print 40 minutes AFTER the mark cannot answer it — the old failure.
      await quote('SCOREB', THU('09:40'), '2026-09-10', 130);
      const at5 = await score.priceInForceAt('SCOREB', THU('09:00'), 5);
      ck('a capture 40 minutes past a 5-minute horizon does not answer it',
        at5 === null, at5);

      /*
       * OVERTURNED. This suite used to assert that a capture 2 minutes PAST
       * the horizon answered it — "one 2 minutes past the horizon does".
       * Under C1 it must not: 09:07 is after the 09:05 mark, so it is a price
       * the mark could not have known.
       */
      await quote('SCOREB', THU('09:07'), '2026-09-10', 102);
      ck('a capture 2 minutes PAST the mark no longer answers it — the '
        + 'assertion this suite used to make, and the bias C1 removes',
      await score.priceInForceAt('SCOREB', THU('09:00'), 5) === null);

      // And one BEFORE the mark, inside the staleness tolerance, does.
      await quote('SCOREB', THU('09:03'), '2026-09-10', 101);
      ck('a capture 2 minutes BEFORE the mark does answer it',
        await score.priceInForceAt('SCOREB', THU('09:00'), 5) === 101);
    }

    // ── a stale capture is refused rather than graded as no move ──────────
    {
      await quote('SCOREE', THU('10:00'), '2026-09-10', 200);
      // In force at the 60-minute mark by "last at or before", but 56 minutes
      // old. Answering with it grades a dead hour as a flat market.
      const at60 = await score.priceInForceAt('SCOREE', THU('10:00'), 60);
      ck('a capture staler than the tolerance is NOT COMPUTED, so an outage '
        + 'is not recorded as a market that did not move',
      at60 === null, at60);

      await quote('SCOREE', THU('10:59'), '2026-09-10', 208);
      ck('  and one inside the tolerance is',
        await score.priceInForceAt('SCOREE', THU('10:00'), 60) === 208);
    }

    // ── the same day, both sources ────────────────────────────────────────
    {
      const src = read('src/jobs/scoreSignals.js');
      ck('the symbol_minute query is bounded to the trading day',
        /FROM symbol_minute[\s\S]{0,500}trading_date = \$4::date/.test(src));
      ck('and so is the quotes fallback',
        /FROM awsat_market_quotes[\s\S]{0,500}trading_date = \$4::date/.test(src));
      ck('both read BACKWARD from the mark, not forward',
        (src.match(/ORDER BY (ts|created_at) DESC LIMIT 1/g) || []).length === 2);
      ck('both carry the staleness floor as well as the mark',
        (src.match(/\(\(\$3::int - \$5::int\) \|\| ' minutes'\)::interval/g) || []).length === 2);
      ck('and both exclude the signal\'s own moment',
        (src.match(/>\s*\$2::timestamptz$/gm) || []).length === 2);
      ck('nothing reaches past the mark any more — no "+ $5" upper bound '
        + 'survives, which is what made the read lookahead',
      !/\(\(\$3::int \+ \$5::int\) \|\| ' minutes'\)::interval/.test(src));
    }

    // ── F-11 · the repair is scoped, and not unattended ───────────────────
    {
      // A symbol that genuinely CHANGED market: a long history under Main, a
      // shorter one under Auction, and ONE botched sweep on a single day.
      const main = '2026-09-01';      // before the move: Main, 20 sessions' worth
      const auction = '2026-09-02';   // after the move: Auction is CORRECT here
      const auctionRow = (at, day) => query(
        `INSERT INTO awsat_market_quotes (symbol, market, created_at, trading_date, ingest_source, last_price)
         VALUES ('LABELX', 'Auction Market', $1, $2, 'awsat_client', 100)`, [at, day]);

      for (let i = 0; i < 20; i += 1) {
        await quote('LABELX', new Date(`${main}T09:${String(i).padStart(2, '0')}:00+03:00`), main, 100);
      }
      // On the auction day the sweep mostly reads Auction correctly…
      for (let i = 0; i < 20; i += 1) {
        await auctionRow(new Date(`${auction}T09:${String(i).padStart(2, '0')}:00+03:00`), auction);
      }
      // …and ONCE fails to switch screens, so the same instant is stored under
      // both. That single bad sweep is the entire evidence the repair acts on.
      const clash = new Date(`${auction}T10:00:00+03:00`);
      await auctionRow(clash, auction);
      await quote('LABELX', clash, auction, 100);

      const dry = await repair.repairMarketLabels({ apply: false });
      const entry = dry.decided.find((d) => d.symbol === 'LABELX');
      ck('the collision is found', !!entry, dry.decided.map((d) => d.symbol));
      ck('and the repair is scoped to the colliding DAY only',
        entry && entry.days.length === 1 && entry.days[0] === auction, entry && entry.days);

      const before = await query("SELECT count(*)::int c FROM awsat_market_quotes WHERE symbol='LABELX' AND trading_date=$1", [main]);
      await repair.repairMarketLabels({ apply: true });
      const after = await query("SELECT count(*)::int c FROM awsat_market_quotes WHERE symbol='LABELX' AND trading_date=$1", [main]);
      ck('THE UNCOLLIDING DAY IS UNTOUCHED — the history survives',
        after.rows[0].c === before.rows[0].c, [before.rows[0].c, after.rows[0].c]);

      const wrongLabel = await query(
        "SELECT count(*)::int c FROM awsat_market_quotes WHERE symbol='LABELX' AND trading_date=$1 AND market='Main Market'", [auction]);
      ck('the WRONG label on the colliding day is removed', wrongLabel.rows[0].c === 0, wrongLabel.rows[0]);
      const rightLabel = await query(
        "SELECT count(*)::int c FROM awsat_market_quotes WHERE symbol='LABELX' AND trading_date=$1 AND market='Auction Market'", [auction]);
      ck('and the right one is kept', rightLabel.rows[0].c === 21, rightLabel.rows[0]);
    }

    // ── and it is out of the unattended path ──────────────────────────────
    {
      const mig = read('scripts/migrate-all.js');
      ck('migrate-all no longer applies the repair',
        /repairMarketLabels\(\{ apply: false \}\)/.test(mig));
      ck('and it points at the deliberate script instead',
        /repair-market-labels\.js --apply/.test(mig));
      ck('the script exists and is dry-run by default',
        fs.existsSync(path.join(REPO, 'scripts/repair-market-labels.js'))
        && /DRY RUN BY DEFAULT/.test(read('scripts/repair-market-labels.js')));
    }

    await query("DELETE FROM awsat_market_quotes WHERE symbol LIKE 'SCORE%' OR symbol LIKE 'LABEL%'");
  } catch (e) {
    ck('the suite ran without throwing', false, e.message);
  }

  await close();
  console.log(`\nsignal scoring window: ${p}/${n}`);
  process.exit(p === n ? 0 : 1);
})();

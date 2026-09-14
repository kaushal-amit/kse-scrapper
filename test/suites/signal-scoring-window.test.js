'use strict';
/**
 * F-11 and F-15 — two ways a tool quietly answered the wrong question.
 *
 * F-15 · THE FORWARD PRICE CROSSED SESSIONS.
 * Neither of priceAfter's queries bounded the search. A signal firing at 13:05
 * with a 60-minute horizon looked for the first capture at or after 14:05 —
 * continuous trading ends at 13:30, so it returned the NEXT SESSION'S OPENING
 * PRINT. On a Thursday that is three calendar days and a weekend later, gap
 * included. `was_right` then recorded a win measuring an overnight gap rather
 * than a 60-minute book signal, and because halts cluster late in the session
 * this preferentially corrupted HALT_RESUME — the one setup the strategy is
 * built on. These numbers are the evidence base for deciding whether any of
 * these signals work.
 *
 * NOT COMPUTED is the honest answer: the session ended before the question
 * could be asked, and a cross-session price is not a late answer to it.
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

    // ── F-15 · the cross-session read ─────────────────────────────────────
    {
      // The signal's own session: a print at 13:05 and the last one at 13:29.
      await quote('SCOREA', THU('13:05'), '2026-09-10', 204);
      await quote('SCOREA', THU('13:11'), '2026-09-10', 205);   // inside a 5-min horizon
      await quote('SCOREA', THU('13:29'), '2026-09-10', 206);   // the session's last print
      // The next session opens higher — the gap that used to be scored as a win.
      await quote('SCOREA', SUN('09:00'), '2026-09-13', 211);

      const at5 = await score.priceAfter('SCOREA', THU('13:05'), 5);
      ck('a horizon INSIDE the session is answered', at5 === 205, at5);

      const at60 = await score.priceAfter('SCOREA', THU('13:05'), 60);
      ck('a horizon PAST THE CLOSE is NOT COMPUTED, not the next session',
        at60 === null, at60);
      ck('and specifically it is not the next session opening print',
        at60 !== 211, at60);
    }

    // ── a long capture gap does not silently answer a different question ──
    {
      await quote('SCOREB', THU('09:00'), '2026-09-10', 100);
      // Nothing for 40 minutes, then a print. "The price 5 minutes later"
      // cannot be satisfied by one 40 minutes later.
      await quote('SCOREB', THU('09:40'), '2026-09-10', 130);
      const at5 = await score.priceAfter('SCOREB', THU('09:00'), 5);
      ck('a capture 40 minutes past a 5-minute horizon does not answer it',
        at5 === null, at5);

      // Inside the tolerance it does.
      await quote('SCOREB', THU('09:07'), '2026-09-10', 102);
      ck('one 2 minutes past the horizon does', await score.priceAfter('SCOREB', THU('09:00'), 5) === 102);
    }

    // ── the same day, both sources ────────────────────────────────────────
    {
      const src = read('src/jobs/scoreSignals.js');
      ck('the symbol_minute query is bounded to the trading day',
        /FROM symbol_minute[\s\S]{0,400}trading_date = \$4::date/.test(src));
      ck('and so is the quotes fallback',
        /FROM awsat_market_quotes[\s\S]{0,400}trading_date = \$4::date/.test(src));
      ck('both carry an upper bound as well as a lower one',
        (src.match(/\(\(\$3::int \+ \$5::int\) \|\| ' minutes'\)::interval/g) || []).length === 2);
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

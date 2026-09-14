'use strict';
/**
 * S-13 · symbols are upper case, and the database says so (round 3, 042/043).
 *
 * Every writer upper-cases the symbol. Nothing enforced it, so the one path that
 * ever forgot would write 'cattl' beside 'CATTL' as a DIFFERENT symbol: a
 * separate row in symbol_day, a separate entry in instruments, a join that
 * silently matches nothing. Not an error — a quiet halving of a symbol's
 * history, which is the worst shape a bug takes here.
 *
 * The two-migration split is the interesting part. awsat_market_quotes held
 * 838,762 rows at migration 014 and grows every minute of every session. A
 * validating ADD CONSTRAINT takes ACCESS EXCLUSIVE and scans the whole table;
 * during a session it queues behind any open scraper transaction and every
 * quote insert queues behind IT. A trading minute cannot be re-scraped, so a
 * lock that stalls the capture costs data. NOT VALID binds new rows under a
 * weak lock; the scan is 043's problem, under SHARE UPDATE EXCLUSIVE, which
 * runs alongside INSERTs.
 */
const { requireTestDb } = require('../dbguard');
requireTestDb('symbol-case');

const { query, close } = require('../../src/db/pool');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };

const quote = (symbol) => query(
  `INSERT INTO awsat_market_quotes (symbol, market, created_at, trading_date, ingest_source, last_price)
   VALUES ($1, 'Main Market', now(), '2026-09-10', 'awsat_client', 176)`, [symbol]);

(async () => {
  try {
    await query("DELETE FROM awsat_market_quotes WHERE symbol ILIKE 'CASE%'");

    // ── the constraint exists and is VALIDATED ─────────────────────────────
    {
      const { rows } = await query(`
        SELECT conname, convalidated FROM pg_constraint
         WHERE conname = 'awsat_quotes_symbol_upper'
           AND conrelid = 'public.awsat_market_quotes'::regclass`);
      ck('the constraint exists', rows.length === 1, rows);
      ck('and 043 validated it — it covers the existing rows too',
        rows[0] && rows[0].convalidated === true, rows[0]);
    }

    // ── it does its job ────────────────────────────────────────────────────
    {
      await quote('CASEUP');
      const { rows } = await query("SELECT count(*)::int c FROM awsat_market_quotes WHERE symbol = 'CASEUP'");
      ck('an upper-case symbol is accepted', rows[0].c === 1, rows[0]);

      let refused = false;
      let msg = '';
      try { await quote('caselow'); } catch (e) { refused = true; msg = e.message; }
      ck('a LOWER-case symbol is refused at the database', refused, msg);
      ck('and the refusal names the constraint', /awsat_quotes_symbol_upper/.test(msg), msg);

      let mixed = false;
      try { await quote('CaseMix'); } catch { mixed = true; }
      ck('a mixed-case symbol is refused too', mixed);
    }

    // ── the split is real: 042 declares, 043 scans ─────────────────────────
    {
      const fs = require('fs');
      const path = require('path');
      const dir = path.join(__dirname, '../../src/db/migrations');
      const notValid = fs.readFileSync(path.join(dir, '042_quotes_symbol_upper_notvalid.sql'), 'utf8');
      const validate = fs.readFileSync(path.join(dir, '043_quotes_symbol_upper_validate.sql'), 'utf8');

      ck('042 adds the constraint NOT VALID', /ADD CONSTRAINT[\s\S]*NOT VALID/.test(notValid));
      ck('042 does NOT validate — that is the whole point',
        !/VALIDATE CONSTRAINT/.test(notValid));
      ck('043 validates, and does nothing else',
        /VALIDATE CONSTRAINT awsat_quotes_symbol_upper/.test(validate)
        && !/ADD CONSTRAINT/.test(validate));
      ck('042 explains why the scan is deferred — the lock would stall the capture',
        /ACCESS EXCLUSIVE/.test(notValid) && /re-scraped/.test(notValid));
      ck('043 says a violating row must be looked at, not migrated past',
        /looked at rather than migrated past/.test(validate));
    }

    await query("DELETE FROM awsat_market_quotes WHERE symbol ILIKE 'CASE%'");
  } catch (e) {
    ck('the suite ran without throwing', false, e.message);
  }

  await close();
  console.log(`\nsymbol case: ${p}/${n}`);
  process.exit(p === n ? 0 : 1);
})();

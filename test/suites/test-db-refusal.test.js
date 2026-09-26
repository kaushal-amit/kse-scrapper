'use strict';
/**
 * ============================================================================
 *  A CAPTURE JOB DOES NOT FILL A DATABASE SOMEBODY EXPECTS TO DROP
 * ============================================================================
 * kse_test could not be rebuilt from kse because a live TradingView process
 * kept writing into it — a deployment pointed at the wrong DATABASE_URL.
 * Stopping that is an ENABLED_SCRAPERS change, and a config change is exactly
 * the kind of thing that comes back after a rebuild. So the refusal lives at
 * the write.
 *
 * This is the scraper's side of the rule test/dbguard.js already enforces for
 * the backend suites, pointing the other way: dbguard refuses to let a TEST
 * suite touch a real database; this refuses to let a REAL job touch a test one.
 *
 * The escape hatch is checked too. A guard with no way to seed a test database
 * on purpose gets removed the first time somebody needs to, and removed guards
 * do not come back.
 * ============================================================================
 */
const jobs = require('../../src/jobs');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };

const saved = { url: process.env.DATABASE_URL, allow: process.env.ALLOW_TEST_DB_WRITES };
const restore = () => {
  if (saved.url === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved.url;
  if (saved.allow === undefined) delete process.env.ALLOW_TEST_DB_WRITES; else process.env.ALLOW_TEST_DB_WRITES = saved.allow;
};

/** The job refuses before it scrapes, so calling it needs no browser and no DB. */
async function refusalFor(url, allow) {
  process.env.DATABASE_URL = url;
  if (allow === undefined) delete process.env.ALLOW_TEST_DB_WRITES;
  else process.env.ALLOW_TEST_DB_WRITES = allow;
  try {
    await jobs.JOBS['tradingview.quotes'](null);
    return null;                       // it got past the guard
  } catch (e) {
    return e && e.message ? e.message : String(e);
  }
}

(async () => {
  try {
    console.log('\n=== it refuses a *_test database ===');
    const r = await refusalFor('postgres://u@h:5432/kse_test');
    ck('tradingview.quotes refuses when DATABASE_URL names kse_test',
      /REFUSES to write/.test(r || ''), r && r.slice(0, 80));
    ck('  and NAMES the database, so the reason is in the error not in a comment',
      /"kse_test"/.test(r || ''), r && r.slice(0, 80));
    ck('  and says what to do instead', /ALLOW_TEST_DB_WRITES=1/.test(r || ''), null);
    ck('  and says WHY it matters — the rebuild that could not happen',
      /rebuilt from kse/.test(r || ''), null);

    console.log('\n=== case, suffix and the escape hatch ===');
    ck('KSE_TEST in capitals is the same database',
      /REFUSES to write/.test((await refusalFor('postgres://u@h:5432/KSE_TEST')) || ''), null);
    ck('a name merely CONTAINING test is not refused — kse_testing is somebody\'s real db',
      !/REFUSES to write/.test((await refusalFor('postgres://u@h:5432/kse_testing')) || ''), null);
    ck('the real database is not refused',
      !/REFUSES to write/.test((await refusalFor('postgres://u@h:5432/kse')) || ''), null);
    ck('ALLOW_TEST_DB_WRITES=1 seeds a test database on purpose',
      !/REFUSES to write/.test((await refusalFor('postgres://u@h:5432/kse_test', '1')) || ''), null);
    ck('  but only when it is exactly 1 — a truthy-looking value is not a decision',
      /REFUSES to write/.test((await refusalFor('postgres://u@h:5432/kse_test', 'true')) || ''), null);

    console.log('\n=== and the guard can fail ===');
    // If the URL parse ever silently returns '' for everything, every check
    // above passes vacuously. Prove the name is really being read.
    ck('a malformed DATABASE_URL does not refuse (it cannot name a database)',
      !/REFUSES to write/.test((await refusalFor('not-a-url')) || ''), null);

    restore();
    console.log(`\ntest db refusal: ${p}/${n}`);
    process.exit(p === n ? 0 : 1);
  } catch (e) {
    restore();
    console.error('test-db-refusal ERROR', e);
    process.exit(1);
  }
})();

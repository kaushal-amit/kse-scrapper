'use strict';
/**
 * S-01 · the suites refuse any database whose name does not end in _test.
 *
 * These suites insert, update and DELETE; several clear a table before seeding
 * it. Pointed at `kse` they destroy the trading record, and a trading minute
 * cannot be re-scraped. The guard is on the database NAME because that is the
 * thing an operator chooses deliberately — a `kse` on localhost is still the
 * trading record if a dump was restored into it.
 *
 * The last check is the one that matters: `npm test` itself must refuse, before
 * any suite has been spawned.
 */
const { spawnSync } = require('child_process');
const path = require('path');
const { isTestDatabase, databaseName } = require('../dbguard');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };

// ── the name is read out of the URL, not guessed ────────────────────────────
ck('a plain url', databaseName('postgres://u:p@h:5432/kse_test') === 'kse_test');
ck('a url with query params', databaseName('postgres://u:p@h:5432/kse_test?sslmode=require') === 'kse_test');
ck('a url with no database at all reads as no name — not as the host',
  databaseName('postgres://u:p@h:5432') === null, databaseName('postgres://u:p@h:5432'));
ck('and such a url is refused', isTestDatabase('postgres://u:p@h:5432') === false);
// A password containing '@' or '#' makes `new URL()` throw. The guard must still
// read the name rather than failing for an unrelated reason.
ck('a password with an @ in it does not break the read',
  databaseName('postgres://u:pa@ss@h:5432/kse_test') === 'kse_test',
  databaseName('postgres://u:pa@ss@h:5432/kse_test'));
ck('an empty url reads as no name', databaseName('') === null && databaseName(undefined) === null);

// ── the rule ────────────────────────────────────────────────────────────────
ck('kse_test is accepted', isTestDatabase('postgres://u:p@h:5432/kse_test') === true);
ck('spread_shared_test is accepted', isTestDatabase('postgres://u:p@h:5432/spread_shared_test') === true);
ck('THE TRADING DATABASE IS REFUSED', isTestDatabase('postgres://u:p@h:5432/kse') === false);
ck('a near-miss is refused: kse_testing', isTestDatabase('postgres://u:p@h:5432/kse_testing') === false);
ck('a near-miss is refused: test_kse', isTestDatabase('postgres://u:p@h:5432/test_kse') === false);
ck('_TEST upper case is refused — the name is exact',
  isTestDatabase('postgres://u:p@h:5432/kse_TEST') === false);
ck('the HOST does not make it safe — a kse on localhost is still the record',
  isTestDatabase('postgres://postgres@localhost:5432/kse') === false);
ck('and a _test on a remote host is still a test database',
  isTestDatabase('postgres://u:p@prod-rds.amazonaws.com:5432/kse_test') === true);

// ── npm test itself refuses, before any suite runs ──────────────────────────
{
  const runner = path.join(__dirname, '..', 'all.js');
  const res = spawnSync(process.execPath, [runner], {
    encoding: 'utf8', timeout: 60_000,
    // An explicit empty-ish env: dotenv must not be able to load a real .env and
    // hand the runner a usable DATABASE_URL behind the test's back.
    env: { ...process.env, DATABASE_URL: 'postgres://u:p@h:5432/kse', DOTENV_CONFIG_PATH: '/nonexistent' },
    cwd: path.join(__dirname, '..', '..'),
  });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  ck('npm test against "kse" exits non-zero', res.status !== 0, res.status);
  ck('and names the database it refused', /REFUSING to run against database "kse"/.test(out), out.slice(0, 300));
  ck('and says why — there is no undo', /cannot be re-scraped|DELETE/.test(out), out.slice(0, 300));
  ck('and it stops BEFORE running any suite', !/\[ok  \]|\[FAIL\]/.test(out), out.slice(0, 300));
}

console.log(`\ndbguard: ${p}/${n}`);
process.exit(p === n ? 0 : 1);

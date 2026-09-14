'use strict';
/**
 * test/dbguard.js — the suites REFUSE any database whose name does not end in
 * `_test`.
 *
 * Why this exists at all: these suites insert, update and DELETE. Several of
 * them clear a table before seeding it. Pointed at `kse` they destroy the
 * trading record — and a trading minute cannot be re-scraped, so the loss is
 * permanent. The backend already carries this guard (`test/dbguard.js` there);
 * the two repos' suites share one `kse_test`, so they must share the rule.
 *
 * The check is on the DATABASE NAME, not on the host. A `kse` on localhost is
 * still the trading record if someone restored a dump into it, and a
 * `kse_test` on RDS is still a test database. The name is the thing the
 * operator controls deliberately.
 *
 * Refusing is the whole point: there is no "assume it is safe" branch, and no
 * environment variable that turns the guard off. If a suite needs a database it
 * must be given a `_test` one.
 */

/** The database name from a postgres URL, or null if it cannot be read. */
function databaseName(url) {
  if (!url) return null;
  // Deliberately not `new URL()` alone: a password with an unescaped '@' or '#'
  // makes that throw, and a guard that throws on a malformed URL for the WRONG
  // reason tells the operator nothing useful. Take the path component by hand.
  const withoutQuery = String(url).split('?')[0];
  // Drop the scheme's own '//' first, or a URL with no path at all
  // ("postgres://host:5432") reads its authority as the database name. That
  // would still be REFUSED — it does not end in _test — but it would refuse
  // while naming something that is not a database, which sends the operator
  // looking in the wrong place.
  const afterScheme = withoutQuery.replace(/^[a-z0-9+.-]+:\/\//i, '');
  const slash = afterScheme.indexOf('/');
  if (slash === -1) return null;
  const name = afterScheme.slice(slash + 1).trim();
  return name || null;
}

function isTestDatabase(url) {
  const name = databaseName(url);
  return !!name && /_test$/.test(name);
}

/**
 * Called at the top of every suite that touches the database, and once by
 * test/all.js for the whole run. `who` names the suite in the refusal so the
 * operator knows which one stopped.
 */
function requireTestDb(who = 'this suite') {
  const url = process.env.DATABASE_URL;
  if (!url) {
    process.stderr.write(
      `\n${who}: DATABASE_URL is not set. The DB suites need a database whose name ends in _test.\n`
      + '  DATABASE_URL=postgres://user:pass@host:5432/kse_test npm test\n\n');
    process.exit(1);
  }
  if (!isTestDatabase(url)) {
    const name = databaseName(url);
    process.stderr.write(
      `\n${who}: REFUSING to run against database "${name || '(unreadable)'}".\n`
      + '  These suites insert and DELETE rows. The database name must end in _test.\n'
      + '  A trading minute cannot be re-scraped — there is no undo for this one.\n'
      + `  DATABASE_URL=postgres://…/${(name || 'kse')}_test npm test\n\n`);
    process.exit(1);
  }
  return url;
}

module.exports = { requireTestDb, isTestDatabase, databaseName };

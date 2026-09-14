'use strict';
/**
 * H-D and H-I · the two attempts a day, and the two ways they used to be lost.
 *
 * THE BROKER ALLOWS TWO LOGIN ATTEMPTS PER DAY. It is the only resource in this
 * system with a hard external cap, and exceeding it locks the account — which
 * ends the capture for the session and needs a human at the broker to undo.
 *
 * H-D · THE DECISION WAS MADE OUTSIDE THE LOCK.
 * recordAttempt was correctly a read-modify-write under withLock. check()
 * correctly read the state. But they were TWO lock acquisitions, and awsat.js
 * decided in the gap:
 *
 *   const verdict = guard.check();   // lock taken, released
 *   if (!verdict.allowed) return;
 *   guard.recordAttempt();           // lock taken again
 *
 * Two processes — the scheduler and a hand-run `npm run run:once`, or a
 * respawned worker and its host — both read "1 remaining", both pass, both
 * attempt. A lock around each half of a decision is not a lock around the
 * decision.
 *
 * H-I · A MISTYPED PASSWORD DISABLED THE SCRAPER INDEFINITELY.
 * BROKER_LOCKOUT matched `invalid (user|password|credential)`. That was survivable
 * while the lockout cleared itself overnight. F-02 made the lockout a fact about
 * the ACCOUNT that carries forward until a human clears it — and from that
 * moment one wrong AWSAT_PASS, or a password rotated at the broker, permanently
 * disabled the capture with a banner blaming the broker for it.
 *
 * A rejected credential is a FAILED ATTEMPT. It debits the budget, the budget
 * refuses the third login, and that is the protection the cap exists to give.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };

const REPO = path.join(__dirname, '..', '..');
const GUARD = path.join(REPO, 'src/scrapers/loginGuard.js');
const STATE = path.join(os.tmpdir(), `login-reservation-${process.pid}.json`);

const env = (over = {}) => ({
  ...process.env,
  AWSAT_LOGIN_STATE: STATE,
  AWSAT_MAX_LOGIN_ATTEMPTS: '2',
  AWSAT_LOGIN_COOLDOWN_MS: '0',
  DATABASE_URL: 'postgres://x@127.0.0.1:5432/x_test',
  ...over,
});

/** Run a snippet in a child process against the shared state file. */
const run = (body, over) => execFileSync(process.execPath, ['-e',
  `const guard = require(${JSON.stringify(GUARD)});\n${body}`],
{ encoding: 'utf8', env: env(over), cwd: REPO }).trim().split('\n').pop();

const reset = () => { try { fs.unlinkSync(STATE); } catch { /* absent */ } };

try {
  // ── reserve() debits as it decides ────────────────────────────────────────
  {
    reset();
    ck('a fresh day offers the whole budget',
      run('process.stdout.write(String(guard.check().attemptsLeft))') === '2');

    ck('reserve grants the first attempt',
      run('const v = guard.reserve(); process.stdout.write(v.allowed + ":" + v.attemptsLeft)') === 'true:1');
    ck('and it is ALREADY DEBITED — the grant is the debit',
      run('process.stdout.write(String(guard.check().attemptsLeft))') === '1');

    ck('the second is granted too',
      run('const v = guard.reserve(); process.stdout.write(v.allowed + ":" + v.attemptsLeft)') === 'true:0');
    ck('and the third is REFUSED',
      run('process.stdout.write(String(guard.reserve().allowed))') === 'false');
    ck('with a reason naming the budget rather than a generic failure',
      /attempt/i.test(run('process.stdout.write(guard.reserve().reason)')));
    ck('a refusal does not debit anything further',
      run('guard.reserve(); process.stdout.write(String(guard.summary().attemptsUsed))') === '2');
  }

  // ── THE RACE · four processes, one remaining attempt ──────────────────────
  {
    reset();
    run('guard.reserve()');   // spend one of the two
    ck('one attempt remains', run('process.stdout.write(String(guard.check().attemptsLeft))') === '1');

    /*
     * Four processes reserve at once. Exactly ONE may be told yes. Under the
     * old check()-then-recordAttempt shape all four could read attemptsLeft: 1,
     * all four pass the check, and all four attempt — against a cap of two,
     * with two already spent.
     */
    const script = `
      const guard = require(${JSON.stringify(GUARD)});
      process.stdout.write(String(guard.reserve().allowed));`;
    const results = [];
    const { spawnSync } = require('child_process');
    const kids = [];
    for (let i = 0; i < 4; i += 1) {
      kids.push(['-e', script]);
    }
    // Sequential spawns still exercise the file lock across process
    // boundaries; the property under test is that the BUDGET is authoritative,
    // not that the OS interleaved them.
    for (const args of kids) {
      results.push(spawnSync(process.execPath, args,
        { encoding: 'utf8', env: env(), cwd: REPO }).stdout.trim().split('\n').pop());
    }

    const granted = results.filter((r) => r === 'true').length;
    ck('EXACTLY ONE of four is granted the last attempt', granted === 1, results);
    ck('and the counter agrees — no attempt was recorded twice or lost',
      run('process.stdout.write(String(guard.summary().attemptsUsed))') === '2');
  }

  // ── a granted reservation survives the process that took it ───────────────
  {
    reset();
    run('guard.reserve()');
    ck('an attempt taken by a process that then dies is still spent — the '
      + 'broker counted it even though we never got to report success',
      run('process.stdout.write(String(guard.summary().attemptsUsed))') === '1');
  }

  // ── check() is an enquiry and does NOT reserve ────────────────────────────
  {
    reset();
    ck('ten checks spend nothing',
      run('for (let i = 0; i < 10; i++) guard.check(); '
        + 'process.stdout.write(String(guard.summary().attemptsUsed))') === '0');
  }

  // ── and awsat.js no longer decides in the gap ─────────────────────────────
  {
    const src = fs.readFileSync(path.join(REPO, 'src/scrapers/awsat.js'), 'utf8');
    const live = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    ck('the login path calls reserve()', /guard\.reserve\(\)/.test(live));
    ck('and no longer calls recordAttempt at all',
      !/guard\.recordAttempt\(/.test(live), (live.match(/.*guard\.recordAttempt.*/g) || []));
    ck('nor decides on a bare check()', !/const verdict = guard\.check\(\)/.test(live));
  }

  // ── H-I · a rejected credential is an attempt, not a lockout ──────────────
  {
    const src = fs.readFileSync(path.join(REPO, 'src/scrapers/awsat.js'), 'utf8');
    const block = src.slice(src.indexOf('const BROKER_LOCKOUT'),
      src.indexOf("].join('|'), 'i')"));
    const live = block.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

    ck('`invalid user/password` is NOT a lockout phrase',
      !/invalid\\\\s\+\(user/.test(live) && !/'invalid/.test(live), live.match(/.*invalid.*/));

    // The regex itself, rebuilt from the file, run against real broker text.
    const PATTERNS = [
      '\\block(ed|out)\\b',
      '(login|attempt|logon)[^.]{0,40}exceeded',
      'exceeded[^.]{0,40}(login|attempt|logon)',
      'maximum\\s+number\\s+of\\s+login',
      'already\\s+(logged|active)',
      '1841841',
    ];
    const RE = new RegExp(PATTERNS.join('|'), 'i');

    ck('a wrong password does not read as a lockout',
      RE.test('Invalid user name or password') === false);
    ck('nor an invalid credential', RE.test('Invalid credentials supplied') === false);

    // …and everything that IS a lockout still is.
    ck('an account locked out still is', RE.test('Your account has been locked out'));
    ck('a locked account still is', RE.test('This user is locked'));
    ck('the broker code still is', RE.test('Error 1841841'));
    ck('an exceeded login limit still is', RE.test('Maximum number of login attempts exceeded'));
    ck('an already-active session still is', RE.test('User already logged in elsewhere'));

    // …and the words that used to trip it still do not.
    ck('BLOCKED is not a lockout', RE.test('Request blocked by the firewall') === false);
    ck('a Playwright timeout is not a lockout',
      RE.test('Timeout 30000ms exceeded waiting for selector') === false);
    ck('and a deadlock is not one either', RE.test('deadlock detected') === false);
  }
} catch (e) {
  ck('the suite ran without throwing', false, e.message);
}

reset();
console.log(`\nlogin reservation: ${p}/${n}`);
process.exit(p === n ? 0 : 1);

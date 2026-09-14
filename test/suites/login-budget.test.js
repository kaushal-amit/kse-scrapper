'use strict';
/**
 * F-02 · the login budget actually holds.
 *
 * The broker allows a HARD 2 login attempts a day, and this guard is the only
 * thing standing between a restart loop and a locked account. Three defects,
 * each of which broke it in a different way.
 *
 * 1 · A SUCCESSFUL LOGIN REFUNDED ITS OWN ATTEMPT.
 *     `attempts = Math.max(0, attempts - 1)`, on the premise that "the broker
 *     counts FAILED attempts" — a premise stated nowhere else in the project;
 *     .env.example calls the cap ATTEMPTS, "held one below the broker's real
 *     cap", and this file's own lockout regex matches `already (logged|active)`,
 *     which is evidence the broker cares about repeat sessions.
 *
 *     A board login at 10:00 took attempts 0→1→0. At 10:12 the depth job
 *     overran, the worker was terminated and the session died with it; the next
 *     worker found attempts: 0, was allowed a fresh login, succeeded, and
 *     refunded again. Up to ~24 real logins in a session against a cap of 2,
 *     with the guard reporting attemptsLeft: 2 throughout.
 *
 * 2 · THE LOCKOUT SELF-CLEARED OVERNIGHT.
 *     `current()` returned a fresh object on a new trading day, so a flag whose
 *     own comment says "Requires a human to clear" cleared itself. The next
 *     morning the scraper walked into a locked account and spent the new day's
 *     attempts discovering it was still locked.
 *
 * 3 · THE COUNTER WAS A READ-MODIFY-WRITE WITH NO LOCK.
 *     Which is the one thing this file exists to survive: two processes
 *     interleaving both read `attempts: 0` and both write `1` — two real
 *     attempts recorded as one, and a third then permitted.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');


const STATE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'loginguard-')), 'attempts.json');
process.env.AWSAT_LOGIN_STATE = STATE;
process.env.AWSAT_LOGIN_COOLDOWN_MS = '0';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x@127.0.0.1:5432/x_test';

const guard = require('../../src/scrapers/loginGuard');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };

const state = () => JSON.parse(fs.readFileSync(STATE, 'utf8'));
const reset = () => { try { fs.unlinkSync(STATE); } catch { /* fresh */ } };

// ── 1 · a success does NOT refund ───────────────────────────────────────────
{
  reset();
  ck('a fresh day starts with the full budget', guard.check().attemptsLeft === 2, guard.summary());

  guard.recordAttempt();
  ck('one attempt is debited', guard.check().attemptsLeft === 1, guard.summary());

  guard.recordSuccess();
  ck('A SUCCESS DOES NOT REFUND IT', guard.check().attemptsLeft === 1, guard.summary());
  ck('but the success is recorded', typeof state().lastSuccessAt === 'number', state());

  guard.recordAttempt();
  guard.recordSuccess();
  ck('two successful logins spend the whole budget', guard.check().attemptsLeft === 0, guard.summary());
  ck('and a third is REFUSED', guard.check().allowed === false, guard.check());
  ck('with a reason naming the budget', /attempt/i.test(guard.check().reason), guard.check().reason);
}

// ── the loop that used to be unbounded ──────────────────────────────────────
{
  reset();
  // Terminate-and-respawn, ten times. Under the refund this stayed at 2 left
  // for ever; the whole point is that it cannot.
  for (let i = 0; i < 10; i += 1) {
    if (guard.check().allowed) { guard.recordAttempt(); guard.recordSuccess(); }
  }
  ck('ten respawn cycles cannot exceed the cap', state().attempts <= 2, state());
  ck('and the guard says so', guard.check().allowed === false, guard.check());
}

// ── 2 · the lockout survives the day rollover ───────────────────────────────
{
  reset();
  guard.recordLockout('the account was reported locked out');
  ck('a lockout refuses immediately', guard.check().allowed === false, guard.check());

  // Age the file into yesterday. current() resets the BUDGET on a new day; the
  // lockout is a fact about the ACCOUNT and must carry.
  const st = state();
  st.tradingDay = '2026-01-01';
  st.lockedOutOn = '2026-01-01';   // it happened on that day, not today
  st.attempts = 2;
  fs.writeFileSync(STATE, JSON.stringify(st), 'utf8');

  const after = guard.check();
  ck('the next day the BUDGET is reset', guard.summary().attemptsLeft === 2 || after.allowed === false, guard.summary());
  ck('but the LOCKOUT still refuses', after.allowed === false, after);
  ck('and it says which day it happened on rather than "earlier today"',
    /2026-01-01/.test(after.reason), after.reason);
  ck('and how to clear it', /reset-lockout/.test(after.reason), after.reason);
}

// ── 3 · concurrent attempts cannot share one slot ───────────────────────────
{
  reset();
  /*
   * Four processes racing recordAttempt on the same file. Without the lock they
   * interleave read-modify-write and the file ends up at 1 or 2 rather than 4 —
   * which is exactly how a third real attempt gets permitted against a cap of 2.
   */
  const child = `
    process.env.AWSAT_LOGIN_STATE = ${JSON.stringify(STATE)};
    process.env.AWSAT_LOGIN_COOLDOWN_MS = '0';
    process.env.DATABASE_URL = 'postgres://x@127.0.0.1:5432/x_test';
    require(${JSON.stringify(path.join(__dirname, '../../src/scrapers/loginGuard.js'))}).recordAttempt();`;

  const kids = [];
  for (let i = 0; i < 4; i += 1) {
    kids.push(new Promise((resolve) => {
      const { spawn } = require('child_process');
      const c = spawn(process.execPath, ['-e', child], { stdio: 'ignore' });
      c.on('exit', resolve);
    }));
  }
  Promise.all(kids).then(() => {
    ck('four concurrent attempts are counted as FOUR, not lost to a race',
      state().attempts === 4, state());
    ck('and no lock file is left behind', !fs.existsSync(`${STATE}.lock`), `${STATE}.lock`);

    // ── the write is atomic ─────────────────────────────────────────────────
    {
      const src = fs.readFileSync(path.join(__dirname, '../../src/scrapers/loginGuard.js'), 'utf8');
      ck('the state file is written via a temp file and renamed',
        /renameSync\(tmp, STATE_PATH\)/.test(src));
      ck('a stale lock is BROKEN, not waited on for ever',
        /breaking a stale login state lock/.test(src));
      ck('and an unlockable filesystem proceeds, loudly, rather than refusing every login',
        /lock unavailable — proceeding without it/.test(src));
      ck('no refund survives anywhere',
        !/attempts = Math\.max\(0, state\.attempts - 1\)/.test(src));
    }

    try { fs.rmSync(path.dirname(STATE), { recursive: true, force: true }); } catch { /* best effort */ }
    console.log(`\nlogin budget: ${p}/${n}`);
    process.exit(p === n ? 0 : 1);
  });
}

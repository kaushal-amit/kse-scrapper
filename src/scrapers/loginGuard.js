'use strict';
/**
 * The AWSAT login attempt guard.
 *
 * ─── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
 * The broker terminal allows a small number of login attempts per trading day.
 * Exceed it and the account is locked for the rest of the session — which
 * cannot be undone by waiting, and costs the whole day's broker data.
 *
 * Until now the attempt counter was a module-level variable. That counts
 * attempts within one process and nothing else, so every one of these reset it
 * to zero and bought a fresh attempt:
 *
 *   - a restart, including `node --watch` firing on a saved file
 *   - a crash and a supervisor restart
 *   - a worker terminated on timeout and respawned
 *
 * An afternoon of editing files with the watcher running would spend the day's
 * attempts without anyone noticing until the lockout. The counter therefore has
 * to outlive the process, which means it has to be on disk.
 *
 * ─── WHY A FILE AND NOT THE DATABASE ───────────────────────────────────────
 * This has to work when the database is unreachable, because "database down" is
 * exactly when a restart loop happens. A local file is the one thing still
 * available in that state.
 */

const fs = require('fs');
const path = require('path');
const log = require('../logger');
const clock = require('../market/clock');

const STATE_PATH = process.env.AWSAT_LOGIN_STATE
  || path.resolve(__dirname, '..', '..', 'tmp', 'awsat-login-attempts.json');

/**
 * Attempts permitted per trading day, held one below the broker's real cap.
 *
 * The margin is deliberate: the true limit is the point at which the account
 * locks, and stopping AT it means the next mistake is the lockout itself. One
 * attempt in reserve is what makes a manual recovery possible.
 */
const MAX_ATTEMPTS = Number(process.env.AWSAT_MAX_LOGIN_ATTEMPTS || 2);

/** Minimum gap between attempts, so a fast retry loop cannot spend them all. */
const COOLDOWN_MS = Number(process.env.AWSAT_LOGIN_COOLDOWN_MS || 10 * 60_000);

function read() {
  try {
    if (!fs.existsSync(STATE_PATH)) return null;
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (err) {
    // A corrupt file must not be read as "zero attempts used". Treating an
    // unreadable counter as exhausted is the safe direction: the cost of a
    // wrong "wait" is a delay, the cost of a wrong "go ahead" is the day.
    log.warn('login attempt state unreadable — assuming attempts are spent', {
      path: STATE_PATH, err: err.message,
    });
    return { tradingDay: clock.tradingDay(), attempts: MAX_ATTEMPTS, lastAttemptAt: Date.now() };
  }
}

/**
 * Persist the state. Returns TRUE only if it actually landed.
 *
 * P2 · IT USED TO RETURN NOTHING, AND EVERY CALLER IGNORED THAT.
 *
 * read() fails SAFE — its own comment says so: "the cost of a wrong 'wait' is a
 * delay, the cost of a wrong 'go ahead' is the day", and an unreadable file is
 * treated as a spent budget. write() failed OPEN. It logged
 * "the guard is now blind" and returned normally, and reserve() went on to
 * report allowed with a debit that had not been recorded anywhere.
 *
 * current() re-reads from disk on the next call, so BOTH `attempts` and
 * `lastAttemptAt` reverted: the cap never advanced and the cooldown never
 * engaged either. Reproduced with the state path made unwritable — six
 * consecutive grants, every one logging "attempt 1 of 2", under a single ERROR
 * line predicting exactly that.
 *
 * An unwritable tmp/ is not exotic: a read-only mount, wrong ownership, a
 * volume that failed to attach. The file exists for one reason — to protect the
 * one resource with a hard external cap — and it failed open for the one reason
 * it could fail.
 */
function write(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    /*
     * ATOMIC: write a temp file, then rename over the target.
     *
     * A plain writeFileSync truncates first and writes second. A crash between
     * the two leaves a truncated JSON file — and while read() is fail-safe
     * about that (it assumes the attempts are spent), the operator then has a
     * guard that refuses everything for a reason that looks like corruption
     * rather than policy. rename(2) is atomic within a filesystem, so a reader
     * sees either the old state or the new one, never half of either.
     */
    const tmp = `${STATE_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, STATE_PATH);
    return true;
  } catch (err) {
    log.error('could not persist login attempt state — the guard is blind, so '
      + 'the attempt is REFUSED rather than granted against a counter that '
      + 'cannot advance', { path: STATE_PATH, err: err.message });
    return false;
  }
}

/**
 * Run `fn` with an exclusive lock on the state file.
 *
 * WHY THIS EXISTS. recordAttempt is a read-modify-write, and this file exists
 * precisely because the counter must survive process boundaries — the host
 * process and a freshly spawned worker, or the scheduler and a hand-run
 * `npm run run:once awsat.orders`. Two of them interleaving both read
 * `attempts: 0` and both write `1`: two real attempts recorded as one, and a
 * third then permitted against a cap of 2.
 *
 * O_EXCL on a lock file, because it is the one primitive available on every
 * filesystem this can run on without a dependency. The lock is advisory in the
 * sense that only this module takes it — which is enough, because only this
 * module writes the file.
 *
 * A STALE LOCK IS BROKEN, NOT WAITED ON. A process that died holding it would
 * otherwise block every login for the rest of the day, which is a worse outcome
 * than the race it prevents.
 */
const LOCK_PATH = `${STATE_PATH}.lock`;
const LOCK_STALE_MS = 30_000;

function withLock(fn) {
  const started = Date.now();
  let fd = null;

  while (Date.now() - started < 5_000) {
    try {
      fd = fs.openSync(LOCK_PATH, 'wx');
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') {
        // Cannot lock at all (permissions, read-only mount). Proceed unlocked
        // rather than refuse every login — and say so, because the race is now
        // possible again.
        log.warn('login state lock unavailable — proceeding without it', { err: err.message });
        return fn();
      }
      try {
        const age = Date.now() - fs.statSync(LOCK_PATH).mtimeMs;
        if (age > LOCK_STALE_MS) {
          log.warn('breaking a stale login state lock', { ageMs: Math.round(age) });
          fs.unlinkSync(LOCK_PATH);
          continue;
        }
      } catch { /* the holder released it between our open and our stat */ }
      // Busy-wait briefly. This is contended for milliseconds at most — the
      // critical section is one small read and one small write.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }

  if (fd === null) {
    log.warn('could not take the login state lock within 5s — proceeding without it');
    return fn();
  }

  try {
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    try { fs.unlinkSync(LOCK_PATH); } catch { /* already gone */ }
  }
}

/** Current state for today, resetting automatically on a new trading day. */
function current() {
  const today = clock.tradingDay();
  const state = read();
  if (!state || state.tradingDay !== today) {
    /*
     * A NEW DAY RESETS THE BUDGET — BUT NOT THE LOCKOUT.
     *
     * It used to reset both, because a fresh object was returned wholesale. So
     * `recordLockout`, whose own comment says "Requires a human to clear" and
     * whose log line says "clear it by hand once the broker confirms it is
     * usable", silently cleared itself overnight. The next morning the scraper
     * walked straight into a locked account and spent the new day's attempts
     * discovering it was still locked.
     *
     * The attempt COUNT is a per-day budget and resets. The lockout is a fact
     * about the ACCOUNT and carries forward until someone clears it.
     */
    return {
      tradingDay: today,
      attempts: 0,
      lastAttemptAt: null,
      lockedOut: !!(state && state.lockedOut),
      lockoutDetail: (state && state.lockedOut) ? state.lockoutDetail : undefined,
      lockedOutOn: (state && state.lockedOut) ? (state.lockedOutOn || state.tradingDay) : undefined,
    };
  }
  return state;
}

/**
 * The verdict for a state that has already been read.
 *
 * Split out of check() so that reserve() can decide and record INSIDE one lock.
 * See reserve for why that matters.
 */
function decide(state) {
  const left = MAX_ATTEMPTS - state.attempts;

  if (state.lockedOut) {
    return {
      allowed: false,
      attemptsLeft: 0,
      reason: `the account was reported locked out${state.lockedOutOn && state.lockedOutOn !== clock.tradingDay()
        ? ` on ${state.lockedOutOn}` : ' earlier today'}; `
        + 'clear it by hand once the broker confirms it is usable '
        + '(npm run awsat:login-state -- --reset-lockout)',
    };
  }

  if (left <= 0) {
    return {
      allowed: false,
      attemptsLeft: 0,
      reason: `all ${MAX_ATTEMPTS} login attempts for ${state.tradingDay} are spent. `
        + 'Waiting will not restore them — they reset on the next trading day.',
    };
  }

  if (state.lastAttemptAt) {
    const since = Date.now() - state.lastAttemptAt;
    if (since < COOLDOWN_MS) {
      const wait = Math.ceil((COOLDOWN_MS - since) / 1000);
      return {
        allowed: false,
        attemptsLeft: left,
        reason: `login cooldown: ${wait}s remaining before attempt ${state.attempts + 1}/${MAX_ATTEMPTS}`,
      };
    }
  }

  return { allowed: true, attemptsLeft: left, reason: 'ok' };
}

/**
 * May we attempt a login right now? READ-ONLY — this is an enquiry, for the
 * startup banner and for reporting. It does NOT reserve anything.
 *
 * Deciding with this and then calling recordAttempt is the H-D race; use
 * reserve() to actually take an attempt.
 *
 * @returns {{allowed: boolean, reason: string, attemptsLeft: number}}
 */
function check() {
  return decide(current());
}

/**
 * H-D · TAKE an attempt: decide and record under ONE lock.
 *
 * THE RACE THIS CLOSES. recordAttempt was correctly a read-modify-write under
 * withLock, and check() correctly read the state — but they were TWO separate
 * lock acquisitions, and the decision was made in the gap between them:
 *
 *   const verdict = guard.check();      // takes the lock, releases it
 *   if (!verdict.allowed) return;
 *   guard.recordAttempt();              // takes the lock again
 *
 * Two processes — the scheduler and a hand-run `npm run run:once`, or a
 * respawned worker and the host — can both read "1 attempt remaining", both
 * pass, and both attempt. The broker's limit is TWO PER DAY and exceeding it
 * locks the account. This is the one resource in the system with a hard
 * external cap, and the guard built to protect it decided outside its own lock.
 *
 * A reservation is not an opinion: if this returns allowed, the attempt is
 * ALREADY DEBITED, and the caller owns it whether or not the login then
 * succeeds. That is deliberate and matches recordAttempt's own rule — a process
 * that dies mid-login must not leave the attempt spent at the broker and
 * available in the counter.
 */
function reserve() {
  const result = withLock(() => {
    const st = current();
    const verdict = decide(st);
    if (!verdict.allowed) return verdict;

    st.attempts += 1;
    st.lastAttemptAt = Date.now();

    /*
     * THE DEBIT MUST LAND BEFORE THE GRANT.
     *
     * If the state file cannot be written, the next call re-reads the old
     * state: the counter never advances and the cooldown never engages, so
     * every worker respawn is granted an attempt that the broker is counting
     * and we are not. Refusing here costs a session's capture; granting costs
     * the account, and the account cannot be re-scraped either.
     */
    if (!write(st)) {
      return {
        allowed: false,
        attemptsLeft: 0,
        reason: `the login attempt could not be recorded at ${STATE_PATH}, so the `
          + 'budget cannot be tracked. Refusing rather than attempting against a '
          + 'counter that cannot advance — make that path writable and restart.',
      };
    }

    return {
      allowed: true,
      reason: 'ok',
      attempt: st.attempts,
      attemptsLeft: MAX_ATTEMPTS - st.attempts,
      tradingDay: st.tradingDay,
    };
  });

  if (result.allowed) {
    log.info('awsat login attempt reserved', {
      attempt: result.attempt, of: MAX_ATTEMPTS, tradingDay: result.tradingDay,
    });
  }
  return result;
}

/**
 * Record that an attempt is being made.
 *
 * Prefer reserve(). This records WITHOUT deciding, and exists for the paths
 * that legitimately have no decision to make — a login performed by hand
 * through `npm run awsat:login-state`, where the operator is the decision.
 * Pairing it with check() re-creates H-D.
 *
 * Called BEFORE the attempt, never after. A process that dies mid-login would
 * otherwise never record it, and the attempt would be spent at the broker while
 * the counter still showed it available — which is the exact accounting error
 * that leads to a lockout.
 */
function recordAttempt() {
  // Read-modify-write, under the lock. See withLock for why.
  const state = withLock(() => {
    const st = current();
    st.attempts += 1;
    st.lastAttemptAt = Date.now();
    write(st);
    return st;
  });
  log.info('awsat login attempt recorded', {
    attempt: state.attempts,
    of: MAX_ATTEMPTS,
    tradingDay: state.tradingDay,
  });
  return state;
}

/**
 * A successful login is recorded. It is NOT refunded.
 *
 * It used to be: `attempts = Math.max(0, attempts - 1)`, on the premise stated
 * in the old comment that "the broker counts FAILED attempts". That premise is
 * not the constraint as it is recorded anywhere else in this project —
 * .env.example describes the cap as ATTEMPTS, "held one below the broker's real
 * cap" — and this file's own lockout regex matches `already (logged|active)`,
 * which is evidence the broker cares about repeat sessions and not only about
 * failures.
 *
 * What the refund cost: a successful board login at 10:00 took attempts 0 -> 1
 * -> 0. At 10:12 the depth job overran, scrapeWorkerHost terminated the worker,
 * and the browser session died with it. The next worker found attempts: 0 and
 * was allowed a fresh login — which succeeded, and refunded again. Over a
 * four-hour session that is up to ~24 real logins against a cap of 2, with the
 * guard reporting attemptsLeft: 2 throughout.
 *
 * A counter that decrements on success cannot converge on the true count. If
 * the broker really does only count failures, the cost of this is a margin
 * narrower than it needs to be; the cost of the refund is the account.
 */
function recordSuccess() {
  withLock(() => {
    const state = current();
    state.lastSuccessAt = Date.now();
    write(state);
  });
}

/** Mark the account as locked out. Requires a human to clear. */
function recordLockout(detail) {
  const state = withLock(() => {
    const st = current();
    st.lockedOut = true;
    st.lockoutDetail = String(detail || '').slice(0, 500);
    // Which day it happened on, so the banner can say how long it has stood
    // rather than implying it happened today.
    st.lockedOutOn = st.lockedOutOn || clock.tradingDay();
    st.persisted = write(st);
    return st;
  });
  log.error('AWSAT ACCOUNT LOCKED OUT — no further attempts today', {
    detail: state.lockoutDetail, statePath: STATE_PATH,
  });
  /*
   * A lockout that could not be written is forgotten by the next call, and the
   * next worker walks into a locked account. reserve() already refuses when it
   * cannot persist, so the outcome is safe — but the operator has to be told
   * WHICH problem they have, because "the account is locked" and "the guard
   * cannot remember anything" need different actions.
   */
  if (!state.persisted) {
    log.error('AND THE LOCKOUT COULD NOT BE PERSISTED — it will not survive this '
      + 'process. Fix the state path before restarting, or the next run will '
      + 'rediscover the lockout by attempting a login.', { statePath: STATE_PATH });
  }
}

/** For the startup banner, so the day's budget is visible before anything runs. */
function summary() {
  const state = current();
  return {
    tradingDay: state.tradingDay,
    attemptsUsed: state.attempts,
    attemptsLeft: Math.max(0, MAX_ATTEMPTS - state.attempts),
    lockedOut: Boolean(state.lockedOut),
    statePath: STATE_PATH,
  };
}

module.exports = {
  check, reserve, recordAttempt, recordSuccess, recordLockout, summary,
  MAX_ATTEMPTS, COOLDOWN_MS, STATE_PATH,
};

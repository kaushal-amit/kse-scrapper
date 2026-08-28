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

function write(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    log.error('could not persist login attempt state — the guard is now blind', {
      path: STATE_PATH, err: err.message,
    });
  }
}

/** Current state for today, resetting automatically on a new trading day. */
function current() {
  const today = clock.tradingDay();
  const state = read();
  if (!state || state.tradingDay !== today) {
    return { tradingDay: today, attempts: 0, lastAttemptAt: null, lockedOut: false };
  }
  return state;
}

/**
 * May we attempt a login right now?
 * @returns {{allowed: boolean, reason: string, attemptsLeft: number}}
 */
function check() {
  const state = current();
  const left = MAX_ATTEMPTS - state.attempts;

  if (state.lockedOut) {
    return {
      allowed: false,
      attemptsLeft: 0,
      reason: 'the account was reported locked out earlier today; '
        + 'clear it by hand once the broker confirms it is usable',
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
 * Record that an attempt is being made.
 *
 * Called BEFORE the attempt, never after. A process that dies mid-login would
 * otherwise never record it, and the attempt would be spent at the broker while
 * the counter still showed it available — which is the exact accounting error
 * that leads to a lockout.
 */
function recordAttempt() {
  const state = current();
  state.attempts += 1;
  state.lastAttemptAt = Date.now();
  write(state);
  log.info('awsat login attempt recorded', {
    attempt: state.attempts,
    of: MAX_ATTEMPTS,
    tradingDay: state.tradingDay,
  });
  return state;
}

/**
 * A successful login refunds the attempt.
 *
 * The broker counts FAILED attempts, so a success that has been debited would
 * needlessly narrow the day's remaining margin. Called only after the logged-in
 * marker has actually been seen.
 */
function recordSuccess() {
  const state = current();
  state.attempts = Math.max(0, state.attempts - 1);
  state.lastSuccessAt = Date.now();
  write(state);
}

/** Mark the account as locked out. Requires a human to clear. */
function recordLockout(detail) {
  const state = current();
  state.lockedOut = true;
  state.lockoutDetail = String(detail || '').slice(0, 500);
  write(state);
  log.error('AWSAT ACCOUNT LOCKED OUT — no further attempts today', {
    detail: state.lockoutDetail, statePath: STATE_PATH,
  });
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
  check, recordAttempt, recordSuccess, recordLockout, summary,
  MAX_ATTEMPTS, COOLDOWN_MS, STATE_PATH,
};

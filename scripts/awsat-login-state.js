'use strict';
/**
 * scripts/awsat-login-state.js — inspect and clear the AWSAT login guard.
 *
 *   npm run awsat:login-state           show the state, change nothing
 *   npm run awsat:login-state -- --reset-lockout    clear a lockout flag
 *   npm run awsat:login-state -- --reset-attempts   restore today's budget
 *
 * ─── WHY THIS EXISTS ───────────────────────────────────────────────────────
 * The guard could set `lockedOut` and nothing could ever unset it. Every AWSAT
 * job then failed with "clear it by hand" — an instruction with no hand to do
 * it with. A guard that can only ever tighten is a trap, not a safeguard.
 *
 * Clearing the flag is deliberately manual and asks for confirmation, because
 * the flag exists for a real reason: if the broker HAS locked the ID, retrying
 * will not help and may make it worse. Confirm with the broker first, then
 * clear it.
 */

const fs = require('fs');
const readline = require('readline');
const guard = require('../src/scrapers/loginGuard');

const RESET_LOCKOUT = process.argv.includes('--reset-lockout');
const RESET_ATTEMPTS = process.argv.includes('--reset-attempts');
const YES = process.argv.includes('--yes');

function readRaw() {
  try {
    return JSON.parse(fs.readFileSync(guard.STATE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

async function confirm(prompt) {
  if (YES) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) => rl.question(prompt, r));
  rl.close();
  return answer.trim().toUpperCase() === 'YES';
}

async function main() {
  const state = readRaw();
  const summary = guard.summary();

  console.log('\n  AWSAT LOGIN GUARD');
  console.log(`  ${'─'.repeat(70)}`);
  console.log(`  state file      ${guard.STATE_PATH}`);
  if (!state) {
    console.log('  no state file yet — the guard starts clean on the next run.\n');
    return;
  }
  console.log(`  trading day     ${summary.tradingDay}`);
  console.log(`  attempts used   ${summary.attemptsUsed} of ${guard.MAX_ATTEMPTS}`);
  console.log(`  attempts left   ${summary.attemptsLeft}`);
  console.log(`  locked out      ${summary.lockedOut ? 'YES' : 'no'}`);
  if (state.lockoutDetail) {
    console.log(`\n  WHY IT WAS LOCKED:\n    ${String(state.lockoutDetail).slice(0, 400)}`);
  }
  if (state.lastAttemptAt) {
    console.log(`\n  last attempt    ${new Date(state.lastAttemptAt).toISOString()}`);
  }
  console.log(`  ${'─'.repeat(70)}`);

  if (!RESET_LOCKOUT && !RESET_ATTEMPTS) {
    if (summary.lockedOut) {
      console.log('\n  To clear the lockout — AFTER confirming with the broker that the ID');
      console.log('  is usable:\n');
      console.log('      npm run awsat:login-state -- --reset-lockout\n');
    } else {
      console.log('\n  Nothing to clear.\n');
    }
    return;
  }

  if (RESET_LOCKOUT) {
    console.log('\n  Clearing the lockout flag does NOT unlock the account at the broker.');
    console.log('  If the ID is still locked, the next attempt will fail and spend one of');
    console.log(`  the ${guard.MAX_ATTEMPTS} attempts for the day.`);
    if (!(await confirm('\n  Type YES if the broker has confirmed the ID is usable: '))) {
      console.log('\n  Left unchanged.\n');
      return;
    }
    state.lockedOut = false;
    delete state.lockoutDetail;
  }

  if (RESET_ATTEMPTS) {
    if (!(await confirm('\n  Type YES to restore the attempt budget for today: '))) {
      console.log('\n  Left unchanged.\n');
      return;
    }
    state.attempts = 0;
    state.lastAttemptAt = null;
  }

  fs.writeFileSync(guard.STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
  console.log('\n  Updated. Current state:');
  console.log(`    ${JSON.stringify(guard.summary())}\n`);
}

main().catch((err) => {
  console.error(`\n  failed: ${err.message}\n`);
  process.exit(1);
});

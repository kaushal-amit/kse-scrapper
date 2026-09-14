'use strict';
/**
 * S-02 · the three rules guarding the ingest surface, and no credential in git.
 *
 *   · a short INGEST_TOKEN REFUSES the boot (it used to be a warning)
 *   · INGEST_ORIGIN is an allowlist, and a list echoes the CALLER's origin back
 *   · a caller cannot spend the process on requests
 *   · secrets/ and tmp/ are not tracked — a live TradingView session was
 *
 * The last block is the one that has teeth: it fails if anyone re-adds a
 * credential to the index, whatever it is called.
 */
const { execFileSync } = require('child_process');
const path = require('path');
const {
  MIN_TOKEN_LENGTH, ConfigRefused, assertTokenPolicy, parseOrigins, resolveOrigin, createRateLimiter,
} = require('../../src/api/ingestSecurity');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };
const REPO = path.join(__dirname, '..', '..');

// ── the token policy ────────────────────────────────────────────────────────
{
  ck('the floor is 24 characters', MIN_TOKEN_LENGTH === 24, MIN_TOKEN_LENGTH);

  const absent = assertTokenPolicy(undefined);
  ck('no token is a configured state, not an error', absent.start === false, absent);
  ck('and the surface does not start', absent.start === false && /not set/.test(absent.reason), absent);

  let threw = null;
  try { assertTokenPolicy('short-one'); } catch (e) { threw = e; }
  ck('a SHORT token throws rather than warning', threw instanceof ConfigRefused, threw && threw.message);
  ck('and the refusal names the length it got and the length required',
    threw && /9 characters/.test(threw.message) && /at least 24/.test(threw.message), threw && threw.message);
  ck('and it hands over the command to generate one',
    threw && /randomBytes/.test(threw.message), threw && threw.message);
  ck('and it says the userscripts need the SAME value',
    threw && /SAME value/i.test(threw.message), threw && threw.message);

  // Exactly at the floor is allowed; one under is not.
  ck('exactly 24 is accepted', assertTokenPolicy('a'.repeat(24)).start === true);
  let edge = null;
  try { assertTokenPolicy('a'.repeat(23)); } catch (e) { edge = e; }
  ck('23 is refused', edge instanceof ConfigRefused);
}

// ── the origin allowlist ────────────────────────────────────────────────────
{
  ck('unset means any', parseOrigins(undefined).any === true);
  ck('empty means any', parseOrigins('').any === true && parseOrigins('   ').any === true);
  ck('a literal * means any', parseOrigins('*').any === true);

  const allow = parseOrigins('https://www.awsatbroker.com, https://kse-spread.web.app');
  ck('a comma list is parsed and trimmed',
    allow.any === false && allow.list.length === 2 && allow.list[1] === 'https://kse-spread.web.app', allow);

  ck('a listed origin is echoed BACK, not the first entry',
    resolveOrigin('https://kse-spread.web.app', allow) === 'https://kse-spread.web.app');
  ck('the other listed origin gets itself too — a list must allow both',
    resolveOrigin('https://www.awsatbroker.com', allow) === 'https://www.awsatbroker.com');
  ck('an unlisted origin is refused', resolveOrigin('https://evil.example', allow) === null);
  ck('a scheme mismatch is refused — not a substring match',
    resolveOrigin('http://kse-spread.web.app', allow) === null);
  ck('a suffix attack is refused',
    resolveOrigin('https://kse-spread.web.app.evil.example', allow) === null);

  // No Origin header is not a browser request; CORS cannot apply to it and the
  // token still does.
  ck('a request with NO origin is not blocked by a rule that cannot apply',
    resolveOrigin(undefined, allow) === '*' && resolveOrigin('', allow) === '*');
  ck('with * everything resolves to *',
    resolveOrigin('https://anything.example', parseOrigins('*')) === '*');
}

// ── the rate limiter ────────────────────────────────────────────────────────
{
  let t = 1_000_000;
  const rl = createRateLimiter({ windowMs: 60_000, max: 3, now: () => t });

  ck('under the limit is allowed', [1, 2, 3].every(() => rl.check('a').allowed === true));
  const over = rl.check('a');
  ck('the fourth is refused', over.allowed === false, over);
  ck('and it says when to come back', over.retryAfterSec > 0 && over.retryAfterSec <= 60, over);

  ck('a DIFFERENT caller is unaffected — one bad script cannot starve the others',
    rl.check('b').allowed === true);

  t += 60_001;
  ck('the window rolls', rl.check('a').allowed === true);
  ck('and the swept map does not grow without bound', rl.size() <= 2, rl.size());

  // A malformed env var must not silently REMOVE the limit: `count > NaN` is
  // false for every count, which is how a cap disappears without anyone noticing.
  const bad = createRateLimiter({ windowMs: Number('2k'), max: Number('lots'), now: () => t });
  ck('a malformed window falls back rather than disabling the limit', bad.windowMs === 60_000, bad.windowMs);
  ck('a malformed max falls back rather than disabling the limit', bad.max === 240, bad.max);
}

// ── no credential in the index ──────────────────────────────────────────────
{
  const tracked = execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' }).split('\n');

  ck('secrets/tradingview-cookies.json is NOT tracked',
    !tracked.includes('secrets/tradingview-cookies.json'));
  ck('nothing under secrets/ is tracked',
    tracked.filter((f) => f.startsWith('secrets/')).length === 0,
    tracked.filter((f) => f.startsWith('secrets/')));
  ck('nothing under tmp/ is tracked — those are pages from the broker terminal',
    tracked.filter((f) => f.startsWith('tmp/')).length === 0,
    tracked.filter((f) => f.startsWith('tmp/')));
  ck('no .env is tracked (only the example)',
    tracked.filter((f) => /(^|\/)\.env($|\.)/.test(f) && !/example/.test(f)).length === 0,
    tracked.filter((f) => /(^|\/)\.env($|\.)/.test(f)));

  // The generic net: anything that looks like a credential file, whatever it is
  // called. This is what fails when someone adds the NEXT one.
  const suspicious = tracked.filter((f) => /(cookies?|credential|secret|token|\.pem$|\.key$|serviceaccount)/i.test(f))
    .filter((f) => !/\.example$|save-tradingview-cookies\.js$|ingestSecurity\.js$|test\//.test(f));
  ck('no credential-shaped file is tracked', suspicious.length === 0, suspicious);

  // And the ignore rules are actually in force, not merely written down.
  const ignored = (f) => {
    try { execFileSync('git', ['check-ignore', '-q', f], { cwd: REPO }); return true; } catch { return false; }
  };
  ck('secrets/ is ignored in force', ignored('secrets/tradingview-cookies.json'));
  ck('tmp/ is ignored in force', ignored('tmp/anything.txt'));
}

console.log(`\ningest security: ${p}/${n}`);
process.exit(p === n ? 0 : 1);

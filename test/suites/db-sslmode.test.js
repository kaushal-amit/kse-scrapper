'use strict';
/**
 * S-03 · DB_SSL_MODE decides TLS, and production must say which.
 *
 * The defect this pins (review F-01): pool.js carried a hardcoded
 * `ssl: { rejectUnauthorized: false }` under a commented-out line that read the
 * config. It disabled certificate verification on every connection AND forced
 * TLS on when DB_SSL was false, so the documented default configuration could
 * not connect to the documented default database — reproduced against a local
 * Postgres as "The server does not support SSL connections".
 *
 * The property that matters most here is the `false` in `disable`: node-postgres
 * needs a literal false, not an object with its fields switched off, or it
 * demands a handshake a local server will refuse. An object that looks
 * permissive is not the same as no TLS, and that distinction is the bug.
 */
const { resolveMode, sslOptions, describe: describeMode, SslConfigRefused, MODES } =
  require('../../src/db/sslMode');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };
const grab = (fn) => { try { return { v: fn(), err: null }; } catch (e) { return { v: null, err: e }; } };

// ── the modes ───────────────────────────────────────────────────────────────
ck('there are exactly three modes', MODES.length === 3 && MODES.join(',') === 'disable,require,verify', MODES);

for (const m of MODES) {
  ck(`${m} resolves from DB_SSL_MODE`, resolveMode({ env: { DB_SSL_MODE: m } }) === m);
}
ck('the value is case-insensitive and trimmed',
  resolveMode({ env: { DB_SSL_MODE: '  VERIFY ' } }) === 'verify');

{
  const { err } = grab(() => resolveMode({ env: { DB_SSL_MODE: 'yes-please' } }));
  ck('an unknown mode is refused', err instanceof SslConfigRefused, err && err.message);
  ck('and the refusal lists the three and says what each promises',
    err && /disable \| require \| verify/.test(err.message) && /NOT authenticated/.test(err.message),
    err && err.message);
}

// ── the pool options — the part node-postgres actually reads ────────────────
{
  ck('disable is literal FALSE, not an object with everything off',
    sslOptions('disable') === false, sslOptions('disable'));
  // This is the regression that made the shipped default unable to connect: an
  // object here — ANY object — makes pg demand a handshake.
  ck('and it is therefore not an object', typeof sslOptions('disable') !== 'object' || sslOptions('disable') === null);

  const req = sslOptions('require');
  ck('require is encrypted but unverified', req && req.rejectUnauthorized === false, req);

  const ver = sslOptions('verify', { env: {} });
  ck('verify verifies', ver && ver.rejectUnauthorized === true, ver);
  ck('and carries no CA unless one was given', ver && ver.ca === undefined, ver);
}

// ── production must state its intent ────────────────────────────────────────
{
  const { err } = grab(() => resolveMode({ env: { NODE_ENV: 'production' } }));
  ck('production with NO setting REFUSES rather than guessing', err instanceof SslConfigRefused, err && err.message);
  ck('and it names verify for a network database and disable for a socket',
    err && /DB_SSL_MODE=verify/.test(err.message) && /DB_SSL_MODE=disable/.test(err.message), err && err.message);
  ck('and it warns that require does not authenticate',
    err && /require encrypts without authenticating/i.test(err.message), err && err.message);

  ck('production WITH a setting is fine',
    resolveMode({ env: { NODE_ENV: 'production', DB_SSL_MODE: 'verify' } }) === 'verify');

  /*
   * P2 · THE DEFAULT NOW NEEDS A POSITIVELY IDENTIFIED DEVELOPMENT ENVIRONMENT.
   *
   * This asserted `resolveMode({ env: {} }) === 'disable'` — "outside
   * production the default is disable". But the check was
   * NODE_ENV === 'production', so NODE_ENV=prod, NODE_ENV=Production and
   * NODE_ENV unset were all "outside production" and all got no TLS at all: on
   * a hand-rolled systemd or pm2 deploy, credentials and the trader's order
   * rows over the wire in clear text, under one INFO line saying
   * "database TLS: DISABLED".
   *
   * The same defect class as H-E, and the assertion below was the thing that
   * said it was fine.
   */
  ck('a KNOWN development environment defaults to disable — a local socket',
    resolveMode({ env: { NODE_ENV: 'development' } }) === 'disable');
  ck('and an UNKNOWN one refuses instead of defaulting',
    !!grab(() => resolveMode({ env: {} })).err);
  for (const spelling of ['prod', 'Production', 'PRODUCTION', 'staging']) {
    ck(`NODE_ENV='${spelling}' refuses too`,
      !!grab(() => resolveMode({ env: { NODE_ENV: spelling } })).err);
  }
}

// ── the deprecated boolean still works, and says so ─────────────────────────
{
  const warns = [];
  ck('DB_SSL=true maps to require',
    resolveMode({ env: { DB_SSL: 'true' }, warn: (m) => warns.push(m) }) === 'require');
  ck('and it warns, naming the replacement', warns.some((w) => /DB_SSL_MODE=require/.test(w)), warns);
  ck('and it says require does not authenticate the server',
    warns.some((w) => /does NOT authenticate/i.test(w)), warns);

  ck('DB_SSL=false maps to disable', resolveMode({ env: { DB_SSL: 'false' } }) === 'disable');
  ck('DB_SSL=1 maps to require', resolveMode({ env: { DB_SSL: '1' } }) === 'require');

  const both = [];
  ck('DB_SSL_MODE wins when both are set — the specific beats the vague',
    resolveMode({ env: { DB_SSL: 'true', DB_SSL_MODE: 'disable' }, warn: (m) => both.push(m) }) === 'disable');
  ck('and that conflict is warned about', both.some((w) => /both DB_SSL and DB_SSL_MODE/.test(w)), both);

  // DB_SSL=true in production is an explicit setting, so it must NOT trip the
  // production refusal — the operator did say something.
  ck('DB_SSL=true satisfies production',
    resolveMode({ env: { NODE_ENV: 'production', DB_SSL: 'true' } }) === 'require');
}

// ── an unreadable CA refuses rather than downgrading ────────────────────────
{
  const { err } = grab(() => sslOptions('verify', { env: { DB_SSL_CA_FILE: '/nonexistent/ca.pem' } }));
  ck('a missing CA file refuses', err instanceof SslConfigRefused, err && err.message);
  ck('and says it will not fall back to unverified',
    err && /Refusing rather than falling back/i.test(err.message), err && err.message);
}

// ── the boot line says which mode is in force ───────────────────────────────
{
  ck('disable is announced', /DISABLED/.test(describeMode('disable')));
  ck('require announces that it is UNVERIFIED', /UNVERIFIED/.test(describeMode('require')));
  ck('verify announces that it is verified', /VERIFIED/.test(describeMode('verify')));
}

// ── pool.js does not carry its own TLS decision any more ────────────────────
{
  const src = require('fs').readFileSync(require('path').join(__dirname, '../../src/db/pool.js'), 'utf8');
  const live = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  ck('no hardcoded rejectUnauthorized survives in pool.js',
    !/rejectUnauthorized/.test(live), live.split('\n').filter((l) => /rejectUnauthorized/.test(l)));
  ck('and the pool reads sslOptions', /sslMode\.sslOptions\(/.test(live));
}

console.log(`\ndb ssl mode: ${p}/${n}`);
process.exit(p === n ? 0 : 1);

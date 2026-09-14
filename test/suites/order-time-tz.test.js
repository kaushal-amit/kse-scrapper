'use strict';
/**
 * F-06 · the broker's clock is Kuwait's, and it is pinned.
 *
 * `new Date(\`${iso}T${t}\`)` — an ISO string with no offset — is parsed as HOST
 * LOCAL TIME. `order_time` is timestamptz, so on a UTC container a cell reading
 * "10-08-2026 13:03:30" was stored as 13:03:30Z, which is 16:03:30 Kuwait.
 * Every order timestamp three hours late, silently, and reconciliation against
 * minute quotes — which ARE Kuwait-correct, via clock.tradingDay — matching the
 * wrong minute.
 *
 * Nothing pins TZ: there is no `TZ=` in .env.example or any Dockerfile, and
 * clock.js is built on the explicit premise that the server may run anywhere.
 * So the offset is written at the parse rather than inherited from the host.
 *
 * This is the same class of bug as CR-12, in a different file — which is why
 * the test runs each case in a process with a DIFFERENT TZ. A timezone bug that
 * is only tested on the machine that has the right timezone is not tested.
 */
const path = require('path');
const { execFileSync } = require('child_process');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };

const REPO = path.join(__dirname, '..', '..');

/** Parse a broker stamp in a child process with the given TZ. */
function parseUnder(tz, day, time) {
  const script = `
    const a = require(${JSON.stringify(path.join(REPO, 'src/scrapers/awsat.js'))});
    const d = a.toKuwaitInstant(${JSON.stringify(day)}, ${JSON.stringify(time)});
    process.stdout.write(d === null ? 'null' : d.toISOString());`;
  const out = execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, TZ: tz, DATABASE_URL: 'postgres://x@127.0.0.1:5432/x_test' },
    cwd: REPO,
  });
  return out.trim().split('\n').pop();
}

// ── the same wall clock, wherever the server is ─────────────────────────────
{
  // 13:03:30 Kuwait is 10:03:30 UTC. Always, because Kuwait has no DST.
  const expect = '2026-08-10T10:03:30.000Z';
  for (const tz of ['UTC', 'America/New_York', 'Asia/Kolkata', 'Europe/London', 'Asia/Kuwait']) {
    ck(`TZ=${tz} gives the same instant`, parseUnder(tz, '2026-08-10', '13:03:30') === expect,
      parseUnder(tz, '2026-08-10', '13:03:30'));
  }
}

// ── the bug, stated as a number ─────────────────────────────────────────────
{
  // What the old code produced on a UTC host: the wall clock read as UTC.
  const wrong = new Date('2026-08-10T13:03:30Z').toISOString();
  const right = parseUnder('UTC', '2026-08-10', '13:03:30');
  ck('the stored instant is NOT the wall clock read as UTC', right !== wrong, [right, wrong]);
  ck('it is exactly three hours earlier',
    new Date(wrong).getTime() - new Date(right).getTime() === 3 * 3600_000,
    (new Date(wrong).getTime() - new Date(right).getTime()) / 3600_000);
}

// ── shapes the grid actually produces ───────────────────────────────────────
{
  ck('HH:MM (no seconds) works', parseUnder('UTC', '2026-08-10', '09:05') === '2026-08-10T06:05:00.000Z',
    parseUnder('UTC', '2026-08-10', '09:05'));
  ck('a single-digit hour works', parseUnder('UTC', '2026-08-10', '9:05:00') === '2026-08-10T06:05:00.000Z',
    parseUnder('UTC', '2026-08-10', '9:05:00'));
  ck('a day boundary is handled — 01:00 Kuwait is the PREVIOUS UTC day',
    parseUnder('UTC', '2026-08-10', '01:00:00') === '2026-08-09T22:00:00.000Z',
    parseUnder('UTC', '2026-08-10', '01:00:00'));
}

// ── a stamp that cannot be read is null, never a guess ──────────────────────
{
  ck('no day is null', parseUnder('UTC', '', '13:03:30') === 'null');
  ck('a malformed time is null', parseUnder('UTC', '2026-08-10', 'noon') === 'null');
  ck('an empty time is null', parseUnder('UTC', '2026-08-10', '') === 'null');
}

// ── and the offset is a named constant, with its reason ─────────────────────
{
  const src = require('fs').readFileSync(path.join(REPO, 'src/scrapers/awsat.js'), 'utf8');
  const live = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  ck('the offset is +03:00', /KUWAIT_OFFSET = '\+03:00'/.test(live));
  ck('no bare `new Date(`${iso}T${t}`)` survives',
    !/new Date\(`\$\{iso\}T\$\{t\}`\)/.test(live));
  ck('and the constant says WHY it can be a constant — no DST',
    /does not observe DST/.test(src));
}

console.log(`\norder time tz: ${p}/${n}`);
process.exit(p === n ? 0 : 1);

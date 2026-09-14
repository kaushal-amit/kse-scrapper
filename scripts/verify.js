'use strict';
/**
 * scripts/verify.js — the one command that says whether this repo is shippable.
 *
 *   npm run verify
 *
 * `npm test` runs the suites. `npm run check` parses two files. Neither answers
 * "is this ready to deploy", and the answer was assembled by hand each time —
 * which is how a green suite came to coexist with two suites that had been red
 * for three weeks, and with a dependency advisory nobody had run.
 *
 * FOUR GATES, ALL OF THEM BLOCKING:
 *
 *   1. every .js file parses            — a syntax error in a file the suites
 *                                         never require is invisible until the
 *                                         job that needs it runs at 13:35
 *   2. npm audit is clean               — 0 vulnerabilities
 *   3. the migration chain is idempotent — applied twice, second run 0
 *   4. the full suite passes            — 0 failed, and skips are NAMED
 *
 * Gates 3 and 4 need a database whose name ends in _test, and refuse without
 * one (test/dbguard.js). Gate 3 used to SKIP when DATABASE_URL was unset and
 * report that skip as a PASS; it now fails, because a command that answers "is
 * this shippable" must not answer yes about work it did not do. Gates 1 and 2
 * still run and report on their own for a developer with no database.
 *
 * Gate 3 applies the chain to a database it CREATES for the run and drops
 * afterwards. Run against an already-migrated database both runs apply 0, and
 * the gate passed having exercised no migration at all.
 */

/*
 * V-01 · THE SUITES LOAD .env AND THIS DID NOT.
 *
 * test/all.js calls dotenv itself, precisely so its checks are made against the
 * environment the suites will see. verify.js did not — so on a machine whose
 * DATABASE_URL lives in .env rather than the shell, gate 3 found no
 * DATABASE_URL, skipped, and REPORTED PASS. The command whose entire purpose is
 * to answer "is this shippable" said yes without having run the migration
 * chain, and said it in green.
 */
try { require('dotenv').config(); } catch { /* dotenv optional */ }

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const results = [];
const t0 = Date.now();

function gate(name, fn) {
  process.stdout.write(`\n── ${name} ${'─'.repeat(Math.max(0, 60 - name.length))}\n`);
  const started = Date.now();
  try {
    const note = fn();
    results.push({ name, ok: true, note, ms: Date.now() - started });
    process.stdout.write(`   PASS  ${note || ''}\n`);
  } catch (err) {
    results.push({ name, ok: false, note: err.message, ms: Date.now() - started });
    process.stdout.write(`   FAIL  ${err.message}\n`);
  }
}

function walk(dir, acc = []) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const q = path.join(dir, f.name);
    if (f.isDirectory()) { if (!/node_modules|\.git/.test(q)) walk(q, acc); }
    else if (f.name.endsWith('.js')) acc.push(q);
  }
  return acc;
}

// ── 1 · every file parses ───────────────────────────────────────────────────
gate('syntax — every .js file', () => {
  const files = ['src', 'scripts', 'test', 'userscript']
    .filter((d) => fs.existsSync(path.join(REPO, d)))
    .flatMap((d) => walk(path.join(REPO, d)));
  const bad = [];
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) bad.push(`${path.relative(REPO, f)}: ${(r.stderr || '').split('\n')[2] || 'parse error'}`);
  }
  if (bad.length) throw new Error(`${bad.length} file(s) do not parse:\n     ${bad.join('\n     ')}`);
  return `${files.length} files`;
});

// ── 2 · dependencies ────────────────────────────────────────────────────────
gate('npm audit', () => {
  const r = spawnSync('npm', ['audit', '--json'], { cwd: REPO, encoding: 'utf8' });
  let report;
  try { report = JSON.parse(r.stdout); } catch { throw new Error('could not read npm audit output'); }
  const total = (report.metadata && report.metadata.vulnerabilities
    && report.metadata.vulnerabilities.total) || 0;
  if (total > 0) {
    const by = report.metadata.vulnerabilities;
    throw new Error(`${total} vulnerabilit(ies): `
      + Object.entries(by).filter(([k, v]) => k !== 'total' && v).map(([k, v]) => `${v} ${k}`).join(', '));
  }
  return '0 vulnerabilities';
});

// ── 3 · the migration chain is idempotent ───────────────────────────────────
gate('migrations — applied twice, second run 0', () => {
  /*
   * V-02 · A SKIP IS NOT A PASS.
   *
   * This returned the string 'SKIPPED — …' and gate() printed it under PASS,
   * in the same colour and with the same weight as a chain that had actually
   * been applied twice. Gate 4 has always reported its skips as skips, by name.
   * This one wore a pass.
   *
   * Now it FAILS. A developer with no database still gets gates 1 and 2 — they
   * run first and report on their own — but the verdict line stops saying the
   * repo is shippable, because nothing here checked whether it is.
   */
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set, so the migration chain was NOT '
      + 'checked. Point it at a database whose name ends in _test and run again. '
      + 'A skipped gate is not a passed one.');
  }

  /*
   * V-03 · AND AN ALREADY-MIGRATED DATABASE PROVES NOTHING.
   *
   * The gate asserts "applied twice, second run 0". Run against a database that
   * is already up to date, both runs apply 0 and the gate passes having
   * exercised no migration at all — which is exactly the state a developer's
   * _test database is in every time but the first. A chain that fails on a
   * fresh database would sail through this.
   *
   * So the chain is applied to a database created FOR THIS RUN and dropped
   * afterwards. That is the claim being made, and now it is the claim being
   * tested.
   */
  const base = process.env.DATABASE_URL.replace(/\/[^/]*$/, '');
  const scratch = `kse_verify_${process.pid}_test`;
  const admin = `${base}/postgres`;

  const psql = (url, sql) => {
    const r = spawnSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`${sql.split(' ').slice(0, 2).join(' ')} failed: `
      + `${(r.stderr || '').trim().split('\n').pop()}`);
  };

  psql(admin, `DROP DATABASE IF EXISTS ${scratch}`);
  psql(admin, `CREATE DATABASE ${scratch}`);

  const scratchEnv = { ...process.env, DATABASE_URL: `${base}/${scratch}` };

  const run = () => {
    const r = spawnSync(process.execPath, [path.join(REPO, 'src/db/migrate.js')],
      { cwd: REPO, encoding: 'utf8', env: scratchEnv });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    if (r.status !== 0) throw new Error(`migrate exited ${r.status}\n     ${out.split('\n').slice(-3).join('\n     ')}`);
    const m = out.match(/"applied":\[(.*?)\]/);
    const applied = m && m[1].trim() ? m[1].split(',').length : 0;
    return applied;
  };

  try {
    const first = run();
    const second = run();

    // A fresh database MUST apply the whole chain. Zero here does not mean
    // "idempotent", it means the migrations never ran — the exact confusion
    // this gate was reporting as a pass.
    const onDisk = fs.readdirSync(path.join(REPO, 'src/db/migrations'))
      .filter((f) => f.endsWith('.sql')).length;
    if (first !== onDisk) {
      throw new Error(`a FRESH database applied ${first} of ${onDisk} migration(s) — `
        + 'the chain did not run in full');
    }
    if (second !== 0) throw new Error(`the chain is NOT idempotent: the second run applied ${second}`);
    return `${first} applied on a fresh database, then 0`;
  } finally {
    // Dropped whether or not the gate passed: a failed verify must not leave a
    // database behind for the next one to trip over.
    try { psql(admin, `DROP DATABASE IF EXISTS ${scratch}`); } catch { /* best effort */ }
  }
});

// ── 4 · the suite ───────────────────────────────────────────────────────────
gate('npm test', () => {
  const r = spawnSync(process.execPath, [path.join(REPO, 'test/all.js')],
    { cwd: REPO, encoding: 'utf8', env: process.env, timeout: 15 * 60_000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  /*
   * The LAST tally, not the first. test/all.js runs the original run.js suite
   * first and prints its own "39 passed, 0 failed" line before the overall one —
   * so matching the first occurrence reported a third of the real count as the
   * whole result, which is exactly the kind of quietly-wrong number this gate
   * exists to catch.
   */
  const all = [...out.matchAll(/(\d+) passed, (\d+) failed(?:, (\d+) skipped)?/g)];
  if (!all.length) throw new Error(`could not read the tally:\n     ${out.split('\n').slice(-5).join('\n     ')}`);
  const [, passed, failed, skipped] = all[all.length - 1];
  if (Number(failed) > 0) {
    const names = out.split('\n').filter((l) => /\[FAIL\]/.test(l)).map((l) => l.trim());
    throw new Error(`${failed} suite(s) failed:\n     ${names.join('\n     ')}`);
  }
  // Skips are NAMED, never counted silently — a skip reported as a pass is how
  // a browser suite stops running and nobody notices.
  const skips = out.split('\n').filter((l) => /\[skip\]/.test(l)).map((l) => l.trim().replace(/\s+/g, ' '));
  return `${passed} passed, 0 failed`
    + (Number(skipped || 0) ? `, ${skipped} skipped:\n         ${skips.join('\n         ')}` : '');
});

// ── verdict ─────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n${'═'.repeat(64)}\n`);
for (const r of results) {
  process.stdout.write(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(42)} ${Math.round(r.ms / 100) / 10}s\n`);
}
process.stdout.write(`${'═'.repeat(64)}\n`);
process.stdout.write(failed.length
  ? `  VERIFY FAILED — ${failed.length} of ${results.length} gate(s)\n\n`
  : `  VERIFY PASSED — ${results.length} gates in ${Math.round((Date.now() - t0) / 1000)}s\n\n`);
process.exit(failed.length ? 1 : 0);

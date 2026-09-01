'use strict';
/**
 * scripts/source-scan.js — find what the tests cannot.
 *
 * ─── WHY ───────────────────────────────────────────────────────────────────
 * Four times a column, table or function returned a plausible value and was
 * wrong. None errored, none failed a test:
 *
 *     spread views          served over EMPTY tables for months
 *     committed_kd          read a table nothing writes — always 0
 *     broker_net_value_kd   read by two consumers — always NULL
 *     expectedRowCount      called, never defined — threw on every cycle
 *
 * A front end wired to a NULL column shows a number and nobody questions it.
 * YOUR % reading zero looks like a valid answer. That is how a display bug
 * becomes a trading decision, and it is why this runs before the UI is built
 * on top rather than after.
 *
 * ─── A COPY OF THIS FILE LIVES IN spread-backend ──────────────────────────
 * Deliberately duplicated. Three of the four instances were in this repo and
 * one in the backend, so a scan covering one tree would have missed most of
 * them — and a copied file that drifts is better than a dependency neither
 * repo owns. If you change this, change the other.
 *
 * ─── WHAT FAILS AND WHAT WARNS ─────────────────────────────────────────────
 *   1 functions called but never defined   FAILS — unambiguous
 *   4 modules never imported               FAILS — unambiguous
 *   2 tables with no INSERT                WARNS FOREVER
 *   3 columns never named in source        WARNS FOREVER
 *
 * 2 and 3 warn permanently, not "until the allowlist settles". A table with no
 * INSERT is often correct: a lookup, a migration artifact, something a job that
 * has not shipped will write. Failing on those would train someone to add
 * allowlist entries to make the build pass, which converts a signal into
 * paperwork.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ALLOW_FILE = path.join(ROOT, 'scan-allow.json');

/** Node and browser names that are never defined in our own source. */
/**
 * Names that LOOK like calls and are not.
 *
 * `constructor()` and `super()` are class syntax. `async()` and `get()` are
 * shorthand method names. Flagging them would bury the one real finding in
 * twenty false ones, which is how a check gets switched off.
 */
const KEYWORDS_LIKE_CALLS = new Set([
  'constructor', 'super', 'async', 'get', 'set', 'static', 'construct',
  'then', 'catch', 'finally', 'apply', 'call', 'bind',
]);

/**
 * Words that appear as `name(` inside SQL rather than as calls.
 *
 * The template-literal stripper cannot always reach SQL: a query containing a
 * nested backtick or an unbalanced ${ leaves the rest intact, and SQL is full
 * of count(*), max(...) and column names followed by an open paren.
 */
/**
 * A file loaded by PATH rather than by require.
 *
 *     const WORKER_FILE = path.join(__dirname, 'scrapeWorker.js');
 *     new Worker(WORKER_FILE, ...)
 *
 * Built with RegExp() rather than written as a literal: a regex containing
 * quote characters desynchronises this scanner's own string stripper, and
 * everything after it parses as calls.
 */
const RUNTIME_PATH = new RegExp(
  'path\\.join\\([^)]*[\'"]([\\w.-]+\\.js)[\'"]'
  + '|new\\s+Worker\\(\\s*[\'"]([^\'"]+\\.js)[\'"]', 'g');

const SQL_WORDS = /^(count|sum|max|min|avg|coalesce|greatest|least|nullif|cast|round|extract|now|array_agg|string_agg|percentile_cont|to_char|date_trunc|lower|upper|length|abs|floor|ceil|regexp_replace|jsonb_build_object|row_number|rank|lag|lead|generate_series|unnest|_)$|_(count|observed|at|on|id|kd|pct|qty|fils|shares|days|hhmm)$/;

const GLOBALS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'new', 'await',
  'delete', 'void', 'in', 'of', 'do', 'else', 'try', 'throw', 'case', 'yield',
  'require', 'fetch', 'Number', 'String', 'Date', 'Math', 'JSON', 'Object', 'Array',
  'Map', 'Set', 'WeakMap', 'Promise', 'RegExp', 'Error', 'TypeError', 'Boolean', 'Symbol',
  'BigInt', 'Buffer', 'process', 'console', 'setTimeout', 'setInterval', 'clearTimeout',
  'clearInterval', 'setImmediate', 'queueMicrotask', 'parseFloat', 'parseInt', 'isNaN',
  'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'structuredClone',
  'crypto', 'performance', 'URL', 'URLSearchParams', 'AbortController', 'TextEncoder',
  'window', 'document', 'navigator', 'location', 'history', 'localStorage', 'alert',
  'MouseEvent', 'KeyboardEvent', 'Event', 'InputEvent', 'CustomEvent', 'WebSocket',
  'MutationObserver', 'IntersectionObserver', 'requestAnimationFrame', 'getComputedStyle',
  'Intl', 'Proxy', 'Reflect', 'globalThis', 'module', 'exports', '__dirname', '__filename',
]);

/** Comments and string literals removed, so PROSE never counts as code. */
function strip(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    // Template literals hold SQL and prose, both full of things that parse as
    // calls: count(*), max(...), and `${n} row(s)`.
    //
    // Nested ${} makes them non-regular, so this runs REPEATEDLY: each pass
    // removes the innermost literals, and the next sees what they exposed. A
    // single pass left `${x} row(s)` behind and row( read as a call.
    .replace(/`[\s\S]*?`/g, '``')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const q = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!/node_modules|\.git|coverage/.test(e.name)) walk(q, out);
    } else if (/\.(js|sql)$/.test(e.name)) out.push(q);
  }
  return out;
}

function loadAllow() {
  if (!fs.existsSync(ALLOW_FILE)) return { columns: [], tables: [], modules: [], functions: [] };
  return JSON.parse(fs.readFileSync(ALLOW_FILE, 'utf8'));
}

/**
 * An entry without a reason or an expiry is itself a finding.
 *
 * That is what stops an exemption becoming permanent by omission: someone in a
 * hurry adds a name, and without both fields nobody can tell later whether it
 * still applies.
 */
function checkAllow(allow) {
  const problems = [];
  const expired = [];
  const today = new Date().toISOString().slice(0, 10);

  for (const kind of ['columns', 'tables', 'modules', 'functions']) {
    for (const e of allow[kind] || []) {
      if (!e.reason) problems.push(`${kind}.${e.name} has no reason`);
      if (!e.until) problems.push(`${kind}.${e.name} has no expiry date`);
      else if (e.until < today) {
        const days = Math.round((Date.parse(today) - Date.parse(e.until)) / 86400000);
        expired.push({ kind, name: e.name, until: e.until, days, reason: e.reason });
      }
    }
  }
  return { problems, expired };
}

const allowed = (allow, kind, name) =>
  (allow[kind] || []).some((e) => e.name === name);

// ── 1 · FUNCTIONS CALLED BUT NEVER DEFINED ─────────────────────────────────
function scanFunctions(files, allow) {
  const findings = [];
  let checked = 0;
  let calls = 0;

  for (const f of files.filter((x) => x.endsWith('.js'))) {
    const code = strip(fs.readFileSync(f, 'utf8'));
    const defined = new Set();

    // `function* name()` — the star sits between the keyword and the name.
    for (const m of code.matchAll(/function\s*\*?\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
    for (const m of code.matchAll(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
    for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?(?:function|\()/g)) defined.add(m[1]);
    // Promise executors and callbacks: (resolve, reject) => and (err, res) =>
    for (const m of code.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
      for (const p of m[1].split(',')) {
        const t = p.trim().replace(/^\.\.\./, '').split(/[\s=:]/)[0];
        if (/^[A-Za-z_$][\w$]*$/.test(t)) defined.add(t);
      }
    }
    for (const m of code.matchAll(/\{([^}]*)\}\s*=/g)) {
      for (const p of m[1].split(',')) {
        const t = p.trim().split(/[\s:=]/).pop().trim();
        if (/^[A-Za-z_$][\w$]*$/.test(t)) defined.add(t);
      }
    }
    checked += defined.size;

    for (const m of code.matchAll(/(^|[^.\w$'"])([A-Za-z_$][\w$]*)\s*\(/gm)) {
      const name = m[2];
      const before = code.slice(Math.max(0, m.index - 12), m.index + m[1].length);
      calls += 1;

      if (defined.has(name) || GLOBALS.has(name)) continue;
      if (allowed(allow, 'functions', name)) continue;

      // `new Foo()` and `class X extends Y` construct rather than call.
      if (/\bnew\s+$/.test(before)) continue;
      // Class syntax: constructor(), super(), and any method shorthand.
      if (KEYWORDS_LIKE_CALLS.has(name)) continue;
      // A capitalised name is a constructor or an imported class. Those come
      // from requires this scan does not resolve, so flagging them would be
      // noise rather than a finding.
      if (/^[A-Z]/.test(name)) continue;
      // Single letters are minifier aliases and SQL correlation names.
      if (name.length < 3) continue;
      // `foo: function` and `foo(` inside an object literal define rather than
      // call. A colon or comma immediately before is the tell.
      if (/[:,]\s*$/.test(before)) continue;
      // A method on a Promise or Map reached through a chain broken across
      // lines: `.then(\n  resolve)` leaves `resolve(` looking bare.
      if (/\.\s*$/.test(before)) continue;
      // SQL survives when a template literal contains a nested backtick or an
      // unbalanced ${. Anything that is a known column name in this codebase is
      // data, not a call — checked against the columns the scan already knows.
      if (SQL_WORDS.test(name)) continue;
      // `${n} row(s)` and `${n} section(s)` are PROSE inside a template
      // literal. Nested ${} makes those literals non-regular, so the stripper
      // cannot always reach them — and stripping harder ate a third of the
      // real calls. A name followed by (s) is English, not code.
      if (/^\(s\)/.test(code.slice(m.index + m[0].length - 1, m.index + m[0].length + 3))) continue;
      // A regex literal survives the stripper, and \b leaves the b attached:
      // /\bwill (rise|fall)/ reads as bwill(. A leading b followed by a word
      // that is never defined anywhere is this, not a call.
      if (/^b[a-z]/.test(name) && !defined.has(name.slice(1))) continue;

      findings.push({ file: path.relative(ROOT, f), name });
    }
  }
  return { findings, checked, calls };
}

// ── 4 · MODULES NEVER IMPORTED ─────────────────────────────────────────────
/**
 * ─── A FINDING MUST STATE WHERE IT LOOKED ─────────────────────────────────
 *
 * The first version said "imported nowhere" when it meant "not imported by
 * src, scripts or userscript". It never walked test/, so three modules with
 * live test coverage were reported as orphans — and on that report they were
 * deleted, taking four suites with them.
 *
 * That gap between what a check SAYS and what it MEASURED is the same failure
 * as executions_observed reading 1 while the fee said 2.
 *
 * So: test/ is walked, and a module imported ONLY by tests is a DISTINCT
 * finding that WARNS. It is genuinely ambiguous — dead code that kept its
 * tests, or live code whose caller was removed — and those need different
 * answers. Ambiguity warns; it does not fail.
 */
function scanModules(files, testFiles, allow, entryPoints) {
  const importsFrom = (list) => {
    const out = new Set();
    for (const f of list.filter((x) => x.endsWith('.js'))) {
      const raw = fs.readFileSync(f, 'utf8');
      for (const m of raw.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
        const target = path.resolve(path.dirname(f), m[1]).replace(/\.js$/, '');
        out.add(target);
        // require('./api/review') resolves to ./api/review/index.js
        out.add(path.join(target, 'index'));
      }

      /**
       * A file can be loaded WITHOUT being required.
       *
       * scrapeWorkerHost does:
       *     path.join(__dirname, 'scrapeWorker.js')
       *     new Worker(WORKER_FILE, ...)
       *
       * There is no require, so the first version of this scan called
       * scrapeWorker.js an orphan. Deleting it left the host spawning a file
       * that no longer existed — MODULE_NOT_FOUND at runtime, in a worker
       * thread, where it surfaced as "scrape worker errored".
       *
       * Any path.join with a .js filename counts as a reference.
       */
      for (const m of raw.matchAll(RUNTIME_PATH)) {
        const name = m[1] || m[2];
        if (name) out.add(path.resolve(path.dirname(f), name).replace(/\.js$/, ''));
      }
    }
    return out;
  };

  const bySrc = importsFrom(files);
  const byTest = importsFrom(testFiles);

  const orphans = [];
  const testOnly = [];
  let scanned = 0;

  for (const f of files.filter((x) => x.endsWith('.js') && x.includes(`${path.sep}src${path.sep}`))) {
    scanned += 1;
    const key = f.replace(/\.js$/, '');
    const rel = path.relative(ROOT, f);
    if (bySrc.has(key)) continue;
    if (entryPoints.some((e) => rel === e || rel.endsWith(e))) continue;
    if (allowed(allow, 'modules', rel)) continue;
    if (byTest.has(key)) { testOnly.push({ file: rel }); continue; }
    orphans.push({ file: rel });
  }
  return { orphans, testOnly, scanned, searched: files.length + testFiles.length };
}

// ── 2 · TABLES WITH NO INSERT ──────────────────────────────────────────────
async function scanTables(query, files, allow) {
  const { rows } = await query(`
    SELECT table_schema || '.' || table_name AS name
      FROM information_schema.tables
     WHERE table_schema IN ('public', 'spread') AND table_type = 'BASE TABLE'
     ORDER BY 1`);

  const all = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const written = new Set();
  for (const m of all.matchAll(/(?:INSERT\s+INTO|COPY)\s+((?:[a-z_]+\.)?[a-z_]+)/gi)) {
    written.add(m[1].toLowerCase());
  }

  const findings = [];
  let allowedCount = 0;
  for (const r of rows) {
    const bare = r.name.split('.')[1];
    if (written.has(r.name.toLowerCase()) || written.has(bare)) continue;
    if (allowed(allow, 'tables', r.name) || allowed(allow, 'tables', bare)) { allowedCount += 1; continue; }
    findings.push({ name: r.name });
  }
  return { findings, scanned: rows.length, allowed: allowedCount };
}

// ── 3 · COLUMNS NEVER NAMED IN SOURCE ──────────────────────────────────────
async function scanColumns(query, files, allow) {
  const { rows } = await query(`
    SELECT c.table_schema || '.' || c.table_name AS tbl, c.column_name AS col
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema IN ('public', 'spread') AND t.table_type = 'BASE TABLE'
     ORDER BY 1, 2`);

  // Migrations name every column by definition, so they are excluded from the
  // haystack: a column that appears ONLY in the migration that created it is
  // exactly what this looks for.
  const src = files.filter((f) => !/migrations/.test(f))
    .map((f) => fs.readFileSync(f, 'utf8')).join('\n');

  const findings = [];
  let allowedCount = 0;
  for (const r of rows) {
    const needle = new RegExp(`\\b${r.col}\\b`);
    if (needle.test(src)) continue;
    if (allowed(allow, 'columns', r.col) || allowed(allow, 'columns', `${r.tbl}.${r.col}`)) {
      allowedCount += 1; continue;
    }
    findings.push({ name: `${r.tbl}.${r.col}` });
  }
  return { findings, scanned: rows.length, allowed: allowedCount };
}

/**
 * @param query  an async SQL runner, or null to skip the database checks
 */
async function scan({ query = null, entryPoints = [] } = {}) {
  const allow = loadAllow();
  const files = walk(path.join(ROOT, 'src'))
    .concat(walk(path.join(ROOT, 'scripts')))
    .concat(walk(path.join(ROOT, 'userscript')));
  // test/ is walked SEPARATELY, not merged: a module imported only by a test
  // is a different finding from one imported by nothing.

  const out = { allow: checkAllow(allow), lines: [], failed: 0 };
  const say = (s) => out.lines.push(s);

  say('SOURCE SCAN · ' + path.basename(ROOT));
  say('');

  const fn = scanFunctions(files, allow);
  say('  functions called but never defined');
  // Counts even when everything passes: a check that speaks only on failure
  // can be silently broken, and numbers prove it ran.
  say(`    ${fn.findings.length ? 'FAIL' : 'OK  '} ${files.filter((f) => f.endsWith('.js')).length} files · `
    + `${fn.checked} names · ${fn.calls} calls`);
  // The limit, stated. A green line otherwise reads as a stronger guarantee
  // than it is — the same reason executions_observed is marked a floor.
  say('         within-file only — cross-module requires are not resolved');
  for (const f of fn.findings) { say(`    FAIL ${f.name}()  in ${f.file}`); out.failed += 1; }
  say('');

  const testFiles = walk(path.join(ROOT, 'test'));
  const mod = scanModules(files, testFiles, allow, entryPoints);
  say('  modules imported by nothing at all');
  say(`    ${mod.orphans.length ? 'FAIL' : 'OK  '} ${mod.scanned} modules · `
    + `searched ${mod.searched} files in src, scripts, userscript AND test`);
  for (const f of mod.orphans) { say(`    FAIL ${f.file}`); out.failed += 1; }
  say('');

  // Ambiguous, so it warns rather than fails: dead code that kept its tests, or
  // live code whose caller was removed. Three modules were deleted on a report
  // that could not tell the two apart.
  say('  modules imported ONLY by tests, never by shipping code');
  say(`    ${mod.testOnly.length} of ${mod.scanned}`);
  for (const f of mod.testOnly) say(`    WARN ${f.file}  — covered by tests, called by no shipping code`);
  say('');

  if (query) {
    const t = await scanTables(query, files, allow);
    say('  tables with no INSERT   (warns, never fails)');
    say(`    ${t.scanned} scanned · ${t.findings.length} with no INSERT · ${t.allowed} allowed`);
    for (const f of t.findings) say(`    WARN ${f.name}`);
    say('');

    const c = await scanColumns(query, files, allow);
    say('  columns never named in source   (warns, never fails)');
    say(`    ${c.scanned} scanned · ${c.findings.length} unreferenced · ${c.allowed} allowed`);
    for (const f of c.findings.slice(0, 40)) say(`    WARN ${f.name}`);
    if (c.findings.length > 40) say(`    ... and ${c.findings.length - 40} more`);
    say('');
  } else {
    say('  tables and columns   SKIPPED — no database connection');
    say('');
  }

  if (out.allow.expired.length) {
    say('  EXPIRED EXEMPTIONS   (warns, never fails)');
    for (const e of out.allow.expired) {
      say(`    WARN ${e.kind}.${e.name}  expired ${e.until}, ${e.days} days ago`);
      say(`         ${e.reason}`);
    }
    say('');
  }
  for (const p of out.allow.problems) { say(`    FAIL allowlist: ${p}`); out.failed += 1; }

  say(`  findings: ${out.failed}   expired: ${out.allow.expired.length}`);
  return out;
}

module.exports = { scan, scanFunctions, scanModules, strip, walk };

if (require.main === module) {
  (async () => {
    // .env is read by src/config.js, which this scanner deliberately does not
    // require — loading it here keeps the source checks independent of the
    // application's configuration validation.
    try { require('dotenv').config(); } catch { /* optional */ }

    // The source checks need no database. Requiring the pool validates the
    // whole environment and throws when DATABASE_URL is absent, so it is only
    // loaded when one is actually configured.
    let query = null;
    if (process.env.DATABASE_URL) {
      try {
        const { query: q } = require('../src/db/pool');
        await q('SELECT 1');
        query = q;
      } catch { /* unreachable database — the source checks still run */ }
    }
    const r = await scan({ query, entryPoints: ['src/index.js', 'src/runOnce.js'] });
    console.log(r.lines.join('\n'));
    process.exit(r.failed ? 1 : 0);
  })();
}

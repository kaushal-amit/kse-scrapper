// The scan itself must work, and must still catch what it was built for.
const path = require('path');
const fs = require('fs');
const { scanFunctions, strip, walk } = require('../../scripts/source-scan');
let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, JSON.stringify(x)); };

const NONE = { functions: [], modules: [], tables: [], columns: [] };
const tmp = '/tmp/scan-fixture';
fs.mkdirSync(tmp, { recursive: true });
const write = (name, src) => { const f = path.join(tmp, name); fs.writeFileSync(f, src); return f; };

// ── IT CATCHES THE THREE REAL CASES ────────────────────────────────────────
// ladderSweep, refreshSymbols, expectedRowCount: each called, never written,
// each threw at runtime and left a panel showing its INITIAL message.
const real = write('real.js', `
  function tick() { var x = expectedRowCount(body); return x; }
  setInterval(function () { ladderSweep(); }, 15000);
`);
const found = scanFunctions([real], NONE).findings.map((f) => f.name).sort();
ck('expectedRowCount is caught', found.includes('expectedRowCount'), found);
ck('ladderSweep is caught', found.includes('ladderSweep'), found);

// ── AND DOES NOT FIRE ON THINGS THAT ARE NOT CALLS ─────────────────────────
const noise = write('noise.js', `
  class A extends B { constructor() { super(); } }
  const p = new Promise(function (resolve, reject) { resolve(1); });
  const o = { handler: function () {}, run() { return 1; } };
  const q = \`SELECT count(*), max(x), sighting_count FROM t WHERE a = \${1}\`;
  // a comment that mentions phantom() and should not count
  /* nor should this: ghost() */
  const s = 'a string with vanished()';
  Promise.resolve().then(function () { return 1; });
`);
const quiet = scanFunctions([noise], NONE).findings.map((f) => f.name);
ck('class syntax is not a call', !quiet.includes('constructor') && !quiet.includes('super'), quiet);
ck('promise executor params are not calls', !quiet.includes('resolve'), quiet);
ck('SQL inside a template is not a call',
   !quiet.includes('count') && !quiet.includes('sighting_count'), quiet);
ck('a comment is not code', !quiet.includes('phantom') && !quiet.includes('ghost'), quiet);
ck('a string is not code', !quiet.includes('vanished'), quiet);

// ── the stripper ──
ck('comments are removed', !/phantom/.test(strip('// phantom()')));
ck('block comments too', !/ghost/.test(strip('/* ghost() */')));
ck('strings are emptied', !/vanished/.test(strip("var a = 'vanished()';")));
ck('template literals are emptied, INCLUDING across ${} and newlines',
   !/sighting_count/.test(strip('var q = `SELECT\n  sighting_count = ${x}\n`;')));

// ── the allowlist requires a reason AND an expiry ──
const allow = JSON.parse(fs.readFileSync(path.join(__dirname, '../../scan-allow.json'), 'utf8'));
for (const kind of ['columns', 'tables', 'modules', 'functions']) {
  for (const e of allow[kind] || []) {
    ck(`${kind}.${e.name} states a reason`, !!e.reason && e.reason.length > 20, e.name);
    ck(`${kind}.${e.name} states an expiry`, /^\d{4}-\d{2}-\d{2}$/.test(e.until || ''), e.until);
  }
}

// ── the scan covers the userscripts, where three of four instances were ────
const files = walk(path.join(__dirname, '../../userscript'));
ck('the userscripts are in scope', files.length >= 4, files.length);
const us = scanFunctions(files, allow);
ck('and every call in them resolves today', us.findings.length === 0,
   us.findings.map((f) => `${f.name} in ${f.file}`));

console.log(`\nsource scan: ${p}/${n}`);
process.exit(p === n ? 0 : 1);

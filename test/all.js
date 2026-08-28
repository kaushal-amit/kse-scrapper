'use strict';
/**
 * test/all.js — run every suite and report one verdict.
 *
 * Suites used to live outside the repository, so `npm test` ran one of ten and
 * reported green. A test runner that silently covers a tenth of the code is
 * worse than none: it produces confidence proportional to nothing.
 *
 * Each suite runs in its OWN process. They mutate shared module state (the
 * login guard, the browser pool, worker threads) and would contaminate each
 * other in-process — one suite's teardown closing another's pool looks like a
 * flaky test rather than a fixture problem.
 *
 * Suites needing a browser or the fixture servers are skipped, loudly, when
 * those are absent. A skip is reported as a skip, never as a pass.
 */

// The suites load .env themselves; the runner must too, or its checks are made
// against a different environment than the one the suites will actually see.
// That is why a stale CHROMIUM_PATH still produced a failure instead of a skip:
// the runner could not see the variable at all.
try { require('dotenv').config(); } catch { /* dotenv optional */ }

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SUITES = path.join(__dirname, 'suites');

/** Suites that need something beyond node + postgres. */
const REQUIRES = {
  'socket-tap.test.js': { browser: true, why: 'needs a browser and the ws fixture' },
  'real-dom.test.js': { browser: true, why: 'needs a browser and the fixture server' },
  'depth-identity.test.js': { browser: true, why: 'needs a browser' },
};

/**
 * A missing browser is a SKIP, not a failure.
 *
 * The env var being set is not the same as the binary existing — a stale
 * CHROMIUM_PATH pointing at a cleared temp directory reported these suites as
 * failing, which buries a real regression among environment noise. Check the
 * file.
 */
function browserAvailable() {
  const explicit = process.env.CHROMIUM_PATH;
  if (explicit) return fs.existsSync(explicit);

  // Playwright being INSTALLED is not the same as its browser being
  // DOWNLOADED. Assuming it was turned a missing binary into a failing suite,
  // which buries a real regression in environment noise. Ask playwright where
  // the executable is and check for it.
  try {
    const { chromium } = require('playwright');
    const path = chromium.executablePath();
    return Boolean(path) && fs.existsSync(path);
  } catch { return false; }
}

function run(file) {
  const need = REQUIRES[file];
  if (need && need.browser && !browserAvailable()) {
    return {
      file,
      status: 'skipped',
      note: `no usable browser — ${need.why}`,
    };
  }

  const res = spawnSync(process.execPath, [path.join(SUITES, file)], {
    encoding: 'utf8', timeout: 240_000, env: process.env,
  });
  const out = `${res.stdout || ''}${res.stderr || ''}`;

  // Suites print "<name>: <passed>/<total>" or the node:test tally.
  const score = out.match(/([a-z][\w\s-]*):\s*(\d+)\/(\d+)/i);
  const tally = out.match(/#\s*pass\s+(\d+)[\s\S]*?#\s*fail\s+(\d+)/);

  let summary = '';
  if (score) summary = `${score[2]}/${score[3]}`;
  else if (tally) summary = `${tally[1]} passed, ${tally[2]} failed`;

  const failed = res.status !== 0;
  return {
    file,
    status: failed ? 'FAILED' : 'passed',
    summary,
    output: failed ? out.split('\n').filter((l) => /FAIL|Error|not ok/.test(l)).slice(0, 6) : [],
  };
}

function main() {
  const files = fs.existsSync(SUITES)
    ? fs.readdirSync(SUITES).filter((f) => f.endsWith('.test.js')).sort()
    : [];

  // The original suite lives alongside, not under suites/.
  const results = [run.call(null, '../run.js')].filter(() => false);
  const all = [];

  const mainSuite = spawnSync(process.execPath, [path.join(__dirname, 'run.js')], {
    encoding: 'utf8', timeout: 240_000, env: process.env,
  });
  const mainOut = `${mainSuite.stdout || ''}${mainSuite.stderr || ''}`;
  const mainTally = mainOut.match(/(\d+)\s+passed,\s+(\d+)\s+failed/);
  all.push({
    file: 'run.js (schedule, validation, schema, persistence)',
    status: mainSuite.status === 0 ? 'passed' : 'FAILED',
    summary: mainTally ? `${mainTally[1]} passed, ${mainTally[2]} failed` : '',
    output: mainSuite.status === 0 ? []
      : mainOut.split('\n').filter((l) => /FAIL/.test(l)).slice(0, 6),
  });

  for (const f of files) all.push(run(f));

  console.log(`\n  TEST SUITES\n  ${'─'.repeat(70)}`);
  for (const r of all) {
    const tag = r.status === 'passed' ? '[ok  ]' : r.status === 'skipped' ? '[skip]' : '[FAIL]';
    console.log(`  ${tag} ${r.file.padEnd(46)} ${r.summary || r.note || ''}`);
    for (const line of r.output || []) console.log(`         ${line.trim()}`);
  }

  const failed = all.filter((r) => r.status === 'FAILED');
  const skipped = all.filter((r) => r.status === 'skipped');
  console.log(`  ${'─'.repeat(70)}`);
  console.log(`  ${all.length - failed.length - skipped.length} passed, `
    + `${failed.length} failed, ${skipped.length} skipped\n`);

  process.exit(failed.length ? 1 : 0);
}

main();

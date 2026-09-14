'use strict';
/**
 * S-10 · the security/ops hygiene items: a bounded /debug, no dead code that
 * reads as live, and no dependency the service does not use.
 *
 * Round 3, items S12 / S13 / S15.
 *
 * The one with real teeth is /debug. It writes client-supplied data to disk, on
 * the request thread, from an array with no length cap and no retention limit —
 * the four broker-terminal page dumps that ended up committed to git came off
 * that pile.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

const { requireTestDb } = require('../dbguard');
requireTestDb('security-ops-hygiene');

// /debug sits behind the AWSAT_MODE gate like the rest of the client surface.
// Set it here rather than depending on the shell, so the suite tests the
// endpoint's bounds and not the operator's environment.
process.env.AWSAT_MODE = 'client';

const { close } = require('../../src/db/pool');
const ingest = require('../../src/api/ingest');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };

const REPO = path.join(__dirname, '..', '..');
const TMP = path.join(REPO, 'tmp');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

function post(port, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: '/ingest/debug', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data),
        'x-ingest-token': process.env.INGEST_TOKEN },
    }, (res) => {
      let out = ''; res.on('data', (c) => { out += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(out) }); } catch { resolve({ status: res.statusCode, body: out }); } });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

(async () => {
  let server;
  try {
    // ── S13 · dead code that read as live ─────────────────────────────────
    {
      // Live code only: the S8 comment explains what defaultHistoryCron was and
      // why deleting it was not the fix on its own.
      const sched = read('src/scheduler.js')
        .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      ck('defaultHistoryCron is gone', !/defaultHistoryCron/.test(sched),
        (sched.match(/.*defaultHistoryCron.*/) || [])[0]);

      const depth = read('userscript/awsat-depth-all.user.js');
      ck('the depth userscript has no hardcoded fallback symbol list',
        !/FALLBACK_SYMBOLS/.test(depth));
      ck('and says plainly that it sweeps nothing when the list is unreachable',
        /sweeping nothing/.test(depth));
      // The comment beside it already argued the case; the code did it anyway.
      ck('no bank tickers are left hardcoded in it',
        !/'NBK'\s*,\s*'KFH'/.test(depth), (depth.match(/'NBK'[^\n]*/g) || [])[0]);

      // Comments are allowed to MENTION the removed guard — the commit that
      // removed it explains what it was. Only live code is checked.
      const wake = read('src/wakeup.js')
        .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      ck('the clock.toDay guard is gone — clock has never exported toDay',
        !/clock\.toDay/.test(wake), (wake.match(/.*clock\.toDay.*/) || [])[0]);
    }

    // ── S15 · dependencies ────────────────────────────────────────────────
    {
      const pkg = JSON.parse(read('package.json'));
      ck('ws is not a dependency — nothing requires it', !pkg.dependencies.ws);
      ck('jsdom is a DEV dependency — only the suites use it',
        !pkg.dependencies.jsdom && !!(pkg.devDependencies || {}).jsdom, pkg.devDependencies);
      ck('node-cron is 4.x', /^\^?4\./.test(pkg.dependencies['node-cron']), pkg.dependencies['node-cron']);

      // And the runtime deps are actually required somewhere in src/.
      const srcAll = ['src', 'scripts'].flatMap((d) => {
        const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((f) => (
          f.isDirectory() ? walk(path.join(dir, f.name))
            : (f.name.endsWith('.js') ? [fs.readFileSync(path.join(dir, f.name), 'utf8')] : [])));
        return walk(path.join(REPO, d));
      }).join('\n');
      for (const dep of Object.keys(pkg.dependencies)) {
        ck(`${dep} is actually required`, new RegExp(`require\\(['"]${dep}`).test(srcAll), dep);
      }
    }

    // ── S12 · /debug is bounded ───────────────────────────────────────────
    {
      fs.mkdirSync(TMP, { recursive: true });
      for (const f of fs.readdirSync(TMP).filter((x) => x.startsWith('client-'))) fs.unlinkSync(path.join(TMP, f));

      const app = express();
      app.use(express.json({ limit: '8mb' }));
      app.use('/ingest', ingest.createRouter());
      server = http.createServer(app);
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const port = server.address().port;

      // Twelve items, cap five.
      const many = Array.from({ length: 12 }, (_, i) => ({ source: `s${i}`, d: `payload ${i}` }));
      const res = await post(port, { items: many });
      ck('a /debug post is accepted', res.status === 200, res.status);
      ck('at most five files are written', res.body.written === 5, res.body);
      ck('and the excess is REPORTED, not silently dropped', res.body.dropped === 7, res.body);
      ck('the limits are stated back', res.body.limits && res.body.limits.maxItems === 5, res.body.limits);

      // An oversized payload is truncated and says so.
      const big = await post(port, { items: [{ source: 'big', d: 'x'.repeat(700 * 1024) }] });
      ck('an oversized dump is truncated', big.body.truncated === 1, big.body);
      const files = fs.readdirSync(TMP).filter((x) => x.startsWith('client-big-'));
      ck('and the file on disk is capped at 512 KB',
        files.length === 1 && fs.statSync(path.join(TMP, files[0])).size === 512 * 1024,
        files.map((f) => fs.statSync(path.join(TMP, f)).size));

      // The pile is swept: a client in a loop cannot fill the disk.
      for (let i = 0; i < 10; i += 1) {
        await post(port, { items: Array.from({ length: 5 }, (_, j) => ({ source: `sweep${i}_${j}`, d: 'x' })) });
      }
      const left = fs.readdirSync(TMP).filter((x) => x.startsWith('client-'));
      ck('at most 40 dumps are kept', left.length <= 40, left.length);

      // Server paths are no longer handed back to the client.
      ck('the response carries no server paths', !('files' in res.body), Object.keys(res.body));

      for (const f of fs.readdirSync(TMP).filter((x) => x.startsWith('client-'))) fs.unlinkSync(path.join(TMP, f));
    }
  } catch (e) {
    ck('the suite ran without throwing', false, e.message);
  }

  if (server) await new Promise((r) => server.close(r));
  await close();
  console.log(`\nsecurity ops hygiene: ${p}/${n}`);
  process.exit(p === n ? 0 : 1);
})();

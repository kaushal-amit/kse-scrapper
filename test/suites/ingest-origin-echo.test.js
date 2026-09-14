'use strict';
/**
 * H-C · the origin allowlist, wired to the router that actually answers.
 *
 * THE DEFECT. src/api/ingestSecurity.js gained parseOrigins and resolveOrigin
 * in the 10 Sep rebuild — a per-request echo, which is the only correct way to
 * serve an allowlist. src/api/ingest.js never called either of them. Its router
 * still did:
 *
 *   const ORIGIN = process.env.INGEST_ORIGIN || '*';
 *   res.set('Access-Control-Allow-Origin', ORIGIN);
 *
 * Access-Control-Allow-Origin accepts exactly ONE origin, or '*'. Set
 * INGEST_ORIGIN to the two origins the broker terminal actually serves the
 * userscripts from — www.awsatbroker.com and awsatbroker.com — and every
 * browser rejects the comma-list as an illegal header value. fetch() fails with
 * a network error, the page discards the response, and NOTHING reaches the
 * server log: the capture stops silently for exactly the configuration the
 * allowlist was added to support.
 *
 * The security module was tested and correct. The router did not use it. That
 * is the failure this suite exists to prevent recurring: a guard that lives in
 * a module nobody calls is not a guard.
 *
 * The suite exercises the REAL router over a real HTTP listener, because the
 * bug was entirely in the wiring — a unit test of resolveOrigin passed
 * throughout.
 */
const { requireTestDb } = require('../dbguard');
requireTestDb('ingest-origin-echo');

const http = require('http');
const fs = require('fs');
const path = require('path');
const { close } = require('../../src/db/pool');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };

const TOKEN = process.env.INGEST_TOKEN || 'test-only-ingest-token-0123456789abcdef';

/**
 * Build an app with a given INGEST_ORIGIN. The router reads the env at
 * construction, so the variable is set and the module cache cleared around it —
 * which also proves the value is read once at build rather than per request.
 */
function appWith(originEnv) {
  const before = process.env.INGEST_ORIGIN;
  if (originEnv === undefined) delete process.env.INGEST_ORIGIN;
  else process.env.INGEST_ORIGIN = originEnv;
  process.env.INGEST_TOKEN = TOKEN;
  for (const k of Object.keys(require.cache)) {
    if (/src[\\/]api[\\/]ingest\.js$/.test(k)) delete require.cache[k];
  }
  const express = require('express');
  const app = express();
  app.use('/', require('../../src/api/ingest').createRouter());
  if (before === undefined) delete process.env.INGEST_ORIGIN;
  else process.env.INGEST_ORIGIN = before;
  return app;
}

/** One request; resolves with { status, headers }. */
function hit(app, { method = 'OPTIONS', pathname = '/orders', origin } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app).listen(0, '127.0.0.1', () => {
      const headers = { 'x-ingest-token': TOKEN };
      if (origin) headers.Origin = origin;
      const req = http.request({
        host: '127.0.0.1', port: server.address().port, path: pathname, method, headers,
      }, (res) => {
        res.resume();
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode, headers: res.headers });
        });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.end();
    });
  });
}

const acao = (r) => r.headers['access-control-allow-origin'];

(async () => {
  try {
    // ── THE BUG · a two-origin allowlist ──────────────────────────────────
    {
      const app = appWith('https://www.awsatbroker.com,https://awsatbroker.com');

      const a = await hit(app, { origin: 'https://www.awsatbroker.com' });
      ck('the first allowed origin is echoed, alone',
        acao(a) === 'https://www.awsatbroker.com', acao(a));

      const b = await hit(app, { origin: 'https://awsatbroker.com' });
      ck('and so is the second', acao(b) === 'https://awsatbroker.com', acao(b));

      ck('NEITHER answer is the comma-list — that header is illegal and every '
        + 'browser discards the response', !String(acao(a)).includes(','), acao(a));
      ck('nor does it contain a space-separated list either',
        !/\s/.test(String(acao(a))), acao(a));
    }

    // ── an origin NOT on the list gets no permission ──────────────────────
    {
      const app = appWith('https://www.awsatbroker.com');
      const r = await hit(app, { origin: 'https://evil.example' });
      ck('an unlisted origin gets NO Allow-Origin header at all',
        acao(r) === undefined, acao(r));
      ck('and specifically is not answered with the allowed origin — that would '
        + 'be a header that permits somebody else', acao(r) !== 'https://www.awsatbroker.com', acao(r));
    }

    // ── the default is still permissive, deliberately ─────────────────────
    {
      const app = appWith(undefined);
      const r = await hit(app, { origin: 'https://www.awsatbroker.com' });
      ck('with INGEST_ORIGIN unset the endpoint stays open — these are '
        + 'token-authenticated and write-only', acao(r) === '*', acao(r));
      const star = appWith('*');
      ck("and an explicit '*' behaves the same",
        acao(await hit(star, { origin: 'https://anywhere.example' })) === '*');
    }

    // ── a request with NO Origin is not a browser request ─────────────────
    {
      const app = appWith('https://www.awsatbroker.com');
      const r = await hit(app, {});
      ck('curl and server-side posters are not blocked by a rule that cannot '
        + 'apply to them', acao(r) === '*', acao(r));
    }

    // ── Vary: Origin is set even when the answer is "no header" ───────────
    {
      const app = appWith('https://www.awsatbroker.com');
      const refused = await hit(app, { origin: 'https://evil.example' });
      ck('Vary: Origin is set on a REFUSED request too — a cache that missed '
        + "that would serve one origin's permission to another",
        /origin/i.test(String(refused.headers.vary)), refused.headers.vary);
    }

    // ── the preflight still short-circuits ────────────────────────────────
    {
      const app = appWith('https://www.awsatbroker.com');
      const r = await hit(app, { origin: 'https://www.awsatbroker.com' });
      ck('OPTIONS is answered 204 here, not passed to the auth middleware — a '
        + '401 on the preflight makes the POST never happen', r.status === 204, r.status);
      ck('and it names the headers the userscript sends',
        /x-ingest-token/i.test(String(r.headers['access-control-allow-headers'])),
        r.headers['access-control-allow-headers']);
    }

    // ── and the raw env value is no longer set as a header anywhere ────────
    {
      const src = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'api', 'ingest.js'), 'utf8');
      const live = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      ck('ingest.js calls resolveOrigin', /security\.resolveOrigin\(/.test(live));
      ck('and parseOrigins', /security\.parseOrigins\(/.test(live));
      ck('no `INGEST_ORIGIN || \'*\'` constant survives',
        !/INGEST_ORIGIN\s*\|\|\s*'\*'/.test(live),
        (live.match(/.*INGEST_ORIGIN.*/g) || []));
      ck('and Allow-Origin is never set from process.env directly',
        !/Access-Control-Allow-Origin['"],\s*process\.env/.test(live));
    }
  } catch (e) {
    ck('the suite ran without throwing', false, e.message);
  }

  await close();
  console.log(`\ningest origin echo: ${p}/${n}`);
  process.exit(p === n ? 0 : 1);
})();

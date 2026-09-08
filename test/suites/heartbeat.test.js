// C2 · the userscript heartbeat. Every script checks in each cycle — data or
// not — so a script that STOPS is visible (last_seen_at stops advancing) and
// its reason is legible (`problem`). This is what the orders script lacked when
// it went dark for six sessions unnoticed.
process.env.AWSAT_MODE = 'client'; process.env.INGEST_TOKEN = 'trading';
// Roster expects these; 'test-absent' never checks in, to prove absent != silent.
process.env.EXPECTED_SCRIPTS = 'test-orders,test-absent';
const express = require('express');
const db = require('../../src/db/pool');
const ingest = require('../../src/api/ingest');
let p = 0, n = 0; const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, JSON.stringify(x)); };

const app = express(); app.use(express.json());
app.use('/', ingest.createRouter());
const PORT = 8819;
const post = (path, body, token = 'trading') => fetch(`http://127.0.0.1:${PORT}${path}`, {
  method: 'POST',
  headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
  body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

const srv = app.listen(PORT, async () => {
  try {
    await db.query("DELETE FROM client_heartbeat WHERE script LIKE 'test-%'");

    // ── a check-in with NO data is still recorded ──
    const r1 = await post('/heartbeat', { script: 'test-orders', version: '2.3.0', rowsSeen: 0, problem: 'Order List tab is active and empty' });
    ck('POST /heartbeat accepts a zero-row check-in', r1.status === 200 && r1.body.ok === true, r1.body);
    const { rows: h1 } = await db.query("SELECT * FROM client_heartbeat WHERE script = 'test-orders'");
    ck('a row is written for the script', h1.length === 1 && Number(h1[0].rows_seen) === 0, h1);
    ck('  the panel reason is captured', /active and empty/.test(h1[0].problem), h1[0] && h1[0].problem);
    ck('  the version is captured', h1[0].version === '2.3.0', h1[0] && h1[0].version);

    // ── a second check-in UPSERTS (one row per script), advancing last_seen ──
    const t1 = h1[0].last_seen_at;
    await new Promise((r) => setTimeout(r, 1100));
    const r2 = await post('/heartbeat', { script: 'test-orders', version: '2.3.0', rowsSeen: 3, problem: null });
    ck('a second check-in is accepted', r2.status === 200, r2.body);
    const { rows: h2 } = await db.query("SELECT * FROM client_heartbeat WHERE script = 'test-orders'");
    ck('  still exactly one row (upsert, not append)', h2.length === 1, h2.length);
    ck('  rows_seen and last_seen_at advanced', Number(h2[0].rows_seen) === 3 && new Date(h2[0].last_seen_at) > new Date(t1), h2[0]);

    // ── the roster: a fresh script is ok; one that never checked in is ABSENT ──
    const roster1 = await ingest.scriptRoster(300);
    const ro = roster1.find((s) => s.script === 'test-orders');
    const ra = roster1.find((s) => s.script === 'test-absent');
    ck('roster shows a fresh script as ok', ro && ro.status === 'ok', ro);
    ck('roster shows a never-seen expected script as ABSENT (not fine)', ra && ra.status === 'absent', ra);

    // ── go quiet: staleScripts flags it, and the roster turns it SILENT ──
    await db.query("UPDATE client_heartbeat SET last_seen_at = now() - interval '20 minutes' WHERE script = 'test-orders'");
    const stale = await ingest.staleScripts(300);
    ck('staleScripts flags the quiet script with its silent age', stale.some((s) => s.script === 'test-orders' && s.silent_sec >= 300), stale);
    const fresh = await ingest.staleScripts(3600);
    ck('  and does NOT flag it under a longer window', !fresh.some((s) => s.script === 'test-orders'), fresh);
    const roster2 = await ingest.scriptRoster(300);
    ck('roster turns the quiet script SILENT (still distinct from absent)',
      roster2.find((s) => s.script === 'test-orders').status === 'silent'
      && roster2.find((s) => s.script === 'test-absent').status === 'absent', roster2);

    // ── refusals ──
    const bad = await post('/heartbeat', {}, 'trading');
    ck('a heartbeat with no script is 400', bad.status === 400, bad.body);
    const noauth = await post('/heartbeat', { script: 'test-orders' }, null);
    ck('a heartbeat with no token is 401', noauth.status === 401, noauth.body);

    await db.query("DELETE FROM client_heartbeat WHERE script LIKE 'test-%'");
    console.log(`\nheartbeat: ${p}/${n}`);
    srv.close(); await db.close();
    process.exit(p === n ? 0 : 1);
  } catch (e) {
    console.error('heartbeat suite error:', e);
    srv.close(); try { await db.close(); } catch (_) {}
    process.exit(1);
  }
});

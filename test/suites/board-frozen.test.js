'use strict';
/**
 * S-15 · H9/H10/H11 — a board that stops CHANGING is degraded, and a sweep only
 * counts what the server accepted (migration 044, depth userscript 2.4.0).
 *
 * THE FAILURE H11 CATCHES. The heartbeat proves a feed is posting. It cannot
 * prove the feed is posting anything NEW. A terminal whose websocket has died
 * keeps rendering the last board it received: the userscript reads 137 rows
 * every cycle, posts them, the server accepts them, client_heartbeat advances,
 * /health is green — and every price is frozen at whatever it was when the
 * socket dropped. That is strictly worse than the feed stopping: a stopped feed
 * leaves a gap anyone can see, a frozen one writes plausible rows all session,
 * and the range, the tape quality and the still-rate are then computed from a
 * photograph.
 *
 * Deliberately the WHOLE board, not per symbol. Individual symbols go quiet for
 * minutes at a time; flagging those would fire constantly. It is 137 symbols
 * being byte-identical a minute apart that cannot happen.
 */
const fs = require('fs');
const path = require('path');
const { requireTestDb } = require('../dbguard');
requireTestDb('board-frozen');

const { query, close } = require('../../src/db/pool');
const fresh = require('../../src/api/boardFreshness');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };

const DEPTH = fs.readFileSync(path.join(__dirname, '../../userscript/awsat-depth-all.user.js'), 'utf8');
const DAY = '2026-09-10';
const board = (px) => [
  { symbol: 'CATTL', last_price: px, volume: 1000 },
  { symbol: 'ZAIN', last_price: 500, volume: 2000 },
];
const at = (m) => new Date(`2026-09-10T09:${String(m).padStart(2, '0')}:00+03:00`);

(async () => {
  try {
    await query('DELETE FROM quote_fingerprint');

    // ── the fingerprint is over what should MOVE ──────────────────────────
    {
      ck('the same board hashes the same', fresh.fingerprint(board(176)) === fresh.fingerprint(board(176)));
      ck('a changed price changes it', fresh.fingerprint(board(176)) !== fresh.fingerprint(board(177)));
      ck('row ORDER does not change it — the board is a set, not a list',
        fresh.fingerprint(board(176)) === fresh.fingerprint([...board(176)].reverse()));
    }

    // ── three identical captures is degraded; two is not ──────────────────
    {
      const one = await fresh.recordAndCheck({ rows: board(176), capturedAt: at(1), tradingDate: DAY, source: 'awsat_client' });
      ck('one capture is not frozen', one.frozen === false, one);

      const two = await fresh.recordAndCheck({ rows: board(176), capturedAt: at(2), tradingDate: DAY, source: 'awsat_client' });
      ck('TWO identical is not frozen — a quiet minute near the close is real',
        two.frozen === false, two);

      const three = await fresh.recordAndCheck({ rows: board(176), capturedAt: at(3), tradingDate: DAY, source: 'awsat_client' });
      ck('THREE identical IS frozen', three.frozen === true, three);
      ck('and it says how many', three.identical === 3, three);
    }

    // ── a moving board clears it ──────────────────────────────────────────
    {
      const moved = await fresh.recordAndCheck({ rows: board(177), capturedAt: at(4), tradingDate: DAY, source: 'awsat_client' });
      ck('one changed price clears the state', moved.frozen === false, moved);
      ck('and the identical run restarts at one', moved.identical === 1, moved);

      const st = await fresh.status(DAY);
      ck('/health reads OK once the board moves', st.state === 'OK', st);
    }

    // ── too few captures says UNKNOWN, not OK ─────────────────────────────
    {
      await query('DELETE FROM quote_fingerprint');
      await fresh.recordAndCheck({ rows: board(176), capturedAt: at(1), tradingDate: DAY, source: 'awsat_client' });
      const st = await fresh.status(DAY);
      ck('with too few captures the state is UNKNOWN, not OK', st.state === 'UNKNOWN', st);
      ck('and it says how many more it needs', st.need === 3, st);
    }

    // ── the check never fails the ingest it observes ──────────────────────
    {
      const empty = await fresh.recordAndCheck({ rows: [], capturedAt: at(9), tradingDate: DAY, source: 'awsat_client' });
      ck('an empty batch is not frozen and does not throw', empty.frozen === false, empty);

      const bad = await fresh.recordAndCheck({
        rows: board(176), capturedAt: at(9), tradingDate: 'not-a-date', source: 'awsat_client' });
      ck('a failing write is reported, not thrown — the capture still lands',
        bad.frozen === false && !!bad.error, bad);
    }

    // ── the depth userscript, at least 2.4.0 ──────────────────────────────
    //
    // AT LEAST, not exactly. This suite owns the round-3 behaviour, not the
    // version number, and pinning the exact string made every later fix to
    // this script fail an unrelated suite. What has to hold is that the build
    // carrying these behaviours is not older than the one that introduced
    // them — and that the header and the panel constant still AGREE, which is
    // the failure that actually cost a session: two scripts both reporting
    // 2.0.0.
    {
      const hdr = (DEPTH.match(/@version\s+(\d+\.\d+\.\d+)/) || [])[1];
      const panel = (DEPTH.match(/var VERSION = '(\d+\.\d+\.\d+)'/) || [])[1];
      const atLeast = (v, min) => {
        const a = String(v).split('.').map(Number);
        const b = min.split('.').map(Number);
        for (let i = 0; i < 3; i += 1) {
          if (a[i] > b[i]) return true;
          if (a[i] < b[i]) return false;
        }
        return true;
      };
      ck('the depth userscript is at least 2.4.0', hdr && atLeast(hdr, '2.4.0'), hdr);
      ck('and the panel constant agrees with the header', panel === hdr, [hdr, panel]);

      // H9 · a symbol counts when the SERVER accepted it.
      ck('the sweep awaits the POST rather than firing and forgetting',
        /return post\(\{[\s\S]*?\}\)\.then\(function \(\) \{[\s\S]*?done\(true, true\)/.test(DEPTH));
      ck('a read-but-not-accepted ladder is counted separately',
        /done\(true, false\)/.test(DEPTH));
      ck('and the heartbeat carries the ACCEPTED count',
        /heartbeat\(ok,/.test(DEPTH));
      ck('the panel shows read and accepted when they differ',
        /read ' \+ read \+ ', ' \+ \(read - ok\)/.test(DEPTH));

      // H10 · a POST has a deadline, and the queue is drained.
      ck('every POST has a 6 s deadline', /POST_TIMEOUT_MS = 6000/.test(DEPTH));
      ck('an abort is reported as a TIMEOUT, in words', /timed out after/.test(DEPTH));
      ck('and it is retryable, not permanent',
        !/AbortError[\s\S]{0,200}permanent: true/.test(DEPTH));
      ck('the retry queue is flushed at the end of every sweep',
        /if \(retryQueue\.length\) \{\s*\n\s*flush\(\)/.test(DEPTH));

      // H11 · a slot beyond the sweep is the script's own PROBLEM.
      ck('a slot gap becomes the panel problem, not a passing message',
        /stats\.problem = list\.length \+ ' slots but only '/.test(DEPTH));
      ck('and it names the symbols that are NOT captured',
        /are NOT being captured/.test(DEPTH));
      ck('the problem is cleared when there is no gap', /stats\.problem = null;/.test(DEPTH));
      ck('and the sweep reports it on the heartbeat so it reaches /health',
        /heartbeat\(ok,[\s\S]{0,200}stats\.problem/.test(DEPTH));
    }

    await query('DELETE FROM quote_fingerprint');
  } catch (e) {
    ck('the suite ran without throwing', false, e.message);
  }

  await close();
  console.log(`\nboard frozen: ${p}/${n}`);
  process.exit(p === n ? 0 : 1);
})();

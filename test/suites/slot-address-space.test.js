'use strict';
/**
 * P2 · one definition of the depth-slot address space, and a login budget that
 * refuses when it cannot record the debit.
 *
 * ─── THE SLOTS ─────────────────────────────────────────────────────────────
 * There were three definitions and they disagreed:
 *
 *   · ingest.js published SLOT_COUNT (default 5) and validated both POSTs
 *     against it, under a comment that says the GET, both POSTs and the
 *     backend's stale check "all follow the published number — never a
 *     literal";
 *   · wakeup.js had `const WAKEUP_SLOTS = [4, 5, 6, 7, 8]` — that literal;
 *   · migration 024 permits 1-8, so the writes succeeded;
 *   · GET /depth-symbols had NO slot_no bound and served whatever was there;
 *   · the depth userscript truncates the list to what it can sweep.
 *
 * Slots 1-3 pre-day, wake-ups fill 4 and 5, a third symbol fires at 11:20: the
 * scan takes slot 6, writes the watchlist row and a WAKEUP signal_log row, and
 * reports promoted: 1 on a SUCCESS run. Six entries go to a client that sweeps
 * five; it truncates in slot order and drops the symbol that just fired. Its
 * ladder is never captured for the rest of the session — unrecoverable — while
 * every server-side record says it was promoted. And it cannot be undone:
 * POST /slots/6 answers 400, and the bulk POST rejects any list containing it.
 *
 * ─── THE LOGIN BUDGET ──────────────────────────────────────────────────────
 * read() fails SAFE — an unreadable state file is treated as a spent budget,
 * because "the cost of a wrong wait is a delay, the cost of a wrong go-ahead is
 * the day". write() failed OPEN: it logged "the guard is now blind" and
 * returned, and reserve() reported allowed for a debit that landed nowhere.
 * current() re-reads from disk, so the counter never advanced and the cooldown
 * never engaged — every worker respawn granted an attempt the broker was
 * counting and we were not, against a cap of two.
 */
const { requireTestDb } = require('../dbguard');
requireTestDb('slot-address-space');

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { query, close } = require('../../src/db/pool');
const slots = require('../../src/config/slots');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };

const REPO = path.join(__dirname, '..', '..');

// ── the address space is derived, in both directions ───────────────────────
{
  ck('the default sweep is five slots', slots.slotCount({}) === 5, slots.slotCount({}));
  ck('pre-day is 1-3', JSON.stringify(slots.preDaySlots({})) === '[1,2,3]', slots.preDaySlots({}));
  ck('and a wake-up may take 4 or 5 — the slots the sweep can reach',
    JSON.stringify(slots.wakeupSlots({})) === '[4,5]', slots.wakeupSlots({}));
  ck('NOT 6, 7 and 8', !slots.wakeupSlots({}).includes(6), slots.wakeupSlots({}));

  ck('widening the sweep widens the wake-up range',
    JSON.stringify(slots.wakeupSlots({ SLOT_COUNT: '8' })) === '[4,5,6,7,8]',
    slots.wakeupSlots({ SLOT_COUNT: '8' }));
  ck('and narrowing it narrows them',
    JSON.stringify(slots.wakeupSlots({ SLOT_COUNT: '4' })) === '[4]',
    slots.wakeupSlots({ SLOT_COUNT: '4' }));
  ck('a sweep of three leaves NO wake-up slots rather than inventing one',
    JSON.stringify(slots.wakeupSlots({ SLOT_COUNT: '3' })) === '[]',
    slots.wakeupSlots({ SLOT_COUNT: '3' }));

  ck('the schema CHECK is the ceiling — 024 permits 1-8 and an INSERT above it '
    + 'would fail', slots.slotCount({ SLOT_COUNT: '99' }) === 8, slots.slotCount({ SLOT_COUNT: '99' }));
  ck('and a garbage value falls back rather than disabling the sweep',
    slots.slotCount({ SLOT_COUNT: 'five' }) === 5, slots.slotCount({ SLOT_COUNT: 'five' }));
  ck('zero is floored at one', slots.slotCount({ SLOT_COUNT: '0' }) === 1);
}

// ── and both readers now read it ───────────────────────────────────────────
{
  const wakeup = fs.readFileSync(path.join(REPO, 'src/wakeup.js'), 'utf8');
  const live = wakeup.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  ck('wakeup.js no longer holds a slot literal',
    !/\[\s*4,\s*5,\s*6,\s*7,\s*8\s*\]/.test(live), (live.match(/.*4, 5, 6.*/g) || []));
  ck('and reads the shared module', /slots\.wakeupSlots\(\)/.test(live));

  const ingest = fs.readFileSync(path.join(REPO, 'src/api/ingest.js'), 'utf8');
  ck('the router reads the same module', /slotConfig\.slotCount\(\)/.test(ingest));
  ck('and no longer computes its own count',
    !/SLOT_COUNT = Math\.max\(1, Number\(process\.env\.SLOT_COUNT/.test(ingest));
}

(async () => {
  try {
    // ── a row above the count is not served, and IS named ──────────────────
    {
      // The GET serves TODAY's slots — it has no date parameter, deliberately:
      // the sweep asks "what am I watching now". So the fixture is dated today.
      const clock = require('../../src/market/clock');
      const DAY = clock.tradingDay();
      await query('DELETE FROM depth_watchlist WHERE trading_date = $1', [DAY]);
      await query("DELETE FROM instruments WHERE symbol LIKE 'ZZSLOT%'");
      await query(`INSERT INTO instruments (symbol, market, is_tradeable) VALUES
        ('ZZSLOTA','Main Market',true), ('ZZSLOTB','Main Market',true),
        ('ZZSLOTC','Main Market',true)`);
      await query(
        `INSERT INTO depth_watchlist (slot_no, symbol, trading_date, slot_type) VALUES
           (1,'ZZSLOTA',$1,'PRE_DAY'), (4,'ZZSLOTB',$1,'WAKEUP'), (6,'ZZSLOTC',$1,'WAKEUP')`,
        [DAY]);

      const express = require('express');
      const http = require('http');
      const app = express();
      process.env.INGEST_TOKEN = process.env.INGEST_TOKEN
        || 'test-only-ingest-token-0123456789abcdef';
      app.use('/', require('../../src/api/ingest').createRouter());

      const body = await new Promise((resolve, reject) => {
        const server = http.createServer(app).listen(0, '127.0.0.1', () => {
          http.get({
            host: '127.0.0.1',
            port: server.address().port,
            path: '/depth-symbols',
            headers: { 'x-ingest-token': process.env.INGEST_TOKEN },
          }, (res) => {
            let buf = '';
            res.on('data', (c) => { buf += c; });
            res.on('end', () => { server.close(); resolve(JSON.parse(buf)); });
          }).on('error', (e) => { server.close(); reject(e); });
        });
      });

      const served = (body.symbols || []).map((s) => s.slot);
      ck('slots within the count are served', served.includes(1) && served.includes(4), served);
      ck('THE SLOT ABOVE THE COUNT IS NOT — the client would have truncated it '
        + 'away anyway, silently', !served.includes(6), served);
      ck('and it is NAMED in the response rather than just hidden',
        Array.isArray(body.beyondSlotCount)
        && body.beyondSlotCount.some((b) => Number(b.slot) === 6), body.beyondSlotCount);
      ck('with a warning an operator can act on',
        /cannot be released through the API/.test(String(body.warning)), body.warning);
      ck('and the published count is still there', body.slotCount === 5, body.slotCount);

      await query('DELETE FROM depth_watchlist WHERE trading_date = $1', [DAY]);
      await query("DELETE FROM instruments WHERE symbol LIKE 'ZZSLOT%'");
    }

    // ── THE LOGIN BUDGET · an unrecordable debit is refused ────────────────
    {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loginstate-'));
      const state = path.join(dir, 'sub', 'login.json');

      /*
       * The unwritable case is created by putting a FILE where the state's
       * parent directory must be, so mkdirSync throws ENOTDIR.
       *
       * Not by chmod: these suites often run as root, and root ignores
       * permission bits — a chmod-based fixture passes by not reproducing
       * anything, which is the worst kind of green.
       */
      const blocker = path.join(dir, 'sub');

      const env = (over = {}) => ({
        ...process.env,
        AWSAT_LOGIN_STATE: state,
        AWSAT_MAX_LOGIN_ATTEMPTS: '2',
        AWSAT_LOGIN_COOLDOWN_MS: '0',
        ...over,
      });
      const run = (body, over) => execFileSync(process.execPath, ['-e',
        `const guard = require(${JSON.stringify(path.join(REPO, 'src/scrapers/loginGuard.js'))});\n${body}`],
      { encoding: 'utf8', env: env(over), cwd: REPO }).trim().split('\n').pop();

      // Writable: the budget behaves.
      ck('a writable state file grants the first attempt',
        run('process.stdout.write(String(guard.reserve().allowed))') === 'true');
      ck('and records it', run('process.stdout.write(String(guard.summary().attemptsUsed))') === '1');

      // Now make it unwritable.
      // Keep what the guard has recorded so far, then put a FILE where its
      // parent directory has to be. Restoring it afterwards is what lets the
      // last check prove the budget picks up where it really was rather than
      // from a file the fixture deleted.
      const saved = fs.readFileSync(state, 'utf8');
      fs.rmSync(blocker, { recursive: true, force: true });
      fs.writeFileSync(blocker, 'not a directory', 'utf8');
      try {
        const verdicts = [];
        for (let i = 0; i < 4; i += 1) {
          verdicts.push(run('const v = guard.reserve(); '
            + 'process.stdout.write(v.allowed + "|" + v.reason)'));
        }
        const granted = verdicts.filter((v) => v.startsWith('true')).length;
        ck('AN UNWRITABLE STATE FILE REFUSES, it does not grant for ever',
          granted === 0, verdicts);
        ck('and the refusal names the path rather than blaming the broker',
          verdicts[0].includes(state), verdicts[0]);
        ck('and says what to do about it',
          /writable/.test(verdicts[0]), verdicts[0]);
        ck('specifically it does NOT report a budget that looks fine',
          !/attempt 1 of 2/.test(verdicts[0]), verdicts[0]);
      } finally {
        fs.rmSync(blocker, { force: true });
        fs.mkdirSync(blocker, { recursive: true });
        fs.writeFileSync(state, saved, 'utf8');
      }

      // Writable again: normal service resumes, and the earlier attempt stands.
      ck('once writable again the budget resumes from where it really was',
        run('process.stdout.write(String(guard.summary().attemptsUsed))') === '1');

      fs.rmSync(dir, { recursive: true, force: true });
    }

    // ── and the write path reports whether it landed ───────────────────────
    {
      const src = fs.readFileSync(path.join(REPO, 'src/scrapers/loginGuard.js'), 'utf8');
      const live = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      ck('write() returns true only on success', /return true;/.test(live));
      ck('and false when it could not persist', /return false;/.test(live));
      ck('reserve() checks it', /if \(!write\(st\)\)/.test(live));
      ck('and a lockout that could not be persisted is reported separately',
        /LOCKOUT COULD NOT BE PERSISTED/.test(src));
    }
  } catch (e) {
    ck('the suite ran without throwing', false, e.message);
  }

  await close();
  console.log(`\nslot address space: ${p}/${n}`);
  process.exit(p === n ? 0 : 1);
})();

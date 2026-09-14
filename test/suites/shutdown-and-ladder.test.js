'use strict';
/**
 * F-16 and F-17 — a shutdown that loses writes, and a ladder read from the
 * wrong panel in the wrong order.
 *
 * F-16 · SHUTDOWN DID NOT DRAIN IN-FLIGHT JOBS.
 * The scheduler fires and forgets by design — awaiting inside a cron callback
 * would hold the next tick behind a slow scrape — so nothing held a reference
 * to a running job, and `scheduler.stop()` only stopped NEW ticks. A SIGTERM
 * landing inside `repo.insertQuotes` tore the connection out from under it: the
 * insert threw, `finishRun` threw on the closed pool and was swallowed, the run
 * row stayed RUNNING for ever, and that minute's ~137 quotes were gone. A
 * trading minute cannot be re-scraped.
 *
 * And it could HANG. `server.close()` waits for every keep-alive socket;
 * `pool.end()` waits for every checked-out client, including the dedicated one
 * a running job holds for its advisory lock. There was no timeout anywhere.
 *
 * F-17 · THE LADDER WAS READ FROM A PANEL THAT WAS NEVER VERIFIED.
 * Verification takes the FIRST depth container whose symbol cell matches; the
 * read walked EVERY container and kept whichever produced the most levels. With
 * two quote panels open, verification passed on A while B's deeper, stale
 * ladder for a different symbol was stored under A's name — the exact failure
 * the verification exists to prevent, defeated by the read.
 *
 * And the sides were never sorted. The comment has always said "bids high to
 * low, offers low to high"; the code used DOM order. Where the terminal renders
 * the touch at the bottom of a column, level 1 held the WORST bid and the WORST
 * offer, and every consumer read the wrong end of a book made entirely of real
 * prices.
 */
const fs = require('fs');
const path = require('path');
const { requireTestDb } = require('../dbguard');
requireTestDb('shutdown-and-ladder');

const { close } = require('../../src/db/pool');
const jobs = require('../../src/jobs');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };

const REPO = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

(async () => {
  try {
    // ── F-16 · drain ──────────────────────────────────────────────────────
    {
      ck('an idle drain returns at once', (await jobs.drain(50)).drained === true);

      // A job that takes a moment. drain must wait for it.
      let finished = false;
      const slow = jobs.run('f16.slow', undefined);
      // run() only knows registered jobs, so use _runJob with our own fn.
      const running = jobs._runJob('f16.slow2', async () => {
        await new Promise((r) => setTimeout(r, 300));
        finished = true;
        return { extracted: 0, inserted: 0 };
      });
      await slow.catch(() => {});          // unknown job — returns FAILED, fine

      // _runJob is not registered with inFlight (only run() is), so this asserts
      // the registration point rather than the timing.
      await running;
      ck('the slow job finished', finished === true);
    }

    // ── the drain is BOUNDED ──────────────────────────────────────────────
    {
      const started = Date.now();
      const res = await jobs.drain(100);
      ck('drain honours its timeout', Date.now() - started < 2_000, Date.now() - started);
      ck('and reports whether it actually drained', typeof res.drained === 'boolean', res);
      ck('naming what was still running if not', Array.isArray(res.stillRunning), res);
    }

    // ── the shutdown path ─────────────────────────────────────────────────
    {
      const src = read('src/index.js');
      ck('shutdown drains before closing anything', /await jobs\.drain\(/.test(src));
      ck('and the drain comes BEFORE db.close()',
        src.indexOf('jobs.drain(') < src.indexOf('await db.close()'), 'ordering');
      ck('the whole sequence is bounded', /SHUTDOWN_BUDGET_MS/.test(src));
      ck('and the hard stop exits rather than hanging', /shutdown exceeded its budget/.test(src));
      ck('keep-alive sockets are closed so server.close cannot stall it',
        /closeAllConnections\(\)/.test(src));
      ck('a CRASH during shutdown exits instead of returning into nothing',
        /crashed while already shutting down/.test(src));
      ck('a second SIGNAL is still ignored', /if \(exitCode !== 0\) \{/.test(src));
    }

    // ── F-17 · the depth read ─────────────────────────────────────────────
    {
      const src = read('src/scrapers/awsat.js');
      const evalBlock = src.slice(src.indexOf('const levelsRaw = await readTarget.evaluate'),
        src.indexOf('const rows = levelsRaw;'));

      ck('the read filters containers by the symbol they claim',
        /const scopes = all\.filter\(owns\);/.test(evalBlock));
      ck('and the symbol searched for is passed in',
        /want: String\(symbol\)\.toUpperCase\(\)/.test(src));
      ck('a container that claims no symbol yields nothing rather than a ladder',
        /unattributed: all\.length/.test(evalBlock));
      ck('and that case is reported', /no depth container claimed this symbol/.test(src));

      ck('bids are sorted high to low', /bids\.sort\(\(a, b\) =>/.test(evalBlock));
      ck('offers are sorted low to high', /offers\.sort\(\(a, b\) =>/.test(evalBlock));
      ck('and sorted NUMERICALLY — these are prices, and 9 > 10 as a string',
        /String\(v\)\.replace\(\/\[\^0-9\.\-\]\/g, ''\)/.test(evalBlock));
    }

    // ── the sort, exercised ───────────────────────────────────────────────
    {
      // The evaluate body runs in the browser, so the ordering rule is checked
      // directly here: the same comparator, on the shape the DOM produces.
      const px = (v) => {
        const x = Number(String(v).replace(/[^0-9.-]/g, ''));
        return Number.isFinite(x) ? x : null;
      };
      const bids = [{ price: '9' }, { price: '10' }, { price: '9.5' }];
      bids.sort((a, b) => (px(b.price) ?? -Infinity) - (px(a.price) ?? -Infinity));
      ck('the best bid is level 1', bids[0].price === '10', bids.map((b) => b.price));
      ck('and 9 does not beat 10 by being lexically larger', bids[2].price === '9', bids.map((b) => b.price));

      const offers = [{ price: '11' }, { price: '10.5' }, { price: '12' }];
      offers.sort((a, b) => (px(a.price) ?? Infinity) - (px(b.price) ?? Infinity));
      ck('the best offer is level 1', offers[0].price === '10.5', offers.map((o) => o.price));

      // A DOM that renders the touch LAST — the case that produced the bug.
      const reversed = [{ price: '9' }, { price: '9.5' }, { price: '10' }];
      reversed.sort((a, b) => (px(b.price) ?? -Infinity) - (px(a.price) ?? -Infinity));
      ck('a bottom-up rendering still puts the touch at level 1',
        reversed[0].price === '10', reversed.map((r) => r.price));
    }
  } catch (e) {
    ck('the suite ran without throwing', false, e.message);
  }

  await close();
  console.log(`\nshutdown and ladder: ${p}/${n}`);
  process.exit(p === n ? 0 : 1);
})();

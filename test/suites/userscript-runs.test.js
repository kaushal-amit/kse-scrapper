// EXECUTE the userscripts. Do not merely parse them.
//
// Two shipped with a function that was called and never written — ladderSweep
// in the depth script, expectedRowCount in the orders one. Both threw at
// runtime, nothing caught it, and each panel kept showing its INITIAL message
// while the grid was full. `node --check` passes on both: a missing function is
// a runtime error, not a syntax one.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, JSON.stringify(x)); };
const DIR = path.join(__dirname, '../../userscript');

/** Load a script into a DOM and report anything it throws. */
function run(file, html, ms = 9000) {
  return new Promise((resolve) => {
    const dom = new JSDOM(`<body>${html}</body>`,
      { url: 'https://www.awsatbroker.com/', pretendToBeVisual: true });
    const w = dom.window;
    const errors = [];
    let posted = null;

    /*
     * ─── A MID-SESSION CLOCK, SUPPLIED ──────────────────────────────────────
     *
     * The capture scripts refuse to capture outside 08:40-13:20 Kuwait. With
     * the real clock this suite would pass only between those hours and fail
     * the rest of the day — a time-of-day-dependent gate, which is the class
     * of flake this repository keeps removing. 10:00 Kuwait on Thursday 24
     * September 2026, frozen, so the script's own guard is satisfied for a
     * reason the test states rather than for the hour it happens to run at.
     *
     * test/suites/capture-window.test.js is where the guard's boundaries are
     * asserted; here it is scenery.
     */
    const MID_SESSION = Date.UTC(2026, 8, 24, 7, 0, 0);   // 10:00 Kuwait
    const RealDate = w.Date;
    class FrozenDate extends RealDate {
      constructor(...args) { super(...(args.length ? args : [MID_SESSION])); }
      static now() { return MID_SESSION; }
    }
    w.Date = FrozenDate;
    w.crypto = { randomUUID: () => 'test-uuid' };
    w.fetch = (url, opts) => {
      if (/\/orders|\/quotes|\/depth|\/market-summary/.test(url)) {
        posted = { url, body: opts && opts.body ? JSON.parse(opts.body) : null };
      }
      return Promise.resolve({ ok: true, status: 200,
        json: () => Promise.resolve({ inserted: 1, symbols: [] }) });
    };

    const src = fs.readFileSync(path.join(DIR, file), 'utf8');
    const origTimeout = setTimeout;
    const guard = (fn, d) => origTimeout(() => { try { fn(); } catch (e) { errors.push(e.message); } }, d);
    const guardInterval = (fn, d) => setInterval(() => { try { fn(); } catch (e) { errors.push(e.message); } }, d);

    try {
      new Function('window', 'document', 'fetch', 'crypto', 'setTimeout', 'setInterval',
        // `Date` is INJECTED, not taken from the realm: the script reads the
        // clock to decide whether it is inside the capture window, and without
        // this it would read the machine's.
        'clearInterval', 'MouseEvent', 'KeyboardEvent', 'Event', 'Date', src)
        (w, w.document, w.fetch, w.crypto, guard, guardInterval,
          clearInterval, w.MouseEvent, w.KeyboardEvent, w.Event, FrozenDate);
    } catch (e) {
      errors.push('threw on load: ' + e.message);
    }

    origTimeout(() => {
      const panel = w.document.body.querySelector('div[style*="2147483647"]');
      resolve({
        errors,
        posted,
        panel: panel ? panel.textContent.replace(/\s+/g, ' ') : null,
      });
    }, ms);
  });
}

(async () => {
  const grid = fs.readFileSync(path.join(__dirname, '../fixtures/order-list.html'), 'utf8');

  // ── every script LOADS without throwing ──
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.user.js'))) {
    const r = await run(f, f === 'awsat-orders.user.js' ? grid : '<div></div>', 3000);
    ck(`${f} runs without a ReferenceError`,
       !r.errors.some((e) => /is not defined/.test(e)),
       r.errors.filter((e) => /is not defined/.test(e)));
    ck(`${f} renders its panel`, !!r.panel, r.panel);
  }

  // ── the orders script actually READS AND POSTS ──
  const o = await run('awsat-orders.user.js', grid, 9000);
  ck('it posts', !!o.posted, o.panel);
  ck('the panel says it sent something', /sent \d+/.test(o.panel || ''), o.panel);
  ck('and NOT "waiting for the order list"',
     !/waiting for the order list/.test(o.panel || ''), o.panel);

  const first = o.posted && o.posted.body.orders && o.posted.body.orders[0];
  ck('two orders were read', o.posted && o.posted.body.orders.length === 2,
     o.posted && o.posted.body.orders.length);
  ck('the order id survives', first && first.orderId === '26083167883', first && first.orderId);
  ck('the symbol is split from "CATTL - 701"', first && first.symbol === 'CATTL', first && first.symbol);

  // THE FIELDS THAT WERE NULL FOR THREE SESSIONS
  ck('ordVal is sent — it was read and dropped one line before the POST',
     first && first.ordVal === 687.6, first && first.ordVal);
  ck('netOrdVal is sent — this is what fee reconciliation matches on',
     first && first.netOrdVal === 685.627, first && first.netOrdVal);
  ck('avgPrice too', first && first.avgPrice === 191, first && first.avgPrice);

  console.log(`\nuserscripts run: ${p}/${n}`);
  process.exit(p === n ? 0 : 1);
})();

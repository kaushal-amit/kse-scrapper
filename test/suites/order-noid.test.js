// C1 · the Order List grid lost its clOrdId column on 2 Sep, and the userscript
// kept a row only `if (rec.orderId)` — so every row was dropped and orders went
// silent for six sessions. This RUNS the shipped userscript against the live
// no-id DOM and proves it now captures rows via a synthesised, stable id.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, JSON.stringify(x)); };
const DIR = path.join(__dirname, '../../userscript');

function run(file, html, ms = 9000) {
  return new Promise((resolve) => {
    const dom = new JSDOM(`<body>${html}</body>`,
      { url: 'https://www.awsatbroker.com/', pretendToBeVisual: true });
    const w = dom.window;
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
      if (/\/ingest\/orders/.test(url)) posted = { url, body: opts && opts.body ? JSON.parse(opts.body) : null };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ inserted: 1 }) });
    };
    const src = fs.readFileSync(path.join(DIR, file), 'utf8');
    const origTimeout = setTimeout;
    const guard = (fn, d) => origTimeout(() => { try { fn(); } catch (e) {} }, d);
    const guardInterval = (fn, d) => setInterval(() => { try { fn(); } catch (e) {} }, d);
    try {
      new Function('window', 'document', 'fetch', 'crypto', 'setTimeout', 'setInterval',
        // `Date` is INJECTED, not taken from the realm: the script reads the
        // clock to decide whether it is inside the capture window, and without
        // this it would read the machine's.
        'clearInterval', 'MouseEvent', 'KeyboardEvent', 'Event', 'Date', src)
        (w, w.document, w.fetch, w.crypto, guard, guardInterval, clearInterval, w.MouseEvent, w.KeyboardEvent, w.Event, FrozenDate);
    } catch (e) {}
    origTimeout(() => {
      const panel = w.document.body.querySelector('div[style*="2147483647"]');
      resolve({ posted, panel: panel ? panel.textContent.replace(/\s+/g, ' ') : null });
    }, ms);
  });
}

(async () => {
  const grid = fs.readFileSync(path.join(__dirname, '../fixtures/order-list-noid.html'), 'utf8');
  const o = await run('awsat-orders.user.js', grid, 9000);
  const orders = (o.posted && o.posted.body && o.posted.body.orders) || [];

  ck('it posts on a grid with no id column', !!o.posted, o.panel);
  ck('all three rows are captured (were 0 before the fix)', orders.length === 3, orders.length);
  ck('every id is synthetic', orders.length === 3 && orders.every((r) => r.synthetic === true && /^syn:/.test(r.orderId)),
     orders.map((r) => r.orderId));
  ck('the synthetic ids are distinct', new Set(orders.map((r) => r.orderId)).size === orders.length,
     orders.map((r) => r.orderId));

  const buy = orders.find((r) => r.side === 'Buy');
  ck('the buy fill is read', buy && buy.symbol === 'EQUIPMENT' && buy.quantity === 3500 && buy.price === 188, buy);
  ck('  and its net value survives (fee reconciliation matches on it)', buy && buy.netOrdVal === 659.487, buy && buy.netOrdVal);

  const sells = orders.filter((r) => r.side === 'Sell');
  ck('both sells are read, one filled one cancelled', sells.length === 2
     && sells.some((r) => r.status === 'Filled') && sells.some((r) => r.status === 'Cancelled'), sells.map((r) => r.status));

  /*
   * 2.8.0 · the key is SYMBOL · SIDE · STAMP. Price and quantity were in it and
   * are gone, because they are exactly what an AMEND changes: amending a
   * resting order used to change its synthetic id, so the server saw one id
   * stop being reported and another appear — one order abandoned mid-life and
   * another born at the amended price, two rows where the trader has one. The
   * abandoned one then read UNSEEN and stopped protecting its slot while still
   * live.
   */
  ck('the same order yields the SAME id on a second read (stable → de-duped)',
     (() => { const first = orders.find((r) => r.status === 'Cancelled');
       return first && first.orderId === 'syn:EQUIPMENT|Sell|08-09-202610:42:39'; })(),
     orders.find((r) => r.status === 'Cancelled') && orders.find((r) => r.status === 'Cancelled').orderId);

  ck('the id carries NO price — an amend must keep its id',
     orders.every((r) => !/\|187\||\|188\|/.test(r.orderId)), orders.map((r) => r.orderId));
  ck('and no quantity either',
     orders.every((r) => !/3,310|3,500/.test(r.orderId)), orders.map((r) => r.orderId));

  ck('the panel does not read "empty"', !/active and empty|waiting for the order list/.test(o.panel || ''), o.panel);

  console.log(`\norder no-id capture: ${p}/${n}`);
  process.exit(p === n ? 0 : 1);
})();

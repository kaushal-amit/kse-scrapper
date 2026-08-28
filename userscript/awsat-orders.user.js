// ==UserScript==
// @name         awsat / DirectFN — Order List → Server 1
// @namespace    local.trading.tools
// @version      2.0.0
// @description  Reads the Order List grid by cell-id and posts it to Server 1. No credentials leave the browser.
// @match        *://*.awsatbroker.com/*
// @match        *://awsatbroker.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/**
 * The Order List is an Ember grid read BY cell-id, never by column position.
 *
 * It splits into a left block holding the symbol and a right block holding
 * everything else, and the two halves of one row share an inline `top:Npx`.
 * That is the join key. A positional reader put a company name in order_id and
 * a price in symbol — every row looked valid and all of it was wrong.
 *
 * Some columns are scrolled out of view horizontally but still present in the
 * DOM, so every cell-id is collected regardless of visibility.
 */
(function () {
  'use strict';

  var SERVER = 'http://localhost:8787';   // Server 1
  var TOKEN  = 'CHANGE-ME';               // must equal INGEST_TOKEN
  var EVERY_MS = 60 * 1000;
  var MAX_RETRY_QUEUE = 30;

  var CELL_MAP = {
    'symbolInfo.dispProp1': 'symbolRaw',
    clOrdId:  'orderId',
    ordSts:   'status',
    ordSide:  'side',
    ordQty:   'quantity',
    price:    'price',
    cumQty:   'filled',
    pendQty:  'remaining',
    adjustedCrdDte: 'stamp',
    // THE MONEY COLUMNS. All three are in the grid already; the old extractor
    // simply did not map them, so the P&L had to be rebuilt by hand.
    avgPrice:   'avgPrice',
    ordVal:     'ordVal',
    netOrdVal:  'netOrdVal',     // <- this one IS the P&L
    // Present in the grid, and columns exist for them since migration 020.
    // The MIGRATION fills these from history; without capturing them here,
    // today's rows would be poorer than the ones we imported — the newest data
    // the thinnest, which is exactly backwards.
    ordTyp:     'orderType',     // Limit or Market. SPREAD never crosses the
                                 // spread, so a Market fill is outside the
                                 // strategy, not a data point within it.
    exg:        'exchange',
  };

  var retryQueue = [];
  var stats = { posts: 0, lastCount: 0, queued: 0, msg: 'waiting for the order list…',
    scrollNote: '', expected: null, shortBy: 0 };

  function uuid() {
    return (crypto && crypto.randomUUID) ? crypto.randomUUID()
      : 'o-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }
  function clean(t) {
    return (t || '').replace(/[\u202A\u202B\u202C\u200E\u200F]/g, '').replace(/\s+/g, ' ').trim();
  }
  function num(v) {
    if (v === null || v === undefined) return null;
    var s = String(v).replace(/\u2212/g, '-').replace(/,/g, '').replace(/\s/g, '');
    if (!s || !/\d/.test(s)) return null;
    var n = parseFloat(s);
    return isNaN(n) ? null : n;
  }

  /**
   * The widget, AND confirmation that the Order List tab is the active one.
   *
   * Order List and Order Search are tabs of the SAME widget — id="orderList-…"
   * matches either. Reading whichever grid happens to be showing means Order
   * Search data silently arrives labelled as the order list, and an unopened
   * tab reads as "empty" when orders plainly exist.
   *
   * @returns {{widget: Element|null, activeTab: string|null}}
   */
  /** The account the Order List is showing, from its Portfolio dropdown. */
  function portfolioOf(widget) {
    if (!widget) return null;
    var el = widget.querySelector('[title="Portfolio"] .ellipsis');
    var t = el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '';
    return /^\d{4,}$/.test(t) ? t : null;
  }

  function ordersWidget() {
    var widgets = document.querySelectorAll('div[id^="orderList-"]');

    for (var i = 0; i < widgets.length; i++) {
      var w = widgets[i];
      var active = w.querySelector('.wdgttl-tab-item.active span');
      var label = active ? (active.textContent || '').replace(/\s+/g, ' ').trim() : null;
      if (label && /^order list$/i.test(label)) return { widget: w, activeTab: label };
    }

    // No widget is on the Order List tab. Report which tab IS active, so the
    // answer is "switch the tab", not "the scraper is broken".
    for (var j = 0; j < widgets.length; j++) {
      var a = widgets[j].querySelector('.wdgttl-tab-item.active span');
      if (a) {
        return { widget: null, activeTab: (a.textContent || '').replace(/\s+/g, ' ').trim() };
      }
    }
    return { widget: null, activeTab: null };
  }

  /**
   * The element that scrolls the grid.
   *
   * The rows are virtualised: the container is 350px of content in a 220px
   * viewport, so only about nine rows exist in the DOM at any moment. Without
   * scrolling, a trader with twenty orders has eleven of them invisible to the
   * scraper — and the capture looks complete.
   */
  function bodyScroller(body) {
    var inner = body.querySelector('.antiscroll-inner');
    if (inner && inner.scrollHeight > inner.clientHeight + 4) return inner;

    var els = body.querySelectorAll('*'), best = null;
    for (var i = 0; i < els.length; i++) {
      var e = els[i];
      if (e.scrollHeight > e.clientHeight + 8 && e.clientHeight > 40) {
        if (!best || e.clientHeight > best.clientHeight) best = e;
      }
    }
    if (best) return best;
    return (body.scrollHeight > body.clientHeight + 4) ? body : null;
  }

  /** Parse whatever rows are rendered right now. */
  function readRenderedRows(body) {
    var buckets = new Map();
    body.querySelectorAll('.ember-table-table-row').forEach(function (row) {
      if (String(row.className).indexOf('header-row') >= 0) return;
      var m = (row.getAttribute('style') || '').match(/top:\s*(-?[\d.]+)px/);
      var key = m ? 'T' + Math.round(parseFloat(m[1]))
                  : 'R' + Math.round(row.getBoundingClientRect().top);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(row);
    });

    var out = [];
    buckets.forEach(function (halves) {
      var rec = {}, hits = 0;
      halves.forEach(function (row) {
        row.querySelectorAll('[cell-id]').forEach(function (cell) {
          var id = cell.getAttribute('cell-id');
          var text = clean(cell.textContent);
          var title = clean(cell.getAttribute('title'));
          // Prefer the TITLE: the cell text is truncated with an ellipsis when
          // the column is narrow, and a truncated order id is a different id.
          var value = title || text;
          if (!value) return;
          if (id === 'ordSts' && title && title !== text) rec.statusReason = title;
          var field = CELL_MAP[id];
          if (field && rec[field] == null) { rec[field] = value; hits++; }
        });
      });
      if (hits && rec.orderId) out.push(rec);
    });
    return out;
  }

  /**
   * The tallest scrollable ancestor inside the grid, and how far it can go.
   *
   * Returned together because "which element scrolls" and "did scrolling do
   * anything" have to be answered about the SAME element — checking one and
   * scrolling another is how a grid appears unscrollable while rows are
   * plainly hidden.
   */
  function scrollTargets(body) {
    var out = [];
    var inner = body.querySelector('.antiscroll-inner');
    if (inner) out.push(inner);
    var els = body.querySelectorAll('*');
    for (var i = 0; i < els.length; i++) {
      var e = els[i];
      if (e !== inner && e.scrollHeight > e.clientHeight + 4) out.push(e);
    }
    if (body.scrollHeight > body.clientHeight + 4) out.push(body);
    return out;
  }

  /**
   * Read every row, scrolling through the virtualised grid.
   *
   * ─── WHY IT STEPS BY ROWS, NOT BY SCREENFULS ───────────────────────────
   * The grid renders ~10 rows for a 220px viewport over 350px of content. A
   * step of 0.8 x viewport (176px) gives only two scroll positions and under
   * two rows of overlap — and if Ember has not finished re-rendering when the
   * read runs, the second position contributes nothing. That is how 13 orders
   * became 10.
   *
   * So: step by a couple of ROW HEIGHTS, which guarantees overlap between
   * consecutive windows, and stop when several steps in a row produce no new
   * order id — not merely when the scrollbar reaches the bottom. Reaching the
   * bottom says where the scrollbar is; finding nothing new says the work is
   * actually done.
   */
  function readOrders(done) {
    var found = ordersWidget();
    if (!found.widget) {
      return done(null, found.activeTab
        ? 'the "' + found.activeTab + '" tab is active — switch to Order List'
        : 'Order List widget not on screen');
    }

    var body = found.widget.querySelector('.ember-table-body-container')
            || found.widget.querySelector('.ember-table-tables-container')
            || found.widget;

    var byId = new Map();
    function collect() {
      var before = byId.size;
      readRenderedRows(body).forEach(function (r) {
        if (!byId.has(r.orderId)) byId.set(r.orderId, r);
      });
      return byId.size - before;      // how many NEW ones this window gave
    }

    collect();

    var targets = scrollTargets(body);
    if (!targets.length) {
      stats.scrollNote = 'grid does not scroll — ' + byId.size + ' row(s) visible';
      return done([...byId.values()], null);
    }

    // Row height from the DOM, so a layout change does not silently break the
    // step size. Two rows per step keeps a large overlap.
    var firstRow = body.querySelector('.ember-table-table-row');
    var rowH = (firstRow && firstRow.getBoundingClientRect().height) || 25;
    var step = Math.max(20, Math.round(rowH * 2));

    var restore = targets.map(function (t) { return t.scrollTop; });
    targets.forEach(function (t) { t.scrollTop = 0; });

    var barren = 0;     // consecutive steps with nothing new
    var guard = 0;

    setTimeout(function tick() {
      // TWO reads per position, not one.
      //
      // The window re-renders asynchronously, so the first read after a scroll
      // can still be the previous window. Counting that as "nothing new" ends
      // the scan three positions later while rows remain unvisited — which is
      // how a 137-row list stopped at 10.
      var added = collect();
      if (!added) added = collect();
      barren = added ? 0 : barren + 1;

      var atEnd = targets.every(function (t) {
        return t.scrollTop + t.clientHeight >= t.scrollHeight - 2;
      });

      // Stop on EVIDENCE: three barren steps once at the bottom, or a hard cap.
      if ((atEnd && barren >= 3) || guard++ > 120) {
        targets.forEach(function (t, i) { t.scrollTop = restore[i]; });
        var expected = expectedRowCount(body);
        stats.expected = expected;
        stats.scrollNote = byId.size + ' row(s) over ' + guard + ' step(s)'
          + (expected != null ? ' · grid says ' + expected : '');

        // ALARM on a mismatch. Five contracts read as three all morning because
        // a short capture is indistinguishable from a short list.
        if (expected != null && byId.size < expected) {
          stats.shortBy = expected - byId.size;
          stats.msg = 'CAPTURED ' + byId.size + ' OF ' + expected
            + ' — ' + stats.shortBy + ' order(s) missed';
          try {
            console.warn('[orders] captured ' + byId.size + ' of ' + expected
              + ' rows the grid reports', { seen: [...byId.keys()] });
          } catch (e) {}
        } else {
          stats.shortBy = 0;
        }
        // One last read after restoring, in case the restore itself renders a
        // window that was never visited on the way down.
        setTimeout(function () { collect(); done([...byId.values()], null); }, 150);
        return;
      }

      targets.forEach(function (t) { t.scrollTop = t.scrollTop + step; });
      // 250ms: Ember re-renders the window asynchronously, and reading before
      // it has is exactly what made the second position contribute nothing.
      setTimeout(tick, 250);
    }, 250);
  }

  function toPayload(rec) {
    var sym = (rec.symbolRaw || '').split(/\s*-\s*/)[0].trim().toUpperCase() || null;
    var q = num(rec.quantity), f = num(rec.filled);
    return {
      orderId: rec.orderId,
      symbol: sym,
      side: rec.side,
      status: rec.status,
      price: num(rec.price),
      quantity: q,
      filled: f,
      remaining: num(rec.remaining),
      avgPrice: num(rec.avgPrice),
      ordVal: num(rec.ordVal),
      netOrdVal: num(rec.netOrdVal),
      statusReason: rec.statusReason || null,
      orderType: rec.orderType || null,
      exchange: rec.exchange || null,
      // The account, read from the widget's own dropdown rather than a cell.
      portfolio: portfolioOf(ordersWidget().widget) || null,
      // The whole record, so a field nobody mapped yet is still captured.
      // netOrdVal was exactly such a field.
      raw: rec,
    };
  }

  function submit(batch) {
    return fetch(SERVER + '/ingest/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify(batch),
    }).then(function (r) {
      // 409 means the server is in server mode and is not accepting client
      // data. Retrying forever would fill the queue; this is a configuration
      // answer, not a transient one.
      if (r.status === 409) {
        return r.json().then(function (j) {
          throw Object.assign(new Error(j.error || 'server not in client mode'), { permanent: true });
        });
      }
      if (r.status >= 400 && r.status < 500 && r.status !== 401) {
        throw Object.assign(new Error('HTTP ' + r.status), { permanent: true });
      }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function flush() {
    if (!retryQueue.length) return Promise.resolve();
    return submit(retryQueue[0]).then(function () {
      retryQueue.shift(); stats.queued = retryQueue.length; return flush();
    }).catch(function (e) {
      if (e.permanent) { retryQueue.shift(); stats.queued = retryQueue.length; }
    });
  }

  function tick() {
    flush();

    readOrders(function (rows, problem) {
      if (problem) { stats.msg = problem; return; }

      if (!rows.length) {
        // A trader with no live orders is a normal state, not a failure.
        stats.lastCount = 0;
        stats.msg = 'Order List tab is active and empty';
        return;
      }

      // batchId is created ONCE and kept across retries; regenerating it would
      // make every retry look like new data and defeat server-side idempotency.
      var batch = {
        batchId: uuid(),
        capturedAt: new Date().toISOString(),
        orders: rows.map(toPayload),
      };

      submit(batch).then(function (j) {
        stats.posts++; stats.lastCount = rows.length;
        stats.msg = 'sent ' + rows.length + ' → inserted ' + (j.inserted != null ? j.inserted : '?')
          + (j.duplicate ? ' (duplicate replayed)' : '')
          + (j.rejected ? ', rejected ' + j.rejected : '');
      }).catch(function (e) {
        if (!e.permanent) {
          if (retryQueue.length >= MAX_RETRY_QUEUE) retryQueue.shift();
          retryQueue.push(batch); stats.queued = retryQueue.length;
          stats.msg = 'failed: ' + e.message + ' — queued';
        } else {
          stats.msg = 'not sent: ' + e.message;
        }
      });
    });
  }

  setTimeout(function () { tick(); setInterval(tick, EVERY_MS); }, 6000);

  // ── panel ─────────────────────────────────────────────────────────────────
  var panel, pre;
  function ensurePanel() {
    if (panel || !document.body) return;
    panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;z-index:2147483647;left:10px;bottom:10px;width:320px;'
      + 'background:#1e1b4b;color:#c7d2fe;font:12px/1.45 monospace;border:1px solid #4f46e5;'
      + 'border-radius:10px;padding:10px;';
    var h = document.createElement('div');
    h.style.cssText = 'font-weight:700;margin-bottom:6px;';
    h.textContent = 'Order List → Server 1';
    panel.appendChild(h);
    pre = document.createElement('div'); panel.appendChild(pre);

    var b = document.createElement('button');
    b.textContent = 'Send now';
    b.style.cssText = 'margin-top:8px;background:#4f46e5;color:#fff;border:0;border-radius:6px;'
      + 'padding:4px 8px;font:11px monospace;cursor:pointer;';
    b.onclick = tick;
    panel.appendChild(b);
    document.body.appendChild(panel);
  }
  function refresh() {
    ensurePanel();
    if (!pre) return;
    pre.innerHTML = 'posts: <b>' + stats.posts + '</b> &nbsp; last batch: <b>'
      + stats.lastCount + '</b><br>'
      + (stats.scrollNote ? 'scan: ' + stats.scrollNote + '<br>' : '')
      + (stats.shortBy ? '<b style="color:#fca5a5">SHORT BY ' + stats.shortBy + '</b><br>' : '')
      + 'retry queue: ' + stats.queued + '<br>· ' + stats.msg;
  }
  setInterval(refresh, 1500);
  refresh();
})();

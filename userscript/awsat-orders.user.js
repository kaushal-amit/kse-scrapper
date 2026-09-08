// ==UserScript==
// @name         awsat / DirectFN — Order List → Server 1
// @namespace    local.trading.tools
// @version      2.3.0
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

  /**
   * The running build, shown on the panel.
   *
   * Two scripts both reported @version 2.0.0 — one with the money fields and
   * the iframe walk, one without. Tampermonkey showed the same string for
   * each, so a session went into diagnosing a bug that was already fixed.
   * A build that cannot identify itself is a build nobody can debug.
   */
  var VERSION = '2.3.0';

  var SERVER = 'https://scrapper.99labs.space';   // Server 1
  var TOKEN  = 'CHANGE-ME';               // must equal INGEST_TOKEN
  var EVERY_MS = 60 * 1000;
  var MAX_RETRY_QUEUE = 30;

  /**
   * cell-id -> field. Several ids map to `orderId` because the grid has not
   * used one consistently: order_list_snapshots carries the id under
   * clOrdId on some rows and nowhere at all on 12,482 of 13,465.
   *
   * Listing the alternatives is cheaper than guessing which is current, and
   * UNMAPPED_SEEN below reports any id we still do not know.
   */
  var CELL_MAP = {
    'symbolInfo.dispProp1': 'symbolRaw',
    'symbolInfo.sDes': 'symbolRaw',
    'symbolInfo.sDesc': 'symbolRaw',      // a third spelling, seen in the wild
    clOrdId:  'orderId',
    orderId:  'orderId',
    ordId:    'orderId',
    orderID:  'orderId',
    ordNo:    'orderId',
    orderNo:  'orderId',
    ordSts:   'status',
    status:   'status',
    ordSide:  'side',
    side:     'side',
    ordQty:   'quantity',
    qty:      'quantity',
    price:    'price',
    cumQty:   'filled',
    filled:   'filled',
    pendQty:  'remaining',
    remaining: 'remaining',
    adjustedCrdDte: 'stamp',
    adjustedExpTime: 'expiry',
    ordTyp:   'orderType',
    exg:      'exchange',
    code:     'code',

    // ─── THE MONEY FIELDS ────────────────────────────────────────────────
    // Present on every row of the grid, and absent from this map — so the
    // script read them and threw them away. netOrdVal is the P&L: it is why
    // net_value was NULL on 20 of 23 migrated orders and would have stayed
    // NULL on every new one.
    avgPrice:  'avgPrice',
    ordVal:    'orderValue',
    netOrdVal: 'netValue',
  };

  /** Every cell-id seen that CELL_MAP does not know. Reported, then dumped. */
  var unmappedSeen = {};
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

  /**
   * Every document on the page, the terminal's frames included.
   *
   * ─── WHY THIS EXISTS ──────────────────────────────────────────────────────
   * document.querySelectorAll does not cross an iframe boundary. The widget
   * renders inside a frame on the terminal page and directly in the document
   * when popped out into its own tab — so a lookup that only searched the top
   * document found it in one place and reported "waiting for the order list"
   * in the other, with three orders on screen.
   *
   * The depth and market-summary scripts have always walked frames. This one
   * never did.
   */
  function collectDocs(doc, acc) {
    acc.push(doc);
    var frames = doc.querySelectorAll('iframe, frame');
    for (var i = 0; i < frames.length; i++) {
      // Cross-origin frames throw on access. Skipping them is correct: the
      // terminal's own frames are same-origin.
      try { if (frames[i].contentDocument) collectDocs(frames[i].contentDocument, acc); } catch (e) {}
    }
    return acc;
  }

  /**
   * The Order List widget.
   *
   * ─── NO TAB CHECK ─────────────────────────────────────────────────────────
   * An earlier version refused unless it could also prove the Order List tab
   * was active, by reading `.wdgttl-tab-item.active span`. That markup differs
   * between the embedded widget and the popped-out window, so the check failed
   * on the terminal, the lookup returned null, and the panel read "waiting for
   * the order list" with three orders on screen.
   *
   * The version that ran for months has no such check: take the widget and
   * read it. If the grid holds no order rows the reader returns nothing, which
   * is the same outcome without a guard that can be wrong.
   *
   * Two lookups, in order:
   *   1. the widget by id
   *   2. any clOrdId cell, climbing to its container — which finds the grid
   *      even if the widget id is renamed
   *
   * Both run across every reachable frame, because the widget renders inside
   * one on the terminal page and directly in the document when popped out.
   */
  function ordersWidget() {
    var docs = collectDocs(document, []);

    for (var d = 0; d < docs.length; d++) {
      var w = docs[d].querySelector('div[id^="orderList-"]');
      if (w) {
        var active = w.querySelector('.wdgttl-tab-item.active span');
        // Reported, never enforced: useful in the panel, and not a reason to
        // refuse to read a grid that is right there.
        return { widget: w, activeTab: active ? clean(active.textContent) : null, problem: null };
      }
    }

    for (var d2 = 0; d2 < docs.length; d2++) {
      var c = docs[d2].querySelector('[cell-id="clOrdId"]');
      if (c) {
        var host = c.closest('.widget_new') || c.closest('.ember-table-tables-container');
        if (host) {
          return {
            widget: host, activeTab: null, problem: null,
            note: 'found by a clOrdId cell — the widget id prefix has changed',
          };
        }
      }
    }

    return {
      widget: null,
      activeTab: null,
      problem: 'no Order List grid in ' + docs.length + ' document(s)'
        + (docs.length === 1 ? ' — no frames reachable from this page' : '')
        + '. Is the Order List panel open?',
    };
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
  function readRenderedRows(body, noId, seen) {
    noId = noId || [];
    var buckets = new Map();
    body.querySelectorAll('.ember-table-table-row').forEach(function (row) {
      if (String(row.className).indexOf('header-row') >= 0) return;
      // Count what is IN THE DOM, separately from what parses. "0 rows" means
      // two completely different faults otherwise: an empty grid and a grid
      // that was read and understood by none of it.
      if (seen) seen.rows = (seen.rows || 0) + 1;
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
          if (field) {
            if (rec[field] == null) { rec[field] = value; hits++; }
          } else {
            // An id we do not know. Recorded rather than ignored: the order id
            // arriving under an unrecognised cell-id is exactly what makes a
            // full grid read as empty.
            unmappedSeen[id] = value;
          }
        });
      });
      /**
       * ─── A ROW WITHOUT AN ID IS COUNTED, NOT DROPPED ────────────────────
       *
       * `hits && rec.orderId` threw away any row whose other eight cells
       * mapped perfectly if that ONE cell-id was named something else — and
       * nothing counted it, so the panel read "active and empty" while the
       * grid was full.
       */
      if (!hits) return;
      if (rec.orderId) out.push(rec);
      else noId.push(rec);
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
   * How many rows the grid SAYS it holds, independent of what we read.
   *
   * ─── IT WAS CALLED AND NEVER WRITTEN ──────────────────────────────────────
   * The scan called this and it did not exist, so tick() threw ReferenceError
   * on every cycle. Nothing caught it, so stats.msg never left its INITIAL
   * value and the panel read "waiting for the order list…" while the grid was
   * full — the same shape as ladderSweep in the depth script.
   *
   * A missing function is not a missing feature: it stops everything after it.
   *
   * The count comes from the virtualised list's own height. Ember sizes the
   * container to rowHeight x rows, so total height over row height IS the row
   * count, whether or not those rows are currently rendered. Null when neither
   * can be measured — an honest unknown rather than a fabricated number.
   */
  function expectedRowCount(body) {
    var list = body.querySelector('.lazy-list-container') || body;
    var row = body.querySelector('.ember-table-table-row');
    var rowH = row ? row.getBoundingClientRect().height : 0;
    if (!rowH) {
      var m = (row && (row.getAttribute('style') || '').match(/height:\s*([\d.]+)px/));
      rowH = m ? parseFloat(m[1]) : 0;
    }
    if (!rowH) return null;

    var total = list.scrollHeight || 0;
    if (!total) {
      var lm = (list.getAttribute('style') || '').match(/height:\s*([\d.]+)px/);
      total = lm ? parseFloat(lm[1]) : 0;
    }
    if (!total) return null;

    var n = Math.round(total / rowH);
    return n > 0 && n < 5000 ? n : null;
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
      return done(null, found.problem
        ? found.problem
        : found.activeTab
        ? 'the "' + found.activeTab + '" tab is active — switch to Order List'
        : 'Order List widget not on screen');
    }

    var body = found.widget.querySelector('.ember-table-body-container')
            || found.widget.querySelector('.ember-table-tables-container')
            || found.widget;

    var byId = new Map();
    var noIdRows = [];
    var seen = { rows: 0 };
    function collect() {
      var before = byId.size;
      readRenderedRows(body, noIdRows, seen).forEach(function (r) {
        if (!byId.has(r.orderId)) byId.set(r.orderId, r);
      });
      return byId.size - before;      // how many NEW ones this window gave
    }

    collect();

    var targets = scrollTargets(body);
    if (!targets.length) {
      stats.scrollNote = 'grid does not scroll — ' + byId.size + ' order(s) from '
        + seen.rows + ' DOM row(s)'
        + (noIdRows.length ? ' · ' + noIdRows.length + ' READ BUT HAD NO ORDER ID' : '');
      reportUnmapped(noIdRows, seen);
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

  /**
   * Rows were read and had no id: say which cell-ids the grid actually used.
   *
   * Dumped ONCE to /ingest/debug, because the markup that explains it exists
   * only in that moment — the same rule as the market-summary selectors. Being
   * told "0 orders" a week later is undiagnosable; being told the grid used
   * `ordNo` is a one-line fix.
   */
  /**
   * Dumped once per PAGE LOAD, not once ever.
   *
   * A tab that was not logged in when the script started will find the grid
   * later, and the markup it finds then is what matters. A flag that latches
   * forever would suppress the one dump that could explain a real failure.
   */
  var dumped = false;
  var dumpedAt = 0;
  function reportUnmapped(noIdRows, seen) {
    // Re-arm after ten minutes, so a late login gets its own dump.
    if (dumped && Date.now() - dumpedAt > 600000) dumped = false;
    var ids = Object.keys(unmappedSeen);

    // Rows existed in the DOM and none became an order. That is a PARSE
    // failure, and it is invisible if it reports the same "0" as an empty grid.
    if (seen && seen.rows && !noIdRows.length) {
      stats.msg = seen.rows + ' DOM row(s) present but none parsed'
        + (ids.length ? ' · unmapped cell-ids: ' + ids.slice(0, 12).join(', ') : '');
    }
    if (!noIdRows.length) return;

    stats.msg = noIdRows.length + ' row(s) read with NO order id. '
      + (ids.length ? 'Unmapped cell-ids: ' + ids.slice(0, 12).join(', ')
        : 'and no unmapped cell-ids — the id column may be absent from the grid');

    if (dumped) return;
    dumped = true;
    dumpedAt = Date.now();
    fetch(SERVER + '/ingest/debug', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify({ items: [{
        source: 'order-list-cell-ids',
        d: JSON.stringify({
          unmappedCellIds: unmappedSeen,
          sampleRowsWithoutId: noIdRows.slice(0, 3),
          knownIds: Object.keys(CELL_MAP),
        }, null, 2),
      }] }),
    }).catch(function () {});
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
      // rec keys come from CELL_MAP's VALUES, not its keys: ordVal maps to
      // orderValue and netOrdVal to netValue. Reading rec.ordVal here sent
      // undefined — the field was captured and then lost one line before the
      // POST, which is the same failure as never capturing it.
      avgPrice: num(rec.avgPrice),
      ordVal: num(rec.orderValue),
      netOrdVal: num(rec.netValue),
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

  /**
   * Per-cycle check-in — sent EVERY tick, data or not. A userscript that only
   * posts when it has rows is invisible when it stops (orders went dark for six
   * sessions unnoticed). This makes silence detectable: the server's
   * client_heartbeat row stops advancing, and `problem` carries this panel's
   * own message so the cause is known without reading the terminal. Fire-and-
   * forget; a heartbeat must never disturb the capture path.
   */
  function heartbeat(rowsSeen, problem) {
    fetch(SERVER + '/ingest/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify({ script: 'orders', version: VERSION, rowsSeen: rowsSeen, problem: problem || null }),
    }).catch(function () {});
  }

  function tick() {
    flush();

    readOrders(function (rows, problem) {
      if (problem) { stats.msg = problem; heartbeat(0, problem); return; }

      if (!rows.length) {
        stats.lastCount = 0;
        // Only claim "empty" when nothing was read at all. A grid full of rows
        // that were discarded for want of an id is not an empty grid, and
        // saying so sent us looking at the wrong thing for a session.
        if (!/NO ORDER ID|none parsed/.test(stats.scrollNote + ' ' + stats.msg)) {
          stats.msg = 'Order List tab is active and empty';
        }
        heartbeat(0, stats.msg);          // check in with the finalised reason
        return;
      }

      // batchId is created ONCE and kept across retries; regenerating it would
      // make every retry look like new data and defeat server-side idempotency.
      var batch = {
        batchId: uuid(),
        capturedAt: new Date().toISOString(),
        orders: rows.map(toPayload),
      };

      heartbeat(rows.length, null);       // alive, with rows — data POST follows
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
    h.textContent = 'Order List → Server 1  v' + VERSION;
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

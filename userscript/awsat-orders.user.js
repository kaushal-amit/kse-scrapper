// ==UserScript==
// @name         awsat / DirectFN — Order List → Server 1
// @namespace    local.trading.tools
// @version      2.10.0
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
  var VERSION = '2.10.0';

  var SERVER = 'https://scrapper.99labs.space';   // Server 1
  var TOKEN  = 'trading';               // must equal INGEST_TOKEN
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

  /**
   * ─── C1 · THE ORDER LIST GRID HAS NO ORDER-ID COLUMN ANY MORE ──────────────
   *
   * The grid this script was built against carried `clOrdId` on every row. On
   * 2 September the broker's Order List view dropped that column: the live DOM
   * now shows only symbol / status / side / quantity / price / filled / pending
   * / avg / order value / net value / order type / order date / expiry — and NO
   * id cell. readRenderedRows kept a row only `if (rec.orderId)`, so with the id
   * gone EVERY row fell to the no-id bucket and nothing was ever posted. That is
   * the six-session silence, and it looks identical in the DB to an empty grid.
   *
   * A real id is always preferred (if the grid ever restores clOrdId, it wins).
   * When there is none, synthesise a STABLE, UNIQUE id from the order's own
   * immutable fields — symbol, side, order price, order quantity, and the
   * placement timestamp (adjustedCrdDte, to the second). Stable across cycles
   * (those fields never change once the order exists) so the server de-dupes it
   * correctly; unique enough that two distinct orders never collide. Marked
   * `synthetic` in the payload so downstream knows the id was derived, not read.
   */
  function syntheticId(rec) {
    var sym = (rec.symbolRaw || '').split(/\s*-\s*/)[0].trim().toUpperCase();
    // The timestamp is what makes it unique; without symbol AND stamp there is
    // no honest stable key, so return nothing rather than a colliding guess.
    if (!sym || !rec.stamp) return null;
    /*
     * 2.8.0 · SYMBOL · SIDE · STAMP. Price and quantity are GONE from the key.
     *
     * They were in it, and that made an AMEND look like a new order: change the
     * price of a resting order and its synthetic id changed with it, so the
     * server saw the old id stop being reported and a new id appear. Under
     * append-only that is one order abandoned mid-life and another born at the
     * amended price — two rows in awsat_order_list where the trader has one
     * order, and the abandoned one then reads UNSEEN and stops protecting its
     * slot while it is still live.
     *
     * Symbol, side and placement time do not change once the order exists.
     * Price and quantity are exactly the things an amend changes, which is why
     * they cannot be in its identity.
     */
    var parts = [sym, rec.side || '', rec.stamp];
    return 'syn:' + parts.join('|').replace(/\s+/g, '');
  }

  /*
   * 2.8.0 · SAME-SECOND TWINS TAKE STABLE ORDINALS.
   *
   * Dropping price and quantity means two orders on the same symbol, same side,
   * placed in the same SECOND now collide. That is rare and real — a split
   * order entered twice, or an algo. The grid renders them in a stable order,
   * so the second one gets ':2', the third ':3'. Stable across cycles because
   * the row order is; unique because the ordinal is assigned within the id, not
   * across the batch.
   *
   * Applied to the WHOLE list at once rather than per row, because the ordinal
   * only means anything relative to its twins.
   *
   * 2.8.1 · H-G — THE ORDINAL IS SCOPED TO THE SCAN, NOT TO THE SCROLL WINDOW.
   *
   * `counts` was a local of this function, and this function runs once per
   * rendered window: readOrders scrolls the virtualised grid and calls
   * readRenderedRows at each position. So the ordinals restarted at every
   * window.
   *
   * Two same-second twins on one symbol and side, A then B:
   *
   *   window 1 renders both   -> A takes `base`, B takes `base:2`
   *   window 2 renders only B -> B takes `base`, because the count restarted
   *
   * byId keeps the FIRST record it sees for an id, so B's own reading is
   * discarded and B is reported as A — or, if the windows come the other way
   * round, A is. Two live orders collapse into one, and the one that is lost
   * then reads UNSEEN and stops protecting its slot while it is still resting
   * in the book.
   *
   * `counts` and `assigned` now live in the scan's own state object, created
   * once per readOrders and threaded through, exactly as `seen` already was.
   *
   * `assigned` is what makes the ordinal stable across OVERLAPPING windows: the
   * scroll deliberately steps two rows at a time so every row is rendered
   * several times, and counting each re-render would walk a twin's ordinal up
   * on every step. A row already assigned an id in this scan gets that same id
   * back, matched on its full cell content rather than on the identity key —
   * the identity key is deliberately blind to price and quantity, which is
   * exactly what tells two twins apart.
   *
   * A twin whose filled quantity changes mid-scan takes a fresh ordinal. That
   * is the conservative direction: a scan lasts seconds, and reporting one
   * order as two costs a duplicate row, while merging two orders into one loses
   * a live order.
   */
  function applySyntheticIds(recs, ids) {
    var counts = ids.counts;
    var assigned = ids.assigned;
    for (var i = 0; i < recs.length; i += 1) {
      var rec = recs[i];
      if (rec.orderId) continue;               // a real id always wins
      var base = syntheticId(rec);
      if (!base) continue;

      var print = rowFingerprint(rec, base);
      if (assigned[print]) {
        rec.orderId = assigned[print];
        rec.orderIdSynthetic = true;
        continue;
      }

      counts[base] = (counts[base] || 0) + 1;
      rec.orderId = counts[base] === 1 ? base : base + ':' + counts[base];
      assigned[print] = rec.orderId;
      rec.orderIdSynthetic = true;
    }
    return recs;
  }

  /** Fresh per-scan ordinal state. One per readOrders, never per window. */
  function newIdState() {
    return { counts: {}, assigned: {} };
  }

  /**
   * Everything this row said, so the SAME row read again in an overlapping
   * scroll window is recognised rather than counted twice.
   *
   * Deliberately includes price and quantity — the two fields the identity key
   * leaves out. They are what distinguishes same-second twins from each other,
   * and here we are asking "is this the same row?", not "is this the same
   * order?".
   */
  function rowFingerprint(rec, base) {
    var parts = [base];
    var keys = Object.keys(rec).sort();
    for (var i = 0; i < keys.length; i += 1) {
      var k = keys[i];
      if (k === 'orderId' || k === 'orderIdSynthetic') continue;
      parts.push(k + '=' + String(rec[k]));
    }
    return parts.join('');
  }

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
  function readRenderedRows(body, noId, seen, ids) {
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
          /*
           * ─── THE STATUS IS THE SHORT WORD · THE REASON IS THE SENTENCE ────
           *
           * `value = title || text` below prefers the TITLE, because a
           * truncated order id is a different id. For the STATUS cell that
           * rule is exactly wrong: the title is the broker's full rejection
           * sentence and the text is the status.
           *
           * Measured in public.awsat_order_obs over 14 sessions: 160 rows
           * whose order_status is "(295): Trade Rule - Price limit exceeded.
           * Price cannot be less than 237.0000", 156 of "(1296): Trade Rule -
           * Order value must be more than Normal Market Size of 40624", 80 of
           * "Insufficient funds! ( Your buying power '156.921' is less than
           * the order value '159.95' KWD )". Every distinct message became its
           * own status, so grouping orders by status was meaningless and a
           * count of rejections could not be taken at all.
           *
           * So: the SHORT text is the status, the sentence goes to
           * status_reason, and a status that is plainly a rejection is
           * normalised to one word. The broker's own text is never discarded —
           * it is put where a sentence belongs.
           */
          if (id === 'ordSts') {
            if (title && title !== text) rec.statusReason = title;
            rec.status = shortStatus(text, title);
            return;
          }
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
      // C1 · no id column in the current grid → a stable one is derived below,
      // for the whole list at once, so same-second twins can take ordinals.
      out.push(rec);
    });

    /*
     * 2.8.0 · ids are assigned to the WHOLE list, not row by row. An ordinal
     * only means anything relative to its twins, so it cannot be decided while
     * looking at one row.
     */
    applySyntheticIds(out, ids);

    var keep = [];
    for (var k = 0; k < out.length; k += 1) {
      if (out[k].orderId) keep.push(out[k]);
      else noId.push(out[k]);
    }
    return keep;
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

    /*
     * P6-CLI-1/2 · THE PER-SCAN FIELDS ARE RESET AT THE START OF THE SCAN.
     *
     * `stats.shortBy` was assigned only on the scrolling path's completion
     * branch, and `stats.msg` only when reportUnmapped had something to say.
     * Both therefore LATCHED: one short capture made `partial: true` on every
     * later batch for the life of the tab (so complete_capture never advanced,
     * 041's UNSEEN never fired and slotGuards would not release the slot), and
     * one "no order id" message made `readNothing` false forever, so a grid
     * that genuinely emptied could never post its empty, complete capture.
     *
     * They describe THIS scan, so they start empty on every scan.
     */
    stats.shortBy = 0;
    stats.msg = null;
    stats.expected = null;
    stats.scrollNote = '';

    var byId = new Map();
    var noIdRows = [];
    var seen = { rows: 0 };
    // H-G · ONE ordinal state for the whole scan. See applySyntheticIds.
    var ids = newIdState();
    function collect() {
      var before = byId.size;
      readRenderedRows(body, noIdRows, seen, ids).forEach(function (r) {
        if (!byId.has(r.orderId)) byId.set(r.orderId, r);
      });
      return byId.size - before;      // how many NEW ones this window gave
    }

    collect();

    var targets = scrollTargets(body);
    if (!targets.length) {
      stats.expected = expectedRowCount(body);
      // P6-CLI-1 · a non-scrolling grid can still be short of what it reports.
      if (stats.expected != null && byId.size < stats.expected) {
        stats.shortBy = stats.expected - byId.size;
      }
      stats.scrollNote = 'grid does not scroll — ' + byId.size + ' order(s) from '
        + seen.rows + ' DOM row(s)'
        + (noIdRows.length ? ' · ' + noIdRows.length + ' READ BUT HAD NO ORDER ID' : '');
      reportUnmapped(noIdRows, seen, byId.size);
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
        setTimeout(function () {
          collect();
          /*
           * 2.8.1 · P2 — THE PARSE-FAILURE REPORT RUNS ON THIS PATH TOO.
           *
           * reportUnmapped had exactly ONE call site: inside
           * `if (!targets.length)`, the grid-does-not-scroll branch. The
           * scrolling path — the NORMAL case, since the grid is virtualised by
           * design — returned without ever calling it.
           *
           * It is the only writer of the strings the post guard tests for:
           *
           *   var readNothing = !/NO ORDER ID|none parsed/
           *     .test(stats.scrollNote + ' ' + stats.msg);
           *   if (!rows.length && !readNothing) { ...do not post an empty capture }
           *
           * whose own comment reads: "A grid full of rows discarded for want of
           * an id is not an empty grid, and saying so sent us looking at the
           * wrong thing for a session." On the scrolling path stats.msg never
           * contained either string, so readNothing was ALWAYS true and the
           * guard could not tell apart the two cases it exists for. An empty
           * COMPLETE capture would then be posted for a grid that was full —
           * and the server judges an order absent by its absence from a
           * complete capture, so every live resting order reads UNSEEN and
           * stops protecting its depth slot.
           *
           * The /ingest/debug dump of unmapped cell-ids never fired either —
           * the dump that turned "0 orders" into "the grid used ordNo, a
           * one-line fix".
           *
           * Called AFTER the final collect, so it judges the whole scan rather
           * than one window.
           */
          reportUnmapped(noIdRows, seen, byId.size);
          done([...byId.values()], null);
        }, 150);
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
  function reportUnmapped(noIdRows, seen, parsed) {
    // Re-arm after ten minutes, so a late login gets its own dump.
    if (dumped && Date.now() - dumpedAt > 600000) dumped = false;
    var ids = Object.keys(unmappedSeen);

    /*
     * 2.8.1 · `parsed` is how many orders the scan actually produced.
     *
     * On the non-scrolling path this function was only ever reached with the
     * whole grid in view, so "rows existed and none parsed" could be inferred
     * from noIdRows alone. On the scrolling path it is called once for the
     * WHOLE scan, and a scan that read 40 rows and parsed 40 orders must not
     * report a parse failure because none of them happened to lack an id.
     */
    if (parsed > 0) return;

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


  /*
   * The broker's status vocabulary, reduced to something countable.
   *
   * Anything that is not one of the terminal's own short words is a REJECTION
   * or a FAILED CANCEL wearing its message as a name. Two rules, both from the
   * messages actually observed:
   *
   *   · a cancel that did not take  ->  'Cancel failed'
   *   · anything else unrecognised  ->  'Rejected'
   *
   * The sentence itself always survives in status_reason, so nothing is lost
   * by shortening this — and a status nobody can GROUP BY is a column that
   * cannot answer "how many orders were rejected today", which is the only
   * question it exists for.
   *
   * A word the terminal adds later falls through as 'Rejected' WITH its text
   * beside it, which is visible and fixable. The alternative — passing an
   * unknown word through as a status — is how this column filled with
   * sentences in the first place.
   */
  var KNOWN_STATUS = [
    'Queued', 'Filled', 'Partially Filled', 'Cancelled', 'Canceled', 'Expired',
    'Partially Filled Canceled', 'Partially Filled Cancelled', 'Partially Filled Expired',
    'Rejected', 'Pending', 'Sent To OMS New', 'Sent To OMS Cancel', 'Sent To OMS Replace',
    'New', 'Replaced', 'Suspended',
  ];
  function shortStatus(text, title) {
    var t = clean(text || '');
    for (var i = 0; i < KNOWN_STATUS.length; i++) {
      if (t.toLowerCase() === KNOWN_STATUS[i].toLowerCase()) return KNOWN_STATUS[i];
    }
    var all = (t + ' ' + clean(title || '')).toLowerCase();
    if (!all.trim()) return null;
    // A cancel the exchange refused is a different event from an order it
    // refused: the order is still live, and treating it as Rejected would read
    // as flat when it is not.
    if (/cancel/.test(all) && /(fail|reject|refus|not\s+allow|unable)/.test(all)) return 'Cancel failed';
    return 'Rejected';
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
      // P6-CLI-4 · the grid's placement stamp (adjustedCrdDte) was captured and
      // then dropped here, so order_time was NULL on every client-path row while
      // the server path filled it — queue-position and time-in-book analysis is
      // dead on the live path without it. Sent as the broker prints it; the
      // server parses it Kuwait-local.
      stamp: rec.stamp || null,
      orderType: rec.orderType || null,
      exchange: rec.exchange || null,
      // C1 · true when the grid had no id column and this id was derived from
      // symbol/side/price/qty/timestamp rather than read from a clOrdId cell.
      synthetic: !!rec.orderIdSynthetic,
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

  /*
   * P6-CLI-3 · THE QUEUE IS NO DEEPER THAN THE SERVER'S ACCEPT WINDOW.
   *
   * The queue held 30 minutes of batches; the server refuses any capture older
   * than 15 minutes with a 400, and a 400 is classified PERMANENT, so every
   * batch past the window was shifted off and discarded with nothing said. A
   * 25-minute outage therefore guaranteed ten minutes of invisible data loss.
   * Stale batches are now dropped HERE, before the post, and counted where the
   * panel can show them.
   */
  var SERVER_ACCEPT_MS = 15 * 60 * 1000;
  function dropStale(queue, statsObj) {
    var cut = Date.now() - SERVER_ACCEPT_MS;
    var kept = [];
    for (var i = 0; i < queue.length; i++) {
      var b = queue[i];
      var at = b && (b.capturedAt || (b.body && b.body.capturedAt));
      var t = at ? new Date(at).getTime() : NaN;
      if (!isNaN(t) && t < cut) { statsObj.dropped = (statsObj.dropped || 0) + 1; continue; }
      kept.push(b);
    }
    if (kept.length !== queue.length) {
      queue.length = 0;
      for (var j = 0; j < kept.length; j++) queue.push(kept[j]);
      statsObj.queued = queue.length;
      try {
        console.warn('[ingest] dropped ' + statsObj.dropped + ' batch(es) older than '
          + (SERVER_ACCEPT_MS / 60000) + ' minutes — the server refuses them');
      } catch (e) {}
    }
  }

  function flush() {
    dropStale(retryQueue, stats);
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

  /**
   * ─── C1b · MOUNT THE GRID THE BROKER BUILDS ONLY ON A TAB INTERACTION ──────
   *
   * On a fresh login the Order List grid is not in the DOM at all — the broker
   * renders it the first time its tab is interacted with, and until then the
   * reader honestly finds nothing ("no Order List grid … Is the panel open?").
   * Once mounted it PERSISTS for the whole session, readable even while another
   * tab is showing — which is why touching the tabs once made capture start and
   * stay working.
   *
   * So do that touch ourselves, once, when the grid is missing: click the Order
   * List tab (harmless if it is already the active one). It never places or
   * cancels an order — a widget tab only switches which panel is shown — and it
   * stops as soon as the grid mounts, so it is not a per-cycle disturbance. If
   * clicking the tab directly does not mount it, a sibling bounce (the exact
   * away-and-back that works by hand) is the escalation, still one-time.
   */
  var mountTries = 0;
  /**
   * A tab is an Ember `data-ember-action` element; a plain .click() on the
   * ALREADY-ACTIVE tab is ignored, which is why activating Order List did
   * nothing. What works by hand is switching AWAY and BACK. Reproduce that with
   * a full, bubbling mouse sequence (mousedown→mouseup→click) so whichever event
   * the broker's handler listens on fires — .click() alone was not enough.
   */
  function fireClick(el) {
    if (!el) return;
    var view = el.ownerDocument && el.ownerDocument.defaultView;
    ['mousedown', 'mouseup', 'click'].forEach(function (type) {
      try { el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: view, composed: true })); }
      catch (e) { try { el.click(); } catch (e2) {} }
    });
  }
  function tabEl(name) {
    var docs = collectDocs(document, []);
    for (var d = 0; d < docs.length; d++) {
      var items = docs[d].querySelectorAll('.wdgttl-tab-item');
      for (var i = 0; i < items.length; i++) {
        var span = items[i].querySelector('span');
        if (span && clean(span.textContent).toLowerCase() === name.toLowerCase()) {
          return items[i].querySelector('a') || items[i];
        }
      }
    }
    return null;
  }
  function clickTab(name) { var el = tabEl(name); if (el) { fireClick(el); return true; } return false; }

  /**
   * Mount the grid by doing exactly what the operator does: switch to a SIBLING
   * tab, then back to Order List. Clicking Order List while it is already active
   * is a no-op — the away-and-back is the trigger. One-time (capped), and only
   * while the grid is absent, so it is a cold-start nudge, never a per-cycle
   * disturbance. It only switches a view panel; it never places or cancels an
   * order, and it returns the view to Order List.
   */
  function mountOrderList() {
    if (mountTries >= 5) return false;   // give up rather than bounce forever
    mountTries++;
    var siblings = ['Portfolio', 'Account Summary', 'Order Search'];
    var away = null;
    for (var i = 0; i < siblings.length && !away; i++) if (tabEl(siblings[i])) away = siblings[i];
    if (!away) { clickTab('Order List'); return true; }   // no sibling found — try Order List anyway
    clickTab(away);
    setTimeout(function () { clickTab('Order List'); }, 500);  // …and straight back
    return true;
  }
  // Prime it once at startup (before the first tick), so capture begins on its
  // own after login instead of waiting for a manual tab switch.
  setTimeout(function () { if (!ordersWidget().widget) mountOrderList(); }, 4500);


  /*
   * ─── THE CAPTURE WINDOW · 08:40 to 13:20 KUWAIT ──────────────────────────
   *
   * No capture script used to stop when the market shut. On 24 September this
   * one was still saving at 16:22 — the same shut board, every cycle, for
   * three hours. The other end is worse: a pre-open capture carries NO session
   * label and the PREVIOUS session's cumulative totals, which is how 20
   * September stored 17 September's trades and volume for 79 of 140 symbols.
   *
   * The SERVER is the authority — it refuses an out-of-window batch by
   * capturedAt and says why — so a stale copy of this script cannot put bad
   * rows in the table. This guard is the other half: it stops the browser
   * burning a cycle, a network round trip and a queue slot on a batch that is
   * going to be refused.
   */
  var CAP_OPEN_MIN = 8 * 60 + 40;     // 08:40 Kuwait
  var CAP_CLOSE_MIN = 13 * 60 + 20;   // 13:20 Kuwait — Close-Of-Day starts 13:15
  function inCaptureWindow() {
    var k = new Date(Date.now() + 3 * 3600 * 1000);   // Kuwait is UTC+3, no DST
    var dow = k.getUTCDay();
    if (dow === 5 || dow === 6) return false;         // Friday, Saturday: shut
    var m = k.getUTCHours() * 60 + k.getUTCMinutes();
    return m >= CAP_OPEN_MIN && m < CAP_CLOSE_MIN;
  }
  function windowNote() {
    var k = new Date(Date.now() + 3 * 3600 * 1000);
    var m = k.getUTCHours() * 60 + k.getUTCMinutes();
    var dow = k.getUTCDay();
    if (dow === 5 || dow === 6) return 'market shut (weekend) — not capturing';
    return (m < CAP_OPEN_MIN ? 'before 08:40' : 'after 13:20') + ' Kuwait — not capturing';
  }

  function tick() {
    if (!inCaptureWindow()) { stats.msg = windowNote(); heartbeat(0, windowNote()); refresh(); return; }
    flush();

    readOrders(function (rows, problem) {
      if (problem) {
        stats.msg = problem;
        heartbeat(0, problem);
        // C1b · the grid is not in the DOM yet (fresh login, no tab touched).
        // Mount it ourselves and re-read shortly after, instead of waiting for
        // the operator to switch tabs.
        if (/no Order List grid/.test(problem) && mountOrderList()) {
          stats.msg = problem + ' — mounting the Order List tab…';
          setTimeout(tick, 1500);
        }
        return;
      }

      /*
       * 2.8.0 · AN EMPTY GRID IS POSTED.
       *
       * It used to check in on the heartbeat and return without posting. But
       * "there are no orders" is a FACT, and under append-only it is the only
       * way "everything is gone" becomes expressible: the server judges an
       * order absent by comparing its last sighting against the most recent
       * COMPLETE capture, and silence is not a capture. Without this, the last
       * order of the day kept its `Queued` status for ever and went on
       * protecting its depth slot after it had left the grid.
       *
       * Still only when nothing was read AT ALL. A grid full of rows discarded
       * for want of an id is not an empty grid, and saying so sent us looking
       * at the wrong thing for a session — so that case still does not post an
       * empty capture, because it is not one.
       */
      /*
       * 2.8.1 · P2 — CASE-INSENSITIVE, because the two writers disagreed.
       *
       * The pattern was case-SENSITIVE. The non-scrolling path's scrollNote
       * writes "READ BUT HAD NO ORDER ID" and matched; reportUnmapped writes
       * "row(s) read with NO order id." and did NOT. So even once
       * reportUnmapped was reachable from the scrolling path, the string it
       * sets would still have slipped past the guard that reads it.
       *
       * Two halves of one mechanism, in one file, differing by capitalisation —
       * which is exactly the kind of thing a regex should not be asked to
       * notice.
       */
      var readNothing = !/NO ORDER ID|none parsed/i.test(stats.scrollNote + ' ' + stats.msg);
      if (!rows.length && !readNothing) {
        stats.lastCount = 0;
        heartbeat(0, stats.msg);          // check in with the finalised reason
        return;
      }
      if (!rows.length) {
        stats.lastCount = 0;
        stats.msg = 'Order List tab is active and empty';
      }

      /*
       * 2.7.0 · batchId AND capturedAt are created ONCE and kept across
       * retries.
       *
       * batchId was always so: regenerating it would make every retry look
       * like new data and defeat server-side idempotency.
       *
       * capturedAt now carries the same weight. Since CR-10/11 the server
       * stores orders APPEND-ONLY, and an observation's identity is
       * (order_id, capturedAt, source) — so capturedAt is when the grid was
       * READ, not when the request happened to be sent. A retry stamped with a
       * fresh clock would be a second, fictitious sighting of the same screen:
       * it would inflate sighting_count and, because executions_observed
       * counts filled_quantity rises between consecutive sightings, it could
       * manufacture an execution that never happened. The settlement fee is
       * charged per execution, so that is money.
       */
      /*
       * 2.8.0 · `partial` says whether this scan read the WHOLE grid.
       *
       * Only the client knows. The server sees fewer rows and cannot tell "the
       * grid is shorter" from "I did not reach the bottom" — and it judges an
       * order gone by its absence from a capture, so judging against a short
       * scan would mark every order below the scroll fold UNSEEN. That turns a
       * client-side scroll problem into a wrong status on live orders.
       *
       * stats.shortBy is set when the grid's own row count exceeds what was
       * captured (see expectedRowCount).
       */
      /*
       * ─── A ROW WITHOUT THE BROKER'S ORDER NUMBER ─────────────────────────
       *
       * A row with NO id at all is never sent: it reconciles against nothing,
       * cannot be matched to a fill, and arrives as a new order on every
       * capture. That one is unambiguous.
       *
       * A row whose id was SYNTHESISED from symbol/side/price/quantity/stamp
       * is NOT dropped, and this is deliberate. On 2 September the Order List
       * grid lost its clOrdId column, this script kept a row only
       * `if (rec.orderId)`, and orders went silent for SIX SESSIONS — the C1
       * fix and test/suites/order-noid.test.js exist because of it. Dropping
       * synthetic ids re-creates that outage exactly: when the column is
       * renamed, EVERY row is synthetic, and the client would post nothing
       * while reporting itself healthy.
       *
       * So they are sent, marked `synthetic: true` (they always were), and
       * COUNTED here so the panel and the batch both say how many. Migration
       * 046 is the guard on the other side: order_id may not be null or blank
       * in the table. The two together are the honest pair — the database
       * refuses what cannot be identified, and the client says out loud when
       * the grid has stopped giving it ids.
       */
      var sendable = [], noId = 0, synthetic = 0;
      rows.forEach(function (r) {
        if (!r.orderId) { noId++; return; }
        if (r.orderIdSynthetic) synthetic++;
        sendable.push(r);
      });
      stats.noBrokerId = noId;
      stats.syntheticIds = synthetic;
      if (noId || synthetic) {
        stats.msg = (noId ? noId + ' row(s) had NO order id and were not sent. ' : '')
          + (synthetic ? synthetic + ' of ' + rows.length + ' id(s) SYNTHESISED — the grid\'s id '
             + 'column may have been renamed again; these are sent and marked synthetic.' : '');
      }

      var batch = {
        batchId: uuid(),
        capturedAt: new Date().toISOString(),
        /*
         * A batch that dropped rows IS partial, whatever the scroll said: the
         * server must not read it as a complete picture of the book and retire
         * orders that are simply missing from it.
         */
        partial: stats.shortBy > 0 || noId > 0,
        // Said on the batch as well as the panel: the server sees how many of
        // these rows carry an id it can reconcile against.
        syntheticIds: synthetic,
        orders: sendable.map(toPayload),
      };

      heartbeat(sendable.length, null);   // alive, with rows — data POST follows
      submit(batch).then(function (j) {
        stats.posts++; stats.lastCount = sendable.length;
        stats.msg = 'sent ' + sendable.length
          + (noId ? ' (' + noId + ' with NO order id dropped)' : '')
          + (synthetic ? ' (' + synthetic + ' synthesised)' : '')
          + ' → inserted ' + (j.inserted != null ? j.inserted : '?')
          + (j.duplicate ? ' (duplicate replayed)' : '')
          + (j.rejected ? ', rejected ' + j.rejected : '');
      }).catch(function (e) {
        if (!e.permanent) {
          if (retryQueue.length >= MAX_RETRY_QUEUE) { retryQueue.shift(); stats.dropped = (stats.dropped || 0) + 1; }   // P6-CLI-3 · counted, not silent
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
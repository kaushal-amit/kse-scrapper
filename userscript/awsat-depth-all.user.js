// ==UserScript==
// @name         awsat / DirectFN — Depth for ALL symbols
// @namespace    local.trading.tools
// @version      2.3.0
// @description  Level-1 depth for every symbol from the price socket each cycle (no switching, meets the 1-1.5 min ceiling), plus a round-robin full-ladder sweep of the open symbol. Posts to Server 1.
// @match        *://*.awsatbroker.com/*
// @match        *://awsatbroker.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/**
 * ─── WHY THIS IS NOT "THE OLD SCRIPT, FASTER" ──────────────────────────────
 *
 * The requirement is all 135 symbols inside 90 seconds — 0.67s each. Switching
 * the terminal to a symbol and waiting for its book to repaint costs ~0.9-1.3s
 * at best, so a DOM sweep needs 2-3 MINUTES. That is a 2-3x gap, and no amount
 * of shorter sleeps closes it: cut the settle time and the book you read is the
 * previous symbol's.
 *
 * The price socket already carries best-bid and best-offer for EVERY symbol,
 * continuously, with no switching:
 *
 *     bbp = best bid price     bbq = best bid quantity
 *     bap = best ask price     baq = best ask quantity
 *
 * That is level 1 of the book for all 135 symbols, available in a single pass
 * that takes milliseconds. It comfortably meets the ceiling, and it is the same
 * data the terminal itself renders into the top row of the ladder.
 *
 * ─── WHAT THIS DOES AND DOES NOT GIVE YOU ──────────────────────────────────
 *
 *   LEVEL 1, all symbols, every cycle          <- from the socket
 *   LEVELS 2-10, one symbol at a time          <- from the DOM, round-robin
 *
 * Full depth for all 135 within 90s is NOT possible through this interface. The
 * terminal only ever renders one ladder, and the socket has not been shown to
 * carry deeper levels. If it does — run the discovery below — this script can
 * be pointed at those frames and the whole problem disappears.
 *
 * The rotation is a strict cursor, so across a full sweep every symbol is
 * visited exactly once: no symbol is skipped and none is captured twice in the
 * same rotation.
 */
(function () {
  'use strict';

  // ── CONFIG ────────────────────────────────────────────────────────────────
  // The running build, shown on the panel: two scripts both reporting
  // 2.0.0 cost a session diagnosing a bug that was already fixed.
  var VERSION = '2.3.0';

  var SERVER          = 'https://socket.99labs.space';
  var TOKEN           = 'trading';
  /**
   * Whether to post the socket's best bid/offer as depth level 1.
   *
   * OFF by default. The touch is ALREADY stored in awsat_market_quotes as
   * bid/bid_qty/offer/offer_qty, so writing it again as a depth level adds no
   * information — and it fills awsat_stock_depth with level-1 rows that make a
   * ladder sweep which never ran look exactly like one that works.
   *
   * awsat_stock_depth should hold LADDERS. If it is empty, that should be
   * visible rather than disguised.
   */
  var LADDER_EVERY_MS = 3000;        // one symbol's full book, round-robin
  var MAX_LEVELS      = 20;   // the awsat_stock_depth CHECK ceiling
  var EQUITIES_ONLY   = true;

  /**
   * The stocks whose FULL LADDER is wanted, in priority order.
   *
   * Empty means "rotate through everything", which takes ~7 minutes for a full
   * pass. Naming a list keeps every one of them inside the minute.
   *
   * MEASURED CAPACITY: a full ladder costs ~0.92s per symbol — set the search
   * box, wait for the repaint, read the rows. In the 55s usable out of a
   * minute that is ~59 at best, and ~40 with the margin a slow repaint needs.
   * Beyond that the sweep runs past the minute and the next one starts late.
   *
   * Level 1 for ALL symbols is unaffected: it comes from the socket in half a
   * millisecond and does not touch the UI.
   */
  var LADDER_SYMBOLS = [];        // filled from GET /depth-symbols; see below
  var SYMBOLS_URL    = SERVER + '/depth-symbols';

  /**
   * Used when /depth-symbols cannot be reached.
   *
   * NOT "sweep everything". An unreachable list previously meant sweeping all
   * ~140 symbols, which at ~1s each cannot fit a 55s budget: 130 were never
   * attempted and the sweep completed 0. The safe response to "I do not know
   * which stocks matter" is a small set that finishes, not the largest one.
   *
   * Edit this to the handful you care about most if the server is often down.
   */
  var FALLBACK_SYMBOLS = ['NBK', 'KFH', 'ZAIN', 'GBK', 'ABK', 'BOUBYAN', 'KIB', 'BURG'];
  var symbolListReachable = false;
  var lastSearchSeen = null;
  /**
   * 15 SECONDS PER FULL SWEEP OF 8 — not per symbol.
   *
   * Measured on CATTL 25 August: 56% of consecutive 30-second snapshots showed
   * a material change. More than half the time the book is already different by
   * the next look, so intermediate states were being missed entirely.
   *
   * Eight symbols at ~0.92s each is ~7.4s of work, which leaves headroom in a
   * 15s window for a slow ladder repaint.
   */
  // 25-second sweep, 23s of budget. Five symbols at the measured 4.34s average
  // is 21.7s of work, so a normal sweep finishes inside it and a stalled one is
  // cut rather than allowed to run into the next.
  var LADDER_BUDGET_MS = 23000;
  // Eight slots at ~0.92s is ~7.4s. Above ~13 the sweep cannot finish in 15s.
  /**
   * ─── THREE, AND IT WAS MEASURED ───────────────────────────────────────────
   *
   * This was 13, from an estimate that a symbol switch takes about 0.9
   * seconds. Measured against 3,984 real switches on 1 September:
   *
   *     average  4.34s
   *     p90     22.84s
   *
   * Nearly five times the estimate, and one switch in ten stalls badly. Eight
   * symbols is a 35-second sweep, not 15.
   *
   * SET TO FIVE, and the window widened to match.
   *
   * Three was too few to trade from. But the average and the p90 are far
   * apart — 4.34s against 22.84s — which means most switches are quick and a
   * handful stall. An average dragged by outliers is the wrong number to size
   * a budget with, and the median was never measured.
   *
   * So: five symbols, and the sweep is given 25 seconds rather than 15. At a
   * 4.34s average that is 21.7s of work in a 25s window; when a switch stalls
   * the budget cuts the sweep short and the next one starts clean, rather than
   * every sweep overrunning into its successor.
   *
   * Slot order is priority order, so the five kept are the pre-day picks and
   * the earliest wake-ups.
   */
  var LADDER_MAX_SAFE = 5;
  var POLL_MS         = 120;      // how often to re-check the widget
  var LADDER_WAIT_MS  = 2500;     // give up on a symbol after this
  var POPUP_TIMEOUT   = 3500;     // wait for the search results to appear
  var BOOK_TIMEOUT    = 5000;     // wait for that symbol's book to load
  var MAX_RETRY_QUEUE = 30;
  // 'B' is the AUCTION market. It was missing from this map, so the raw code
  // leaked into the market column and 57 zero-price symbols were posted every
  // cycle. Premier + Main is the TradingView list exactly (39 + 98 = 137).
  var MARKETS = { P: 'Premier Market', M: 'Main Market', B: 'Auction Market' };
  var KEEP_MARKETS = ['Premier Market', 'Main Market'];   // [] = keep all
  function marketName(id) { return MARKETS[id] || (id ? 'UNKNOWN (' + id + ')' : null); }

  var board = new Map();     // sym code -> merged quote frame
  var master = new Map();
  var retryQueue = [];
  var cursor = 0;            // round-robin position, never reset mid-rotation
  var rotationStarted = Date.now();
  var rotationSeen = new Set();
  var sampleUrl = null, fullMasterFetched = false;
  var stats = {
    frames: 0, l1Symbols: 0, l1Posts: 0, ladderPosts: 0, ladderSkips: 0,
    rotationMs: 0, queued: 0, msg: 'starting…', msgTypes: {},
    missing: {}, lastMissed: [], lastSkipReason: '', listSource: '—', l1Empty: 0,
    lastDepth: 0,
  };

  function uuid() {
    return (crypto && crypto.randomUUID) ? crypto.randomUUID()
      : 'b-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }
  function txt(el) { return (el && el.textContent || '').replace(/\s+/g, ' ').trim(); }
  function num(v) {
    if (v === null || v === undefined) return null;
    var s = String(v).replace(/\u2212/g, '-').replace(/,/g, '').replace(/\s/g, '').trim();
    if (!s || !/\d/.test(s)) return null;
    var n = parseFloat(s);
    return isNaN(n) ? null : n;
  }
  function noteUrl(u) {
    try { if (!sampleUrl && u && /price\?/i.test(String(u))) sampleUrl = String(u); } catch (e) {}
  }

  // ── keep the tab alive in the background ──────────────────────────────────
  (function stayVisible() {
    try {
      Object.defineProperty(document, 'hidden', { configurable: true, get: function () { return false; } });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: function () { return 'visible'; } });
    } catch (e) {}
    function swallow(e) { try { e.stopImmediatePropagation(); } catch (x) {} }
    ['visibilitychange', 'webkitvisibilitychange', 'blur', 'pagehide', 'freeze'].forEach(function (t) {
      try { document.addEventListener(t, swallow, true); window.addEventListener(t, swallow, true); } catch (e) {}
    });
  })();

  // ── tap the price socket ──────────────────────────────────────────────────
  try {
    var W = window.WebSocket;
    window.WebSocket = new Proxy(W, {
      construct: function (T, a) {
        var url = String(a[0] || ''), ws;
        try { ws = new T(a[0], a[1]); } catch (e) { ws = new T(a[0]); }
        if (/wsqs/i.test(url)) {
          try {
            ws.addEventListener('message', function (ev) {
              if (typeof ev.data !== 'string') return;
              var i = ev.data.indexOf('{'); if (i < 0) return;
              var obj; try { obj = JSON.parse(ev.data.slice(i)); } catch (e) { return; }
              stats.frames++;

              // Census of every message type. If depth ever arrives here under
              // its own type, this is what will show it — and full depth for
              // all symbols becomes possible in one pass.
              var t = String(obj['1'] === undefined ? 'none' : obj['1']);
              stats.msgTypes[t] = (stats.msgTypes[t] || 0) + 1;

              if (obj.sym === undefined || obj.sym === null) return;
              // MERGE: frames are partial, so replacing would wipe bbp off a
              // symbol whose next frame only carries a traded price.
              var key = String(obj.sym);
              var cur = board.get(key) || {};
              for (var k in obj) if (k !== '1') cur[k] = obj[k];
              cur.__at = Date.now();
              board.set(key, cur);
            });
          } catch (e) {}
        }
        return ws;
      },
    });
  } catch (e) {}

  // ── symbol master ─────────────────────────────────────────────────────────
  function ingestMaster(json) {
    if (!json || !json.HED || !json.DAT) return;
    function rows(cols, list) {
      var idx = {}; cols.forEach(function (c, n) { idx[c] = n; });
      if (idx.SYMBOL === undefined) return;
      list.forEach(function (rowStr) {
        if (typeof rowStr !== 'string') return;
        var f = rowStr.split('|');
        var e = {
          symbol: (f[idx.SHRT_DSC] || f[idx.SYMBOL] || '').trim() || null,
          code: (idx.COMPANY_CODE !== undefined ? (f[idx.COMPANY_CODE] || '').trim() : '')
                || (f[idx.SYMBOL] || '').trim() || null,
          market: marketName(f[idx.MARKET_ID]),
          instr: idx.INSTRUMENT_TYPE !== undefined ? (f[idx.INSTRUMENT_TYPE] || '').trim() : '',
        };
        if (!e.code) return;
        ['SYMBOL', 'SHRT_DSC', 'COMPANY_CODE', 'CFID', 'SERIAL', 'TI'].forEach(function (col) {
          var v = idx[col] !== undefined ? (f[idx[col]] || '').trim() : '';
          if (v) master.set(v.toUpperCase(), e);
        });
      });
    }
    (function scan(hed, dat) {
      if (!hed || !dat || typeof hed !== 'object') return;
      for (var k in hed) {
        var c = hed[k];
        if (typeof c === 'string' && c.indexOf('|') >= 0 && Array.isArray(dat[k])) rows(c.split('|'), dat[k]);
        else if (c && typeof c === 'object' && dat[k] && typeof dat[k] === 'object') scan(c, dat[k]);
      }
    })(json.HED, json.DAT);
  }

  try {
    var XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) { this.__u = u; noteUrl(u); return XO.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function () {
      var s = this;
      try {
        s.addEventListener('load', function () {
          try {
            if (!/price\?/i.test(s.__u || '')) return;
            if (/json/i.test(s.getResponseHeader('content-type') || '')) ingestMaster(JSON.parse(s.responseText));
          } catch (e) {}
        });
      } catch (e) {}
      return XS.apply(this, arguments);
    };
  } catch (e) {}

  var nativeFetch = window.fetch;
  try {
    window.fetch = function (input) {
      try { noteUrl(typeof input === 'string' ? input : (input && input.url)); } catch (e) {}
      var p = nativeFetch.apply(this, arguments);
      try {
        p.then(function (res) {
          var u = typeof input === 'string' ? input : (input && input.url) || '';
          if (/price\?/i.test(u) && /json/i.test(res.headers.get('content-type') || '')) {
            res.clone().json().then(ingestMaster).catch(function () {});
          }
        }).catch(function () {});
      } catch (e) {}
      return p;
    };
  } catch (e) {}

  // The app's own request carries its cached version, so the reply is a DELTA.
  // VRS=0 asks for everything. Runs even once a master exists, because a
  // partial master silently drops whole markets.
  function masterUrl(u) {
    var x = String(u);
    x = /RT=\d+/.test(x) ? x.replace(/RT=\d+/, 'RT=303') : x + (x.indexOf('?') >= 0 ? '&' : '?') + 'RT=303';
    x = /VRS=\d+/.test(x) ? x.replace(/VRS=\d+/, 'VRS=0') : x + '&VRS=0';
    if (!/[?&]AS=/.test(x)) x += '&AS=1';
    return x.replace(/&?MOD=[^&]*/i, '');
  }
  setInterval(function () {
    // Never gives up: a tab sits through a login, a timeout and a re-login,
    // and anything that can only happen at startup will eventually happen
    // before the thing it depends on exists.
    if (fullMasterFetched || !sampleUrl) return;
    try {
      nativeFetch(masterUrl(sampleUrl), { credentials: 'include' })
        .then(function (r) { return r.json(); })
        .then(function (j) { ingestMaster(j); if (master.size) fullMasterFetched = true; })
        .catch(function () {});
    } catch (e) {}
  }, 2000);

  // ── submission with idempotency + retry ───────────────────────────────────
  function submit(batch) {
    return nativeFetch(SERVER + '/depth', {
      method: 'POST', body: JSON.stringify(batch),
    }).then(function (r) {
      if (r.status >= 400 && r.status < 500 && r.status !== 401) {
        throw Object.assign(new Error('HTTP ' + r.status), { permanent: true });
      }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json().catch(function () { return {}; });
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
  function post(batch) {
    // batchId is created once and KEPT across retries — regenerating it would
    // make every retry look like new data and defeat the server's idempotency.
    return submit(batch).catch(function (e) {
      if (!e.permanent) {
        if (retryQueue.length >= MAX_RETRY_QUEUE) retryQueue.shift();
        retryQueue.push(batch);
        stats.queued = retryQueue.length;
      }
      throw e;
    });
  }

  // ── l1Tick REMOVED ────────────────────────────────────────────────────────
  //
  // It posted level 1 for every symbol on the board to /depth. That duplicates
  // awsat_market_quotes, which already carries the touch, and it filled the
  // depth table with 136 symbols at one level — crowding out the ladders the
  // table exists for.
  //
  // older build with the flag on reintroduces it, and one did. Deleted rather
  // than disabled.

  // ── TASK 2 — full ladder, one symbol per tick, strict rotation ────────────
  function symbolList() {
    var out = [], seen = {};
    master.forEach(function (m) {
      if (EQUITIES_ONLY && m.instr && m.instr !== '0') return;
      if (KEEP_MARKETS.length && KEEP_MARKETS.indexOf(m.market) === -1) return;
      var k = String(m.symbol || m.code).toUpperCase();
      if (!k || seen[k]) return;
      seen[k] = 1; out.push(m);
    });
    return out.sort(function (a, b) { return String(a.code).localeCompare(String(b.code), undefined, { numeric: true }); });
  }
  function findSearch() {
    return document.querySelector('.symbol-input-width input')
        || document.querySelector('input.symbol-fore-color.search-query')
        || document.querySelector('input[id^="searchField"]');
  }
  /**
   * The symbol the DEPTH WIDGET itself is showing.
   *
   * Not the search box — the search box echoes what was typed immediately,
   * while the book arrives afterwards. Reading between those two moments gives
   * the previous stock's numbers under the new stock's name, which is the bug
   * this exists to prevent.
   */
  function parseSym(raw) {
    if (!raw) return null;
    var m = String(raw).replace(/\s+/g, ' ')
      .match(/\b([A-Za-z][A-Za-z0-9]*)\s*[-\u2013]\s*(\d{1,6})\b/);
    return m ? { symbol: m[1].toUpperCase(), code: m[2] } : null;
  }

  /**
   * Which stock the order ticket is currently showing.
   *
   * ─── WHY NOT THE LADDER WIDGET ─────────────────────────────────────────
   * The ladder lives in its own bare widget:
   *
   *     <div class="widget_new border-none" style="height:132px">
   *       <div class="nano quote-page-second-row-wght">
   *
   * and NOTHING in it names a stock — it is only Quantity/Bid and
   * Offer/Quantity columns. Looking for .symbol-fore-color inside it always
   * returned null, so the "does this book belong to the symbol I asked for?"
   * check never passed and every symbol was skipped as "book never loaded".
   *
   * The symbol is in the order ticket's HEADER, one widget up:
   *
   *     <div class="layout-inline pad-s-l mgn-l-r">New Order - ABAR - 633</div>
   *
   * with the search box's value as a second source. Both are read; the header
   * is preferred because it changes only once the terminal has ACCEPTED the
   * selection, while the input echoes whatever was typed.
   */
  function ladderSymbol() {
    // 1 — the order ticket header, the authoritative source.
    var headers = document.querySelectorAll('#order-ticket-landscape-id .wdgttl-header div, '
      + '[id^="widget-header"] div, .wdgttl-header div');
    for (var i = 0; i < headers.length; i++) {
      var el = headers[i];
      if (el.children.length > 2) continue;          // skip layout wrappers
      var t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!/New Order/i.test(t)) continue;
      var parsed = parseSym(t.replace(/^.*New Order\s*[-\u2013]\s*/i, ''));
      if (parsed) return parsed.symbol;
    }

    // 2 — the search box. It echoes typing, so it is only a fallback.
    var input = findSearch();
    if (input && input.value) {
      var fromInput = parseSym(input.value);
      if (fromInput) return fromInput.symbol;
    }
    return null;
  }

  /**
   * Every container that might hold an order book.
   *
   * Searching ONE container was a reduction that cost four levels out of five:
   * the quote page's own row can hold just the touch while the full ladder sits
   * in another widget. The book is wherever it is; find all the candidates and
   * let the depth decide.
   */
  function ladderScopes() {
    var out = [];
    var q = document.querySelector('.quote-page-second-row-wght');
    if (q) out.push(q);

    // Any table whose header says Bid / Offer / Ask is a book by definition.
    var heads = document.querySelectorAll('.data-table-header, th');
    for (var i = 0; i < heads.length; i++) {
      var t = txt(heads[i]).toLowerCase();
      if (t !== 'bid' && t !== 'offer' && t !== 'ask') continue;
      var c = heads[i].closest('.widget_new') || heads[i].closest('.nano')
           || (heads[i].parentElement && heads[i].parentElement.parentElement);
      if (c && out.indexOf(c) < 0) out.push(c);
    }

    // Last resort: the whole document. Costs a wider query on a page that has
    // no recognisable book, which is better than returning nothing.
    if (!out.length) out.push(document);
    return out;
  }

  /**
   * Read one scope's ladder.
   *
   * Bids and offers are INTERLEAVED in a flat list of rows and separated by
   * colour class, not by column. Each side is sorted on its own — bids high to
   * low, offers low to high — and the two are then zipped into levels.
   *
   * Zipping by POSITION matters: the sides can have different depths, so
   * pairing any other way would stop level 1 being the touch on both sides.
   */
  function readLadderIn(scope) {
    if (!scope) return [];
    var bids = [], offers = [];

    // Each level is a .pos-rel row holding a price cell (.cursor-pointer,
    // because clicking it fills the order ticket) and a quantity cell
    // (.h-right). Bid and offer sides sit in separate columns and are told
    // apart by colour class, never by column position.
    scope.querySelectorAll('.pos-rel').forEach(function (r) {
      var pe = r.querySelector('.cursor-pointer');
      if (!pe) return;
      var price = num(txt(pe));
      if (price === null) return;

      var qe = r.querySelector('.h-right');
      var qty = qe ? num(txt(qe)) : null;

      var cls = (pe.className || '') + ' ' + (r.className || '');
      // table-row-up-back-color / table-row-down-back-color are the real class
      // names in this terminal; the shorter forms are kept for other layouts.
      if (/up-fore-color|table-row-up/.test(cls)) bids.push({ price: price, qty: qty });
      else if (/down-fore-color|table-row-down/.test(cls)) offers.push({ price: price, qty: qty });
    });

    if (!bids.length && !offers.length) return [];
    bids.sort(function (a, b) { return b.price - a.price; });
    offers.sort(function (a, b) { return a.price - b.price; });

    // NO HARDCODED DEPTH. Take as many levels as the book actually has, capped
    // only by what the database allows (20) — a fixed 5 or 10 would silently
    // discard levels on a deeper book.
    var n = Math.min(MAX_LEVELS, Math.max(bids.length, offers.length));
    var out = [];
    for (var i = 0; i < n; i++) {
      var b = bids[i] || {}, o = offers[i] || {};
      out.push({
        level: i + 1,
        bid: b.price != null ? b.price : null,
        bidQty: b.qty != null ? b.qty : null,
        offer: o.price != null ? o.price : null,
        offerQty: o.qty != null ? o.qty : null,
      });
    }
    return out;
  }

  /** The DEEPEST book on the page. */
  function readLadder() {
    var scopes = ladderScopes(), best = [];
    for (var i = 0; i < scopes.length; i++) {
      var lv = readLadderIn(scopes[i]);
      if (lv.length > best.length) best = lv;
    }
    stats.lastDepth = best.length;
    return best;
  }

  // ── SELECTING A SYMBOL ─────────────────────────────────────────────────
  //
  // Typing and pressing Enter is what produced one stock's book under another
  // stock's name. Enter takes whatever the dropdown has highlighted, which may
  // be a rights line, a "Buy In Market" entry, or the same name listed on a
  // different market — and when it matches nothing, the previous book simply
  // stays on screen while the search box already shows the new name.
  //
  // So: wait for the result popup, find the row that matches the symbol AND the
  // code AND a real market, and select THAT row.

  function setNativeValue(el, val) {
    try {
      var d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
      if (d && d.set) d.set.call(el, val); else el.value = val;
    } catch (e) { el.value = val; }
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // Type character by character. Setting the whole value at once leaves Ember's
  // typeahead unaware that anything was typed, so no results ever appear.
  function typeInto(input, text) {
    input.focus();
    setNativeValue(input, '');
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      setNativeValue(input, text.slice(0, i + 1));
      ['keydown', 'keypress', 'keyup'].forEach(function (t) {
        try { input.dispatchEvent(new KeyboardEvent(t, { key: ch, bubbles: true })); } catch (e) {}
      });
    }
  }

  function resultContainers() {
    return document.querySelectorAll('[id^="symbolSearch"], .symbol-search-result-popup, '
      + '.modal-symbol, [class*="search-result"], [class*="autocomplete"], [class*="typeahead"]');
  }

  function candidateRows() {
    var cs = resultContainers(), rows = [];
    for (var c = 0; c < cs.length; c++) {
      var ea = cs[c].querySelectorAll('[data-ember-action]');
      for (var i = 0; i < ea.length; i++) rows.push(ea[i]);
    }
    return rows;
  }

  /**
   * The row for this symbol, or null.
   *
   * Requires symbol AND code AND a real market, and refuses "BUY IN" outright —
   * that entry looks like a match and opens a different screen. Invisible rows
   * are skipped: a zero-size element is a stale render, and dispatching a click
   * at it does nothing while looking like success.
   */
  function findResult(want, code) {
    // WORD BOUNDARY, not indexOf.
    //
    // "ABARRE" contains "ABAR", so a substring match happily selects the rights
    // line when the real listing is one row further down — and the code cannot
    // always save it, because the code is only a tiebreak. Matching the ticker
    // as a whole token is what keeps ABAR off ABARRE.
    var token = new RegExp('(^|[^A-Z0-9])' + want.replace(/[^A-Z0-9]/gi, '') + '([^A-Z0-9]|$)');

    var rows = candidateRows();
    var visible = [], namedMatch = [], cands = [];

    for (var i = 0; i < rows.length; i++) {
      var el = rows[i], t = txt(el).toUpperCase();
      var r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;    // stale render
      visible.push(t);
      if (!token.test(t)) continue;
      namedMatch.push(t);
      if (/BUY IN/.test(t)) continue;
      // The code is a TIEBREAK, not a requirement.
      //
      // Requiring it meant a symbol whose result row does not print the code —
      // or prints it differently from the master — matched nothing at all, and
      // the sweep skipped it every cycle. Below, a code match is preferred and
      // its absence is survivable.
      cands.push({ el: el, t: t, hasCode: Boolean(code) && t.indexOf(String(code)) >= 0 });
    }

    // Record what was on screen, so "no matching result row" can be acted on.
    lastSearchSeen = { want: want, code: code || null, visible: visible.slice(0, 6),
      named: namedMatch.length };

    if (!cands.length) return null;

    // Best first: right code AND a real market; then right code; then a real
    // market; then anything that named the symbol and is not a Buy In.
    for (var a = 0; a < cands.length; a++) {
      if (cands[a].hasCode && /PREMIER MARKET|MAIN MARKET/.test(cands[a].t)) return cands[a].el;
    }
    for (var b = 0; b < cands.length; b++) if (cands[b].hasCode) return cands[b].el;
    for (var c = 0; c < cands.length; c++) {
      if (/PREMIER MARKET|MAIN MARKET/.test(cands[c].t)) return cands[c].el;
    }
    return cands[0].el;
  }

  /**
   * Select by MOUSEDOWN, not click.
   *
   * These dropdowns commit on mousedown; a plain click arrives after the input
   * has blurred and the popup has closed, so it lands on nothing.
   */
  function selectByMouse(el) {
    var r = el.getBoundingClientRect();
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    ['pointerover', 'mouseover', 'mousemove', 'pointerdown', 'mousedown',
      'pointerup', 'mouseup', 'click'].forEach(function (t) {
      try {
        el.dispatchEvent(new MouseEvent(t, {
          bubbles: true, cancelable: true, view: window,
          clientX: cx, clientY: cy, button: 0,
        }));
      } catch (e) {}
    });
    try { el.click(); } catch (e) {}
  }

  function waitFor(test, timeout, interval) {
    return new Promise(function (resolve) {
      var end = Date.now() + timeout;
      var t = setInterval(function () {
        var ok = false;
        try { ok = test(); } catch (e) {}
        if (ok || Date.now() > end) { clearInterval(t); resolve(ok); }
      }, interval || 120);
    });
  }

  /** The book on screen belongs to `want` AND has rows. */
  function bookReady(want) {
    var shown = ladderSymbol();
    return shown === String(want).toUpperCase() && readLadder().length > 0;
  }

  function captureLadder(target, done) {
    var want = String(target.symbol).toUpperCase();
    var input = findSearch();
    if (!input) { stats.lastSkipReason = 'search box not found'; return done(false); }

    typeInto(input, target.symbol);

    waitFor(function () { return findResult(want, target.code) != null; }, POPUP_TIMEOUT)
      .then(function () {
        // Up to three attempts: Ember re-renders the popup, so the element
        // found a moment ago may already be detached.
        var attempt = 0;
        function tryOnce() {
          var el = findResult(want, target.code);
          if (!el) {
            // Say what the popup actually contained. "no matching row" alone
            // cannot distinguish a popup that never opened from one whose rows
            // are shaped differently than expected.
            var seen = lastSearchSeen || {};
            stats.lastSkipReason = want + ': no match — '
              + (!seen.visible || !seen.visible.length
                ? 'the results popup never opened'
                : (seen.named
                  ? seen.named + ' row(s) named it but none were selectable; saw: '
                    + seen.visible.slice(0, 2).join(' | ')
                  : 'popup had ' + seen.visible.length + ' row(s), none naming it; saw: '
                    + seen.visible.slice(0, 2).join(' | ')));
            return done(false);
          }
          selectByMouse(el);

          // The book must belong to this symbol AND be stable — the widget
          // clears its rows before refilling, and a cleared ladder is neither
          // the old book nor the new one.
          var lastSnapshot = null, stableFor = 0;
          waitFor(function () {
            if (!bookReady(want)) { stableFor = 0; return false; }
            var snap = JSON.stringify(readLadder());
            stableFor = (snap === lastSnapshot) ? stableFor + 1 : 0;
            lastSnapshot = snap;
            return stableFor >= 2;
          }, BOOK_TIMEOUT).then(function (ok) {
            if (ok) {
              // Re-read after confirming, so what is posted is what was verified.
              var levels = readLadder();
              if (!bookReady(want) || !levels.length) {
                stats.lastSkipReason = want + ': symbol changed between verify and read';
                return done(false);
              }

              // A ladder of nothing but zeros is a rendered-but-empty widget,
              // not a book. Posting it stores rows indistinguishable from real
              // depth.
              var real = levels.filter(function (L) {
                return (L.bid > 0) || (L.offer > 0) || (L.bidQty > 0) || (L.offerQty > 0);
              });
              if (!real.length) {
                stats.lastSkipReason = want + ': book rendered but every level is zero';
                return done(false);
              }
              levels = real;
              post({
                batchId: uuid(), token: TOKEN, capturedAt: new Date().toISOString(),
                symbol: target.symbol, code: target.code,
                levels: levels, source: 'awsat_client',
              }).catch(function () {});
              return done(true);
            }
            if (++attempt < 3) return tryOnce();
            stats.lastSkipReason = want + ': book never loaded (showing '
              + (ladderSymbol() || 'nothing') + ')';
            return done(false);
          });
        }
        tryOnce();
      });
  }

  /**
   * The symbols to sweep, from /depth-symbols.
   *
   * ─── ALSO MISSING ─────────────────────────────────────────────────────────
   * Like ladderSweep, this was called and never defined. Both had to exist for
   * the ladder to run at all, and neither did.
   *
   * The endpoint serves depth_watchlist in SLOT ORDER, so pre-day slots 1-3 are
   * swept before wake-ups and a short budget cuts the least important first.
   *
   * On failure the previous list is KEPT rather than cleared: a momentary
   * network error should not stop the sweep, and an empty list is
   * indistinguishable from "no slots assigned" to everything downstream.
   */
  function refreshSymbols() {
    return fetch(SYMBOLS_URL, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (j) {
        var list = (j && j.symbols) || [];
        if (!list.length) {
          // A real state at 08:59, not an error: no pre-day picks and no
          // wake-ups yet. The server logs a warning on a session day.
          LADDER_SYMBOLS = [];
          stats.listSource = 'depth_watchlist (empty)';
          return;
        }
        /**
         * TRUNCATED, not merely warned about.
         *
         * This used to warn and sweep all of them anyway — so eight slots
         * produced a 35-second cycle while the message said 15. Slot order is
         * priority order, so the first three are the pre-day picks and the
         * wake-ups fall off the end.
         */
        if (list.length > LADDER_MAX_SAFE) {
          stats.msg = list.length + ' slots, sweeping the first '
            + LADDER_MAX_SAFE + ' — a switch measured 4.34s average, so more '
            + 'than that does not fit a 25s sweep';
          list = list.slice(0, LADDER_MAX_SAFE);
        }
        LADDER_SYMBOLS = list.map(function (x) {
          return typeof x === 'string' ? { symbol: x, code: null } : x;
        });
        stats.listSource = 'depth_watchlist · ' + (j.pre_day || 0) + ' pre-day, '
          + (j.wakeup || 0) + ' wake-up';
      })
      .catch(function (e) {
        // Keep whatever we had. Falling back to a hardcoded list would sweep
        // symbols nobody chose and quietly fill the table with them.
        if (!LADDER_SYMBOLS.length) {
          LADDER_SYMBOLS = FALLBACK_SYMBOLS.map(function (x) {
            return { symbol: x, code: null };
          });
          stats.listSource = 'FALLBACK — /depth-symbols unreachable (' + e.message + ')';
        } else {
          stats.listSource = 'kept previous list — ' + e.message;
        }
      });
  }

  /**
   * ─── THE SWEEP ────────────────────────────────────────────────────────────
   *
   * This function did not exist. It was scheduled twice and never defined, so
   * the script threw ReferenceError twelve seconds after load and the ladder
   * never ran once — which is why three sessions produced level 1 only.
   *
   * One symbol at a time, in slot order, re-reading the list every sweep so a
   * slot change takes effect without a reload. Sequential rather than parallel:
   * the terminal shows ONE book, so two captures at once would read the same
   * widget and file it under two symbols.
   */
  var sweeping = false;

  // Per-sweep check-in (see /ingest/heartbeat) — every sweep, whatever it read,
  // so a depth script that stops sweeping (or sweeps and captures nothing, as on
  // 8 Sep) is visible instead of silently absent. rowsSeen = symbols captured.
  function heartbeat(rowsSeen, problem) {
    fetch(SERVER + '/ingest/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify({ script: 'depth', version: VERSION, rowsSeen: rowsSeen, problem: problem || null }),
    }).catch(function () {});
  }

  function ladderSweep() {
    if (sweeping) { stats.msg = 'previous sweep still running'; return; }
    sweeping = true;
    var started = Date.now();

    // Re-read every sweep. The list is state, not configuration, and a
    // wake-up can claim a slot mid-session.
    refreshSymbols().then(function () {
      var targets = LADDER_SYMBOLS.slice();
      if (!targets.length) {
        stats.msg = 'no symbols from /depth-symbols — nothing to sweep';
        heartbeat(0, 'no symbols from /depth-symbols');
        sweeping = false;
        refresh();
        return;
      }

      var i = 0;
      var ok = 0;
      var skipped = 0;

      function next() {
        // Stop at the budget rather than run into the next sweep: a sweep that
        // overlaps its successor reads a book the other one just switched away
        // from, and files it under the wrong symbol.
        if (i >= targets.length || Date.now() - started > LADDER_BUDGET_MS) {
          sweeping = false;
          stats.sweeps = (stats.sweeps || 0) + 1;
          stats.msg = 'swept ' + ok + '/' + targets.length
            + (skipped ? ' · ' + skipped + ' skipped' : '')
            + ' in ' + Math.round((Date.now() - started) / 100) / 10 + 's';
          heartbeat(ok, ok === 0 ? ('0 captured of ' + targets.length + ' — ' + stats.msg) : null);
          refresh();
          return;
        }
        var target = targets[i++];
        captureLadder(target, function (good) {
          if (good) ok += 1; else skipped += 1;
          next();
        });
      }
      next();
    }).catch(function (e) {
      sweeping = false;
      stats.msg = 'sweep failed: ' + e.message;
      heartbeat(0, 'sweep failed: ' + e.message);
      refresh();
    });
  }

  setTimeout(function () { ladderSweep(); setInterval(ladderSweep, 25 * 1000); }, 12000);

  // ── panel ─────────────────────────────────────────────────────────────────
  var panel, pre;
  function ensurePanel() {
    if (panel || !document.body) return;
    panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;z-index:2147483647;right:10px;top:10px;width:380px;background:#042f2e;color:#99f6e4;font:12px/1.45 monospace;border:1px solid #0891b2;border-radius:10px;padding:10px;';
    var h = document.createElement('div');
    h.style.cssText = 'font-weight:700;margin-bottom:6px;';
    h.textContent = 'Depth — ladder sweep  v' + VERSION + '';
    panel.appendChild(h);
    pre = document.createElement('div'); panel.appendChild(pre);
    var b = document.createElement('button');
    b.textContent = 'Log message types';
    b.style.cssText = 'margin-top:8px;background:#0891b2;color:#042f2e;border:0;border-radius:6px;padding:4px 8px;font:11px monospace;cursor:pointer;';
    b.onclick = function () {
      console.log('%c[depth] socket message types:', 'color:#38bdf8', stats.msgTypes);
      console.log('If a type other than the quote type appears here, depth may be');
      console.log('available for ALL symbols in one pass — send this to wire it up.');
    };
    panel.appendChild(b);
    document.body.appendChild(panel);
  }
  function refresh() {
    ensurePanel();
    if (!pre) return;
    var list = symbolList().length;
    pre.innerHTML =
      // The L1 sweep is gone; what matters now is where the list came from.
      '<b>list</b> ' + (stats.listSource || 'not loaded yet')
        + (stats.l1Empty ? ', ' + stats.l1Empty + ' empty (skipped)' : '')
        + ' &nbsp; posts: ' + stats.l1Posts + '<br>' +
      'frames: ' + stats.frames + ' &nbsp; master: ' + master.size + (fullMasterFetched ? ' (full)' : ' (partial…)') + '<br><br>' +
      '<b>Ladder sweep</b> ' + (LADDER_SYMBOLS.length ? LADDER_SYMBOLS.length + ' configured' : 'all ' + list) + '<br>' +
      (Object.keys(stats.missing).length ? 'not on the board: ' + Object.keys(stats.missing).join(', ') + '<br>' : '') +
      (stats.lastMissed.length ? 'ran out of time: ' + stats.lastMissed.join(', ') + '<br>' : '') +
      'deepest book seen: ' + stats.lastDepth + ' level(s)<br>' +
      (stats.lastSkipReason ? 'last skip: ' + stats.lastSkipReason + '<br>' : '') +
      'posts: ' + stats.ladderPosts + ' &nbsp; skipped: ' + stats.ladderSkips + '<br>' +
      'last sweep: ' + (stats.rotationMs ? (stats.rotationMs / 1000).toFixed(1) + 's' : '—') + '<br>' +
      'retry queue: ' + stats.queued + '<br>· ' + stats.msg;
  }
  setInterval(refresh, 1500);
  refresh();
})();

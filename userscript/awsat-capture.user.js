// ==UserScript==
// @name         AWSAT / DirectFN — Server 1 Capture
// @namespace    local.trading.tools
// @version      2.4.0
// @description  Reads the price socket in the page's own context and submits quotes, depth and orders to Server 1. No second login, no refresh, no scrolling. Credentials never leave the browser.
// @match        *://*.awsatbroker.com/*
// @match        *://awsatbroker.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/**
 * Built on the interception logic that already works in your v1.7 script. What
 * is new is the submission protocol, so the server can be idempotent:
 *
 *   batchId        a UUID per POST. The server replays the stored counts for a
 *                  repeated id, so a retry after a timeout can never double-
 *                  insert and the client needs no special duplicate handling.
 *   Bearer token   sent as a header, not in the body.
 *   retry queue    failed batches are held and re-sent, oldest first, keeping
 *                  their ORIGINAL batchId — a retry that changed its id would
 *                  defeat the idempotency it depends on.
 *
 * The broker password is never read, stored or transmitted. This runs inside a
 * session you already authenticated by hand.
 */
(function () {
  'use strict';

  // ── CONFIG ────────────────────────────────────────────────────────────────
  // The running build, shown on the panel: two scripts both reporting
  // 2.0.0 cost a session diagnosing a bug that was already fixed.
  var VERSION = '2.4.0';

  var SERVER      = 'https://scrapper.99labs.space'; // Server 1 base URL
  var TOKEN       = 'CHANGE-ME';                    // must equal INGEST_TOKEN
  var POST_EVERY_MS = 60 * 1000;
  var MAX_RETRY_QUEUE = 30;                         // ~30 minutes of backlog
  var EQUITIES_ONLY = true;
  // 'B' is the AUCTION market. It was missing from this map, so the raw code
  // leaked into the market column and 57 zero-price symbols were posted every
  // cycle. Premier + Main is the TradingView list exactly (39 + 98 = 137).
  var MARKETS = { P: 'Premier Market', M: 'Main Market', B: 'Auction Market' };
  var KEEP_MARKETS = ['Premier Market', 'Main Market'];   // [] = keep all
  function marketName(id) { return MARKETS[id] || (id ? 'UNKNOWN (' + id + ')' : null); }

  var board = new Map();     // sym -> merged frame
  var master = new Map();    // code -> instrument
  var unmatched = new Set();
  var retryQueue = [];
  var stats = { frames: 0, lastPost: '—', lastResult: '—', masterTries: 0, queued: 0, sent: 0,
    unmatched: 0, masterRefetches: 0, lastRefetch: '—',
    masterState: 'starting' };

  /**
   * ─── THE MASTER GOES STALE AND NOTHING NOTICED ───────────────────────────
   *
   * The symbol master was fetched ONCE at page load. If it came back partial,
   * every symbol missing from it was dropped on every poll for as long as the
   * tab stayed open — ABAR, ACICO, NIND and SOKOUK vanished from the scrape for
   * EIGHT DAYS on 26 July while trading normally.
   *
   * Two triggers, because they catch different failures:
   *
   *   ON UNMATCHED   a symbol arrives the master does not know. Precise, and it
   *                  self-heals within one poll.
   *   EVERY 30 MIN   catches a master that is WRONG rather than incomplete. A
   *                  symbol that changed market or instrument type is still
   *                  "matched", just matched to stale data — and EQUITIES_ONLY
   *                  and KEEP_MARKETS both read from it, so it is filtered out
   *                  with no unmatched symbol to trigger on.
   *
   * THE THROTTLE IS NOT OPTIONAL. A symbol the master will never contain — a
   * delisted code still quoting — would otherwise re-fetch on every poll,
   * forever. This account has a two-login-per-day cap, so a request loop
   * against the broker is worse than the bug it fixes.
   */
  var MASTER_REFETCH_MS = 30 * 60 * 1000;
  var MASTER_THROTTLE_MS = 5 * 60 * 1000;
  var lastMasterFetch = 0;
  var permanentlyUnmatched = {};   // symbols still absent AFTER a fresh fetch

  function maybeRefetchMaster(reason, symbols) {
    var now = Date.now();
    if (now - lastMasterFetch < MASTER_THROTTLE_MS) return;

    // Symbols we have already looked for and failed to find must not keep
    // triggering. Only a genuinely NEW unknown is worth a fetch.
    if (symbols && symbols.length) {
      var novel = symbols.filter(function (s) { return !permanentlyUnmatched[s]; });
      if (!novel.length) return;
    }

    lastMasterFetch = now;
    stats.masterRefetches++;
    stats.lastRefetch = new Date().toISOString().slice(11, 19) + ' (' + reason + ')';

    var before = master.size;
    fetchMaster(function () {
      // Anything still missing after a FRESH master is not a stale-master
      // problem, and re-fetching for it again would be a loop.
      if (symbols) {
        symbols.forEach(function (s) {
          if (!master.get(String(s).toUpperCase())) permanentlyUnmatched[s] = true;
        });
      }
      if (master.size > before) {
        try { console.warn('[capture] master grew ' + before + ' -> ' + master.size
          + ' after re-fetch (' + reason + ')'); } catch (e) {}
      }
    });
  }

  setInterval(function () { maybeRefetchMaster('periodic'); }, MASTER_REFETCH_MS);
  var sampleUrl = null, fullMasterFetched = false;

  function uuid() {
    if (crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'b-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }
  function noteUrl(u) {
    try { if (!sampleUrl && u && /price\?/i.test(String(u))) sampleUrl = String(u); } catch (e) {}
  }

  // ── keep the terminal from logging out in a background tab ────────────────
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
        // ONLY the quote socket. The trading/account socket is left alone.
        if (/wsqs/i.test(url)) {
          try {
            ws.addEventListener('message', function (ev) {
              if (typeof ev.data !== 'string') return;
              var i = ev.data.indexOf('{'); if (i < 0) return;
              var obj; try { obj = JSON.parse(ev.data.slice(i)); } catch (e) { return; }
              stats.frames++;
              if (obj.sym === undefined || obj.sym === null) return;

              // MERGE, never replace: frames are partial, so an ltp-only frame
              // would otherwise wipe volume and bid/ask off the symbol.
              var key = String(obj.sym);
              var cur = board.get(key) || { __fields: {} };
              for (var k in obj) {
                if (k === '1') continue;
                cur[k] = obj[k];
                cur.__fields[k] = Date.now();
              }
              cur.__lastSeen = Date.now();
              board.set(key, cur);
            });
          } catch (e) {}
        }
        return ws;
      },
    });
  } catch (e) {}

  // ── symbol master (XHR + fetch), then an explicit full pull ───────────────
  function ingestMaster(json) {
    if (!json || !json.HED || !json.DAT) return;
    function registerRows(cols, rows) {
      var idx = {}; cols.forEach(function (c, n) { idx[c] = n; });
      if (idx.SYMBOL === undefined) return;
      rows.forEach(function (rowStr) {
        if (typeof rowStr !== 'string') return;
        var f = rowStr.split('|');
        var entry = {
          symbol: (f[idx.SHRT_DSC] || f[idx.SYMBOL] || '').trim() || null,
          code: (idx.COMPANY_CODE !== undefined ? (f[idx.COMPANY_CODE] || '').trim() : '') || (f[idx.SYMBOL] || '').trim() || null,
          description: idx.SYMBOL_DESCRIPTION !== undefined ? (f[idx.SYMBOL_DESCRIPTION] || '').trim() : null,
          market: marketName(f[idx.MARKET_ID]),
          instr: idx.INSTRUMENT_TYPE !== undefined ? (f[idx.INSTRUMENT_TYPE] || '').trim() : '',
        };
        if (!entry.code) return;
        ['SYMBOL', 'SHRT_DSC', 'COMPANY_CODE', 'CFID', 'SERIAL', 'TI'].forEach(function (col) {
          var v = idx[col] !== undefined ? (f[idx[col]] || '').trim() : '';
          if (v) master.set(v.toUpperCase(), entry);
        });
      });
    }
    function scanPair(hed, dat) {
      if (!hed || !dat || typeof hed !== 'object') return;
      for (var k in hed) {
        var cols = hed[k];
        if (typeof cols === 'string' && cols.indexOf('|') >= 0 && Array.isArray(dat[k])) registerRows(cols.split('|'), dat[k]);
        else if (cols && typeof cols === 'object' && dat[k] && typeof dat[k] === 'object') scanPair(cols, dat[k]);
      }
    }
    scanPair(json.HED, json.DAT);
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
          if (!/price\?/i.test(u)) return;
          if (/json/i.test(res.headers.get('content-type') || '')) res.clone().json().then(ingestMaster).catch(function () {});
        }).catch(function () {});
      } catch (e) {}
      return p;
    };
  } catch (e) {}

  // The app's own request carries its cached version, so the reply is a DELTA —
  // a partial list. VRS=0 means "I hold no version, send everything". This runs
  // even when a master is already present, because a partial master silently
  // drops whole markets.
  function buildMasterUrl(u) {
    var x = String(u);
    x = /RT=\d+/.test(x) ? x.replace(/RT=\d+/, 'RT=303') : x + (x.indexOf('?') >= 0 ? '&' : '?') + 'RT=303';
    x = /VRS=\d+/.test(x) ? x.replace(/VRS=\d+/, 'VRS=0') : x + '&VRS=0';
    if (!/[?&]AS=/.test(x)) x += '&AS=1';
    return x.replace(/&?MOD=[^&]*/i, '');
  }
  /**
   * Pull the FULL symbol master.
   *
   * Extracted from the startup loop so a re-fetch can reuse it. The loop below
   * stops once fullMasterFetched is true — which is correct for startup and is
   * exactly why a master that came back partial stayed partial for eight days.
   */
  function fetchMaster(done) {
    if (!sampleUrl) { if (done) done(false); return; }
    try {
      nativeFetch(buildMasterUrl(sampleUrl), { credentials: 'include' })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          ingestMaster(j);
          if (master.size) fullMasterFetched = true;
          refresh();
          if (done) done(true);
        })
        .catch(function () { if (done) done(false); });
    } catch (e) { if (done) done(false); }
  }

  /**
   * ─── IT MUST NEVER GIVE UP ────────────────────────────────────────────────
   *
   * This loop used to stop after eight attempts — sixteen seconds. If the
   * terminal was not logged in by then, sampleUrl had never been observed, the
   * master was never fetched, and every quote was dropped as unmatched. Logging
   * in afterwards changed nothing, because nothing re-armed the loop.
   *
   * Depth and orders need the master too, so all three went quiet together and
   * looked like three separate faults.
   *
   * A userscript sits in a tab for hours across a login, a session timeout and
   * a re-login. Anything that can only happen at startup will eventually happen
   * before the thing it depends on exists.
   *
   * So: keep trying, and back off rather than hammer. Every 2 seconds for the
   * first minute, then every 15 — a fetch that costs nothing while waiting, and
   * does not become a request loop over an eight-hour session.
   */
  var masterWaitStarted = Date.now();

  setInterval(function () {
    if (fullMasterFetched) return;

    if (!sampleUrl) {
      // Not logged in, or no quote request seen yet. Say which, because "no
      // data" and "not logged in" need different actions from whoever is
      // watching the panel.
      stats.masterState = 'waiting for the terminal — no quote request seen yet '
        + '(' + Math.round((Date.now() - masterWaitStarted) / 1000) + 's)';
      return;
    }

    // Slow down after the first minute, but never stop.
    var waited = Date.now() - masterWaitStarted;
    if (waited > 60000 && stats.masterTries % 8 !== 0) { stats.masterTries++; return; }

    stats.masterTries++;
    stats.masterState = 'fetching the symbol master (attempt ' + stats.masterTries + ')';
    fetchMaster(function (ok) {
      if (ok && master.size) {
        stats.masterState = 'master loaded: ' + master.size + ' symbols';
      } else {
        stats.masterState = 'master fetch failed — retrying'
          + (waited > 60000 ? ' every 16s' : ' every 2s');
      }
    });
  }, 2000);

  /**
   * A LOGIN AFTER THE FACT RE-ARMS EVERYTHING.
   *
   * sampleUrl is captured from an observed request, so it appears the moment
   * the terminal starts talking — which is the moment a late login completes.
   * Watching for it is how the script notices, without polling the DOM for a
   * login form whose markup we would have to guess at.
   */
  var sawSampleUrl = false;
  setInterval(function () {
    if (sampleUrl && !sawSampleUrl) {
      sawSampleUrl = true;
      // Reset the backoff: this is a fresh start, not a continuation of a
      // failed one.
      masterWaitStarted = Date.now();
      stats.masterTries = 0;
      fullMasterFetched = false;
      try { console.log('[capture] terminal is talking — fetching the master'); } catch (e) {}
    } else if (!sampleUrl && sawSampleUrl) {
      // It stopped talking: a session timeout, or the tab was left overnight.
      // Re-arm so the next login is picked up.
      sawSampleUrl = false;
      fullMasterFetched = false;
      stats.masterState = 'the terminal stopped responding — waiting for a new session';
    }
  }, 3000);

  // ── build + submit ────────────────────────────────────────────────────────
  function score(r) {
    var k = ['last', 'chg', 'pctChg', 'volume', 'trades', 'open', 'high', 'low', 'bid', 'offer'], n = 0;
    for (var i = 0; i < k.length; i++) { var v = r[k[i]]; if (v !== null && v !== undefined && v !== '' && v !== 0) n++; }
    return n;
  }
  function buildRecords() {
    var byS = new Map();
    unmatched = new Set();
    board.forEach(function (q, sym) {
      var m = master.get(String(sym).toUpperCase());
      if (!m) {
        // Its quotes ARRIVED and are being dropped. That is our failure, not
        // the exchange's, and it is the state ABAR sat in for eight days.
        unmatched.add(sym);
        return;
      }
      if (EQUITIES_ONLY && m.instr && m.instr !== '0') return;
      if (KEEP_MARKETS.length && KEEP_MARKETS.indexOf(m.market) === -1) return;
      var rec = {
        market: m.market, symbol: m.symbol, code: m.code, description: m.description,
        last: q.ltp, chg: q.chg, pctChg: q.pctChg, volume: q.vol, trades: q.trades,
        open: q.open, high: q.high, low: q.low, lutt: q.lutt,
        bid: q.bbp, bidQty: q.bbq, offer: q.bap, offerQty: q.baq,
        lastQty: q.ltq, intrinsicValue: q.intsV, session: q.sname, nms: q.nms,
      };
      var key = String(m.symbol || m.code || sym).toUpperCase();
      var ex = byS.get(key);
      if (!ex || score(rec) > score(ex)) byS.set(key, rec);
    });
    return Array.from(byS.values());
  }

  function submit(batch) {
    return nativeFetch(SERVER + '/ingest/' + batch.kind, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify(batch.body),
    }).then(function (r) {
      // 4xx other than 401 means the payload is wrong; retrying an identical
      // bad payload forever only fills the queue. 401 and 5xx are worth
      // retrying — a rotated token or a restarting server both recover.
      if (r.status >= 400 && r.status < 500 && r.status !== 401) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          throw Object.assign(new Error(j.error || ('HTTP ' + r.status)), { permanent: true });
        });
      }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function flushQueue() {
    if (!retryQueue.length) return Promise.resolve();
    var batch = retryQueue[0];
    return submit(batch).then(function () {
      retryQueue.shift();                       // only on success
      stats.queued = retryQueue.length;
      return flushQueue();                      // oldest first, in order
    }).catch(function (e) {
      if (e.permanent) { retryQueue.shift(); stats.queued = retryQueue.length; }
    });
  }

  var SCRIPT_NAME = 'awsat-capture';

  /*
   * P2 · AN UNEDITED TOKEN REFUSES, LOUDLY, INSTEAD OF 401-LOOPING.
   *
   * This ships 'CHANGE-ME' while awsat-orders and awsat-depth-all ship the real
   * default. A tab installed and not edited posts with a token the server
   * rejects — and 401 is deliberately retryable, so the retry queue fills to
   * MAX_RETRY_QUEUE and then DROPS THE OLDEST MINUTE, every minute. The
   * heartbeat 401s too, so the server sees nothing at all: not a broken client,
   * not a silent one, nothing. It looks exactly like a tab that was never
   * opened.
   *
   * A configuration that cannot work should say so once, not fail invisibly
   * four hundred times.
   */
  var TOKEN_PLACEHOLDER = TOKEN === 'CHANGE-ME' || !TOKEN;
  if (TOKEN_PLACEHOLDER) {
    try {
      console.error('[%s] TOKEN is still "%s" — edit it to match INGEST_TOKEN on '
        + 'the server. NOTHING will be posted until you do.', SCRIPT_NAME, TOKEN);
    } catch (e) {}
  }

  function post(kind, body) {
    if (TOKEN_PLACEHOLDER) {
      stats.lastResult = 'NOT POSTING — TOKEN is still CHANGE-ME. Edit it to '
        + 'match INGEST_TOKEN on the server.';
      refresh();
      return Promise.resolve();
    }
    // The batchId is created ONCE and kept across retries. Regenerating it
    // would make every retry look like new data to the server and defeat the
    // idempotency this depends on.
    var batch = { kind: kind, body: Object.assign({ batchId: uuid() }, body) };
    return submit(batch).then(function (j) {
      stats.lastPost = new Date().toLocaleTimeString();
      stats.sent += (j && j.inserted) || 0;
      stats.lastResult = kind + ': offered ' + (j.offered || 0) + ' inserted ' + (j.inserted || 0)
        + (j.duplicate ? ' (duplicate replayed)' : '') + (j.rejected ? ' rejected ' + j.rejected : '');
      refresh();
    }).catch(function (e) {
      if (!e.permanent) {
        if (retryQueue.length >= MAX_RETRY_QUEUE) retryQueue.shift();   // drop oldest
        retryQueue.push(batch);
        stats.queued = retryQueue.length;
      }
      stats.lastResult = kind + ' failed: ' + e.message + (e.permanent ? ' (not retried)' : ' — queued');
      refresh();
    });
  }

  // Per-cycle check-in (see /ingest/heartbeat) — every cycle, records or not,
  // so a quotes script that stops (or sees an empty board) is visible instead of
  // silently absent. rowsSeen = symbols built this cycle.
  function heartbeat(rowsSeen, problem) {
    nativeFetch(SERVER + '/ingest/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify({ script: 'quotes', version: VERSION, rowsSeen: rowsSeen, problem: problem || null }),
    }).catch(function () {});
  }

  function cycle() {
    flushQueue();                               // backlog first
    var records = buildRecords();
    if (!records.length) {
      stats.lastResult = 'nothing to send (' + board.size + ' raw / ' + master.size + ' master)';
      heartbeat(0, 'nothing to send (' + board.size + ' raw / ' + master.size + ' master)');
      refresh(); return;
    }
    heartbeat(records.length, null);            // alive, with N symbols

    /*
     * P2 · THE UNMATCHED LIST IS SENT, AND THE MASTER IS RE-FETCHED ON IT.
     *
     * Two dead paths for one failure mode, and it is the failure mode this file
     * was written for.
     *
     * 1 · The POST omitted `unmatched` entirely. The SERVER reads
     *     body.unmatched and marks those instruments UNMATCHED — the path
     *     test/suites/unmatched-reporting.test.js proves end to end. It had no
     *     producer. The server's own comment on that handler reads: "The panel
     *     showed 'unmatched: 11' and nobody read it. A number in a UI…" — and
     *     this client still put it only in the panel.
     *
     * 2 · maybeRefetchMaster's documented ON UNMATCHED trigger — "a symbol
     *     arrives the master does not know. Precise, and it self-heals within
     *     one poll" — had no call site. Only the 30-minute periodic timer
     *     called it, and with NO symbols, so `novel` was always empty and
     *     permanentlyUnmatched was never written: wholly dead code.
     *
     * ABAR, ACICO, NIND and SOKOUK sat in exactly this state for eight days.
     * Their quotes arrived on the socket, the master did not know them, they
     * were dropped — and recovery waited up to thirty minutes per occurrence
     * instead of one poll, with instruments.broker_status never set, so the
     * loss was invisible in the database and to /health. Visible only to
     * somebody reading a number on a browser panel.
     */
    var missing = [];
    unmatched.forEach(function (s) { missing.push(s); });
    if (missing.length) maybeRefetchMaster('unmatched', missing);

    post('quotes', {
      capturedAt: new Date().toISOString(),
      source: 'awsat_client',
      records: records,
      unmatched: missing,
    });
  }
  setInterval(cycle, POST_EVERY_MS);

  // ── panel ─────────────────────────────────────────────────────────────────
  var panel, pre;
  function btn(label, fn) {
    var b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'margin:2px 0 0 6px;background:#1d4ed8;color:#fff;border:0;border-radius:6px;padding:4px 8px;cursor:pointer;font:11px monospace;';
    b.onclick = fn; return b;
  }
  function ensurePanel() {
    if (panel || !document.body) return;
    panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;z-index:2147483647;right:10px;bottom:10px;width:340px;background:#0f172a;color:#e2e8f0;font:12px/1.45 monospace;border:1px solid #334155;border-radius:10px;padding:10px;';
    var h = document.createElement('div');
    h.style.cssText = 'font-weight:600;margin-bottom:6px;';
    h.textContent = 'Server 1 Capture  v' + VERSION + '';
    panel.appendChild(h);
    pre = document.createElement('div'); panel.appendChild(pre);
    var bar = document.createElement('div');
    bar.appendChild(btn('Post now', cycle));
    bar.appendChild(btn('Health', function () {
      nativeFetch(SERVER + '/ingest/health', { headers: { Authorization: 'Bearer ' + TOKEN } })
        .then(function (r) { return r.json(); })
        .then(function (j) { stats.lastResult = 'health: ' + JSON.stringify(j); refresh(); })
        .catch(function (e) { stats.lastResult = 'health unreachable: ' + e.message; refresh(); });
    }));
    panel.appendChild(bar);
    document.body.appendChild(panel);
  }
  function refresh() {
    ensurePanel();
    if (!pre) return;
    var matched = 0; board.forEach(function (q, s) { if (master.get(String(s).toUpperCase())) matched++; });
    pre.innerHTML =
      'frames: <b>' + stats.frames + '</b> &nbsp; symbols: <b>' + board.size + '</b> mapped: <b>' + matched + '</b><br>' +
      'master rows: <b>' + master.size + '</b>' + (fullMasterFetched ? ' (full)' : ' (partial — fetching…)') + '<br>' +
      'unmatched: ' + unmatched.size + ' &nbsp; retry queue: <b>' + stats.queued + '</b><br>' +
      'inserted total: <b>' + stats.sent + '</b><br>' +
      'last post: ' + stats.lastPost + '<br>' + 'result: ' + stats.lastResult;
  }
  setInterval(refresh, 1500);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refresh); else refresh();
})();

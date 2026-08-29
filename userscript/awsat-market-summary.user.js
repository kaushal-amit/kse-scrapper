// ==UserScript==
// @name         AWSAT / DirectFN — Market Summary Capture
// @namespace    local.trading.tools
// @version      1.3.0
// @description  Reads the top-panel market summary (Index, Volume, Turnover, Trades, YTD %, Symbols Traded, UPs, Down, Unchanged) once a minute and submits it to Server 1.
// @match        *://*.awsatbroker.com/*
// @match        *://awsatbroker.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/**
 * Same submission protocol as awsat-capture.user.js v2:
 *
 *   batchId        a UUID per POST; the server replays stored counts for a
 *                  repeated id, so a retry can never double-insert.
 *   Bearer token   sent as a header, not in the body.
 *   retry queue    failed batches re-sent oldest first, keeping their ORIGINAL
 *                  batchId. The server rejects capturedAt older than 15
 *                  minutes, so a long outage drains as permanent 400s —
 *                  correct, since a stale summary stored under a fresh minute
 *                  is worse than a gap.
 */
(function () {
  'use strict';

  // ── CONFIG ────────────────────────────────────────────────────────────────
  var SERVER          = 'https://scrapper.99labs.space';
  var TOKEN           = 'CHANGE-ME';               // must equal INGEST_TOKEN
  var POST_EVERY_MS   = 60 * 1000;
  var MAX_RETRY_QUEUE = 30;
  var SKIP_UNCHANGED  = false;
  // ──────────────────────────────────────────────────────────────────────────

  var LABELS = {
    'Volume':         'volume',
    'Turnover':       'turnover',
    'Trades':         'trades',
    'YTD %':          'ytdPct',
    'Symbols Traded': 'symbolsTraded',
    'UPs':            'ups',
    'Down':           'down',
    'Unchanged':      'unchanged',
  };

  var retryQueue = [];
  var lastKey = null;
  var stats = { lastPost: '—', lastResult: '—', sent: 0, queued: 0, skipped: 0 };

  function uuid() {
    if (crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'b-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }

  function parseNum(text) {
    if (text == null) return null;
    var cleaned = String(text).replace(/\u2212/g, '-').replace(/[,%\s]/g, '');
    var n = parseFloat(cleaned);
    return isNaN(n) ? null : n;
  }

  function collectDocs(doc, acc) {
    acc.push(doc);
    var frames = doc.querySelectorAll('iframe, frame');
    for (var i = 0; i < frames.length; i++) {
      try { if (frames[i].contentDocument) collectDocs(frames[i].contentDocument, acc); } catch (e) {}
    }
    return acc;
  }

  function readValue(labelDiv) {
    var sib = labelDiv.previousElementSibling;
    var v = sib ? parseNum(sib.textContent) : null;
    if (v !== null) return v;
    var p = labelDiv.parentElement;
    if (p) {
      var el = p.querySelector('div.font-l');
      if (el) return parseNum(el.textContent);
    }
    return null;
  }

  /**
   * ─── THE INDEX LEVEL HAS NO LABEL ─────────────────────────────────────────
   * Volume, Trades and the rest render as value-then-label pairs, so the label
   * finds the value. The index — 9,302.73 — sits alone above its change figure
   * with no text beside it, so the label sweep never sees it and the payload
   * carried YTD % without the level it applies to.
   *
   * Found by shape instead: the largest number with a decimal point in the
   * header strip, above 1,000. The index runs in the thousands; the change
   * (-18.74) and percentage (-0.20) do not, and Volume and Turnover are
   * integers. If the exchange ever renumbers the index below 1,000 this stops
   * finding it — it returns null rather than guessing, and index_close is
   * nullable for that reason.
   */
  function readIndex(docs) {
    var best = null;
    for (var d = 0; d < docs.length; d++) {
      var nodes = docs[d].querySelectorAll('div.font-l, span.font-l, div.bold');
      for (var i = 0; i < nodes.length; i++) {
        var t = (nodes[i].textContent || '').trim();
        if (!/^[\d,]+\.\d+$/.test(t)) continue;      // must carry a decimal
        var n = parseNum(t);
        if (n === null || n < 1000) continue;         // the index is in the thousands
        if (best === null || n > best) best = n;
      }
    }
    return best;
  }

  function scrape() {
    var docs = collectDocs(document, []);
    var data = {};
    var matched = [];
    for (var d = 0; d < docs.length; d++) {
      var labelDivs = docs[d].querySelectorAll('div.font-m.fade-fore-color');
      for (var i = 0; i < labelDivs.length; i++) {
        var label = labelDivs[i].textContent.trim();
        var key = LABELS[label];
        if (!key) continue;
        matched.push(labelDivs[i]);
        // A null never claims a key: the SPA keeps a hidden copy of the panel
        // with EMPTY value divs, and locking in the first match meant always
        // reading that one.
        if (data[key] !== undefined && data[key] !== null) continue;
        data[key] = readValue(labelDivs[i]);
      }
    }
    data.indexClose = readIndex(docs);
    var values = 0;
    for (var k in data) if (data[k] !== null) values++;
    return { data: data, labelsMatched: matched, values: values };
  }

  var debugDumped = false;
  function dumpDebug(matched) {
    if (debugDumped || !matched.length) return;
    debugDumped = true;
    var html = matched.map(function (el) {
      var p = el.parentElement || el;
      return (p.parentElement || p).outerHTML;
    }).join('\n\n────────\n\n').slice(0, 500000);
    fetch(SERVER + '/ingest/debug', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify({ items: [{ source: 'market-summary-labels', d: html }] }),
    }).catch(function () {});
  }

  function submit(batch) {
    return fetch(SERVER + '/ingest/market-summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify(batch.body),
    }).then(function (r) {
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
      retryQueue.shift();
      stats.queued = retryQueue.length;
      return flushQueue();
    }).catch(function (e) {
      if (e.permanent) { retryQueue.shift(); stats.queued = retryQueue.length; }
    });
  }

  function post(body) {
    var batch = { body: Object.assign({ batchId: uuid() }, body) };
    return submit(batch).then(function (j) {
      stats.lastPost = new Date().toLocaleTimeString();
      stats.sent += (j && j.inserted) || 0;
      stats.lastResult = 'inserted ' + (j.inserted || 0) + (j.duplicate ? ' (duplicate replayed)' : '');
      refresh();
    }).catch(function (e) {
      if (!e.permanent) {
        if (retryQueue.length >= MAX_RETRY_QUEUE) retryQueue.shift();
        retryQueue.push(batch);
        stats.queued = retryQueue.length;
      }
      stats.lastResult = 'failed: ' + e.message + (e.permanent ? ' (not retried)' : ' — queued');
      refresh();
    });
  }

  function cycle() {
    flushQueue();
    var r = scrape();
    if (!r.labelsMatched.length) { stats.lastResult = 'panel not found'; refresh(); return; }
    if (!r.values) {
      dumpDebug(r.labelsMatched);
      stats.lastResult = 'labels found, NO values — HTML dumped to /ingest/debug';
      refresh(); return;
    }
    if (SKIP_UNCHANGED) {
      var key = JSON.stringify(r.data);
      if (key === lastKey) {
        stats.skipped++;
        stats.lastResult = 'unchanged — skipped (' + stats.skipped + ')';
        refresh(); return;
      }
      lastKey = key;
    }
    post({
      capturedAt: new Date().toISOString(),
      source: 'awsat_client',
      summary: r.data,
      fieldsFound: r.values,   // 9 = complete
    });
  }
  setInterval(cycle, POST_EVERY_MS);
  setTimeout(cycle, 10 * 1000);

  var panel, pre;
  function ensurePanel() {
    if (panel || !document.body) return;
    panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;z-index:2147483647;right:10px;bottom:10px;width:260px;'
      + 'background:#0f172a;color:#e2e8f0;font:12px/1.45 monospace;border:1px solid #334155;'
      + 'border-radius:10px;padding:10px;';
    var h = document.createElement('div');
    h.style.cssText = 'font-weight:600;margin-bottom:6px;';
    h.textContent = 'Market Summary Capture';
    panel.appendChild(h);
    pre = document.createElement('div');
    panel.appendChild(pre);
    var b = document.createElement('button');
    b.textContent = 'Post now';
    b.style.cssText = 'margin-top:4px;background:#1d4ed8;color:#fff;border:0;border-radius:6px;'
      + 'padding:4px 8px;cursor:pointer;font:11px monospace;';
    b.onclick = function () { lastKey = null; cycle(); };
    panel.appendChild(b);
    document.body.appendChild(panel);
  }
  function refresh() {
    ensurePanel();
    if (!pre) return;
    pre.innerHTML = 'inserted total: <b>' + stats.sent + '</b><br>'
      + 'retry queue: <b>' + stats.queued + '</b><br>'
      + 'last post: ' + stats.lastPost + '<br>'
      + 'result: ' + stats.lastResult;
  }
  setInterval(refresh, 1500);
  refresh();
})();

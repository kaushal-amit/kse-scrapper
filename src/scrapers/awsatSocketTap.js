'use strict';
/**
 * AWSAT — read the price WebSocket instead of the rendered table.
 *
 * ─── WHY THIS REPLACES THE DOM SCRAPER ─────────────────────────────────────
 * The Ember cells are a RENDERING of socket frames. The field names give it
 * away: the DOM carries `cell-id="dataObj.ltp"` and the socket frame carries
 * `ltp`. Same for chg, pctChg, vol, bbp, bbq, bap, baq, ltq, open, high, low,
 * trades, sname, nms.
 *
 * Reading the render instead of the source is what created every problem we
 * chased on this scraper:
 *
 *   virtualised rows          only the visible slice exists in the DOM
 *   the 250px blind band      a fixed wheel step skipped the same 5 symbols
 *                             every single run
 *   market-switch dropdowns   needed only because the table shows one market
 *   left/right block joins    two DOM blocks that must be paired by style.top
 *   scroll stalls and caps    hundreds of wheel events per capture
 *
 * None of that exists at the socket. Every symbol arrives, in both markets, with
 * no scrolling, no dropdown, and no pairing. The client-side userscript already
 * works this way; this is the same tap, injected through Playwright.
 *
 * ─── WHAT IS STILL REQUIRED FROM THE PAGE ──────────────────────────────────
 * The socket only carries a numeric `sym` code. Turning that into a ticker needs
 * the symbol master, which arrives over XHR as pipe-delimited rows — so that is
 * tapped too, and re-requested explicitly with VRS=0 ("I have no version, send
 * everything") because the app caches it and may never re-fetch.
 */

const log = require('../logger');

/**
 * Installed BEFORE any page script runs, via addInitScript.
 *
 * document-start matters: the terminal constructs its WebSocket during startup,
 * and a proxy installed afterwards never sees it. Everything is buffered on
 * `window.__awsatTap` for the Node side to drain.
 */
function tapSource() {
  if (window.__awsatTap) return;

  const tap = {
    board: new Map(),        // sym code -> latest merged frame
    master: new Map(),       // code/ticker -> { symbol, code, description, market, instr }
    frames: 0,
    lastFrameAt: null,
    masterRows: 0,

    /**
     * A census of EVERY message type on the socket, not just the quote frames.
     *
     * The quote type is the only one being consumed, so anything else — depth,
     * order activity, index ticks — currently arrives and is discarded without
     * a trace. That is why "does depth come over the socket?" could not be
     * answered from a log: nothing was recording the answer.
     *
     * Per type: how many frames, which field names appeared, and a couple of
     * whole sample frames. Samples are capped because these are kept in page
     * memory for a whole session.
     */
    msgTypes: {},
    sockets: [],
    sampleUrl: null,
    masterTries: 0,
    fullMasterFetched: false,
  };
  window.__awsatTap = tap;

  /**
   * MARKET_ID -> the market's name.
   *
   * 'B' is the AUCTION market — symbols that do not trade continuously. It was
   * missing, so the raw code leaked into the market column and 57 zero-price
   * rows were stored per cycle, inflating every count and every coverage check.
   *
   * An unknown code now becomes 'UNKNOWN (<code>)' rather than the bare code,
   * so it is obviously a gap in this map rather than a market name nobody
   * recognises.
   */
  const MARKETS = { P: 'Premier Market', M: 'Main Market', B: 'Auction Market' };
  const marketName = (id) => MARKETS[id] || (id ? `UNKNOWN (${id})` : null);

  /**
   * Which markets to keep. Premier + Main is the TradingView watchlist exactly
   * (39 + 98 = 137); the auction market is extra and is excluded by default.
   */
  const KEEP_MARKETS = new Set(['Premier Market', 'Main Market']);

  const noteUrl = (u) => {
    try {
      if (!tap.sampleUrl && u && /price\?/i.test(String(u))) tap.sampleUrl = String(u);
    } catch { /* ignore */ }
  };

  // ── the price socket ──────────────────────────────────────────────────────
  try {
    const Native = window.WebSocket;
    window.WebSocket = new Proxy(Native, {
      construct(T, a) {
        const url = String(a[0] || '');
        let ws;
        try { ws = new T(a[0], a[1]); } catch { ws = new T(a[0]); }

        // Note EVERY socket the app opens. If depth arrives on a second socket
        // rather than a second message type, only this shows it — and the wsqs
        // filter below would hide it completely.
        try {
          tap.sockets.push({ url: url.slice(0, 200), tapped: /wsqs/i.test(url), at: Date.now() });
        } catch { /* ignore */ }
        // ONLY the quote socket. The trading/account socket carries order
        // activity and must not be touched.
        if (/wsqs/i.test(url)) {
          try {
            ws.addEventListener('message', (ev) => {
              if (typeof ev.data !== 'string') return;
              const i = ev.data.indexOf('{');
              if (i < 0) return;
              let obj;
              try { obj = JSON.parse(ev.data.slice(i)); } catch { return; }
              tap.frames += 1;
              tap.lastFrameAt = Date.now();

              // Census first, so a frame is recorded even when it is not a
              // quote and gets dropped two lines below.
              const type = String(obj['1'] === undefined ? 'none' : obj['1']);
              const seen = tap.msgTypes[type] || (tap.msgTypes[type] = {
                count: 0, fields: {}, samples: [],
              });
              seen.count += 1;
              for (const k of Object.keys(obj)) seen.fields[k] = (seen.fields[k] || 0) + 1;
              if (seen.samples.length < 3) {
                seen.samples.push(JSON.stringify(obj).slice(0, 600));
              }
              if (obj.sym === undefined || obj.sym === null) return;
              // Frames are PARTIAL: each carries only the fields that changed,
              // so they must be merged onto what is already known rather than
              // replacing it. Replacing is how a symbol ends up with a price
              // and no volume.
              const key = String(obj.sym);
              const cur = tap.board.get(key) || { __firstSeen: Date.now(), __fields: {} };

              for (const k of Object.keys(obj)) {
                if (k === '1') continue;
                cur[k] = obj[k];
                // WHEN each field last changed, not just when the symbol was
                // last touched. A symbol can keep receiving bid/ask churn while
                // its price has not moved for an hour — one timestamp per
                // symbol cannot tell those apart, and "the feed is alive" is
                // not the same claim as "this price is current".
                cur.__fields[k] = Date.now();
              }
              cur.__lastSeen = Date.now();
              tap.board.set(key, cur);
            });
          } catch { /* ignore */ }
        }
        else {
          // Not the quote socket. Do NOT parse or store its payloads — the
          // trading/account socket carries order activity and is not ours to
          // read. Counting frames is enough to prove it exists and is busy.
          try {
            const entry = tap.sockets[tap.sockets.length - 1];
            ws.addEventListener('message', () => { entry.frames = (entry.frames || 0) + 1; });
          } catch { /* ignore */ }
        }
        return ws;
      },
    });
  } catch { /* ignore */ }

  // ── the symbol master, over XHR and fetch ─────────────────────────────────
  const ingestMaster = (json) => {
    if (!json || !json.HED || !json.DAT) return;

    const registerRows = (colNames, rows) => {
      const idx = {};
      colNames.forEach((c, n) => { idx[c] = n; });
      if (idx.SYMBOL === undefined) return;

      rows.forEach((rowStr) => {
        if (typeof rowStr !== 'string') return;
        const f = rowStr.split('|');
        const entry = {
          symbol: (f[idx.SHRT_DSC] || f[idx.SYMBOL] || '').trim() || null,
          code: (idx.COMPANY_CODE !== undefined ? (f[idx.COMPANY_CODE] || '').trim() : '')
            || (f[idx.SYMBOL] || '').trim() || null,
          description: idx.SYMBOL_DESCRIPTION !== undefined
            ? (f[idx.SYMBOL_DESCRIPTION] || '').trim() : null,
          market: marketName(f[idx.MARKET_ID]),
          instr: idx.INSTRUMENT_TYPE !== undefined ? (f[idx.INSTRUMENT_TYPE] || '').trim() : '',
        };
        if (!entry.code) return;
        // The socket's `sym` may be any of these identifiers depending on the
        // frame, so every one is registered as a lookup key.
        for (const col of ['SYMBOL', 'SHRT_DSC', 'COMPANY_CODE', 'CFID', 'SERIAL', 'TI']) {
          const v = idx[col] !== undefined ? (f[idx[col]] || '').trim() : '';
          if (v) tap.master.set(v.toUpperCase(), entry);
        }
      });
    };

    const scanPair = (hed, dat) => {
      if (!hed || !dat || typeof hed !== 'object') return;
      for (const k of Object.keys(hed)) {
        const cols = hed[k];
        if (typeof cols === 'string' && cols.includes('|') && Array.isArray(dat[k])) {
          registerRows(cols.split('|'), dat[k]);
        } else if (cols && typeof cols === 'object' && dat[k] && typeof dat[k] === 'object') {
          scanPair(cols, dat[k]);
        }
      }
    };

    scanPair(json.HED, json.DAT);
    tap.masterRows = tap.master.size;
  };
  window.__awsatIngestMaster = ingestMaster;

  try {
    const XO = XMLHttpRequest.prototype.open;
    const XS = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) { this.__u = u; noteUrl(u); return XO.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function () {
      try {
        this.addEventListener('load', () => {
          try {
            if (!/price\?/i.test(this.__u || '')) return;
            if (/json/i.test(this.getResponseHeader('content-type') || '')) {
              ingestMaster(JSON.parse(this.responseText));
            }
          } catch { /* ignore */ }
        });
      } catch { /* ignore */ }
      return XS.apply(this, arguments);
    };
  } catch { /* ignore */ }

  const nativeFetch = window.fetch;
  window.__awsatFetch = nativeFetch;
  try {
    window.fetch = function (input, init) {
      try { noteUrl(typeof input === 'string' ? input : (input && input.url)); } catch { /* ignore */ }
      const p = nativeFetch.apply(this, arguments);
      try {
        p.then((res) => {
          const u = typeof input === 'string' ? input : (input && input.url) || '';
          if (!/price\?/i.test(u)) return;
          if (/json/i.test(res.headers.get('content-type') || '')) {
            res.clone().json().then(ingestMaster).catch(() => {});
          }
        }).catch(() => {});
      } catch { /* ignore */ }
      return p;
    };
  } catch { /* ignore */ }

  // ── pull the FULL master explicitly ───────────────────────────────────────
  // The app caches it, so it may never re-request. VRS=0 means "I hold no
  // version, send everything"; MOD is dropped because it restricts the reply to
  // watchlist mode, and we want every listed symbol.
  const buildMasterUrl = (u) => {
    let x = String(u);
    x = /RT=\d+/.test(x) ? x.replace(/RT=\d+/, 'RT=303') : `${x}${x.includes('?') ? '&' : '?'}RT=303`;
    x = /VRS=\d+/.test(x) ? x.replace(/VRS=\d+/, 'VRS=0') : `${x}&VRS=0`;
    if (!/[?&]AS=/.test(x)) x += '&AS=1';
    return x.replace(/&?MOD=[^&]*/i, '');
  };

  // The explicit VRS=0 fetch happens EVEN IF a master has already arrived.
  //
  // Gating it on `master.size` being zero was wrong: the app's own request
  // carries its cached version (VRS=7 or similar), and the reply is then only
  // the DELTA — a partial list. A partial master is worse than none, because
  // every symbol missing from it becomes an "unmatched code" and silently
  // vanishes from the board.
  //
  // Measured against a fixture reproducing that shape: the app's cached reply
  // gave 2 of 9 symbols, and because 2 > 0 the full fetch never ran. Only
  // Premier came through and Main was missing entirely.
  setInterval(() => {
    if (tap.fullMasterFetched || !tap.sampleUrl || tap.masterTries >= 8) return;
    tap.masterTries += 1;
    try {
      nativeFetch(buildMasterUrl(tap.sampleUrl), { credentials: 'include' })
        .then((r) => r.json())
        .then((j) => {
          ingestMaster(j);
          // Only counts as done once it actually yielded rows; a failed or
          // empty reply must be retried.
          if (tap.master.size) tap.fullMasterFetched = true;
        })
        .catch(() => {});
    } catch { /* ignore */ }
  }, 2000);
}

/** Install the tap on a context. Must be called BEFORE navigation. */
async function install(context) {
  await context.addInitScript(tapSource);
  log.info('awsat: socket tap installed (runs at document-start)');
}

/**
 * Drain the tap: join live frames to the symbol master.
 *
 * Returns plain rows keyed by ticker. Unmatched codes are reported rather than
 * dropped silently — a rising unmatched count means the master is stale, which
 * would otherwise look like symbols disappearing from the board.
 */
async function readBoard(target, {
  equitiesOnly = true,
  staleAfterMs = Number(process.env.AWSAT_STALE_AFTER_MS || 5 * 60_000),
  keepMarkets = (process.env.AWSAT_KEEP_MARKETS || 'Premier Market,Main Market')
    .split(',').map((m) => m.trim()).filter(Boolean),
} = {}) {
  return target.evaluate((opts) => {
    const tap = window.__awsatTap;
    if (!tap) return { ready: false, frames: 0, masterRows: 0, rows: [], unmatched: [] };
    const nowMs = Date.now();

    const unmatched = [];
    const skippedByMarket = [];
    const byTicker = new Map();

    // Keep the RICHEST record for a ticker: a frame read mid-update can carry
    // only one changed field, and the fuller one is the better row.
    const score = (r) => ['last', 'chg', 'pctChg', 'volume', 'trades', 'open', 'high', 'low', 'bid', 'offer']
      .filter((k) => r[k] !== null && r[k] !== undefined && r[k] !== '' && r[k] !== 0).length;

    tap.board.forEach((q, sym) => {
      const m = tap.master.get(String(sym).toUpperCase());
      if (!m) { unmatched.push(String(sym)); return; }
      if (opts.equitiesOnly && m.instr && m.instr !== '0') return;
      // Auction and any unmapped market are excluded unless asked for.
      if (opts.keepMarkets && !opts.keepMarkets.includes(m.market)) {
        skippedByMarket.push(m.market);
        return;
      }

      const now = Date.now();
      // lutt is the EXCHANGE's last-trade time; __lastSeen is when we received
      // anything at all. They answer different questions and both are kept.
      const priceAgeMs = q.__fields && q.__fields.ltp ? now - q.__fields.ltp : null;

      const rec = {
        market: m.market, symbol: m.symbol, code: m.code, description: m.description,
        receivedAt: q.__lastSeen ? new Date(q.__lastSeen).toISOString() : null,
        priceAgeMs,
        stale: priceAgeMs !== null && priceAgeMs > opts.staleAfterMs,
        last: q.ltp, chg: q.chg, pctChg: q.pctChg, volume: q.vol, trades: q.trades,
        open: q.open, high: q.high, low: q.low, lutt: q.lutt,
        bid: q.bbp, bidQty: q.bbq, offer: q.bap, offerQty: q.baq,
        lastQty: q.ltq, intrinsicValue: q.intsV, session: q.sname, nms: q.nms,
      };
      const key = String(m.symbol || m.code || sym).toUpperCase();
      const prev = byTicker.get(key);
      if (!prev || score(rec) > score(prev)) byTicker.set(key, rec);
    });

    const rows = [...byTicker.values()];
    const staleRows = rows.filter((r) => r.stale);

    return {
      ready: true,
      frames: tap.frames,
      masterRows: tap.master.size,
      rows,
      unmatched: unmatched.slice(0, 20),
      unmatchedCount: unmatched.length,
      // Reported, never dropped: a stale price is still the last known price,
      // and discarding it would turn a flat symbol into a gap.
      skippedByMarket: skippedByMarket.length,
      staleCount: staleRows.length,
      staleSymbols: staleRows.map((r) => r.symbol).slice(0, 20),
      oldestPriceMs: rows.reduce((m, r) => Math.max(m, r.priceAgeMs || 0), 0),
      lastFrameAgeMs: tap.lastFrameAt ? nowMs - tap.lastFrameAt : null,
    };
  }, { equitiesOnly, staleAfterMs, keepMarkets });
}

/**
 * Wait until the tap has both frames and a symbol master.
 *
 * Both are required: frames alone give numeric codes with no tickers, and a
 * master alone gives tickers with no prices. Returning early with one of them
 * looks like a working scrape that stores nothing usable.
 */
async function waitForData(target, { timeoutMs = 60_000, minRows = 1 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = { frames: 0, masterRows: 0, rows: [] };

  while (Date.now() < deadline) {
    last = await readBoard(target).catch(() => last);

    // Wait for the FULL master, not merely for some rows to join. Returning as
    // soon as anything matches yields whatever subset the app had cached — a
    // board that looks populated and is missing a whole market.
    const fullMaster = await target.evaluate(
      () => Boolean(window.__awsatTap && window.__awsatTap.fullMasterFetched),
    ).catch(() => false);

    if (last.ready && last.rows.length >= minRows && fullMaster) return last;
    await new Promise((r) => setTimeout(r, 1_000));
  }

  if (last.ready && last.rows.length) {
    // Deadline reached with a partial master. Return what there is, but say so:
    // silently short data is the failure this whole file exists to avoid.
    log.warn('awsat: returning board before the full symbol master arrived — '
      + 'some symbols may be missing', {
      rows: last.rows.length, masterRows: last.masterRows, unmatched: last.unmatchedCount,
    });
  }
  return last;
}

/**
 * Everything the socket revealed: message types, their fields, sample frames,
 * and which sockets the app opened.
 *
 * This is the answer to "does depth arrive over the socket, and under which
 * message type?" — a measurement rather than a guess.
 */
async function discover(target) {
  return target.evaluate(() => {
    const tap = window.__awsatTap;
    if (!tap) return { ready: false };

    const types = {};
    for (const [type, v] of Object.entries(tap.msgTypes)) {
      types[type] = {
        count: v.count,
        // Ordered by how often each field appeared: the ones present on nearly
        // every frame of a type are that type's real shape.
        fields: Object.entries(v.fields).sort((a, b) => b[1] - a[1])
          .map(([k, n]) => `${k}(${n})`),
        samples: v.samples,
      };
    }

    return {
      ready: true,
      frames: tap.frames,
      masterRows: tap.master.size,
      boardSymbols: tap.board.size,
      sockets: tap.sockets,
      messageTypes: types,
    };
  });
}

module.exports = { install, readBoard, waitForData, discover, tapSource };

'use strict';
/**
 * Client → Server ingest API.
 *
 * The Tampermonkey userscript runs in the trader's own authenticated AWSAT
 * session and POSTs what it reads. It never sees the server's database and the
 * server never sees the broker credentials — that separation is the whole point
 * of the client-side collector, so nothing here asks for or stores them.
 *
 * ─── WHY A SHARED TOKEN AND NOT REQUEST SIGNING ────────────────────────────
 * The userscript is readable by anyone who can open the Tampermonkey editor, so
 * an HMAC secret embedded in it is a shared secret in name only. A bearer token
 * over HTTPS is the same security property with none of the false confidence,
 * and the endpoints are write-only into a quarantined path. Signing would be
 * worth adding if the client were ever compiled or the token per-device.
 *
 * ─── IDEMPOTENCY ───────────────────────────────────────────────────────────
 * The client retries. A retry arriving after the original succeeded must not
 * insert twice, so the client's batch id is the idempotency key: seen before,
 * the stored counts are replayed and nothing is written. The client gets the
 * same answer either way and needs no special handling for the duplicate case.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config } = require('../config');
const repo = require('../db/repositories');
const { query } = require('../db/pool');
const clock = require('../market/clock');
const marketMetrics = require('../jobs/marketDayMetrics');
const symbolCheck = require('../reconcileSymbols');
const validate = require('../validate');
const parse = require('../scrapers/parse');
const log = require('../logger');

/** Precedence: see 003_ingest_source.sql for why the client outranks the server. */
const PRECEDENCE = { awsat_client: 2, awsat_server: 1, tradingview: 0 };

const MAX_BATCH_ROWS = Number(process.env.INGEST_MAX_ROWS || 2_000);

/**
 * Constant-time token comparison.
 *
 * A plain === leaks the token's length and prefix through timing. It is a small
 * leak and it costs one function call to close.
 */
function tokenMatches(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Reject a capture timestamp that is not plausibly now.
 *
 * A batch stamped hours ago is either a client that sat in a background tab or
 * a replay. Either way it must not be written as current market data: a stale
 * quote stored under a fresh minute is worse than a gap, because nothing
 * downstream can tell it is stale.
 */
function checkCapturedAt(raw, maxSkewMs = 15 * 60_000) {
  if (!raw) return { ok: true, capturedAt: new Date() };   // absent is tolerated
  const t = new Date(raw);
  if (Number.isNaN(t.getTime())) return { ok: false, reason: 'capturedAt is not a valid timestamp' };

  const skew = Date.now() - t.getTime();
  if (skew > maxSkewMs) {
    return { ok: false, reason: `capturedAt is ${Math.round(skew / 1000)}s old (limit ${maxSkewMs / 1000}s)` };
  }
  if (skew < -60_000) {
    return { ok: false, reason: 'capturedAt is in the future' };
  }
  return { ok: true, capturedAt: t };
}

/** Already-processed batch? Replay its result rather than inserting again. */
async function replayIfSeen(batchId) {
  if (!batchId) return null;
  const { rows } = await query(
    `SELECT rows_offered, rows_inserted, rows_rejected, received_at
       FROM client_submissions WHERE batch_id = $1`, [batchId]);
  if (!rows.length) return null;
  return {
    ok: true,
    duplicate: true,
    offered: rows[0].rows_offered,
    inserted: rows[0].rows_inserted,
    rejected: rows[0].rows_rejected,
    firstReceivedAt: rows[0].received_at,
  };
}

async function recordSubmission(batchId, kind, source, capturedAt, counts) {
  if (!batchId) return;
  await query(
    `INSERT INTO client_submissions
       (batch_id, ingest_source, kind, captured_at, rows_offered, rows_inserted, rows_rejected)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (batch_id) DO NOTHING`,
    [batchId, source, kind, capturedAt, counts.offered, counts.inserted, counts.rejected],
  ).catch((err) => log.error('could not record client submission', { batchId, err: err.message }));
}

/** Map the userscript's camelCase record onto awsat_market_quotes columns. */
function toQuoteRow(r, meta) {
  const symbol = parse.toSymbol(r.symbol || r.code);
  if (!symbol) return null;

  const n = (v, signed = false) => {
    const x = parse.toNumber(v);
    if (x === null) return null;
    return (!signed && x < 0) ? Math.abs(x) : x;
  };

  return {
    scrape_batch_id: null,
    market: r.market || 'UNKNOWN',
    symbol,
    code: r.code ? String(r.code).trim() : null,
    description: r.description || null,
    last_price: n(r.last),
    last_qty: n(r.lastQty),
    chg: n(r.chg, true),          // chg and pctChg are legitimately negative
    pct_chg: n(r.pctChg, true),
    volume: n(r.volume),
    bid: n(r.bid),
    bid_qty: n(r.bidQty),
    offer: n(r.offer),
    offer_qty: n(r.offerQty),
    trades: n(r.trades),
    last_trade_date: null,
    last_trade_time: parse.toTime(r.lutt),
    open_price: n(r.open),
    high_price: n(r.high),
    low_price: n(r.low),
    session: r.session || null,
    nms: n(r.nms),
    trading_date: meta.tradingDate,
    source: 'awsat',
    ingest_source: meta.source,
    source_precedence: PRECEDENCE[meta.source] ?? 0,
    captured_at: meta.capturedAt,
    run_id: null,
    created_at: meta.capturedAt,
  };
}

function createRouter() {
  const router = express.Router();
  const TOKEN = process.env.INGEST_TOKEN || '';

  /**
   * CORS. Without it nothing from the terminal ever arrives.
   *
   * The userscript runs on https://www.awsatbroker.com and posts cross-origin.
   * With no Access-Control-Allow-Origin the browser discards the response and
   * fetch() rejects with "NetworkError when attempting to fetch resource" —
   * which looks like the server being down, and leaves NO trace in the server
   * log because the request either never left or its answer was thrown away.
   *
   * INGEST_ORIGIN restricts it; '*' is the default because these endpoints are
   * already token-authenticated and write-only, and an origin allowlist that
   * silently blocks the one browser you are testing from is its own trap.
   */
  const ORIGIN = process.env.INGEST_ORIGIN || '*';
  router.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', ORIGIN);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-ingest-token');
    res.set('Access-Control-Max-Age', '86400');
    // Answer the preflight here. Falling through would hit the auth middleware,
    // which returns 401 — and a 401 on the OPTIONS makes the POST never happen.
    if (req.method === 'OPTIONS') return res.status(204).end();
    return next();
  });

  /**
   * Bodies sent as text/plain are parsed here.
   *
   * A POST with Content-Type: application/json is a "preflighted" request: the
   * browser sends OPTIONS first and only proceeds if that succeeds. text/plain
   * is a SIMPLE request — no preflight, one round trip, and nothing to
   * misconfigure. The client may send either.
   */
  router.use((req, res, next) => {
    if (typeof req.body === 'string' && req.body.length) {
      try { req.body = JSON.parse(req.body); } catch { /* leave it; validated below */ }
    }
    return next();
  });

  // Auth on every ingest route. Mounted as middleware rather than repeated per
  // handler, so a route added later cannot forget it.
  router.use((req, res, next) => {
    // These two return no market data and are fetched before the client has
    // any reason to hold a token.
    if (req.method === 'GET' && (req.path === '/depth-symbols' || req.path === '/health')) {
      return next();
    }
    if (!TOKEN) {
      return res.status(503).json({
        ok: false,
        error: 'ingest disabled: INGEST_TOKEN is not set on the server',
      });
    }
    const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const provided = bearer || req.get('x-ingest-token') || (req.body && req.body.token);
    if (!tokenMatches(provided, TOKEN)) {
      // Say what was actually received. "unauthorized" alone sends people
      // looking at the transport when the value simply differs.
      log.warn('ingest rejected: bad token', {
        ip: req.ip,
        path: req.path,
        sentVia: bearer ? 'Authorization header'
          : req.get('x-ingest-token') ? 'x-ingest-token header'
            : (req.body && req.body.token) ? 'body.token' : 'nothing sent',
        tokenLength: provided ? String(provided).length : 0,
        expectedLength: TOKEN.length,
      });
      return res.status(401).json({
        ok: false,
        error: 'unauthorized — the token does not match INGEST_TOKEN on the server',
        hint: provided
          ? 'a token was sent but does not match; check AUTH_TOKEN in the userscript'
          : 'no token was sent in the Authorization header, x-ingest-token, or the body',
      });
    }
    return next();
  });

  /**
   * Client submissions are accepted only in client mode.
   *
   * The other half of the guarantee: with the server scraping, a userscript
   * someone forgot to disable would keep posting and both sides would be
   * collecting the same board at once. Refusing here means the mode setting
   * cannot be half-applied.
   *
   * 409 rather than 403: the request is well-formed and authorised, it simply
   * conflicts with how the system is configured — and the message says which
   * way to resolve it.
   */
  router.use((req, res, next) => {
    if (req.path === '/health' || req.path === '/depth-symbols') return next();
    if (config.awsat.mode === 'client') return next();
    return res.status(409).json({
      ok: false,
      error: `AWSAT_MODE=${config.awsat.mode} — client submissions are not accepted. `
        + 'Set AWSAT_MODE=client to collect from the browser instead of the server.',
      mode: config.awsat.mode,
    });
  });

  /**
   * GET /depth-symbols — the stocks the client should sweep, server-driven.
   *
   * The list lives here rather than in the userscript so it can change without
   * anyone editing a Tampermonkey file in a browser. Order is significant: the
   * client works through it in order and stops at its time budget, so the most
   * important stocks belong first.
   *
   * Source, in order of preference:
   *   DEPTH_SYMBOLS      an explicit list, when specific stocks are wanted
   *   the day's watchlist  otherwise, capped — a full ladder costs ~0.9s, so a
   *                        list longer than the minute allows is a list that
   *                        silently never finishes.
   *
   * No auth: it returns no market data, only which tickers to look at, and the
   * client fetches it before it has any reason to hold a token.
   */
  router.get('/depth-symbols', async (req, res) => {
    try {
      // The schema this endpoint depends on. A 500 rather than an empty list:
      // an empty list at 08:59 is legitimate, and an empty list because a table
      // is missing is a failure. If the two look identical, the failure stays
      // invisible until someone notices nothing was captured all day.
      await require('../db/preflight').check('/depth-symbols', {
        depth_watchlist: ['trading_date', 'slot_no', 'symbol', 'slot_type', 'released_at'],
      }, { quiet: true });
    } catch (err) {
      log.error('depth-symbols: schema check failed', { err: err.message });
      return res.status(500).json({ ok: false, error: err.message, symbols: [] });
    }

    const day = clock.tradingDay();
    try {
      // THE STATE, from depth_watchlist. Slot order is priority order: the
      // client sweeps in order and stops at its time budget, so pre-day slots
      // 1-3 are swept before wake-ups.
      /*
       * The sweep list — TRADEABLE symbols only.
       *
       * ─── THREE FILTERS, TWO COLUMNS, DELIBERATELY DIFFERENT ────────────────────
       *
       *   symbol_day        is_primary      history keeps a delisted stock
       *   market_day        is_tradeable    breadth excludes it
       *   /depth-symbols    is_tradeable    never sweep it
       *
       * A symbol is primary but NOT tradeable for two distinct reasons: it sits on
       * the Auction Market, or it is DELISTED. Both are correct. is_primary is never
       * set false by either — BAREEQ keeps its 8 sessions in symbol_day and simply
       * stops counting in breadth.
       *
       * This looks like an inconsistency and is not one. Do not "fix" it.
       */
      const { rows } = await query(`
        SELECT w.slot_no, w.symbol, w.slot_type,
               i.code, i.is_tradeable, i.broker_status, i.market
          FROM depth_watchlist w
          LEFT JOIN LATERAL (
            SELECT code, is_tradeable, broker_status, market FROM instruments
             WHERE symbol = w.symbol LIMIT 1
          ) i ON true
         WHERE w.trading_date = $1 AND w.symbol IS NOT NULL AND w.released_at IS NULL
           -- NEVER OFFER A SLOT TO A SYMBOL THAT CANNOT BE TRADED.
           --
           -- Delisted, or on the auction market: sweeping its book costs one of
           -- eight slots and returns something nobody can act on. Unknown
           -- symbols are kept — a new listing has no registry row yet.
           AND NOT EXISTS (
             SELECT 1 FROM instruments i2
              WHERE i2.symbol = w.symbol AND i2.is_tradeable = false)
         ORDER BY w.slot_no`, [day]);

      // A slot can be held by a symbol that has since become untradeable.
      // Silently shrinking the list from 8 to 7 is exactly the class of thing
      // that goes unnoticed for a month, so each drop is named with its reason.
      const usable = [];
      for (const r of rows) {
        if (r.is_tradeable === false) {
          const why = r.broker_status === 'DELISTED' ? 'DELISTED'
            : r.market === 'Auction Market' ? 'Auction Market' : 'not primary';
          logDroppedOnce(day, r.symbol, why);
          continue;
        }
        usable.push(r);
      }

      const preDay = usable.filter((r) => r.slot_type === 'PRE_DAY').length;
      if (!preDay && clock.isTradingDay(new Date())) {
        // A warning, not a failure: no pre-day picks is a legitimate choice,
        // and the day runs on wake-ups alone. Silent would be wrong.
        log.warn('depth-symbols: no PRE_DAY slots on a session day', {
          day,
          note: 'seed them with scripts/seed-depth-slots.js, or the day runs on wake-ups only',
        });
      }

      return res.json({
        symbols: usable.map((r) => ({ symbol: r.symbol, code: r.code, slot: r.slot_no })),
        source: 'depth_watchlist',
        trading_date: day,
        pre_day: preDay,
        wakeup: usable.length - preDay,
        dropped: rows.length - usable.length,
      });
    } catch (err) {
      log.error('depth-symbols failed', { err: err.message });
      return res.status(500).json({ ok: false, error: err.message, symbols: [] });
    }
  });

  /** Liveness for the userscript's panel. */
  /**
   * Liveness — and WHICH DATABASE this instance writes to.
   *
   * A client posting successfully to an instance nobody can find is not a
   * hypothetical: 140 quotes, 135 depth and 14 orders were accepted and appear
   * in neither database being queried, not even in client_submissions. The
   * rows went somewhere; nothing said where.
   *
   * The answer has to come from the process doing the writing, because that is
   * the only thing that knows. No credentials are returned — database, host and
   * port identify an instance without exposing how to reach it.
   */
  router.get('/health', async (_req, res) => {
    let db = { reachable: false };
    try {
      const { rows } = await query(
        `SELECT current_database() AS database,
                inet_server_addr()::text AS host,
                inet_server_port() AS port,
                (SELECT count(*) FROM client_submissions
                  WHERE received_at > now() - interval '24 hours')::int AS submissions_24h,
                (SELECT count(*) FROM awsat_market_quotes
                  WHERE trading_date = CURRENT_DATE)::int AS quotes_today`);
      db = { reachable: true, ...rows[0] };
    } catch (err) {
      db = { reachable: false, error: err.message };
    }

    return res.json({
      ok: true,
      at: new Date().toISOString(),
      tradingDay: clock.tradingDay(),
      awsatMode: config.awsat.mode,
      acceptingClientData: config.awsat.mode === 'client',
      pid: process.pid,
      // Where the rows this instance accepts actually land.
      db,
    });
  });

  /**
   * POST /market-summary — the broker's own top-panel figures.
   *
   * ─── ONE ROW PER DAY, LAST CAPTURE WINS ────────────────────────────────
   * The script posts every minute. Nothing reads a minute-by-minute breadth
   * series, and 260 near-identical rows a day is storage without a consumer,
   * so each capture overwrites the day's row.
   *
   * The broker's six shared figures REPLACE the computed ones and stamp
   * broker_seen_at, which is what stops the next backfill putting a
   * reconstruction back over the exchange's own count.
   */
  router.post('/market-summary', async (req, res) => {
    const started = Date.now();
    const body = req.body || {};
    const summary = body.summary || {};

    const when = checkCapturedAt(body.capturedAt);
    if (!when.ok) return res.status(400).json({ ok: false, error: when.error });

    const num = (v) => {
      if (v === null || v === undefined || v === '') return null;
      const n = parse.toNumber(v);
      return n === null || !Number.isFinite(n) ? null : n;
    };
    const int = (v) => { const n = num(v); return n === null ? null : Math.round(n); };

    const advancing = int(summary.ups);
    const declining = int(summary.down);
    const symbols = int(summary.symbolsTraded);

    // An all-null summary is a selector failure, not data. PERMANENT so the
    // client stops retrying and dumps the markup instead.
    if (advancing === null && declining === null && symbols === null) {
      return res.status(400).json({
        ok: false,
        error: 'every breadth figure was null — the panel selectors have moved',
      });
    }

    try {
      const replay = await replayIfSeen(body.batchId);
      if (replay) {
        log.info('ingest: duplicate market summary replayed', { batchId: body.batchId });
        return res.json(replay);
      }

      /**
       * WHICH SESSION DO THESE FIGURES DESCRIBE?
       *
       * From days that ACTUALLY TRADED. The earlier rule asked
       * awsat_market_quotes for the newest trading_date at or before the
       * capture — and gave two different answers ten minutes apart, because a
       * quote row dated the 28th arrived in between. The same panel wrote to
       * two different days' rows.
       *
       * A derivation that changes as unrelated data arrives is not a
       * derivation. market_day only holds sessions that produced volume, so it
       * cannot move under a capture.
       */
      /**
       * The comparison is done in SQL, not in JavaScript.
       *
       * ─── WHY ────────────────────────────────────────────────────────────
       * The driver returns trading_date as a Date object, and
       * String(new Date(...)) gives "Fri Aug 28 2026 21:00:00 GMT+0000". Slicing
       * ten characters off that yields "Fri Aug 2", which can never equal
       * "2026-08-29" — so isSessionDay was ALWAYS false and every capture filed
       * as STALE, whenever it was taken.
       *
       * daily.marketday skips STALE rows, so the broker's breadth would never
       * have reached market_day. It would have looked like the scraper was not
       * posting, while it posted perfectly and was filed wrong.
       *
       * Comparing ::date to ::date in SQL removes the class of error: no Date
       * object reaches a string comparison, and no timezone is applied twice.
       */
      const { rows: sess } = await query(
        `SELECT trading_date::text AS trading_date,
                (trading_date = ($1::timestamptz AT TIME ZONE 'Asia/Kuwait')::date)
                  AS is_session_day
           FROM market_day
          WHERE trading_date <= ($1::timestamptz AT TIME ZONE 'Asia/Kuwait')::date
            AND COALESCE(total_volume, 0) > 0
          ORDER BY trading_date DESC LIMIT 1`, [when.capturedAt]);

      const captured = new Date(when.capturedAt);
      const tradingDate = sess.length ? sess[0].trading_date : clock.tradingDay();
      const isSessionDay = sess.length ? sess[0].is_session_day : false;

      /**
       * LIVE before 13:30 Kuwait, CLOSE at or after, STALE off-session.
       *
       * Deliberately NOT "the last capture of the day is the close": that would
       * promote a session that stopped at 12:23 to a complete one. A truncated
       * session gets no CLOSE row at all, which is the truth — nobody captured
       * the close — and market_day falls back to computing.
       */
      const kuwaitMinutes = (() => {
        const k = new Date(captured.getTime() + 3 * 3600_000);   // UTC+3, no DST
        return k.getUTCHours() * 60 + k.getUTCMinutes();
      })();
      const sessionState = !isSessionDay ? 'STALE'
        : (kuwaitMinutes >= 13 * 60 + 30 ? 'CLOSE' : 'LIVE');

      const res2 = await query(`
        INSERT INTO awsat_market_summary
          (captured_at, trading_date, session_state, symbols_traded, advancing,
           declining, unchanged, total_volume, total_trades, turnover_kd,
           index_close, index_ytd_pct, fields_found, batch_id, source)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'awsat_client')
        ON CONFLICT (captured_at) DO NOTHING
        RETURNING captured_at`,
      [when.capturedAt, tradingDate, sessionState, symbols, advancing, declining,
        int(summary.unchanged), int(summary.volume), int(summary.trades),
        num(summary.turnover), num(summary.indexClose), num(summary.ytdPct),
        body.fieldsFound ?? null, body.batchId ?? null]);

      const counts = { offered: 1, inserted: res2.rowCount, rejected: 0 };
      await recordSubmission(body.batchId, 'market-summary', 'awsat_client', when.capturedAt, counts);
      await logRun('ingest.marketsummary', tradingDate, counts, started);

      if (sessionState === 'STALE') {
        log.info('ingest: market summary stored as STALE', {
          capturedOn: captured.toISOString().slice(0, 10), describes: tradingDate,
          note: 'a shut market shows the LAST session — stored and marked, not discarded',
        });
      }

      // NOTE: market_day is NOT written here. One writer per table —
      // daily.marketday reads the last non-STALE capture of the session.
      return res.json({
        ok: true, ...counts, trading_date: tradingDate, session_state: sessionState,
      });
    } catch (err) {
      log.error('ingest: market summary failed', { err: err.message });
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * Record what happened to a symbol in the scrape.
   *
   * first_seen_on and last_seen_on answer "when did we last see data". They
   * cannot tell a suspension from a master that came back incomplete, and on
   * 26 July those two looked identical for eight days.
   *
   * Only writes when the status CHANGES, so scrape_status_on is the date it
   * changed rather than the date it was last confirmed — which is what makes
   * "UNMATCHED since 26 July" distinguishable from "UNMATCHED since today".
   */
  /**
   * Once per symbol per day. The endpoint is polled every 15 seconds; saying it
   * every time would bury it, and saying it once per process would hide it
   * after a restart.
   */
  const droppedSeen = new Map();
  function logDroppedOnce(day, symbol, why) {
    const key = `${day}|${symbol}`;
    if (droppedSeen.has(key)) return;
    droppedSeen.clear();          // yesterday's keys are of no use
    droppedSeen.set(key, true);
    log.warn(`depth-symbols: dropped ${symbol} from the sweep — is_tradeable false (${why})`,
      { symbol, reason: why, day });
  }

  async function markBrokerStatus(symbols, status) {
    if (!symbols.length) return;
    try {
      await query(
        `UPDATE instruments
            SET broker_status = $2,
                broker_status_on = CURRENT_DATE,
                updated_at = now()
          WHERE symbol = ANY($1)
            -- Only on a CHANGE, so broker_status_on is the date it changed
            -- rather than the date it was last confirmed.
            AND broker_status IS DISTINCT FROM $2
            -- DELISTED is a fact set by hand. The ingest path must never
            -- overwrite it, or BAREEQ flips to ABSENT on the first quiet day
            -- and starts triggering re-fetches again.
            AND COALESCE(broker_status, '') <> 'DELISTED'`,
        [symbols.map((s) => String(s).toUpperCase()), status]);
    } catch (err) {
      // Never fail a batch over an audit column.
      log.warn('could not record broker_status', { status, err: err.message });
    }
  }

  /**
   * One scrape_runs row per accepted batch.
   *
   * Same scraper-name shape as every other job, so a single query answers "did
   * everything run today" across scheduled jobs and pushed feeds alike.
   *
   * Never throws: a failure to LOG a batch must not reject the batch. The rows
   * are already stored, and losing the audit line is a smaller loss than losing
   * a trading minute.
   */
  async function logRun(scraper, tradingDate, counts, started) {
    try {
      await repo.recordRun(scraper, tradingDate, {
        status: counts.rejected > 0 ? 'PARTIAL' : 'SUCCESS',
        rowsExtracted: counts.offered ?? 0,
        rowsInserted: counts.inserted ?? 0,
        durationMs: started ? Date.now() - started : null,
      });
    } catch (err) {
      log.warn('could not record the ingest run', { scraper, err: err.message });
    }
  }

  /**
   * POST /debug — diagnostic dumps from the client.
   *
   * The userscripts post the widget's HTML here when a grid is found but yields
   * no rows. Without the endpoint those dumps 404ed silently, so the one
   * artifact that explains a selector failure was being thrown away at exactly
   * the moment it was needed.
   *
   * Written to ./tmp rather than the database: it is markup for a human to
   * read once, not data to query.
   */
  router.post('/debug', (req, res) => {
    const body = req.body || {};
    const items = Array.isArray(body.items) ? body.items : [{ source: 'unknown', d: body }];

    try {
      const dir = path.resolve(__dirname, '..', '..', 'tmp');
      fs.mkdirSync(dir, { recursive: true });
      const written = [];
      for (const item of items) {
        const tag = String(item.source || 'debug').replace(/[^\w.-]/g, '_').slice(0, 60);
        const file = path.join(dir, `client-${tag}-${Date.now()}.txt`);
        const payload = typeof item.d === 'string' ? item.d : JSON.stringify(item.d, null, 2);
        fs.writeFileSync(file, String(payload).slice(0, 2_000_000), 'utf8');
        written.push(file);
      }
      log.warn('client posted a debug dump', { count: written.length, files: written });
      return res.json({ ok: true, written: written.length, files: written });
    } catch (err) {
      log.error('could not store the debug dump', { err: err.message });
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * POST /ingest/quotes
   * { batchId?, capturedAt, source?, records: [...] }
   */
  router.post('/quotes', async (req, res) => {
    // Arrival time, for duration_ms on the run row.
    const started = Date.now();
    const body = req.body || {};
    const source = body.source === 'awsat_server' ? 'awsat_server' : 'awsat_client';
    const batchId = body.batchId || body.batch_id || null;

    if (!Array.isArray(body.records)) {
      return res.status(400).json({ ok: false, error: 'records must be an array' });
    }
    if (body.records.length > MAX_BATCH_ROWS) {
      return res.status(413).json({
        ok: false, error: `batch too large: ${body.records.length} rows (max ${MAX_BATCH_ROWS})`,
      });
    }

    const when = checkCapturedAt(body.capturedAt);
    if (!when.ok) return res.status(400).json({ ok: false, error: when.reason });

    try {
      const replay = await replayIfSeen(batchId);
      if (replay) {
        log.info('ingest: duplicate batch replayed', { batchId, source });
        return res.json(replay);
      }

      const meta = {
        source, capturedAt: when.capturedAt, tradingDate: clock.tradingDay(when.capturedAt),
      };

      const mapped = [];
      let malformed = 0;
      for (const r of body.records) {
        const row = toQuoteRow(r, meta);
        if (row) mapped.push(row); else malformed += 1;
      }

      const checked = validate.validateAll(mapped, validate.validateQuote, 'ingest/quotes');

      // Register instruments first, exactly as the server-side path does.
      await repo.upsertSymbols(mapped.map((r) => ({
        market: r.market, symbol: r.symbol, code: r.code, description: r.description,
      })));

      const result = await repo.insertQuotes(checked.rows);
      const counts = {
        offered: body.records.length,
        inserted: result.inserted,
        rejected: malformed + checked.rejected + result.rejected,
      };

      /**
       * UNMATCHED SYMBOLS — quotes that arrived and were dropped.
       *
       * ─── WHY THIS IS A WARN WITH NAMES ─────────────────────────────────
       * The panel showed "unmatched: 11" and nobody read it. A number in a UI
       * nobody watches is the same as no signal — ABAR, ACICO, NIND and SOKOUK
       * left the scrape on 26 July and it took a month to notice.
       *
       * Named symbols in the server log are greppable, alertable, and land in
       * the same place as every other failure.
       */
      const unmatched = Array.isArray(body.unmatched) ? body.unmatched.filter(Boolean) : [];
      if (unmatched.length) {
        log.warn('ingest: symbols DROPPED — not in the client symbol master', {
          count: unmatched.length,
          symbols: unmatched.slice(0, 25),
          source,
          note: 'their quotes arrived and were discarded. This is our failure, '
            + 'not a suspension — the client should be re-fetching its master.',
        });
        await markBrokerStatus(unmatched, 'UNMATCHED');
      }

      // Everything that DID store is captured. Recorded so a symbol leaving the
      // scrape is a state change with a date, not an absence nobody can date.
      const captured = [...new Set(mapped.map((r) => r.symbol).filter(Boolean))];
      if (captured.length) await markBrokerStatus(captured, 'CAPTURED');

      await recordSubmission(batchId, 'quotes', source, when.capturedAt, counts);
      // The quotes handler derives a per-row trading_date from each record's
      // capture time; the RUN belongs to the session it arrived in.
      await logRun('ingest.quotes', clock.tradingDay(), counts, started);
      log.info('ingest: quotes accepted', { source, batchId, ...counts });

      // Every cycle, per the consistency requirement. Reported, never blocking:
      // a short capture is still worth storing, and refusing it would turn a
      // reporting problem into a data-loss one.
      const coverage = await symbolCheck
        .check(new Set(mapped.map((r) => r.symbol)), { source })
        .catch((err) => {
          log.warn('symbol reconciliation failed', { err: err.message });
          return null;
        });

      return res.json({
        ok: true,
        duplicate: false,
        ...counts,
        coverage: coverage && coverage.checked ? {
          expected: coverage.expected,
          matched: coverage.matched,
          missing: coverage.missing,
          pct: coverage.coveragePct,
        } : undefined,
      });
    } catch (err) {
      log.error('ingest: quotes failed', { err: log.serializeError(err) });
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * POST /ingest/depth
   * { batchId?, capturedAt, symbol, levels: [{ level, bid, bidQty, offer, offerQty }] }
   */
  router.post('/depth', async (req, res) => {
    // Arrival time, for duration_ms on the run row.
    const started = Date.now();
    const body = req.body || {};
    const batchId = body.batchId || null;
    // The client sends `records`; earlier examples used `levels`. Accepting
    // both costs one line and removes a whole class of 400 that looks like an
    // auth or routing problem from the browser side.
    const levelsIn = Array.isArray(body.levels) ? body.levels
      : (Array.isArray(body.records) ? body.records : null);

    if (!levelsIn) {
      return res.status(400).json({
        ok: false, error: 'expected an array in "levels" or "records"',
      });
    }

    // TWO SHAPES, one endpoint.
    //
    //   one symbol   { symbol, levels: [{ level, bid, ... }] }      full ladder
    //   many symbols { levels: [{ symbol, level, bid, ... }] }      level 1 for
    //                                                              the market
    //
    // The second is how all 135 symbols fit inside the 1.5-minute ceiling: the
    // socket carries best bid/offer for every symbol at once, so a whole-market
    // level-1 sweep is a single batch rather than 135 round trips.
    const batchSymbol = parse.toSymbol(body.symbol);
    const perRowSymbols = levelsIn.some((l) => l && l.symbol);

    if (!batchSymbol && !perRowSymbols) {
      return res.status(400).json({
        ok: false,
        error: 'provide a batch-level "symbol", or a "symbol" on each level',
      });
    }
    if (levelsIn.length > MAX_BATCH_ROWS) {
      return res.status(413).json({
        ok: false, error: `batch too large: ${levelsIn.length} rows (max ${MAX_BATCH_ROWS})`,
      });
    }

    const when = checkCapturedAt(body.capturedAt);
    if (!when.ok) return res.status(400).json({ ok: false, error: when.reason });

    try {
      const replay = await replayIfSeen(batchId);
      if (replay) return res.json(replay);

      const tradingDate = clock.tradingDay(when.capturedAt);
      let malformed = 0;
      const mapped = [];
      levelsIn.forEach((l, i) => {
        const rowSymbol = parse.toSymbol(l.symbol) || batchSymbol;
        // A level with no symbol on it and no batch symbol cannot be stored
        // against anything, so it is counted rather than guessed at.
        if (!rowSymbol) { malformed += 1; return; }
        mapped.push({
        symbol: rowSymbol,
        // Trust the client's level when given; otherwise position in the array.
        level: Number.isInteger(l.level) ? l.level : i + 1,
        // bidPrice/offerPrice are what the terminal script emits; bid/offer
        // were the earlier shape. Both name the same cell.
        bid: parse.toNumber(l.bid ?? l.bidPrice),
        bid_qty: parse.toNumber(l.bidQty),
        bid_orders: parse.toNumber(l.bidOrders),
        ingest_source: 'awsat_client',
        // The client's own capture instant, not ours. All ten levels of one
        // book carry the same value and that is what groups them.
        captured_at: when.capturedAt,
        code: l.code ?? body.code ?? null,
        offer: parse.toNumber(l.offer ?? l.offerPrice ?? l.ask ?? l.askPrice),
        offer_qty: parse.toNumber(l.offerQty ?? l.askQty),
        offer_orders: parse.toNumber(l.offerOrders ?? l.askOrders),
        trading_date: tradingDate,
        run_id: null,
        created_at: when.capturedAt,
        });
      });

      // Counted separately from other rejections: an empty book is a symbol
      // with no live market, not a broken payload, and conflating the two hides
      // whichever is actually happening.
      const empties = mapped.filter((m) => validate.isEmptyBook(m)).length;

      const checked = validate.validateAll(mapped, validate.validateDepthLevel, 'ingest/depth');
      const result = await repo.insertDepth(checked.rows);
      const counts = {
        offered: levelsIn.length,
        inserted: result.inserted,
        rejected: malformed + checked.rejected + result.rejected,
        emptyBooks: empties,
      };

      if (empties === levelsIn.length && levelsIn.length > 1) {
        // The whole batch was empty. Worth a warning: it means the ladder never
        // loaded, or the market is closed, and silently storing nothing looks
        // the same as never having been called.
        log.warn('ingest: every depth level in this batch was an empty book', {
          rows: levelsIn.length,
          note: 'no bid, offer or quantity on any level — market closed, or the '
            + 'book never loaded for these symbols',
        });
      }

      const symbols = new Set(mapped.map((m) => m.symbol));
      await recordSubmission(batchId, 'depth', 'awsat_client', when.capturedAt, counts);
      await logRun('ingest.depth', tradingDate, counts, started);
      log.info('ingest: depth accepted', { symbols: symbols.size, batchId, ...counts });
      return res.json({ ok: true, duplicate: false, symbols: symbols.size, ...counts });
    } catch (err) {
      log.error('ingest: depth failed', { err: log.serializeError(err) });
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * POST /ingest/orders
   * { batchId?, capturedAt, orders: [{ orderId, symbol, side, status, price, quantity, filled }] }
   */
  router.post('/orders', async (req, res) => {
    // Arrival time, for duration_ms on the run row.
    const started = Date.now();
    const body = req.body || {};
    const batchId = body.batchId || null;

    const ordersIn = Array.isArray(body.orders) ? body.orders
      : (Array.isArray(body.records) ? body.records : null);

    if (!ordersIn) {
      return res.status(400).json({
        ok: false, error: 'expected an array in "orders" or "records"',
      });
    }

    const when = checkCapturedAt(body.capturedAt);
    if (!when.ok) return res.status(400).json({ ok: false, error: when.reason });

    try {
      const replay = await replayIfSeen(batchId);
      if (replay) return res.json(replay);

      const tradingDate = clock.tradingDay(when.capturedAt);
      const mapped = [];
      let malformed = 0;

      for (const o of ordersIn) {
        // orderId is what the cell map produces; the others are aliases.
        const orderId = o.orderId || o.order_id || o.clOrdId;
        // Without an id the row cannot be deduplicated across captures or
        // reconciled against a fill later.
        if (!orderId) { malformed += 1; continue; }

        const quantity = parse.toNumber(o.quantity ?? o.ordQty);
        const filled = parse.toNumber(o.filled ?? o.filledQuantity ?? o.cumQty);
        // The broker's own field names, and the camelCase the scraper emits.
        const money = (...names) => {
          for (const nm of names) {
            const v = parse.toNumber(o[nm]);
            if (v !== null) return v;
          }
          return null;
        };

        mapped.push({
          order_id: String(orderId).trim(),
          symbol: parse.toSymbol(o.symbol ?? o.symbolRaw),
          side: parse.toSide(o.side ?? o.ordSide),
          order_status: o.status || o.orderStatus || o.ordSts || null,
          price: parse.toNumber(o.price),
          quantity,
          filled_quantity: filled,
          remaining_qty: parse.toNumber(o.remaining ?? o.pendQty)
            ?? ((quantity !== null && filled !== null && filled <= quantity)
              ? quantity - filled : null),
          order_time: null,
          trading_date: tradingDate,
          ingest_source: 'awsat_client',
          avg_price: money('avgPrice', 'avg_price'),
          order_value: money('ordVal', 'orderValue', 'order_value'),
          // netOrdVal IS the P&L. The old table had it NULL on every row while
          // the JSON carried it on 5,482 of 5,520.
          net_value: money('netOrdVal', 'netValue', 'net_value'),
          status_reason: o.statusReason || o.status_reason || null,
          // Added by migration 020. Mapped here so the live path fills the
          // same columns the migration does — otherwise history is richer
          // than today.
          code: o.code || null,
          order_type: o.orderType || o.order_type || null,
          exchange: o.exchange || null,
          portfolio: o.portfolio || null,
          // The whole record, always. The previous extractor dropped fields it
          // did not recognise — netOrdVal among them.
          raw: o.raw || o,
          run_id: null,
          created_at: when.capturedAt,
        });
      }

      const checked = validate.validateAll(mapped, validate.validateOrder, 'ingest/orders');
      const result = await repo.insertOrders(checked.rows);
      const counts = {
        offered: ordersIn.length,
        inserted: result.inserted,
        rejected: malformed + checked.rejected + result.rejected,
      };

      await recordSubmission(batchId, 'orders', 'awsat_client', when.capturedAt, counts);
      await logRun('ingest.orders', tradingDate, counts, started);
      log.info('ingest: orders accepted', { batchId, ...counts });
      return res.json({ ok: true, duplicate: false, ...counts });
    } catch (err) {
      log.error('ingest: orders failed', { err: log.serializeError(err) });
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}

module.exports = { createRouter, toQuoteRow, checkCapturedAt, tokenMatches, PRECEDENCE };

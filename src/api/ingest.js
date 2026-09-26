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
const slotGuards = require('./slotGuards');
const slotConfig = require('../config/slots');
const security = require('./ingestSecurity');
const boardFreshness = require('./boardFreshness');
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
 * P6-CLI-4 · a broker grid stamp -> a real instant, in Kuwait.
 *
 * The cell carries either a full date-time ('25-08-2026 13:14:10', or ISO) or a
 * bare clock. A bare clock is taken on the batch's own trading day; a date in
 * the text wins over it, because a carried order was placed in an earlier
 * session. Anything unparseable is NULL: the column means "when the broker says
 * it was placed", and a guess there is worse than an absence.
 *
 * Kuwait does not observe DST, so +03:00 is a constant — the same reasoning
 * src/scrapers/awsat.js:toKuwaitInstant is written on.
 */
function clientOrderTime(raw, tradingDate) {
  if (raw === null || raw === undefined) return null;
  const t = String(raw).trim();
  if (!t) return null;

  const clock = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(t);
  if (!clock) return null;
  const hhmmss = `${String(clock[1]).padStart(2, '0')}:${clock[2]}:${clock[3] || '00'}`;

  let day = tradingDate;
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(t);
  const dmy = /\b(\d{1,2})[-/](\d{1,2})[-/](\d{4})\b/.exec(t);
  if (iso) day = `${iso[1]}-${iso[2]}-${iso[3]}`;
  else if (dmy) day = `${dmy[3]}-${String(dmy[2]).padStart(2, '0')}-${String(dmy[1]).padStart(2, '0')}`;
  if (!day) return null;

  const d = new Date(`${day}T${hhmmss}+03:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Reject a capture timestamp that is not plausibly now.
 *
 * A batch stamped hours ago is either a client that sat in a background tab or
 * a replay. Either way it must not be written as current market data: a stale
 * quote stored under a fresh minute is worse than a gap, because nothing
 * downstream can tell it is stale.
 */
function checkCapturedAt(raw, maxSkewMs = 15 * 60_000, { allowLateCloseOfDay = false } = {}) {
  if (!raw) return { ok: true, capturedAt: new Date() };   // absent is tolerated
  const t = new Date(raw);
  if (Number.isNaN(t.getTime())) return { ok: false, reason: 'capturedAt is not a valid timestamp' };

  // clock.now(), not Date.now(): ONE named source for "now", so a suite can
  // place itself inside a real session rather than only passing on weekdays.
  const skew = clock.now().getTime() - t.getTime();
  if (skew > maxSkewMs) {
    return { ok: false, reason: `capturedAt is ${Math.round(skew / 1000)}s old (limit ${maxSkewMs / 1000}s)` };
  }
  if (skew < -60_000) {
    return { ok: false, reason: 'capturedAt is in the future' };
  }
  /*
   * ─── THE CAPTURE WINDOW · 08:40 to 13:20 KUWAIT ──────────────────────────
   *
   * No userscript stops posting when the market shuts. P6-CLI-5 already knew
   * this — it skips the frozen-board check out of hours because "from 13:30
   * until the tab is shut the same board is posted every 60 s" — and it
   * skipped the DETECTOR while still storing the rows. On 24 September the
   * client was still saving at 16:22: 17,640 price rows and 16,086 depth rows
   * after 13:20, every one of them the same shut board.
   *
   * The other end is worse. On 20 September 1,022 rows arrived before 08:00
   * with NO session label at all, carrying 17 SEPTEMBER's cumulative trades
   * and volume — the terminal was serving Thursday's figures after an outage.
   * 79 of 140 symbols still have identical day totals for the two dates.
   * Those rows are not early data; they are last session's data wearing
   * today's date.
   *
   * So the window is enforced HERE, at the one door every capture comes
   * through, rather than in four userscripts that can be stale in somebody's
   * browser. Close-Of-Day starts at 13:15, so by 13:20 the final print is in
   * and everything after it is a tab left open.
   *
   * REFUSED, not silently dropped: the client sees the reason, the panel can
   * show it, and the run is recorded. A window that discards data quietly is
   * the same class of defect as the data it is discarding.
   */
  const w = captureWindow(t);
  if (!w.inside) return { ok: false, reason: w.reason, outsideWindow: true };
  /*
   * 051 · only the QUOTES endpoint can act on this, because only it can tell a
   * closing print from the shut board. Every other caller gets the old
   * behaviour: a late batch is refused outright, which is right — a late depth
   * snapshot or order list is a page left open, with no closing print in it.
   */
  if (w.lateCloseOfDayOnly && !allowLateCloseOfDay) {
    return { ok: false, outsideWindow: true,
      reason: `captured at ${clock.localTime(t)} Kuwait, after the capture window closes at `
        + `${config.market.captureEndTime} — the Close-Of-Day exemption applies to quotes only` };
  }
  return { ok: true, capturedAt: t, lateCloseOfDayOnly: !!w.lateCloseOfDayOnly };
}

/*
 * The capture window, in Kuwait minutes. Its own setting rather than
 * START_TIME/END_TIME: those drive the SCHEDULER, and the after-close jobs are
 * derived from END_TIME at +1/+5/+12 — moving it to 13:20 would move
 * daily.symbolday and daily.marketday with it, which is the exact trap the
 * scheduler's own header warns about and the reason they did not run on 24
 * September.
 */
function captureWindow(at) {
  const start = config.market.captureStartMinutes;
  const end = config.market.captureEndMinutes;
  const backstop = config.market.codBackstopMinutes;
  const k = clock.parts(at);
  const m = k.minutesOfDay;
  const hhmm = `${String(k.hour).padStart(2, '0')}:${String(k.minute).padStart(2, '0')}`;
  if (m < start) {
    return { inside: false,
      reason: `captured at ${hhmm} Kuwait, before the capture window opens at `
        + `${config.market.captureStartTime} — a pre-open capture with no session label carries `
        + 'the PREVIOUS session\'s totals, which is how 20 September stored 17 September\'s numbers' };
  }
  if (m >= end) {
    /*
     * ─── 051 · THE ONE ROW THAT MAY BE LATE ──────────────────────────────
     *
     * The reason this door used to give — "Close-Of-Day starts 13:15, so the
     * final print is already in" — is disproved. Measured first Close-Of-Day
     * row: 13:15 on 23 September (captured continuously), 13:25 on 13 August,
     * 14:43 on 24 September. The last two sit on the far side of a 15- and a
     * 92-minute gap in our own capture, so they are when WE LOOKED, not when
     * the venue published.
     *
     * No fixed clock can be right: any number drawn from those three is wrong
     * on two of them. So the door still shuts at 13:20 for the board, and
     * opens for the closing print alone, up to a backstop — because "whenever
     * it arrives" would accept a stuck page at 22:00. The caller filters the
     * batch to the first Close-Of-Day row per symbol; this only says the
     * batch may be considered.
     */
    if (m < backstop) {
      return { inside: true, reason: null, lateCloseOfDayOnly: true };
    }
    return { inside: false,
      reason: `captured at ${hhmm} Kuwait, after the Close-Of-Day backstop at `
        + `${config.market.codBackstopTime} — the board shuts at `
        + `${config.market.captureEndTime} and the closing print is admitted after it, but a `
        + 'capture this late is a page left open, not a late publication' };
  }
  return { inside: true, reason: null };
}


/*
 * Drop rows identical to the last stored row for the same symbol today.
 *
 * ONE query for the whole batch — the latest row per symbol — rather than one
 * per row: the batch is the whole board, 140 symbols, every capture.
 *
 * A read that FAILS keeps every row. The dedupe is an optimisation on top of
 * the data; losing a capture because a lookup broke would be the priority
 * backwards, and it says so in the log rather than passing silently.
 */
const DEDUPE_FIELDS = ['session', 'last_price', 'last_qty', 'volume', 'trades',
  'bid', 'bid_qty', 'offer', 'offer_qty', 'open_price', 'high_price', 'low_price'];

function sameRow(a, b) {
  for (const f of DEDUPE_FIELDS) {
    const x = a[f] == null ? null : String(a[f]);
    const y = b[f] == null ? null : String(b[f]);
    if (x !== y) return false;
  }
  return true;
}

async function dropUnchanged(rows, tradingDate, source) {
  if (!rows || !rows.length) return { rows: rows || [], skipped: 0 };
  let latest = new Map();
  try {
    const { rows: prev } = await query(
      `SELECT DISTINCT ON (symbol) symbol, session, last_price, last_qty, volume, trades,
              bid, bid_qty, offer, offer_qty, open_price, high_price, low_price
         FROM awsat_market_quotes
        WHERE trading_date = $1 AND ingest_source = $2
        ORDER BY symbol, created_at DESC, id DESC`, [tradingDate, source]);
    latest = new Map(prev.map((r) => [r.symbol, r]));
  } catch (err) {
    log.warn('the repeat check could not read the previous capture — every row kept',
      { err: err.message, note: 'a dedupe that fails must not lose a capture' });
    return { rows, skipped: 0 };
  }
  const kept = [];
  let skipped = 0;
  for (const r of rows) {
    const prev = latest.get(r.symbol);
    if (prev && sameRow(r, prev)) { skipped += 1; continue; }
    kept.push(r);
  }
  return { rows: kept, skipped };
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

async function recordSubmission(batchId, kind, source, capturedAt, counts, partial = false) {
  // A1 · The heartbeat is a BYPRODUCT of every accepted submission, not a
  // separate call only orders made. Before this, depth/quotes/market-summary
  // posted rows into client_submissions but never touched client_heartbeat, so
  // feedHealth.roster() — which reads ONLY client_heartbeat — reported them
  // "absent" while they were in fact flowing every 28s. A live feed now writes
  // its own liveness row on each post; silence is the only thing that reads as
  // absent. Fired unconditionally on `kind` (independent of batchId, which only
  // the submission log needs), and awaited before the submission so a heartbeat
  // still lands even if the submission upsert is a duplicate no-op.
  //
  // A submission attests liveness (last_seen_at) and rows_seen ONLY. It does
  // NOT touch version/problem — those are the userscript panel's own self-report
  // (orders posts them via /ingest/heartbeat), and a submission overwriting them
  // with nulls would erase a real "problem" message. So this upsert leaves both
  // columns as they were on conflict, and inserts them null only on the first
  // ever row for a feed that has no explicit heartbeat channel.
  await query(
    `INSERT INTO client_heartbeat (script, source, version, rows_seen, problem, last_seen_at)
       VALUES ($1, $2, NULL, $3, NULL, now())
     ON CONFLICT (script, source) DO UPDATE SET
       rows_seen = EXCLUDED.rows_seen, last_seen_at = now()`,
    [kind, source, counts.inserted],
  ).catch((err) => log.error('could not record feed heartbeat from submission', { kind, err: err.message }));
  if (!batchId) return;
  await query(
    `INSERT INTO client_submissions
       (batch_id, ingest_source, kind, captured_at, rows_offered, rows_inserted, rows_rejected, partial)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (batch_id) DO NOTHING`,
    // S6 · `partial` is a fact only the CLIENT knows. The server sees fewer rows
    // and cannot tell "the grid is shorter" from "I did not reach the bottom" —
    // and absence from a partial capture is not evidence an order is gone.
    [batchId, source, kind, capturedAt, counts.offered, counts.inserted, counts.rejected, !!partial],
  ).catch((err) => log.error('could not record client submission', { batchId, err: err.message }));
}

/**
 * A userscript's per-cycle check-in. Upserted, so one row per (script, source)
 * always shows the last time it ran and what it saw — 0 rows and a `problem`
 * are check-ins too, which is the whole point: silence, not a value, is the
 * failure. `problem` carries the panel's own message so the cause is legible
 * remotely.
 */
async function recordHeartbeat({ script, source = 'awsat_client', version = null, rowsSeen = null, problem = null }) {
  if (!script) return { ok: false, error: 'no script name' };
  /*
   * F-18 · rowsSeen is COERCED, and the outcome is REPORTED.
   *
   * Two things were wrong. The value was `Number.isFinite(Number(b.rowsSeen)) ?
   * Number(...) : null` at the route, so 12.5 or 2^31 reached an `integer`
   * column and Postgres rejected the row. And this function swallowed that
   * rejection while the route returned {ok:true} unconditionally.
   *
   * The result: last_seen_at never advanced, /health reported the panel as
   * `silent` while it was alive and posting every cycle — the precise
   * "stopped and running-but-empty are indistinguishable" failure migration 038
   * was written to end, inverted — and the panel was told its check-in had
   * succeeded, so it had no way to know.
   */
  const rows = (rowsSeen === null || rowsSeen === undefined) ? null : Math.trunc(Number(rowsSeen));
  const safeRows = (Number.isFinite(rows) && Math.abs(rows) <= 2_147_483_647) ? rows : null;
  if (rows !== null && safeRows === null) {
    log.warn('heartbeat: rowsSeen is not a storable integer — recording null', { script, rowsSeen });
  }

  try {
    await query(
      `INSERT INTO client_heartbeat (script, source, version, rows_seen, problem, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (script, source) DO UPDATE SET
         version = EXCLUDED.version, rows_seen = EXCLUDED.rows_seen,
         problem = EXCLUDED.problem, last_seen_at = now()`,
      [script, source, version, safeRows, problem],
    );
    return { ok: true };
  } catch (err) {
    log.error('could not record heartbeat', { script, err: err.message });
    return { ok: false, error: err.message };
  }
}

// The scripts that SHOULD be checking in. "Absent" (never ran) looks identical
// to "fine" without this list — which is the whole trap: a script dead from boot
// leaves no row, so silence alone cannot see it. Overridable per deployment.
const EXPECTED_SCRIPTS = (process.env.EXPECTED_SCRIPTS || 'orders,depth,quotes,market-summary')
  .split(',').map((s) => s.trim()).filter(Boolean);

/**
 * The scripts that have checked in but have gone quiet longer than `maxAgeSec`
 * — H-9: a feed that was posting and stops must be detectable. A script that
 * has NEVER checked in is not "silent", it is absent — see scriptRoster.
 */
async function staleScripts(maxAgeSec = 300) {
  const { rows } = await query(
    `SELECT script, source, version, rows_seen, problem, last_seen_at,
            EXTRACT(epoch FROM now() - last_seen_at)::int AS silent_sec
       FROM client_heartbeat
      WHERE last_seen_at < now() - ($1 || ' seconds')::interval
      ORDER BY last_seen_at ASC`,
    [String(maxAgeSec)],
  );
  return rows;
}

/**
 * The full roster: every EXPECTED script with a status — `ok`, `silent`
 * (checked in, then stopped for > maxAgeSec) or `absent` (never checked in
 * today). Absent is the one plain silence can't see: a script dead from boot
 * leaves no row, and "no row" reads as "fine" unless something expects it.
 */
async function scriptRoster(maxAgeSec = 300) {
  const { rows } = await query(
    `SELECT script, version, rows_seen, problem, last_seen_at,
            EXTRACT(epoch FROM now() - last_seen_at)::int AS silent_sec
       FROM client_heartbeat`);
  const byScript = new Map(rows.map((r) => [r.script, r]));
  return EXPECTED_SCRIPTS.map((script) => {
    const r = byScript.get(script);
    if (!r) return { script, status: 'absent', lastSeenAt: null, silentSec: null };
    return {
      script,
      status: r.silent_sec > maxAgeSec ? 'silent' : 'ok',
      version: r.version, rowsSeen: r.rows_seen, problem: r.problem,
      lastSeenAt: r.last_seen_at, silentSec: r.silent_sec,
    };
  });
}

/** Map the userscript's camelCase record onto awsat_market_quotes columns. */
function toQuoteRow(r, meta) {
  const symbol = parse.toSymbol(r.symbol || r.code);
  if (!symbol) return null;

  /*
   * F-05 · A NEGATIVE VALUE IN AN UNSIGNED FIELD IS REFUSED, NOT FLIPPED.
   *
   * This returned Math.abs(x), which made validate.js's negative-price check
   * DEAD CODE on the entire ingest path:
   *
   *     // A negative price is always a misread; the row is not worth keeping.
   *     if (isImpossible(q[f], MAX_PRICE)) return { ok: false, ... }
   *
   * isImpossible tests n < 0, and the sign was already gone. Reproduced with
   * the real parser: `"(12.5)"` (accounting negative) and `"−5"` (U+2212) —
   * both documented features of parse.toNumber — arrived as last_price 12.5 and
   * bid 5, and validateQuote returned ok. The row was then stored with
   * ingest_source awsat_client and source_precedence 2, the HIGHEST precedence,
   * so it outranked the server's own capture of the same minute.
   *
   * Returning null lets the validator do its job: a null price is a gap the
   * gates can see, and an impossible one is refused with a reason.
   */
  const n = (v, signed = false) => {
    const x = parse.toNumber(v);
    if (x === null) return null;
    if (!signed && x < 0) return null;
    return x;
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
    /*
     * P5 · AN EMPTY SESSION CELL IS NOT AN ABSENT ONE, AND `|| null` ERASED
     * THE DIFFERENCE.
     *
     * symbolDayMetrics states the rule and depends on it: "'' sits with
     * Trading: it is a JULY CAPTURE DEFECT, not an exchange state — those rows
     * are 09:00-12:59 continuous trading whose label was not captured. NULL is
     * excluded entirely: those are 14:13-14:23 Friday reads, after the close on
     * a non-trading day, and their volume is cumulative rather than new."
     *
     * `'' || null` is null. So every continuous-trading row whose session cell
     * failed to render was stored as the Friday shape — and closeRow,
     * priceBlock, rangeSource, previousCloses and (since P3/P4) ownSession all
     * discard it.
     *
     * That was survivable while only volumeBlock filtered. It stopped being
     * survivable when P4 moved the filter into volumeSteps: a symbol whose
     * label drops for a stretch of the morning now loses those steps from
     * up_moves, down_moves, peak_hour and every flow column — and if the label
     * never renders all session, close_px, open_px, total_volume and the whole
     * flow block go NULL for a symbol that traded normally, indistinguishable
     * from one that did not trade at all.
     *
     * A capture defect and a non-trading day are different facts. The client
     * sending an empty string is saying "the cell was there and was blank";
     * sending nothing is saying "there was no cell". Both are preserved.
     */
    session: r.session === undefined || r.session === null ? null : String(r.session),
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
  /*
   * G-5 · the ONE slot count, published so the backend does not guess. FIVE is
   * the SPREAD depth sweep — 3 pre-day + 2 swappable (FLOW step 2), bounded by
   * the 25 s vs 30 s capture cycle, which is why POST /slots/:n has always
   * validated 1..5. The 7 September "twelve" was the raw scraper's total capture
   * list, not the SPREAD sweep; the halt module operates on the five this
   * endpoint validates. An operator who widens the sweep sets SLOT_COUNT, and the
   * GET, both POSTs, and the backend's stale check all follow the published
   * number — never a literal.
   */
  /*
   * P2 · and it is now read from src/config/slots.js rather than computed here,
   * because src/wakeup.js had its own `[4, 5, 6, 7, 8]` literal and the two
   * disagreed. The wake-up scan seated symbols in slots this endpoint refuses
   * to address, the GET below served them, and the client dropped them.
   */
  const SLOT_COUNT = slotConfig.slotCount();

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
   *
   * H-C · THE HEADER IS ECHOED PER REQUEST, NEVER SET FROM THE ENV VERBATIM.
   * Access-Control-Allow-Origin accepts exactly ONE origin, or '*'. This used
   * to be `res.set('…-Allow-Origin', process.env.INGEST_ORIGIN || '*')`, which
   * is correct for a single origin and catastrophic for the shape the
   * allowlist exists to serve: set
   *
   *   INGEST_ORIGIN=https://www.awsatbroker.com,https://awsatbroker.com
   *
   * — the two origins the terminal actually serves the userscripts from — and
   * every browser rejects the comma-list as an illegal header value. fetch()
   * fails with a network error, the response is discarded, and NOTHING is
   * written to the server log, because the answer never reaches the page. The
   * capture silently stops for exactly the configuration the feature was added
   * to support.
   *
   * resolveOrigin (src/api/ingestSecurity.js) returns the ONE value this
   * request may be answered with, or null when the caller's origin is not on
   * the list. A refused origin gets NO Allow-Origin header at all — the
   * browser then blocks the response on its own, which is the loud form: the
   * page sees a CORS failure rather than a silent 200 it is not allowed to
   * read.
   */
  const ALLOW = security.parseOrigins(process.env.INGEST_ORIGIN);
  router.use((req, res, next) => {
    const allowed = security.resolveOrigin(req.get('Origin'), ALLOW);
    if (allowed !== null) res.set('Access-Control-Allow-Origin', allowed);
    // Vary regardless: the answer depends on the request's Origin even when
    // the answer is "no header", and a cache that missed that would serve one
    // origin's permission to another.
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
      /**
       * ─── IT EXPLAINS WHY THE LIST IS EMPTY ────────────────────────────────
       *
       * An empty list has four possible causes and they are indistinguishable
       * from outside: no rows for this date, every row released, every symbol
       * filtered as not tradeable, or the rows sitting in a different database
       * from the one this process reads.
       *
       * Seven slots existed for exactly the date this asked for, and the
       * endpoint still returned nothing — with no way to tell which of the four
       * it was. So it now reports each count, and names the database it read.
       */
      const { rows: diag } = await query(`
        SELECT
          (SELECT count(*)::int FROM depth_watchlist) AS rows_any_date,
          (SELECT count(*)::int FROM depth_watchlist WHERE trading_date = $1) AS rows_today,
          (SELECT count(*)::int FROM depth_watchlist
            WHERE trading_date = $1 AND released_at IS NOT NULL) AS released,
          (SELECT count(*)::int FROM depth_watchlist w
            WHERE w.trading_date = $1 AND w.released_at IS NULL
              AND EXISTS (SELECT 1 FROM instruments i
                           WHERE i.symbol = w.symbol AND i.is_tradeable = false)) AS not_tradeable,
          (SELECT max(trading_date)::text FROM depth_watchlist) AS newest_slot_date,
          current_database() AS db`, [day]);
      const d = diag[0];

      const { rows } = await query(`
        SELECT w.slot_no, w.symbol, w.slot_type, i.code
          FROM depth_watchlist w
          LEFT JOIN LATERAL (
            SELECT code FROM instruments
             WHERE symbol = w.symbol AND code IS NOT NULL AND is_primary LIMIT 1
          ) i ON true
         WHERE w.trading_date = $1 AND w.symbol IS NOT NULL AND w.released_at IS NULL
           -- NEVER OFFER A SLOT TO A SYMBOL THAT CANNOT BE TRADED. Unknown
           -- symbols are KEPT: a new listing has no registry row yet.
           AND NOT EXISTS (
             SELECT 1 FROM instruments i2
              WHERE i2.symbol = w.symbol AND i2.is_tradeable = false)
         ORDER BY w.slot_no`, [day]);

      /*
       * P2 · A ROW ABOVE THE PUBLISHED COUNT IS NOT SERVED, AND IS NAMED.
       *
       * This query had no slot_no bound at all — it served whatever was in the
       * table. Migration 024 permits 1-8, both POSTs validate 1..SLOT_COUNT,
       * and the wake-up scan used to write 6, 7 and 8. Six entries went to a
       * client that sweeps five; the client truncated in slot order and the
       * newest wake-up — the symbol that had just fired — was the one dropped,
       * its ladder never captured, with every server-side record saying it was
       * promoted.
       *
       * Bounding the query alone would hide the row instead. It is separated
       * out and REPORTED, because a row nobody can address through either POST
       * needs an operator, not a filter.
       */
      const beyond = rows.filter((r) => Number(r.slot_no) > SLOT_COUNT);
      const served = rows.filter((r) => Number(r.slot_no) <= SLOT_COUNT);
      if (beyond.length) {
        log.error('depth_watchlist holds slot(s) ABOVE SLOT_COUNT — not served, '
          + 'and not addressable through /slots/:n or /depth-symbols', {
          slotCount: SLOT_COUNT,
          beyond: beyond.map((r) => `${r.slot_no}:${r.symbol}`),
          fix: 'raise SLOT_COUNT to cover them, or release them in the database',
        });
      }
      rows.length = 0;
      rows.push(...served);

      const preDay = rows.filter((r) => r.slot_type === 'PRE_DAY').length;

      if (!rows.length) {
        // One line that says WHICH of the four it was.
        const why = d.rows_today === 0
          ? (d.rows_any_date === 0
            ? `depth_watchlist is EMPTY in database "${d.db}" — the seeder wrote somewhere else`
            : `no slots for ${day}; newest slots are dated ${d.newest_slot_date}`)
          : d.released === d.rows_today ? 'every slot for today is released'
            : d.not_tradeable ? `${d.not_tradeable} slot(s) hold symbols marked is_tradeable = false`
              : 'rows exist and pass every filter — this should not happen';
        log.warn('depth-symbols: serving an empty list', {
          day, database: d.db, rowsToday: d.rows_today, rowsAnyDate: d.rows_any_date,
          released: d.released, notTradeable: d.not_tradeable,
          newestSlotDate: d.newest_slot_date, why,
        });
        return res.json({
          symbols: [], source: 'depth_watchlist', trading_date: day,
          pre_day: 0, wakeup: 0,
          // Returned so one curl answers it, without server log access.
          diagnostic: {
            database: d.db, rows_today: d.rows_today, rows_any_date: d.rows_any_date,
            released: d.released, not_tradeable: d.not_tradeable,
            newest_slot_date: d.newest_slot_date, why,
          },
        });
      }

      if (!preDay && clock.isTradingDay(new Date())) {
        log.warn('depth-symbols: no PRE_DAY slots on a session day', {
          day, note: 'seed with scripts/seed-depth-slots.js, or the day runs on wake-ups only',
        });
      }

      return res.json({
        symbols: rows.map((r) => ({ symbol: r.symbol, code: r.code, slot: r.slot_no })),
        source: 'depth_watchlist',
        trading_date: day,
        pre_day: preDay,
        wakeup: rows.length - preDay,
        slotCount: SLOT_COUNT, // G-5 · the address space POST /slots/:n validates against
        /*
         * Present only when something is wrong. A row above SLOT_COUNT is not
         * swept and cannot be released through either POST, so the client's
         * panel — the one surface an operator is actually looking at during a
         * session — says so rather than silently listing one symbol fewer.
         */
        ...(beyond.length ? {
          beyondSlotCount: beyond.map((r) => ({ slot: r.slot_no, symbol: r.symbol })),
          warning: `${beyond.length} slot(s) above SLOT_COUNT=${SLOT_COUNT} are held `
            + 'but not swept, and cannot be released through the API',
        } : {}),
      });
    } catch (err) {
      log.error('depth-symbols failed', { err: err.message });
      return res.status(500).json({ ok: false, error: err.message, symbols: [] });
    }
  });

  /**
   * POST /slots/:n — swap the symbol in a depth slot.
   *
   * ─── WHY THIS EXISTS ──────────────────────────────────────────────────────
   * EMIRATES was not in the sweep on 2 September. It became the only stock
   * worth trading and the book was invisible for an hour until someone ran a
   * command. SHUAIBA the day before. Twice in two days.
   *
   * ─── AND WHY IT LIVES IN THE SCRAPER ──────────────────────────────────────
   * depth_watchlist is capture configuration, not a UI concern that happens to
   * sit here — which symbols get swept is the scraper's business, and the
   * backend is forbidden from writing public.* by a lint rule worth keeping.
   *
   * NO RESTART: /depth-symbols reads the table live and the userscript
   * re-reads it every sweep, so a change lands within 25 seconds.
   */
  router.post('/slots/:n', async (req, res) => {
    const slot = Number(req.params.n);
    const symbol = String(req.body?.symbol || '').trim().toUpperCase();
    const reason = String(req.body?.reason || '').slice(0, 200) || null;
    // B4 · the backend names what it is replacing (spread:slotRequest carries
    // replaced_symbol). Honoured when given; otherwise the slot's current holder.
    const replacedSymbolIn = String(req.body?.replaced_symbol || '').trim().toUpperCase() || null;
    const day = clock.tradingDay();

    /**
     * FIVE SLOTS, NEVER SIX.
     *
     * A symbol switch measured 4.34s across 3,984 real switches. Six symbols
     * makes the cycle 30 seconds instead of 25 for EVERY symbol — degrading
     * five books to gain one.
     */
    if (!Number.isInteger(slot) || slot < 1 || slot > SLOT_COUNT) {
      return res.status(400).json({
        ok: false,
        error: `slot must be 1-${SLOT_COUNT}, got ${req.params.n}`,
        detail: 'Five slots, never six: a sixth makes the sweep 30s instead of '
          + '25s across every symbol, which degrades five books to gain one.',
      });
    }
    if (!symbol) return res.status(400).json({ ok: false, error: 'symbol is required' });

    try {
      // SPR-03 · a symbol not in the instruments list is refused, not assigned;
      // and a non-tradeable one would sweep a book nobody can act on. Both live
      // in slotGuards now, so POST /depth-symbols enforces the same rules.
      const assignable = await slotGuards.symbolIsAssignable(symbol);
      if (!assignable.ok) {
        return res.status(assignable.status).json({
          ok: false, error: assignable.error, detail: assignable.detail,
        });
      }

      const { rows: current } = await query(
        `SELECT slot_no, symbol FROM depth_watchlist
          WHERE trading_date = $1 AND released_at IS NULL`, [day]);
      const here = current.find((r) => r.slot_no === slot);
      const elsewhere = current.find((r) => r.symbol === symbol && r.slot_no !== slot);

      if (elsewhere) {
        return res.status(409).json({
          ok: false,
          error: `${symbol} already holds slot ${elsewhere.slot_no}`,
          detail: 'One symbol, one slot. Release that one first, or swap a different slot.',
        });
      }
      if (here && here.symbol === symbol) {
        return res.json({ ok: true, unchanged: true, slot, symbol,
          note: 'that slot already holds this symbol' });
      }

      /**
       * A SLOT HOLDING A POSITION OR A QUEUED ORDER CANNOT BE DISPLACED.
       *
       * Losing the book on a symbol you are IN is the one case where a swap
       * costs more than it gains — you would be blind on the position while
       * watching something you are not in.
       */
      if (here) {
        /*
         * A SLOT HOLDING A POSITION OR A LIVE ORDER CANNOT BE DISPLACED.
         *
         * Losing the book on a symbol you are IN is the one case where a swap
         * costs more than it gains — you would be blind on the position while
         * watching something you are not in. In slotGuards so the bulk
         * endpoint, which releases the whole day at once, enforces it too.
         */
        const displaceable = await slotGuards.slotIsDisplaceable(here.symbol, day);
        if (!displaceable.ok) {
          return res.status(displaceable.status).json({
            ok: false,
            error: `slot ${slot} holds ${here.symbol}, which cannot be displaced`,
            detail: displaceable.detail,
            holding: here.symbol,
          });
        }

        await query(
          `UPDATE depth_watchlist SET released_at = now()
            WHERE trading_date = $1 AND slot_no = $2 AND released_at IS NULL`, [day, slot]);
      }

      await query(`
        INSERT INTO depth_watchlist
          (trading_date, slot_no, symbol, slot_type, assigned_by,
           replaced_symbol, replaced_at, replaced_by, replaced_reason)
        VALUES ($1, $2, $3, $4, 'UI', $5, CASE WHEN $5::text IS NULL THEN NULL ELSE now() END,
                CASE WHEN $5::text IS NULL THEN NULL ELSE 'UI' END, $6)
        ON CONFLICT (trading_date, slot_no) DO UPDATE SET
          symbol = EXCLUDED.symbol, assigned_at = now(), released_at = NULL,
          replaced_symbol = EXCLUDED.replaced_symbol,
          replaced_at = EXCLUDED.replaced_at,
          replaced_by = EXCLUDED.replaced_by,
          replaced_reason = EXCLUDED.replaced_reason`,
      [day, slot, symbol, slot <= 3 ? 'PRE_DAY' : 'WAKEUP',
        replacedSymbolIn || (here ? here.symbol : null), reason]);

      const replaced = replacedSymbolIn || (here ? here.symbol : null);
      log.info('depth slot swapped', {
        slot, symbol, replaced, reason,
        note: 'live within 25s — the sweep re-reads the list every cycle',
      });

      // B4 · return the RESULTING slot row, so the backend's spread:slotRequest
      // handler can confirm the applied state rather than assume it.
      const { rows: [row] } = await query(
        `SELECT trading_date, slot_no, symbol, slot_type, assigned_at,
                replaced_symbol, replaced_at, replaced_by, replaced_reason
           FROM depth_watchlist WHERE trading_date = $1 AND slot_no = $2 AND released_at IS NULL`,
        [day, slot]);
      return res.json({
        ok: true, slot, symbol, replaced,
        row: row || null,
        effective_in: 'up to 25 seconds — the sweep re-reads the list each cycle',
      });
    } catch (err) {
      log.error('slot swap failed', { slot, symbol, err: err.message });
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * B4 · POST /depth-symbols — set the whole sweep list at once, in ONE
   * transaction. This closes the "assumed shape" the backend was written to.
   *
   * REQUEST:  { date?: 'YYYY-MM-DD', slots: [{ slot: 1..5, symbol: 'ABC' }, …] }
   *           date defaults to today; slots 1-3 are PRE_DAY, 4-5 WAKEUP.
   * RESPONSE: { ok, date, slots: [<the resulting depth_watchlist rows>] }
   *           a bad slot number or a duplicate symbol is a 400, applied atomically
   *           (all or nothing) — a partial list would leave the sweep inconsistent.
   */
  router.post('/depth-symbols', async (req, res) => {
    const day = String(req.body?.date || clock.tradingDay()).slice(0, 10);
    const slots = Array.isArray(req.body?.slots) ? req.body.slots : null;
    if (!slots || !slots.length) return res.status(400).json({ ok: false, error: 'slots array is required' });
    const seen = new Set();
    for (const s of slots) {
      const nn = Number(s.slot);
      const sym = String(s.symbol || '').trim().toUpperCase();
      if (!Number.isInteger(nn) || nn < 1 || nn > SLOT_COUNT) return res.status(400).json({ ok: false, error: `slot must be 1-${SLOT_COUNT}, got ${s.slot}` });
      if (!sym) return res.status(400).json({ ok: false, error: `slot ${nn} has no symbol` });
      if (seen.has(sym)) return res.status(400).json({ ok: false, error: `${sym} appears twice — one symbol, one slot` });
      seen.add(sym);
    }
    /*
     * THE SAME GUARDS POST /slots/:n ENFORCES.
     *
     * This endpoint writes the same table to the same effect and used to
     * enforce none of them — so a bulk call could release the slot the trader
     * had a position in, and seat a symbol that is in no instruments row. The
     * narrow endpoint refused with 409 what this one accepted with 200.
     */
    const normalised = slots.map((s) => ({ slot: Number(s.slot), symbol: String(s.symbol).trim().toUpperCase() }));
    const guard = await slotGuards.checkBulkAssignment(normalised, day);
    if (!guard.ok) {
      return res.status(guard.status || 400).json({
        ok: false, error: guard.error, detail: guard.detail, holding: guard.holding,
      });
    }

    const { pool } = require('../db/pool');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Set the WHOLE list: release the day's active slots first so a symbol
      // moving slots does not collide with its old row (one symbol, one slot).
      await client.query(
        `UPDATE depth_watchlist SET released_at = now()
          WHERE trading_date = $1 AND released_at IS NULL`, [day]);
      for (const s of slots) {
        const nn = Number(s.slot);
        const sym = String(s.symbol).trim().toUpperCase();
        await client.query(
          `INSERT INTO depth_watchlist (trading_date, slot_no, symbol, slot_type, assigned_by)
           VALUES ($1,$2,$3,$4,'INGEST_BULK')
           ON CONFLICT (trading_date, slot_no) DO UPDATE SET
             symbol = EXCLUDED.symbol, assigned_at = now(), released_at = NULL`,
          [day, nn, sym, nn <= 3 ? 'PRE_DAY' : 'WAKEUP']);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      log.error('bulk depth-symbols failed', { err: err.message });
      return res.status(500).json({ ok: false, error: err.message });
    } finally {
      client.release();
    }
    /*
     * The read-back used to sit OUTSIDE the try. Express 4 does not catch an
     * async handler's rejection, so if this query failed after the COMMIT the
     * request was never answered at all — the write had landed and the caller
     * could not tell, so it retried and re-released the whole list. A failed
     * read-back must never un-say a successful write.
     */
    try {
      const { rows } = await query(
        `SELECT trading_date, slot_no, symbol, slot_type FROM depth_watchlist
          WHERE trading_date = $1 AND released_at IS NULL ORDER BY slot_no`, [day]);
      return res.json({ ok: true, date: day, slots: rows });
    } catch (err) {
      log.error('bulk depth-symbols: read-back failed after COMMIT', { err: err.message });
      return res.json({ ok: true, date: day, slots: null, readBackError: err.message });
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
                -- P6-CLI-8 · the KUWAIT day. trading_date is Kuwait-derived and
                -- CURRENT_DATE is the database server's; on a UTC host this
                -- read 0 between 00:00 and 03:00 Kuwait while the feed ran.
                (SELECT count(*) FROM awsat_market_quotes
                  WHERE trading_date = (now() AT TIME ZONE 'Asia/Kuwait')::date)::int AS quotes_today`);
      db = { reachable: true, ...rows[0] };
    } catch (err) {
      db = { reachable: false, error: err.message };
    }

    // H-9 · the full roster — every expected script, including ones that never
    // started (`absent`), not only ones that stopped (`silent`). `problem`, when
    // present, is the panel's own message, so a break's cause is legible here.
    let scripts = [];
    try { scripts = await scriptRoster(300); } catch { /* table may predate 038 */ }
    const scriptsDown = scripts.filter((s) => s.status !== 'ok');

    return res.json({
      ok: true,
      at: new Date().toISOString(),
      tradingDay: clock.tradingDay(),
      awsatMode: config.awsat.mode,
      acceptingClientData: config.awsat.mode === 'client',
      pid: process.pid,
      // Every expected script and its status; scriptsDown is the not-ok subset
      // (absent | silent). Empty scriptsDown is healthy.
      scripts,
      scriptsDown,
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
    /*
     * P2 · `when.reason`, not `when.error`.
     *
     * checkCapturedAt returns { ok, reason }. There is no `error` field, so this
     * answered `400 {"ok": false}` with no reason at all — while the other three
     * callers of the same function all read `when.reason` correctly.
     *
     * The market-summary userscript surfaces the server's reason on its panel
     * and had nothing to show: a bare 400 on one endpoint while the others name
     * the cause. The "make the failure loud" principle failing on the one branch
     * that exists to be loud.
     */
    if (!when.ok) return res.status(400).json({ ok: false, error: when.reason });

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
       * IS TODAY A SESSION? ASK THE QUOTES, NOT market_day.
       *
       * ─── WHY NOT market_day ────────────────────────────────────────────
       * It has no row for today until daily.marketday runs at 13:40, so during
       * a session it can NEVER say "today is a session". Every live capture
       * would find yesterday, mark itself STALE, and be skipped by the very job
       * that was going to create the row — leaving broker_seen_at NULL and the
       * compute quietly falling back to our own breadth.
       *
       * Tomorrow would look like the broker feed was never wired, and the day
       * after would be spent debugging an endpoint that works.
       *
       * awsat_market_quotes is written AS THE SESSION RUNS, so it can answer
       * the question at 09:05. Same class of error as comparing String(Date):
       * a derivation that consults something not yet populated.
       *
       * The comparison stays in SQL — ::date to ::date, with the Kuwait
       * conversion done by Postgres, so no Date object reaches a string and no
       * timezone is applied twice.
       */
      const { rows: sess } = await query(
        `WITH cap AS (
           SELECT ($1::timestamptz AT TIME ZONE 'Asia/Kuwait')::date AS capture_day,
                  extract(dow FROM ($1::timestamptz AT TIME ZONE 'Asia/Kuwait')) AS dow
         )
         SELECT cap.capture_day::text AS capture_day,
                -- Friday (5) and Saturday (6) are never sessions on Boursa
                -- Kuwait, whatever happens to be in the table.
                (cap.dow NOT IN (5, 6)
                 AND EXISTS (SELECT 1 FROM awsat_market_quotes q
                              WHERE q.trading_date = cap.capture_day)) AS is_session_day,
                -- The session these figures describe when today is not one:
                -- the last day that actually traded.
                (SELECT max(q2.trading_date)::text FROM awsat_market_quotes q2
                  WHERE q2.trading_date <= cap.capture_day) AS last_traded
           FROM cap`, [when.capturedAt]);

      const captured = new Date(when.capturedAt);
      /*
       * P6-CLI-6 · A HOLIDAY IS NOT A SESSION, WHATEVER THE QUOTES SAY.
       *
       * The SQL above asks "did any quote row land on this day?" — and on an
       * Eid weekday the capture userscript is still open and still posting the
       * previous close's board, which CREATES those very rows. The summary was
       * then stored LIVE/CLOSE and broker_seen_at stamped on a day that never
       * traded. The calendar (market/holidays, migration 040) is the authority
       * the rest of the scheduler already uses; it is consulted here too.
       */
      const isSessionDay = sess.length
        ? sess[0].is_session_day && clock.isTradingDay(captured)
        : false;
      if (sess.length && sess[0].is_session_day && !isSessionDay) {
        log.warn('market summary captured on a non-session day (holiday calendar) — '
          + 'filed against the last day that traded', {
          captureDay: sess[0].capture_day, lastTraded: sess[0].last_traded,
        });
      }
      const tradingDate = isSessionDay
        ? sess[0].capture_day
        : (sess[0] && sess[0].last_traded) || clock.tradingDay();

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
                -- P6-CLI-8 · the Kuwait day, like every other date in this schema.
                broker_status_on = (now() AT TIME ZONE 'Asia/Kuwait')::date,
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

    /*
     * S12 · BOUNDED. Three ways, because this writes to disk on the request
     * thread from a client-supplied array:
     *
     *   · at most DEBUG_MAX_ITEMS per request — the array had no length cap, so
     *     one payload could hold hundreds of files' worth of writes and block
     *     the event loop through all of them while the live capture waited;
     *   · at most DEBUG_MAX_BYTES per file, down from 2 MB;
     *   · at most DEBUG_KEEP files in tmp/ — the oldest are removed after each
     *     write, so a client stuck in a loop cannot fill the disk. It used to
     *     keep every dump for ever; the four that ended up committed to git
     *     came from exactly this pile.
     *
     * The excess is REPORTED, not silently dropped: a debug endpoint that
     * quietly discards half of what you sent it is worse than no endpoint,
     * because you will read the half you got as the whole.
     */
    const MAX_ITEMS = Number(process.env.DEBUG_MAX_ITEMS || 5);
    const MAX_BYTES = Number(process.env.DEBUG_MAX_BYTES || 512 * 1024);
    const KEEP = Number(process.env.DEBUG_KEEP || 40);
    const take = items.slice(0, Number.isFinite(MAX_ITEMS) && MAX_ITEMS > 0 ? MAX_ITEMS : 5);
    const dropped = items.length - take.length;

    try {
      const dir = path.resolve(__dirname, '..', '..', 'tmp');
      fs.mkdirSync(dir, { recursive: true });
      const written = [];
      let truncated = 0;
      for (const item of take) {
        const tag = String(item.source || 'debug').replace(/[^\w.-]/g, '_').slice(0, 60);
        const file = path.join(dir, `client-${tag}-${Date.now()}-${written.length}.txt`);
        const payload = typeof item.d === 'string' ? item.d : JSON.stringify(item.d, null, 2);
        const text = String(payload);
        const cap = Number.isFinite(MAX_BYTES) && MAX_BYTES > 0 ? MAX_BYTES : 512 * 1024;
        if (text.length > cap) truncated += 1;
        fs.writeFileSync(file, text.slice(0, cap), 'utf8');
        written.push(file);
      }

      // Sweep the pile. Names carry a timestamp, so lexical order is age order.
      let removed = 0;
      try {
        const keep = Number.isFinite(KEEP) && KEEP > 0 ? KEEP : 40;
        const all = fs.readdirSync(dir).filter((f) => f.startsWith('client-')).sort();
        for (const f of all.slice(0, Math.max(0, all.length - keep))) {
          fs.unlinkSync(path.join(dir, f));
          removed += 1;
        }
      } catch (sweepErr) {
        log.warn('could not sweep old debug dumps', { err: sweepErr.message });
      }

      log.warn('client posted a debug dump', {
        offered: items.length, written: written.length, dropped, truncated, removed,
      });
      // Server paths are not handed back — the client cannot use them and they
      // describe the deployment. The count and the caps are what it needs.
      return res.json({
        ok: true, written: written.length, dropped, truncated,
        limits: { maxItems: MAX_ITEMS, maxBytes: MAX_BYTES, keep: KEEP },
      });
    } catch (err) {
      log.error('could not store the debug dump', { err: err.message });
      return res.status(500).json({ ok: false, error: 'could not store the debug dump' });
    }
  });

  /**
   * POST /ingest/heartbeat
   * { script, version?, rowsSeen?, problem?, source? }
   *
   * Every userscript cycle, data or not. It is what makes a stopped script
   * visible: the row's last_seen_at stops advancing, and `problem` says why.
   */
  router.post('/heartbeat', async (req, res) => {
    const b = req.body || {};
    if (!b.script) return res.status(400).json({ ok: false, error: 'script is required' });
    const result = await recordHeartbeat({
      script: String(b.script).slice(0, 40),
      source: b.source === 'awsat_server' ? 'awsat_server' : 'awsat_client',
      version: b.version != null ? String(b.version).slice(0, 20) : null,
      rowsSeen: Number.isFinite(Number(b.rowsSeen)) ? Number(b.rowsSeen) : null,
      problem: b.problem != null ? String(b.problem).slice(0, 300) : null,
    });
    /*
     * F-18 · a failed write is not {ok:true}.
     *
     * It used to be. The panel was told its check-in succeeded while
     * last_seen_at had not moved, so /health reported it `silent` and the panel
     * had no way to know — the exact failure migration 038 exists to prevent,
     * with the sign flipped. 200 with ok:false rather than a 5xx: the check-in
     * is advisory and the client must not treat it as a reason to retry the
     * whole cycle, but it must be able to see that it did not land.
     */
    if (!result.ok) {
      return res.json({ ok: false, error: 'the check-in was not recorded', detail: result.error });
    }
    return res.json({ ok: true });
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

    const when = checkCapturedAt(body.capturedAt, undefined, { allowLateCloseOfDay: true });
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

      /*
       * ─── 051 · THE CLOSING PRINT IS THE ONLY THING THAT CROSSES THE DOOR ──
       *
       * `when.lateCloseOfDayOnly` means this batch arrived after 13:20 and was
       * admitted ONLY because the closing print may not be in yet. Measured:
       * the venue published Close-Of-Day at 13:15 on the one day we captured
       * continuously through the transition, at 13:25 on 13 August, and at
       * 14:43 on 24 September — the last two both on the far side of a gap in
       * OUR capture, so they are looking times, not publication times.
       *
       * Everything else in a late batch is the shut board: 17,640 price rows
       * after 13:20 on 24 September, the same values re-posted every minute
       * until 16:22. So the rows are filtered to Close-Of-Day, and a symbol
       * that already has one today is dropped — the FIRST one per symbol per
       * day, at the door, which is where "first" is cheap to enforce.
       *
       * Refusing the whole batch here would be the old behaviour; storing all
       * of it would be the defect the door was built for. Neither.
       */
      let lateKept = 0;
      let lateDropped = 0;
      if (when.lateCloseOfDayOnly) {
        const before = mapped.length;
        const cod = mapped.filter((r) => String(r.session || '').trim() === 'Close-Of-Day');
        const already = cod.length
          ? new Set((await repo.symbolsWithCloseOfDay(meta.tradingDate,
            cod.map((r) => r.symbol))).map((s) => String(s).toUpperCase()))
          : new Set();
        const keep = cod.filter((r) => !already.has(String(r.symbol).toUpperCase()));
        lateKept = keep.length;
        lateDropped = before - keep.length;
        mapped.length = 0;
        mapped.push(...keep);
        log.info('ingest: late batch admitted for the closing print only', {
          batchId, tradingDate: meta.tradingDate, kept: lateKept, dropped: lateDropped,
          note: 'rows kept are marked cod_late in quotes_clean — their time is when WE '
              + 'saw them, not when the venue published',
        });
        if (!mapped.length) {
          return res.json({ ok: true, offered: before, inserted: 0, rejected: 0,
            note: 'late batch: every symbol already has its closing print' });
        }
      }

      const checked = validate.validateAll(mapped, validate.validateQuote, 'ingest/quotes');

      // Register instruments first, exactly as the server-side path does.
      await repo.upsertSymbols(mapped.map((r) => ({
        market: r.market, symbol: r.symbol, code: r.code, description: r.description,
      })));

      /*
       * ─── THE REPEAT CHECK · AN IDENTICAL CAPTURE IS NOT A SECOND READING ──
       *
       * On 24 September 2,520 extra rows landed — one per symbol per minute
       * from 13:04 onward, every one byte-identical to the row before it,
       * because the cadence moved to 30 seconds at the deploy and the market
       * was in Close Auction Acceptance with nothing moving.
       *
       * quote_fingerprint does NOT stop this. It is the FROZEN-BOARD detector
       * — it records a hash of the whole batch and warns when the board stops
       * changing — and it deliberately runs only inside the window, which is
       * why it had four rows today and none after 13:11. It never dropped a
       * row and was never meant to.
       *
       * This is the missing check, and it is content, not time: a row is
       * skipped only when every field that can move is IDENTICAL to the last
       * stored row for that symbol today. Two genuine captures a minute are
       * kept — the historical cadence is roughly that, and the coverage
       * measures count them — while a repeat of a board that has not moved is
       * not a second reading of anything.
       *
       * Counted and returned, never silent: `duplicate` on the response and in
       * the run row. A dedupe nobody can see is indistinguishable from a feed
       * that stopped.
       */
      const deduped = await dropUnchanged(checked.rows, meta.tradingDate, source);
      const result = await repo.insertQuotes(deduped.rows);
      const counts = {
        offered: body.records.length,
        inserted: result.inserted,
        rejected: malformed + checked.rejected + result.rejected,
        duplicate: deduped.skipped,
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

      /*
       * Everything that DID store is captured. Recorded so a symbol leaving the
       * scrape is a state change with a date, not an absence nobody can date.
       *
       * P2 · AND IT NOW MEANS WHAT THE COMMENT SAYS. This read `mapped` — the
       * pre-validation list, everything the client OFFERED. `checked.rows` is
       * what survived validateAll and is what insertQuotes actually stored.
       *
       * A symbol whose every row was REFUSED — a price above MAX_PRICE after a
       * column shift, say — was still stamped CAPTURED with today's date. And
       * broker_status_on exists precisely to be the date the status CHANGED, so
       * the row asserted the symbol was being captured on a day none of its
       * quotes stored. The UNMATCHED detection directly above is the mechanism
       * that makes a dropped symbol visible; this defeated it one line later.
       */
      const stored = Array.isArray(checked.rows) ? checked.rows : [];
      const captured = [...new Set(stored.map((r) => r.symbol).filter(Boolean))];
      if (captured.length) await markBrokerStatus(captured, 'CAPTURED');

      /*
       * H11 · is the board still MOVING? The heartbeat proves the feed is
       * posting; it cannot prove it is posting anything new. A terminal whose
       * websocket has died keeps rendering its last board, and every capture
       * then looks healthy while every price is frozen. Never blocks the
       * ingest — a freshness check that can fail the capture it observes has
       * the priority backwards.
       */
      /*
       * P6-CLI-5 · ONLY INSIDE THE TRADING WINDOW.
       *
       * No userscript stops posting at the close, so from 13:30 until the tab
       * is shut the same board is posted every 60 s — byte-identical, because
       * the market is shut. Three of those tripped `frozen`, logged QUOTES FEED
       * DEGRADED and left /health DEGRADED for the rest of the day, EVERY day.
       * A frozen board only means something while the market is open, and a
       * detector that cries wolf daily is one nobody reads.
       */
      const freshness = clock.isWithinWindow(new Date(when.capturedAt))
        ? await boardFreshness.recordAndCheck({
          rows: checked.rows, capturedAt: when.capturedAt, tradingDate: meta.tradingDate, source,
        })
        : { frozen: false, checked: false, reason: 'outside the trading window' };

      await recordSubmission(batchId, 'quotes', source, when.capturedAt, counts);
      // The quotes handler derives a per-row trading_date from each record's
      // capture time; the RUN belongs to the session it arrived in.
      await logRun('ingest.quotes', clock.tradingDay(), counts, started);
      log.info('ingest: quotes accepted', { source, batchId, ...counts, boardFrozen: freshness.frozen });

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
        // H11 · the panel shows this. A capture the server accepted but that did
        // not MOVE the board is the failure the heartbeat cannot see, so it has
        // to reach the one screen a human is actually looking at.
        boardFrozen: freshness.frozen,
        identicalCaptures: freshness.identical,
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

    /*
     * The batch cap /quotes and /depth have always had, and this endpoint did
     * not. The trader's own order list is a few dozen rows; anything past the
     * cap is a client bug or a retry loop, and letting it through means one
     * request holding a pool connection while the live 15 s depth and quote
     * cycles queue behind it.
     */
    if (ordersIn.length > MAX_BATCH_ROWS) {
      return res.status(413).json({
        ok: false, error: `batch too large: ${ordersIn.length} orders (max ${MAX_BATCH_ROWS})`,
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
          // P6-CLI-4 · the placement stamp the grid shows, read Kuwait-local
          // exactly as the server-side scraper reads it (awsat.toKuwaitInstant).
          // Absent or unparseable stays NULL — "not captured", never a guess.
          order_time: clientOrderTime(o.stamp ?? o.orderTime ?? o.order_time, tradingDate),
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
          /*
           * 039 · the OBSERVATION's own instant, and part of its identity
           * (order_id, observed_at, ingest_source). Taken from the client's
           * capturedAt, not the server's clock, so a replayed batch lands on
           * the same key and is a no-op rather than a second sighting of the
           * same moment.
           */
          observed_at: when.capturedAt,
          last_seen_at: when.capturedAt,
        });
      }

      const checked = validate.validateAll(mapped, validate.validateOrder, 'ingest/orders');
      const result = await repo.insertOrders(checked.rows);
      const counts = {
        offered: ordersIn.length,
        inserted: result.inserted,
        rejected: malformed + checked.rejected + result.rejected,
      };

      await recordSubmission(batchId, 'orders', 'awsat_client', when.capturedAt, counts, body.partial === true);
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

module.exports = { createRouter, toQuoteRow, checkCapturedAt, clientOrderTime, tokenMatches, PRECEDENCE,
  recordHeartbeat, staleScripts, scriptRoster, EXPECTED_SCRIPTS };

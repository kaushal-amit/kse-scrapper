'use strict';
/**
 * ============================================================================
 *  symbol_minute_sample — one observation of the board per symbol per minute
 * ============================================================================
 * Not a bar. See migration 052 for why the name matters; the short version is
 * that quote capture has run at 60 seconds throughout (1.00 samples/minute
 * across 1,456,376 symbol-minutes), so there is no intra-minute variation for
 * open/high/low/close to describe.
 *
 * Everything this job does that could be silent is a column instead:
 *
 *   samples_in_minute     how much of a minute the row actually is
 *   delta_span_seconds    what the volume and trade deltas really cover
 *   is_session_first      whether the delta runs from the open rather than
 *                         from a previous sample
 *   time_basis            whether the authoritative time is ours or the venue's
 *   depth_lag_seconds     how stale the joined book is
 *   source_*              the fingerprint of the rows this was built from
 *
 * Idempotent: re-running a day corrects it rather than duplicating.
 * ============================================================================
 */
const { query } = require('../db/pool');
const clock = require('../market/clock');
const log = require('../logger');
const { config } = require('../config');

const COLUMNS = [
  'symbol', 'trading_date', 'minute', 'observed_at', 'time_basis',
  'exchange_trade_time', 'samples_in_minute',
  'last_price', 'bid', 'bid_qty', 'offer', 'offer_qty', 'session',
  'volume_delta', 'trades_delta', 'delta_span_seconds', 'is_session_first',
  'depth_samples_in_minute', 'depth_lag_seconds',
  'depth_bid_levels', 'depth_offer_levels', 'depth_bid_shares_5', 'depth_offer_shares_5',
  'source_max_created_at', 'source_rows',
];

/**
 * Depth begins on 6 August 2026. Before it there is nothing to join, and that
 * is NOT COMPUTED rather than an empty book — a book with no levels and a book
 * never captured are different facts, and only one of them is about the market.
 *
 * AND THE DATE IS THE SMALLER HALF OF THE LIMIT. Depth does NOT cover 136
 * symbols: that number occurs on exactly ONE day, 30 August, and every other
 * session since 6 August carries between 1 and 18 — typically 8 to 18 lately.
 * The data-tables brief and my own review of it both quoted 136 as the
 * coverage; it is a single run's artefact. So the depth columns here are NOT
 * COMPUTED for most symbols on EVERY day, not merely before 6 August, and a
 * study filtering on "has depth" is working with a watchlist rather than a
 * market.
 */
const DEPTH_FROM = '2026-08-06';

/** The board, from the view that refuses the capture traps — never the raw table. */
async function samplesFor(day) {
  const { rows } = await query(
    `SELECT symbol, created_at, session, last_price, bid, bid_qty, offer, offer_qty,
            volume, trades
       FROM public.quotes_clean
      WHERE trading_date = $1
      ORDER BY symbol, created_at;`, [day]);
  return rows;
}

/**
 * The book, at or before each quote. Fetched per day and matched in memory:
 * a correlated lookup per row is 140 symbols x 240 minutes of round trips.
 */
async function depthFor(day) {
  const { rows } = await query(
    // One row per LEVEL, with both sides on it — there is no `side` column.
    `SELECT symbol, captured_at,
            count(*) FILTER (WHERE bid   IS NOT NULL) AS bid_levels,
            count(*) FILTER (WHERE offer IS NOT NULL) AS offer_levels,
            sum(bid_qty)   FILTER (WHERE level <= 5)  AS bid_shares_5,
            sum(offer_qty) FILTER (WHERE level <= 5)  AS offer_shares_5
       FROM public.awsat_stock_depth
      WHERE trading_date = $1
      GROUP BY symbol, captured_at
      ORDER BY symbol, captured_at;`, [day]);
  const bySymbol = new Map();
  for (const r of rows) {
    const k = String(r.symbol).toUpperCase();
    if (!bySymbol.has(k)) bySymbol.set(k, []);
    bySymbol.get(k).push({ at: new Date(r.captured_at).getTime(),
      bidLevels: Number(r.bid_levels), offerLevels: Number(r.offer_levels),
      bidShares5: r.bid_shares_5 === null ? null : Number(r.bid_shares_5),
      offerShares5: r.offer_shares_5 === null ? null : Number(r.offer_shares_5) });
  }
  return bySymbol;
}

/**
 * THE JOIN RULE, stated once: the last depth sample AT OR BEFORE the quote.
 *
 * At-or-before rather than nearest. A depth sample taken AFTER the quote is
 * information from the future, and in a trading system lookahead is the error
 * that matters — a backtest that quietly reads the next book is not wrong by a
 * little, it is wrong in the direction that flatters it.
 */
function bookAtOrBefore(list, atMs) {
  if (!list || !list.length) return null;
  let lo = 0; let hi = list.length - 1; let found = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].at <= atMs) { found = list[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

/** Seconds from the session open to `at`, for the first sample's span. */
function secondsFromOpen(at, day) {
  const openMins = config.market.sessionStartMinutes;
  const open = new Date(`${day}T00:00:00+03:00`).getTime() + openMins * 60_000;
  return Math.max(1, Math.round((at - open) / 1000));
}

async function compute(tradingDay, runId = null) {
  const day = String(tradingDay).slice(0, 10);
  const rows = await samplesFor(day);
  if (!rows.length) {
    log.warn('symbol_minute_sample: no rows in quotes_clean for the day', { day });
    return { extracted: 0, inserted: 0, rejected: 0 };
  }

  const depth = await depthFor(day);
  const depthAvailable = day >= DEPTH_FROM;

  // The input fingerprint — max(source timestamp) and the row count — rather
  // than a build version. A build version says which code ran; it does not say
  // whether the rows underneath have changed since.
  let sourceMax = null;
  for (const r of rows) {
    const t = new Date(r.created_at);
    if (!sourceMax || t > sourceMax) sourceMax = t;
  }

  const bucketed = new Map();      // symbol|minuteISO -> { rows[] }
  for (const r of rows) {
    const at = new Date(r.created_at);
    const minute = clock.minuteBucket(at);            // the ONE clock
    const key = `${String(r.symbol).toUpperCase()}|${minute.toISOString()}`;
    if (!bucketed.has(key)) bucketed.set(key, { symbol: r.symbol, minute, rows: [] });
    bucketed.get(key).rows.push(r);
  }

  const built = [];
  const prevBySymbol = new Map();                     // symbol -> previous sample
  for (const b of [...bucketed.values()].sort((x, y) => (x.symbol === y.symbol
    ? x.minute - y.minute : (x.symbol < y.symbol ? -1 : 1)))) {
    // The LAST capture in the minute represents it: the board is cumulative,
    // so the latest reading is the most complete one. samples_in_minute says
    // how many there were, so nothing has to guess what was discarded.
    const s = b.rows[b.rows.length - 1];
    const sym = String(b.symbol).toUpperCase();
    const atMs = new Date(s.created_at).getTime();

    const prev = prevBySymbol.get(sym) || null;
    const isFirst = !prev;
    const spanSecs = isFirst
      ? secondsFromOpen(atMs, day)
      : Math.max(1, Math.round((atMs - prev.atMs) / 1000));
    const volDelta = s.volume === null ? null
      : Number(s.volume) - (isFirst ? 0 : Number(prev.volume ?? 0));
    const trDelta = s.trades === null ? null
      : Number(s.trades) - (isFirst ? 0 : Number(prev.trades ?? 0));

    const inMinute = (depth.get(sym) || []).filter((d) => {
      const m = clock.minuteBucket(new Date(d.at));
      return m.getTime() === b.minute.getTime();
    }).length;
    const book = depthAvailable ? bookAtOrBefore(depth.get(sym), atMs) : null;

    built.push({
      symbol: sym,
      trading_date: day,
      minute: b.minute,
      observed_at: s.created_at,
      /*
       * CAPTURE, and it is not a default. The exchange's own stamp
       * (last_trade_time / last_trade_date) has been empty on every quote row
       * since the awsat_client cutover on 30 August 2026, so no row written
       * today can honestly claim EXCHANGE. The column exists from the first
       * day so that when the feed returns, new rows say EXCHANGE and old rows
       * still say CAPTURE — with no backfill and nothing inferring the era
       * from a date.
       */
      time_basis: 'CAPTURE',
      exchange_trade_time: null,
      samples_in_minute: b.rows.length,
      last_price: s.last_price,
      bid: s.bid,
      bid_qty: s.bid_qty,
      offer: s.offer,
      offer_qty: s.offer_qty,
      session: s.session,
      volume_delta: volDelta,
      trades_delta: trDelta,
      delta_span_seconds: spanSecs,
      is_session_first: isFirst,
      // NOT COMPUTED before depth exists: null on BOTH, which the CHECK
      // constraint enforces, so "no book captured" can never read as "an empty
      // book".
      depth_samples_in_minute: depthAvailable ? inMinute : null,
      depth_lag_seconds: depthAvailable
        ? (book ? Math.max(0, Math.round((atMs - book.at) / 1000)) : null) : null,
      depth_bid_levels: book ? book.bidLevels : null,
      depth_offer_levels: book ? book.offerLevels : null,
      depth_bid_shares_5: book ? book.bidShares5 : null,
      depth_offer_shares_5: book ? book.offerShares5 : null,
      source_max_created_at: sourceMax,
      source_rows: rows.length,
    });

    prevBySymbol.set(sym, { atMs, volume: s.volume, trades: s.trades });
  }

  /*
   * A lag where depth was never computed is the one impossible pair — see the
   * constraint in 052. `samples = 0` with a null lag is NOT impossible: depth
   * ran that day, none of it landed in this minute, and none of it preceded
   * the quote either. The first version of this guard required the two to be
   * null together and threw on exactly that case, which was the data telling
   * me the constraint was wrong rather than the rows.
   */
  const bad = built.filter((r) => r.depth_lag_seconds !== null
    && r.depth_samples_in_minute === null);
  if (bad.length) {
    throw new Error(`symbol_minute_sample: ${bad.length} row(s) carry a depth lag where depth `
      + `was never computed (first: ${bad[0].symbol} ${bad[0].minute.toISOString()})`);
  }

  let inserted = 0;
  for (let i = 0; i < built.length; i += 200) {
    const chunk = built.slice(i, i + 200);
    const values = [];
    const tuples = chunk.map((r, ri) => {
      const base = ri * COLUMNS.length;
      COLUMNS.forEach((c) => values.push(r[c] === undefined ? null : r[c]));
      return `(${COLUMNS.map((_, ci) => `$${base + ci + 1}`).join(', ')})`;
    });
    // eslint-disable-next-line no-await-in-loop
    const res = await query(
      `INSERT INTO public.symbol_minute_sample (${COLUMNS.join(', ')})
       VALUES ${tuples.join(', ')}
       ON CONFLICT (symbol, trading_date, minute) DO UPDATE SET
         ${COLUMNS.filter((c) => !['symbol', 'trading_date', 'minute'].includes(c))
    .map((c) => `${c} = EXCLUDED.${c}`).join(', ')},
         computed_at = now()`, values);
    inserted += res.rowCount || chunk.length;
  }

  log.info('symbol_minute_sample: written', {
    day, rows: built.length, symbols: prevBySymbol.size,
    depth: depthAvailable ? 'joined' : `NOT COMPUTED (depth starts ${DEPTH_FROM})`,
    sourceRows: rows.length, runId,
  });
  return { extracted: rows.length, inserted, rejected: 0 };
}

module.exports = { compute, COLUMNS, bookAtOrBefore, secondsFromOpen, DEPTH_FROM };

'use strict';
/**
 * src/jobs/computeSymbolDay.js — one row per symbol per session.
 *
 *   npm run run:once -- daily.symbolday --date=2026-08-25
 *
 * Idempotent: re-running a day corrects it rather than duplicating.
 *
 * ─── WHAT THIS FILLS, AND WHAT IT LEAVES NULL ──────────────────────────────
 * The L1 columns, for every symbol captured that day — price, volume,
 * movement, tape quality, flow, sessions, quality.
 *
 * The BOOK group stays NULL: bid_p10..p90, offer percentiles, spread_fils_*,
 * refill_ratio, wall_*, bid_age_p50_secs. Depth covers 19 symbols of 142, so
 * computing them would produce a row that is complete for 19 and misleading
 * for 123.
 *
 * The BUDGET columns stay NULL by design: net_per_fil and shares_at_budget are
 * properties of an account, not of a stock. They change when the balance
 * changes and would need recomputing across every historical row. The
 * invariants belong in config and the economics at query time.
 *
 * `family` is CRAWLER or NULL — every other class needs bid_p50.
 */

const { query } = require('../db/pool');
const clock = require('../market/clock');
const log = require('../logger');
const M = require('./symbolDayMetrics');
const T = require('../config/thresholds');

/** Columns written. Anything absent from here is deliberately left NULL. */
const COLUMNS = [
  'symbol', 'trading_date',
  'open_px', 'high_px', 'low_px', 'close_px', 'prev_close', 'chg_fils',
  'chg_1d', 'chg_5d', 'day_range', 'prev_session_used', 'prev_session_gap_days',
  'total_volume', 'trades', 'avg_trade_size', 'highest_minute_volume',
  'moves', 'up_moves', 'down_moves', 'up_moves_2plus', 'up_moves_3plus',
  'up_moves_tiny', 'down_moves_tiny', 'tiny_pct_up', 'tiny_pct_down',
  'trades_under_100',
  'bought_at_offer', 'sold_at_bid', 'shares_inside_spread',
  'trades_at_offer', 'trades_at_bid', 'pct_at_offer', 'buy_sell_ratio',
  'minutes_captured', 'coverage_pct', 'data_quality', 'source', 'close_source',
  'range_source',
  // The shape of the session's trading, not its totals. Logged, never gated.
  'avg_uptick_shares', 'avg_downtick_shares', 'uptick_ratio',
  'n_upticks', 'n_downticks', 'turnover_kd',
  'first_half_shares_per_min', 'second_half_shares_per_min',
  'family', 'tick_band_crossed', 'computed_at',
];

/**
 * Every capture for the day, one symbol at a time.
 *
 * Ordered by symbol then time so the rows arrive grouped and in sequence —
 * the metrics compare consecutive captures, so the ordering is not cosmetic.
 */
async function loadDay(day) {
  const { rows } = await query(`
    SELECT q.symbol, q.market, q.last_price, q.last_qty, q.bid, q.offer,
           q.volume, q.trades, q.session, q.created_at
      FROM awsat_market_quotes q
     WHERE q.trading_date = $1
       -- PRIMARY SYMBOLS ONLY.
       --
       -- A phantom counts as a symbol that did not trade, which nudges
       -- market_day.pct_advancing down — a wrong number in the table the
       -- regime gate reads. Unknown symbols are kept: a new listing has no
       -- registry row yet and dropping it would lose a real one.
       AND NOT EXISTS (
         SELECT 1 FROM instruments i
          WHERE i.symbol = q.symbol AND i.is_primary = false)
     ORDER BY q.symbol, q.created_at`, [day]);

  const bySymbol = new Map();
  for (const r of rows) {
    if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, []);
    bySymbol.get(r.symbol).push(r);
  }
  return bySymbol;
}

/**
 * One symbol must belong to one market.
 *
 * The primary key is (symbol, trading_date), so a symbol legitimately trading
 * on two markets would collapse into one row and nothing would say so. This
 * was verified zero at build time; the assertion exists because "verified once"
 * and "true from now on" are different claims.
 */
async function assertOneMarketPerSymbol(day) {
  const { rows } = await query(`
    SELECT symbol, array_agg(DISTINCT market ORDER BY market) AS markets
      FROM awsat_market_quotes
     WHERE trading_date = $1
     GROUP BY symbol HAVING count(DISTINCT market) > 1`, [day]);
  if (rows.length) {
    throw new Error(
      `${rows.length} symbol(s) appear under more than one market on ${day}: `
      + rows.slice(0, 5).map((r) => `${r.symbol} (${r.markets.join(', ')})`).join('; ')
      + '. The primary key would silently merge them. Run fix-market-labels first.');
  }
}

/** The median minute count across the market, for that day. */
function marketMedianMinutes(bySymbol) {
  const counts = [...bySymbol.values()].map((rows) => M.minutesCaptured(rows)).sort((a, b) => a - b);
  if (!counts.length) return 0;
  const mid = Math.floor(counts.length / 2);
  return counts.length % 2 ? counts[mid] : Math.round((counts[mid - 1] + counts[mid]) / 2);
}

/**
 * The previous close for EVERY symbol, in one query.
 *
 * ─── WHY NOT PER SYMBOL ────────────────────────────────────────────────────
 * This used to call prev_session_sym() and session_close() once each per
 * symbol: 272 round trips per session, each one a scan of awsat_market_quotes.
 * A day took 87 seconds and later days nearly five minutes, because each has
 * more history behind it.
 *
 * One query, two round trips, and the arithmetic is identical — the same
 * DISTINCT ON that session_close() performs, applied to every symbol at once.
 *
 * The session rule is repeated here rather than calling the function per row:
 * that is a duplicate definition and I would rather it were not, but the
 * alternative is 272 function calls. The list is asserted against
 * closing_sessions() in the test suite so the two cannot drift apart silently.
 */
async function previousCloses(day) {
  /**
   * THE LAST SESSION THAT ACTUALLY PRODUCED A CLOSE — not merely the last
   * session with data.
   *
   * 30 July captured 75 minutes and produced ZERO closes across all 134
   * symbols. The previous rule found it (it has quotes), asked for its close,
   * got NULL, and left 2 August with one prev_close out of 134 — a whole
   * session of breadth reading 0/1/0.
   *
   * PER SYMBOL, not market-wide: a single suspended stock is a different fact
   * from a market-wide capture failure, and it is the symbol's own previous
   * close we want. market_day already carries the market-wide view.
   *
   * CAPPED AT 5 SESSIONS: a "previous close" from two weeks ago is not one.
   * Beyond that prev_close stays NULL, and prev_session_gap_days makes the
   * reach visible whenever it exceeds a day.
   */
  const cutoffHHMM = T.get('close_capture_min_hhmm');
  const cutoffMinutes = Math.floor(cutoffHHMM / 100) * 60 + (cutoffHHMM % 100);

  const { rows } = await query(`
    WITH ends AS (
      SELECT trading_date, max(created_at) AS last_capture
        FROM awsat_market_quotes WHERE trading_date < $1
       GROUP BY trading_date
    ),
    usable AS (
      -- A SESSION WHOSE CAPTURE STOPPED EARLY CANNOT SUPPLY A CLOSE.
      --
      -- 30 July captured 09:00-10:14 Kuwait: its last print is a mid-morning
      -- price wearing a close's name, three hours before the session ended.
      -- Storing it is right (TRADING, THIN); reaching back TO it is not.
      --
      -- The cut is close_capture_min_hhmm = 12:30. End times cluster at 12:59 —
      -- ten July days missing only the closing auction — while 30 July ends at
      -- 10:14 and 26 August at 12:23. 12:30 falls in the empty gap, so it is
      -- the midpoint of a real discontinuity rather than a number fitted to the
      -- data.
      SELECT trading_date FROM ends
       WHERE (extract(hour FROM (last_capture AT TIME ZONE 'Asia/Kuwait')) * 60
            + extract(minute FROM (last_capture AT TIME ZONE 'Asia/Kuwait'))) >= $2
    ),
    candidates AS (
      SELECT symbol, trading_date, close_px,
             row_number() OVER (PARTITION BY symbol ORDER BY trading_date DESC) AS back
        FROM (
          SELECT DISTINCT ON (q.symbol, q.trading_date)
                 q.symbol, q.trading_date, q.last_price AS close_px
            FROM awsat_market_quotes q
            JOIN usable u ON u.trading_date = q.trading_date
           WHERE q.trading_date < $1
             AND q.last_price IS NOT NULL AND q.last_price > 0
             AND (q.session IS NULL OR q.session = ANY(closing_sessions()))
           ORDER BY q.symbol, q.trading_date DESC, q.created_at DESC
        ) withClose
    )
    SELECT symbol, trading_date AS prev_day, close_px AS prev_close
      FROM candidates WHERE back = 1`, [day, cutoffMinutes]);

  const out = new Map();
  for (const r of rows) {
    out.set(r.symbol, {
      prev_close: Number(r.prev_close),
      prev_session_used: r.prev_day,
      prev_session_gap_days: Math.round(
        (new Date(day) - new Date(r.prev_day)) / 86_400_000),
    });
  }
  return out;
}

/** The close five SESSIONS back, for every symbol, in one query. */
async function closesFiveSessionsBack(day) {
  /**
   * The same rule, five sessions back.
   *
   * Counting a session that could not supply a close would make chg_5d measure
   * four sessions while claiming five — the same silent miscount as chg_1d
   * spanning a gap. "Usable for a close" must mean ONE thing.
   */
  const cutoffHHMM = T.get('close_capture_min_hhmm');
  const cutoffMinutes = Math.floor(cutoffHHMM / 100) * 60 + (cutoffHHMM % 100);

  const { rows } = await query(`
    WITH ends AS (
      SELECT trading_date, max(created_at) AS last_capture
        FROM awsat_market_quotes WHERE trading_date < $1
       GROUP BY trading_date
    ),
    usable AS (
      SELECT trading_date FROM ends
       WHERE (extract(hour FROM (last_capture AT TIME ZONE 'Asia/Kuwait')) * 60
            + extract(minute FROM (last_capture AT TIME ZONE 'Asia/Kuwait'))) >= $2
    ),
    candidates AS (
      SELECT symbol, trading_date, close_px,
             row_number() OVER (PARTITION BY symbol ORDER BY trading_date DESC) AS back
        FROM (
          SELECT DISTINCT ON (q.symbol, q.trading_date)
                 q.symbol, q.trading_date, q.last_price AS close_px
            FROM awsat_market_quotes q
            JOIN usable u ON u.trading_date = q.trading_date
           WHERE q.trading_date < $1
             AND q.last_price IS NOT NULL AND q.last_price > 0
             AND (q.session IS NULL OR q.session = ANY(closing_sessions()))
           ORDER BY q.symbol, q.trading_date DESC, q.created_at DESC
        ) withClose
    )
    SELECT symbol, close_px AS px FROM candidates WHERE back = 5`, [day, cutoffMinutes]);
  const out = new Map();
  for (const r of rows) out.set(r.symbol, Number(r.px));
  return out;
}

function buildRow(symbol, day, rows, marketMedian) {
  const price = M.priceBlock(rows);
  const close = M.closePrice(rows);
  const volume = M.volumeBlock(rows);
  const movement = M.movementBlock(rows);
  const minutes = M.minutesCaptured(rows);
  const closeOfDay = M.hasCloseOfDay(rows);

  return {
    symbol,
    trading_date: day,
    ...price,
    close_px: close,
    close_source: M.closeSource(rows),
    range_source: M.rangeSource(rows),
    ...M.flowBlock(rows),
    day_range: (price.high_px !== null && price.low_px !== null)
      ? price.high_px - price.low_px : null,
    total_volume: volume.total_volume,
    trades: volume.trades,
    avg_trade_size: volume.avg_trade_size,
    highest_minute_volume: volume.highest_minute_volume,
    moves: movement.moves,
    up_moves: movement.up_moves,
    down_moves: movement.down_moves,
    up_moves_2plus: movement.up_moves_2plus,
    up_moves_3plus: movement.up_moves_3plus,
    up_moves_tiny: movement.up_moves_tiny,
    down_moves_tiny: movement.down_moves_tiny,
    tiny_pct_up: movement.tiny_pct_up,
    tiny_pct_down: movement.tiny_pct_down,
    trades_under_100: movement.trades_under_100,
    bought_at_offer: movement.bought_at_offer,
    sold_at_bid: movement.sold_at_bid,
    shares_inside_spread: movement.shares_inside_spread,
    trades_at_offer: movement.trades_at_offer,
    trades_at_bid: movement.trades_at_bid,
    pct_at_offer: movement.pct_at_offer,
    buy_sell_ratio: M.buySellRatio(movement),
    minutes_captured: minutes,
    coverage_pct: marketMedian
      ? Number(((100 * minutes) / marketMedian).toFixed(2)) : null,
    data_quality: M.dataQuality(minutes, marketMedian, closeOfDay),
    // Constant today. It exists so the day a TradingView-derived row appears,
    // it cannot be mistaken for a broker one — and any query using `trades`
    // must filter on it, since TradingView rows have no trade count.
    source: 'AWSAT',
    family: M.familyOf(close),
    tick_band_crossed: M.tickBandCrossed(close, price.high_px),
    computed_at: new Date(),
  };
}

async function compute(tradingDay, runId) {
  const day = tradingDay || clock.tradingDay();

  // Fail ONCE with the fix in the message. A backfill that hits the same
  // missing column 28 times buries any second, different error in the noise.
  await require('../db/preflight').check('symbol_day compute', {
    symbol_day: ['prev_session_gap_days', 'tick_band_crossed',
      'up_moves_2plus', 'up_moves_3plus', 'pct_at_offer', 'source', 'data_quality'],
    awsat_market_quotes: ['symbol', 'last_price', 'last_qty', 'bid', 'offer',
      'volume', 'trades', 'session', 'trading_date', 'created_at'],
  });

  await assertOneMarketPerSymbol(day);

  /**
   * REMOVE ROWS THAT SHOULD NO LONGER EXIST.
   *
   * The job upserts and never deleted, so a symbol that stops qualifying kept
   * whatever was written last: KFIN and KPPC left 16 rows behind when they
   * became non-primary, and market_day counted them as symbols that did not
   * trade — inflating the denominator on 15 sessions.
   *
   * A recompute that overwrites but cannot remove does not converge. This makes
   * it converge.
   */
  const purged = await query(`
    DELETE FROM symbol_day sd
     USING instruments i
     WHERE sd.trading_date = $1 AND i.symbol = sd.symbol AND i.is_primary = false`, [day]);
  if (purged.rowCount) {
    log.info('symbol_day: removed rows for symbols that are no longer primary', {
      day, removed: purged.rowCount,
    });
  }

  const bySymbol = await loadDay(day);
  if (!bySymbol.size) {
    log.warn('symbol_day: no quotes for this day', { day, runId });
    return { extracted: 0, inserted: 0, rejected: 0 };
  }

  const marketMedian = marketMedianMinutes(bySymbol);
  log.info('symbol_day: computing', {
    day, symbols: bySymbol.size, marketMedianMinutes: marketMedian,
  });

  // Two queries for the whole day, not two per symbol.
  const prevCloses = await previousCloses(day);
  const back5 = await closesFiveSessionsBack(day);

  const built = [];
  let crossed = 0;
  for (const [symbol, rows] of bySymbol) {
    const row = buildRow(symbol, day, rows, marketMedian);

    const prev = prevCloses.get(symbol)
      || { prev_close: null, prev_session_used: null, prev_session_gap_days: null };
    Object.assign(row, prev);
    row.chg_fils = (row.close_px !== null && prev.prev_close !== null)
      ? row.close_px - prev.prev_close : null;
    row.chg_1d = (row.chg_fils !== null && prev.prev_close)
      ? Number(((100 * row.chg_fils) / prev.prev_close).toFixed(4)) : null;

    const px5 = back5.get(symbol);
    row.chg_5d = (row.close_px !== null && px5)
      ? Number(((100 * (row.close_px - px5)) / px5).toFixed(4)) : null;

    if (row.tick_band_crossed) crossed += 1;
    built.push(row);
  }

  if (crossed) {
    log.warn('symbol_day: symbols crossed the 100-fil tick band', {
      day, count: crossed,
      note: 'two tick regimes in one session — per-fil economics are wrong for part of it',
    });
  }

  // UPSERT: re-running a day must CORRECT it, not duplicate or skip it.
  let inserted = 0;
  for (let i = 0; i < built.length; i += 200) {
    const chunk = built.slice(i, i + 200);
    const values = [];
    const tuples = chunk.map((r, k) => {
      const ph = COLUMNS.map((c, j) => {
        values.push(r[c] === undefined ? null : r[c]);
        return `$${k * COLUMNS.length + j + 1}`;
      });
      return `(${ph.join(', ')})`;
    });
    const res = await query(
      `INSERT INTO symbol_day (${COLUMNS.join(', ')}) VALUES ${tuples.join(', ')}
       ON CONFLICT (symbol, trading_date) DO UPDATE SET
         ${COLUMNS.filter((c) => c !== 'symbol' && c !== 'trading_date')
    .map((c) => `${c} = EXCLUDED.${c}`).join(', ')}`,
      values);
    inserted += res.rowCount;
  }

  const thin = built.filter((r) => r.data_quality === 'THIN').length;
  log.info('symbol_day: written', {
    day, symbols: built.length, inserted, thin, crossed, runId,
  });

  return { extracted: bySymbol.size, inserted, rejected: 0, thin };
}

module.exports = {
  compute, buildRow, loadDay, marketMedianMinutes, previousCloses,
  closesFiveSessionsBack, COLUMNS,
};

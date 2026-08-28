'use strict';
/**
 * The wake-up scan — every 15 minutes, all 137 symbols.
 *
 *   pace = trades_today / median_trades_by_this_hour_last_10d
 *   FIRE if pace >= 3.0 AND trades >= 20
 *
 * ─── WHY THIS DOES NOT COMPETE FOR THE 8 DEPTH SLOTS ───────────────────────
 * It reads the market quotes grid, which already covers every symbol every 60
 * seconds. Depth is only needed once a stock is promoted, so detection costs
 * nothing from the slot budget — that is the whole reason the scan can cover
 * 137 while the fast loop covers 8.
 *
 * ─── STATE AND HISTORY ARE DIFFERENT TABLES ────────────────────────────────
 * depth_watchlist holds WHICH SYMBOL HAS WHICH SLOT — the state the scraper
 * reads. signal_log records WHAT FIRED — history.
 *
 * An earlier version kept both in signal_log to avoid a table, which created
 * two answers to "who holds slot 4" and left the correct one depending on
 * which query ran. A promotion now writes to both: the slot to
 * depth_watchlist, the event to signal_log.
 */

const { query } = require('./db/pool');
const preflight = require('./db/preflight');
const clock = require('./market/clock');
const log = require('./logger');

const PACE_MIN = Number(process.env.WAKEUP_PACE_MIN || 3.0);
const TRADES_MIN = Number(process.env.WAKEUP_TRADES_MIN || 20);
const BASELINE_DAYS = Number(process.env.WAKEUP_BASELINE_DAYS || 10);
const WAKEUP_SLOTS = [4, 5, 6, 7, 8];

/**
 * Pace for every symbol that has traded today.
 *
 * The baseline is the median trade count for THIS HOUR over the last 10
 * sessions — not the daily total. A stock is busy at 09:15 by a different
 * standard than at 12:45, and comparing today's morning against a whole-day
 * average would make every symbol look asleep before noon.
 *
 * percentile_cont gives the median; an average would be moved by one frantic
 * session, which is exactly the kind of day the baseline should ignore.
 */
async function computePace(day = clock.tradingDay(), atHour = null) {
  const hour = atHour === null ? new Date().getUTCHours() + 3 : atHour;

  const { rows } = await query(`
    WITH today AS (
      SELECT symbol, max(trades) AS trades_today
        FROM awsat_market_quotes
       WHERE trading_date = $1 AND trades IS NOT NULL
       GROUP BY symbol
    ),
    recent_sessions AS (
      -- The last N SESSIONS, not the last N calendar days.
      --
      -- "last 10d" cannot mean ten dates: two days a week are not sessions,
      -- holidays remove more, and 29-30 July are missing entirely. A calendar
      -- window silently returned an EMPTY baseline here, which made pace NULL
      -- for every symbol and the scan fire nothing at all. Same error
      -- prev_session() exists to prevent.
      SELECT DISTINCT trading_date FROM awsat_market_quotes
       WHERE trading_date < $1
       ORDER BY trading_date DESC LIMIT $3
    ),
    hour_history AS (
      -- One row per symbol per past session: the trades seen by this hour.
      SELECT q.symbol, q.trading_date, max(q.trades) AS trades_by_hour
        FROM awsat_market_quotes q
        JOIN recent_sessions rs USING (trading_date)
       WHERE q.trades IS NOT NULL
         AND EXTRACT(hour FROM q.created_at AT TIME ZONE 'UTC') + 3 <= $2
       GROUP BY q.symbol, q.trading_date
    ),
    baseline AS (
      SELECT symbol,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY trades_by_hour) AS median_trades,
             count(*) AS sessions
        FROM hour_history GROUP BY symbol
    )
    SELECT t.symbol, t.trades_today, b.median_trades, b.sessions
      FROM today t LEFT JOIN baseline b USING (symbol)
     ORDER BY t.symbol`, [day, hour, BASELINE_DAYS]);

  return rows.map((r) => {
    const trades = Number(r.trades_today);
    const median = r.median_trades === null ? null : Number(r.median_trades);
    // No baseline, or a baseline of zero, means pace is unknowable — not
    // infinite. A symbol with no history would otherwise fire every scan.
    const pace = (median === null || median <= 0) ? null
      : Number((trades / median).toFixed(3));
    return {
      symbol: r.symbol,
      trades,
      median_trades: median,
      sessions: r.sessions === null ? 0 : Number(r.sessions),
      pace,
    };
  });
}

/** Who currently holds each wake-up slot. THE STATE, from depth_watchlist. */
async function currentHolders(day = clock.tradingDay()) {
  const { rows } = await query(`
    SELECT slot_no AS slot, symbol, assigned_at
      FROM depth_watchlist
     WHERE trading_date = $1 AND slot_type = 'WAKEUP'
       AND symbol IS NOT NULL AND released_at IS NULL
     ORDER BY slot_no`, [day]);
  return rows;
}

/**
 * The pace a slot was claimed at, for the eviction comparison.
 *
 * depth_watchlist holds the slot; the pace that won it is in signal_log. That
 * is the correct split — pace is a property of the event, not of the slot —
 * and it means the eviction rule reads history to compare and writes state to
 * act.
 */
async function holderPaces(day = clock.tradingDay()) {
  const { rows } = await query(`
    SELECT DISTINCT ON (symbol) symbol, pace
      FROM signal_log
     WHERE trading_date = $1 AND signal = 'WAKEUP' AND pace IS NOT NULL
     ORDER BY symbol, fired_at DESC`, [day]);
  const out = new Map();
  for (const r of rows) out.set(r.symbol, Number(r.pace));
  return out;
}

/**
 * Run the scan and promote what fires.
 *
 * A symbol already holding a slot is not re-promoted: it holds for the session.
 * Re-firing would churn the slot it already owns and log a swap that never
 * happened.
 */
async function scan(day = clock.tradingDay(), atHour = null) {
  await preflight.check('wake-up scan', {
    depth_watchlist: ['trading_date', 'slot_no', 'symbol', 'slot_type', 'released_at'],
    signal_log: ['symbol', 'signal', 'slot', 'pace', 'fired_at'],
    awsat_market_quotes: ['symbol', 'trades', 'trading_date', 'created_at'],
  }, { quiet: true });

  const paced = await computePace(day, atHour);
  const firing = paced
    .filter((p) => p.pace !== null && p.pace >= PACE_MIN && p.trades >= TRADES_MIN)
    .sort((a, b) => b.pace - a.pace);      // fastest first

  if (!firing.length) {
    log.info('wake-up scan: nothing firing', { day, examined: paced.length });
    return { examined: paced.length, fired: 0, promoted: 0, rows: [] };
  }

  const holders = await currentHolders(day);
  const paces = await holderPaces(day);
  const held = new Map(holders.map((h) => [h.slot, { ...h, pace: paces.get(h.symbol) ?? null }]));
  const heldSymbols = new Set(holders.map((h) => h.symbol));

  const out = [];
  for (const cand of firing) {
    if (heldSymbols.has(cand.symbol)) continue;      // holds for the session

    const free = WAKEUP_SLOTS.find((s) => !held.has(s));
    let slot = free;
    let replaced = null;

    if (slot === undefined) {
      // Full. The lowest pace goes — but only if this one beats it. A swap
      // that does not improve the set costs the evicted symbol's session.
      const weakest = [...held.values()]
        .sort((a, b) => Number(a.pace ?? 0) - Number(b.pace ?? 0))[0];
      if (Number(cand.pace) <= Number(weakest.pace ?? 0)) continue;
      slot = weakest.slot;
      replaced = weakest.symbol;
    }

    const message = replaced
      ? `pace ${cand.pace}x on ${cand.trades} trades — replaced ${replaced}`
      : `pace ${cand.pace}x on ${cand.trades} trades`;

    // STATE first. If claiming the slot fails, no history is written for a
    // promotion that did not happen.
    //
    // Inserted on claim, never pre-created: an unclaimed slot is an absent row.
    const claimed = await query(
      `INSERT INTO depth_watchlist
         (trading_date, slot_no, symbol, slot_type, assigned_by, replaced)
       VALUES ($1, $2, $3, 'WAKEUP', 'WAKEUP_SCAN', $4)
       ON CONFLICT (trading_date, slot_no) DO UPDATE SET
         symbol = EXCLUDED.symbol,
         assigned_at = now(),
         released_at = NULL,
         replaced = EXCLUDED.replaced
       RETURNING slot_no`,
      [day, slot, cand.symbol, replaced],
    );
    if (!claimed.rowCount) continue;

    // HISTORY second. The event, with the pace that justified it.
    const res = await query(
      `INSERT INTO signal_log
         (fired_at, trading_date, symbol, signal, slot, pace, message, replaced)
       VALUES (now(), $1, $2, 'WAKEUP', $3, $4, $5, $6)
       ON CONFLICT (symbol, signal, fired_at) DO NOTHING
       RETURNING id`,
      [day, cand.symbol, slot, cand.pace, message, replaced],
    );

    held.set(slot, { slot, symbol: cand.symbol, pace: cand.pace });
    heldSymbols.add(cand.symbol);
    if (replaced) heldSymbols.delete(replaced);
    out.push({ ...cand, slot, replaced });
  }

  log.info('wake-up scan complete', {
    day, examined: paced.length, firing: firing.length, promoted: out.length,
    promotions: out.map((o) => `${o.symbol} slot ${o.slot} @ ${o.pace}x`),
  });
  return { examined: paced.length, fired: firing.length, promoted: out.length, rows: out };
}

/**
 * The 8 symbols the fast loop watches — pre-day plus wake-up holders.
 *
 * From depth_watchlist, the state. Reading signal_log would answer "what has
 * fired today", which is a different question and includes symbols that were
 * evicted hours ago.
 */
async function slottedSymbols(day = clock.tradingDay()) {
  const { rows } = await query(`
    SELECT slot_no AS slot, symbol, slot_type
      FROM depth_watchlist
     WHERE trading_date = $1 AND symbol IS NOT NULL AND released_at IS NULL
     ORDER BY slot_no`, [day]);
  return rows;
}

module.exports = {
  scan, computePace, currentHolders, holderPaces, slottedSymbols,
  PACE_MIN, TRADES_MIN, WAKEUP_SLOTS,
};

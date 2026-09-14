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
const T = require('./config/thresholds');
const slots = require('./config/slots');
const clock = require('./market/clock');
const log = require('./logger');

const PACE_MIN = T.get('wakeup_pace_min');
const TRADES_MIN = T.get('wakeup_trades_min');
const BASELINE_DAYS = T.get('wakeup_baseline_sessions');
/*
 * P2 · READ, NOT RESTATED. This was `[4, 5, 6, 7, 8]` — a literal sitting
 * beside a router comment that says the GET, both POSTs and the backend's
 * stale check "all follow the published number — never a literal".
 *
 * With SLOT_COUNT=5 the sweep has slots 4 and 5 for wake-ups. The literal
 * offered 6, 7 and 8: the scan seated a symbol in slot 6, reported it
 * promoted, and the client — which truncates the list to what it can sweep —
 * dropped it. Its ladder was never captured, and neither documented endpoint
 * could release the slot, because both validate against SLOT_COUNT.
 *
 * A function, not a constant, so an operator who changes SLOT_COUNT and
 * restarts gets the change here too.
 */
const wakeupSlots = () => slots.wakeupSlots();
const LOT = T.get('wakeup_lot_shares');

/**
 * B2 · the current session budget, from the backend's spread.gate_config — the
 * absolute-volume floor is 300 × shares AT THAT BUDGET, and the budget is read,
 * not restated. spread.* is the backend's; the scraper only READS it (allowed).
 * Falls back to WAKEUP_BUDGET_KD, then 2000, when the store is unreachable.
 */
async function currentBudgetKd() {
  /*
   * F-13 · A FALLBACK BUDGET IS ANNOUNCED, NOT SUBSTITUTED SILENTLY.
   *
   * The catch swallowed EVERY error, not only "the spread schema is absent".
   * A connection blip during a backend deploy therefore replaced the real
   * session budget with 2,000 KD without a word. At a true budget of 600 KD on
   * a 250-fil stock that is a floor of 2,400,000 shares instead of 720,000 —
   * symbols that should fire do not, and nothing in the log says the number
   * was a guess.
   *
   * The two cases are now distinguished: a missing schema is the documented
   * scraper-only case and is expected; anything else is a failure and says so.
   * Either way the fallback is logged the first time it is used, because a
   * default that nobody knows is in force is indistinguishable from a
   * measurement.
   */
  try {
    const { rows } = await query(
      `SELECT config FROM spread.gate_config ORDER BY version DESC LIMIT 1`);
    const v = rows[0] && rows[0].config ? rows[0].config['session-budget'] : null;
    const n = Number(typeof v === 'object' && v ? v.numericValue : v);
    if (Number.isFinite(n) && n > 0) return n;
    warnBudgetFallback('spread.gate_config holds no usable session-budget');
  } catch (err) {
    const absent = /does not exist/i.test(err.message || '');
    warnBudgetFallback(absent
      ? 'spread.gate_config is absent (scraper-only database)'
      : `spread.gate_config could not be read: ${err.message}`);
  }
  return T.get('wakeup_budget_fallback_kd');
}

let budgetFallbackWarned = null;
function warnBudgetFallback(reason) {
  const using = T.get('wakeup_budget_fallback_kd');
  if (budgetFallbackWarned === reason) return;
  budgetFallbackWarned = reason;
  log.warn('wake-up: using a FALLBACK session budget', {
    reason,
    budgetKd: using,
    note: 'the absolute-volume floor is computed from this. A wrong budget moves '
      + 'the floor proportionally, and nothing downstream can tell a fallback '
      + 'from a measurement.',
  });
}

/**
 * B2 · per-symbol MOVEMENT and ACTIVITY inputs for the movement test: today's
 * range, the move from the open, the count of ≥N-fil up-moves, today's volume
 * and the symbol's own average, and whether it halted today. From the board-wide
 * quotes grid, up to `atHour`.
 */
async function computeMovement(day = clock.tradingDay(), atHour = null) {
  const hour = atHour === null ? new Date().getUTCHours() + 3 : atHour;
  const upmove = T.get('wakeup_upmove_fils');
  const { rows } = await query(`
    WITH q AS (
      SELECT symbol, created_at, session, trades, volume,
             last_price::numeric AS last_price,
             high_price::numeric AS high_price, low_price::numeric AS low_price,
             lag(last_price::numeric) OVER (PARTITION BY symbol ORDER BY created_at) AS prev_px
        FROM awsat_market_quotes
       WHERE trading_date = $1 AND last_price IS NOT NULL AND last_price > 0
         AND EXTRACT(hour FROM created_at AT TIME ZONE 'Asia/Kuwait') <= $2
    ),
    agg AS (
      SELECT symbol,
             max(trades)  AS trades_today,
             max(volume)  AS volume_today,
             (array_agg(last_price ORDER BY created_at))[1]      AS open_px,
             (array_agg(last_price ORDER BY created_at DESC))[1] AS last_px,
             max(GREATEST(COALESCE(high_price, last_price), last_price)) AS high_px,
             min(LEAST(COALESCE(low_price, last_price), last_price))     AS low_px,
             count(*) FILTER (WHERE prev_px IS NOT NULL AND (last_price - prev_px) >= $3) AS up_moves,
             bool_or(session ~* 'auction|halt|circuit|suspend|\\ycb\\y') AS halted_today
        FROM q GROUP BY symbol
    ),
    vavg AS (
      -- the symbol's own average daily volume over the prior sessions
      SELECT symbol, avg(vol) AS vol_avg FROM (
        SELECT symbol, trading_date, max(volume) AS vol
          FROM awsat_market_quotes
         WHERE trading_date < $1 AND trading_date >= $1 - ($4 || ' days')::interval
           AND volume IS NOT NULL
         GROUP BY symbol, trading_date
      ) d GROUP BY symbol
    )
    SELECT a.*, v.vol_avg
      FROM agg a LEFT JOIN vavg v USING (symbol)`, [day, hour, upmove, BASELINE_DAYS * 3]);

  return rows.map((r) => {
    const open = r.open_px == null ? null : Number(r.open_px);
    const last = r.last_px == null ? null : Number(r.last_px);
    const high = r.high_px == null ? null : Number(r.high_px);
    const low = r.low_px == null ? null : Number(r.low_px);
    return {
      symbol: r.symbol,
      tradesToday: Number(r.trades_today || 0),
      volumeToday: Number(r.volume_today || 0),
      volAvg: r.vol_avg == null ? null : Number(r.vol_avg),
      open, last, price: last,
      rangeFils: high != null && low != null ? high - low : null,
      moveFromOpen: last != null && open != null ? last - open : null,
      upMoves: Number(r.up_moves || 0),
      haltedToday: r.halted_today === true,
    };
  });
}

/**
 * B2 · the movement test. ACTIVITY (any of three) AND MOVEMENT (both) AND an
 * absolute-volume floor. Returns { fires, reasons, floor } per the config.
 */
function movementVerdict(m, pace, budgetKd) {
  const paceMult = T.get('wakeup_pace_mult');
  const volMult = T.get('wakeup_vol_mult');
  const moveOpen = T.get('wakeup_move_open_fils');
  const rangeMin = T.get('wakeup_range_min_fils');
  const floorShares = T.get('wakeup_abs_vol_floor_shares');
  const floorFrac = T.get('wakeup_abs_vol_floor_frac');

  const activity =
    (pace != null && pace >= paceMult) ||
    (m.volAvg != null && m.volAvg > 0 && m.volumeToday >= volMult * m.volAvg) ||
    (m.moveFromOpen != null && Math.abs(m.moveFromOpen) >= moveOpen);
  const movement =
    (m.rangeFils != null && m.rangeFils >= rangeMin) &&
    // F-12 · the one term in this function that was a literal. Every other
    // number here comes from the threshold file, and config/thresholds.js says
    // so in as many words: "Every number here, never a literal in wakeup.js."
    (m.upMoves != null && m.upMoves >= T.get('wakeup_upmoves_min'));
  /*
   * F-13 · AN UNMEASURABLE PRICE IS NOT A FLOOR OF ZERO.
   *
   * This was `m.price > 0 ? … : 0`. m.price is null when the symbol's captures
   * carry no usable last_price — `null > 0` is false, so sharesAtBudget became
   * 0, the floor became 0, and `absVol` became `volumeToday >= 0`: ALWAYS TRUE.
   * The most permissive possible answer, produced by the absence of the number
   * the test is built on.
   *
   * A thinly-quoted symbol could then claim a depth slot ahead of a real
   * candidate on a floor of zero shares, where a 250-fil stock would have had
   * to clear 240,000.
   *
   * NOT COMPUTED is the answer: without a price the floor cannot be stated, so
   * the test cannot pass. The verdict carries the reason so the log says which
   * term was missing rather than only that the symbol did not fire.
   */
  const sharesAtBudget = (m.price != null && m.price > 0)
    ? Math.floor((budgetKd * 1000) / m.price / LOT) * LOT
    : null;
  const floor = sharesAtBudget === null ? null : Math.round(floorShares * sharesAtBudget * floorFrac);
  const absVol = floor === null ? false : m.volumeToday >= floor;

  const notComputed = [];
  if (m.price == null || m.price <= 0) notComputed.push('price');
  if (m.rangeFils == null) notComputed.push('rangeFils');
  if (m.upMoves == null) notComputed.push('upMoves');

  return {
    fires: activity && movement && absVol,
    activity,
    movement,
    absVol,
    floor,
    // Empty means every term was measured. Non-empty means the verdict is a
    // refusal for want of data, not a measurement that came out negative.
    notComputed,
  };
}

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

  // B2 · the movement test replaces the pace-only trigger. Pace still feeds
  // ACTIVITY (a), but MOVEMENT and the absolute-volume floor now decide.
  const paced = await computePace(day, atHour);
  const paceBy = new Map(paced.map((p) => [p.symbol, p.pace]));
  // SPR-31 · the divisor behind pace, so a "13.9x" in the feed is checkable
  // (473 trades / 34 baseline). A tiny baseline is what made 92x on 92 trades.
  const baselineBy = new Map(paced.map((p) => [p.symbol, p.median_trades]));
  const moves = await computeMovement(day, atHour);
  const budgetKd = await currentBudgetKd();
  const firing = moves
    .map((m) => ({ ...m, pace: paceBy.get(m.symbol) ?? null, v: movementVerdict(m, paceBy.get(m.symbol) ?? null, budgetKd) }))
    .filter((m) => m.v.fires)
    // Priority: (1) halted today, (2) largest range in fils, (3) most 3-fil
    // up-moves, (4) volume ratio — last.
    .sort((a, b) => {
      if (a.haltedToday !== b.haltedToday) return a.haltedToday ? -1 : 1;
      if ((b.rangeFils ?? 0) !== (a.rangeFils ?? 0)) return (b.rangeFils ?? 0) - (a.rangeFils ?? 0);
      if (b.upMoves !== a.upMoves) return b.upMoves - a.upMoves;
      const ar = a.volAvg ? a.volumeToday / a.volAvg : 0;
      const br = b.volAvg ? b.volumeToday / b.volAvg : 0;
      return br - ar;
    })
    .map((m) => ({ ...m, trades: m.tradesToday })); // keep the field the rest reads

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

    const free = wakeupSlots().find((s) => !held.has(s));
    let slot = free;
    let replaced = null;

    if (slot === undefined) {
      /**
       * ─── A WAKE-UP NEVER DISPLACES AN OCCUPIED SLOT ───────────────────────
       *
       * This used to evict the lowest-pace holder. So a symbol chosen
       * deliberately at 09:50 could be overwritten by a scan at 09:52 — which
       * looks like a bug and is very hard to trace, because nothing in the
       * book data says the slot changed hands.
       *
       * The refusal is LOGGED and SURFACED, not swallowed. If ABAR wakes at
       * 3.4x and cannot get a slot, that is a decision for the trader — and
       * they only get to make it if they are told.
       */
      const weakest = [...held.values()]
        .sort((a, b) => Number(a.pace ?? 0) - Number(b.pace ?? 0))[0];

      log.warn('wake-up could not claim a slot — all five are held', {
        symbol: cand.symbol,
        pace: cand.pace,
        trades: cand.trades,
        weakestHeld: weakest ? weakest.symbol : null,
        weakestPace: weakest ? weakest.pace : null,
        note: 'swap it by hand if it is worth a slot: POST /ingest/slots/:n',
      });

      // Into the feed, so a blocked wake-up becomes a prompt rather than a log
      // line nobody reads.
      await query(
        `INSERT INTO signal_log
           (fired_at, trading_date, symbol, signal, slot, pace, message)
         VALUES (now(), $1, $2, 'WAKEUP_BLOCKED', NULL, $3, $4)
         ON CONFLICT DO NOTHING`,
        [day, cand.symbol, cand.pace,
          `woke ${cand.pace}x on ${cand.trades} trades (÷${baselineBy.get(cand.symbol) ?? '?'} baseline) — no free slot`
          + (weakest ? `. ${weakest.symbol} is the deadest at ${weakest.pace ?? '?'}x. Swap?` : '')],
      ).catch(() => {});

      out.push({ symbol: cand.symbol, pace: cand.pace, slot: null, blocked: true });
      continue;
    }

    // SPR-31 · show the divisor so the multiple can be checked, without losing
    // the "on N trades" phrasing the rest of the system reads.
    const base = baselineBy.get(cand.symbol);
    const paceStr = cand.pace != null
      ? `pace ${cand.pace}x on ${cand.trades} trades (÷${base ?? '?'} baseline)`
      : `${cand.trades} trades (no pace baseline)`;
    const message = replaced
      ? `${paceStr} — replaced ${replaced}`
      : paceStr;

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
    // A BLOCKED wake-up is not a promotion. Counting it as one would report
    // five promotions on a day when nothing changed slots.
    day, examined: paced.length, firing: firing.length,
    promoted: out.filter((r) => !r.blocked).length,
    blocked: out.filter((r) => r.blocked).length,
    promotions: out.map((o) => `${o.symbol} slot ${o.slot} @ ${o.pace}x`),
  });
  return {
    examined: paced.length,
    fired: firing.length,
    promoted: out.filter((r) => !r.blocked).length,
    blocked: out.filter((r) => r.blocked).length,
    rows: out,
  };
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

/**
 * B2 · the HARD-RULE dry-run — before the new trigger ships, run it against the
 * last N sessions and report how many symbols would fire per session, and which.
 * If it is under one per session the absolute-volume floor is too high (the
 * wake-up finds stocks to WATCH, not to fill at full size): lower
 * wakeup_abs_vol_floor_frac toward 1/3 and run again. No writes — a report only.
 */
async function dryRun({ sessions = 5, atHour = 13 } = {}) {
  const { rows: days } = await query(
    `SELECT DISTINCT trading_date FROM awsat_market_quotes ORDER BY trading_date DESC LIMIT $1`, [sessions]);
  const budgetKd = await currentBudgetKd();
  const out = [];
  for (const d of days.reverse()) {
    const moves = await computeMovement(d.trading_date, atHour);
    const paced = await computePace(d.trading_date, atHour);
    const paceBy = new Map(paced.map((p) => [p.symbol, p.pace]));
    const fired = moves.filter((m) => movementVerdict(m, paceBy.get(m.symbol) ?? null, budgetKd).fires);
    // S13 · this was `clock.toDay ? clock.toDay(...) : ...`. clock has never
    // exported toDay, so the guard was permanently false and only made the
    // reader think there was a second path. The slice IS the path.
    out.push({ day: String(d.trading_date).slice(0, 10),
      examined: moves.length, fired: fired.length, symbols: fired.map((f) => f.symbol) });
  }
  const avg = out.length ? out.reduce((s, r) => s + r.fired, 0) / out.length : 0;
  return { budgetKd, floorFrac: T.get('wakeup_abs_vol_floor_frac'), perSession: out, avgPerSession: Number(avg.toFixed(2)),
    tooHigh: avg < 1 };
}

module.exports = {
  scan, computePace, computeMovement, movementVerdict, dryRun, currentBudgetKd,
  currentHolders, holderPaces, slottedSymbols,
  PACE_MIN, TRADES_MIN, wakeupSlots,
};

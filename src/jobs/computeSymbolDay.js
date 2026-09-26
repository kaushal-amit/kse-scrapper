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
 * ─── AND MOST OF WHAT THIS PARAGRAPH USED TO DESCRIBE IS GONE (053) ───────
 *
 * It used to say the BOOK group (bid_p10..p90, the offer and spread
 * percentiles, refill_ratio, wall_*, bid_age_p50_secs) and the BUDGET group
 * (net_per_fil, shares_at_budget, budget_for_queue_kd, max_budget_kd) "stay
 * NULL by design" — depth covers 8 to 18 symbols of 142, so filling the book
 * columns would give a row complete for those and misleading for the rest;
 * and the budget figures are properties of an ACCOUNT rather than of a stock,
 * changing whenever the balance does.
 *
 * Both reasons were and are correct, and they explain why those columns were
 * never FILLED. They never explained why they should EXIST. A column nothing
 * writes and nothing reads still looks like a measurement, still passes every
 * IS NOT NULL test nobody wrote, and is still read by a study as though it
 * meant something — so 053 dropped forty-five of them.
 *
 * WHAT SURVIVES UNWRITTEN, AND WHY: eleven columns that spread.symbol_day —
 * the board's view — selects. Five directly (markup, resumed, lift, hit,
 * block_ratio) and six as the FIRST branch of a COALESCE over
 * spread.symbol_day_stats (pct_postable, pct_exitable, exitable_best_hour,
 * bid_p25, bid_p50, vol_ratio_5d). Those six are not dead: they are the
 * PREFERRED source, NULL on purpose so the backend's recompute is used, and
 * filling them here would silently take over from it.
 *
 * `family` is CRAWLER or NULL — every other class needs bid_p50, which is one
 * of the eleven and is therefore still here.
 */

const { query } = require('../db/pool');
const clock = require('../market/clock');
const log = require('../logger');
const M = require('./symbolDayMetrics');
const { repairAwaitingCloses } = require('./repairAwaitingCloses');
const T = require('../config/thresholds');
const { config } = require('../config');

/**
 * CLOSE_TIERS as an ordered array, for the SQL.
 *
 * Derived from the Map rather than restated, so the precedence the close column
 * uses and the precedence prev_close uses cannot drift apart — which is exactly
 * what happened when closeRow() moved to tiers and these queries did not.
 */
const CLOSE_TIER_ORDER = [...M.CLOSE_TIERS.entries()]
  .sort((a, b) => a[1] - b[1])
  .map(([session]) => session);

/** Columns written. Anything absent from here is deliberately left NULL. */
const COLUMNS = [
  'symbol', 'trading_date',
  'cb_auctions',
  'open_px', 'high_px', 'low_px', 'close_px', 'prev_close', 'chg_fils',
  // D3 · which rule supplied prev_close, and whether the feed agreed with
  // itself about the reference. Both are NOT optional: see 055.
  'prev_close_source', 'prev_close_ref_spread',
  'chg_1d', 'chg_5d', 'day_range', 'prev_session_used', 'prev_session_gap_days',
  'total_volume', 'trades', 'avg_trade_size', 'highest_minute_volume',
  'moves', 'up_moves', 'down_moves', 'up_moves_2plus', 'up_moves_3plus',
  'up_moves_tiny', 'down_moves_tiny', 'tiny_pct_up', 'tiny_pct_down',
  'trades_under_100',
  'bought_at_offer', 'sold_at_bid', 'shares_inside_spread',
  'trades_at_offer', 'trades_at_bid', 'pct_at_offer', 'buy_sell_ratio',
  'minutes_captured', 'coverage_pct', 'data_quality', 'quality_rule_version',
  'source', 'close_source',
  // The shape of the session's trading, not its totals. Logged, never gated.
  'avg_uptick_shares', 'avg_downtick_shares', 'uptick_ratio',
  'n_upticks', 'n_downticks', 'turnover_kd',
  'first_half_shares_per_min', 'second_half_shares_per_min',
  'avg_spread_fils', 'avg_spread_pct', 'days_active', 'down_days', 'peak_hour',
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

/*
 * ============================================================================
 *  THE REFUSAL · a recompute does not overwrite a label it cannot produce
 * ============================================================================
 * 3,496 rows across 27 days carry data_quality = 'PARTIAL'. No commit on any
 * branch can produce that value — dataQuality() returned FULL or THIN on
 * release/2026-09, on amit, and on both deployed commits (b29248f, 4588d10).
 * They are real measurements by a rule that is lost.
 *
 * compute() takes a day, so any past day can be recomputed, and the after-close
 * catch-up added for item #8 exists precisely to reach back to days that were
 * missed — 14 September, which still holds 120 PARTIAL rows, is one of them.
 * Without this, the first catch-up run silently converts those labels to rule
 * 2's and the count of what was lost is unrecoverable.
 *
 * So a row already labelled by rule 1 keeps its label, its coverage and its
 * NULL version. Everything else on the row — prices, volumes, breadth inputs —
 * updates normally: this refuses the three columns whose meaning would change,
 * not the recompute.
 *
 * It is deliberately not a date cutoff. A date is a guess about which rows are
 * old; quality_rule_version is the row saying which rule wrote it.
 */
const PRESERVED_FROM_RULE_1 = new Set(['data_quality', 'coverage_pct', 'quality_rule_version']);
const RULE_1_ROW = 'symbol_day.quality_rule_version IS NULL AND symbol_day.data_quality IS NOT NULL';

/** The median minute count across the market, for that day. Same window as the
 *  per-symbol count, or the two are not comparable. */
function marketMedianMinutes(bySymbol, bounds = null) {
  const counts = [...bySymbol.values()].map((rows) => M.minutesCaptured(rows, bounds)).sort((a, b) => a - b);
  if (!counts.length) return 0;
  const mid = Math.floor(counts.length / 2);
  return counts.length % 2 ? counts[mid] : Math.round((counts[mid - 1] + counts[mid]) / 2);
}

/**
 * ============================================================================
 *  THE SCHEDULED CAPTURE WINDOW — the denominator that cannot collapse
 * ============================================================================
 * public.market_session_hours holds a row only for days that DIFFER from the
 * standard window: a half-day, an early close, a late open. Everything else
 * uses CAPTURE_START_TIME..CAPTURE_END_TIME from config.
 *
 * `assumed` is returned and logged rather than hidden. A denominator read from
 * the calendar and one taken from a default are not the same measurement, and
 * the whole reason this function exists is that the old denominator was
 * derived from the data it was measuring. Replacing one invisible assumption
 * with another would be no better.
 *
 * A missing table is not an error here: 049 may not have run yet on a host
 * that is otherwise fine, and a capture service must not refuse to capture
 * over it. It falls back to the standard window and says so.
 */
/*
 * ─── THE DENOMINATOR IS THE CONTINUOUS SESSION, NOT THE CAPTURE DOOR ───────
 *
 * This read capture_open..capture_close — the INGEST window, 08:40-13:20, 280
 * minutes. The measure exists to tell an analysis whether a day is usable, and
 * analyses consume continuous trading: 09:00-13:00, 240 minutes. Counting from
 * 08:40 against 240 put 13 September at 108%; counting to 13:20 would make a
 * Close-Of-Day row ingested at 14:43 lengthen the day it closes.
 *
 * Both halves of the fraction now use session_open..session_close, and
 * minutesCaptured() is given the same bounds. Pre-open capture is still
 * ingested and still useful; its absence is simply not a data-quality failure
 * for anything downstream.
 */
async function scheduledMinutesFor(day) {
  const fallback = {
    minutes: config.market.sessionEndMinutes - config.market.sessionStartMinutes,
    startMinutes: config.market.sessionStartMinutes,
    endMinutes: config.market.sessionEndMinutes,
    assumed: true,
    reason: 'no market_session_hours row — the standard '
          + `${config.market.sessionStartTime}-${config.market.sessionEndTime} session`,
  };
  try {
    const { rows } = await query(
      `SELECT (EXTRACT(hour FROM session_open)  * 60 + EXTRACT(minute FROM session_open))  AS open_mins,
              (EXTRACT(hour FROM session_close) * 60 + EXTRACT(minute FROM session_close)) AS close_mins,
              reason
         FROM public.market_session_hours WHERE trading_date = $1`, [day]);
    if (!rows.length) return fallback;
    const startMinutes = Number(rows[0].open_mins);
    const endMinutes = Number(rows[0].close_mins);
    return { minutes: endMinutes - startMinutes, startMinutes, endMinutes, assumed: false,
      reason: rows[0].reason || 'a market_session_hours row' };
  } catch (e) {
    if (e.code === '42P01' || e.code === '42703') {
      // 42703 = the table exists from an earlier 049 without session_open.
      return { ...fallback,
        reason: `${fallback.reason} (market_session_hours missing or has no session_open — run migration 049)` };
    }
    throw e;
  }
}

/**
 * The short-session trigger (049).
 *
 * All 47 sessions measured on 25 September were normal-length, so the
 * 60-minute absolute floor is REASONED AND UNMEASURED: on a normal day
 * 0.50 x 240 = 120 minutes clears it twice over and it can never fire, and on
 * a genuinely short scheduled session the proportional test alone would pass a
 * day with 45 minutes of data. The first short session is therefore the first
 * observation of the branch, and it must not slip past unnoticed — a caveat in
 * a document is read once; this fires on its own.
 */
const SHORT_SESSION_MINUTES = 240;

/**
 * ============================================================================
 *  THE EMPTY BANDS — an alarm, not a comment (049)
 * ============================================================================
 * 0.94 and 0.50 sit in bands that are EMPTY across 6,557 symbol-days: nothing
 * measured between 93% and 95%, nothing between 50% and 52.5%. That is not
 * luck, it is the failure mode — one client serves every symbol, so a capture
 * dies at a moment and the whole market loses the same tail, which makes days
 * cluster and leaves real space between the clusters.
 *
 * A DIFFERENT FAILURE MODE WOULD FILL THEM IN. A slow degradation — a feed
 * getting gradually later rather than stopping — puts symbol-days inside the
 * band, and the first one is worth knowing about on the day it happens rather
 * than at the next audit. It does NOT mean the threshold is wrong; it means
 * the assumption the threshold was chosen under no longer holds.
 *
 * So: a cheap data_alarm row. The loud form of a robustness choice — a margin
 * that is only ever described in a comment is a margin nobody checks.
 */
async function alarmOnBandOccupancy(day, built, scheduledMinutes) {
  if (!(scheduledMinutes > 0) || !built.length) return;
  const bands = [
    { name: 'FULL', lo: Number(T.get('sd_full_band_lo')), hi: Number(T.get('sd_full_min_fraction')) },
    { name: 'PARTIAL', lo: Number(T.get('sd_partial_min_fraction')), hi: Number(T.get('sd_partial_band_hi')) },
  ];
  for (const b of bands) {
    if (!(b.hi > b.lo)) continue;
    const hits = built
      .map((r) => ({ symbol: r.symbol, frac: Number(r.minutes_captured) / scheduledMinutes }))
      // Half-open (lo, hi]. A value exactly on a boundary belongs to one side,
      // and which side is the whole point of the band.
      .filter((x) => Number.isFinite(x.frac) && x.frac > b.lo && x.frac <= b.hi);
    if (!hits.length) continue;

    const msg = `${day}: ${hits.length} symbol-day(s) landed INSIDE the empty `
      + `${b.name} band (${b.lo}, ${b.hi}]. Measured over 47 sessions to 25 September that `
      + 'band held nothing at all, because capture failed in quantised steps — the whole '
      + 'market losing the same tail at the same moment. A value in here means the FAILURE '
      + 'MODE HAS CHANGED (a slow degradation rather than a clean cut), not that the '
      + 'threshold is wrong. Re-measure the distribution before moving any boundary.';
    log.warn('symbol_day: an empty quality band is no longer empty',
      { day, band: b.name, lo: b.lo, hi: b.hi, count: hits.length,
        sample: hits.slice(0, 5).map((h) => `${h.symbol} ${(100 * h.frac).toFixed(1)}%`) });
    await query(
      `INSERT INTO data_alarm (trading_date, table_name, column_name, alarm, detail)
       VALUES ($1, 'symbol_day', 'data_quality', 'QUALITY_BAND_OCCUPIED', $2)
       ON CONFLICT DO NOTHING`,
      [day, JSON.stringify({ band: b.name, lo: b.lo, hi: b.hi, scheduledMinutes,
        count: hits.length, symbols: hits.slice(0, 20), what: msg })]).catch((e) => {
      // Best-effort, exactly like the market_day alarm: losing the alarm must
      // not lose the rows.
      log.warn('symbol_day: could not write the band data_alarm row', { day, error: e.message });
    });
  }
}

function noteShortSession(day, sched) {
  if (sched.assumed || !(sched.minutes > 0) || sched.minutes >= SHORT_SESSION_MINUTES) return false;
  log.warn('shortSessionFirstObservation', {
    day,
    sessionMinutes: sched.minutes,
    reason: sched.reason,
    floorMinutes: T.get('sd_thin_absolute_minutes'),
    partialFloorMinutes: Math.round(T.get('sd_partial_min_fraction') * sched.minutes),
    note: 'FIRST SHORT SCHEDULED SESSION — the absolute floor has never been '
        + 'observed doing anything. Check its behaviour deliberately and report: '
        + 'below 120 scheduled minutes the proportional test stops protecting it.',
  });
  return true;
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
      --
      -- H-K · AND THE REACH IS CAPPED, which the docblock above has always
      -- claimed and nothing enforced. "back = 1" took the most recent session
      -- that produced a close HOWEVER FAR BACK that was, so a symbol suspended
      -- for three weeks returned with chg_fils measured against its
      -- pre-suspension price — and that number went on to down_days, the
      -- breadth count and the signal scoring as though it were a day's move.
      --
      -- The cap is on MARKET sessions, not on the symbol's own: five usable
      -- sessions before this one. A symbol with no close in that window keeps
      -- prev_close NULL and is not measured, which is the state
      -- prev_session_gap_days exists to make visible.
      SELECT trading_date FROM ends
       WHERE (extract(hour FROM (last_capture AT TIME ZONE 'Asia/Kuwait')) * 60
            + extract(minute FROM (last_capture AT TIME ZONE 'Asia/Kuwait'))) >= $2
       ORDER BY trading_date DESC
       LIMIT $3
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
             /*
              * P2 · THE SAME CLOSE RULE THE close_px COLUMN USES.
              *
              * This was "session = ANY(closing_sessions())" ordered by
              * created_at — a session LIST plus "latest capture", which is the
              * rule symbolDayMetrics abandoned and argues against by name:
              *
              *   "A list plus 'latest by created_at' picks whichever session
              *    happened to be captured last, which is not the same as the
              *    best available close. CABLE on 2 August has a Close-Of-Day at
              *    1650 captured at 10:17 and an auction print at 1648 captured
              *    later in the file — ordering by time reaches the auction and
              *    never gets to the official close."
              *
              * closeRow() was changed to a PRECEDENCE ORDER; previousCloses was
              * not. So symbol_day contradicted itself: the row for 2 August said
              * close_px 1650 with close_source CLOSE_OF_DAY, and the row for
              * 3 August said the previous close was 1648. chg_fils was measured
              * from a base the table itself denies — and it feeds breadth,
              * pct_advancing, market_day.regime, down_days and the signal
              * scoring evidence base. Two fils is enough to flip a symbol
              * between advancing and declining.
              *
              * $4 is CLOSE_TIERS, in order, from symbolDayMetrics — one list,
              * passed in, so the two rules cannot drift apart again.
              *
              * NULL sessions are excluded here as they are there: those are the
              * 14:13-14:23 Friday reads, after the close on a non-trading day,
              * whose volume is cumulative rather than new. '' is kept — it is a
              * July capture defect on continuous-trading rows, not a state.
              */
             AND q.session IS NOT NULL
             AND array_position($4::text[], q.session) IS NOT NULL
           ORDER BY q.symbol, q.trading_date DESC,
                    array_position($4::text[], q.session), q.created_at DESC
        ) withClose
    )
    SELECT symbol, trading_date AS prev_day, close_px AS prev_close
      FROM candidates WHERE back = 1`,
  [day, cutoffMinutes, T.get('sd_prev_close_max_sessions_back'), CLOSE_TIER_ORDER]);

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

/**
 * days_active and down_days — both lookbacks, both per symbol, one query.
 *
 * days_active counts sessions the symbol TRADED in the last 20 with data. A
 * stock active 3 of 20 is a different proposition from one active 20, and no
 * other column says so in a number.
 *
 * down_days is a run length, which chg_1d cannot give: it describes one day.
 */
/**
 * days_active and down_days, as at the END of `day`.
 *
 * F-14 · COMPUTED FROM THE SESSIONS BEFORE `day`, PLUS TODAY'S OWN ROWS.
 *
 * Both CTEs used to read `symbol_day WHERE trading_date <= $1` — including
 * today — and ran BEFORE today's row was written. So the answer depended on
 * whether the day had been computed before:
 *
 *   ARABREC fell on 8, 9, 10 and 11 September. First run of
 *   `daily.symbolday --date=2026-09-11`: symbol_day has no row for the 11th,
 *   so `back = 1` is the 10th and down_days is written as 3. Re-run an hour
 *   later: today's row now exists, `back = 1` is the 11th, and the SAME COMMAND
 *   writes 4.
 *
 * Same command, same data, two different numbers — in a column the backend
 * reads as a run length — and the first-run value is yesterday's streak wearing
 * today's date. The file's own header claims "Idempotent: re-running a day
 * corrects it rather than duplicating."
 *
 * The fix is to stop reading today's row at all and to fold today's OWN measured
 * values in explicitly. `todayRows` is the map of what this run has just
 * computed, so the answer is the same whether or not a previous run left a row
 * behind.
 */
async function activityBlock(day, todayRows = new Map()) {
  const { rows } = await query(`
    WITH sessions AS (
      -- STRICTLY BEFORE today. Today is folded in from this run's own numbers.
      SELECT DISTINCT trading_date FROM symbol_day
       WHERE trading_date < $1 ORDER BY trading_date DESC LIMIT 19
    ),
    active AS (
      SELECT sd.symbol, count(*)::int AS days_active
        FROM symbol_day sd JOIN sessions s USING (trading_date)
       WHERE COALESCE(sd.total_volume, 0) > 0
       GROUP BY sd.symbol
    ),
    runs AS (
      -- Consecutive down sessions, this one included. A gap in the sequence
      -- ends the run: two down days either side of an untraded day is not a
      -- run of three.
      SELECT symbol, trading_date, chg_fils,
             row_number() OVER (PARTITION BY symbol ORDER BY trading_date DESC) AS back
        FROM symbol_day WHERE trading_date < $1
    ),
    streak AS (
      SELECT symbol,
             (SELECT count(*)::int FROM runs r2
               WHERE r2.symbol = r.symbol
                 AND r2.back <= COALESCE((SELECT min(back) FROM runs r3
                       WHERE r3.symbol = r.symbol AND COALESCE(r3.chg_fils, 0) >= 0), 999) - 1
             ) AS down_days
        FROM runs r WHERE r.back = 1
    )
    SELECT COALESCE(a.symbol, st.symbol) AS symbol,
           a.days_active, st.down_days
      FROM active a FULL OUTER JOIN streak st ON a.symbol = st.symbol`, [day]);
  const prior = new Map();
  for (const r of rows) {
    prior.set(r.symbol, {
      days_active: r.days_active === null ? null : Number(r.days_active),
      down_days: r.down_days === null ? null : Number(r.down_days),
    });
  }

  /*
   * Fold in TODAY, from this run's own measurements rather than from the table.
   *
   *   days_active — today counts if it traded.
   *   down_days   — today EXTENDS the run if today fell; if today did not fall
   *                 the run is 0, whatever yesterday's was. A null chg_fils is
   *                 direction UNKNOWN, not flat: it can neither extend a run nor
   *                 honestly end one, so the streak becomes null rather than
   *                 silently reporting yesterday's.
   */
  const out = new Map(prior);
  for (const [symbol, today] of todayRows) {
    const base = prior.get(symbol) || { days_active: 0, down_days: 0 };
    const traded = Number(today.total_volume || 0) > 0;
    const chg = today.chg_fils;

    let downDays;
    if (chg === null || chg === undefined) downDays = null;
    else if (Number(chg) < 0) downDays = (base.down_days === null ? null : base.down_days + 1);
    else downDays = 0;

    out.set(symbol, {
      days_active: (base.days_active || 0) + (traded ? 1 : 0),
      down_days: downDays,
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
      /*
       * P2 · CAPPED, like previousCloses.
       *
       * H-K capped the chg_1d reach and measured-denominators.test.js asserted
       * "the chg_5d query is untouched — back = 5 bounds itself". It bounds the
       * COUNT, not the REACH: "back" counts the SYMBOL's own closes, and H-K's
       * own comment draws exactly that distinction — "the cap is on MARKET
       * sessions, not on the symbol's own".
       *
       * A symbol that printed on only five of the last forty sessions had its
       * chg_5d measured against a close two months old, reported in a column
       * named for five sessions, with no prev_session_gap_days analogue to say
       * so. The window is the same market sessions previousCloses uses, so the
       * two columns describe the same span of trading.
       */
      SELECT trading_date FROM ends
       WHERE (extract(hour FROM (last_capture AT TIME ZONE 'Asia/Kuwait')) * 60
            + extract(minute FROM (last_capture AT TIME ZONE 'Asia/Kuwait'))) >= $2
       ORDER BY trading_date DESC
       LIMIT $5
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
             -- P2 · the same precedence rule as above. chg_5d measured its base
             -- with the superseded "latest capture" rule too.
             AND q.session IS NOT NULL
             AND array_position($3::text[], q.session) IS NOT NULL
           ORDER BY q.symbol, q.trading_date DESC,
                    array_position($3::text[], q.session), q.created_at DESC
        ) withClose
    )
    SELECT symbol, close_px AS px FROM candidates WHERE back = $4`,
  [day, cutoffMinutes, CLOSE_TIER_ORDER, T.get('sd_chg5d_sessions_back'),
    T.get('sd_chg5d_max_sessions_back')]);
  const out = new Map();
  for (const r of rows) out.set(r.symbol, Number(r.px));
  return out;
}

function buildRow(symbol, day, rows, marketMedian, scheduledMinutes = null, bounds = null) {
  const price = M.priceBlock(rows);
  const close = M.closePrice(rows);
  const volume = M.volumeBlock(rows);
  const movement = M.movementBlock(rows);
  // Same window as the denominator — see minutesCaptured()'s docblock.
  const minutes = M.minutesCaptured(rows, bounds);
  const closeOfDay = M.hasCloseOfDay(rows);

  return {
    symbol,
    trading_date: day,
    ...price,
    /*
     * D6 · THE HIGH AND LOW COME FROM THE FEED, NOT FROM WHAT WE SAMPLED.
     *
     * priceBlock still supplies open_px (see feedRange's docblock for why
     * open is deliberately left alone — it is read by a live trading gate).
     * high_px and low_px are overwritten by the exchange's own running
     * extremes, which arrive on every quote row and are 100% populated across
     * all 49 captured days.
     *
     * Our sampled version was below the feed high on 974 of 6,351 symbol-days
     * and above the feed low on 1,100, and NEVER the other way — the
     * signature of a sampling floor, not a disagreement. A 60-second grid
     * cannot see a spike that came back inside the minute.
     *
     * The feed value is used only when it exists; a day with no high_price at
     * all falls back to the sampled one rather than losing the range.
     */
    ...(() => {
      const f = M.feedRange(rows);
      return {
        high_px: f.feed_high !== null ? f.feed_high : price.high_px,
        low_px: f.feed_low !== null ? f.feed_low : price.low_px,
      };
    })(),
    cb_auctions: M.cbAuctions(rows),
    close_px: close,
    /*
     * D3 · A DAY WITH NO CLOSE-OF-DAY CAPTURE DOES NOT GET A CLOSE'S LABEL.
     *
     * On 14 September capture stopped at 11:59 and the table recorded those
     * 11:59 prices as the day's closes under a closing-session name, for a
     * session that was never captured. 15 September's prev_close is wrong on
     * 108 of 134 symbols because of it.
     *
     * close_px still holds the best available price — throwing it away helps
     * nobody — but the label says what it is: provisional, and waiting for
     * the following session to publish the real close as its reference.
     * repairAwaitingCloses() then replaces both.
     */
    close_source: closeOfDay ? M.closeSource(rows)
      : (close === null ? null : 'AWAITING_NEXT_SESSION'),
    ...M.flowBlock(rows),
    ...M.spreadBlock(rows, close),
    peak_hour: M.peakHour(rows),
    // day_range follows the SAME extremes as high_px/low_px above. Leaving it
    // on `price` would have the stored range disagree with the stored high
    // minus the stored low, which is the kind of quiet contradiction 049's
    // fingerprint exists to catch.
    day_range: (() => {
      const f = M.feedRange(rows);
      const hi = f.feed_high !== null ? f.feed_high : price.high_px;
      const lo = f.feed_low !== null ? f.feed_low : price.low_px;
      return (hi !== null && lo !== null) ? hi - lo : null;
    })(),
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
    /*
     * Against the SCHEDULED window (049), not the day's own median. The median
     * collapsed with the thing it measured: 20 September captured 188 minutes
     * and stored coverage_pct = 100.0, while 15 September captured 233 and
     * stored 86.3. Both measures divided by the same moving denominator, so
     * fixing data_quality alone would leave a stored 100% sitting beside a
     * PARTIAL label, disagreeing with it.
     */
    coverage_pct: scheduledMinutes > 0
      ? Number(((100 * minutes) / scheduledMinutes).toFixed(2)) : null,
    data_quality: M.dataQuality(minutes, marketMedian, closeOfDay, scheduledMinutes),
    quality_rule_version: M.QUALITY_RULE_VERSION,
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

  const sched = await scheduledMinutesFor(day);
  const bounds = { startMinutes: sched.startMinutes, endMinutes: sched.endMinutes };
  const marketMedian = marketMedianMinutes(bySymbol, bounds);
  noteShortSession(day, sched);
  log.info('symbol_day: computing', {
    day, symbols: bySymbol.size, marketMedianMinutes: marketMedian,
    scheduledMinutes: sched.minutes, scheduleSource: sched.reason,
    denominatorAssumed: sched.assumed,
  });

  // Two queries for the whole day, not two per symbol.
  const prevCloses = await previousCloses(day);
  const back5 = await closesFiveSessionsBack(day);

  const built = [];
  let crossed = 0;
  for (const [symbol, rows] of bySymbol) {
    const row = buildRow(symbol, day, rows, marketMedian, sched.minutes, bounds);

    /*
     * ─── D3 · THE EXCHANGE'S REFERENCE FIRST, THE RECONSTRUCTION SECOND ────
     *
     * `last_price - chg` on this day's own quotes IS the previous official
     * close, published by the exchange and constant through the session. It
     * needs no reach-back, no usable-session rule and no five-session cap,
     * and it disagreed with our reconstruction on 1,138 of 6,082 symbol-days
     * — 41 of them by more than 5%.
     *
     * previousCloses() is kept as the fallback, for a symbol with no usable
     * chg on the day (it never traded, or the board carried no change
     * column). prev_close_source records which one answered, because a
     * fallback nothing can distinguish from the primary is how four defects
     * survived this month.
     *
     * prev_session_used / prev_session_gap_days describe the RECONSTRUCTION,
     * so they are carried only when the reconstruction is what was used.
     * Leaving them populated beside an exchange-sourced prev_close would
     * describe a reach-back that did not happen.
     */
    const carried = prevCloses.get(symbol)
      || { prev_close: null, prev_session_used: null, prev_session_gap_days: null };
    const ref = M.referenceClose(rows);

    if (ref.ref !== null) {
      row.prev_close = ref.ref;
      row.prev_close_source = 'EXCHANGE_REFERENCE';
      row.prev_close_ref_spread = ref.spread;
      row.prev_session_used = null;
      row.prev_session_gap_days = null;
    } else {
      Object.assign(row, carried);
      row.prev_close_source = carried.prev_close === null ? null : 'CARRIED_FORWARD';
      row.prev_close_ref_spread = null;
    }

    const prevClose = row.prev_close;
    row.chg_fils = (row.close_px !== null && prevClose !== null)
      ? row.close_px - prevClose : null;
    row.chg_1d = (row.chg_fils !== null && prevClose)
      ? Number(((100 * row.chg_fils) / prevClose).toFixed(4)) : null;

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

  // 049 · the empty bands either side of the two boundaries. Runs on the rows
  // as measured, before the labels are written, because the question is about
  // the DISTRIBUTION rather than about any one verdict.
  await alarmOnBandOccupancy(day, built, sched.minutes);

  /*
   * F-14 · the streaks are computed AFTER the rows are built, from the sessions
   * BEFORE today plus today's own measured values.
   *
   * It used to run before the loop and read `trading_date <= day` — including a
   * row for today that may or may not have been written by an earlier run. The
   * same command then produced different answers depending on whether it had
   * been run before. See the note on activityBlock.
   */
  const activity = await activityBlock(day, new Map(built.map((r) => [r.symbol, r])));
  for (const row of built) {
    const act = activity.get(row.symbol);
    row.days_active = act ? act.days_active : null;
    row.down_days = act ? act.down_days : null;
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
    .map((c) => (PRESERVED_FROM_RULE_1.has(c)
      ? `${c} = CASE WHEN ${RULE_1_ROW} THEN symbol_day.${c} ELSE EXCLUDED.${c} END`
      : `${c} = EXCLUDED.${c}`)).join(', ')}`,
      values);
    inserted += res.rowCount;
  }

  const thin = built.filter((r) => r.data_quality === 'THIN').length;
  log.info('symbol_day: written', {
    day, symbols: built.length, inserted, thin, crossed, runId,
  });

  /*
   * D3 · NOW THAT THIS SESSION EXISTS, EARLIER DAYS CAN BE REPAIRED.
   *
   * A day whose capture missed the closing auction has no close of its own,
   * and the exchange publishes it the next morning as that session's
   * reference price. This session is that morning for whatever came before
   * it. It only ever touches rows already labelled AWAITING_NEXT_SESSION.
   *
   * Failing here must not fail the night's compute — the rows for TODAY are
   * already written and correct, and a repair of a fortnight-old close is
   * not worth losing them over. It is logged and left for tomorrow's run,
   * which will find the same rows still awaiting.
   */
  let repair = { repaired: 0, stillAwaiting: null };
  try {
    repair = await repairAwaitingCloses(day);
  } catch (e) {
    log.error('symbol_day: the awaiting-close repair failed; today\'s rows are '
      + 'unaffected and the repair will be retried on the next session',
    { day, error: e.message });
  }

  return {
    extracted: bySymbol.size, inserted, rejected: 0, thin,
    closesRepaired: repair.repaired, stillAwaiting: repair.stillAwaiting,
  };
}

module.exports = {
  compute, buildRow, loadDay, marketMedianMinutes, previousCloses,
  closesFiveSessionsBack, COLUMNS,
};

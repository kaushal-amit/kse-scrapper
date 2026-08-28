'use strict';
/**
 * Write symbol_minute — Step 3, item 2 of the order of work.
 *
 * ─── DERIVED, NOT SCRAPED ──────────────────────────────────────────────────
 * Ten of the columns cannot be read from a single observation. buyers_per_seller
 * is a ratio, bid_change is a difference, wall_event is a difference qualified
 * by whether anything traded, and bid_age_secs is a count of how long a level
 * has survived. All of them need the PREVIOUS row, which is why this is a
 * separate step from capture rather than something the client can send.
 *
 * The inputs are awsat_stock_depth and awsat_market_quotes — both already
 * filled by the client. Nothing here scrapes.
 *
 * ─── WHY IT WRITES ONE ROW PER SYMBOL PER TICK ─────────────────────────────
 * The table is named for minutes but keyed on (symbol, ts), and the loop runs
 * every 20 seconds. That is deliberate: the checks compare consecutive rows, so
 * collapsing three observations into one minute would discard exactly the
 * movement they exist to detect.
 */

const { query } = require('../db/pool');
const clock = require('../market/clock');
const log = require('../logger');

/** Both sides above this and nothing trading is FROZEN. */
const BIG_QTY = Number(process.env.SIG_BIG_QTY || 100_000);

/** A wall is size at a price level worth noticing. */
const WALL_QTY = Number(process.env.SIG_WALL_QTY || 200_000);

const num = (v) => (v === null || v === undefined ? null : Number(v));

/**
 * The newest quote and level-1 depth for a symbol.
 *
 * Level 1 only: symbol_minute holds the touch. The deeper ladder lives in
 * awsat_stock_depth and is not flattened into this table — a row per level
 * would break the one-row-per-tick shape the checks depend on.
 */
async function latestObservation(symbol, day) {
  const { rows } = await query(`
    WITH q AS (
      SELECT last_price, bid, bid_qty, offer, offer_qty, volume, created_at
        FROM awsat_market_quotes
       WHERE symbol = $1 AND trading_date = $2
       ORDER BY created_at DESC LIMIT 1
    ),
    d AS (
      SELECT bid AS d_bid, bid_qty AS d_bid_qty, offer AS d_offer,
             offer_qty AS d_offer_qty, created_at AS d_at
        FROM awsat_stock_depth
       WHERE symbol = $1 AND trading_date = $2 AND level = 1
       ORDER BY created_at DESC LIMIT 1
    )
    SELECT * FROM q FULL OUTER JOIN d ON true`, [symbol, day]);

  if (!rows.length) return null;
  const r = rows[0];

  // Depth wins on the book where it exists: it is captured for the slotted
  // symbols specifically and is the more recent look at the touch. The quote
  // grid is the fallback and the only source of price and volume.
  return {
    last_price: num(r.last_price),
    bid: num(r.d_bid ?? r.bid),
    bid_qty: num(r.d_bid_qty ?? r.bid_qty),
    offer: num(r.d_offer ?? r.offer),
    offer_qty: num(r.d_offer_qty ?? r.offer_qty),
    volume: num(r.volume),
    observed_at: r.d_at || r.created_at,
  };
}

/**
 * The last cumulative volume seen per symbol, carried between ticks.
 *
 * symbol_minute deliberately stores the DELTA, so the running total has to be
 * remembered here. Process-local: a restart loses one tick's delta, which is
 * the correct trade against adding a column that duplicates the source.
 */
const lastCumulative = new Map();

/** The row this symbol wrote last, for the differences. */
async function previousRow(symbol, day) {
  const { rows } = await query(
    `SELECT * FROM symbol_minute WHERE symbol = $1 AND trading_date = $2
      ORDER BY ts DESC LIMIT 1`, [symbol, day],
  );
  return rows[0] || null;
}

/**
 * Build one symbol_minute row from an observation and its predecessor.
 *
 * Pure: no database, so every derived column can be tested against a
 * hand-built pair.
 */
function derive(now, prev, ts) {
  const bidQty = now.bid_qty;
  const offerQty = now.offer_qty;

  /**
   * Volume traded since the previous snapshot.
   *
   * ─── WHY THE PREVIOUS CUMULATIVE FIGURE IS NOT IN symbol_minute ────────
   * The table stores volume_delta, not the running total — there is no
   * volume_cum column and never was. An earlier version compared against
   * prev.volume_cum, which is always undefined, so volume_delta came out NULL
   * on every row and WALL PLACED, WALL PULLED and FROZEN could never fire:
   * all three require volume_delta === 0 to distinguish a placed order from a
   * consumed one.
   *
   * The cumulative figure lives in the SOURCE, so it is carried alongside the
   * snapshot rather than read back from the table.
   *
   * A counter going backwards is a reset or a bad read, not negative trading —
   * recorded as null rather than as a fall, because a negative delta would make
   * those same three checks fire on nonsense.
   */
  let volumeDelta = null;
  const prevCum = prev && prev.__volume_cum !== undefined ? prev.__volume_cum : null;
  if (now.volume !== null && prevCum !== null) {
    const d = now.volume - Number(prevCum);
    volumeDelta = d < 0 ? null : d;
  }

  const bidChange = (prev && bidQty !== null && prev.bid_qty !== null)
    ? bidQty - Number(prev.bid_qty) : null;
  const offerChange = (prev && offerQty !== null && prev.offer_qty !== null)
    ? offerQty - Number(prev.offer_qty) : null;

  // A move in offer size WITHOUT trading is someone placing or pulling. The
  // same move WITH trading is the market consuming it — a different event, and
  // conflating them is what makes a wall look like it vanished when it was
  // simply bought.
  let wallEvent = null;
  let wallPrice = null;
  let wallQty = null;
  if (offerChange !== null && offerChange !== 0) {
    if (volumeDelta === 0) {
      wallEvent = offerChange > 0 ? 'ADDED' : 'PULLED';
    } else if (volumeDelta !== null && offerChange < 0) {
      wallEvent = 'TRADED';
    }
    if (wallEvent) {
      wallPrice = now.offer;
      wallQty = Math.abs(offerChange);
    }
  }
  // Only size worth calling a wall.
  if (wallEvent && (wallQty === null || wallQty < WALL_QTY) && wallEvent !== 'TRADED') {
    const stillBig = offerQty !== null && offerQty >= WALL_QTY;
    if (!stillBig) { wallEvent = null; wallPrice = null; wallQty = null; }
  }

  /**
   * How long THIS level has stood.
   *
   * Carried forward while the price is unchanged, reset when it moves. Size
   * changing at the same price does NOT reset it: a bid being partially eaten
   * and refilled is the same level surviving, and treating it as new would
   * make every busy level look freshly placed — which is exactly the
   * distinction BAIT BID depends on.
   */
  const ageOf = (prevPrice, prevAge, price) => {
    if (price === null) return null;
    if (!prev || prevPrice === null || Number(prevPrice) !== price) return 0;
    const elapsed = Math.round((new Date(ts) - new Date(prev.ts)) / 1000);
    return (prevAge === null || prevAge === undefined ? 0 : Number(prevAge)) + Math.max(0, elapsed);
  };

  return {
    last_price: now.last_price,
    bid: now.bid,
    bid_qty: bidQty,
    offer: now.offer,
    offer_qty: offerQty,
    buyers_per_seller: (bidQty !== null && offerQty) ? Number((bidQty / offerQty).toFixed(4)) : null,
    bid_age_secs: ageOf(prev && prev.bid, prev && prev.bid_age_secs, now.bid),
    offer_age_secs: ageOf(prev && prev.offer, prev && prev.offer_age_secs, now.offer),
    bid_change: bidChange,
    offer_change: offerChange,
    wall_event: wallEvent,
    wall_price: wallPrice,
    wall_qty: wallQty,
    volume_delta: volumeDelta,
    is_frozen: (bidQty !== null && offerQty !== null && volumeDelta !== null)
      ? (bidQty > BIG_QTY && offerQty > BIG_QTY && volumeDelta === 0) : null,
  };
}

/**
 * Write one tick for each slotted symbol.
 *
 * Skips a symbol whose observation has not changed since its last row: writing
 * an identical tick inflates the table and, worse, makes the checks compare a
 * row against a copy of itself, which can never produce a signal.
 */
async function writeTick(runId) {
  const day = clock.tradingDay();
  const wakeup = require('../wakeup');
  const held = await wakeup.slottedSymbols(day);

  if (!held.length) {
    log.info('symbol_minute: no slotted symbols yet');
    return { extracted: 0, inserted: 0, rejected: 0 };
  }

  let written = 0;
  let unchanged = 0;
  let noData = 0;

  for (const { symbol } of held) {
    const now = await latestObservation(symbol, day);
    if (!now || now.observed_at === null) { noData += 1; continue; }

    const prev = await previousRow(symbol, day);
    if (prev) prev.__volume_cum = lastCumulative.get(symbol) ?? null;

    // The observation itself has not moved on — the source has not been
    // recaptured since the last tick.
    if (prev && new Date(prev.ts).getTime() >= new Date(now.observed_at).getTime()) {
      unchanged += 1;
      continue;
    }

    const ts = now.observed_at;
    const row = derive(now, prev, ts);

    const res = await query(
      `INSERT INTO symbol_minute
         (symbol, ts, trading_date, last_price, bid, bid_qty, offer, offer_qty,
          buyers_per_seller, bid_age_secs, offer_age_secs, bid_change,
          offer_change, wall_event, wall_price, wall_qty, volume_delta, is_frozen)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (symbol, ts) DO NOTHING RETURNING symbol`,
      [symbol, ts, day, row.last_price, row.bid, row.bid_qty, row.offer,
        row.offer_qty, row.buyers_per_seller, row.bid_age_secs, row.offer_age_secs,
        row.bid_change, row.offer_change, row.wall_event, row.wall_price,
        row.wall_qty, row.volume_delta, row.is_frozen],
    );
    written += res.rowCount;
    if (now.volume !== null) lastCumulative.set(symbol, now.volume);
  }

  log.info('symbol_minute written', {
    symbols: held.length, written, unchanged, noData, runId,
  });
  return { extracted: held.length, inserted: written, rejected: noData };
}

module.exports = {
  writeTick, derive, latestObservation, previousRow, lastCumulative, BIG_QTY, WALL_QTY,
};

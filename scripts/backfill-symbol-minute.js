'use strict';
/**
 * scripts/backfill-symbol-minute.js — a minute series from stored quotes.
 *
 * ─── WHY writeSymbolMinute CANNOT DO THIS ──────────────────────────────────
 * That job takes the SINGLE most recent quote per symbol and writes one row.
 * Correct for a 20-second loop capturing "now"; run against a past date it
 * writes one row per symbol, not a series.
 *
 * This walks every capture instant of a day and reconstructs a row per slotted
 * symbol per instant, using the SAME derive() the live loop uses — so the
 * maths is not a second implementation that can disagree.
 *
 * ─── WHAT IT PROVES, AND WHAT IT DOES NOT ──────────────────────────────────
 *   proves      the writer produces a series
 *               derive() works across real transitions
 *               signals.js evaluates and writes to signal_log
 *
 *   does NOT    which signals fire at 20-second granularity
 *
 * The capture interval is about 60 seconds against roughly 20 live, so
 * bid_age_secs is coarser and BAIT_BID may behave differently. Do not read
 * these counts as a live baseline.
 */

const { query } = require('../src/db/pool');
const M = require('../src/jobs/writeSymbolMinute');

async function backfill(day, { apply = false } = {}) {
  const { rows: slots } = await query(
    `SELECT symbol FROM depth_watchlist
      WHERE trading_date = $1 AND released_at IS NULL ORDER BY slot_no`, [day]);
  if (!slots.length) return { day, error: 'no slotted symbols for that date' };

  const symbols = slots.map((s) => s.symbol);
  const out = { day, symbols: {}, derived: 0, nullDerive: 0,
    skippedExisting: 0, skippedLive: 0, written: 0 };

  for (const symbol of symbols) {
    process.stdout.write(`    ${symbol.padEnd(12)} reading… `);

    /**
     * ─── ONE QUERY PER SYMBOL, NOT ONE PER ROW ──────────────────────────────
     *
     * The first version used a LATERAL join to find the depth row at or before
     * each quote instant. That runs once PER QUOTE — 280 times a symbol — and
     * no index covers (symbol, trading_date, level, captured_at), so each did
     * a partial scan of 194,575 rows. It ran for more than ten minutes and
     * printed nothing, so a slow query and a hang looked identical.
     *
     * Instead: pull the quotes and the level-1 depth separately, each on an
     * index that exists, and walk them together in memory. Two queries a
     * symbol rather than 281.
     */
    const [{ rows: quotes }, { rows: depth }] = await Promise.all([
      query(
        `SELECT created_at AS ts, last_price, volume, bid, bid_qty, offer, offer_qty
           FROM awsat_market_quotes
          WHERE symbol = $1 AND trading_date = $2 AND last_price > 0
          ORDER BY created_at`, [symbol, day]),
      query(
        `SELECT captured_at, bid, bid_qty, offer, offer_qty
           FROM awsat_stock_depth
          WHERE symbol = $1 AND trading_date = $2 AND level = 1
          ORDER BY captured_at`, [symbol, day]),
    ]);

    // Merge by walking both in time order — the depth pointer only moves
    // forward, so this is linear rather than a lookup per row.
    let di = 0;
    let prev = null;
    let wrote = 0;
    const pending = [];

    for (const qr of quotes) {
      while (di + 1 < depth.length && depth[di + 1].captured_at <= qr.ts) di += 1;
      const d = (depth.length && depth[di].captured_at <= qr.ts) ? depth[di] : null;

      const now = {
        last_price: qr.last_price,
        bid: d ? d.bid : qr.bid,
        bid_qty: d ? d.bid_qty : qr.bid_qty,
        offer: d ? d.offer : qr.offer,
        offer_qty: d ? d.offer_qty : qr.offer_qty,
        volume: qr.volume,
        created_at: qr.ts,
      };

      const derived = M.derive(now, prev, qr.ts);
      if (!derived) { out.nullDerive += 1; prev = now; continue; }
      out.derived += 1;
      if (apply) pending.push([now, derived, qr.ts]);
      prev = now;
    }

    /**
     * Inserted in batches of 100.
     *
     * One INSERT per row is 2,240 round trips to RDS, and at 50ms each that is
     * two minutes of latency alone. A LIVE row still wins — ON CONFLICT DO
     * NOTHING, and the difference between offered and inserted is the skip
     * count.
     */
    if (apply) {
      for (let i = 0; i < pending.length; i += 100) {
        const batch = pending.slice(i, i + 100);
        const values = [];
        const params = [];
        batch.forEach(([now, dv, ts], n) => {
          const b = n * 19;
          values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},`
            + `$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11},$${b + 12},`
            + `$${b + 13},$${b + 14},$${b + 15},$${b + 16},$${b + 17},$${b + 18},$${b + 19})`);
          params.push(symbol, ts, day, now.last_price, now.bid, now.bid_qty,
            now.offer, now.offer_qty, dv.buyers_per_seller, dv.bid_age_secs,
            dv.offer_age_secs, dv.bid_change, dv.offer_change, dv.wall_event,
            dv.wall_price, dv.wall_qty, dv.volume_delta, dv.is_frozen, 'BACKFILL');
        });
        const r = await query(`
          INSERT INTO symbol_minute
            (symbol, ts, trading_date, last_price, bid, bid_qty, offer, offer_qty,
             buyers_per_seller, bid_age_secs, offer_age_secs, bid_change,
             offer_change, wall_event, wall_price, wall_qty, volume_delta,
             is_frozen, source)
          VALUES ${values.join(',')}
          ON CONFLICT (symbol, ts) DO NOTHING`, params);
        wrote += r.rowCount;
        out.written += r.rowCount;
        out.skippedExisting += batch.length - r.rowCount;
      }
    }

    /**
     * How many of the skips were LIVE rows, counted rather than assumed.
     *
     * A skip means a row already existed — and on a re-run that is almost
     * always one this script wrote. Reporting every conflict as "a LIVE row
     * held it" turned "1,992 already done" into what read like a finding.
     */
    if (apply && out.skippedExisting) {
      const { rows: live } = await query(
        `SELECT count(*)::int AS n FROM symbol_minute
          WHERE symbol = $1 AND trading_date = $2 AND source = 'LIVE'`, [symbol, day]);
      out.skippedLive += live[0].n;
    }

    out.symbols[symbol] = { observations: quotes.length, written: wrote };
    // Progress as it goes: a job that prints only at the end is a job you
    // cannot tell from a hang.
    console.log(`${String(quotes.length).padStart(5)} obs · `
      + `${String(wrote).padStart(5)} written`);
  }

  return out;
}

module.exports = { backfill };

if (require.main === module) {
  (async () => {
    const day = (process.argv.find((a) => a.startsWith('--date=')) || '').split('=')[1];
    const apply = process.argv.includes('--apply');
    if (!day) { console.error('  --date=YYYY-MM-DD required'); process.exit(1); }

    console.log(`\n  SYMBOL_MINUTE BACKFILL · ${day}${apply ? '  (APPLY)' : '  (dry run)'}\n`);
    const started = Date.now();
    const r = await backfill(day, { apply });
    if (r.error) { console.error('  ' + r.error); process.exit(1); }

    console.log(`\n    derive() produced a row      ${r.derived}`);
    console.log(`    derive() returned null       ${r.nullDerive}`);
    // The first version called every conflict a LIVE collision. On a re-run
    // they were all rows THIS SCRIPT had written, so "1,992 live rows blocked
    // me" read as a finding when it meant "1,992 already done".
    console.log(`    skipped — a row was already there ${r.skippedExisting}`);
    if (r.skippedLive) {
      console.log(`      of which written LIVE          ${r.skippedLive}  <- a live row wins`);
    }
    console.log(`    written                      ${r.written}`);
    console.log(`    took                         ${Math.round((Date.now() - started) / 1000)}s`);
    console.log('\n  BACKFILL — capture interval ~60s vs ~20s live.');
    console.log('  Ages are coarser; BAIT_BID may behave differently. These are');
    console.log('  NOT a live baseline.\n');
    process.exit(0);
  })();
}

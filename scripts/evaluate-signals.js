'use strict';
/**
 * scripts/evaluate-signals.js — run the seven checks over a stored series.
 *
 * signals.js is pure: seven functions over a row and its predecessor. The live
 * loop calls them every 20 seconds; this calls them over symbol_minute rows
 * that already exist, in order, so the EVALUATION can be proven without a
 * session.
 *
 * ─── WHAT THIS PROVES ──────────────────────────────────────────────────────
 *   the checks execute against real transitions
 *   signal_log receives rows
 *
 * ─── WHAT IT DOES NOT ──────────────────────────────────────────────────────
 * Which signals fire at 20-second granularity. On backfilled rows the gap is
 * about 60 seconds, so bid_age_secs is coarser — BAIT_BID needs an age under
 * 300s and will see different ages than it would live.
 */

const { query } = require('../src/db/pool');
const signals = require('../src/signals');

async function evaluate(day, { apply = false, source = null } = {}) {
  const { rows } = await query(
    `SELECT * FROM symbol_minute
      WHERE trading_date = $1 AND ($2::text IS NULL OR source = $2)
      ORDER BY symbol, ts`, [day, source]);

  const out = { day, rows: rows.length, evaluated: 0, fired: {}, written: 0, skipped: 0 };
  let prev = null;
  const pending = [];
  let lastSymbol = null;

  for (const row of rows) {
    if (row.symbol !== lastSymbol) {
      // Progress per symbol. A job that prints only at the end cannot be told
      // from a hang — which is exactly what happened with the backfill.
      if (lastSymbol) process.stdout.write(`  ${out.evaluated} pairs\n`);
      process.stdout.write(`    ${row.symbol.padEnd(12)} evaluating…`);
      lastSymbol = row.symbol;
      prev = row;
      continue;
    }
    out.evaluated += 1;

    const hits = signals.evaluate(row, prev) || [];
    for (const h of hits) {
      const name = h.signal || h.name || String(h);
      out.fired[name] = (out.fired[name] || 0) + 1;
      if (apply) pending.push([row, name, h.message || null]);
    }
    prev = row;
  }
  if (lastSymbol) process.stdout.write(`  ${out.evaluated} pairs\n`);

  /**
   * Inserted in batches of 200.
   *
   * One INSERT per signal is a round trip each, and over 2,200 pairs that is
   * thousands of them to RDS — minutes of latency with nothing printed. Same
   * defect the backfill had.
   */
  if (apply && pending.length) {
    process.stdout.write(`\n    writing ${pending.length} signal(s)… `);
    for (let i = 0; i < pending.length; i += 200) {
      const batch = pending.slice(i, i + 200);
      const values = [];
      const params = [];
      batch.forEach(([r, name, msg], n) => {
        const b = n * 9;
        values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},`
          + `$${b + 6},$${b + 7},$${b + 8},$${b + 9})`);
        params.push(r.symbol, day, name, r.ts, r.last_price, r.bid_qty,
          r.offer_qty, r.buyers_per_seller, msg);
      });
      const res = await query(`
        INSERT INTO signal_log
          (symbol, trading_date, signal, fired_at, price, bid_qty, offer_qty,
           ratio, message)
        VALUES ${values.join(',')}
        ON CONFLICT DO NOTHING`, params);
      out.written += res.rowCount;
      out.skipped += batch.length - res.rowCount;
    }
    console.log('done');
  }

  return out;
}

module.exports = { evaluate };

if (require.main === module) {
  (async () => {
    const day = (process.argv.find((a) => a.startsWith('--date=')) || '').split('=')[1];
    const apply = process.argv.includes('--apply');
    if (!day) { console.error('  --date=YYYY-MM-DD required'); process.exit(1); }

    console.log(`\n  SIGNAL EVALUATION · ${day}${apply ? '  (APPLY)' : '  (dry run)'}\n`);
    const started = Date.now();
    const r = await evaluate(day, { apply });
    console.log(`    symbol_minute rows read   ${r.rows}`);
    console.log(`    pairs evaluated           ${r.evaluated}`);
    console.log(`    signal_log rows written   ${r.written}`);
    if (r.skipped) console.log(`    already present, skipped  ${r.skipped}`);
    console.log(`    took                      ${Math.round((Date.now() - started) / 1000)}s\n`);
    const names = Object.keys(r.fired).sort();
    if (!names.length) {
      console.log('    NOTHING FIRED.');
      console.log('    With rows present and pairs evaluated, that is the checks');
      console.log('    finding nothing — not the evaluation failing to run.');
    } else {
      for (const n of names) console.log(`    ${n.padEnd(18)} ${r.fired[n]}`);
    }
    console.log('\n  Backfilled rows sit ~60s apart against ~20s live, so ages are');
    console.log('  coarser. These counts are NOT a live baseline.\n');
    process.exit(0);
  })();
}

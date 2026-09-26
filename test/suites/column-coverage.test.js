'use strict';
/**
 * ============================================================================
 *  THE 30 AUGUST COLLAPSE, AS A TEST
 * ============================================================================
 * Measured on `kse` on 25 September 2026:
 *
 *   awsat_market_quotes.last_trade_time   26 Aug  27,608 of 27,608   100%
 *                                         30 Aug       0 of 35,840     0%
 *   awsat_market_quotes.last_trade_date   same day, same collapse
 *
 * The EXCHANGE'S OWN trade timestamp — not our capture time — empty on every
 * row for four weeks and 737,218 rows, with nothing anywhere saying so. The
 * cause was the awsat_server -> awsat_client cutover on 30 August.
 *
 * It went unseen because NULL is the honest value for "this symbol has not
 * traded yet today", so a dead column and a quiet one are the same shape. Only
 * the previous session tells them apart.
 *
 * The fixture below is that day, at small scale: a column at 100% on the
 * previous session and 0% on this one. The detector must fire on it, must NOT
 * fire on a column that was already empty yesterday (a standing condition is
 * not news), and must not fire on an ordinary fluctuation.
 * ============================================================================
 */
const db = require('../../src/db/pool');
const cov = require('../../src/jobs/columnCoverage');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };

const PREV = '2026-06-01';   // outside every other suite's fixture range
const DAY = '2026-06-02';
const SYMS = ['CCTEST1', 'CCTEST2', 'CCTEST3', 'CCTEST4'];

async function clean() {
  await db.query('DELETE FROM awsat_market_quotes WHERE symbol = ANY($1)', [SYMS]);
  await db.query('DELETE FROM data_alarm WHERE trading_date IN ($1,$2)', [PREV, DAY]);
  await db.query('DELETE FROM instruments WHERE symbol = ANY($1)', [SYMS]);
}

/** `lutt` null or set; `low` always null, to prove a standing empty is quiet. */
async function seed(day, withTradeTime) {
  for (const s of SYMS) {
    // eslint-disable-next-line no-await-in-loop
    await db.query(
      `INSERT INTO awsat_market_quotes
         (market, symbol, trading_date, session, last_price, low_price,
          last_trade_time, ingest_source, created_at)
       VALUES ('PM', $1, $2, 'Trading', 100, NULL, $3, 'awsat_client', $4)`,
      [s, day, withTradeTime ? '10:15:00' : null, `${day}T10:00:00+03`]);
  }
}

(async () => {
  try {
    await clean();
    for (const s of SYMS) {
      // eslint-disable-next-line no-await-in-loop
      await db.query('INSERT INTO instruments (market, symbol) VALUES ($1,$2) ON CONFLICT DO NOTHING', ['PM', s]);
    }

    console.log('\n=== the collapse fires ===');
    await seed(PREV, true);    // 100% populated
    await seed(DAY, false);    // 0%
    const hits = await cov.check(DAY);

    const tt = hits.find((h) => h.column === 'last_trade_time');
    ck('a column at 100% yesterday and 0% today is reported', !!tt,
      hits.map((h) => `${h.table}.${h.column}`));
    ck('  and it names both sides of the comparison, not just today',
      !!tt && tt.wasPct === 100 && tt.nowPct === 0 && tt.prevDay != null,
      tt && { was: tt.wasPct, now: tt.nowPct, prevDay: String(tt.prevDay) });

    const { rows: alarms } = await db.query(
      `SELECT column_name, detail FROM data_alarm
        WHERE trading_date = $1 AND alarm = 'COLUMN_COVERAGE_COLLAPSED'`, [DAY]);
    ck('  and an alarm row is written, not just a log line',
      alarms.some((a) => a.column_name === 'last_trade_time'),
      alarms.map((a) => a.column_name));
    ck('  and the alarm carries the measured precedent, so the reader knows the shape',
      alarms.some((a) => /30 August 2026/.test(JSON.stringify(a.detail || {}))), null);

    console.log('\n=== a standing empty is NOT news ===');
    ck('low_price was empty on BOTH days and is not reported — re-reporting a standing '
      + 'condition every night is how an alarm gets muted',
    !hits.some((h) => h.column === 'low_price'), hits.map((h) => h.column));

    console.log('\n=== and it does not fire on the reverse, or on a quiet day ===');
    // Running the previous day: its own predecessor has no rows at all, so
    // there is nothing to compare and nothing to say.
    const noPrev = await cov.check(PREV);
    ck('a day whose predecessor has no rows in the table reports nothing — a capture '
      + 'outage is the feed alarm\'s to raise, not this one\'s',
    !noPrev.some((h) => SYMS.length && h.column === 'last_trade_time'), noPrev.length);

    // And the recovery direction: 0% -> 100% is a fix, not a fault.
    await db.query('DELETE FROM awsat_market_quotes WHERE symbol = ANY($1) AND trading_date = $2', [SYMS, DAY]);
    await seed(DAY, true);
    const recovered = await cov.check(DAY);
    ck('a column coming BACK is not an alarm',
      !recovered.some((h) => h.column === 'last_trade_time'), recovered.map((h) => h.column));

    await clean();
    console.log(`\ncolumn coverage: ${p}/${n}`);
    await db.close();
    process.exit(p === n ? 0 : 1);
  } catch (e) {
    console.error('column-coverage ERROR', e);
    try { await clean(); } catch { /* the run is over either way */ }
    await db.close().catch(() => {});
    process.exit(1);
  }
})();

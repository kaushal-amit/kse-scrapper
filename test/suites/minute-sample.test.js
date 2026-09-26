'use strict';
/**
 * ============================================================================
 *  symbol_minute_sample — the three things that would otherwise be silent
 * ============================================================================
 * Every check here is for a value that, if wrong, would look right:
 *
 *   1 · a delta across a capture gap is a MULTI-minute delta. Without
 *       delta_span_seconds it wears a one-minute name — the same
 *       invisible-denominator shape as coverage_pct dividing by its own
 *       median, in a new place.
 *   2 · the session's FIRST sample has no previous sample to subtract. Its
 *       delta runs from zero, spanning from the session open, and the row says
 *       so rather than leaving it to be worked out.
 *   3 · the depth join takes the last book AT OR BEFORE the quote. A later
 *       book is information from the future, and lookahead is the error that
 *       matters in a trading system: it is wrong in the direction that
 *       flatters a backtest.
 *
 * And the structural one: no open/high/low/close column exists. If someone
 * adds them later this fails, which is the point — migration 052 exists
 * because the name is a claim.
 * ============================================================================
 */
const db = require('../../src/db/pool');
const job = require('../../src/jobs/computeMinuteSample');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };

/*
 * AFTER 6 August, and that is not incidental. The first version of this suite
 * used a June date and the three depth checks failed with nulls — correctly:
 * computeMinuteSample marks depth NOT COMPUTED before 2026-08-06 because there
 * is nothing to join, and the fixture had put itself on the wrong side of the
 * rule it was trying to test. The guard worked; the test was wrong. A Monday,
 * well clear of every other suite's fixtures, and past DEPTH_FROM.
 */
const DAY = '2026-11-16';
const SYM = 'MSTEST1';

async function clean() {
  await db.query('DELETE FROM symbol_minute_sample WHERE symbol = $1', [SYM]);
  await db.query('DELETE FROM awsat_market_quotes WHERE symbol = $1', [SYM]);
  await db.query('DELETE FROM awsat_stock_depth WHERE symbol = $1', [SYM]);
  await db.query('DELETE FROM instruments WHERE symbol = $1', [SYM]);
}

const q = (hhmmss, volume, trades) => db.query(
  `INSERT INTO awsat_market_quotes
     (market, symbol, trading_date, session, last_price, bid, bid_qty, offer, offer_qty,
      volume, trades, ingest_source, created_at)
   VALUES ('PM', $1, $2, 'Trading', 100, 99, 5000, 101, 4000, $3, $4, 'awsat_client', $5)`,
  [SYM, DAY, volume, trades, `${DAY}T${hhmmss}+03:00`]);

const d = (hhmmss, level, bidQty, offerQty) => db.query(
  `INSERT INTO awsat_stock_depth
     (symbol, level, bid, bid_qty, offer, offer_qty, trading_date, ingest_source, captured_at, created_at)
   VALUES ($1, $2, 99, $3, 101, $4, $5, 'awsat_client', $6, $6)`,
  [SYM, level, bidQty, offerQty, DAY, `${DAY}T${hhmmss}+03:00`]);

(async () => {
  try {
    await clean();
    await db.query('INSERT INTO instruments (market, symbol) VALUES ($1,$2) ON CONFLICT DO NOTHING', ['PM', SYM]);

    // 09:02 first sample · 09:03 one minute later · 09:07 after a FOUR-minute gap
    await q('09:02:10', 1000, 10);
    await q('09:03:10', 1500, 14);
    await q('09:07:10', 4000, 40);

    // Two books before the 09:07 quote and ONE AFTER IT. The one after must
    // never be chosen: 9,999 is the tell.
    await d('09:06:40', 1, 7777, 3000);
    await d('09:07:05', 1, 8888, 3100);
    await d('09:07:40', 1, 9999, 3200);

    await job.compute(DAY);

    const { rows } = await db.query(
      `SELECT * FROM symbol_minute_sample WHERE symbol = $1 AND trading_date = $2
        ORDER BY minute;`, [SYM, DAY]);
    ck('three minutes, three rows', rows.length === 3, rows.length);

    const [first, second, third] = rows;

    console.log('\n=== 1 · the session\'s first sample says so, and spans from the open ===');
    ck('is_session_first is true on the first and false after',
      first.is_session_first === true && second.is_session_first === false,
      [first.is_session_first, second.is_session_first]);
    ck('  its delta runs from ZERO, not from a sample that does not exist',
      Number(first.volume_delta) === 1000 && Number(first.trades_delta) === 10,
      [first.volume_delta, first.trades_delta]);
    // 09:00 open to 09:02:10 = 130 seconds.
    ck('  and the span is from the SESSION OPEN, not a guessed minute',
      Number(first.delta_span_seconds) === 130, first.delta_span_seconds);

    console.log('\n=== 2 · a delta across a gap carries its real span ===');
    ck('one minute apart gives a 60-second span',
      Number(second.delta_span_seconds) === 60, second.delta_span_seconds);
    ck('FOUR minutes apart gives 240 — not 60, and not silence',
      Number(third.delta_span_seconds) === 240, third.delta_span_seconds);
    ck('  and the delta is the whole gap, which is only honest BECAUSE the span says so',
      Number(third.volume_delta) === 2500, third.volume_delta);

    console.log('\n=== 3 · the depth join never reads the future ===');
    ck('the book is the last one AT OR BEFORE the quote (8,888), never the 09:07:40 one',
      Number(third.depth_bid_shares_5) === 8888, third.depth_bid_shares_5);
    ck('  and the lag is recorded, so a stale book is visible rather than assumed fresh',
      Number(third.depth_lag_seconds) === 5, third.depth_lag_seconds);
    ck('  and how many were available to choose from',
      Number(third.depth_samples_in_minute) === 2, third.depth_samples_in_minute);
    ck('a minute with no book AT OR BEFORE it is NOT COMPUTED on both columns, never an '
      + 'empty book', first.depth_bid_shares_5 === null && first.depth_lag_seconds === null,
    [first.depth_bid_shares_5, first.depth_lag_seconds]);

    console.log('\n=== 4 · the columns that must NOT exist ===');
    const { rows: cols } = await db.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'symbol_minute_sample';`);
    const names = cols.map((c) => c.column_name);
    const ohlc = names.filter((c) => ['open', 'high', 'low', 'close', 'open_price',
      'high_price', 'low_price', 'close_price', 'vwap', 'vwap_approx'].includes(c));
    ck('no OHLC and no VWAP — one observation of a cumulative board has neither, and a '
      + 'flag does not rescue a name that is false', ohlc.length === 0, ohlc);
    ck('samples_in_minute, delta_span_seconds and time_basis are all present',
      ['samples_in_minute', 'delta_span_seconds', 'time_basis'].every((c) => names.includes(c)),
      names.length);

    console.log('\n=== 5 · time_basis is honest, and the fingerprint is the input ===');
    ck('every row says CAPTURE — there has been no exchange trade time since 30 Aug',
      rows.every((r) => r.time_basis === 'CAPTURE' && r.exchange_trade_time === null), null);
    ck('the fingerprint records the SOURCE, not a build version',
      rows.every((r) => r.source_rows === 3 && r.source_max_created_at !== null),
      [rows[0].source_rows, rows[0].source_max_created_at]);

    console.log('\n=== 6 · re-running corrects, it does not duplicate ===');
    await job.compute(DAY);
    const { rows: again } = await db.query(
      'SELECT count(*)::int c FROM symbol_minute_sample WHERE symbol = $1 AND trading_date = $2',
      [SYM, DAY]);
    ck('still three rows after a second run', again[0].c === 3, again[0].c);

    await clean();
    console.log(`\nminute sample: ${p}/${n}`);
    await db.close();
    process.exit(p === n ? 0 : 1);
  } catch (e) {
    console.error('minute-sample ERROR', e);
    try { await clean(); } catch { /* the run is over either way */ }
    await db.close().catch(() => {});
    process.exit(1);
  }
})();

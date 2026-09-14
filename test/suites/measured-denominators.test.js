'use strict';
/**
 * H-J and H-K · two numbers computed over things that were never measured.
 *
 * H-J · THE BREADTH DENOMINATOR INCLUDED SYMBOLS WITH NO DIRECTION.
 * marketDayMetrics.breadth states its own rule at the top: a symbol with no
 * chg_fils has no previous session to compare against, "its direction is
 * unknown, not flat", so it is excluded from advancing, declining and unchanged
 * alike. It can therefore never appear in the numerator — and it was in the
 * DENOMINATOR, which was rows.length.
 *
 * The error is one-directional and it is a downgrade: every unmeasurable symbol
 * pushes pct_advancing toward zero and the regime toward RISK_OFF. The day
 * after a gap in the capture — exactly when a lot of symbols lack a previous
 * close — the market reads risk-off BECAUSE THE CAPTURE WAS DOWN, and the
 * session gate then says do not trade.
 *
 * `unchanged` stays in the denominator: that is the calibration behind the 18%
 * quoted all month, and a day where 60 rise, 50 fall and 26 sit still is not a
 * risk-on day. What changes is only that symbols with no measurement stop
 * counting as though they had sat still.
 *
 * H-K · previousCloses HAD NO CAP, CONTRARY TO ITS OWN DOCBLOCK.
 * "CAPPED AT 5 SESSIONS: a previous close from two weeks ago is not one." The
 * query took `back = 1` — the most recent usable session that produced a close,
 * however far back that was. A symbol suspended for three weeks returned with
 * chg_fils measured against its pre-suspension price, and that number reached
 * down_days, the breadth count and the signal scoring as though it were one
 * day's move.
 */
const { requireTestDb } = require('../dbguard');
requireTestDb('measured-denominators');

const { query, close } = require('../../src/db/pool');
const M = require('../../src/jobs/marketDayMetrics');
const csd = require('../../src/jobs/computeSymbolDay');
const T = require('../../src/config/thresholds');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };

const row = (chg) => ({ chg_fils: chg, data_quality: 'GOOD' });

// ── H-J · the denominator ──────────────────────────────────────────────────
{
  // A fully measured session: nothing changes, and the calibration holds.
  {
    const rows = [...Array(24).fill(row(1)), ...Array(50).fill(row(-1)), ...Array(62).fill(row(0))];
    const b = M.breadth(rows);
    ck('a fully measured session is unchanged — 24 of 136 is still 17.65%',
      b.pct_advancing === 17.6471, b.pct_advancing);
    ck('and every symbol counts as measured', b.measured_symbols === 136, b);
    ck('with none lacking a previous close', b.no_prev_close === 0, b);
  }

  // THE BUG: the same real market, with a third of the board unmeasurable.
  {
    const measured = [...Array(24).fill(row(1)), ...Array(26).fill(row(-1)), ...Array(30).fill(row(0))];
    const blind = Array(56).fill(row(null));
    const b = M.breadth([...measured, ...blind]);

    ck('the unmeasured symbols are counted and named', b.no_prev_close === 56, b);
    ck('they are in symbols_traded', b.symbols_traded === 136, b);
    ck('but NOT in measured_symbols', b.measured_symbols === 80, b);

    ck('pct_advancing is 24 of the 80 that had a direction',
      b.pct_advancing === 30, b.pct_advancing);
    // The old answer: 24/136.
    ck('and NOT 24 of 136 — a number diluted by symbols nobody measured',
      b.pct_advancing !== 17.6471, b.pct_advancing);
  }

  // And the consequence, stated as the regime the backend reads.
  {
    // 28 up, 25 down, 17 flat — and 30 symbols with no previous close at all,
    // which is what a gap in yesterday's capture leaves behind.
    const measured = [...Array(28).fill(row(1)), ...Array(25).fill(row(-1)), ...Array(17).fill(row(0))];
    const blind = Array(30).fill(row(null));
    const b = M.breadth([...measured, ...blind]);

    // What the old denominator produced: 28 over all 100 rows.
    const diluted = Number(((100 * 28) / 100).toFixed(4));

    ck('the honest reading — 28 of the 70 measured — is NEUTRAL',
      b.pct_advancing === 40 && M.regimeOf(b.pct_advancing) === 'NEUTRAL',
      [b.pct_advancing, M.regimeOf(b.pct_advancing)]);
    ck('the diluted one would have said RISK_OFF — the capture being down '
      + 'reading as the market being down',
    M.regimeOf(diluted) === 'RISK_OFF', [diluted, M.regimeOf(diluted)]);
  }

  // ── below the floor it is NOT COMPUTED at all ────────────────────────────
  {
    const frac = T.get('md_breadth_min_measured_frac');
    ck('the floor is a threshold, not a literal', typeof frac === 'number' && frac > 0, frac);

    // Eleven measured out of 136 — a breadth reading over eleven stocks.
    const b = M.breadth([...Array(4).fill(row(1)), ...Array(7).fill(row(-1)),
      ...Array(125).fill(row(null))]);
    ck('breadth over a handful of symbols is NOT COMPUTED', b.pct_advancing === null, b);
    ck('nor is the ratio', b.pct_advancing_ratio === null, b);
    ck('and the regime with it — an unmeasured market is not a RISK_OFF one',
      M.regimeOf(b.pct_advancing) === null, M.regimeOf(b.pct_advancing));
    ck('while the counts themselves are still reported',
      b.advancing === 4 && b.declining === 7 && b.measured_symbols === 11, b);
  }

  // ── exactly at the floor it computes ─────────────────────────────────────
  {
    const b = M.breadth([...Array(50).fill(row(1)), ...Array(50).fill(row(null))]);
    ck('half measured is enough — the floor is inclusive', b.pct_advancing === 100, b);
  }

  // ── and a session with no rows at all is still null, not zero ────────────
  {
    const b = M.breadth([]);
    ck('an empty session computes nothing rather than a flat market',
      b.pct_advancing === null && b.measured_symbols === 0, b);
  }
}

// ── H-K · the reach ────────────────────────────────────────────────────────
(async () => {
  try {
    const SYM = 'REACH';
    const cap = T.get('sd_prev_close_max_sessions_back');
    ck('the cap is a threshold, not a literal', typeof cap === 'number' && cap >= 1, cap);

    await query('DELETE FROM awsat_market_quotes WHERE symbol = $1', [SYM]);
    await query("DELETE FROM awsat_market_quotes WHERE symbol = 'REACHOTH'");

    /*
     * Ten consecutive usable sessions. REACH prints a close on the FIRST of
     * them and then goes quiet — suspended. REACHOTH prints on every one, so
     * each of the ten counts as a usable session with a close.
     */
    const DAYS = ['2026-08-16', '2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20',
      '2026-08-23', '2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27'];
    const TODAY = '2026-08-30';

    const print = (sym, day, px) => query(
      `INSERT INTO awsat_market_quotes (symbol, market, created_at, trading_date, ingest_source, last_price, session)
       VALUES ($1, 'Main Market', $2, $3, 'awsat_client', $4, 'Close-Of-Day')`,
      [sym, new Date(`${day}T13:25:00+03:00`), day, px]);

    for (const d of DAYS) await print('REACHOTH', d, 200);
    await print(SYM, DAYS[0], 500);          // its last close, nine sessions ago

    {
      const closes = await csd.previousCloses(TODAY);
      ck('a close from NINE usable sessions ago is NOT reached for',
        !closes.has(SYM), closes.get(SYM));
      ck('while a symbol that printed yesterday still has one',
        closes.has('REACHOTH'), closes.get('REACHOTH'));
    }

    // ── and it IS reached for from inside the window ──────────────────────
    {
      // Print for REACH on the third session back instead.
      await print(SYM, DAYS[DAYS.length - 3], 480);
      const closes = await csd.previousCloses(TODAY);
      ck('a close from THREE usable sessions ago is used',
        closes.has(SYM) && Number(closes.get(SYM).prev_close) === 480, closes.get(SYM));
      ck('and the gap is reported rather than hidden',
        closes.get(SYM).prev_session_gap_days >= 3, closes.get(SYM));
    }

    // ── the boundary ─────────────────────────────────────────────────────
    {
      await query('DELETE FROM awsat_market_quotes WHERE symbol = $1', [SYM]);
      // Exactly `cap` usable sessions back — the oldest session still in reach.
      await print(SYM, DAYS[DAYS.length - cap], 470);
      const closes = await csd.previousCloses(TODAY);
      ck(`a close exactly ${cap} usable sessions back is still in reach`,
        closes.has(SYM) && Number(closes.get(SYM).prev_close) === 470, closes.get(SYM));

      await query('DELETE FROM awsat_market_quotes WHERE symbol = $1', [SYM]);
      // One session further, which must fall outside it.
      await print(SYM, DAYS[DAYS.length - cap - 1], 460);
      const beyond = await csd.previousCloses(TODAY);
      ck(`and one session beyond ${cap} is not`, !beyond.has(SYM), beyond.get(SYM));
    }

    // ── the query still names the threshold rather than a 5 ───────────────
    {
      const src = require('fs').readFileSync(
        require('path').join(__dirname, '../../src/jobs/computeSymbolDay.js'), 'utf8');
      ck('previousCloses passes the cap as a parameter',
        /sd_prev_close_max_sessions_back/.test(src));
      /*
       * THIS ASSERTION WAS WRONG, and the second review pass caught it.
       *
       * It read "the chg_5d query is untouched — back = 5 bounds itself". It
       * bounds the COUNT, not the REACH: `back` counts the SYMBOL's own closes,
       * which is exactly the distinction H-K's own comment draws — "the cap is
       * on MARKET sessions, not on the symbol's own". A symbol that printed on
       * five of the last forty sessions had its chg_5d measured against a close
       * two months old, in a column named for five sessions, with no
       * prev_session_gap_days analogue to say so.
       *
       * An assertion that states a false reason is worse than none: it stopped
       * the next reader looking.
       */
      ck('the chg_5d query names how many sessions back it measures',
        /sd_chg5d_sessions_back/.test(src));
      ck('and caps its REACH in market sessions, like chg_1d',
        /sd_chg5d_max_sessions_back/.test(src));
    }

    await query('DELETE FROM awsat_market_quotes WHERE symbol = $1', [SYM]);
    await query("DELETE FROM awsat_market_quotes WHERE symbol = 'REACHOTH'");
  } catch (e) {
    ck('the suite ran without throwing', false, e.message);
  }

  await close();
  console.log(`\nmeasured denominators: ${p}/${n}`);
  process.exit(p === n ? 0 : 1);
})();

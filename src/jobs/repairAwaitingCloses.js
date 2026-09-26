'use strict';
/**
 * ============================================================================
 *  D3 · THE CLOSE WE MISSED IS PUBLISHED THE NEXT MORNING
 * ============================================================================
 * A day whose capture stopped before the closing auction has no official
 * close, and nothing we captured that day can supply one. 14 September
 * stopped at 11:59, and the 11:59 prices went into symbol_day wearing a
 * closing session's label — which is why 15 September's prev_close is wrong
 * on 108 of 134 symbols.
 *
 * But the close is not lost. The exchange publishes it the next morning, as
 * that session's reference price: `last_price - chg`, constant all day, for
 * every symbol. 14 September's real close IS 15 September's reference.
 *
 * So the repair is not a reconstruction or an estimate. It is the same number
 * from the same authority, arriving a day late because our capture was not
 * running when it was first published — which is exactly what
 * NEXT_SESSION_REFERENCE means and why it is not a downgrade of
 * CLOSE_OF_DAY.
 *
 * ─── WHY IT RUNS AFTER THE NEXT DAY, NOT ON THE NIGHT ──────────────────────
 * On the night of 14 September the information does not exist anywhere. The
 * row is written AWAITING_NEXT_SESSION — a state, not a value — and this job
 * clears it once the session that carries the answer has been captured.
 *
 * ─── AND IT NEVER TOUCHES A DAY THAT HAS A REAL CLOSE ──────────────────────
 * The only rows it can change are ones already labelled
 * AWAITING_NEXT_SESSION, i.e. days with no Close-Of-Day capture at all. A day
 * with a captured official close is not improved by a second opinion, and a
 * repair that can overwrite good data is a worse defect than the one it
 * fixes.
 * ============================================================================
 */
const { query } = require('../db/pool');
const log = require('../logger');

/**
 * Repair every AWAITING_NEXT_SESSION row for which a later session now exists.
 *
 * @param {string} upToDay  the session just captured; its reference is what
 *                          repairs the day before it
 * @returns {{repaired:number, stillAwaiting:number}}
 */
async function repairAwaitingCloses(upToDay) {
  /*
   * ONE STATEMENT, because the repair and the arithmetic that depends on it
   * must not be able to half-apply. chg_fils and chg_1d are recomputed in the
   * same UPDATE: close_px changes, and a stored change measured against the
   * old close is the contradiction 049's fingerprint exists to catch.
   *
   * `next` is the FIRST session strictly after the awaiting day that actually
   * carries a reference for that symbol — not simply the next calendar day.
   * A weekend, a holiday or a second missed session must not stop the repair,
   * and must not be treated as the following session either.
   */
  const { rows } = await query(`
    WITH awaiting AS (
      SELECT symbol, trading_date, prev_close
        FROM public.symbol_day
       WHERE close_source = 'AWAITING_NEXT_SESSION'
         AND trading_date < $1::date
    ),
    refs AS (
      -- The exchange reference per symbol per day: constant by construction,
      -- so min() is an order-independent pick rather than a choice.
      SELECT q.symbol, q.trading_date, min(q.last_price - q.chg) AS ref
        FROM public.awsat_market_quotes q
       WHERE q.trading_date <= $1::date
         AND q.session IN ('Trading', '')
         AND q.last_price IS NOT NULL AND q.last_price > 0
         AND q.chg IS NOT NULL
       GROUP BY q.symbol, q.trading_date
      HAVING min(q.last_price - q.chg) > 0
    ),
    paired AS (
      SELECT a.symbol, a.trading_date, a.prev_close,
             (SELECT r.ref FROM refs r
               WHERE r.symbol = a.symbol AND r.trading_date > a.trading_date
               ORDER BY r.trading_date ASC LIMIT 1) AS recovered
        FROM awaiting a
    )
    UPDATE public.symbol_day sd
       SET close_px     = p.recovered,
           close_source = 'NEXT_SESSION_REFERENCE',
           chg_fils     = CASE WHEN p.prev_close IS NOT NULL
                               THEN p.recovered - p.prev_close END,
           chg_1d       = CASE WHEN p.prev_close IS NOT NULL AND p.prev_close <> 0
                               THEN round((100 * (p.recovered - p.prev_close))
                                          / p.prev_close, 4) END
      FROM paired p
     WHERE sd.symbol = p.symbol
       AND sd.trading_date = p.trading_date
       AND p.recovered IS NOT NULL
    RETURNING sd.symbol, sd.trading_date`, [upToDay]);

  const { rows: left } = await query(
    `SELECT count(*)::int AS n FROM public.symbol_day
      WHERE close_source = 'AWAITING_NEXT_SESSION'`);

  if (rows.length) {
    log.warn('symbol_day: recovered closes for days whose capture missed the '
      + 'closing auction — the exchange published them as the next session\'s '
      + 'reference price', { upToDay, repaired: rows.length });
  }
  return { repaired: rows.length, stillAwaiting: left[0].n };
}

module.exports = { repairAwaitingCloses };

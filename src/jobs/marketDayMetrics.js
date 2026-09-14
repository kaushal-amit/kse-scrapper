'use strict';
const T = require('../config/thresholds');
/**
 * src/jobs/marketDayMetrics.js — the market-wide arithmetic, no database.
 *
 * Every function takes an array of symbol_day rows for ONE session and returns
 * numbers. M1-M6 test against hand-built days with no fixture.
 */

const n = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

/**
 * Advancing, declining, unchanged.
 *
 * A symbol with no chg_fils has no previous session to compare against — its
 * direction is unknown, not flat. Counting it unchanged would inflate the
 * unchanged bucket with symbols nobody measured, so it is excluded from all
 * three and only appears in symbols_traded.
 */
function breadth(rows) {
  let advancing = 0;
  let declining = 0;
  let unchanged = 0;
  let noPrev = 0;

  for (const r of rows) {
    const chg = n(r.chg_fils);
    if (chg === null) { noPrev += 1; continue; }
    if (chg > 0) advancing += 1;
    else if (chg < 0) declining += 1;
    else unchanged += 1;
  }

  const traded = rows.length;
  const directional = advancing + declining;

  /*
   * H-J · THE DENOMINATOR IS THE SYMBOLS THAT WERE MEASURED.
   *
   * It was `traded` — rows.length — which INCLUDES the noPrev symbols. Those
   * have no previous close, so this function's own rule (stated above) excludes
   * them from advancing, declining and unchanged alike: they can never appear
   * in the numerator. Dividing by them is dividing by symbols whose direction
   * nobody measured.
   *
   * The effect is one-directional and it is a downgrade: every unmeasurable
   * symbol pushes pct_advancing toward zero and the regime toward RISK_OFF. The
   * day after a gap in the capture — exactly when a lot of symbols lack a
   * previous close — the market reads risk-off because the capture was down,
   * and the session gate then says do not trade.
   *
   * `unchanged` STAYS in the denominator. That is the calibration: 24 of 136 is
   * the 17.6% quoted all month, and a day where 60 rise, 50 fall and 26 sit
   * still is not a risk-on day. What changes is only that symbols with no
   * measurement at all stop counting as if they had sat still.
   */
  const measured = advancing + declining + unchanged;

  /*
   * And below a floor of measured symbols the percentage is NOT COMPUTED at
   * all. A breadth reading over eleven stocks carries the same column and the
   * same authority as one over 136, and nothing downstream can tell them apart
   * — so the one that cannot describe the market says so instead.
   */
  const enough = traded > 0
    && (measured / traded) >= T.get('md_breadth_min_measured_frac');

  return {
    symbols_traded: traded,
    advancing,
    declining,
    unchanged,
    no_prev_close: noPrev,
    /** How many symbols the percentages below are actually computed over. */
    measured_symbols: measured,
    /**
     * THE GATE, over every symbol whose direction was MEASURED.
     *
     * `unchanged` is in the denominator and stays there — that is the
     * calibration the regime cutoffs were set against. The alternative,
     * advancing over advancing+declining, discards the symbols that did not
     * move, and a day where 60 rise, 50 fall and 26 sit still is not a risk-on
     * day. It is kept beside this as pct_advancing_ratio for comparison.
     *
     * The 18% quoted all month was 24 of 136 on 17 August. Eight of those 136
     * had no previous close, so the honest figure for that session is 24 of
     * 128 — 18.75%. One point, on a day whose capture was good; the correction
     * is much larger on the day after a gap, which is precisely when this
     * number gets read.
     */
    pct_advancing: enough ? Number(((100 * advancing) / measured).toFixed(4)) : null,
    /** Stored for comparison only. regime is decided by pct_advancing. */
    pct_advancing_ratio: (enough && directional)
      ? Number(((100 * advancing) / directional).toFixed(4)) : null,
    thin_symbols: rows.filter((r) => r.data_quality === 'THIN').length,
  };
}

/** Percentile by linear interpolation, on a sorted array. */
function percentile(sorted, p) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * The day's move distribution.
 *
 * MEDIAN AND MEAN BOTH, because they disagree and the disagreement is the
 * signal. CATTL rose 109% in one gap on 24 August: that single outlier moves
 * the average and says nothing about the market, while the median is unmoved.
 * Storing only one of them would hide which kind of day it was.
 */
function moveDistribution(rows) {
  const changes = rows.map((r) => n(r.chg_1d)).filter((v) => v !== null).sort((a, b) => a - b);
  if (!changes.length) {
    return {
      avg_pct_change: null, median_pct_change: null,
      pct_change_p10: null, pct_change_p90: null,
    };
  }
  const mean = changes.reduce((t, v) => t + v, 0) / changes.length;
  const round = (v) => (v === null ? null : Number(v.toFixed(4)));
  return {
    avg_pct_change: round(mean),
    median_pct_change: round(percentile(changes, 0.5)),
    pct_change_p10: round(percentile(changes, 0.10)),
    pct_change_p90: round(percentile(changes, 0.90)),
  };
}

/** Volume and trade totals, summed across symbols. */
function activity(rows) {
  const sum = (field) => {
    const vals = rows.map((r) => n(r[field])).filter((v) => v !== null);
    return vals.length ? vals.reduce((t, v) => t + v, 0) : null;
  };
  return {
    total_volume: sum('total_volume'),
    total_trades: sum('trades'),
  };
}

/**
 * Symbols trading at 3x their own recent norm.
 *
 * A WHOLE-DAY proxy: today's trade count against the symbol's 5-day trailing
 * average. The intraday pace the wake-up scan uses is a different measure over
 * a different window, which is why this column is not called pace.
 *
 * `trailing` maps symbol -> average trades over its previous sessions.
 */
function over3xDaily(rows, trailing) {
  let count = 0;
  for (const r of rows) {
    const today = n(r.trades);
    const avg = trailing.get(r.symbol);
    // No history, or an average of zero, makes the multiple unknowable rather
    // than infinite — a symbol with no past would otherwise fire every day.
    if (today === null || !avg || avg <= 0) continue;
    // F-12 · the multiple in the column's own name, read from the file.
    if (today >= T.get('md_over_multiple') * avg) count += 1;
  }
  return count;
}

/**
 * volume_vs_20d — today's volume against the 20-session average.
 *
 * NULL until 20 prior sessions exist. A ratio against three days of history is
 * not the thing the column claims to be, and a number that means something
 * different early on is worse than no number.
 */
function volumeVs20d(todayVolume, priorVolumes) {
  if (todayVolume === null || priorVolumes.length < 20) return null;
  const window = priorVolumes.slice(-20);
  const avg = window.reduce((t, v) => t + v, 0) / window.length;
  return avg > 0 ? Number((todayVolume / avg).toFixed(4)) : null;
}

/**
 * The regime label, from pct_advancing.
 *
 * WARN ONLY. This names the day; it gates nothing. The 20-session log comes
 * first, and only then does anyone argue about blocking entries — the same
 * discipline that downgraded the direction gate once its base rate turned out
 * to be a coin flip.
 */
function regimeOf(pctAdvancing) {
  if (pctAdvancing === null || pctAdvancing === undefined) return null;
  // F-12 · market_day.regime is read by the trading backend. Its two cutoffs
  // were literals here with no provenance.
  if (pctAdvancing < T.get('md_regime_risk_off_pct')) return 'RISK_OFF';
  if (pctAdvancing <= T.get('md_regime_neutral_pct')) return 'NEUTRAL';
  return 'RISK_ON';
}

/** Rolling mean of the last n breadth readings, today included. */
function breadth5dAvg(todayPct, priorPcts) {
  const window = [...priorPcts.slice(-4), todayPct].filter((v) => v !== null && v !== undefined);
  if (!window.length) return null;
  return Number((window.reduce((t, v) => t + v, 0) / window.length).toFixed(4));
}

module.exports = {
  breadth, moveDistribution, activity, over3xDaily, volumeVs20d,
  regimeOf, breadth5dAvg, percentile,
};

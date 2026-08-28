// PORTED VERBATIM from the working ingestion service (history/compute.js).
//
// These formulas were the missing specification — swings, the Fibonacci
// signals, best_earning_time, the buyer/seller split. Nothing here is invented,
// and it is deliberately NOT rewritten: the numbers it produces are already
// trusted, and a tidier version of a formula is a different formula.
//
// Input is one array of 1-minute OHLCV rows for a single stock-day:
//   { ts, open, high, low, close, vol }
// Output keys are mapped by dailyAnalysis.js. Its target table was replaced
// by symbol_day; these formulas are kept for that job to draw on.

// =============================================================================
// KSE Signal Engine — Step 3: Core Metric Computation
// All 35 columns computed from 1-min OHLCV rows for a single stock-day.
// =============================================================================

'use strict';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function round(v, dp = 3) {
  return Math.round(v * Math.pow(10, dp)) / Math.pow(10, dp);
}

// ---------------------------------------------------------------------------
// 3A. Volume spike stats
// ---------------------------------------------------------------------------
/**
 * @param {number[]} vols
 * @param {number}   multiplier
 * @returns {{ avgVolMin: number, highestVolume: number, volSpikeCount: number }}
 */
function computeVolSpikes(vols, multiplier) {
  if (!vols.length) return { avgVolMin: 0, highestVolume: 0, volSpikeCount: 0 };

  const avg     = mean(vols);
  const highest = Math.max(...vols);
  const spikes  = vols.filter(v => v > multiplier * avg).length;

  return {
    avgVolMin:      round(avg, 2),
    highestVolume:  highest,
    volSpikeCount:  spikes,
  };
}

// ---------------------------------------------------------------------------
// 3B. Swing detection  (FIX #4 — minSwingFils filters 1-fil noise ticks)
// ---------------------------------------------------------------------------
/**
 * Detect price swings from sorted close prices.
 * Only returns swings whose absolute size >= minFils.
 *
 * @param {number[]} closes       Sorted 1-min close prices (oldest first)
 * @param {number}   minFils      Minimum swing size to keep
 * @returns {Array<{
 *   direction: 'bull'|'bear',
 *   size: number,
 *   startIdx: number,
 *   endIdx: number,
 *   startPrice: number,
 *   endPrice: number,
 *   startMinute: number,
 *   endMinute: number
 * }>}
 */
function detectSwings(closes, minFils) {
  const swings = [];
  const n = closes.length;
  let i = 1;

  while (i < n) {
    if (closes[i] === closes[i - 1]) { i++; continue; }

    const direction = closes[i] > closes[i - 1] ? 1 : -1;
    let j = i;

    // Extend while direction holds; flat bars are absorbed
    while (j < n) {
      const delta = closes[j] - closes[j - 1];
      if (delta * direction >= 0 || delta === 0) j++;
      else break;
    }

    const endIdx = Math.min(j - 1, n - 1);
    const size   = closes[endIdx] - closes[i - 1];

    if (Math.abs(size) >= minFils) {
      swings.push({
        direction:   size > 0 ? 'bull' : 'bear',
        size:        round(Math.abs(size), 3),
        startIdx:    i - 1,
        endIdx,
        startPrice:  closes[i - 1],
        endPrice:    closes[endIdx],
        startMinute: i - 1,
        endMinute:   endIdx,
      });
    }
    i = j;
  }

  return swings;
}

/**
 * Aggregate swing-level metrics for one trading day.
 *
 * @param {ReturnType<typeof detectSwings>} swings
 * @param {number} autoTarget
 * @returns {object}
 */
function swingStats(swings, autoTarget) {
  if (!swings.length) {
    return {
      bullSwings: 0, bearSwings: 0, totalSwings: 0,
      tradableBullSwings: 0,
      largestBullSwing: 0, largestBearSwing: 0,
      avgSwingSize: 0, avgTimeBtwnSwings: 0,
      longestBullRun: 0, longestBearRun: 0,
    };
  }

  const bull = swings.filter(s => s.direction === 'bull');
  const bear = swings.filter(s => s.direction === 'bear');

  // Tradable = bull swings that reach the auto target
  const tradableBull = bull.filter(s => s.size >= autoTarget);

  // Average minutes between swing starts
  let avgTimeBtwn = 0;
  if (swings.length > 1) {
    const gaps = [];
    for (let k = 0; k < swings.length - 1; k++) {
      gaps.push(swings[k + 1].startMinute - swings[k].startMinute);
    }
    avgTimeBtwn = round(mean(gaps), 2);
  }

  // Longest consecutive bull / bear runs
  let longestBull = 0, longestBear = 0, curBull = 0, curBear = 0;
  for (const s of swings) {
    if (s.direction === 'bull') { curBull++; curBear = 0; }
    else                         { curBear++; curBull = 0; }
    longestBull = Math.max(longestBull, curBull);
    longestBear = Math.max(longestBear, curBear);
  }

  return {
    bullSwings:          bull.length,
    bearSwings:          bear.length,
    totalSwings:         swings.length,
    tradableBullSwings:  tradableBull.length,
    largestBullSwing:    bull.length ? round(Math.max(...bull.map(s => s.size)), 3) : 0,
    largestBearSwing:    bear.length ? round(Math.max(...bear.map(s => s.size)), 3) : 0,
    avgSwingSize:        round(mean(swings.map(s => s.size)), 3),
    avgTimeBtwnSwings:   avgTimeBtwn,
    longestBullRun:      longestBull,
    longestBearRun:      longestBear,
  };
}

// ---------------------------------------------------------------------------
// 3C. Auto target
// ---------------------------------------------------------------------------
function computeAutoTarget(avgSwing, floorFils) {
  return round(Math.max(floorFils, avgSwing * 0.75), 2);
}

// ---------------------------------------------------------------------------
// 3D. Fibonacci signals
// ---------------------------------------------------------------------------
/**
 * Simulate Fib-level trades for every swing in the day.
 * FIX: uses real exit price (not hardcoded target) for avgProfitFib.
 *
 * @param {ReturnType<typeof detectSwings>} swings
 * @param {number[]} closes
 * @param {number}   target
 * @param {number[]} fibLevels
 * @returns {object}
 */
function computeFibSignals(swings, closes, target, fibLevels) {
  const signals = [];

  for (const swing of swings) {
    const swHigh = Math.max(swing.startPrice, swing.endPrice);
    const swLow  = Math.min(swing.startPrice, swing.endPrice);
    const rng    = swHigh - swLow;
    if (rng === 0) continue;

    for (const lvl of fibLevels) {
      const fibPrice = round(swHigh - lvl * rng, 3);
      const future   = closes.slice(swing.endIdx);

      // First touch of fib level (±0.5 fils tolerance)
      const touchOffset = future.findIndex(p => Math.abs(p - fibPrice) <= 0.5);
      if (touchOffset === -1) continue;

      const touchIdx  = swing.endIdx + touchOffset;
      const entryPx   = closes[touchIdx];
      const tWin      = entryPx + target;
      const tStop     = entryPx - target;
      const remaining = closes.slice(touchIdx);

      const hitWin  = remaining.findIndex(p => p >= tWin);
      const hitStop = remaining.findIndex(p => p <= tStop);

      if (hitWin !== -1 && (hitStop === -1 || hitWin < hitStop)) {
        // WIN — actual exit price, not just target (FIX #4 in Python — same here)
        const exitPx = closes[Math.min(touchIdx + hitWin, closes.length - 1)];
        signals.push({
          win:         true,
          profit:      round(exitPx - entryPx, 3),
          mins:        hitWin,
          entryMinute: touchIdx,
        });
      } else {
        // LOSS
        const stopIdx = hitStop !== -1 ? touchIdx + hitStop : closes.length - 1;
        const exitPx  = closes[Math.min(stopIdx, closes.length - 1)];
        signals.push({
          win:         false,
          profit:      round(exitPx - entryPx, 3),
          mins:        null,
          entryMinute: touchIdx,
        });
      }
    }
  }

  if (!signals.length) {
    return {
      fibSignals: 0, successfulFib: 0, fibWinPct: 0,
      avgProfitFib: 0, avgLossFib: 0, avgTimeToTarget: 0,
      bestEarningTime: '06:00', falseSignalPct: 0,
    };
  }

  const wins   = signals.filter(s => s.win);
  const losses = signals.filter(s => !s.win);
  const total  = signals.length;

  const winPct      = round(wins.length / total * 100, 2);
  const falsePct    = round(losses.length / total * 100, 2);
  const avgProfit   = wins.length   ? round(mean(wins.map(s => s.profit)), 3)               : 0;
  const avgLoss     = losses.length ? round(mean(losses.map(s => Math.abs(s.profit))), 3)   : 0;
  const holdTimes   = wins.filter(s => s.mins !== null).map(s => s.mins);
  const avgTimeTgt  = holdTimes.length ? round(mean(holdTimes), 2) : 0;

  // Best earning time — hour bucket with highest win rate
  // KSE opens ~06:00, so minute 0 = 06:00, minute 60 = 07:00, etc.
  const hourMap = {};
  for (const s of signals) {
    const h = Math.floor(s.entryMinute / 60);
    if (!hourMap[h]) hourMap[h] = { wins: 0, total: 0 };
    hourMap[h].total++;
    if (s.win) hourMap[h].wins++;
  }
  const bestH = Object.entries(hourMap).reduce((best, [h, stat]) => {
    const rate = stat.wins / stat.total;
    return rate > (best.rate || 0) ? { h: parseInt(h), rate } : best;
  }, { h: 0, rate: 0 }).h;

  const bestEarningTime = `${String(6 + bestH).padStart(2, '0')}:00`;

  return {
    fibSignals:      total,
    successfulFib:   wins.length,
    fibWinPct:       winPct,
    avgProfitFib:    avgProfit,
    avgLossFib:      avgLoss,
    avgTimeToTarget: avgTimeTgt,
    bestEarningTime,
    falseSignalPct:  falsePct,
  };
}

// ---------------------------------------------------------------------------
// 3E. Buyer / Seller estimation
// ---------------------------------------------------------------------------
/**
 * @param {number[]} closes
 * @param {number[]} vols
 * @returns {{ estBuyerVol: number, estSellerVol: number, buyerPct: number, sellerPct: number }}
 */
function computeBuyerSeller(closes, vols) {
  let buyerVol = 0, sellerVol = 0;

  for (let i = 1; i < closes.length; i++) {
    const v = vols[i];
    if (closes[i] > closes[i - 1])      buyerVol  += v;
    else if (closes[i] < closes[i - 1]) sellerVol += v;
    else { buyerVol += v / 2; sellerVol += v / 2; }
  }

  const total = buyerVol + sellerVol;
  return {
    estBuyerVol:  Math.round(buyerVol),
    estSellerVol: Math.round(sellerVol),
    buyerPct:     total ? round(buyerVol  / total * 100, 2) : 0,
    sellerPct:    total ? round(sellerVol / total * 100, 2) : 0,
  };
}

// ---------------------------------------------------------------------------
// 3F. Master per-day function — returns all 35 columns or null
// ---------------------------------------------------------------------------
/**
 * @param {string}   symbol
 * @param {string}   tradeDate   'YYYY-MM-DD'
 * @param {Array<{ts: Date, open: number, high: number, low: number, close: number, vol: number}>} rows
 * @param {import('./config').DEFAULT_CONFIG} cfg
 * @returns {object|null}
 */
function computeDailyMetrics(symbol, tradeDate, rows, cfg) {
  if (rows.length < 5) {
    console.warn(`[compute] ${symbol} ${tradeDate} — only ${rows.length} rows, skipping`);
    return null;
  }

  // FIX #2 — sort by ts ASC then take first open / last close explicitly
  const sorted = [...rows].sort((a, b) => new Date(a.ts) - new Date(b.ts));

  const opens  = sorted.map(r => r.open);
  const highs  = sorted.map(r => r.high);
  const lows   = sorted.map(r => r.low);
  const closes = sorted.map(r => r.close);
  const vols   = sorted.map(r => r.vol);

  // ── OHLCV ─────────────────────────────────────────────────────────────────
  const dayOpen  = opens[0];
  const dayClose = closes[closes.length - 1];   // FIX #2 — last element, not ARRAY_AGG DESC
  const dayHigh  = Math.max(...highs);
  const dayLow   = Math.min(...lows);
  const ocMargin = round(dayClose - dayOpen, 3);
  const dayRange = round(dayHigh - dayLow, 3);
  const totalVol = vols.reduce((s, v) => s + v, 0);

  const { avgVolMin, highestVolume, volSpikeCount } =
    computeVolSpikes(vols, cfg.volSpikeMultiplier);

  // ── Swings ────────────────────────────────────────────────────────────────
  const swings    = detectSwings(closes, cfg.minSwingFils);
  const avgSwing  = swings.length ? mean(swings.map(s => s.size)) : 0;
  const autoTgt   = computeAutoTarget(avgSwing, cfg.targetProfitFils);
  const swStats   = swingStats(swings, autoTgt);

  // ── Fibonacci ─────────────────────────────────────────────────────────────
  const fibStats  = computeFibSignals(swings, closes, autoTgt, cfg.fibLevels);

  // ── Buyer / Seller ────────────────────────────────────────────────────────
  const bsStats   = computeBuyerSeller(closes, vols);

  return {
    symbol,
    tradeDate,

    // OHLCV
    dayOpen:       round(dayOpen, 3),
    dayClose:      round(dayClose, 3),
    ocMargin,
    dayHigh:       round(dayHigh, 3),
    dayLow:        round(dayLow, 3),
    dayRange,
    totalVolume:   totalVol,
    avgVolMin,
    highestVolume,
    volSpikeCount,

    // Swings
    ...swStats,
    autoTargetFils: autoTgt,

    // Fibonacci
    ...fibStats,

    // Buyer / Seller
    ...bsStats,
  };
}

module.exports = {
  computeVolSpikes,
  detectSwings,
  swingStats,
  computeAutoTarget,
  computeFibSignals,
  computeBuyerSeller,
  computeDailyMetrics,
};
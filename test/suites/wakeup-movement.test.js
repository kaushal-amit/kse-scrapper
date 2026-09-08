// B2 · the wake-up MOVEMENT test (Item 4).
//   ACTIVITY (pace≥2× OR volume≥3×avg OR moved 15+ fils from open)
//   AND MOVEMENT (range≥8 fils AND ≥1 3-fil up-move)
//   AND absolute volume ≥ 300 × shares-at-budget × frac
//   priority: halted today > range > 3-fil up-moves > volume ratio
process.env.AWSAT_MODE = 'client';
process.env.WAKEUP_BUDGET_KD = '700';        // shares-at-budget uses this
process.env.WAKEUP_ABS_VOL_FLOOR_FRAC = '1'; // full screen floor
const db = require('../../src/db/pool');
const wake = require('../../src/wakeup');
let p = 0, n = 0; const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, JSON.stringify(x)); };

const day = '1995-05-05';
// A symbol's captures: prices in order, plus the day's max volume and an
// optional halt session on one capture.
async function sym(symbol, prices, volume, { halted = false } = {}) {
  const base = new Date(day + 'T06:00:00Z').getTime();
  for (let i = 0; i < prices.length; i += 1) {
    const session = halted && i === 1 ? 'CB Auction' : 'Trading';
    await db.query(
      `insert into awsat_market_quotes(market,symbol,session,last_price,high_price,low_price,volume,trades,trading_date,ingest_source,source_precedence,created_at)
       values ('Main Market',$1,$2,$3,$3,$3,$4,$5,$6,'awsat_server',1,$7)`,
      [symbol, session, prices[i], i === prices.length - 1 ? volume : Math.round(volume * 0.5), 30, day,
       new Date(base + i * 60000)]);
  }
}

(async () => {
  await db.query("delete from awsat_market_quotes where symbol like 'WM%'");
  await db.query('delete from depth_watchlist where trading_date=$1', [day]);
  await db.query('delete from signal_log where trading_date=$1', [day]);

  // floor at 700 KD, ~100 fils ≈ 300 × 7,000 = 2,100,000 — firing symbols carry 3M.
  const BIGVOL = 3_000_000, SMALLVOL = 1_000_000;

  // QIC — a huge move would need range; here range is 3 fils. Tiny volume too.
  await sym('WMQIC', [100, 101, 103, 102], 20_000);
  // ALMANAR — 3-fil range, but built of +1 steps: zero 3-fil up-moves.
  await sym('WMALMANAR', [100, 101, 102, 103], BIGVOL);
  // VALID — open 100 → last 118 (moved 18 ≥15, ACTIVITY), range 18, three 3-fil
  // up-moves, volume over the floor. Fires.
  await sym('WMGOOD', [100, 103, 106, 118], BIGVOL);
  // FLOOR-FAIL — same movement as VALID but volume below the floor.
  await sym('WMTHIN', [100, 103, 106, 118], SMALLVOL);
  // BIG — a LARGER range than FTI, not halted.
  await sym('WMBIG', [100, 106, 112, 130], BIGVOL);   // range 30
  // FTI — halted today, smaller range (18) than BIG, fires.
  await sym('WMFTI', [100, 103, 106, 118], BIGVOL, { halted: true });

  const moves = await wake.computeMovement(day, 13);
  const budget = await wake.currentBudgetKd();
  const verdict = (s) => { const m = moves.find((x) => x.symbol === s); return wake.movementVerdict(m, m.pace ?? null, budget); };

  ck('QIC (3-fil range) does NOT fire — MOVEMENT fails', verdict('WMQIC').fires === false, verdict('WMQIC'));
  ck('ALMANAR (3-fil range, no 3-fil up-move) does NOT fire', verdict('WMALMANAR').fires === false, verdict('WMALMANAR'));
  ck('a 18-fil range with 3-fil up-moves over the floor FIRES', verdict('WMGOOD').fires === true, verdict('WMGOOD'));
  ck('the same movement UNDER the volume floor does not fire', verdict('WMTHIN').fires === false && verdict('WMTHIN').movement === true && verdict('WMTHIN').absVol === false, verdict('WMTHIN'));

  // priority: FTI (halted) outranks BIG (larger range, not halted).
  const r = await wake.scan(day, 13);
  const order = r.rows.filter((x) => !x.blocked).map((x) => x.symbol);
  ck('the halted symbol (FTI) is promoted first, above a larger-range symbol', order[0] === 'WMFTI', order);
  ck('BIG (larger range) ranks below the halted one', order.indexOf('WMBIG') > order.indexOf('WMFTI'), order);

  await db.query("delete from awsat_market_quotes where symbol like 'WM%'");
  await db.query('delete from depth_watchlist where trading_date=$1', [day]);
  await db.query('delete from signal_log where trading_date=$1', [day]);
  console.log(`\nwakeup movement: ${p}/${n}`);
  await db.close();
  process.exit(p === n ? 0 : 1);
})();

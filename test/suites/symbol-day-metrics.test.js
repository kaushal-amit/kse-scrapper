// S1-S10 and the six rules, against hand-built days. No database.
const m=require('../../src/jobs/symbolDayMetrics');
let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,JSON.stringify(x))};
let T=0;
const row=(o={})=>({created_at:new Date(Date.parse('2026-08-13T06:00:00Z')+(T++)*60000),
  last_price:100,last_qty:5000,volume:1000,trades:10,bid:99,offer:101,session:'Trading',...o});
const day=(rows)=>{T=0;return rows;};

// ── S1 · TIJARA 13 Aug close = 176, not 172 ──
const tijara=day([
  row({last_price:170,volume:1000,session:'Trading'}),
  row({last_price:172,volume:2000,session:'Trading'}),
  row({last_price:174,volume:3000,session:'Trading at Last'}),
  row({last_price:176,volume:4000,session:'Close-Of-Day'}),
]);
ck('S1: close_px = 176', m.closePrice(tijara)===176, m.closePrice(tijara));
const lastTrading=tijara.filter(r=>r.session==='Trading').slice(-1)[0].last_price;
ck('S1: the OLD way gives 172 — the bug', lastTrading===172, lastTrading);

// ── S2 · a close from Close Auction Acceptance ──
ck('S2: Close Auction Acceptance counts',
   m.closePrice(day([row({last_price:175,volume:1}),row({last_price:170,volume:2,session:'Close Auction Acceptance'})]))===170);
ck('an unknown session is EXCLUDED',
   m.closePrice(day([row({last_price:200,volume:1}),row({last_price:999,volume:2,session:'Suspended'})]))===200);
ck('a NULL session is INCLUDED',
   m.closePrice(day([row({last_price:200,volume:1}),row({last_price:210,volume:2,session:null})]))===210);

// ── CATTL · high must include the CB auction ──
const cattl=day([
  row({last_price:250,volume:1000}), row({last_price:280,volume:2000}),
  row({last_price:133,volume:3000,session:'Close Auction Acceptance'}),
]);
const pb=m.priceBlock(cattl);
ck('CATTL: low includes the auction (133)', pb.low_px===133, pb);
ck('CATTL: high across all rows (280)', pb.high_px===280, pb);
ck('open is the first capture', pb.open_px===250, pb);

// ── THE VOLUME GATE ──
const quoteOnly=day([row({last_price:100,volume:5000}),row({last_price:105,volume:5000})]);
ck('a price change with NO volume is not a move', m.movementBlock(quoteOnly).moves===0);
const realMove=day([row({last_price:100,volume:5000}),row({last_price:105,volume:5100})]);
ck('a price change WITH volume is a move', m.movementBlock(realMove).moves===1);
ck('a volume reset is ignored, not counted negative',
   m.volumeSteps(day([row({volume:9000}),row({volume:5})])).length===0);

// ── CUMULATIVE: max, never sum ──
const mrc=day([row({volume:10876132,trades:1034}),row({volume:10876132,trades:1034}),
               row({volume:10876132,trades:1034}),row({volume:10876132,trades:1034}),
               row({volume:10876132,trades:1034})]);
const vb=m.volumeBlock(mrc);
ck('MRC: total_volume = max, not 54M', vb.total_volume===10876132, vb.total_volume);
ck('MRC: trades = max', vb.trades===1034, vb.trades);
const steps=day([row({volume:1000}),row({volume:6000}),row({volume:6500})]);
ck('highest_minute_volume is the largest INCREASE',
   m.volumeBlock(steps).highest_minute_volume===5000, m.volumeBlock(steps).highest_minute_volume);

// ── S3/S4 · ARABREC tiny_pct_up is UP-ONLY ──
// 4 up-moves, 1 on a tiny print. 4 down-moves, 3 tiny.
const arabrec=day([
  row({last_price:100,volume:1000,last_qty:5000}),
  row({last_price:101,volume:1100,last_qty:50}),    // up, tiny
  row({last_price:102,volume:1200,last_qty:5000}),  // up
  row({last_price:103,volume:1300,last_qty:5000}),  // up
  row({last_price:104,volume:1400,last_qty:5000}),  // up
  row({last_price:103,volume:1500,last_qty:50}),    // down, tiny
  row({last_price:102,volume:1600,last_qty:50}),    // down, tiny
  row({last_price:101,volume:1700,last_qty:50}),    // down, tiny
  row({last_price:100,volume:1800,last_qty:5000}),  // down
]);
const ar=m.movementBlock(arabrec);
ck('S3: tiny_pct_up = 25 (1 of 4 up-moves)', ar.tiny_pct_up===25, ar.tiny_pct_up);
// 1 tiny of 4 up = 25%. Blending in 3 tiny of 4 down gives 4 of 8 = 50%.
// The blended figure DOUBLES it here; on ARABREC it halved 24 to 12. Either
// way the two numbers describe different things and only the up-only one is
// the gate.
ck('S4: blended reads 50, up-only reads 25 — they are not interchangeable',
   Number((100*(ar.up_moves_tiny+ar.down_moves_tiny)/(ar.up_moves+ar.down_moves)).toFixed(1))===50.0
   && ar.tiny_pct_up===25);
ck('tiny_pct_down reported separately', ar.tiny_pct_down===75, ar.tiny_pct_down);
ck('trades_under_100 counts prints, not moves', ar.trades_under_100===4, ar.trades_under_100);

// ── up_moves_2plus is UP ONLY ──
const jumps=day([
  row({last_price:100,volume:1000}), row({last_price:103,volume:1100}),  // +3
  row({last_price:105,volume:1200}),                                     // +2
  row({last_price:100,volume:1300}),                                     // -5
]);
const jm=m.movementBlock(jumps);
ck('up_moves_2plus counts only UP', jm.up_moves_2plus===2, jm.up_moves_2plus);
ck('up_moves_3plus stricter', jm.up_moves_3plus===1, jm.up_moves_3plus);
ck('the -5 is a down_move, not a 2plus', jm.down_moves===1, jm.down_moves);

// ── S5 · GFH buy_sell_ratio NULL at 98% at-offer ──
const gfh=day(Array.from({length:50},(_,i)=>
  row({last_price:101,volume:1000+i*10,bid:99,offer:101})));   // every print AT the offer
const gm=m.movementBlock(gfh);
ck('GFH: pct_at_offer ~100', gm.pct_at_offer>90, gm.pct_at_offer);
ck('S5: buy_sell_ratio is NULL', m.buySellRatio(gm)===null, m.buySellRatio(gm));
// Flow is judged on the LATER row of each step — the first capture opens the
// day and is never the `now` side of anything, so its own location never
// counts. Four rows to get three steps ending at offer, bid and inside.
const mixed=day([
  row({last_price:100,volume:1000,bid:99,offer:101}),
  row({last_price:101,volume:1100,bid:99,offer:101}),   // step 1 ends AT OFFER
  row({last_price:99,volume:1200,bid:99,offer:101}),    // step 2 ends AT BID
  row({last_price:100,volume:1300,bid:99,offer:101}),   // step 3 ends INSIDE
]);
const mm=m.movementBlock(mixed);
ck('a balanced book DOES get a ratio', m.buySellRatio(mm)!==null, m.buySellRatio(mm));
ck('flow uses print location', mm.trades_at_offer===1&&mm.trades_at_bid===1,
   {atOffer:mm.trades_at_offer,atBid:mm.trades_at_bid});
ck('shares attributed to the right side',
   mm.bought_at_offer===100&&mm.sold_at_bid===100, mm);
ck('the opening capture is never classified — 3 steps from 4 rows',
   mm.steps===3, mm.steps);

// ── data_quality ──
ck('THIN below 60 minutes absolute', m.dataQuality(45,260,true)==='THIN');
ck('THIN below 80% of the market median', m.dataQuality(200,260,true)==='THIN');
ck('FULL at 80%+ with a close', m.dataQuality(210,260,true)==='FULL');
ck('THIN with no Close-Of-Day', m.dataQuality(259,260,false)==='THIN');
ck('26 Aug: 203 of 260 AND no close -> THIN', m.dataQuality(203,260,false)==='THIN');
ck('a 20-minute market day does NOT read FULL', m.dataQuality(20,20,true)==='THIN');

// ── family and the tick band ──
ck('CRAWLER below 100 fils', m.familyOf(87)==='CRAWLER');
ck('not CRAWLER at 100', m.familyOf(100)===null);
ck('family NULL when there is no close', m.familyOf(null)===null);
ck('tick band crossed: closes 99, high 105', m.tickBandCrossed(99,105)===true);
ck('not crossed: closes 99, high 99', m.tickBandCrossed(99,99)===false);
ck('not crossed above the band', m.tickBandCrossed(200,210)===false);

// ── minutes ──
ck('minutes are DISTINCT', m.minutesCaptured([{created_at:'2026-08-13T06:00:00Z'},
  {created_at:'2026-08-13T06:00:30Z'},{created_at:'2026-08-13T06:01:00Z'}])===2);

console.log(`\nsymbol_day metrics: ${p}/${n}`);
process.exit(p===n?0:1);

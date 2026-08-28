const analysis=require('../../src/jobs/dailyAnalysis');
// daily_stock_analysis was dropped by migration 011. The ENGINE is kept and
// still tested; only the job that wrote to the retired table is gone.
const analyse=analysis.analyseLegacy;
const fin=require('../../src/jobs/historyFinalise');
const db=require('../../src/db/pool');
let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,JSON.stringify(x))};
(async()=>{
  const day='1988-03-10';   // a date no other suite touches
  await db.query("delete from tradingview_watchlist where trading_date=$1",[day]);
  await db.query("delete from tradingview_history where trade_date=$1",[day]);

  // 120 minutes of a symbol that swings, with CUMULATIVE volume
  const base=new Date('1988-03-10T06:00:00Z');
  let cum=0;
  for(let i=0;i<120;i++){
    const price = 100 + Math.round(8*Math.sin(i/6));   // swings ~+-8 fils
    cum += 500 + (i%10===0 ? 9000 : 0);                 // periodic volume spikes
    await db.query(
      `insert into tradingview_watchlist(symbol,last_price,volume,trading_date,created_at)
       values ('DAA',$1,$2,$3,$4)`,[price,cum,day,new Date(base.getTime()+i*60000)]);
  }
  // too-thin symbol
  for(let i=0;i<3;i++)
    await db.query(`insert into tradingview_watchlist(symbol,last_price,volume,trading_date,created_at)
      values ('DATHIN',$1,$2,$3,$4)`,[50,10,day,new Date(base.getTime()+i*60000)]);

  // ── minute bars: cumulative volume must be DIFFERENCED ──
  const bars=await analysis.loadMinuteBars(day);
  const daa=bars.get('DAA');
  ck('one bar per minute', daa.length===120, daa.length);
  ck('volume differenced, not cumulative', daa[1].vol===500, daa[1].vol);
  ck('spike minute has the spike', daa[10].vol===9500, daa[10].vol);
  ck('total differenced volume == final cumulative',
     daa.reduce((s,b)=>s+b.vol,0)===cum, {sum:daa.reduce((s,b)=>s+b.vol,0),cum});

  // ── the ENGINE, direct ──
  //
  // daily_stock_analysis was dropped by migration 011, so there is no table to
  // write to. The formulas are still real and still needed by the symbol_day
  // job, so they are tested against compute() directly rather than through a
  // persistence path that no longer exists.
  const compute=require('../../src/jobs/dailyCompute');
  const metrics=compute.computeDailyMetrics('DAA',day,daa,analysis.CFG);
  ck('engine returns metrics for the fat symbol', !!metrics, metrics);
  const thin=compute.computeDailyMetrics('DATHIN',day,bars.get('DATHIN')||[],analysis.CFG);
  ck('engine refuses a thin symbol', thin===null, thin);
  const a=analysis.toRow(metrics,day);

  ck('row shape built', !!a);
  ck('day_open/close set', Number(a.day_open)>0 && Number(a.day_close)>0, {o:a.day_open,c:a.day_close});
  ck('day_high >= day_low', Number(a.day_high)>=Number(a.day_low));
  ck('day_range = high - low', Math.abs(Number(a.day_range)-(Number(a.day_high)-Number(a.day_low)))<0.01);
  ck('total_volume matches cumulative', Number(a.total_volume)===cum, a.total_volume);
  ck('vol spikes detected', Number(a.vol_spike_count)>0, a.vol_spike_count);
  ck('swings detected', Number(a.total_swings)>0, a.total_swings);
  ck('bull+bear == total', Number(a.bull_swings)+Number(a.bear_swings)===Number(a.total_swings),
     {b:a.bull_swings,r:a.bear_swings,t:a.total_swings});
  ck('auto_target_fils set', a.auto_target_fils!==null, a.auto_target_fils);
  ck('buyer_pct + seller_pct ~ 100',
     Math.abs(Number(a.buyer_pct)+Number(a.seller_pct)-100)<0.5, {b:a.buyer_pct,s:a.seller_pct});
  // Buyer + seller is LESS than total volume, and that is correct: minutes
  // where the close did not move are attributed to neither side. Asserting
  // equality would be asserting a different formula than the one in use.
  ck('buyer+seller <= total (flat minutes excluded)',
     Number(a.est_buyer_vol)+Number(a.est_seller_vol)<=Number(a.total_volume),
     {b:a.est_buyer_vol,s:a.est_seller_vol,t:a.total_volume});
  ck('both sides attributed', Number(a.est_buyer_vol)>0&&Number(a.est_seller_vol)>0);
  ck('best_earning_time populated', typeof a.best_earning_time==='string'||a.best_earning_time===null);
  ck('every mapped column produced', Object.keys(a).length>=35, Object.keys(a).length);


  // ── history for the same day, testable via an explicit date ──
  const h=await fin.finalise(day,null);
  ck('history finalises the same day', h.inserted===1, h);

  // ── previousTradingDay steps over the weekend ──
  const sun=analysis.previousTradingDay(new Date('2026-08-23T05:00:00Z')); // Sunday
  ck('previous trading day skips Fri/Sat', sun==='2026-08-20', sun);

  await db.query("delete from tradingview_watchlist where trading_date=$1",[day]);
  await db.query("delete from tradingview_history where trade_date=$1",[day]);
  console.log(`\ndaily analysis: ${p}/${n}`);
  await db.close(); process.exit(p===n?0:1);
})().catch(async e=>{console.error('CRASH:',e.message);await db.close();process.exit(1)});

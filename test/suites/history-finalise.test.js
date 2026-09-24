const fin=require('../../src/jobs/historyFinalise');
const db=require('../../src/db/pool');
let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,JSON.stringify(x))};
(async()=>{
  const day='1987-06-15';   // a date no other suite touches
  await db.query("delete from tradingview_watchlist where symbol like 'HF%'");
  await db.query("delete from tradingview_history where symbol like 'HF%'");

  /*
   * P6-TV-5 · change is measured against the PREVIOUS SESSION'S CLOSE — the
   * venue's own definition, and the one the backfill path writes into these
   * same columns. The previous day's bar is seeded so the rule has an input;
   * without one, and with no change from the venue, the columns are NULL
   * ("not measured"), never close - open.
   */
  await db.query(
    `insert into tradingview_history(symbol,trade_date,close_price)
     values ('HFA','1987-06-12',100)
     on conflict (symbol,trade_date) do update set close_price = excluded.close_price`);

  // 20 captures: price walks 100 -> 118, dips to 95, volume is CUMULATIVE
  const base=new Date('1987-06-15T06:00:00Z');
  for(let i=0;i<20;i++){
    const price = i===7 ? 95 : (i===15 ? 130 : 100+i);
    await db.query(
      `insert into tradingview_watchlist(symbol,last_price,volume,trading_date,created_at)
       values ('HFA',$1,$2,$3,$4)`,
      [price, 1000*(i+1), day, new Date(base.getTime()+i*60000)]);
  }
  // a thin symbol: 3 captures only
  for(let i=0;i<3;i++)
    await db.query(`insert into tradingview_watchlist(symbol,last_price,volume,trading_date,created_at)
      values ('HFTHIN',$1,$2,$3,$4)`,[50+i,10,day,new Date(base.getTime()+i*60000)]);

  const r=await fin.finalise(day,null);
  ck('aggregated the fat symbol', r.inserted===1, r);
  ck('thin symbol rejected, not stored as a bar', r.rejected===1, r);

  // P6-TV-5 · this day's bar only: the previous session's row is seeded above.
  const {rows}=await db.query("select * from tradingview_history where symbol='HFA' and trade_date=$1",[day]);
  const b=rows[0];
  ck('open = FIRST capture', Number(b.open_price)===100, b.open_price);
  ck('close = LAST capture', Number(b.close_price)===119, b.close_price);
  ck('high = max across the day', Number(b.high_price)===130, b.high_price);
  ck('low = min across the day', Number(b.low_price)===95, b.low_price);
  ck('volume = LAST cumulative value, not a sum', Number(b.volume)===20000, b.volume);
  ck('change_value is against the PREVIOUS CLOSE (119 - 100)', Number(b.change_value)===19, b.change_value);
  ck('change_pct likewise', Number(b.change_pct)===19, b.change_pct);
  ck('session_finalised_at stamped', b.session_finalised_at!==null);
  ck('high >= low', Number(b.high_price)>=Number(b.low_price));

  // re-run must CORRECT, never duplicate
  await db.query(`insert into tradingview_watchlist(symbol,last_price,volume,trading_date,created_at)
    values ('HFA',200,99000,$1,$2)`,[day,new Date(base.getTime()+21*60000)]);
  const r2=await fin.finalise(day,null);
  const {rows:rows2}=await db.query("select count(*)::int c, max(close_price) cp, max(high_price) hp from tradingview_history where symbol='HFA' and trade_date=$1",[day]);
  ck('re-run does not duplicate', rows2[0].c===1, rows2[0]);
  ck('re-run corrects the close', Number(rows2[0].cp)===200, rows2[0].cp);
  ck('re-run corrects the high', Number(rows2[0].hp)===200, rows2[0].hp);

  // a day with no minutes at all
  const r3=await fin.finalise('1999-01-01',null);
  ck('empty day is not an error', r3.inserted===0&&r3.extracted===0, r3);

  await db.query("delete from tradingview_watchlist where symbol like 'HF%'");
  await db.query("delete from tradingview_history where symbol like 'HF%'");
  console.log(`\nhistory finalise: ${p}/${n}`);
  await db.close(); process.exit(p===n?0:1);
})().catch(async e=>{console.error('CRASH:',e.message);await db.close();process.exit(1)});

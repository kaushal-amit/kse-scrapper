const repo=require('../../src/db/repositories');
const clock=require('../../src/market/clock');
const db=require('../../src/db/pool');
const awsat=require('../../src/scrapers/awsat');
const hist=require('../../src/scrapers/historyTransform');
let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,x===undefined?'':JSON.stringify(x))};
(async()=>{
  // --- parsing ported from production ---
  ck('symbol "ABAR - 101" split', JSON.stringify(awsat.parseSymbol('ABAR - 101'))==='{"symbol":"ABAR","code":"101"}', awsat.parseSymbol('ABAR - 101'));
  ck('unsigned negative -> abs', awsat.num('-5')===5);
  ck('signed keeps negative', awsat.num('-2.5',true)===-2.5);
  ck('U+2212 minus', awsat.num('\u22122.5',true)===-2.5, awsat.num('\u22122.5',true));
  ck('DD-MM-YYYY -> ISO', awsat.toDate('20-08-2026')==='2026-08-20');
  ck('bad date -> null', awsat.toDate('20/08/2026')===null);
  ck('wheelDelta stays below viewport', awsat.WHEEL_DELTA===250, awsat.WHEEL_DELTA);
  ck('both markets configured', awsat.MARKETS.length===2, awsat.MARKETS);
  ck('FIELD_MAP has ltp->last_price', awsat.FIELD_MAP['dataObj.ltp']==='last_price');

  // --- persistence against the production-named tables ---
  const created=new Date(); const day=clock.tradingDay();
  await db.query("delete from awsat_market_quotes where symbol like 'TST%'");
  await db.query("delete from instruments where symbol like 'TST%'");
  await repo.upsertSymbols([{market:'Premier Market',symbol:'TSTA',code:'1',description:'A'},
                            {market:'Main Market',symbol:'TSTB',code:'2',description:'B'}]);
  const q=(m,s,pr)=>({scrape_batch_id:null,market:m,symbol:s,code:'1',description:'d',
    last_price:pr,chg:-2.5,pct_chg:-1.1,volume:1000,bid:pr-1,offer:pr+1,trades:5,
    trading_date:day,source:'awsat',ingest_source:'awsat_server',run_id:null,created_at:created});
  let r=await repo.insertQuotes([q('Premier Market','TSTA',176),q('Main Market','TSTB',540)]);
  ck('awsat_market_quotes inserted', r.inserted===2, r);
  r=await repo.insertQuotes([q('Premier Market','TSTA',999)]);
  ck('replay deduplicated', r.inserted===0, r);
  const {rows}=await db.query("select market,symbol,last_price,chg from awsat_market_quotes where symbol like 'TST%' order by symbol");
  ck('original price kept', Number(rows[0].last_price)===176, rows[0]);
  ck('negative chg preserved', Number(rows[0].chg)===-2.5, rows[0].chg);
  ck('both markets stored', rows[0].market!==rows[1].market, rows.map(x=>x.market));

  // --- daily history ---
  await db.query("delete from tradingview_history where symbol like 'TST%'");
  const bar={symbol:'TSTA',trade_date:'2026-08-19',open_price:176,high_price:180,low_price:175,
    close_price:178,change_value:-2,change_pct:null,volume:1000,source:'tradingview',run_id:null};
  ck('daily inserted',(await repo.upsertDailyPrices([bar])).inserted===1);
  ck('daily restatement upserts',(await repo.upsertDailyPrices([{...bar,close_price:183}])).inserted===1);
  const {rows:d}=await db.query("select close_price from tradingview_history where symbol='TSTA'");
  ck('restated value won', Number(d[0].close_price)===183, d[0]);
  const {rows:c}=await db.query("select count(*)::int c from tradingview_history where symbol='TSTA'");
  ck('no duplicate day', c[0].c===1, c[0]);

  // history transform emits the production column names
  const built=hist.buildDailyRows([{ts:Math.floor(Date.UTC(2026,7,19)/1000),dateText:'',values:['1','2','0.5','1.5','0','10']}],
    ['Date','Open','High','Low','Close','Change','Volume'],{symbol:'TSTA'});
  ck('transform emits trade_date', 'trade_date' in built.rows[0], Object.keys(built.rows[0]));
  ck('transform emits change_value', 'change_value' in built.rows[0]);

  await db.query("delete from awsat_market_quotes where symbol like 'TST%'");
  await db.query("delete from tradingview_history where symbol like 'TST%'");
  await db.query("delete from instruments where symbol like 'TST%'");
  console.log(`\nproduction alignment: ${p}/${n}`);
  await db.close(); process.exit(p===n?0:1);
})().catch(async e=>{console.error('CRASH:',e.message);await db.close();process.exit(1)});

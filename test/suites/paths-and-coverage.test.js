// The 404, and the 135-symbol consistency requirement.
process.env.AWSAT_MODE='client';
process.env.INGEST_TOKEN='trading';
const express=require('express');
const db=require('../../src/db/pool');
const clock=require('../../src/market/clock');
let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,JSON.stringify(x))};

const ingest=require('../../src/api/ingest');
const app=express();
app.use((req,res,next)=>{res.set('Access-Control-Allow-Origin','*');
  if(req.method==='OPTIONS')return res.status(204).end(); next();});
app.use(express.json({limit:'8mb'}));
app.use(express.text({limit:'8mb',type:['text/plain','text/*']}));
app.use('/ingest', ingest.createRouter());
app.use('/', ingest.createRouter());

const srv=app.listen(8805,async()=>{
  const post=(path,body)=>fetch('http://127.0.0.1:8805'+path,{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    .then(async r=>({status:r.status,body:await r.json().catch(()=>({}))}));

  const day=clock.tradingDay();
  await db.query("delete from awsat_stock_depth where ingest_source='awsat_client'");
  await db.query("delete from awsat_market_quotes where ingest_source='awsat_client'");
  // The whole day, not just RC%: other suites leave rows on today's date and
  // the coverage reference is "every symbol TradingView captured", so a
  // stranger's row moves the expected count.
  await db.query("delete from tradingview_watchlist where trading_date=$1",[day]);
  await db.query("delete from awsat_market_quotes where trading_date=$1",[day]);

  // ── THE 404: the bare paths the userscripts use ──
  const d1=await post('/depth',{token:'trading',records:[
    {symbol:'RC1',level:1,bidPrice:100,bidQty:10,offerPrice:101,offerQty:20}]});
  ck('POST /depth no longer 404s', d1.status===200, d1.status);
  const d2=await post('/ingest/depth',{token:'trading',records:[
    {symbol:'RC2',level:1,bidPrice:100,bidQty:10,offerPrice:101,offerQty:20}]});
  ck('POST /ingest/depth still works', d2.status===200, d2.status);
  const o1=await post('/orders',{token:'trading',capturedAt:new Date().toISOString(),records:[
    {orderId:'RC-O1',symbolRaw:'RC1 - 1',side:'Buy',status:'OPEN',price:1,quantity:'10',filled:'0',remaining:'10'}]});
  ck('POST /orders works', o1.status===200 && o1.body.inserted===1, o1.body);

  // ── /debug: the dumps that were silently 404ing ──
  const dbg=await post('/debug',{token:'trading',items:[{source:'ORDERS_ROWS_HTML',d:'<div>markup</div>'}]});
  ck('POST /debug accepted', dbg.status===200 && dbg.body.written===1, dbg.body);

  // ── 135-symbol consistency ──
  // TradingView captured 135; AWSAT sends 131 of them plus 2 it alone has.
  const at=new Date();
  const tv=[]; for(let i=1;i<=135;i++) tv.push('RC'+i);
  for(const sym of tv)
    await db.query(`insert into tradingview_watchlist(symbol,last_price,volume,trading_date,created_at)
      values ($1,100,10,$2,$3)`,[sym,day,at]);

  const awsat=tv.slice(0,131).map(sym=>({market:'Premier Market',symbol:sym,last:100,
    chg:0,pctChg:0,volume:10,bid:99,bidQty:1,offer:101,offerQty:1}));
  awsat.push({market:'Premier Market',symbol:'RIGHTS1',last:1,volume:1});
  awsat.push({market:'Premier Market',symbol:'RIGHTS2',last:1,volume:1});

  const q=await post('/quotes',{token:'trading',capturedAt:new Date().toISOString(),records:awsat});
  ck('quotes accepted', q.status===200, q.body);
  ck('coverage reported in the response', !!q.body.coverage, q.body.coverage);
  ck('expected = the 135 watchlist symbols', q.body.coverage.expected===135, q.body.coverage);
  ck('matched = 131', q.body.coverage.matched===131, q.body.coverage);
  ck('missing = 4 flagged', q.body.coverage.missing===4, q.body.coverage);
  ck('coverage pct computed', q.body.coverage.pct===97.0, q.body.coverage.pct);

  // a COMPLETE capture reports no gap
  const full=tv.map(sym=>({market:'Premier Market',symbol:sym,last:100,volume:10}));
  const q2=await post('/quotes',{token:'trading',capturedAt:new Date(Date.now()+1000).toISOString(),records:full});
  ck('complete capture -> 0 missing', q2.body.coverage.missing===0, q2.body.coverage);
  ck('complete capture -> 100%', q2.body.coverage.pct===100, q2.body.coverage);

  // the reconciler itself
  const rec=require('../../src/reconcileSymbols');
  const r=await rec.check(new Set(tv.slice(0,100)),{day,source:'test'});
  ck('reconciler lists the missing tickers', r.missingSymbols.length===35, r.missingSymbols.length);
  ck('extras reported separately', (await rec.check(new Set([...tv,'ZZZ']),{day,source:'test'})).extra===1);

  // The whole day, not just RC%: other suites leave rows on today's date and
  // the coverage reference is "every symbol TradingView captured", so a
  // stranger's row moves the expected count.
  await db.query("delete from tradingview_watchlist where trading_date=$1",[day]);
  await db.query("delete from awsat_market_quotes where trading_date=$1",[day]);
  await db.query("delete from awsat_market_quotes where ingest_source='awsat_client'");
  await db.query("delete from awsat_stock_depth where ingest_source='awsat_client'");
  await db.query("delete from awsat_order_obs where order_id like 'RC-%'");
  console.log(`\npaths + coverage: ${p}/${n}`);
  srv.close(); await db.close(); process.exit(p===n?0:1);
});

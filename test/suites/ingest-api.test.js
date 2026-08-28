// The ingest API only accepts client posts in client mode — that is the
// mutual-exclusion guarantee, not a bug. The suite must therefore run in the
// mode it is exercising.
process.env.AWSAT_MODE = 'client';
// Pin the token the suite uses, so a different INGEST_TOKEN in .env cannot
// make an auth-config difference look like an API failure.
process.env.INGEST_TOKEN = 'test-token-0123456789abcdef0123';

const express=require('express');
const {createRouter}=require('../../src/api/ingest');
const db=require('../../src/db/pool');
const app=express(); app.use(express.json({limit:'8mb'}));
app.use('/ingest',createRouter());
const srv=app.listen(8797,async()=>{
  let p=0,n=0; const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,JSON.stringify(x))};
  const T='test-token-0123456789abcdef0123';
  const post=(path,body,tok=T)=>fetch('http://127.0.0.1:8797/ingest/'+path,{method:'POST',
    headers:{'Content-Type':'application/json','Authorization':'Bearer '+tok},body:JSON.stringify(body)})
    .then(async r=>({status:r.status,body:await r.json()}));

  await db.query("delete from awsat_market_quotes where ingest_source='awsat_client'");
  await db.query("delete from client_submissions");

  // auth
  ck('no token -> 401', (await post('quotes',{records:[]},'')).status===401);
  ck('bad token -> 401', (await post('quotes',{records:[]},'wrong-token-aaaaaaaaaaaaaaaaaaaa')).status===401);

  // stale capture rejected
  const old=new Date(Date.now()-3600e3).toISOString();
  const stale=await post('quotes',{capturedAt:old,records:[{symbol:'ABAR',last:'176'}]});
  ck('stale capturedAt -> 400', stale.status===400 && /old/.test(stale.body.error), stale.body);

  // happy path, userscript-shaped payload
  const rec={market:'Premier Market',symbol:'ABAR',code:'101',description:'Al Arabi',
    last:176,chg:-2.5,pctChg:-1.4,volume:1240000,bid:175,bidQty:5000,offer:177,offerQty:3000,
    trades:42,open:178,high:180,low:174,session:'Trading'};
  const ok=await post('quotes',{batchId:'b-1',capturedAt:new Date().toISOString(),records:[rec]});
  ck('valid batch inserted', ok.status===200 && ok.body.inserted===1, ok.body);

  // idempotency: SAME batchId replays, does not double-insert
  const dup=await post('quotes',{batchId:'b-1',capturedAt:new Date().toISOString(),records:[rec]});
  ck('duplicate batch replayed', dup.body.duplicate===true, dup.body);
  const {rows:c}=await db.query("select count(*)::int c from awsat_market_quotes where ingest_source='awsat_client'");
  ck('no double insert', c[0].c===1, c[0]);

  // negatives + precedence stored
  const {rows:r}=await db.query("select chg,pct_chg,ingest_source,source_precedence from awsat_market_quotes where ingest_source='awsat_client'");
  ck('negative chg preserved', Number(r[0].chg)===-2.5, r[0].chg);
  ck('client precedence = 2', r[0].source_precedence===2, r[0].source_precedence);

  // batch size cap
  const big=await post('quotes',{capturedAt:new Date().toISOString(),records:new Array(3000).fill(rec)});
  ck('oversized batch -> 413', big.status===413, big.status);

  // depth
  const d=await post('depth',{batchId:'d-1',capturedAt:new Date().toISOString(),symbol:'ABAR',
    levels:[{level:1,bid:175,bidQty:5000,offer:177,offerQty:3000},{level:2,bid:174,bidQty:4000,offer:178,offerQty:2500}]});
  ck('depth inserted', d.body.inserted===2, d.body);

  // orders, incl. one with no id
  const o=await post('orders',{batchId:'o-1',capturedAt:new Date().toISOString(),
    orders:[{orderId:'A1',symbol:'ABAR',side:'Buy',status:'FILLED',price:176,quantity:1000,filled:1000},
            {symbol:'ABAR',side:'Sell',price:177,quantity:500,filled:0}]});
  ck('orders: valid kept, id-less rejected', o.body.inserted===1 && o.body.rejected===1, o.body);

  // health
  const h=await fetch('http://127.0.0.1:8797/ingest/health',{headers:{Authorization:'Bearer '+T}}).then(r=>r.json());
  ck('health ok', h.ok===true, h);

  await db.query("delete from awsat_market_quotes where ingest_source='awsat_client'");
  await db.query("delete from client_submissions");
  console.log(`\ningest API: ${p}/${n}`);
  srv.close(); await db.close(); process.exit(p===n?0:1);
});

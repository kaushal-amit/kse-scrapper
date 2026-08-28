// Reproduces the exact shape found in awsat_market_quotes.csv:
// Premier 39 + Main 98 = 137 wanted, plus 57 auction rows that should not be there.
process.env.AWSAT_MODE='client';
process.env.INGEST_TOKEN='trading';
const express=require('express');
const db=require('../../src/db/pool');
const validate=require('../../src/validate');
let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,JSON.stringify(x))};

const ingest=require('../../src/api/ingest');
const app=express(); app.use(express.json({limit:'8mb'}));
app.use('/', ingest.createRouter());
const srv=app.listen(8806,async()=>{
  const post=(b)=>fetch('http://127.0.0.1:8806/quotes',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify(b)})
    .then(async r=>({status:r.status,body:await r.json()}));

  await db.query("delete from awsat_market_quotes where ingest_source='awsat_client'");

  // ── the raw code must never reach the table ──
  const raw=validate.validateQuote({symbol:'AAN',market:'B',trading_date:'2026-08-25',
    created_at:new Date(),source:'awsat'});
  ck("market 'B' rejected as a raw code", raw.ok===false, raw.reason);
  ck('the reason names the code', /raw code/.test(raw.reason||''), raw.reason);
  const good=validate.validateQuote({symbol:'ABAR',market:'Main Market',trading_date:'2026-08-25',
    created_at:new Date(),source:'awsat'});
  ck('a real market name passes', good.ok===true, good.reason);
  const named=validate.validateQuote({symbol:'AAN',market:'Auction Market',trading_date:'2026-08-25',
    created_at:new Date(),source:'awsat'});
  ck('Auction Market is a valid NAME if sent', named.ok===true, named.reason);

  // ── both markets land, with the right split ──
  const recs=[];
  for(let i=1;i<=39;i++) recs.push({market:'Premier Market',symbol:'PRM'+i,last:100,volume:1});
  for(let i=1;i<=98;i++) recs.push({market:'Main Market',symbol:'MAIN'+i,last:100,volume:1});
  const r=await post({token:'trading',capturedAt:new Date().toISOString(),records:recs});
  ck('137 rows accepted', r.body.inserted===137, r.body);

  const {rows:split}=await db.query(
    "select market, count(*)::int c from awsat_market_quotes where ingest_source='awsat_client' group by market order by market");
  ck('BOTH markets present', split.length===2, split);
  ck('Main Market = 98', split.find(x=>x.market==='Main Market').c===98, split);
  ck('Premier Market = 39', split.find(x=>x.market==='Premier Market').c===39, split);

  // ── a leaked raw code is rejected, the good rows still land ──
  const mixed=[{market:'Premier Market',symbol:'PRMX',last:100,volume:1},
               {market:'B',symbol:'AANX',last:0,volume:0}];
  const r2=await post({token:'trading',capturedAt:new Date(Date.now()+1000).toISOString(),records:mixed});
  ck('good row stored despite the bad one', r2.body.inserted===1, r2.body);
  ck('bad row counted as rejected', r2.body.rejected===1, r2.body);
  const {rows:none}=await db.query("select count(*)::int c from awsat_market_quotes where market='B'");
  ck("no market 'B' rows in the table", none[0].c===0, none[0]);

  await db.query("delete from awsat_market_quotes where ingest_source='awsat_client'");
  console.log(`\nmarkets: ${p}/${n}`);
  srv.close(); await db.close(); process.exit(p===n?0:1);
});

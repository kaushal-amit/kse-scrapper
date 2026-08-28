// A symbol whose quotes arrive and are dropped must be visible in the database,
// not only as a count in a panel nobody watches.
process.env.AWSAT_MODE='client'; process.env.INGEST_TOKEN='trading';
const express=require('express');
const db=require('../../src/db/pool');
let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,JSON.stringify(x))};

const app=express(); app.use(express.json({limit:'8mb'}));
app.use('/', require('../../src/api/ingest').createRouter());
const srv=app.listen(8814, async()=>{
  const post=(b)=>fetch('http://127.0.0.1:8814/quotes',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(r=>r.json());
  const st=async(sym)=>(await db.query(
    'select broker_status,broker_status_on,tv_status from instruments where symbol=$1',[sym])).rows[0];

  await db.query("delete from instruments where symbol like 'UM%'");
  await db.query("delete from awsat_market_quotes where symbol like 'UM%'");
  for(const s of ['UMABAR','UMNIND','UMOK'])
    await db.query("insert into instruments(market,symbol) values ('Main Market',$1) on conflict do nothing",[s]);

  // a batch that stored UMOK and dropped two
  await post({token:'trading',capturedAt:new Date().toISOString(),
    records:[{market:'Main Market',symbol:'UMOK',last:100,volume:1000}],
    unmatched:['UMABAR','UMNIND']});

  ck('a captured symbol is marked CAPTURED', (await st('UMOK')).broker_status==='CAPTURED', await st('UMOK'));
  ck('a dropped symbol is marked UNMATCHED', (await st('UMABAR')).broker_status==='UNMATCHED', await st('UMABAR'));
  ck('all dropped symbols, not just the first', (await st('UMNIND')).broker_status==='UNMATCHED');
  ck('the date is recorded', (await st('UMABAR')).broker_status_on!==null);

  // ── scrape_status_on is the date it CHANGED, not last confirmed ──
  await db.query("update instruments set broker_status_on='2026-07-26' where symbol='UMABAR'");
  await post({token:'trading',capturedAt:new Date(Date.now()+1000).toISOString(),
    records:[{market:'Main Market',symbol:'UMOK',last:101,volume:1100}],
    unmatched:['UMABAR']});
  const still=await st('UMABAR');
  ck('an unchanged status does NOT move the date — "UNMATCHED since 26 July"',
     new Date(still.broker_status_on).toISOString().startsWith('2026-07-26'), still);

  // ── recovery moves it ──
  await post({token:'trading',capturedAt:new Date(Date.now()+2000).toISOString(),
    records:[{market:'Main Market',symbol:'UMABAR',last:224,volume:5000}]});
  const back=await st('UMABAR');
  ck('recovery flips it to CAPTURED', back.broker_status==='CAPTURED', back);
  ck('and the date moves, because the status changed',
     !new Date(back.broker_status_on).toISOString().startsWith('2026-07-26'), back);

  // ── an unmatched report must not fail the batch ──
  const r=await post({token:'trading',capturedAt:new Date(Date.now()+3000).toISOString(),
    records:[{market:'Main Market',symbol:'UMOK',last:102,volume:1200}],
    unmatched:['NOSUCHSYMBOL']});
  ck('a batch with an unknown unmatched symbol still stores', r.inserted===1, r);

  // ── the CHECK constraint holds ──
  let bad=false;
  try{ await db.query("update instruments set broker_status='WEIRD' where symbol='UMOK'"); }catch{ bad=true; }
  ck('an invalid broker_status is refused', bad===true);

  // DELISTED is a fact set by hand. The ingest path must never overwrite it,
  // or BAREEQ flips to ABSENT on the first quiet day and starts triggering
  // master re-fetches against a symbol that will never resolve.
  await db.query("insert into instruments(market,symbol,broker_status,broker_status_on) values ('Main Market','UMDEAD','DELISTED','2022-04-21') on conflict do nothing");
  await post({token:'trading',capturedAt:new Date(Date.now()+4000).toISOString(),
    records:[{market:'Main Market',symbol:'UMOK',last:103,volume:1300}],
    unmatched:['UMDEAD']});
  const dead=await st('UMDEAD');
  ck('a DELISTED symbol is NOT flipped to UNMATCHED by ingest',
     dead.broker_status==='DELISTED', dead);
  ck('and its date is untouched',
     new Date(dead.broker_status_on).toISOString().startsWith('2022-04-21'), dead);

  await db.query("delete from instruments where symbol like 'UM%'");
  await db.query("delete from awsat_market_quotes where symbol like 'UM%'");
  console.log(`\nunmatched reporting: ${p}/${n}`);
  srv.close(); await db.close(); process.exit(p===n?0:1);
});

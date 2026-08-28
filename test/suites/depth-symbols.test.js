process.env.AWSAT_MODE='client';
process.env.INGEST_TOKEN='trading';
const express=require('express');
const db=require('../../src/db/pool');
const clock=require('../../src/market/clock');
let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,JSON.stringify(x))};

// /depth-symbols now serves depth_watchlist — the STATE — not a config list.
const app=express(); app.use(express.json());
app.use('/', require('../../src/api/ingest').createRouter());
const srv=app.listen(8807,async()=>{
  const get=(u)=>fetch('http://127.0.0.1:8807'+u).then(async r=>({status:r.status,body:await r.json()}));
  const day=clock.tradingDay();
  const clean=()=>db.query('delete from depth_watchlist where trading_date=$1',[day]);
  await clean();
  await db.query("delete from instruments where symbol like 'DS%'");

  // ── no auth: the client fetches this before it holds a token ──
  const r0=await get('/depth-symbols');
  ck('reachable without a token', r0.status===200, r0.status);
  ck('an empty watchlist is an empty list, not an error',
     r0.body.symbols.length===0 && r0.status===200, r0.body);
  ck('source names the table', r0.body.source==='depth_watchlist', r0.body.source);

  // ── slots are served in slot order: priority order ──
  await db.query("insert into instruments(market,symbol,code) values ('Main Market','DSMRC','510') on conflict do nothing");
  for(const [slot,sym,type] of [[1,'DSMRC','PRE_DAY'],[2,'DSEMI','PRE_DAY'],[5,'DSWAKE','WAKEUP']]){
    await db.query(`insert into depth_watchlist(trading_date,slot_no,symbol,slot_type,assigned_by)
      values ($1,$2,$3,$4,'TEST')`,[day,slot,sym,type]);
  }
  const r1=await get('/depth-symbols');
  ck('serves every held slot', r1.body.symbols.length===3, r1.body.symbols.length);
  ck('in SLOT ORDER — pre-day swept before wake-ups',
     r1.body.symbols.map(s=>s.symbol).join()==='DSMRC,DSEMI,DSWAKE', r1.body.symbols.map(s=>s.symbol));
  ck('reports the pre-day / wakeup split',
     r1.body.pre_day===2 && r1.body.wakeup===1, {p:r1.body.pre_day,w:r1.body.wakeup});
  ck('code attached where the registry knows it',
     r1.body.symbols[0].code==='510', r1.body.symbols[0]);
  ck('slot number carried through', r1.body.symbols[2].slot===5, r1.body.symbols[2]);

  // ── a released slot is not served ──
  await db.query('update depth_watchlist set released_at=now() where trading_date=$1 and slot_no=5',[day]);
  const r2=await get('/depth-symbols');
  ck('a released slot drops out', r2.body.symbols.length===2, r2.body.symbols.length);

  // ── no PRE_DAY rows is a WARNING, not a failure ──
  await clean();
  await db.query(`insert into depth_watchlist(trading_date,slot_no,symbol,slot_type,assigned_by)
    values ($1,4,'DSONLY','WAKEUP','TEST')`,[day]);
  const r3=await get('/depth-symbols');
  ck('wake-ups alone still serve — no pre-day is a choice, not an error',
     r3.status===200 && r3.body.symbols.length===1, r3.body);
  ck('and the pre-day count is zero', r3.body.pre_day===0, r3.body.pre_day);

  await clean();
  await db.query("delete from instruments where symbol like 'DS%'");
  console.log(`\ndepth-symbols: ${p}/${n}`);
  srv.close(); await db.close(); process.exit(p===n?0:1);
});

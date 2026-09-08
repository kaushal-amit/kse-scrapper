// EMIRATES was not in the sweep on 2 September. It became the only stock worth
// trading and the book was invisible for an hour. SHUAIBA the day before.
process.env.AWSAT_MODE='client'; process.env.INGEST_TOKEN='trading';
const express=require('express');
const db=require('../../src/db/pool');
const clock=require('../../src/market/clock');
let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,JSON.stringify(x))};

const app=express(); app.use(express.json());
app.use('/', require('../../src/api/ingest').createRouter());
const srv=app.listen(8823, async()=>{
  const day=clock.tradingDay();
  const post=(n2,body)=>fetch(`http://127.0.0.1:8823/slots/${n2}`,{method:'POST',
    headers:{'Content-Type':'application/json',Authorization:'Bearer trading'},
    body:JSON.stringify(body)}).then(async r=>({status:r.status,body:await r.json()}));
  const clean=async()=>{
    await db.query('delete from depth_watchlist where trading_date=$1',[day]);
    await db.query("delete from position where symbol like 'SW%'");
    await db.query("delete from instruments where symbol like 'SW%'");
  };
  await clean();
  await db.query(`insert into instruments(market,symbol,code,is_primary,is_tradeable) values
    ('Main Market','SWA','1',true,true),('Main Market','SWB','2',true,true),
    ('Main Market','SWC','3',true,true),('Main Market','SWDEAD','4',true,false)
    on conflict do nothing`);

  console.log('\n=== an empty slot is claimed ===');
  const a=await post(1,{symbol:'SWA',reason:'only stock moving'});
  ck('200', a.status===200, a.body);
  ck('and it says when it takes effect', /25 seconds/.test(a.body.effective_in||''), a.body);
  ck('nothing was replaced', a.body.replaced===null, a.body);

  console.log('\n=== a swap RECORDS what it replaced ===');
  const b=await post(1,{symbol:'SWB',reason:'SWA went dead'});
  ck('200', b.status===200, b.body);
  ck('and names the symbol it displaced', b.body.replaced==='SWA', b.body);
  const {rows:hist}=await db.query(
    `select symbol, replaced_symbol, replaced_by, replaced_reason
       from depth_watchlist where trading_date=$1 and slot_no=1 and released_at is null`,[day]);
  ck('the history is stored — ALOLA became INJAZZAT and nothing recorded it',
     hist[0].replaced_symbol==='SWA' && hist[0].replaced_by==='UI', hist[0]);
  ck('with the reason', hist[0].replaced_reason==='SWA went dead', hist[0]);

  console.log('\n=== a slot holding a POSITION cannot be displaced ===');
  await db.query(`insert into position(symbol,trading_date,shares,avg_cost,opened_at,is_open)
    values ('SWB',$1,3600,217,now(),true)`,[day]);
  const c=await post(1,{symbol:'SWC'});
  ck('409', c.status===409, c.status);
  ck('and says WHY — blind on a symbol you are in',
     /blind on a symbol you are in/.test(c.body.detail||''), c.body.detail);
  ck('the slot is unchanged',
     (await db.query('select symbol from depth_watchlist where trading_date=$1 and slot_no=1 and released_at is null',[day])).rows[0].symbol==='SWB');
  await db.query("delete from position where symbol='SWB'");

  console.log('\n=== five slots, never six ===');
  const six=await post(6,{symbol:'SWC'});
  ck('slot 6 is refused', six.status===400, six.status);
  ck('and the reason is the sweep budget, not an arbitrary limit',
     /degrades five books to gain one/.test(six.body.detail||''), six.body.detail);
  ck('slot 0 too', (await post(0,{symbol:'SWC'})).status===400);

  console.log('\n=== one symbol, one slot ===');
  await post(2,{symbol:'SWC'});
  const dup=await post(3,{symbol:'SWC'});
  ck('the same symbol twice is refused', dup.status===409, dup.status);
  ck('and names where it already sits', /holds slot 2/.test(dup.body.error||''), dup.body.error);

  console.log('\n=== a non-tradeable symbol is refused ===');
  const dead=await post(3,{symbol:'SWDEAD'});
  ck('refused', dead.status===400, dead.status);
  ck('and says a book nobody can act on', /nobody can act on/.test(dead.body.detail||''), dead.body.detail);

  console.log('\n=== re-posting the same symbol is a no-op, not an error ===');
  const same=await post(2,{symbol:'SWC'});
  ck('200 and unchanged', same.status===200 && same.body.unchanged===true, same.body);

  await clean();
  console.log(`\nslot swap: ${p}/${n}`);
  srv.close(); await db.close(); process.exit(p===n?0:1);
});

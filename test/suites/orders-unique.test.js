// The requirement in one sentence: 10 orders placed -> 10 rows, however many
// times the scraper runs.
process.env.AWSAT_MODE='client';
const repo=require('../../src/db/repositories');
const db=require('../../src/db/pool');
let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,JSON.stringify(x))};
(async()=>{
  await db.query("delete from awsat_order_list where order_id like 'UQ-%'");
  const day='2026-08-25';
  const mk=(id,status,filled,at)=>({order_id:id,symbol:'ABAR',side:'BUY',order_status:status,
    price:176,quantity:1000,filled_quantity:filled,remaining_qty:1000-filled,
    trading_date:day,ingest_source:'awsat_client',created_at:at});

  // 10 orders, scraped 30 times (half an hour at one minute)
  const t0=new Date('2026-08-25T09:00:00Z');
  for(let run=0;run<30;run++){
    const batch=[];
    for(let i=1;i<=10;i++) batch.push(mk('UQ-'+i,'OPEN',0,new Date(t0.getTime()+run*60000)));
    await repo.insertOrders(batch);
  }
  const {rows:c}=await db.query("select count(*)::int c from awsat_order_list where order_id like 'UQ-%'");
  ck('10 orders x 30 scrapes -> 10 rows', c[0].c===10, c[0]);

  const {rows:s}=await db.query("select sighting_count, first_seen_at, last_seen_at from awsat_order_list where order_id='UQ-1'");
  ck('sighting_count records the repeats', s[0].sighting_count===30, s[0].sighting_count);
  ck('first_seen_at kept from the FIRST sighting',
     new Date(s[0].first_seen_at).getTime()===t0.getTime(), s[0].first_seen_at);
  ck('last_seen_at advanced to the LAST',
     new Date(s[0].last_seen_at).getTime()===t0.getTime()+29*60000, s[0].last_seen_at);

  // an order that FILLS must update, not stay OPEN for ever
  await repo.insertOrders([mk('UQ-1','FILLED',1000,new Date(t0.getTime()+31*60000))]);
  const {rows:f}=await db.query("select order_status,filled_quantity,remaining_qty from awsat_order_list where order_id='UQ-1'");
  ck('status advances to FILLED', f[0].order_status==='FILLED', f[0].order_status);
  ck('filled_quantity updates', Number(f[0].filled_quantity)===1000, f[0].filled_quantity);
  ck('remaining_qty updates', Number(f[0].remaining_qty)===0, f[0].remaining_qty);
  const {rows:c2}=await db.query("select count(*)::int c from awsat_order_list where order_id like 'UQ-%'");
  ck('still 10 rows after the fill', c2[0].c===10, c2[0]);

  // the SAME order seen by both collectors is ONE order
  await repo.insertOrders([{...mk('UQ-1','FILLED',1000,new Date()),ingest_source:'awsat_server'}]);
  const {rows:c3}=await db.query("select count(*)::int c from awsat_order_list where order_id='UQ-1'");
  ck('both collectors -> still one row', c3[0].c===1, c3[0]);

  // a duplicate WITHIN one batch
  const dup=[mk('UQ-99','OPEN',0,new Date()),mk('UQ-99','OPEN',0,new Date())];
  await repo.insertOrders(dup);
  const {rows:c4}=await db.query("select count(*)::int c from awsat_order_list where order_id='UQ-99'");
  ck('duplicate inside one batch -> one row', c4[0].c===1, c4[0]);

  // an order with no id is not storable
  const r=await repo.insertOrders([{symbol:'ABAR',side:'BUY',trading_date:day,created_at:new Date()}]);
  ck('id-less order dropped', r.inserted===0, r);

  await db.query("delete from awsat_order_list where order_id like 'UQ-%'");
  console.log(`\norders uniqueness: ${p}/${n}`);
  await db.close(); process.exit(p===n?0:1);
})().catch(async e=>{console.error('CRASH:',e.message);await db.close();process.exit(1)});

// O1-O5 from the step 2 spec.
process.env.AWSAT_MODE='client';
process.env.INGEST_TOKEN='trading';
const express=require('express');
const db=require('../../src/db/pool');
const repo=require('../../src/db/repositories');
let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,JSON.stringify(x))};

const app=express(); app.use(express.json({limit:'8mb'}));
app.use('/', require('../../src/api/ingest').createRouter());
const srv=app.listen(8810,async()=>{
  const post=(b)=>fetch('http://127.0.0.1:8810/orders',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify(b)})
    .then(async r=>({status:r.status,body:await r.json()}));
  const clean=()=>db.query("delete from awsat_order_list where order_id like 'OM%'");
  await clean();

  // ── O1 · net_value populated on every filled row ──
  const filled=[
    {orderId:'OM-1',symbolRaw:'MRC - 510',side:'Sell',status:'Filled',price:204,
     quantity:'3,500',filled:'3,500',remaining:'0',
     avgPrice:'204',ordVal:'714,000',netOrdVal:'713,712.5'},
    {orderId:'OM-2',symbolRaw:'CATTL - 701',side:'Buy',status:'Filled',price:188,
     quantity:'1,000',filled:'1,000',remaining:'0',
     avgPrice:'188',ordVal:'188,000',netOrdVal:'188,075.2'},
  ];
  const r=await post({token:'trading',capturedAt:new Date().toISOString(),records:filled});
  ck('filled orders accepted', r.body.inserted===2, r.body);

  const {rows:nv}=await db.query(
    "select order_id,net_value,order_value,avg_price from awsat_order_list where order_id like 'OM-%' order by order_id");
  ck('O1: net_value on 100% of filled rows',
     nv.length===2 && nv.every(x=>x.net_value!==null), nv);
  ck('O1: net_value is the netOrdVal number, not ordVal',
     Number(nv[0].net_value)===713712.5, nv[0].net_value);
  ck('order_value mapped separately', Number(nv[0].order_value)===714000, nv[0].order_value);
  ck('avg_price mapped', Number(nv[0].avg_price)===204, nv[0].avg_price);
  ck('raw JSON kept whole',
     (await db.query("select raw from awsat_order_list where order_id='OM-1'")).rows[0].raw!==null);

  // ── O2 · executions on a partial fill ──
  // A 6,100 sell filling 5,350 then 750: two executions, two settlement fees.
  const at=new Date();
  const step=(fillQty,ms)=>({order_id:'OM-PART',symbol:'MRC',side:'SELL',
    order_status:fillQty===6100?'Filled':'Partially Filled',price:204,
    quantity:6100,filled_quantity:fillQty,remaining_qty:6100-fillQty,
    trading_date:'2026-08-25',ingest_source:'awsat_client',
    created_at:new Date(at.getTime()+ms)});

  await repo.insertOrders([step(0,0)]);
  let e=async()=>(await db.query("select executions_observed,filled_quantity from awsat_order_list where order_id='OM-PART'")).rows[0];
  ck('a new order starts at 1 observed execution', (await e()).executions_observed===1, await e());

  await repo.insertOrders([step(5350,60000)]);
  ck('first fill -> 2', (await e()).executions_observed===2, await e());
  await repo.insertOrders([step(6100,120000)]);
  ck('O2: partial fill gives executions_observed > 1', (await e()).executions_observed===3, await e());

  // an unchanged sighting must NOT inflate the fee
  await repo.insertOrders([step(6100,180000)]);
  ck('a repeat sighting does not increment', (await e()).executions_observed===3, await e());

  // It is a FLOOR, not a count: two fills inside one 60-second poll are seen
  // as one. The reference 6,100 sell filling as 5,350 + 750 in the same minute
  // records 1, and the fee — charged per execution — is understated.
  await db.query("delete from awsat_order_list where order_id='OM-SAMEMIN'");
  await repo.insertOrders([{order_id:'OM-SAMEMIN',symbol:'MRC',side:'SELL',
    order_status:'Filled',price:204,quantity:6100,filled_quantity:6100,
    remaining_qty:0,trading_date:'2026-08-25',ingest_source:'awsat_client',
    created_at:new Date()}]);
  const {rows:sm}=await db.query(
    "select executions_observed from awsat_order_list where order_id='OM-SAMEMIN'");
  ck('both fills in one interval read as 1 — a known UNDERCOUNT',
     sm[0].executions_observed===1, sm[0]);

  // The fee view is what surfaces it.
  await db.query(`update awsat_order_list set order_value=1244400, net_value=1244397.7
    where order_id='OM-SAMEMIN'`);
  const {rows:fc}=await db.query(
    "select fee_charged, fee_per_execution from order_fee_check where order_id='OM-SAMEMIN'");
  ck('order_fee_check exposes the charged fee', fc.length===1 && Number(fc[0].fee_charged)>0, fc[0]);
  ck('and a fee-per-execution to compare',
     fc[0] && Number(fc[0].fee_per_execution)===Number(fc[0].fee_charged), fc[0]);
  await db.query("delete from awsat_order_list where order_id='OM-SAMEMIN'");
  ck('filled_quantity final', Number((await e()).filled_quantity)===6100, await e());

  // ── O4 · order_id unique and non-null ──
  const {rows:u}=await db.query(`
    select count(*)::int total, count(distinct order_id)::int distinct_ids,
           count(*) filter (where order_id is null)::int nulls
      from awsat_order_list where order_id like 'OM%'`);
  ck('O4: order_id unique', u[0].total===u[0].distinct_ids, u[0]);
  ck('O4: order_id never null', u[0].nulls===0, u[0]);
  let dup=false;
  try { await db.query(`insert into awsat_order_list(order_id,trading_date,ingest_source,created_at)
    values ('OM-1','2026-08-25','awsat_client',now())`); } catch { dup=true; }
  ck('a duplicate order_id is refused by the database', dup===true);

  // ── O5 · buys minus sells equals the position ──
  await db.query("delete from awsat_order_list where order_id like 'OMP%'");
  const pos=[
    {orderId:'OMP-1',symbolRaw:'MRC - 510',side:'Buy',status:'Filled',quantity:'3,500',filled:'3,500',netOrdVal:'658,000'},
    {orderId:'OMP-2',symbolRaw:'MRC - 510',side:'Buy',status:'Filled',quantity:'2,600',filled:'2,600',netOrdVal:'488,800'},
    {orderId:'OMP-3',symbolRaw:'MRC - 510',side:'Sell',status:'Filled',quantity:'3,500',filled:'3,500',netOrdVal:'713,712.5'},
    {orderId:'OMP-4',symbolRaw:'MRC - 510',side:'Buy',status:'Cancelled',quantity:'1,000',filled:'0',netOrdVal:null},
  ];
  await post({token:'trading',capturedAt:new Date().toISOString(),records:pos});
  const {rows:net}=await db.query(`
    select sum(case when side='BUY' then filled_quantity else -filled_quantity end)::int AS position
      from awsat_order_list where order_id like 'OMP-%'`);
  ck('O5: buys minus sells = 2,600 held', net[0].position===2600, net[0]);
  const {rows:cancelled}=await db.query(
    "select filled_quantity from awsat_order_list where order_id='OMP-4'");
  ck('a cancelled order contributes 0, not its quantity',
     Number(cancelled[0].filled_quantity)===0, cancelled[0]);

  // executions must never be zero — it multiplies the fee
  let bad=false;
  try { await db.query("update awsat_order_list set executions_observed=0 where order_id='OM-1'"); }
  catch { bad=true; }
  ck('executions_observed cannot be set to 0', bad===true);

  await clean();
  await db.query("delete from awsat_order_list where order_id like 'OMP%'");
  console.log(`\norder money: ${p}/${n}`);
  srv.close(); await db.close(); process.exit(p===n?0:1);
});

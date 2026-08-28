// The 398 rows in the screenshot, reproduced exactly, then refused.
process.env.AWSAT_MODE='client';
process.env.INGEST_TOKEN='trading';
const express=require('express');
const db=require('../../src/db/pool');
const validate=require('../../src/validate');
let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,JSON.stringify(x))};

const app=express(); app.use(express.json({limit:'8mb'}));
app.use('/', require('../../src/api/ingest').createRouter());
const srv=app.listen(8809,async()=>{
  const post=(b)=>fetch('http://127.0.0.1:8809/depth',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify(b)})
    .then(async r=>({status:r.status,body:await r.json()}));
  await db.query("delete from awsat_stock_depth where ingest_source='awsat_client'");

  // ── the exact row shape from the screenshot ──
  const screenshotRow={symbol:'HUMANSOFT',level:1,bid:0,bid_qty:0,offer:0,offer_qty:0,
    bid_orders:null,offer_orders:null,trading_date:'2026-08-25',created_at:new Date()};
  const v=validate.validateDepthLevel(screenshotRow);
  ck('the screenshot row is rejected', v.ok===false, v.reason);
  ck('reason says empty book', /empty book/.test(v.reason||''), v.reason);
  ck('isEmptyBook agrees', validate.isEmptyBook(screenshotRow)===true);

  // one real side is enough to be a book
  ck('bid only -> valid', validate.validateDepthLevel({...screenshotRow,bid:175,bid_qty:5000}).ok===true);
  ck('offer only -> valid', validate.validateDepthLevel({...screenshotRow,offer:177,offer_qty:3000}).ok===true);
  ck('quantity only -> valid', validate.validateDepthLevel({...screenshotRow,bid_qty:5000}).ok===true);

  // ── a whole batch of zeros, as the client was sending ──
  const empties=['HUMANSOFT','IFAHR','IFA','INJAZZAT','INOVEST','INTEGRATED','INVESTORS','IPG']
    .map(s=>({symbol:s,level:1,bidPrice:0,bidQty:0,offerPrice:0,offerQty:0}));
  const r=await post({token:'trading',capturedAt:new Date().toISOString(),records:empties});
  ck('batch accepted (not an error)', r.status===200, r.status);
  ck('NOTHING inserted', r.body.inserted===0, r.body);
  ck('counted as empty books, not malformed', r.body.emptyBooks===8, r.body);
  const {rows:c}=await db.query("select count(*)::int c from awsat_stock_depth where ingest_source='awsat_client'");
  ck('table stays clean', c[0].c===0, c[0]);

  // ── a real ladder still lands, with all fields ──
  const real=[
    {symbol:'ABAR',level:1,bidPrice:175,bidQty:5000,offerPrice:177,offerQty:3000},
    {symbol:'ABAR',level:2,bidPrice:174,bidQty:4000,offerPrice:178,offerQty:2500},
    {symbol:'ABAR',level:3,bidPrice:0,bidQty:0,offerPrice:0,offerQty:0},   // padding
  ];
  const r2=await post({token:'trading',capturedAt:new Date().toISOString(),records:real});
  ck('two real levels stored', r2.body.inserted===2, r2.body);
  ck('the padding level dropped', r2.body.emptyBooks===1, r2.body);
  const {rows:d}=await db.query(
    "select level,bid,bid_qty,offer,offer_qty from awsat_stock_depth where symbol='ABAR' order by level");
  ck('level 1 bid correct', Number(d[0].bid)===175, d[0]);
  ck('level 1 offer correct', Number(d[0].offer)===177, d[0]);
  ck('level 1 quantities correct', Number(d[0].bid_qty)===5000&&Number(d[0].offer_qty)===3000, d[0]);
  ck('level 2 present and distinct', Number(d[1].bid)===174, d[1]);
  ck('no zero rows survived', d.every(r=>Number(r.bid)>0||Number(r.offer)>0), d);

  await db.query("delete from awsat_stock_depth where ingest_source='awsat_client'");
  console.log(`\nempty books: ${p}/${n}`);
  srv.close(); await db.close(); process.exit(p===n?0:1);
});

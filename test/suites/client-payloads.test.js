// The EXACT payload shapes the uploaded userscripts send, verbatim.
process.env.AWSAT_MODE='client';
process.env.INGEST_TOKEN='trading';
const express=require('express');
const {createRouter}=require('../../src/api/ingest');
const db=require('../../src/db/pool');
const app=express(); app.use(express.json({limit:'8mb'})); app.use('/ingest',createRouter());
const srv=app.listen(8802,async()=>{
  let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,JSON.stringify(x))};
  // The scripts send the token in the BODY, no Authorization header.
  const post=(path,body)=>fetch('http://127.0.0.1:8802/ingest/'+path,{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    .then(async r=>({status:r.status,body:await r.json()}));

  await db.query("delete from awsat_stock_depth where ingest_source='awsat_client'");
  await db.query("delete from awsat_order_obs where order_id like 'CL-%'");
  await db.query("delete from awsat_market_quotes where ingest_source='awsat_client'");

  const capturedAt=new Date().toISOString();

  // ── DEPTH: { token, records:[{symbol,code,level,bidPrice,bidQty,offerPrice,offerQty,capturedAt}] }
  const depth=await post('depth',{token:'trading',records:[
    {symbol:'ABAR',code:'101',level:1,bidPrice:175,bidQty:5000,offerPrice:177,offerQty:3000,capturedAt},
    {symbol:'ABAR',code:'101',level:2,bidPrice:174,bidQty:4000,offerPrice:178,offerQty:2500,capturedAt},
  ],capturedAt});
  ck('depth: body token accepted', depth.status===200, depth.body);
  ck('depth: records[] accepted as levels', depth.body.inserted===2, depth.body);
  const {rows:d}=await db.query("select level,bid,bid_qty,offer,offer_qty from awsat_stock_depth where symbol='ABAR' order by level");
  ck('depth: bidPrice -> bid', d[0]&&Number(d[0].bid)===175, d[0]);
  ck('depth: offerPrice -> offer', d[0]&&Number(d[0].offer)===177, d[0]);
  ck('depth: quantities mapped', d[0]&&Number(d[0].offer_qty)===3000, d[0]);

  // ── ORDERS: { token, records:[{orderId,status,side,quantity,price,filled,remaining,symbolRaw}] }
  const ord=await post('orders',{token:'trading',capturedAt,records:[
    {orderId:'CL-1',symbolRaw:'KFIC - 227',side:'Buy',status:'FILLED',price:176.5,
     quantity:'1,000',filled:'1,000',remaining:'0',portfolio:'P1',rowIndex:1},
    {orderId:'CL-2',symbolRaw:'ABAR - 101',side:'Sell',status:'PENDING',price:177,
     quantity:'500',filled:'0',remaining:'500',portfolio:'P1',rowIndex:2},
  ]});
  ck('orders: records[] accepted', ord.status===200, ord.body);
  ck('orders: both stored', ord.body.inserted===2, ord.body);
  const {rows:o}=await db.query("select order_id,symbol,side,order_status,quantity,filled_quantity,remaining_qty from awsat_order_list where order_id like 'CL-%' order by order_id");
  ck('orders: order_id is an id', o[0]&&o[0].order_id==='CL-1', o[0]);
  ck('orders: symbolRaw -> symbol', o[0]&&o[0].symbol==='KFIC', o[0]&&o[0].symbol);
  ck('orders: side normalised', o[0].side==='BUY'&&o[1].side==='SELL', o.map(x=>x.side));
  ck('orders: "1,000" parsed', Number(o[0].quantity)===1000, o[0].quantity);
  ck('orders: remaining mapped', Number(o[1].remaining_qty)===500, o[1].remaining_qty);

  // re-post the SAME orders — must not duplicate
  await post('orders',{token:'trading',capturedAt:new Date().toISOString(),records:[
    {orderId:'CL-1',symbolRaw:'KFIC - 227',side:'Buy',status:'FILLED',price:176.5,quantity:'1,000',filled:'1,000',remaining:'0'},
  ]});
  const {rows:c}=await db.query("select count(*)::int c from awsat_order_list where order_id like 'CL-%'");
  ck('orders: re-post does not duplicate', c[0].c===2, c[0]);

  // ── QUOTES: { capturedAt, token, records:[...] }
  const q=await post('quotes',{token:'trading',capturedAt,records:[
    {market:'Premier Market',symbol:'ABAR',code:'101',last:176,chg:-2.5,pctChg:-1.4,
     volume:1240000,bid:175,bidQty:5000,offer:177,offerQty:3000},
  ]});
  ck('quotes: records[] accepted', q.status===200 && q.body.inserted===1, q.body);

  // ── a WRONG token must say what was received ──
  const bad=await post('depth',{token:'wrong',records:[]});
  ck('bad token -> 401', bad.status===401, bad.status);
  ck('401 names the mismatch', /does not match INGEST_TOKEN/.test(bad.body.error||''), bad.body);
  ck('401 hints where to look', /AUTH_TOKEN in the userscript/.test(bad.body.hint||''), bad.body.hint);

  await db.query("delete from awsat_stock_depth where ingest_source='awsat_client'");
  await db.query("delete from awsat_order_obs where order_id like 'CL-%'");
  await db.query("delete from awsat_market_quotes where ingest_source='awsat_client'");
  console.log(`\nclient payloads: ${p}/${n}`);
  srv.close(); await db.close(); process.exit(p===n?0:1);
});

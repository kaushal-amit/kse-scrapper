// Everything a browser on https://www.awsatbroker.com needs before a single
// byte of market data can arrive.
process.env.AWSAT_MODE='client';
process.env.INGEST_TOKEN='trading';
const express=require('express');
const {createRouter}=require('../../src/api/ingest');
const db=require('../../src/db/pool');
const app=express();
app.use(express.json({limit:'8mb'}));
app.use(express.text({limit:'8mb',type:['text/plain','text/*']}));
app.use('/ingest',createRouter());
const ORIGIN='https://www.awsatbroker.com';
const srv=app.listen(8803,async()=>{
  let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,JSON.stringify(x))};

  // ── the PREFLIGHT must succeed, or the POST never happens ──
  const pre=await fetch('http://127.0.0.1:8803/ingest/depth',{method:'OPTIONS',
    headers:{Origin:ORIGIN,'Access-Control-Request-Method':'POST',
             'Access-Control-Request-Headers':'content-type,authorization'}});
  ck('preflight returns 2xx', pre.status===204||pre.status===200, pre.status);
  ck('preflight is NOT 401', pre.status!==401, pre.status);
  ck('allows the origin', !!pre.headers.get('access-control-allow-origin'), pre.headers.get('access-control-allow-origin'));
  ck('allows POST', /POST/.test(pre.headers.get('access-control-allow-methods')||''));
  ck('allows Content-Type + Authorization',
     /content-type/i.test(pre.headers.get('access-control-allow-headers')||'') &&
     /authorization/i.test(pre.headers.get('access-control-allow-headers')||''));

  // ── a normal JSON POST carries the header too ──
  const j=await fetch('http://127.0.0.1:8803/ingest/depth',{method:'POST',
    headers:{'Content-Type':'application/json',Origin:ORIGIN},
    body:JSON.stringify({token:'trading',records:[
      {symbol:'CORSA',level:1,bidPrice:100,bidQty:10,offerPrice:101,offerQty:20}]})});
  const jb=await j.json();
  ck('JSON post accepted', j.status===200 && jb.inserted===1, jb);
  ck('response carries the CORS header', !!j.headers.get('access-control-allow-origin'));

  // ── text/plain: a SIMPLE request, no preflight at all ──
  const t=await fetch('http://127.0.0.1:8803/ingest/depth',{method:'POST',
    headers:{'Content-Type':'text/plain',Origin:ORIGIN},
    body:JSON.stringify({token:'trading',records:[
      {symbol:'CORSB',level:1,bidPrice:200,bidQty:10,offerPrice:201,offerQty:20}]})});
  const tb=await t.json();
  ck('text/plain body parsed as JSON', t.status===200 && tb.inserted===1, tb);

  // ── the data actually landed ──
  const {rows}=await db.query("select symbol,bid,offer from awsat_stock_depth where symbol in ('CORSA','CORSB') order by symbol");
  ck('both posts persisted', rows.length===2, rows.length);
  ck('bidPrice mapped', rows[0]&&Number(rows[0].bid)===100, rows[0]);

  // ── health is reachable without auth for the panel button ──
  const h=await fetch('http://127.0.0.1:8803/ingest/health',{headers:{Origin:ORIGIN,Authorization:'Bearer trading'}});
  ck('health reachable', h.status===200);
  ck('health has CORS header', !!h.headers.get('access-control-allow-origin'));

  await db.query("delete from awsat_stock_depth where symbol in ('CORSA','CORSB')");
  console.log(`\ncors + preflight: ${p}/${n}`);
  srv.close(); await db.close(); process.exit(p===n?0:1);
});

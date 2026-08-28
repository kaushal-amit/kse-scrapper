// A response the browser cannot READ is reported as a CORS error, whatever the
// real status was. Error paths must carry the headers too.
process.env.AWSAT_MODE='client';
process.env.INGEST_TOKEN='trading';
process.env.INGEST_BODY_LIMIT='20kb';
const express=require('express');
let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,JSON.stringify(x))};
const ORIGIN='https://www.awsatbroker.com';

// Mirrors src/index.js: CORS first, then parsers, then router, then handler.
const app=express();
const CO='*';
app.use((req,res,next)=>{res.set('Access-Control-Allow-Origin',CO);res.set('Vary','Origin');
  res.set('Access-Control-Allow-Methods','POST, GET, OPTIONS');
  res.set('Access-Control-Allow-Headers','Content-Type, Authorization, x-ingest-token');
  if(req.method==='OPTIONS') return res.status(204).end(); next();});
app.use(express.json({limit:'20kb'}));
app.use(express.text({limit:'20kb',type:['text/plain','text/*']}));
app.use('/ingest',require('../../src/api/ingest').createRouter());
app.use((err,req,res,_next)=>{
  res.set('Access-Control-Allow-Origin',CO);
  const tooBig=err.type==='entity.too.large'||err.status===413;
  res.status(tooBig?413:400).json({ok:false,error:tooBig?'payload too large':'bad body'});
});

const srv=app.listen(8804,async()=>{
  const hdr=(r)=>r.headers.get('access-control-allow-origin');

  // oversized depth batch — the case that showed up as "CORS error"
  const big=JSON.stringify({token:'trading',records:new Array(4000).fill(
    {symbol:'AAAAAAAA',level:1,bidPrice:100,bidQty:1000,offerPrice:101,offerQty:1000})});
  const r1=await fetch('http://127.0.0.1:8804/ingest/depth',{method:'POST',
    headers:{'Content-Type':'application/json',Origin:ORIGIN},body:big});
  ck('oversized payload -> 413 not a hang', r1.status===413, r1.status);
  ck('413 CARRIES the CORS header', !!hdr(r1), hdr(r1));
  ck('413 explains itself', /too large/i.test((await r1.json()).error||''));

  // malformed JSON
  const r2=await fetch('http://127.0.0.1:8804/ingest/depth',{method:'POST',
    headers:{'Content-Type':'application/json',Origin:ORIGIN},body:'{not json'});
  ck('malformed body -> 400', r2.status===400, r2.status);
  ck('400 CARRIES the CORS header', !!hdr(r2), hdr(r2));

  // 401 and 409 must carry it too, or an auth/mode problem reads as CORS
  const r3=await fetch('http://127.0.0.1:8804/ingest/depth',{method:'POST',
    headers:{'Content-Type':'application/json',Origin:ORIGIN},
    body:JSON.stringify({token:'wrong',records:[]})});
  ck('401 CARRIES the CORS header', !!hdr(r3), hdr(r3));

  // preflight before any body parsing
  const r4=await fetch('http://127.0.0.1:8804/ingest/depth',{method:'OPTIONS',
    headers:{Origin:ORIGIN,'Access-Control-Request-Method':'POST'}});
  ck('preflight 204', r4.status===204, r4.status);
  ck('preflight CARRIES the header', !!hdr(r4), hdr(r4));

  console.log(`\ncors on error paths: ${p}/${n}`);
  srv.close(); process.exit(p===n?0:1);
});

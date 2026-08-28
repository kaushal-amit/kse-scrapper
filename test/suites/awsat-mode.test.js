// AWSAT_MODE must make "both sides at once" impossible, in BOTH directions.
const { spawnSync } = require('child_process');
const path=require('path');
let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,JSON.stringify(x))};

function inMode(mode, script){
  const r=spawnSync(process.execPath,['-e',script],
    {encoding:'utf8',cwd:path.join(__dirname,'..','..'),
     env:{...process.env,AWSAT_MODE:mode},timeout:60000});
  return (r.stdout||'')+(r.stderr||'');
}

// ── server jobs blocked unless mode=server ──
const jobProbe = `
const jobs=require('./src/jobs');
jobs.run('awsat.board').then(r=>{console.log('RESULT='+r.status+'|'+(r.reason||''));process.exit(0)});`;

for (const [mode, want] of [['client','SKIPPED'],['off','SKIPPED']]) {
  const out=inMode(mode, jobProbe);
  ck(`mode=${mode}: awsat.board is ${want}`, out.includes('RESULT='+want), out.split('\n').find(l=>l.startsWith('RESULT='))); 
  ck(`mode=${mode}: reason names the mode`, /AWSAT_MODE=/.test(out));
}

// ── ingest refuses AWSAT writes unless mode=client ──
const apiProbe = `
const express=require('express');
const {createRouter}=require('./src/api/ingest');
const app=express(); app.use(express.json()); app.use('/ingest',createRouter());
const s=app.listen(8801,async()=>{
  const T=process.env.INGEST_TOKEN;
  const post=(b)=>fetch('http://127.0.0.1:8801/ingest/quotes',{method:'POST',
    headers:{'Content-Type':'application/json',Authorization:'Bearer '+T},body:JSON.stringify(b)})
    .then(async r=>({status:r.status,body:await r.json()}));
  const r=await post({capturedAt:new Date().toISOString(),records:[]});
  console.log('API='+r.status+'|'+(r.body.mode||''));
  const h=await fetch('http://127.0.0.1:8801/ingest/health',{headers:{Authorization:'Bearer '+T}}).then(x=>x.json());
  console.log('HEALTH='+h.awsatMode+'|'+h.acceptingClientData);
  s.close(); process.exit(0);
});`;

for (const [mode, want] of [['server','409'],['off','409'],['client','200']]) {
  const out=inMode(mode, apiProbe);
  ck(`mode=${mode}: ingest returns ${want}`, out.includes('API='+want), out.split('\n').find(l=>l.startsWith('API=')));
  ck(`mode=${mode}: health reports the mode`, out.includes('HEALTH='+mode), out.split('\n').find(l=>l.startsWith('HEALTH=')));
}

// ── the contradictory state is unrepresentable ──
const bad=spawnSync(process.execPath,['-e',"require('./src/config')"],
  {encoding:'utf8',cwd:path.join(__dirname,'..','..'),env:{...process.env,AWSAT_MODE:'both'}});
ck('AWSAT_MODE=both is rejected outright', /must be server, client or off/.test(bad.stdout+bad.stderr));

console.log(`\nawsat mode: ${p}/${n}`);
process.exit(p===n?0:1);

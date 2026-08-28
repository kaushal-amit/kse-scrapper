process.env.AWSAT_MODE='client';
process.env.NOTIFY_URL='http://127.0.0.1:8811/hook';
process.env.NOTIFY_MIN_GAP_MS='60000';
const express=require('express');
const notify=require('../../src/notify');
const scorer=require('../../src/jobs/scoreSignals');
const db=require('../../src/db/pool');
let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,JSON.stringify(x))};

const received=[];
const app=express(); app.use(express.json());
app.post('/hook',(req,res)=>{received.push(req.body);res.json({ok:true});});
app.post('/bad',(req,res)=>res.status(500).end());
const srv=app.listen(8811,async()=>{
  // ── delivery ──
  const s1={symbol:'ABAR',signal:'NO_PROTECTION',detail:'bid 15,000 < 20,000',last_price:176};
  ck('a signal is pushed', (await notify.push(s1)).sent===true);
  ck('the phone gets readable text',
     received[0].text==='ABAR @ 176 — NO_PROTECTION: bid 15,000 < 20,000', received[0].text);
  ck('and the structured fields', received[0].symbol==='ABAR'&&received[0].signal==='NO_PROTECTION');

  // ── throttling: the loop runs every 15-20s ──
  const again=await notify.push(s1);
  ck('the SAME signal is throttled', again.sent===false&&again.reason==='throttled', again);
  ck('nothing extra was delivered', received.length===1, received.length);
  const other=await notify.push({...s1,signal:'BID_EMPTY',detail:'50 shares'});
  ck('a DIFFERENT signal on the same symbol still goes', other.sent===true);
  const otherSym=await notify.push({...s1,symbol:'ZAIN'});
  ck('the same signal on a different symbol still goes', otherSym.sent===true);

  // ── failure must not throw ──
  process.env.NOTIFY_URL='http://127.0.0.1:8811/bad';
  delete require.cache[require.resolve('../../src/notify')];
  const n2=require('../../src/notify');
  const bad=await n2.push({symbol:'X',signal:'FROZEN',detail:'d'});
  ck('a 500 is reported, not thrown', bad.sent===false&&/500/.test(bad.reason), bad);
  process.env.NOTIFY_URL='';
  delete require.cache[require.resolve('../../src/notify')];
  const off=require('../../src/notify');
  ck('no URL -> disabled, not an error',
     (await off.push({symbol:'X',signal:'FROZEN'})).reason==='NOTIFY_URL not set');

  // ── nightly scoring ──
  const day='1993-06-06';
  await db.query('delete from signal_log where trading_date=$1',[day]);
  await db.query('delete from symbol_minute where trading_date=$1',[day]);
  const t0=new Date('1993-06-06T09:00:00Z');
  const at=(m)=>new Date(t0.getTime()+m*60000);
  for(const [m,px] of [[0,176],[5,180],[15,185]])
    await db.query(`insert into symbol_minute(symbol,trading_date,ts,last_price)
      values ('SCA',$1,$2,$3)`,[day,at(m),px]);
  for(const [m,px] of [[0,176],[5,172],[15,170]])
    await db.query(`insert into symbol_minute(symbol,trading_date,ts,last_price)
      values ('SCB',$1,$2,$3)`,[day,at(m),px]);

  const fire=(sym,sig)=>db.query(
    `insert into signal_log(symbol,trading_date,fired_at,signal,price)
     values ($1,$2,$3,$4,176)`,[sym,day,t0,sig]);
  await fire('SCA','BUYERS_8_5');       // expects a rise; price rose  -> right
  await fire('SCB','BUYERS_8_5');       // expects a rise; price fell  -> wrong
  await fire('SCB','NO_PROTECTION');    // a WARNING; price fell       -> right
  await fire('SCA','NO_PROTECTION');    // a warning; price rose       -> wrong
  await fire('SCA','FROZEN');           // no directional claim        -> NULL

  const r=await scorer.score(day,null);
  ck('five signals processed', r.extracted===5, r);

  const got=async(sym,sig)=>(await db.query(
    'select px_5min,px_15min,px_60min,was_right,scored_at from signal_log where symbol=$1 and signal=$2 and trading_date=$3',
    [sym,sig,day])).rows[0];

  const a=await got('SCA','BUYERS_8_5');
  ck('px_5min from the first capture AT or after +5', Number(a.px_5min)===180, a.px_5min);
  ck('px_15min likewise', Number(a.px_15min)===185, a.px_15min);
  ck('a rise signal that rose is right', a.was_right===true, a);

  ck('a rise signal that FELL is wrong', (await got('SCB','BUYERS_8_5')).was_right===false);
  ck('a WARNING that preceded a fall is RIGHT',
     (await got('SCB','NO_PROTECTION')).was_right===true);
  ck('a warning that preceded a rise is wrong',
     (await got('SCA','NO_PROTECTION')).was_right===false);
  ck('FROZEN claims no direction -> NULL, not false',
     (await got('SCA','FROZEN')).was_right===null);
  ck('but it IS marked scored, so it is not retried nightly',
     (await got('SCA','FROZEN')).scored_at!==null);

  const r2=await scorer.score(day,null);
  ck('a second run finds nothing unscored', r2.extracted===0, r2);

  await db.query('delete from signal_log where trading_date=$1',[day]);
  await db.query('delete from symbol_minute where trading_date=$1',[day]);
  console.log(`\nnotify + scoring: ${p}/${n}`);
  srv.close(); await db.close(); process.exit(p===n?0:1);
});

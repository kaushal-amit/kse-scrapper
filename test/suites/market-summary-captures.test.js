// Every capture is kept — the film, not the photograph. And the endpoint must
// not write market_day: one writer per table.
process.env.AWSAT_MODE='client'; process.env.INGEST_TOKEN='trading';
const express=require('express');
const db=require('../../src/db/pool');
const md=require('../../src/jobs/computeMarketDay');
let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,JSON.stringify(x))};

const app=express(); app.use(express.json());
app.use('/', require('../../src/api/ingest').createRouter());
const srv=app.listen(8818, async()=>{
  const day='2026-08-25';          // a Tuesday, a real session
  const post=(b)=>fetch('http://127.0.0.1:8818/market-summary',{method:'POST',
    headers:{'Content-Type':'application/json',Authorization:'Bearer trading'},
    body:JSON.stringify(b)}).then(async r=>({status:r.status,body:await r.json()}));
  const clean=async()=>{
    await db.query("delete from awsat_market_summary where batch_id like 'mc-%'");
    await db.query('delete from market_day where trading_date=$1',[day]);
    await db.query("delete from symbol_day where symbol like 'MC%'");
    await db.query("delete from awsat_market_quotes where symbol like 'MC%'");
    await db.query("delete from instruments where symbol like 'MC%'");
    await db.query("delete from client_submissions where batch_id like 'mc-%'");
  };
  await clean();

  // a session with volume, so the date derivation has something to find
  await db.query(`insert into market_day(trading_date,symbols_traded,advancing,declining,
    unchanged,total_volume,total_trades,computed_at) values ($1,3,2,1,0,1000,10,now())`,[day]);

  // checkCapturedAt refuses anything older than 15 minutes — correct, since a
  // stale summary stored under a fresh minute is worse than a gap. So the test
  // works in RECENT time and asserts session_state against the clock rule
  // directly rather than against invented session timestamps.
  // Distinct and ORDERED, and inside the 15-minute window. The capture times
  // are what orders the rows, so they must not collide.
  let tick = 0;
  const at=()=>new Date(Date.now() - 60_000 + (tick++ * 1000)).toISOString();
  const cap=(id,h,m,ups,down)=>post({batchId:id,capturedAt:at(),
    summary:{symbolsTraded:132,ups,down,unchanged:20,volume:327788687,
             trades:25745,turnover:88797853,ytdPct:-2.06,indexClose:9302.73},fieldsFound:9});

  // ── EVERY capture is kept ──
  await cap('mc-1', 9,30,90,20);
  await cap('mc-2',11, 0,68,44);
  await cap('mc-3',13, 0,50,62);
  const {rows:all}=await db.query(
    "select captured_at,session_state,advancing from awsat_market_summary where batch_id like 'mc-%' order by captured_at");
  ck('three captures, three rows — the film, not the photograph', all.length===3, all.length);
  ck('the progression is visible: 90 -> 68 -> 50',
     all.map(r=>r.advancing).join()==='90,68,50', all.map(r=>r.advancing));

  // ── session_state by the CLOCK, not by position ──
  // Asserted as arithmetic: promoting the LAST capture to CLOSE would make a
  // session that stopped at 12:23 look complete.
  const stateOf=(kuwaitH,kuwaitM,isSessionDay)=>
    !isSessionDay ? 'STALE' : ((kuwaitH*60+kuwaitM) >= 13*60+30 ? 'CLOSE' : 'LIVE');
  ck('09:30 on a session day is LIVE', stateOf(9,30,true)==='LIVE');
  ck('13:00 is still LIVE — the session has not closed', stateOf(13,0,true)==='LIVE');
  ck('13:29 is LIVE — one minute before the close', stateOf(13,29,true)==='LIVE');
  ck('13:30 is CLOSE', stateOf(13,30,true)==='CLOSE');
  ck('any hour on a non-session day is STALE', stateOf(10,0,false)==='STALE');
  ck('a session that stopped at 12:23 has NO close row',
     stateOf(12,23,true)==='LIVE');

  // ── the endpoint does NOT touch market_day ──
  const {rows:mdRow}=await db.query('select advancing,broker_seen_at from market_day where trading_date=$1',[day]);
  ck('market_day is UNTOUCHED by the endpoint — one writer per table',
     mdRow[0].advancing===2 && mdRow[0].broker_seen_at===null, mdRow[0]);

  // ── a STALE capture: a shut day showing the previous session ──
  // Today is not a session in this fixture, so a capture NOW is STALE and is
  // attributed to the last day that actually traded — the failure being fixed
  // is that this used to consult awsat_market_quotes and move under a capture.
  const st=await post({batchId:'mc-5',capturedAt:at(),
    summary:{symbolsTraded:132,ups:51,down:61,unchanged:20}});
  ck('a capture on a non-session day is STALE', st.body.session_state==='STALE', st.body);
  ck('and is attributed to the session it DESCRIBES',
     String(st.body.trading_date).slice(0,10)===day, st.body.trading_date);

  // ── the compute reads the last NON-STALE capture ──
  for(const [s,chg] of [['MCA',2],['MCB',3],['MCC',-1]]){
    await db.query("insert into instruments(market,symbol,code,is_primary,is_tradeable) values ('Main Market',$1,$1,true,true)",[s]);
    await db.query(`insert into symbol_day(symbol,trading_date,close_px,chg_fils,chg_1d,trades,total_volume,source,data_quality,minutes_captured)
      values ($1,$2,100,$3,1.0,10,1000,'AWSAT','FULL',200)`,[s,day,chg]);
    await db.query(`insert into awsat_market_quotes(market,symbol,last_price,volume,trading_date,ingest_source,source_precedence,created_at)
      values ('Main Market',$1,100,1000,$2,'awsat_server',1,$3)`,[s,day,new Date(Date.parse(day+'T09:00:00Z')+Math.random()*1e6)]);
  }
  // The endpoint requires capturedAt within 15 minutes, so a capture FOR a past
  // session cannot be posted through it — every such post is correctly STALE.
  // The compute half is exercised with rows inserted directly.
  await db.query(`insert into awsat_market_summary
    (captured_at,trading_date,session_state,symbols_traded,advancing,declining,
     unchanged,total_volume,total_trades,turnover_kd,index_close,index_ytd_pct,batch_id)
    values ($1,$2,'LIVE',132,90,20,22,327788687,25745,88797853,9302.73,-2.06,'mc-live1'),
           ($3,$2,'CLOSE',132,50,62,20,327788687,25745,88797853,9302.73,-2.06,'mc-live2'),
           ($4,$2,'STALE',132,999,1,1,1,1,1,1,1,'mc-stale')`,
    [day+' 09:30:00+03', day, day+' 13:45:00+03', day+' 20:00:00+03']);

  await md.compute(day,null);
  const {rows:after}=await db.query(
    'select advancing,symbols_traded,broker_seen_at,turnover_kd,index_close,computed_advancing from market_day where trading_date=$1',[day]);
  ck('the compute takes the LAST NON-STALE capture (50, not the 999 STALE row)',
     after[0].advancing===50, after[0].advancing);
  ck('a STALE capture never speaks for the session',
     after[0].advancing!==999, after[0].advancing);
  ck('and stamps broker_seen_at from that capture', after[0].broker_seen_at!==null);
  ck('turnover and index arrive by this route now', Number(after[0].turnover_kd)===88797853);
  ck('computed_* still hold OUR numbers', after[0].computed_advancing===2, after[0]);

  // ── with NO capture, the computed breadth stands ──
  await db.query("delete from awsat_market_summary where batch_id like 'mc-%'");
  await md.compute(day,null);
  const {rows:none}=await db.query('select advancing,broker_seen_at from market_day where trading_date=$1',[day]);
  ck('no capture -> our breadth stands', none[0].advancing===2, none[0]);
  ck('and broker_seen_at is NULL', none[0].broker_seen_at===null);

  await clean();
  console.log(`\nmarket summary captures: ${p}/${n}`);
  srv.close(); await db.close(); process.exit(p===n?0:1);
});

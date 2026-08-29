// isSessionDay compared String(Date) to an ISO day and could NEVER match, so
// every capture filed as STALE — and daily.marketday skips STALE.
process.env.AWSAT_MODE='client'; process.env.INGEST_TOKEN='trading';
const express=require('express');
const db=require('../../src/db/pool');
let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,JSON.stringify(x))};

// The shape of the bug, in isolation.
const d=new Date('2026-08-29T00:00:00Z');
ck('String(Date).slice(0,10) is "Fri Aug 2" — it can never equal an ISO day',
   String(d).slice(0,10)!=='2026-08-29', String(d).slice(0,10));

const app=express(); app.use(express.json());
app.use('/', require('../../src/api/ingest').createRouter());
const srv=app.listen(8820, async()=>{
  const post=(b)=>fetch('http://127.0.0.1:8820/market-summary',{method:'POST',
    headers:{'Content-Type':'application/json',Authorization:'Bearer trading'},
    body:JSON.stringify(b)}).then(async r=>({status:r.status,body:await r.json()}));
  const clean=async()=>{
    await db.query("delete from awsat_market_summary where batch_id like 'ss-%'");
    await db.query("delete from awsat_market_quotes where symbol like 'SS%'");
    await db.query("delete from market_day where trading_date >= current_date - 3");
    await db.query("delete from client_submissions where batch_id like 'ss-%'");
  };
  await clean();

  const sum={symbolsTraded:132,ups:51,down:61,unchanged:20,volume:1,trades:1};

  // ── TODAY is a session: quotes exist and market_day has a row with volume ──
  await db.query(`insert into awsat_market_quotes(market,symbol,last_price,volume,trading_date,ingest_source,source_precedence,created_at)
    values ('Main Market','SSA',100,1000,current_date,'awsat_server',1,now())`);
  await db.query(`insert into market_day(trading_date,symbols_traded,advancing,declining,
    unchanged,total_volume,total_trades,computed_at) values (current_date,1,1,0,0,1000,10,now())`);

  const live=await post({batchId:'ss-1',capturedAt:new Date().toISOString(),summary:sum});
  ck('a capture on a SESSION DAY is not STALE', live.body.session_state!=='STALE', live.body);
  ck('it is LIVE or CLOSE depending on the clock',
     ['LIVE','CLOSE'].includes(live.body.session_state), live.body.session_state);

  // ── and it is attributed to today, not to a previous session ──
  const {rows:r1}=await db.query(
    "select trading_date::text=current_date::text as is_today from awsat_market_summary where batch_id='ss-1'");
  ck('attributed to today', r1[0].is_today===true, r1[0]);

  // ── with NO session today, the same capture is STALE ──
  await db.query("delete from market_day where trading_date = current_date");
  await db.query("delete from awsat_market_quotes where symbol='SSA'");
  await db.query(`insert into awsat_market_quotes(market,symbol,last_price,volume,trading_date,ingest_source,source_precedence,created_at)
    values ('Main Market','SSB',100,1000,current_date - 2,'awsat_server',1,now() - interval '2 days')`);
  await db.query(`insert into market_day(trading_date,symbols_traded,advancing,declining,
    unchanged,total_volume,total_trades,computed_at) values (current_date - 2,1,1,0,0,1000,10,now())`);

  const stale=await post({batchId:'ss-2',capturedAt:new Date().toISOString(),summary:sum});
  ck('with no session today the capture IS stale', stale.body.session_state==='STALE', stale.body);
  const {rows:r2}=await db.query(
    "select trading_date::text=(current_date-2)::text as is_prev from awsat_market_summary where batch_id='ss-2'");
  ck('and describes the last day that TRADED', r2[0].is_prev===true, r2[0]);

  // ── daily.marketday refuses a day with no quotes ──
  const md=require('../../src/jobs/computeMarketDay');
  let refused=false;
  try{ await md.compute('1999-01-04', null); }
  catch(e){ refused=/was not a session/.test(e.message); }
  ck('the compute REFUSES a day with no quotes', refused===true);

  const {rows:none}=await db.query("select count(*)::int c from market_day where trading_date='1999-01-04'");
  ck('and writes nothing', none[0].c===0, none[0]);

  await clean();
  console.log(`\nsession state: ${p}/${n}`);
  srv.close(); await db.close(); process.exit(p===n?0:1);
});

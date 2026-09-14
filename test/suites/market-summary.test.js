// The broker's own count must survive a backfill. Overwriting it would look
// exactly like a working system.
process.env.AWSAT_MODE='client'; process.env.INGEST_TOKEN='trading';
const express=require('express');
const db=require('../../src/db/pool');
const md=require('../../src/jobs/computeMarketDay');
const clock=require('../../src/market/clock');
let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,JSON.stringify(x))};

const app=express(); app.use(express.json());
app.use('/', require('../../src/api/ingest').createRouter());
const srv=app.listen(8817, async()=>{
  /*
   * F-08 · THE DAY IS DERIVED, NOT WRITTEN DOWN.
   *
   * It was a hardcoded '2026-08-25' while every post carries
   * `capturedAt: new Date()`. ingest.js derives session_state from whether the
   * capture's own day IS the day it describes:
   *
   *     const sessionState = !isSessionDay ? 'STALE' : ...
   *
   * and computeMarketDay reads only the last NON-STALE capture of a session. So
   * from 26 August onward every capture in this suite was marked STALE, every
   * broker figure was excluded, and twelve checks failed — the whole
   * broker-overwrite path, which decides whether market_day.pct_advancing is
   * the broker's authoritative count or our reconstruction, and therefore the
   * regime.
   *
   * It passed on the day it was written and has failed every day since, without
   * appearing on any known-reds list. The path had no working coverage for
   * three weeks.
   *
   * Today's trading day, so the capture is of the session it describes — which
   * is the case the product is built for.
   */
  const day=clock.tradingDay();
  const post=(b)=>fetch('http://127.0.0.1:8817/market-summary',{method:'POST',
    headers:{'Content-Type':'application/json',Authorization:'Bearer trading'},
    body:JSON.stringify(b)}).then(async r=>({status:r.status,body:await r.json()}));
  const md_=async()=>(await db.query('select * from market_day where trading_date=$1',[day])).rows[0];
  /*
   * F-08 · the clean-up has to clear EVERYTHING keyed on the day, now that the
   * day is today's.
   *
   * With a hardcoded past date the fixture owned that day outright. Today's is
   * shared: this suite's own previous run leaves an awsat_market_summary
   * capture and a market_day row behind, and other suites seed symbol_day for
   * today. The first assertion — "our compute writes breadth, 2 up 1 down" —
   * then sees 134 symbols and a broker_seen_at already stamped, and reads as a
   * product defect when it is a dirty fixture.
   */
  const clean=async()=>{
    await db.query('delete from market_day where trading_date=$1',[day]);
    await db.query('delete from awsat_market_summary where trading_date=$1',[day]);
    await db.query("delete from symbol_day where trading_date=$1",[day]);
    await db.query("delete from awsat_market_quotes where trading_date=$1",[day]);
    await db.query("delete from instruments where symbol like 'MS%'");
    await db.query("delete from client_submissions where kind='market-summary'");
  };
  await clean();

  // OUR data: 3 symbols, 2 up 1 down = 66.7%
  for(const [s,chg] of [['MSA',2],['MSB',3],['MSC',-1]]){
    await db.query("insert into instruments(market,symbol,code,is_primary,is_tradeable) values ('Main Market',$1,$1,true,true)",[s]);
    await db.query(`insert into symbol_day(symbol,trading_date,close_px,chg_fils,chg_1d,trades,total_volume,source,data_quality,minutes_captured)
      values ($1,$2,100,$3,1.0,10,1000,'AWSAT','FULL',200)`,[s,day,chg]);
    await db.query(`insert into awsat_market_quotes(market,symbol,last_price,volume,trading_date,ingest_source,source_precedence,created_at)
      values ('Main Market',$1,100,1000,$2,'awsat_server',1,$3)`,[s,day,new Date(Date.parse(day+'T09:00:00Z')+Math.random()*1e6)]);
  }

  // ── compute first, no broker ──
  await md.compute(day,null);
  let r=await md_();
  ck('our compute writes breadth', r.advancing===2&&r.declining===1, r);
  ck('computed_* mirror it when no broker exists',
     r.computed_advancing===2&&r.computed_symbols===3, r);
  ck('broker_seen_at is NULL', r.broker_seen_at===null);

  // ── the broker speaks: 132/51/61/20 ──
  const res=await post({batchId:'ms-1',capturedAt:new Date().toISOString(),source:'awsat_client',
    summary:{volume:327788687,turnover:88797853,trades:25745,ytdPct:-2.06,
             symbolsTraded:132,ups:51,down:61,unchanged:20,indexClose:9302.73},fieldsFound:9});
  ck('the endpoint accepts it', res.status===200&&res.body.ok, res.body);
  ck('and stores it as a LIVE capture of today, not STALE',
     res.body.session_state!=='STALE', res.body);

  /*
   * F-08 · the ENDPOINT does not write market_day — ONE WRITER PER TABLE.
   *
   * ingest.js says so in as many words: "market_day is NOT written here.
   * daily.marketday reads the last non-STALE capture of the session." This
   * suite predates that rule and asserted the overwrite immediately after the
   * POST, so once the rule arrived the assertion was testing something the
   * design had deliberately stopped doing.
   *
   * The compute is the writer, so the compute is what has to run.
   */
  await md.compute(day,null);
  r=await md_();
  ck('the broker OVERWRITES breadth', r.advancing===51&&r.declining===61&&r.symbols_traded===132, r);
  ck('broker_seen_at is stamped', r.broker_seen_at!==null);
  ck('turnover stored', Number(r.turnover_kd)===88797853, r.turnover_kd);
  ck('index close stored', Number(r.index_close)===9302.73, r.index_close);
  ck('ytd stored', Number(r.index_ytd_pct)===-2.06, r.index_ytd_pct);
  ck('pct_advancing recomputed from THEIR breadth: 51/132 = 38.64',
     Math.abs(Number(r.pct_advancing)-38.6364)<0.01, r.pct_advancing);
  ck('regime follows the authoritative count', r.regime==='NEUTRAL', r.regime);
  ck('but computed_* still hold OUR numbers',
     r.computed_advancing===2&&r.computed_symbols===3, r);

  // ── THE TEST THAT MATTERS: a backfill AFTER the capture ──
  await md.compute(day,null);
  r=await md_();
  ck('THE BACKFILL DOES NOT OVERWRITE the broker breadth',
     r.advancing===51&&r.declining===61&&r.symbols_traded===132, r);
  ck('and pct_advancing still reflects the broker', Math.abs(Number(r.pct_advancing)-38.6364)<0.01, r.pct_advancing);
  ck('broker_seen_at survives', r.broker_seen_at!==null);
  ck('computed_* are refreshed by the run', r.computed_advancing===2, r);
  ck('the rolling windows still recompute', r.breadth_5d_avg!==undefined);

  // ── idempotency ──
  const dup=await post({batchId:'ms-1',capturedAt:new Date().toISOString(),
    summary:{symbolsTraded:999,ups:999,down:1,unchanged:1}});
  ck('a repeated batchId is replayed, not re-applied', dup.body.duplicate===true, dup.body);
  r=await md_();
  ck('and the stored breadth is untouched', r.advancing===51, r.advancing);

  // ── an all-null summary is refused permanently ──
  const bad=await post({batchId:'ms-2',capturedAt:new Date().toISOString(),
    summary:{volume:null,ups:null,down:null,symbolsTraded:null}});
  ck('an all-null summary is a 400, so the client stops retrying', bad.status===400, bad);

  // ── last capture wins, one row per day ──
  await post({batchId:'ms-3',capturedAt:new Date().toISOString(),
    summary:{symbolsTraded:134,ups:70,down:50,unchanged:14}});
  const {rows:cnt}=await db.query('select count(*)::int c from market_day where trading_date=$1',[day]);
  ck('still ONE row for the day', cnt[0].c===1, cnt[0]);
  // Same reason as above: the compute is the writer, so a newer capture reaches
  // market_day when the compute next runs — not at the moment it is posted.
  await md.compute(day,null);
  r=await md_();
  ck('the LAST capture wins', r.advancing===70&&r.symbols_traded===134, r);

  await clean();
  console.log(`\nmarket summary: ${p}/${n}`);
  srv.close(); await db.close(); process.exit(p===n?0:1);
});

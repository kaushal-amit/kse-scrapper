// The writer must run INSIDE fastLoop, and an inert loop must announce itself.
process.env.AWSAT_MODE='client';
const db=require('../../src/db/pool');
const jobs=require('../../src/jobs');
const clock=require('../../src/market/clock');
let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,JSON.stringify(x))};
(async()=>{
  const day=clock.tradingDay();
  const clean=async()=>{
    for(const t of ['symbol_minute','signal_log','depth_watchlist','awsat_market_quotes','awsat_stock_depth'])
      await db.query(`delete from ${t} where trading_date=$1`,[day]).catch(()=>{});
  };
  await clean();

  // ── no slots: the loop reports rather than silently doing nothing ──
  const r0=await jobs.run('signals.fast');
  ck('no slots -> extracted 0', r0.extracted===0, r0);

  // ── give it a slot and ONE observation ──
  await db.query(`insert into depth_watchlist(trading_date,slot_no,symbol,slot_type,assigned_by)
    values ($1,1,'FLMRC','PRE_DAY','TEST')`,[day]);
  const at=(s)=>new Date(Date.now()-(60-s)*1000);
  const quote=(px,vol,t)=>db.query(
    `insert into awsat_market_quotes(market,symbol,last_price,last_qty,bid,bid_qty,offer,offer_qty,
       volume,trades,session,trading_date,ingest_source,source_precedence,created_at)
     values ('Main Market','FLMRC',$1,100,$2,150000,$3,90000,$4,10,'Trading',$5,'awsat_server',1,$6)`,
    [px,px-1,px+1,vol,day,t]);

  await quote(200,1000,at(0));
  const r1=await jobs.run('signals.fast');
  ck('one observation -> one snapshot written', r1.extracted===1, r1);
  const {rows:sm1}=await db.query("select count(*)::int c from symbol_minute where symbol='FLMRC'");
  ck('THE WRITER RAN — symbol_minute is no longer empty', sm1[0].c===1, sm1[0]);
  ck('nothing fired yet — one row cannot be compared', r1.inserted===0, r1);

  // ── a second, CHANGED observation ──
  await quote(198,1050,at(20));
  const r2=await jobs.run('signals.fast');
  const {rows:sm2}=await db.query("select count(*)::int c from symbol_minute where symbol='FLMRC'");
  ck('a changed observation writes a second row', sm2[0].c===2, sm2[0]);
  ck('extracted is the SNAPSHOT count, not symbols watched', r2.extracted===2, r2);

  // ── unchanged: no new row ──
  const r3=await jobs.run('signals.fast');
  const {rows:sm3}=await db.query("select count(*)::int c from symbol_minute where symbol='FLMRC'");
  ck('an unchanged observation writes NO new row', sm3[0].c===2, sm3[0]);
  ck('one row per changed observation, not per tick', r3.extracted===2, r3);

  // ── the derived columns actually computed ──
  const {rows:d}=await db.query(
    "select bid_qty,offer_qty,buyers_per_seller,bid_age_secs,volume_delta,is_frozen from symbol_minute where symbol='FLMRC' order by ts desc limit 1");
  ck('buyers_per_seller derived', Number(d[0].buyers_per_seller)>0, d[0]);
  ck('bid_age_secs derived', d[0].bid_age_secs!==null, d[0]);
  ck('volume_delta derived', Number(d[0].volume_delta)===50, d[0]);

  // ── a signal fires: bid 150k vs offer 90k with the price rising ──
  await db.query("delete from symbol_minute where symbol='FLMRC'");
  await db.query("delete from awsat_market_quotes where symbol='FLMRC'");
  await quote(200,1000,at(0));
  await jobs.run('signals.fast');
  await quote(201,1100,at(20));
  const r4=await jobs.run('signals.fast');
  const {rows:sig}=await db.query(
    "select signal,slot from signal_log where symbol='FLMRC' and trading_date=$1",[day]);
  ck('BUYERS 8:5 fires — ratio 1.67 with the price rising',
     sig.some(s=>s.signal==='BUYERS_8_5'), sig);
  ck('the slot number is recorded', sig.length&&sig[0].slot===1, sig[0]);
  ck('inserted counts the signals', r4.inserted>=1, r4);

  // ── extracted 0 vs extracted 8 are different failures ──
  await db.query("delete from symbol_minute where symbol='FLMRC'");
  await db.query("delete from awsat_market_quotes where symbol='FLMRC'");
  const r5=await jobs.run('signals.fast');
  ck('writer produced nothing -> extracted 0, the "broken" signature',
     r5.extracted===0 && r5.inserted===0, r5);

  await clean();
  console.log(`\nfastloop wiring: ${p}/${n}`);
  await db.close(); process.exit(p===n?0:1);
})().catch(async e=>{console.error('CRASH:',e.message);await db.close();process.exit(1)});

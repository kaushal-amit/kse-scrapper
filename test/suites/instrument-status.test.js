// The nightly status rules. The DELISTED re-quote flip is the one that must
// fire from the NIGHTLY side and stay silent from the INGEST side.
process.env.AWSAT_MODE='client'; process.env.INGEST_TOKEN='trading';
const express=require('express');
const db=require('../../src/db/pool');
const job=require('../../src/jobs/refreshInstruments');
const clock=require('../../src/market/clock');
let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,JSON.stringify(x))};

const app=express(); app.use(express.json());
app.use('/', require('../../src/api/ingest').createRouter());
const srv=app.listen(8815, async()=>{
  const day=clock.tradingDay();
  const st=async(s)=>(await db.query(
    'select market,market_changed_on,broker_status,broker_status_on,tv_status,is_primary,is_tradeable from instruments where symbol=$1',[s])).rows[0];
  const clean=async()=>{
    await db.query("delete from awsat_market_quotes where symbol like 'IS%'");
    await db.query("delete from tradingview_watchlist where symbol like 'IS%'");
    await db.query("delete from instruments where symbol like 'IS%'");
  };
  await clean();

  const q=(sym,d,mkt='Main Market',px=100)=>db.query(
    `insert into awsat_market_quotes(market,symbol,last_price,volume,trading_date,ingest_source,source_precedence,created_at)
     values ($1,$2,$3,1000,$4,'awsat_server',1,$5)`,
    [mkt,sym,px,d,new Date(Date.parse(d+'T09:00:00Z')+Math.random()*1e6)]);

  for(const s of ['ISLIVE','ISGONE','ISDEAD','ISMOVE','ISAUC'])
    await db.query("insert into instruments(market,symbol,code,is_primary) values ('Main Market',$1,$1,true)",[s]);
  await db.query("update instruments set market='Auction Market' where symbol='ISAUC'");
  await db.query("update instruments set broker_status='DELISTED', broker_status_on='2022-04-21' where symbol='ISDEAD'");

  // 6 sessions of history; ISGONE stops after the first
  const days=['2026-06-01','2026-06-02','2026-06-03','2026-06-04','2026-06-07','2026-06-08',day];
  for(const d of days){ await q('ISLIVE',d); await q('ISMOVE',d,'Premier Market'); }
  await q('ISGONE','2026-06-01');
  // Its quotes must AGREE with its market, or refreshMarkets correctly
  // overwrites it from the live feed.
  await q('ISAUC',day,'Auction Market');

  await job.refresh(null);

  // ── broker_status ──
  ck('a symbol quoting today is CAPTURED', (await st('ISLIVE')).broker_status==='CAPTURED', await st('ISLIVE'));
  ck('a symbol absent 5+ sessions is ABSENT', (await st('ISGONE')).broker_status==='ABSENT', await st('ISGONE'));
  ck('a DELISTED symbol with NO quotes stays DELISTED',
     (await st('ISDEAD')).broker_status==='DELISTED', await st('ISDEAD'));
  ck('and its date is untouched',
     new Date((await st('ISDEAD')).broker_status_on).toISOString().startsWith('2022-04-21'));

  // ── market from the live feed ──
  ck('market updates from the broker feed', (await st('ISMOVE')).market==='Premier Market', await st('ISMOVE'));
  ck('and market_changed_on is set', (await st('ISMOVE')).market_changed_on!==null);

  // ── is_tradeable, and its TWO causes ──
  ck('a live primary symbol is tradeable', (await st('ISLIVE')).is_tradeable===true);
  ck('an AUCTION symbol is not tradeable', (await st('ISAUC')).is_tradeable===false, await st('ISAUC'));
  ck('a DELISTED symbol is not tradeable', (await st('ISDEAD')).is_tradeable===false, await st('ISDEAD'));
  ck('but DELISTED keeps is_primary — history does not disappear',
     (await st('ISDEAD')).is_primary===true, await st('ISDEAD'));

  // ── THE RE-QUOTE FLIP: silent from ingest, fires once from nightly ──
  await db.query("update instruments set broker_status='DELISTED', broker_status_on='2022-04-21' where symbol='ISDEAD'");
  await fetch('http://127.0.0.1:8815/quotes',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({token:'trading',capturedAt:new Date().toISOString(),
      records:[{market:'Main Market',symbol:'ISDEAD',last:224,volume:5000}]})}).then(r=>r.json());
  ck('INGEST does NOT flip a DELISTED symbol — it would say so every poll',
     (await st('ISDEAD')).broker_status==='DELISTED', await st('ISDEAD'));

  await job.refresh(null);
  ck('the NIGHTLY job flips it to CAPTURED — once', (await st('ISDEAD')).broker_status==='CAPTURED', await st('ISDEAD'));
  ck('and it becomes tradeable again', (await st('ISDEAD')).is_tradeable===true, await st('ISDEAD'));

  // ── tv_status skipped when TradingView produced nothing ──
  await db.query('delete from tradingview_watchlist where trading_date=$1',[day]);
  const before=(await st('ISLIVE')).tv_status;
  await job.refresh(null);
  ck('no TV rows -> tv_status untouched, not 142 ABSENT statements',
     (await st('ISLIVE')).tv_status===before, {before,after:(await st('ISLIVE')).tv_status});

  await db.query(`insert into tradingview_watchlist(symbol,last_price,trading_date,created_at)
    values ('ISLIVE',100,$1,now())`,[day]);
  await job.refresh(null);
  ck('with TV rows, a present symbol is CAPTURED', (await st('ISLIVE')).tv_status==='CAPTURED');
  ck('and an absent one is ABSENT', (await st('ISGONE')).tv_status==='ABSENT', await st('ISGONE'));

  // ── idempotent ──
  const r=await job.refresh(null);
  ck('a second run changes nothing', r.inserted===0, r);

  await clean();
  console.log(`\ninstrument status: ${p}/${n}`);
  srv.close(); await db.close(); process.exit(p===n?0:1);
});

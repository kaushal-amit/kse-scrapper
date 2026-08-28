// is_tradeable must actually EXCLUDE. It was correct and inert for a week.
process.env.AWSAT_MODE='client'; process.env.INGEST_TOKEN='trading';
const express=require('express');
const db=require('../../src/db/pool');
const md=require('../../src/jobs/computeMarketDay');
const clock=require('../../src/market/clock');
let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,JSON.stringify(x))};

const app=express(); app.use(express.json());
app.use('/', require('../../src/api/ingest').createRouter());
const srv=app.listen(8816, async()=>{
  const day=clock.tradingDay();
  const clean=async()=>{
    await db.query("delete from symbol_day where symbol like 'TF%'");
    await db.query("delete from depth_watchlist where trading_date=$1",[day]);
    await db.query("delete from instruments where symbol like 'TF%'");
  };
  await clean();

  await db.query(`insert into instruments(market,symbol,code,is_primary,is_tradeable,broker_status) values
    ('Main Market','TFLIVE','1',true,true,'CAPTURED'),
    ('Main Market','TFDEAD','2',true,false,'DELISTED'),
    ('Auction Market','TFAUC','3',true,false,'CAPTURED'),
    ('Main Market','TFNEW','4',true,NULL,'CAPTURED')`);
  for(const s of ['TFLIVE','TFDEAD','TFAUC','TFNEW'])
    await db.query(`insert into symbol_day(symbol,trading_date,close_px,chg_fils,chg_1d,trades,total_volume,source,data_quality,minutes_captured)
      values ($1,$2,100,2,1.0,10,1000,'AWSAT','FULL',200)`,[s,day]);

  // ── market_day breadth ──
  const rows=await md.loadDay(day);
  const got=rows.map(r=>r.symbol).filter(s=>s.startsWith('TF')).sort();
  ck('a tradeable symbol counts', got.includes('TFLIVE'), got);
  ck('a DELISTED symbol does NOT count in breadth', !got.includes('TFDEAD'), got);
  ck('an AUCTION symbol does NOT count', !got.includes('TFAUC'), got);
  ck('an UNKNOWN symbol IS kept — a new listing has no registry row yet',
     got.includes('TFNEW'), got);
  ck('so 2 of 4 count', got.length===2, got);

  // symbol_day keeps them all — history does not disappear
  const {rows:kept}=await db.query(
    "select count(*)::int c from symbol_day where symbol like 'TF%' and trading_date=$1",[day]);
  ck('but symbol_day KEEPS all four — it is the denominator they leave',
     kept[0].c===4, kept[0]);

  // ── /depth-symbols ──
  await db.query(`insert into depth_watchlist(trading_date,slot_no,symbol,slot_type,assigned_by) values
    ($1,1,'TFLIVE','PRE_DAY','TEST'),($1,2,'TFDEAD','PRE_DAY','TEST'),($1,3,'TFAUC','PRE_DAY','TEST')`,[day]);
  const r=await fetch('http://127.0.0.1:8816/depth-symbols').then(x=>x.json());
  const served=r.symbols.map(s=>s.symbol);
  ck('a slot for a tradeable symbol is served', served.includes('TFLIVE'), served);
  ck('a slot for a DELISTED symbol is NOT served — it would waste 1 of 8',
     !served.includes('TFDEAD'), served);
  ck('a slot for an AUCTION symbol is NOT served', !served.includes('TFAUC'), served);

  await clean();
  console.log(`\ntradeable filter: ${p}/${n}`);
  srv.close(); await db.close(); process.exit(p===n?0:1);
});

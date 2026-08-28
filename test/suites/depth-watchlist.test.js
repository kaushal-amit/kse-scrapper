// depth_watchlist is the STATE; signal_log is history. They must not disagree.
process.env.AWSAT_MODE='client'; process.env.INGEST_TOKEN='trading';
const express=require('express');
const db=require('../../src/db/pool');
const wake=require('../../src/wakeup');
let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,JSON.stringify(x))};

const app=express(); app.use(express.json());
app.use('/', require('../../src/api/ingest').createRouter());
const srv=app.listen(8812, async()=>{
  const day='1995-03-03';
  const clean=async()=>{
    await db.query('delete from depth_watchlist where trading_date=$1',[day]);
    await db.query('delete from signal_log where trading_date=$1',[day]);
  };
  await clean();

  // ── seeding pre-day slots ──
  for(let i=1;i<=3;i++){
    await db.query(`insert into depth_watchlist(trading_date,slot_no,symbol,slot_type,assigned_by)
      values ($1,$2,$3,'PRE_DAY','SEED')`,[day,i,['MRC','EMIRATES','CATTL'][i-1]]);
  }
  const held=await wake.slottedSymbols(day);
  ck('3 pre-day slots held', held.length===3, held.length);
  ck('slot order is priority order', held.map(h=>h.symbol).join()==='MRC,EMIRATES,CATTL', held.map(h=>h.symbol));

  // ── a PRE_DAY symbol cannot take a wake-up slot number ──
  let bad=false;
  try{ await db.query(`insert into depth_watchlist(trading_date,slot_no,symbol,slot_type)
    values ($1,5,'X','PRE_DAY')`,[day]); }catch{ bad=true; }
  ck('PRE_DAY cannot occupy slot 5', bad===true);
  bad=false;
  try{ await db.query(`insert into depth_watchlist(trading_date,slot_no,symbol,slot_type)
    values ($1,2,'Y','WAKEUP')`,[day]); }catch{ bad=true; }
  ck('WAKEUP cannot occupy slot 2', bad===true);

  // ── one symbol, one slot ──
  bad=false;
  try{ await db.query(`insert into depth_watchlist(trading_date,slot_no,symbol,slot_type)
    values ($1,4,'MRC','WAKEUP')`,[day]); }catch{ bad=true; }
  ck('a symbol cannot hold two slots', bad===true);

  // ── a wake-up claims slot 4, INSERTED not pre-created ──
  const {rows:before}=await db.query(
    'select count(*)::int c from depth_watchlist where trading_date=$1 and slot_type=$2',[day,'WAKEUP']);
  ck('no empty WAKEUP rows exist before a claim', before[0].c===0, before[0]);

  await db.query(`insert into depth_watchlist(trading_date,slot_no,symbol,slot_type,assigned_by)
    values ($1,4,'ALFTAQA','WAKEUP','WAKEUP_SCAN')`,[day]);
  await db.query(`insert into signal_log(fired_at,trading_date,symbol,signal,slot,pace,message)
    values (now(),$1,'ALFTAQA','WAKEUP',4,12.0,'pace 12x')`,[day]);

  const held2=await wake.slottedSymbols(day);
  ck('4 slots held after the claim', held2.length===4, held2.length);
  const holders=await wake.currentHolders(day);
  ck('currentHolders reads depth_watchlist, WAKEUP only', holders.length===1, holders);
  const paces=await wake.holderPaces(day);
  ck('the pace comes from signal_log — history, not state',
     paces.get('ALFTAQA')===12, paces.get('ALFTAQA'));

  // ── eviction is recorded in BOTH ──
  await db.query(`update depth_watchlist set symbol='CATTL2', replaced='ALFTAQA', assigned_at=now()
    where trading_date=$1 and slot_no=4`,[day]);
  const {rows:ev}=await db.query(
    'select symbol,replaced from depth_watchlist where trading_date=$1 and slot_no=4',[day]);
  ck('the slot changed hands', ev[0].symbol==='CATTL2', ev[0]);
  ck('and records what it replaced', ev[0].replaced==='ALFTAQA', ev[0]);
  const {rows:hist}=await db.query(
    "select count(*)::int c from signal_log where trading_date=$1 and symbol='ALFTAQA'",[day]);
  ck('history still shows the evicted symbol fired', hist[0].c===1, hist[0]);

  // ── a released slot is not held ──
  await db.query('update depth_watchlist set released_at=now() where trading_date=$1 and slot_no=4',[day]);
  ck('a released slot drops out of the held list',
     (await wake.slottedSymbols(day)).length===3);

  // ── /depth-symbols serves the state ──
  const r=await fetch('http://127.0.0.1:8812/depth-symbols').then(x=>x.json());
  ck('endpoint reads depth_watchlist', r.source==='depth_watchlist', r.source);
  ck('it reports the pre-day / wakeup split', typeof r.pre_day==='number', r);

  await clean();
  console.log(`\ndepth watchlist: ${p}/${n}`);
  srv.close(); await db.close(); process.exit(p===n?0:1);
});

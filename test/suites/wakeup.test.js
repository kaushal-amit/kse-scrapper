// pace = trades_today / median_trades_by_this_hour_last_10d
// FIRE if pace >= 3.0 AND trades >= 20
process.env.AWSAT_MODE='client';
const wake=require('../../src/wakeup');
const db=require('../../src/db/pool');
let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,JSON.stringify(x))};
(async()=>{
  const day='1994-07-07';
  const clean=async()=>{
    await db.query("delete from awsat_market_quotes where symbol like 'WK%'");
    await db.query("delete from signal_log where trading_date=$1",[day]);
    // Slots are STATE now and live here; signal_log keeps only the history.
    await db.query("delete from depth_watchlist where trading_date=$1",[day]);
  };
  await clean();

  // history: 10 past sessions, each with `median` trades BY 10:00
  const q=(sym,d,trades,hourUTC)=>db.query(
    `insert into awsat_market_quotes(market,symbol,trades,trading_date,session,
       ingest_source,source_precedence,created_at)
     values ('Main Market',$1,$2,$3,'Trading','awsat_server',1,$4)`,
    [sym,trades,d,new Date(d+'T'+String(hourUTC).padStart(2,'0')+':30:00Z')]);

  for(let i=1;i<=10;i++){
    const d='1994-06-'+String(i+9).padStart(2,'0');
    await q('WKFAST',d,10,6);     // 10 trades by 09:30 Kuwait (06:30Z)
    await q('WKSLOW',d,100,6);
    await q('WKTINY',d,2,6);
    await q('WKNONE',d,0,6);      // baseline zero
  }
  // today, same hour
  await q('WKFAST',day,120,6);    // 120/10  = 12x, 120 trades  -> FIRES
  await q('WKSLOW',day,150,6);    // 150/100 = 1.5x            -> no
  await q('WKTINY',day,12,6);     // 12/2    = 6x but 12 trades -> no (< 20)
  await q('WKNONE',day,500,6);    // baseline 0 -> pace unknowable
  await q('WKNEW',day,999,6);     // no history at all

  const paced=await wake.computePace(day,9);
  const by=(s)=>paced.find(x=>x.symbol===s);
  ck('pace = today / median-by-this-hour', by('WKFAST').pace===12, by('WKFAST'));
  ck('a busy stock with a busy baseline is NOT 12x', by('WKSLOW').pace===1.5, by('WKSLOW'));
  ck('a zero baseline gives NULL, not infinity', by('WKNONE').pace===null, by('WKNONE'));
  ck('no history gives NULL, not a fire', by('WKNEW').pace===null, by('WKNEW'));
  ck('the baseline used 10 sessions', by('WKFAST').sessions===10, by('WKFAST').sessions);

  // ── the two firing conditions ──
  const r=await wake.scan(day,9);
  ck('only WKFAST fires', r.fired===1, {fired:r.fired,rows:r.rows.map(x=>x.symbol)});
  ck('6x on 12 trades does NOT fire — below the 20-trade floor',
     !r.rows.some(x=>x.symbol==='WKTINY'), r.rows.map(x=>x.symbol));
  ck('1.5x does not fire', !r.rows.some(x=>x.symbol==='WKSLOW'));
  ck('it took slot 4, the first wake-up slot', r.rows[0].slot===4, r.rows[0]);

  const {rows:sig}=await db.query(
    "select symbol,signal,slot,pace,message,replaced from signal_log where trading_date=$1",[day]);
  ck('a WAKEUP row was written', sig.length===1&&sig[0].signal==='WAKEUP', sig);
  ck('with the pace on it', Number(sig[0].pace)===12, sig[0].pace);
  ck('and a readable message', /12x on 120 trades/.test(sig[0].message), sig[0].message);
  ck('no replacement on a free slot', sig[0].replaced===null);

  // ── holding for the session ──
  const again=await wake.scan(day,9);
  ck('an existing holder is not re-promoted', again.promoted===0, again);

  // ── fill 4-8, then the swap rule ──
  for(const [sym,tr] of [['WKB',60],['WKC',70],['WKD',80],['WKE',90]]){
    for(let i=1;i<=10;i++) await q(sym,'1994-06-'+String(i+9).padStart(2,'0'),10,6);
    await q(sym,day,tr,6);
  }
  await wake.scan(day,9);
  const holders=await wake.currentHolders(day);
  ck('all five wake-up slots held', holders.length===5, holders.map(h=>h.slot));

  // a faster newcomer replaces the LOWEST pace
  for(let i=1;i<=10;i++) await q('WKMEGA','1994-06-'+String(i+9).padStart(2,'0'),10,6);
  await q('WKMEGA',day,300,6);        // 30x
  const swap=await wake.scan(day,9);
  ck('the newcomer is promoted', swap.promoted===1, swap.rows);
  ck('and RECORDS what it replaced', swap.rows[0].replaced!==null, swap.rows[0]);
  ck('it evicted the lowest pace (WKB at 6x)', swap.rows[0].replaced==='WKB', swap.rows[0].replaced);
  const {rows:swapRow}=await db.query(
    "select replaced,message from signal_log where symbol='WKMEGA' and trading_date=$1",[day]);
  ck('the swap is in signal_log.replaced', swapRow[0].replaced==='WKB', swapRow[0]);
  ck('and named in the message', /replaced WKB/.test(swapRow[0].message), swapRow[0].message);

  // a slower newcomer must NOT churn a slot
  for(let i=1;i<=10;i++) await q('WKMEH','1994-06-'+String(i+9).padStart(2,'0'),10,6);
  await q('WKMEH',day,35,6);          // 3.5x, below every holder
  const noSwap=await wake.scan(day,9);
  ck('a slower symbol does not evict anyone', noSwap.promoted===0, noSwap.rows);

  // ── the 8 the fast loop watches ──
  // A pre-day slot is a depth_watchlist row, not a signal_log row.
  await db.query(`insert into depth_watchlist(trading_date,slot_no,symbol,slot_type,assigned_by)
    values ($1,1,'PREDAY1','PRE_DAY','SEED')`,[day]);
  const slotted=await wake.slottedSymbols(day);
  ck('pre-day slots 1-3 sit alongside wake-ups 4-8',
     slotted.some(s=>s.slot===1) && slotted.some(s=>s.slot>=4), slotted.map(s=>s.slot));
  ck('never more than 8', slotted.length<=8, slotted.length);

  await clean();
  console.log(`\nwake-up: ${p}/${n}`);
  await db.close(); process.exit(p===n?0:1);
})().catch(async e=>{console.error('CRASH:',e.message);await db.close();process.exit(1)});

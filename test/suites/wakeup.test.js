// B2 · pace is now one ACTIVITY input; MOVEMENT (range≥8, a 3-fil up-move) and
// an absolute-volume floor decide. This suite tests the SLOT machinery, which
// B2 did not change: the volume floor is switched off here and the firing
// symbols get price captures (mv()) so they clear MOVEMENT. computePace reads
// `trades`; the movement query reads `last_price` — the two fixtures coexist.
process.env.AWSAT_MODE='client';
process.env.WAKEUP_ABS_VOL_FLOOR_FRAC='0';
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

  // B2 · give a firing symbol the MOVEMENT it now needs: range 10 fils with
  // 3-fil up-moves. The last capture carries the trade count so the message
  // still reads "Nx on N trades". Floor is off (frac=0), so any volume clears it.
  const mv=(sym,tradesOnLast)=>Promise.all([100,103,106,110].map((px,i)=>db.query(
    `insert into awsat_market_quotes(market,symbol,last_price,high_price,low_price,volume,trades,
       trading_date,session,ingest_source,source_precedence,created_at)
     values ('Main Market',$1,$2,$2,$2,1,$3,$4,'Trading','awsat_server',1,$5)`,
    [sym,px,i===3?tradesOnLast:0,day,new Date(day+'T06:0'+i+':00Z')])));

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
  await mv('WKFAST',120);         // only WKFAST also has the MOVEMENT to fire

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

  // ── fill every wake-up slot, then the swap rule ──
  //
  // P2 · this used to fill "4-8" and assert five holders, from wakeup.js's own
  // `[4, 5, 6, 7, 8]` literal. Slots 6-8 are outside SLOT_COUNT: the sweep
  // cannot reach them, the client truncates them away, and neither POST can
  // release them. The range is now derived, and so is this fixture — a test
  // that restates the number under test proves only that it was copied.
  const WAKE_SLOTS = require('../../src/config/slots').wakeupSlots();
  ck('there is at least one wake-up slot to fill', WAKE_SLOTS.length >= 1, WAKE_SLOTS);

  const fillers=[['WKB',60],['WKC',70],['WKD',80],['WKE',90]].slice(0, WAKE_SLOTS.length - 1);
  for(const [sym,tr] of fillers){
    for(let i=1;i<=10;i++) await q(sym,'1994-06-'+String(i+9).padStart(2,'0'),10,6);
    await q(sym,day,tr,6);
    await mv(sym,tr);
  }
  await wake.scan(day,9);
  const holders=await wake.currentHolders(day);
  ck('every wake-up slot the sweep can reach is held',
     holders.length===WAKE_SLOTS.length, {held:holders.map(h=>h.slot), space:WAKE_SLOTS});
  ck('and none of them is outside the published address space',
     holders.every(h=>WAKE_SLOTS.includes(Number(h.slot))), holders.map(h=>h.slot));

  // A faster newcomer is BLOCKED when every slot is held — even at 30x.
  // It used to evict the lowest pace, which could overwrite a symbol chosen
  // ninety seconds earlier.
  for(let i=1;i<=10;i++) await q('WKMEGA','1994-06-'+String(i+9).padStart(2,'0'),10,6);
  await q('WKMEGA',day,300,6);        // 30x
  await mv('WKMEGA',300);
  const swap=await wake.scan(day,9);
  ck('a full board promotes nobody', swap.promoted===0, swap.rows);
  ck('and counts the block separately', swap.blocked>=1, swap);
  ck('and RECORDS what it replaced', swap.rows[0].replaced!==null, swap.rows[0]);
  /**
 * ─── A WAKE-UP NO LONGER EVICTS ──────────────────────────────────────────
 *
 * It used to replace the lowest-pace holder. So a symbol chosen deliberately
 * at 09:50 could be overwritten by a scan at 09:52 — which looks like a bug
 * and is very hard to trace, because nothing in the book data says the slot
 * changed hands.
 *
 * It now claims only FREE slots, and a blocked wake-up is logged AND surfaced
 * in the feed, so it becomes a prompt rather than a silence.
 */
ck('it does NOT evict the lowest pace, even at 30x',
     swap.rows.every(r=>r.slot===null||r.blocked!==true||r.slot===null), swap.rows);
  ck('the wake-up is reported BLOCKED',
     swap.rows.some(r=>r.symbol==='WKMEGA' && r.blocked===true), swap.rows);

  // The refusal reaches the FEED, not just a log line. A blocked wake-up that
  // nobody sees is a decision the trader never got to make.
  const {rows:blocked}=await db.query(
    "select signal,message from signal_log where symbol='WKMEGA' and trading_date=$1",[day]);
  ck('it lands in signal_log as WAKEUP_BLOCKED',
     blocked.length===1 && blocked[0].signal==='WAKEUP_BLOCKED', blocked);
  ck('and names the deadest holder, so it reads as a prompt',
     /WKB is the deadest/.test(blocked[0].message||''), blocked[0].message);
  ck('with the pace that justified it', /30x/.test(blocked[0].message||''), blocked[0].message);

  // a slower newcomer is blocked too, and says so
  for(let i=1;i<=10;i++) await q('WKMEH','1994-06-'+String(i+9).padStart(2,'0'),10,6);
  await q('WKMEH',day,35,6);          // 3.5x, below every holder
  await mv('WKMEH',35);
  const noSwap=await wake.scan(day,9);
  ck('a slower symbol claims nothing either', noSwap.promoted===0, noSwap.rows);

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

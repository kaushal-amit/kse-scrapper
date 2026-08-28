// The two session rules, tested against the errors they exist to prevent.
process.env.AWSAT_MODE='client';
const db=require('../../src/db/pool');
let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,JSON.stringify(x))};
(async()=>{
  const clean=async()=>db.query("delete from awsat_market_quotes where symbol like 'SR%'");
  await clean();

  const q=async(sym,day,price,session,minute)=>db.query(
    `insert into awsat_market_quotes(market,symbol,last_price,trading_date,session,
       ingest_source,source_precedence,created_at)
     values ('Main Market',$1,$2,$3,$4,'awsat_server',1,$5)`,
    [sym,price,day,session,new Date(Date.parse(day+'T09:00:00Z')+minute*60000)]);

  // ── RULE 1 · the TIJARA case ──
  // Continuous trading ends at 172; the closing auction prints 176.
  await q('SRTIJARA','2026-08-13',170,'Trading',10);
  await q('SRTIJARA','2026-08-13',172,'Trading',60);
  await q('SRTIJARA','2026-08-13',174,'Trading at Last',80);
  await q('SRTIJARA','2026-08-13',176,'Close-Of-Day',90);

  const {rows:c}=await db.query("select session_close('SRTIJARA','2026-08-13') AS close");
  ck('S1: close is 176, not 172', Number(c[0].close)===176, c[0].close);

  const {rows:wrong}=await db.query(
    `select last_price from awsat_market_quotes
      where symbol='SRTIJARA' and trading_date='2026-08-13' and session='Trading'
      order by created_at desc limit 1`);
  ck("the OLD way ('Trading' only) gives 172 — the bug", Number(wrong[0].last_price)===172, wrong[0]);

  // an unlabelled print still counts: a gap in capture, not an excluded print
  await q('SRNULLSESS','2026-08-13',99,null,90);
  const {rows:ns}=await db.query("select session_close('SRNULLSESS','2026-08-13') AS close");
  ck('NULL session is included, not dropped', Number(ns[0].close)===99, ns[0].close);

  // a session that must NOT count toward the close
  await q('SRSUSP','2026-08-13',200,'Trading',10);
  await q('SRSUSP','2026-08-13',999,'Suspended',95);
  const {rows:sp}=await db.query("select session_close('SRSUSP','2026-08-13') AS close");
  ck('an unknown session is excluded', Number(sp[0].close)===200, sp[0].close);

  // ── RULE 2 · the 29-30 July gap ──
  // Data on 28 July, then nothing until 31 July.
  await q('SRGAP','2026-07-28',100,'Close-Of-Day',90);
  await q('SRGAP','2026-07-31',106,'Close-Of-Day',90);

  const {rows:pv}=await db.query("select prev_session_sym('SRGAP','2026-07-31') AS d");
  ck('prev_session finds 28 July, skipping the gap',
     new Date(pv[0].d).toISOString().startsWith('2026-07-28'), pv[0].d);

  const {rows:naive}=await db.query("select date '2026-07-31' - 1 AS d");
  ck("date - 1 lands on 30 July, which has NO data",
     new Date(naive[0].d).toISOString().startsWith('2026-07-30'), naive[0].d);

  // the 6-fil error the naive version produced
  const {rows:chg}=await db.query(`
    select session_close('SRGAP','2026-07-31')
         - session_close('SRGAP', prev_session_sym('SRGAP','2026-07-31')) AS change`);
  ck('change is 6 against the real previous session', Number(chg[0].change)===6, chg[0].change);
  const {rows:bad}=await db.query(
    "select session_close('SRGAP', date '2026-07-31' - 1) AS close");
  ck('against date - 1 the close is NULL — the change would be wrong',
     bad[0].close===null, bad[0].close);

  // weekends
  await q('SRWK','2026-08-20',50,'Close-Of-Day',90);   // Thursday
  const {rows:wk}=await db.query("select prev_session_sym('SRWK','2026-08-23') AS d");  // Sunday
  ck('Sunday looks back to Thursday, not Saturday',
     new Date(wk[0].d).toISOString().startsWith('2026-08-20'), wk[0].d);

  // first ever session for a symbol
  const {rows:first}=await db.query("select prev_session_sym('SRTIJARA','2026-08-13') AS d");
  ck('no earlier session -> NULL, not a guess', first[0].d===null, first[0].d);

  // the function must not leak across symbols
  const {rows:other}=await db.query("select prev_session_sym('SRGAP','2026-08-13') AS d");
  ck('per-symbol, not global',
     new Date(other[0].d).toISOString().startsWith('2026-07-31'), other[0].d);

  await clean();
  console.log(`\nsession rules: ${p}/${n}`);
  await db.close(); process.exit(p===n?0:1);
})().catch(async e=>{console.error('CRASH:',e.message);await db.close();process.exit(1)});

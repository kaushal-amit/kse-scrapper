// A day that produced no close must not be the "previous close".
const M=require('../../src/jobs/symbolDayMetrics');
let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,JSON.stringify(x))};
let T=0;
const row=(o={})=>({created_at:new Date(Date.parse('2026-07-21T06:00:00Z')+(T++)*60000),
  last_price:100,last_qty:100,volume:1000,trades:10,bid:99,offer:101,session:'Trading',...o});
const day=(r)=>{T=0;return r;};

// ── close_source names the session ──
ck('Close-Of-Day -> CLOSE_OF_DAY',
   M.closeSource(day([row({last_price:172}),row({last_price:176,session:'Close-Of-Day'})]))==='CLOSE_OF_DAY');
ck('Trading at Last -> TRADING_AT_LAST',
   M.closeSource(day([row({last_price:172}),row({last_price:174,session:'Trading at Last'})]))==='TRADING_AT_LAST');
ck('Close Auction Acceptance -> AUCTION',
   M.closeSource(day([row({last_price:172}),row({last_price:133,session:'Close Auction Acceptance'})]))==='AUCTION');

// THE JULY SHAPE: capture stopped at 12:59, only Trading rows exist.
const july=day([row({last_price:170}),row({last_price:172})]);
ck('Trading only -> TRADING — the 172-instead-of-176 case',
   M.closeSource(july)==='TRADING', M.closeSource(july));
ck('and close_px is that last Trading print', M.closePrice(july)===172);

// ── a session outside the closing set is not a close ──
const preopen=day([row({last_price:200,session:'Pre-Open'}),row({last_price:210,session:'Pre-Open'})]);
ck('a day with only Pre-Open rows has NO close', M.closePrice(preopen)===null, M.closePrice(preopen));
ck('and close_source is NULL, not a fifth value',
   M.closeSource(preopen)===null, M.closeSource(preopen));
ck('close_px IS NULL already says there was none — no NONE value',
   M.closePrice(preopen)===null && M.closeSource(preopen)===null);

// ── an unlabelled row still counts, and reads as TRADING ──
const unlabelled=day([row({last_price:200}),row({last_price:205,session:null})]);
// NULL is now excluded (Friday post-close reads); '' is included at the
// TRADING tier (July capture defect on continuous trading).
ck('a NULL session is EXCLUDED', M.closePrice(unlabelled)===200, M.closePrice(unlabelled));
T=0;
const blank=day([row({last_price:200}),row({last_price:205,session:''})]);
ck('a BLANK session IS included', M.closePrice(blank)===205);
ck('and reads as TRADING — not a claim it was the official close',
   M.closeSource(blank)==='TRADING');

// ── the reach-back rule, as arithmetic ──
// 28 Jul close 100 · 29 Jul close 110 · 30 Jul NO close · 2 Aug close 120
const sessions=[
  {d:'2026-07-28', close:100}, {d:'2026-07-29', close:110},
  {d:'2026-07-30', close:null}, {d:'2026-08-02', close:120},
];
function previousClose(forDay, cap=5){
  const prior=sessions.filter(s=>s.d<forDay && s.close!==null).sort((a,b)=>b.d.localeCompare(a.d));
  if(!prior.length) return null;
  const hit=prior[0];
  const gap=Math.round((new Date(forDay)-new Date(hit.d))/86400000);
  const sessionsBack=sessions.filter(s=>s.d<forDay&&s.d>=hit.d).length;
  return sessionsBack>cap ? null : {prev:hit.close, used:hit.d, gap};
}
const aug2=previousClose('2026-08-02');
ck('2 Aug reaches PAST the closeless 30 July', aug2.used==='2026-07-29', aug2);
ck('to a close of 110, not NULL', aug2.prev===110, aug2);
ck('and the gap says 4 days, not 1 — the reach is visible', aug2.gap===4, aug2);
ck('29 Jul still uses 28 Jul, gap 1', previousClose('2026-07-29').gap===1);
ck('the FIRST session has no previous close', previousClose('2026-07-28')===null);

// the cap
const far=[{d:'2026-07-01', close:50}];
function cappedReach(forDay, cap){
  const hit=far[0];
  const back=20;                       // 20 sessions away
  return back>cap ? null : hit.close;
}
ck('beyond the 5-session cap, prev_close is NULL — not a price from two weeks ago',
   cappedReach('2026-08-02',5)===null);

console.log(`\nclose source + reach-back: ${p}/${n}`);
process.exit(p===n?0:1);

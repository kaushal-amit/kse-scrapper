// The row-matching logic, extracted verbatim from the userscript and run
// against a jsdom-free fake DOM. No browser needed: this is pure predicate
// logic, and it is the part that decides WHICH stock gets selected.
let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,JSON.stringify(x))};

const txt=(el)=>(el.text||'').replace(/\s+/g,' ').trim();

// findResult(), as written in awsat-depth-all.user.js
function findResult(rows, want, code){
  // Whole-token match: ABARRE must not satisfy a search for ABAR.
  const token=new RegExp('(^|[^A-Z0-9])'+want.replace(/[^A-Z0-9]/gi,'')+'([^A-Z0-9]|$)');
  const cands=[];
  for(const el of rows){
    const t=txt(el).toUpperCase();
    if(el.w<=0||el.h<=0) continue;          // invisible = stale render
    if(!token.test(t)) continue;
    if(/BUY IN/.test(t)) continue;
    cands.push({el,t,hasCode:Boolean(code)&&t.indexOf(String(code))>=0});
  }
  if(!cands.length) return null;
  for(const c of cands) if(c.hasCode && /PREMIER MARKET|MAIN MARKET/.test(c.t)) return c.el;
  for(const c of cands) if(c.hasCode) return c.el;
  for(const c of cands) if(/PREMIER MARKET|MAIN MARKET/.test(c.t)) return c.el;
  return cands[0].el;
}
const row=(text,w=200,h=20)=>({text,w,h,id:text});

// The real dropdown for "ABAR": the right row plus the traps.
const abarRows=[
  row('ABAR - 633  Buy In Market'),
  row('ABARRE - 634  Rights  Main Market'),
  row('ABAR - 633  AL ARABI GROUP  Main Market'),
];
const hit=findResult(abarRows,'ABAR','633');
ck('picks the real Main Market row', hit && /AL ARABI/.test(hit.text), hit&&hit.text);
ck('never the Buy In row', !(hit&&/BUY IN/.test(hit.text.toUpperCase())), hit&&hit.text);
ck('never the rights line', !(hit&&/ABARRE/.test(hit.text)), hit&&hit.text);
ck('ABARRE does not satisfy a search for ABAR',
   findResult([row('ABARRE - 634  Rights  Main Market')],'ABAR',null)===null);

// Same NAME on two markets -> the code disambiguates.
const twoMarkets=[
  row('KFH - 999  KUWAIT FINANCE  Premier Market'),
  row('KFH - 108  KUWAIT FINANCE HOUSE  Main Market'),
];
const byCode=findResult(twoMarkets,'KFH','108');
ck('code picks the right listing', byCode && /108/.test(byCode.text), byCode&&byCode.text);
const noCode=findResult(twoMarkets,'KFH',null);
ck('without a code it still returns a real market row',
   noCode && /MARKET/.test(noCode.text.toUpperCase()), noCode&&noCode.text);

// A zero-size row is a stale render: clicking it does nothing but looks fine.
const stale=[row('ZAIN - 605  Premier Market',0,0), row('ZAIN - 605  ZAIN  Main Market')];
const vis=findResult(stale,'ZAIN','605');
ck('skips invisible rows', vis && vis.w>0, vis&&{w:vis.w,t:vis.text});

// Nothing matching -> null, so the caller SKIPS instead of posting the
// previous stock's book.
ck('no match -> null', findResult(abarRows,'NBK','101')===null);
// A code that does not appear is now a MISSED TIEBREAK, not a rejection: the
// row still names ABAR and is not a Buy In, so it is better than skipping the
// symbol entirely every cycle.
const wrongCode=findResult(abarRows,'ABAR','999');
ck('unknown code still finds the real market row',
   wrongCode && /AL ARABI/.test(wrongCode.text), wrongCode&&wrongCode.text);
ck('and still never the Buy In row',
   !(wrongCode && /BUY IN/.test(wrongCode.text.toUpperCase())), wrongCode&&wrongCode.text);
ck('only a Buy In row -> null',
   findResult([row('MRC - 510  Buy In Market')],'MRC','510')===null);

// Substring safety: ABAR must not match ABARRE's row when the code differs.
// ABARRE contains "ABAR", so a name-only match would pick it. The CODE
// tiebreak is what keeps the right one when both are present.
const both=findResult([row('ABARRE - 634  Rights  Main Market'),
                       row('ABAR - 633  AL ARABI  Main Market')],'ABAR','633');
ck('code tiebreak picks the exact listing', both && /AL ARABI/.test(both.text), both&&both.text);

console.log(`\ndepth selection: ${p}/${n}`);
process.exit(p===n?0:1);

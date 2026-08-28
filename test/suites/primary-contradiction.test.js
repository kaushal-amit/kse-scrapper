// The ranking must not let a renamed-away ticker win its own code, and the
// job must REFUSE rather than write a contradiction.
const job=require('../../src/jobs/refreshInstruments');
let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,JSON.stringify(x))};

const row=(o)=>({symbol:'X',code:'1',quote_rows:100,last_quote:'2026-08-25',
  was_primary:true,superseded_by:null,broker_status:'CAPTURED',should_be_primary:true,...o});

// ── THE 624 CASE, exactly as it occurred ──
const inverted=[
  row({symbol:'KPPC',code:'624',last_quote:'2026-08-02',quote_rows:3156,
       superseded_by:'PHC',broker_status:'ABSENT',should_be_primary:true}),
  row({symbol:'PHC',code:'624',last_quote:'2026-08-25',quote_rows:1845,
       superseded_by:null,broker_status:'CAPTURED',should_be_primary:false}),
];
const found=job.findContradictions(inverted);
ck('the 624 inversion is caught', found.length===1, found.length);
ck('it names the stale primary', found[0]&&found[0].primary.symbol==='KPPC', found[0]);
ck('and the fresher non-primary', found[0]&&found[0].stalerThan.symbol==='PHC');
ck('with both last-quote dates, so the log explains itself',
   found[0]&&found[0].primary.last_quote==='2026-08-02'&&found[0].stalerThan.last_quote==='2026-08-25');

// ── the CORRECT arrangement passes ──
const correct=[
  row({symbol:'KPPC',code:'624',last_quote:'2026-08-02',superseded_by:'PHC',
       broker_status:'ABSENT',should_be_primary:false}),
  row({symbol:'PHC',code:'624',last_quote:'2026-08-25',should_be_primary:true}),
];
ck('the correct arrangement raises nothing', job.findContradictions(correct).length===0);

// ── KFH / KFIN, right by accident before, right by rule now ──
ck('108 passes when KFH is primary', job.findContradictions([
  row({symbol:'KFH',code:'108',last_quote:'2026-08-25',quote_rows:7523,should_be_primary:true}),
  row({symbol:'KFIN',code:'108',last_quote:'2026-07-13',quote_rows:1,
       superseded_by:'KFH',should_be_primary:false}),
]).length===0);
ck('and FAILS if they were the other way round', job.findContradictions([
  row({symbol:'KFH',code:'108',last_quote:'2026-08-25',should_be_primary:false}),
  row({symbol:'KFIN',code:'108',last_quote:'2026-07-13',should_be_primary:true}),
]).length===1);

// ── the BROAD rule catches shapes the narrow one would miss ──
ck('a 1-quote symbol outranking a 7,523-quote one is caught', job.findContradictions([
  row({symbol:'TINY',code:'9',last_quote:'2026-07-01',quote_rows:1,should_be_primary:true}),
  row({symbol:'BIG',code:'9',last_quote:'2026-08-25',quote_rows:7523,should_be_primary:false}),
]).length===1);
ck('both CAPTURED, still caught — status is not the test, RECENCY is',
   job.findContradictions([
     row({symbol:'A',code:'7',last_quote:'2026-07-01',broker_status:'CAPTURED',should_be_primary:true}),
     row({symbol:'B',code:'7',last_quote:'2026-08-25',broker_status:'CAPTURED',should_be_primary:false}),
   ]).length===1);

// ── DELISTED is deliberately stale and primary — NOT a contradiction ──
ck('a DELISTED primary is exempt — it kept its history on purpose',
   job.findContradictions([
     row({symbol:'BAREEQ',code:'2003',last_quote:'2026-07-22',broker_status:'DELISTED',should_be_primary:true}),
     row({symbol:'OTHER',code:'2003',last_quote:'2026-08-25',should_be_primary:false}),
   ]).length===0);

// ── a lone symbol on its code cannot contradict anything ──
ck('one symbol per code raises nothing',
   job.findContradictions([row({symbol:'SOLO',code:'5',should_be_primary:true})]).length===0);
ck('a symbol that never quoted does not trigger on its NULL date',
   job.findContradictions([
     row({symbol:'P',code:'4',last_quote:'2026-08-25',should_be_primary:true}),
     row({symbol:'NOQ',code:'4',last_quote:null,quote_rows:0,should_be_primary:false}),
   ]).length===0);

console.log(`\nprimary contradiction: ${p}/${n}`);
process.exit(p===n?0:1);

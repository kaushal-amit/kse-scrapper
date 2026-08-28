// An inert job must announce itself. A single line at 09:00 is scrollable;
// a warning at 09:07 is not.
let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,JSON.stringify(x))};

// The escalation logic, as written in jobs.js
function makeSkipper(today='2026-08-30'){
  let empties=0; const seen=new Map(); const out=[];
  return {
    skip(reason){
      empties+=1;
      const key=today+'|'+reason;
      if(!seen.has(key)){ seen.clear(); seen.set(key,true); out.push({level:'info',reason,runs:empties}); return; }
      if(empties===20 || empties%180===0) out.push({level:'warn',reason,runs:empties});
    },
    reset(){ empties=0; },
    out,
  };
}

const s=makeSkipper();
s.skip('symbol_minute empty, nothing to compare');
ck('the FIRST empty run logs the reason', s.out.length===1 && s.out[0].level==='info', s.out[0]);

for(let i=2;i<=19;i++) s.skip('symbol_minute empty, nothing to compare');
ck('runs 2-19 are silent — 810 lines a day is noise', s.out.length===1, s.out.length);

s.skip('symbol_minute empty, nothing to compare');
ck('run 20 WARNS — about 7 minutes at a 20s tick',
   s.out.length===2 && s.out[1].level==='warn' && s.out[1].runs===20, s.out[1]);

for(let i=21;i<180;i++) s.skip('symbol_minute empty, nothing to compare');
ck('nothing between 20 and 180', s.out.length===2, s.out.length);

s.skip('symbol_minute empty, nothing to compare');
ck('run 180 WARNS — roughly hourly', s.out.length===3 && s.out[2].runs===180, s.out[2]);

for(let i=181;i<360;i++) s.skip('symbol_minute empty, nothing to compare');
s.skip('symbol_minute empty, nothing to compare');
ck('and again at 360 — every 180, for as long as it lasts',
   s.out.length===4 && s.out[3].runs===360, s.out[3]);
ck('20s x 180 runs = 60 minutes — the count carries the time',
   Math.round((180*20)/60)===60);

// a DIFFERENT reason logs once on its own
const s2=makeSkipper();
s2.skip('symbol_minute empty, nothing to compare');
s2.skip('no slots held — seed pre-day slots or wait for a wake-up');
ck('a second reason gets its own first-time line', s2.out.length===2, s2.out.length);
ck('both are info, neither is a warn yet', s2.out.every(o=>o.level==='info'));

// a NEW DAY logs again — once per process would hide it after a 09:00 restart
const s3=makeSkipper('2026-08-31');
s3.skip('symbol_minute empty, nothing to compare');
ck('a new calendar day logs the reason again', s3.out.length===1 && s3.out[0].level==='info');

// recovery resets the counter
const s4=makeSkipper();
for(let i=0;i<25;i++) s4.skip('symbol_minute empty, nothing to compare');
const before=s4.out.length;
s4.reset();
for(let i=0;i<19;i++) s4.skip('symbol_minute empty, nothing to compare');
ck('after a recovery, 19 more empties do NOT warn again', s4.out.length===before, {before,after:s4.out.length});
s4.skip('symbol_minute empty, nothing to compare');
ck('but the 20th after recovery does', s4.out.length===before+1, s4.out.length);

console.log(`\nfastloop escalation: ${p}/${n}`);
process.exit(p===n?0:1);

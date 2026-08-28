// O3: a 13-order session must capture 13, and a short capture must ALARM.
let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,JSON.stringify(x))};

// expectedRowCount(): the virtualised container is sized to the FULL list even
// though only a screenful is rendered, so height / rowHeight is the real total.
function expectedRowCount(lazyHeight, rowHeight){
  if(!lazyHeight||!rowHeight) return null;
  return Math.round(lazyHeight/rowHeight);
}
ck('13 orders: 325px / 25px', expectedRowCount(325,25)===13, expectedRowCount(325,25));
ck('the widget HTML: 350px / 25px = 14', expectedRowCount(350,25)===14);
ck('missing height -> null, not a guess', expectedRowCount(0,25)===null);
ck('missing row height -> null', expectedRowCount(350,0)===null);

// The alarm.
function verdict(captured, expected){
  if(expected==null) return {alarm:false,note:'grid total unknown'};
  if(captured<expected) return {alarm:true,shortBy:expected-captured};
  return {alarm:false,shortBy:0};
}
const short=verdict(10,13);
ck('O3: 10 of 13 ALARMS', short.alarm===true, short);
ck('and says how many were missed', short.shortBy===3, short);
ck('13 of 13 is silent', verdict(13,13).alarm===false);
ck('more captured than expected does not alarm', verdict(14,13).alarm===false);
ck('unknown total does not alarm', verdict(10,null).alarm===false);

// The scan itself, over a virtualised grid WITH render lag.
function makeGrid(total,windowRows,rowH=25,viewport=220,lag=1){
  return {total,rowH,clientHeight:viewport,scrollHeight:total*rowH,scrollTop:0,
    _rendered:0,_pending:0,
    scrollTo(v){this.scrollTop=Math.max(0,Math.min(v,this.scrollHeight-this.clientHeight));this._pending=lag;},
    rendered(){ if(this._pending>0)this._pending--; else this._rendered=this.scrollTop;
      const first=Math.floor(this._rendered/rowH),out=[];
      for(let i=first;i<Math.min(first+windowRows,this.total);i++) out.push('ORD-'+i);
      return out;}};
}
function scan(grid,step){
  const seen=new Set();
  const collect=()=>{const b=seen.size;for(const id of grid.rendered())seen.add(id);return seen.size-b;};
  collect(); grid.scrollTo(0);
  let barren=0,guard=0;
  for(;;){
    let added=collect(); if(!added) added=collect();
    barren=added?0:barren+1;
    const atEnd=grid.scrollTop+grid.clientHeight>=grid.scrollHeight-2;
    if((atEnd&&barren>=3)||guard++>120) break;
    grid.scrollTo(grid.scrollTop+step);
  }
  return seen.size;
}
const g=makeGrid(13,10);
const found=scan(g,50);
ck('O3: all 13 captured from a 10-row window', found===13, found);
ck('and the alarm stays silent', verdict(found,13).alarm===false);

// The shipped behaviour, for contrast: one read, near-viewport step.
function scanOld(grid,step){
  const seen=new Set();
  const collect=()=>{const b=seen.size;for(const id of grid.rendered())seen.add(id);return seen.size-b;};
  collect(); grid.scrollTo(0);
  let guard=0;
  for(;;){ collect();
    const atEnd=grid.scrollTop+grid.clientHeight>=grid.scrollHeight-2;
    if(atEnd||guard++>2) break;
    grid.scrollTo(grid.scrollTop+step); }
  return seen.size;
}
const old=scanOld(makeGrid(13,10),176);
ck('the OLD scan reproduces 10 of 13', old===10, old);
ck('and WOULD have alarmed', verdict(old,13).alarm===true);

for(const total of [20,37,137]){
  const f=scan(makeGrid(total,10),50);
  ck(total+' orders all captured', f===total, f+' of '+total);
}

console.log(`\norder row count: ${p}/${n}`);
process.exit(p===n?0:1);

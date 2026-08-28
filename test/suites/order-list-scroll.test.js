// A virtualised grid modelled on the real widget: 350px of content, a 220px
// viewport, 25px rows, and a render window that only ever holds ~10 rows.
let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,JSON.stringify(x))};

/**
 * A virtualised grid WITH RENDER LAG.
 *
 * This is the part that matters. Ember re-renders the window asynchronously,
 * so a read taken immediately after a scroll still sees the PREVIOUS window.
 * A model that re-renders instantly cannot reproduce the bug at all — which is
 * why my first version of this test passed against the broken step size.
 */
function makeGrid(total, windowRows, rowH=25, viewport=220, lag=1){
  return {
    total, rowH, clientHeight: viewport,
    scrollHeight: total*rowH,
    scrollTop: 0,
    _renderedTop: 0,        // where the DOM currently reflects
    _pending: 0,
    scrollTo(v){
      this.scrollTop=Math.max(0,Math.min(v,this.scrollHeight-this.clientHeight));
      this._pending=lag;    // the DOM is now stale for `lag` reads
    },
    rendered(){
      if(this._pending>0) this._pending--;      // still catching up
      else this._renderedTop=this.scrollTop;
      const first=Math.floor(this._renderedTop/rowH);
      const out=[];
      for(let i=first;i<Math.min(first+windowRows,this.total);i++) out.push('ORD-'+i);
      return out;
    },
  };
}

// The scan, mirroring readOrders()
function scan(grid, {step, barrenLimit=3, cap=120, doubleRead=true}={}){
  const seen=new Set();
  const collect=()=>{ const b=seen.size; for(const id of grid.rendered()) seen.add(id); return seen.size-b; };
  collect();
  grid.scrollTo(0);
  let barren=0, guard=0;
  for(;;){
    // Two reads per position: the first may still be the stale window.
    let added=collect();
    if(!added && doubleRead) added=collect();
    barren = added? 0 : barren+1;
    const atEnd = grid.scrollTop + grid.clientHeight >= grid.scrollHeight-2;
    if((atEnd && barren>=barrenLimit) || guard++>cap) break;
    grid.scrollTo(grid.scrollTop+step);
  }
  return {found:seen.size, steps:guard, ids:[...seen]};
}

// ── YOUR CASE: 13 orders, 10 rendered at a time ──
const g=makeGrid(13,10);
const OLD_STEP=Math.floor(220*0.8);            // 176px — what shipped
const NEW_STEP=Math.max(20,Math.round(25*2));  // 50px  — two rows

// The shipped behaviour: two scroll positions, stop as soon as the scrollbar
// reaches the bottom. With render lag the second window is still the first.
// EXACTLY what shipped: one read per position, a 176px step, and stop the
// moment the scrollbar reaches the bottom.
const oldWay=scan(makeGrid(13,10),{step:OLD_STEP,barrenLimit:1,cap:2,doubleRead:false});
ck('the shipped behaviour reproduces "10 of 13"', oldWay.found===10, oldWay.found+' of 13');

// Each half of the fix, on its own, is not enough for a long list.
const stepOnly=scan(makeGrid(137,10),{step:NEW_STEP,barrenLimit:3,doubleRead:false});
ck('row-sized steps ALONE still fall short on 137', stepOnly.found<137, stepOnly.found+' of 137');

const newWay=scan(g,{step:NEW_STEP});
ck('row-sized steps find ALL 13', newWay.found===13, newWay.found+' of 13');
ck('no duplicates', newWay.ids.length===new Set(newWay.ids).size);
ck('first and last both present',
   newWay.ids.includes('ORD-0')&&newWay.ids.includes('ORD-12'), newWay.ids.slice(-2));

// ── it must not stop merely because the scrollbar hit the bottom ──
const lazy=makeGrid(13,10);
const slow=scan(lazy,{step:NEW_STEP,barrenLimit:3});
ck('waits for three barren steps at the bottom', slow.found===13, slow.found);

// ── larger lists ──
for(const total of [20,50,137]){
  const r=scan(makeGrid(total,10),{step:NEW_STEP});
  ck(total+' orders all found', r.found===total, r.found+' of '+total);
}

// ── a grid that does not scroll at all ──
const tiny=makeGrid(4,10);
tiny.scrollHeight=tiny.clientHeight;
tiny.scrollTo=function(v){ this.scrollTop=0; };
const t=scan(tiny,{step:NEW_STEP});
ck('short list still complete', t.found===4, t.found);

// ── the cap must not truncate a real list ──
const big=scan(makeGrid(137,10),{step:NEW_STEP});
ck('137 found inside the step cap', big.found===137 && big.steps<=120, {found:big.found,steps:big.steps});

// ── overlap check: consecutive windows must share rows ──
const rowsPerWindow=10, rowsPerStep=NEW_STEP/25;
ck('windows overlap by several rows', rowsPerWindow-rowsPerStep>=6,
   {windowRows:rowsPerWindow, stepRows:rowsPerStep, overlap:rowsPerWindow-rowsPerStep});

console.log(`\norder list scroll: ${p}/${n}`);
process.exit(p===n?0:1);

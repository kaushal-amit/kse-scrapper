// The ladder reader: interleaved bids/offers separated by colour class, many
// candidate scopes, no hardcoded depth.
let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,JSON.stringify(x))};
const MAX_LEVELS=20;
const txt=(e)=>(e.text||'').trim();
const num=(t)=>{const s=String(t).replace(/,/g,'').trim();if(!s||!/\d/.test(s))return null;
  const x=parseFloat(s);return isNaN(x)?null:x;};

const bidRow=(price,qty)=>({cls:'pos-rel table-row-up',price:{text:String(price),cls:'cursor-pointer up-fore-color'},qty:{text:String(qty)}});
const offRow=(price,qty)=>({cls:'pos-rel table-row-down',price:{text:String(price),cls:'cursor-pointer down-fore-color'},qty:{text:String(qty)}});

function readLadderIn(rows){
  const bids=[],offers=[];
  for(const r of rows){
    const price=num(txt(r.price)); if(price===null) continue;
    const qty=r.qty?num(txt(r.qty)):null;
    const cls=(r.price.cls||'')+' '+(r.cls||'');
    if(/up-fore-color|table-row-up/.test(cls)) bids.push({price,qty});
    else if(/down-fore-color|table-row-down/.test(cls)) offers.push({price,qty});
  }
  if(!bids.length&&!offers.length) return [];
  bids.sort((a,b)=>b.price-a.price);
  offers.sort((a,b)=>a.price-b.price);
  const nn=Math.min(MAX_LEVELS,Math.max(bids.length,offers.length)),out=[];
  for(let i=0;i<nn;i++){const b=bids[i]||{},o=offers[i]||{};
    out.push({level:i+1,bid:b.price??null,bidQty:b.qty??null,offer:o.price??null,offerQty:o.qty??null});}
  return out;
}
function readLadder(scopes){
  let best=[];
  for(const sc of scopes){const lv=readLadderIn(sc); if(lv.length>best.length) best=lv;}
  return best;
}

// ── the five-level book from the screenshot, INTERLEAVED as the DOM has it ──
const book5=[
  bidRow(188,589380), offRow(190,157624),
  bidRow(187,478886), offRow(191,328146),
  bidRow(186,286350), offRow(192,137100),
  bidRow(184,150000), offRow(193,100000),
  bidRow(183,200000), offRow(194,100000),
];
const five=readLadderIn(book5);
ck('all FIVE levels captured', five.length===5, five.length);
ck('level 1 is the touch', five[0].bid===188&&five[0].offer===190, five[0]);
ck('level 5 is the far end', five[4].bid===183&&five[4].offer===194, five[4]);
ck('bids descend', five.map(l=>l.bid).join()==='188,187,186,184,183', five.map(l=>l.bid));
ck('offers ascend', five.map(l=>l.offer).join()==='190,191,192,193,194', five.map(l=>l.offer));
ck('quantities kept per level', five[0].bidQty===589380&&five[4].offerQty===100000, [five[0].bidQty,five[4].offerQty]);
ck('no level overwritten', new Set(five.map(l=>l.level)).size===5);

// ── THE REGRESSION: a shallow scope must not win over a deep one ──
const touchOnly=[bidRow(188,589380), offRow(190,157624)];
ck('single scope with only the touch gives 1', readLadderIn(touchOnly).length===1);
ck('DEEPEST scope wins', readLadder([touchOnly, book5]).length===5, readLadder([touchOnly,book5]).length);
ck('order of scopes does not matter', readLadder([book5, touchOnly]).length===5);

// ── uneven sides ──
const uneven=[bidRow(175,5000),offRow(177,3000),bidRow(174,4000),offRow(178,2500),offRow(179,900)];
const u=readLadderIn(uneven);
ck('uneven book keeps every level', u.length===3, u.length);
ck('missing bid at level 3 is null, not dropped', u[2].bid===null&&u[2].offer===179, u[2]);

// ── depth is NOT hardcoded ──
const deep=[]; for(let i=0;i<12;i++){deep.push(bidRow(200-i,1000+i));deep.push(offRow(201+i,2000+i));}
ck('a 12-level book yields 12', readLadderIn(deep).length===12, readLadderIn(deep).length);
const huge=[]; for(let i=0;i<30;i++){huge.push(bidRow(300-i,10));huge.push(offRow(301+i,10));}
ck('capped at the DB ceiling of 20, not truncated at 5',
   readLadderIn(huge).length===20, readLadderIn(huge).length);

// ── a rendered-but-empty widget ──
ck('no rows -> no levels', readLadderIn([]).length===0);
ck('rows without prices -> no levels',
   readLadderIn([{cls:'pos-rel',price:{text:'—'},qty:{text:''}}]).length===0);

console.log(`\nladder depth: ${p}/${n}`);
process.exit(p===n?0:1);

// The ladder exactly as the order-ticket HTML has it: ONE bid, THIRTEEN offers,
// split across two columns, prices in .cursor-pointer, quantities in .h-right.
let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,JSON.stringify(x))};
const MAX_LEVELS=20;
const num=(t)=>{const s=String(t).replace(/,/g,'').trim();if(!s||!/\d/.test(s))return null;
  const x=parseFloat(s);return isNaN(x)?null:x;};

// row(): a .pos-rel container holding a price cell and a quantity cell.
const bid=(price,qty)=>({rowCls:'layout-container full-width pos-rel',
  price:{text:String(price),cls:'layout-col-8 row-height up-fore-color bold table-row-up-back-color font-l cursor-pointer'},
  qty:{text:String(qty),cls:'layout-col-8 row-height up-fore-color bold h-right pad-s-r'}});
const off=(price,qty)=>({rowCls:'layout-container full-width pos-rel',
  price:{text:String(price),cls:'layout-col-8 row-height down-fore-color bold table-row-down-back-color cursor-pointer'},
  qty:{text:String(qty),cls:'layout-col-8 row-height down-fore-color h-right pad-s-r'}});

function readLadderIn(rows){
  const bids=[],offers=[];
  for(const r of rows){
    if(!/cursor-pointer/.test(r.price.cls)) continue;
    const price=num(r.price.text); if(price===null) continue;
    const qty=/h-right/.test(r.qty.cls)?num(r.qty.text):null;
    const cls=r.price.cls+' '+r.rowCls;
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

// The exact book from the HTML.
const book=[bid(224,120),
  off(227,65000),off(228,40000),off(229,129750),off(230,62235),off(231,9141),
  off(232,16500),off(233,22000),off(234,40000),off(235,41052),off(236,20000),
  off(237,45000),off(239,90000),off(243,82220)];

const L=readLadderIn(book);
ck('THIRTEEN levels, not one', L.length===13, L.length);
ck('level 1 has BOTH sides', L[0].bid===224&&L[0].offer===227, L[0]);
ck('level 1 quantities', L[0].bidQty===120&&L[0].offerQty===65000, L[0]);
ck('level 2 offer-only, bid null not dropped',
   L[1].bid===null&&L[1].offer===228&&L[1].offerQty===40000, L[1]);
ck('deepest level is the far offer', L[12].offer===243&&L[12].offerQty===82220, L[12]);
ck('offers ascend across all 13',
   L.map(x=>x.offer).join()==='227,228,229,230,231,232,233,234,235,236,237,239,243', L.map(x=>x.offer));
ck('levels are 1..13 with none repeated',
   L.map(x=>x.level).join()===Array.from({length:13},(_,i)=>i+1).join());
ck('every level carries an offer quantity', L.every(x=>x.offerQty!==null));
ck('only ONE level has a bid', L.filter(x=>x.bid!==null).length===1);

// The symbol comes from the order-ticket header, NOT the ladder widget.
function parseSym(raw){const m=String(raw).replace(/\s+/g,' ')
  .match(/\b([A-Za-z][A-Za-z0-9]*)\s*[-\u2013]\s*(\d{1,6})\b/);
  return m?{symbol:m[1].toUpperCase(),code:m[2]}:null;}
function ladderSymbol(headerTexts, inputValue){
  for(const t of headerTexts){
    if(!/New Order/i.test(t)) continue;
    const s=parseSym(t.replace(/^.*New Order\s*[-\u2013]\s*/i,''));
    if(s) return s.symbol;
  }
  if(inputValue){const s=parseSym(inputValue); if(s) return s.symbol;}
  return null;
}
ck('symbol read from "New Order - ABAR - 633"',
   ladderSymbol(['New Order - ABAR - 633'],'')==='ABAR');
ck('header beats a half-typed search box',
   ladderSymbol(['New Order - ABAR - 633'],'ZAI')==='ABAR');
ck('falls back to the input when no header',
   ladderSymbol([],'ZAIN - 605')==='ZAIN');
ck('the LADDER WIDGET alone yields nothing (the old bug)',
   ladderSymbol([],'')===null);
ck('a header with no symbol yet is not a false match',
   ladderSymbol(['New Order'],'')===null);

console.log(`\nladder real DOM: ${p}/${n}`);
process.exit(p===n?0:1);

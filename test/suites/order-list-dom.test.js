// The Order List parsing logic, run against the real DOM shapes from the
// widget HTML: tabs in one widget, left/right blocks joined by top, values in
// the title attribute.
let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,JSON.stringify(x))};

const CELL_MAP={'symbolInfo.dispProp1':'symbolRaw',clOrdId:'orderId',ordSts:'status',
  ordSide:'side',ordQty:'quantity',price:'price',cumQty:'filled',pendQty:'remaining',
  adjustedCrdDte:'stamp'};
const clean=(t)=>(t||'').replace(/[\u202A\u202B\u202C]/g,'').replace(/\s+/g,' ').trim();

// A cell as the HTML has it: text may be TRUNCATED, title is full.
const cell=(id,title,text)=>({cellId:id,title,text:text===undefined?title:text});
const rowEl=(top,cells)=>({top,cells});

function readRendered(rows){
  const buckets=new Map();
  for(const r of rows){
    const key='T'+r.top;
    if(!buckets.has(key)) buckets.set(key,[]);
    buckets.get(key).push(r);
  }
  const out=[];
  for(const halves of buckets.values()){
    const rec={};let hits=0;
    for(const row of halves) for(const c of row.cells){
      const value=clean(c.title)||clean(c.text);      // TITLE preferred
      if(!value) continue;
      const f=CELL_MAP[c.cellId];
      if(f&&rec[f]==null){rec[f]=value;hits++;}
    }
    if(hits&&rec.orderId) out.push(rec);
  }
  return out;
}

// Row 1 of the real widget, split across the two blocks at top:0px.
const left0 =rowEl(0,[cell('symbolInfo.dispProp1','MRC - 510')]);
const right0=rowEl(0,[cell('symbolInfo.sDes','MRC'),cell('clOrdId','26082560133'),
  cell('ordSts','Cancelled'),cell('ordSide','Buy'),cell('ordQty','3,500'),
  cell('price','188'),cell('exg','KSE'),cell('cumQty','0'),cell('pendQty','3,500'),
  cell('adjustedCrdDte','25-08-2026 13:14:10')]);
// Row 2 at top:25px — a FILLED sell.
const left25 =rowEl(25,[cell('symbolInfo.dispProp1','MRC - 510')]);
const right25=rowEl(25,[cell('clOrdId','26082558914'),cell('ordSts','Filled'),
  cell('ordSide','Sell'),cell('ordQty','3,500'),cell('price','204'),
  cell('cumQty','3,500'),cell('pendQty','0')]);

const rows=readRendered([left0,right0,left25,right25]);
ck('two orders parsed', rows.length===2, rows.length);

const a=rows.find(r=>r.orderId==='26082560133');
ck('order id from clOrdId', !!a, rows.map(r=>r.orderId));
ck('symbol from the LEFT block', a.symbolRaw==='MRC - 510', a.symbolRaw);
ck('status Cancelled', a.status==='Cancelled', a.status);
ck('side Buy', a.side==='Buy', a.side);
ck('quantity 3,500', a.quantity==='3,500', a.quantity);
ck('price 188', a.price==='188', a.price);
ck('filled 0 (cumQty)', a.filled==='0', a.filled);
ck('remaining 3,500 (pendQty)', a.remaining==='3,500', a.remaining);
ck('timestamp captured', a.stamp==='25-08-2026 13:14:10', a.stamp);

const b=rows.find(r=>r.orderId==='26082558914');
ck('second order distinct', b && b.status==='Filled' && b.side==='Sell', b);
ck('filled sell has cumQty 3,500', b.filled==='3,500', b.filled);
ck('and pendQty 0', b.remaining==='0', b.remaining);

// TRUNCATION: the visible text is ellipsised, the title is complete.
const trunc=readRendered([rowEl(50,[cell('clOrdId','26082558836','2608255…')])]);
ck('title wins over truncated text', trunc[0].orderId==='26082558836', trunc[0]);

// A row with no order id is not storable.
ck('row without clOrdId dropped',
   readRendered([rowEl(75,[cell('ordSts','Filled')])]).length===0);

// SCROLL DEDUPE: re-rendered rows must not become extra orders.
const byId=new Map();
for(const pass of [rows,rows,rows]) for(const r of pass) if(!byId.has(r.orderId)) byId.set(r.orderId,r);
ck('three passes still two orders', byId.size===2, byId.size);

// TAB CHECK
function activeTab(widget){
  const a2=widget.tabs.find(t=>t.active);
  return a2?a2.label:null;
}
function pickWidget(widgets){
  for(const w of widgets) if(/^order list$/i.test(activeTab(w)||'')) return {widget:w,activeTab:'Order List'};
  for(const w of widgets){ const t=activeTab(w); if(t) return {widget:null,activeTab:t}; }
  return {widget:null,activeTab:null};
}
const onList  =[{tabs:[{label:'Order List',active:true},{label:'Order Search',active:false}]}];
const onSearch=[{tabs:[{label:'Order List',active:false},{label:'Order Search',active:true}]}];
ck('reads when Order List is active', pickWidget(onList).widget!==null);
ck('REFUSES when Order Search is active', pickWidget(onSearch).widget===null);
ck('names the wrong tab', pickWidget(onSearch).activeTab==='Order Search', pickWidget(onSearch).activeTab);

console.log(`\norder list DOM: ${p}/${n}`);
process.exit(p===n?0:1);

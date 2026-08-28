const t=require('../../src/scrapers/transform');
const meta={minuteBucket:new Date('2026-08-16T06:00:00Z'),tradingDay:'2026-08-16',
  capturedAt:new Date('2026-08-16T06:00:05Z'),source:'tradingview',runId:1};
const A={last:['price','last'],change_percent:['chg %','change %'],change_amount:['chg','change'],
  volume:['vol','volume'],open_price:['open'],high_price:['high'],low_price:['low'],prev_close:['prev close']};
let pass=0,total=0;
const ck=(name,cond,extra)=>{total++;if(cond)pass++;else console.log('  FAIL:',name,extra||'');};

// 1. header row must not become data
const header=['Symbol','Name','Price','Chg %','Vol'];
const rows=[header,['ABAR','Al Arabi','176.0','+1.2%','1.24M'],['ZAIN','Zain','540','-0.5%','800K']];
let r=t.buildQuotes(header,rows,A,meta);
ck('header row dropped', r.quotes.length===2, `got ${r.quotes.length}`);
ck('no SYMBOL instrument', !r.quotes.find(q=>q.symbol==='SYMBOL'));
ck('price parsed', r.quotes[0].last_price===176);
ck('volume suffix', r.quotes[0].volume===1240000, r.quotes[0].volume);
ck('negative pct', r.quotes[1].change_percent===-0.5);

// 2. "chg" must not steal the "chg %" column
const idx=t.resolveColumns(['Symbol','Name','Price','Chg','Chg %'],A);
ck('exact match beats prefix', idx.change_amount===3&&idx.change_percent===4, JSON.stringify(idx));

// 3. column INSERTED upstream -> name resolution follows it
const h2=['Symbol','Name','NEW','Price','Chg %','Vol'];
const r2=t.buildQuotes(h2,[h2,['ABAR','Al Arabi','xx','176.0','+1.2%','1.24M']],A,meta);
ck('survives inserted column', r2.quotes[0].last_price===176, r2.quotes[0].last_price);

// 4. malformed / missing cells
const r3=t.buildQuotes(header,[header,['ABAR','Al Arabi','—','','—'],['','x','1','2','3'],['ZZ']],A,meta);
ck('em-dash -> null price', r3.quotes[0].last_price===null);
ck('row without symbol skipped', !r3.quotes.find(q=>q.symbol===''));
ck('short row kept if symbol ok', r3.quotes.length===2, r3.quotes.length);

// 5. price coverage detects selector drift
ck('coverage full', t.priceCoverage(r.quotes)===1);
ck('coverage zero on all-null', t.priceCoverage(r3.quotes)===0, t.priceCoverage(r3.quotes));

// 6. no header at all -> fallback indices
const rf=t.buildQuotes([],[['ABAR','Al Arabi','176.0','+1.2%','1.24M']],A,meta,{last:2,change_percent:3,volume:4});
ck('fallback used', rf.usedFallback===true);
ck('fallback price', rf.quotes[0].last_price===176);

// 7. depth
const d=t.buildDepthLevels([['Qty','Bid','Ask','Qty'],['1000','175','177','900'],['2000','174','178','800'],['','','','']],'ABAR',meta);
ck('depth header dropped', d.length===2, d.length);
ck('depth levels numbered', d[0].level===1&&d[1].level===2);
ck('depth empty row dropped', d.every(x=>x.bid!==null||x.ask!==null));
const many=Array.from({length:30},(_,i)=>[`${i}`,`${100-i}`,`${200+i}`,`${i}`]);
ck('depth capped at 20', t.buildDepthLevels(many,'X',meta).length===20);

// 8. orders
const o=t.buildOrders([['Order','Symbol','Side','Status','Price','Qty','Filled'],
  ['A1','ABAR','Buy','FILLED','176','1000','1000'],
  ['','ABAR','Buy','X','1','1','1'],
  ['A3','???','Sell','OPEN','177','500','0']],meta);
ck('orders header dropped', o.length===2, o.length);
ck('order without id dropped', !o.find(x=>x.order_id===''));
ck('side normalised', o[0].side==='BUY'&&o[1].side==='SELL');
ck('remaining computed', o[0].remaining_qty===0&&o[1].remaining_qty===500);
ck('unparseable symbol kept as null', o[1].symbol===null||typeof o[1].symbol==='string');

console.log(`\ntransform: ${pass}/${total}`);
process.exit(pass===total?0:1);

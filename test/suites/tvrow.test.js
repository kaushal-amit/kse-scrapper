const tv=require('../../src/scrapers/tradingview');
const clock=require('../../src/market/clock');
let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,x===undefined?'':JSON.stringify(x))};
const meta={minuteBucket:clock.minuteBucket(new Date()),tradingDay:'2026-08-20',capturedAt:new Date(),runId:1};

// shapes readVisibleRows actually produces
const q=tv.toQuote({symbolText:'ABAR',companyName:'Al Arabi',lastPrice:'176.0',
  changePercent:'+1.20%',change:'+2.0',volume:'1.24M'},meta);
ck('symbol',q.symbol==='ABAR');
ck('price',q.last_price===176);
ck('change%',q.pct_chg===1.2,q.pct_chg);
ck('volume suffix expanded',q.volume===1240000,q.volume);
ck("created_at set",q.created_at instanceof Date);
ck('source tagged',q.source==='tradingview');

// prefixed symbol from the anchor
ck('KSE: prefix stripped',tv.toQuote({symbolText:'KSE:ZAIN',lastPrice:'540'},meta).symbol==='ZAIN');
// suspended symbol: no price yet, must still be KEPT
const s=tv.toQuote({symbolText:'NBK',lastPrice:'—',changePercent:'',volume:''},meta);
ck('suspended row kept with null price',s!==null&&s.last_price===null,s&&s.last_price);
// unusable symbol dropped
ck('empty symbol dropped',tv.toQuote({symbolText:'',lastPrice:'1'},meta)===null);
ck('bidi-wrapped symbol cleaned',tv.toQuote({symbolText:'ABAR',lastPrice:'1'},meta).symbol==='ABAR');
// negative change
ck('negative change',tv.toQuote({symbolText:"X",lastPrice:"1",change:"-2.5"},meta).chg===-2.5);
// QA ids match the working implementation
ck('CELL ids match server1',tv.CELL.symbol==='column-symbol'&&tv.CELL.lastPrice==='column-last_price',tv.CELL);
console.log(`\ntradingview rows: ${p}/${n}`);process.exit(p===n?0:1);

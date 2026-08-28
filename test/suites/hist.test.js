const t=require('../../src/scrapers/historyTransform');
let p=0,n=0; const ck=(name,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',name,x===undefined?'':JSON.stringify(x))};

// --- the U+2212 minus sign: the bug that silently nulls every negative ---
ck('U+2212 minus parsed', t.parseNumeric('\u22121.5')===-1.5, t.parseNumeric('\u22121.5'));
ck('ascii minus parsed', t.parseNumeric('-1.5')===-1.5);
ck('thousands separator', t.parseNumeric('1,234.50')===1234.5);
ck('em-dash -> null', t.parseNumeric('—')===null);
ck('nbsp stripped', t.parseNumeric('1\u00A0234')===1234);
ck('zero is not missing', t.parseNumeric('0')===0);
ck('garbage -> null', t.parseNumeric('abc')===null);

// --- bidi-wrapped date text ---
ck('bidi-wrapped date', t.toDayString(t.parseRowDate("\u202A1 Feb '26\u202C"))==='2026-02-01',
   t.toDayString(t.parseRowDate("\u202A1 Feb '26\u202C")));
ck('plain date', t.toDayString(t.parseRowDate("30 Jun '26"))==='2026-06-30');
ck('4-digit year', t.toDayString(t.parseRowDate("5 Mar 2026"))==='2026-03-05');
ck('junk date -> null', t.parseRowDate('not a date')===null);

// --- the off-by-one: header index vs value index ---
const headers=['Date','Open','High','Low','Close','Change','Volume'];
const col=t.mapColumns(headers);
ck('open maps to VALUE index 0', col.open===0, col);
ck('close maps to VALUE index 3', col.close===3, col);
ck('volume maps to VALUE index 5', col.volume===5, col);

// --- build rows ---
const meta={symbol:'ABAR',runId:1,startDay:'2026-02-01',endDay:'2026-06-30'};
const mk=(ts,vals)=>({ts,dateText:'',values:vals});
const feb1=Math.floor(Date.UTC(2026,1,1)/1000), feb2=Math.floor(Date.UTC(2026,1,2)/1000);
const jan1=Math.floor(Date.UTC(2026,0,1)/1000);
const r=t.buildDailyRows([
  mk(feb1,['176','180','175','178','\u22122.5','1,240,000']),
  mk(feb2,['178','182','177','181','+3','900000']),
  mk(jan1,['1','2','0.5','1.5','0','10']),              // BEFORE range
  mk(feb1,['9','9','9','9','0','1']),                    // duplicate day
  mk(Math.floor(Date.UTC(2026,2,1)/1000),['1','—','1','1','0','1']), // missing high
  mk(Math.floor(Date.UTC(2026,2,2)/1000),['5','1','9','5','0','1']), // high<low
],headers,meta);

ck('two valid rows kept', r.rows.length===2, r.rows.length);
ck('out-of-range excluded', r.outOfRange===1, r.outOfRange);
ck('duplicate day dropped', !r.rows.filter(x=>x.trade_date==='2026-02-01')[1]);
ck('incomplete OHLC skipped', r.reasons.some(x=>/incomplete OHLC/.test(x)), r.reasons);
ck('crossed columns skipped', r.reasons.some(x=>/columns appear crossed/.test(x)), r.reasons);
ck('negative change survived', r.rows[0].change_value===-2.5, r.rows[0].change_value);
ck('volume parsed with commas', r.rows[0].volume===1240000, r.rows[0].volume);
ck('sorted oldest first', r.rows[0].trade_date<r.rows[1].trade_date);
ck('OHLC on correct columns', r.rows[0].open_price===176&&r.rows[0].close_price===178, r.rows[0]);

// --- header misread must THROW, not write wrong columns ---
let threw=false;
try{ t.buildDailyRows([mk(feb1,['1','2','3','4'])],['Date','Foo','Bar','Baz'],meta) }catch(e){threw=/could not map OHLC/.test(e.message)}
ck('unmappable headers throw', threw);

console.log(`\nhistory transform: ${p}/${n}`);
process.exit(p===n?0:1);

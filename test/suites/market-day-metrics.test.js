// M1-M6 and the breadth rules, against hand-built sessions. No database.
const m=require('../../src/jobs/marketDayMetrics');
let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,JSON.stringify(x))};
const sym=(i,chg,o={})=>({symbol:'S'+i,chg_fils:chg,chg_1d:chg===null?null:chg*0.5,
  trades:100,total_volume:10000,data_quality:'FULL',...o});

// ── 17 August: 24 up, 93 down, 11 flat, 8 with no previous close ──
const aug17=[];
for(let i=0;i<24;i++) aug17.push(sym(i,2));
for(let i=24;i<117;i++) aug17.push(sym(i,-1));
for(let i=117;i<128;i++) aug17.push(sym(i,0));
for(let i=128;i<136;i++) aug17.push(sym(i,null));

const b=m.breadth(aug17);
ck('136 symbols traded', b.symbols_traded===136, b.symbols_traded);
ck('24 advancing', b.advancing===24, b.advancing);
ck('93 declining', b.declining===93, b.declining);
ck('11 unchanged', b.unchanged===11, b.unchanged);
ck('8 with no previous close, excluded from all three', b.no_prev_close===8, b.no_prev_close);
ck('the four sum to 136', b.advancing+b.declining+b.unchanged+b.no_prev_close===136);

// ── M1 · pct_advancing over the symbols that were MEASURED ──
//
// H-J · this asserted 24/136 = 17.65. Eight of those 136 had no previous close,
// so they could never be in the numerator — and dividing by them was dividing by
// symbols whose direction nobody measured. The honest denominator is the 128
// that had one: 24/128 = 18.75.
//
// The difference is small here because 17 August was a good capture. It is not
// small on the day after a gap, which is exactly when the number is read.
ck('M1: 24 of the 128 MEASURED = 18.75',
   Math.round(b.pct_advancing*100)/100===18.75, b.pct_advancing);
ck('and not 24/136 — the eight unmeasured symbols are not in the denominator',
   Math.round(b.pct_advancing*100)/100!==17.65, b.pct_advancing);
ck('measured_symbols says what it was computed over', b.measured_symbols===128, b.measured_symbols);
ck('the ratio denominator would give 20.5 — stored separately',
   Math.round(b.pct_advancing_ratio*10)/10===20.5, b.pct_advancing_ratio);
ck('the two are NOT the same number', b.pct_advancing!==b.pct_advancing_ratio);

// ── M2 · regime ──
// Still RISK_OFF: the correction moves the number by one point, not across a
// cutoff, on a day whose capture was good.
ck('M2: 18.75 -> RISK_OFF', m.regimeOf(b.pct_advancing)==='RISK_OFF');

// ── M3/M4 · 25 August, 52% ──
const aug25=[];
for(let i=0;i<71;i++) aug25.push(sym(i,3));
for(let i=71;i<136;i++) aug25.push(sym(i,-1));
const b25=m.breadth(aug25);
ck('M3: 71/136 = 52.2', Math.round(b25.pct_advancing)===52, b25.pct_advancing);
ck('M4: 52.2 -> RISK_ON', m.regimeOf(b25.pct_advancing)==='RISK_ON');

// boundaries
ck('34.9 -> RISK_OFF', m.regimeOf(34.9)==='RISK_OFF');
ck('35 -> NEUTRAL', m.regimeOf(35)==='NEUTRAL');
ck('50 -> NEUTRAL', m.regimeOf(50)==='NEUTRAL');
ck('50.1 -> RISK_ON', m.regimeOf(50.1)==='RISK_ON');
ck('NULL -> NULL, not a guess', m.regimeOf(null)===null);

// ── M5 · CATTL's +109% moves the mean, not the median ──
const aug24=[];
for(let i=0;i<135;i++) aug24.push({...sym(i,1),chg_1d:0.5});
aug24.push({...sym(999,1),chg_1d:109});          // CATTL
const d=m.moveDistribution(aug24);
ck('M5: mean and median DIFFER', d.avg_pct_change!==d.median_pct_change, d);
ck('M5: the median is unmoved at 0.5', d.median_pct_change===0.5, d.median_pct_change);
ck('M5: the mean is dragged above 1.2', d.avg_pct_change>1.2, d.avg_pct_change);
ck('p90 is not the outlier', d.pct_change_p90===0.5, d.pct_change_p90);
ck('p10 reported', d.pct_change_p10===0.5, d.pct_change_p10);

// ── THIN counted, still included in breadth ──
const withThin=[sym(1,2,{data_quality:'THIN'}),sym(2,2),sym(3,-1)];
const bt=m.breadth(withThin);
ck('THIN symbols still count toward breadth', bt.advancing===2, bt.advancing);
/*
 * D7 · thin_symbols is RETIRED and always NULL now.
 *
 * It had no semantic reader — two SELECT * accidents and a log line — while
 * spread-backend's review/index.js recomputed the same THIN count from
 * public.symbol_day, which is the number the frontend shows. Two
 * implementations of one definition, and 16 of 48 stored values disagreed
 * with the symbol_day rows they claimed to count.
 *
 * The line above still matters and is the reason this block exists: THIN
 * symbols are INCLUDED in breadth. Excluding them would make breadth jump on
 * days with patchy capture, which is worse than a slightly noisy figure. It
 * is the SEPARATE COUNT that has gone, not the inclusion.
 */
ck('the separate count is retired, not merely missing', bt.thin_symbols===null, bt.thin_symbols);

// ── activity ──
const act=m.activity([sym(1,1,{total_volume:1000,trades:10}),sym(2,1,{total_volume:2000,trades:20})]);
ck('volume summed', act.total_volume===3000, act);
ck('trades summed', act.total_trades===30, act);

// ── symbols_over_3x_daily ──
const trailing=new Map([['S1',10],['S2',10],['S3',0]]);
const rows3x=[sym(1,1,{symbol:'S1',trades:30}),sym(2,1,{symbol:'S2',trades:29}),
              sym(3,1,{symbol:'S3',trades:999}),sym(4,1,{symbol:'S4',trades:999})];
ck('3x exactly fires', m.over3xDaily([rows3x[0]],trailing)===1);
ck('just under does not', m.over3xDaily([rows3x[1]],trailing)===0);
ck('a zero average is unknowable, not infinite', m.over3xDaily([rows3x[2]],trailing)===0);
ck('no history at all does not fire', m.over3xDaily([rows3x[3]],trailing)===0);

// ── volume_vs_20d ──
ck('NULL below 20 sessions', m.volumeVs20d(1000,new Array(19).fill(1000))===null);
ck('computed at 20', m.volumeVs20d(2000,new Array(20).fill(1000))===2, m.volumeVs20d(2000,new Array(20).fill(1000)));
ck('uses the LAST 20, not all history',
   m.volumeVs20d(1000,[...new Array(30).fill(999999),...new Array(20).fill(1000)])===1);

// ── breadth_5d_avg ──
// 4 priors + today = 5 values. (30+40+50+60+50)/5 = 46.
ck('5-day average is 4 priors PLUS today', m.breadth5dAvg(50,[30,40,50,60])===46,
   m.breadth5dAvg(50,[30,40,50,60]));
ck('only the last 4 priors are used', m.breadth5dAvg(50,[999,30,40,50,60])===46);
ck('works with no history', m.breadth5dAvg(50,[])===50);

console.log(`\nmarket_day metrics: ${p}/${n}`);
process.exit(p===n?0:1);

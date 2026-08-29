// The scraper owns nine thresholds in a file. It must not read kb_threshold —
// a capture service that refuses to boot without a backend table is backwards
// coupling.
const fs=require('fs'); const path=require('path');
const T=require('../../src/config/thresholds');
const S=require('../../src/signals');
let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,JSON.stringify(x))};

const NINE=['sig_no_protection_bid','sig_buyers_ratio','sig_big_qty',
  'sig_bait_max_age_secs','sig_tiny_trade_shares','sig_wall_qty',
  'wakeup_pace_min','wakeup_trades_min','close_capture_min_hhmm'];

ck('exactly nine thresholds', Object.keys(T.all()).length===9, Object.keys(T.all()).length);
for(const k of NINE) ck(k+' present', T.get(k)!==undefined);

// ── the VALUES did not move when they left the table ──
ck('sig_no_protection_bid still 20000', T.get('sig_no_protection_bid')===20000);
ck('sig_buyers_ratio still 1.6', T.get('sig_buyers_ratio')===1.6);
ck('sig_tiny_trade_shares still 100', T.get('sig_tiny_trade_shares')===100);
ck('sig_big_qty still 100000', T.get('sig_big_qty')===100000);
ck('wakeup_pace_min still 3', T.get('wakeup_pace_min')===3);
ck('close_capture_min_hhmm is 1230 — the gap between 12:59 and 10:14',
   T.get('close_capture_min_hhmm')===1230);

// ── signals reads the file, and its numbers are unchanged ──
ck('signals reads the same source',
   S.THRESHOLDS.NO_PROTECTION_BID()===T.get('sig_no_protection_bid'));
ck('and BUYERS_RATIO agrees', S.THRESHOLDS.BUYERS_RATIO()===T.get('sig_buyers_ratio'));

// ── an unknown key THROWS rather than returning undefined ──
let threw=false; try{ T.get('my_pct_min'); }catch{ threw=true; }
ck('a BACKEND key is unknown here and throws', threw===true);
threw=false; try{ T.get('nope'); }catch{ threw=true; }
ck('an unknown key throws — undefined would make a gate never fire', threw===true);

// ── NOTHING in the scraper reads kb_threshold ──
const walk=(d,acc=[])=>{for(const f of fs.readdirSync(d,{withFileTypes:true})){
  const q=path.join(d,f.name);
  if(f.isDirectory()){ if(!/node_modules|migrations/.test(q)) walk(q,acc); }
  else if(f.name.endsWith('.js')) acc.push(q);} return acc;};
const offenders=walk(path.join(__dirname,'../../src'))
  // Only actual reads count — several files MENTION kb_threshold in a comment
  // explaining why they no longer read it, and those comments are the record of
  // the decision.
  .filter(f=>/require\(['"].*kb\/thresholds|FROM\s+kb_threshold|from kb_threshold/i
    .test(fs.readFileSync(f,'utf8')));
ck('no source file READS kb_threshold', offenders.length===0, offenders);

// ── env override still works, so a value can change for one run ──
process.env.SIG_BUYERS_RATIO='2.5';
delete require.cache[require.resolve('../../src/config/thresholds')];
const T2=require('../../src/config/thresholds');
ck('an env var overrides the constant', T2.get('sig_buyers_ratio')===2.5, T2.get('sig_buyers_ratio'));
delete process.env.SIG_BUYERS_RATIO;

// ── the cutoff converts HHMM to minutes correctly ──
const toMin=(h)=>Math.floor(h/100)*60+(h%100);
ck('1230 -> 750 minutes', toMin(1230)===750);
ck('30 July ended 10:14 = 614 -> skipped', toMin(1014)<750);
ck('26 August ended 12:23 = 743 -> skipped', toMin(1223)<750);
ck('the July block ended 12:59 = 779 -> KEPT', toMin(1259)>=750);

console.log(`\nscraper thresholds: ${p}/${n}`);
process.exit(p===n?0:1);

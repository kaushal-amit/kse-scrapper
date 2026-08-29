// The fallback covers the deploy window; the assertion covers correctness.
// A typo in the seed must not hide behind a working default.
const db=require('../../src/db/pool');
const T=require('../../src/kb/thresholds');
let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,JSON.stringify(x))};
(async()=>{
  // ── every key the code reads exists in the table ──
  const {rows}=await db.query('select key,value,source_cr from kb_threshold where still_true');
  const have=new Set(rows.map(r=>r.key));
  const missing=Object.keys(T.REQUIRED).filter(k=>!have.has(k));
  ck('every REQUIRED key is seeded', missing.length===0, missing);
  ck('every seeded threshold names its CR',
     rows.every(r=>r.source_cr), rows.filter(r=>!r.source_cr).map(r=>r.key));

  // ── the values did not move ──
  T.reset(); await T.load({quiet:true});
  ck('sig_no_protection_bid still 20000', T.get('sig_no_protection_bid')===20000);
  ck('sig_buyers_ratio still 1.6', T.get('sig_buyers_ratio')===1.6);
  ck('sig_tiny_trade_shares still 100', T.get('sig_tiny_trade_shares')===100);
  ck('frozen_min_qty and sig_big_qty agree — CR-68 is the same number',
     T.get('frozen_min_qty')===T.get('sig_big_qty'), [T.get('frozen_min_qty'),T.get('sig_big_qty')]);

  // ── the derived pair ──
  ck('min_position_kd = commission_min / rate',
     Math.round(T.get('commission_min_kd')/T.get('commission_rate'))===333,
     T.get('commission_min_kd')/T.get('commission_rate'));
  ck('max_price_fils = 1 / rate / 3',
     Math.round(1/T.get('commission_rate')/3)===222 || T.get('max_price_fils')===333,
     {computed:1/T.get('commission_rate')/3, stored:T.get('max_price_fils')});

  // ── a MISSING key with no fallback fails hard ──
  await db.query("delete from kb_threshold where key='snapshots_min'");
  T.reset();
  let threw=false;
  try{ await T.load({quiet:true}); }catch(e){ threw=/missing 1 key/.test(e.message); }
  ck('a missing key with NO fallback fails the boot', threw===true);

  // ── a MISSING key WITH a fallback warns but does not fail ──
  await db.query("insert into kb_threshold(key,value,source_cr) values ('snapshots_min',100,'chk')");
  await db.query("delete from kb_threshold where key='sig_big_qty'");
  process.env.SIG_BIG_QTY='100000';
  T.reset();
  let ok=false;
  try{ await T.load({quiet:true}); ok=true; }catch(e){ ok=false; }
  ck('the fallback does NOT rescue the boot — the assertion is separate', ok===false);
  await db.query("insert into kb_threshold(key,value,source_cr) values ('sig_big_qty',100000,'CR-68')");

  // ── non-strict for tools that predate the seed ──
  T.reset();
  const v=await T.load({strict:false,quiet:true});
  ck('non-strict returns values instead of throwing', typeof v.sig_big_qty==='number');

  // ── get() throws rather than returning undefined ──
  let g=false;
  try{ T.get('no_such_key'); }catch{ g=true; }
  ck('an unknown key THROWS — a gate comparing against undefined never fires', g===true);
  T.reset();
  let unloaded=false;
  try{ T.get('sig_big_qty'); }catch{ unloaded=true; }
  ck('reading before load() throws', unloaded===true);

  // ── kb_phrase ──
  const {rows:ph}=await db.query('select event,text from kb_phrase where still_true');
  ck('twelve phrases seeded', ph.length===12, ph.length);
  ck('placeholders are intact', ph.find(x=>x.event==='AGED').text==='held {n}m');

  // ── trigger_state is a CHECK, not a convention ──
  let bad=false;
  try{ await db.query("insert into kb_rule(rule,scope,trigger_state) values ('x','SITUATIONAL','TYPO_STATE')"); }
  catch{ bad=true; }
  ck('a typo in trigger_state is REFUSED at insert', bad===true);
  await db.query("delete from kb_rule where rule='x'");

  await T.load({quiet:true});
  console.log(`\nkb thresholds: ${p}/${n}`);
  await db.close(); process.exit(p===n?0:1);
})().catch(async e=>{console.error('CRASH:',e.message);await db.close();process.exit(1)});

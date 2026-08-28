// The reference must be TradingView's list, never a registry AWSAT also writes.
process.env.AWSAT_MODE='client';
const rec=require('../../src/reconcileSymbols');
const db=require('../../src/db/pool');
let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,JSON.stringify(x))};
(async()=>{
  const day='1991-04-04', prev='1991-04-03';
  const clean=async()=>{
    await db.query("delete from tradingview_watchlist where trading_date in ($1,$2)",[day,prev]);
    await db.query("delete from instruments where symbol like 'CV%'");
  };
  await clean();

  // ── the exact situation from the log: AWSAT ran first, TV has not ──
  // instruments holds AWSAT's own 194 symbols.
  for(let i=1;i<=194;i++)
    await db.query("insert into instruments(market,symbol) values ('Main Market',$1) on conflict do nothing",['CV'+i]);

  const r0=await rec.check(new Set(Array.from({length:194},(_,i)=>'CV'+(i+1))),{day,source:'awsat_client'});
  ck('does NOT compare AWSAT against the registry', r0.checked===false, r0);
  ck('says the check was skipped', r0.expected===0, r0);

  // ── yesterday's watchlist exists -> use it, and say so ──
  const at=new Date();
  for(let i=1;i<=137;i++)
    await db.query(`insert into tradingview_watchlist(symbol,last_price,volume,trading_date,created_at)
      values ($1,100,10,$2,$3)`,['CV'+i,prev,at]);

  const r1=await rec.check(new Set(Array.from({length:194},(_,i)=>'CV'+(i+1))),{day,source:'awsat_client'});
  ck('falls back to the PREVIOUS session', r1.checked===true, r1);
  ck('expects 137, not 194', r1.expected===137, r1.expected);
  ck('flags the reference as stale', r1.referenceIsStale===true, r1.referenceIsStale);
  ck('names the reference day', new Date(r1.referenceDay).toISOString().startsWith('1991-04-03'), r1.referenceDay);
  ck('the 57 extras are reported as extra', r1.extra===57, r1.extra);
  ck('nothing missing when AWSAT is a superset', r1.missing===0, r1.missing);

  // ── today's watchlist wins once TradingView runs ──
  const at2=new Date(at.getTime()+60000);   // distinct capture instant
  for(let i=1;i<=100;i++)
    await db.query(`insert into tradingview_watchlist(symbol,last_price,volume,trading_date,created_at)
      values ($1,100,10,$2,$3)`,['CV'+i,day,at2]);

  const r2=await rec.check(new Set(Array.from({length:80},(_,i)=>'CV'+(i+1))),{day,source:'awsat_client'});
  ck("today's list is preferred", r2.expected===100, r2.expected);
  ck('not stale any more', r2.referenceIsStale===false, r2.referenceIsStale);
  ck('20 genuinely missing are FOUND', r2.missing===20, r2.missing);
  ck('missing tickers are listed', r2.missingSymbols.length===20, r2.missingSymbols.length);
  ck('coverage pct is real', r2.coveragePct===80, r2.coveragePct);

  await clean();
  console.log(`\ncoverage reference: ${p}/${n}`);
  await db.close(); process.exit(p===n?0:1);
})().catch(async e=>{console.error('CRASH:',e.message);await db.close();process.exit(1)});

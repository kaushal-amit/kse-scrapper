// The rules the schema can now enforce, and the boundaries of the regime rule.
process.env.AWSAT_MODE='client';
const db=require('../../src/db/pool');
let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,JSON.stringify(x))};
const fails=async(sql,args)=>{try{await db.query(sql,args);return false;}catch(e){return true;}};
(async()=>{
  await db.query("delete from symbol_day where symbol like 'TM%'");
  await db.query("delete from market_day where trading_date in ('1990-01-01','1990-01-02')");
  const ins=(cols,vals)=>`insert into symbol_day (symbol,trading_date,source${cols})
      values ($1,$2,$3${vals})`;

  // ── RULE 6 · source on every row ──
  ck('a row WITHOUT source is refused',
     await fails("insert into symbol_day(symbol,trading_date) values ('TM1','1990-01-01')"));
  ck('an invalid source is refused',
     await fails(ins('',''),['TM1','1990-01-01','BLOOMBERG']));
  await db.query(ins('',''),['TM1','1990-01-01','AWSAT']);
  ck('AWSAT accepted', true);
  await db.query(ins('',''),['TM2','1990-01-01','TRADINGVIEW']);
  ck('TRADINGVIEW accepted', true);

  // ── RULE 5 · buy_sell_ratio invalid at the offer ──
  // GFH: sits at the offer 98% of minutes. A ratio there is an artifact.
  ck('ratio WITH pct_at_offer 98 is refused',
     await fails(ins(',pct_at_offer,buy_sell_ratio',',$4,$5'),
       ['TMGFH','1990-01-01','AWSAT',98,52]));
  await db.query(ins(',pct_at_offer,buy_sell_ratio',',$4,$5'),
    ['TMGFH','1990-01-01','AWSAT',98,null]);
  const {rows:g}=await db.query("select buy_sell_ratio,pct_at_offer from symbol_day where symbol='TMGFH'");
  ck('S5: GFH ratio NULL, and WHY is recorded',
     g[0].buy_sell_ratio===null && Number(g[0].pct_at_offer)===98, g[0]);

  // below the threshold a ratio is fine
  await db.query(ins(',pct_at_offer,buy_sell_ratio',',$4,$5'),
    ['TMOK','1990-01-01','AWSAT',60,3.2]);
  ck('ratio allowed at 60% at-offer', true);
  ck('exactly 90 is allowed (rule says > 90)',
     !(await fails(ins(',pct_at_offer,buy_sell_ratio',',$4,$5'),
       ['TM90','1990-01-01','AWSAT',90,4.0])));
  ck('90.1 is refused',
     await fails(ins(',pct_at_offer,buy_sell_ratio',',$4,$5'),
       ['TM901','1990-01-01','AWSAT',90.1,4.0]));

  // ── enums ──
  ck('bad data_quality refused',
     await fails(ins(',data_quality',',$4'),['TMQ','1990-01-01','AWSAT','GOOD']));
  ck('FULL accepted',
     !(await fails(ins(',data_quality',',$4'),['TMQ2','1990-01-01','AWSAT','FULL'])));
  ck('bad family refused',
     await fails(ins(',family',',$4'),['TMF','1990-01-01','AWSAT','WHALE']));
  ck('CRAWLER accepted — S9',
     !(await fails(ins(',family',',$4'),['TMALIM','1990-01-01','AWSAT','CRAWLER'])));

  // ── the regime rule, at its boundaries ──
  const r=async(v)=>(await db.query('select regime_of($1) g',[v])).rows[0].g;
  ck('M2: 18 -> RISK_OFF', await r(18)==='RISK_OFF');
  ck('M4: 52 -> RISK_ON', await r(52)==='RISK_ON');
  ck('34.9 -> RISK_OFF', await r(34.9)==='RISK_OFF');
  ck('35 -> NEUTRAL (boundary is inclusive below)', await r(35)==='NEUTRAL');
  ck('50 -> NEUTRAL (boundary is inclusive above)', await r(50)==='NEUTRAL');
  ck('50.1 -> RISK_ON', await r(50.1)==='RISK_ON');
  ck('NULL -> NULL, not a guess', await r(null)===null);
  ck('31 (16 Aug) -> RISK_OFF', await r(31)==='RISK_OFF');
  ck('41 (18 Aug) -> NEUTRAL', await r(41)==='NEUTRAL');
  ck('54 (24 Aug) -> RISK_ON', await r(54)==='RISK_ON');

  ck('bad regime refused by market_day',
     await fails("insert into market_day(trading_date,regime) values ('1990-01-01','BULLISH')"));
  await db.query("insert into market_day(trading_date,pct_advancing,regime) values ('1990-01-02',18,regime_of(18))");
  const {rows:m}=await db.query("select regime from market_day where trading_date='1990-01-02'");
  ck('regime_of usable inline', m[0].regime==='RISK_OFF', m[0]);

  await db.query("delete from symbol_day where symbol like 'TM%'");
  await db.query("delete from market_day where trading_date in ('1990-01-01','1990-01-02')");
  console.log(`\nTMI rules: ${p}/${n}`);
  await db.close(); process.exit(p===n?0:1);
})().catch(async e=>{console.error('CRASH:',e.message);await db.close();process.exit(1)});

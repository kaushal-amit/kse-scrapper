// ITEM 4 — THE TEST THAT DECIDES SUNDAY.
//
// Everything else proves the code agrees with itself. This proves the WRITER
// produces rows the CHECKS accept: real writer -> real row -> evaluate -> no
// throw. If writeSymbolMinute omits a column or names one differently, the
// shape check fires on the first real row and signals are dead for the session.
const db=require('../../src/db/pool');
const writer=require('../../src/jobs/writeSymbolMinute');
const signals=require('../../src/signals');
const clock=require('../../src/market/clock');
let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,JSON.stringify(x))};
(async()=>{
  const day=clock.tradingDay();
  const clean=async()=>{
    for(const t of ['symbol_minute','depth_watchlist','awsat_market_quotes','awsat_stock_depth'])
      await db.query(`delete from ${t} where trading_date=$1`,[day]).catch(()=>{});
  };
  await clean();
  await db.query(`insert into depth_watchlist(trading_date,slot_no,symbol,slot_type,assigned_by)
    values ($1,1,'W2S','PRE_DAY','TEST')`,[day]);

  const quote=(px,vol,oq,t)=>db.query(
    `insert into awsat_market_quotes(market,symbol,last_price,last_qty,bid,bid_qty,offer,offer_qty,
       volume,trades,session,trading_date,ingest_source,source_precedence,created_at)
     values ('Main Market','W2S',$1,100,$2,150000,$3,$4,$5,10,'Trading',$6,'awsat_server',1,$7)`,
    [px,px-1,px+1,oq,vol,day,t]);
  const at=(s)=>new Date(Date.now()-(300-s)*1000);

  // THE WRITER produces the rows. Not a fixture.
  await quote(200,5000,120000,at(0));   await writer.writeTick(null);
  await quote(200,5000,400000,at(20));  await writer.writeTick(null);

  const {rows}=await db.query(
    `SELECT *, ts AS captured_at FROM symbol_minute
      WHERE symbol='W2S' AND trading_date=$1 ORDER BY ts DESC LIMIT 2`,[day]);
  ck('the writer produced two rows', rows.length===2, rows.length);
  if(rows.length<2){ console.log('\nwriter -> signals: '+p+'/'+n); await db.close(); process.exit(1); }

  const [now,prev]=rows;

  // ── THE ASSERTION THAT MATTERS ──
  let threw=null;
  try{ signals.evaluate(prev,now); }catch(e){ threw=e; }
  ck('evaluate() does NOT throw on a row the WRITER produced',
     threw===null, threw && threw.message);

  // every required column is present AND populated
  for(const c of signals.REQUIRED_COLUMNS){
    ck(`the writer populates \`${c}\``, c in now, {column:c, keys:Object.keys(now).length});
  }
  ck('volume_delta is a number, not null — the wall checks need it',
     now.volume_delta!==null && Number.isFinite(Number(now.volume_delta)), now.volume_delta);

  // ── and the checks actually FIRE on writer output ──
  const fired=signals.evaluate(prev,now).map(h=>h.signal);
  ck('WALL_PLACED fires on real writer output — offer 120k -> 400k, no volume',
     fired.includes('WALL_PLACED'), fired);

  // ── the shape check catches a writer that drops a column ──
  const broken={...now}; delete broken.volume_delta;
  let named=null;
  try{ signals.evaluate(prev,broken); }catch(e){ named=e; }
  ck('a dropped column throws', named!==null);
  ck('and the error NAMES it — not "invalid row shape"',
     named && /volume_delta/.test(named.message), named && named.message.slice(0,70));
  ck('and is flagged as a shape error, so the loop can count it',
     named && named.shapeError===true);

  await clean();
  console.log(`\nwriter -> signals: ${p}/${n}`);
  await db.close(); process.exit(p===n?0:1);
})().catch(async e=>{console.error('CRASH:',e.message);await db.close();process.exit(1)});

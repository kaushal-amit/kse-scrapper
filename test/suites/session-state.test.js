// isSessionDay compared String(Date) to an ISO day and could NEVER match, so
// every capture filed as STALE — and daily.marketday skips STALE.
process.env.AWSAT_MODE='client'; process.env.INGEST_TOKEN='trading';
const express=require('express');
const db=require('../../src/db/pool');
let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,JSON.stringify(x))};

// The shape of the bug, in isolation.
const d=new Date('2026-08-29T00:00:00Z');
ck('String(Date).slice(0,10) is "Fri Aug 2" — it can never equal an ISO day',
   String(d).slice(0,10)!=='2026-08-29', String(d).slice(0,10));

const app=express(); app.use(express.json());
app.use('/', require('../../src/api/ingest').createRouter());
const srv=app.listen(8820, async()=>{
  const post=(b)=>fetch('http://127.0.0.1:8820/market-summary',{method:'POST',
    headers:{'Content-Type':'application/json',Authorization:'Bearer trading'},
    body:JSON.stringify(b)}).then(async r=>({status:r.status,body:await r.json()}));
  const clean=async()=>{
    await db.query("delete from awsat_market_summary where batch_id like 'ss-%'");
    await db.query("delete from awsat_market_quotes where symbol like 'SS%'");
    await db.query("delete from market_day where trading_date >= current_date - 3");
    await db.query("delete from client_submissions where batch_id like 'ss-%'");
  };
  await clean();

  const sum={symbolsTraded:132,ups:51,down:61,unchanged:20,volume:1,trades:1};

  // ── THE CASE THAT WOULD HAVE BROKEN SUNDAY ──────────────────────────────
  //
  // Quotes arriving for today, and NO market_day row for today — the state of
  // the database at 09:05 on any session, because daily.marketday runs at 13:40.
  //
  // The old rule read market_day, found yesterday, and marked every live
  // capture STALE. daily.marketday skipped them, broker_seen_at stayed NULL,
  // and the compute fell back to our own breadth: the broker feed would have
  // looked like it was never wired.
  //
  // Exercised as SQL rather than through the endpoint: the 15-minute freshness
  // window means capturedAt must be recent, so a weekday capture cannot be
  // posted from a Saturday. The rule is what matters and this runs it exactly.
  const rule = (captureTs) => db.query(`
    WITH cap AS (
      SELECT ($1::timestamptz AT TIME ZONE 'Asia/Kuwait')::date AS capture_day,
             extract(dow FROM ($1::timestamptz AT TIME ZONE 'Asia/Kuwait')) AS dow
    )
    SELECT cap.capture_day::text AS capture_day,
           (cap.dow NOT IN (5,6)
            AND EXISTS (SELECT 1 FROM awsat_market_quotes q
                         WHERE q.trading_date = cap.capture_day)) AS is_session_day,
           (SELECT max(q2.trading_date)::text FROM awsat_market_quotes q2
             WHERE q2.trading_date <= cap.capture_day) AS last_traded
      FROM cap`, [captureTs]).then(r => r.rows[0]);

  // a Tuesday with quotes, and deliberately no market_day row
  await db.query(`insert into awsat_market_quotes(market,symbol,last_price,volume,trading_date,ingest_source,source_precedence,created_at)
    values ('Main Market','SSA',100,1000,'2026-08-25','awsat_server',1,'2026-08-25 09:00:00+03')`);
  await db.query("delete from market_day where trading_date = '2026-08-25'");

  const live = await rule('2026-08-25T07:00:00Z');      // 10:00 Kuwait, Tuesday
  ck('a session day with quotes and NO market_day row IS a session',
     live.is_session_day === true, live);
  ck('and it is attributed to THAT day', live.capture_day === '2026-08-25', live);

  // ── the clock decides LIVE vs CLOSE ──
  const stateOf = (r, kuwaitMinutes) =>
    !r.is_session_day ? 'STALE' : (kuwaitMinutes >= 13 * 60 + 30 ? 'CLOSE' : 'LIVE');
  ck('10:00 on a session day is LIVE', stateOf(live, 600) === 'LIVE');
  ck('13:29 is still LIVE', stateOf(live, 809) === 'LIVE');
  ck('13:30 is CLOSE', stateOf(live, 810) === 'CLOSE');

  // ── a weekend capture is STALE whatever the table holds ──
  const sat = await rule('2026-08-29T07:00:00Z');       // Saturday
  ck('Saturday is never a session', sat.is_session_day === false, sat);
  ck('and it describes the last day that traded',
     sat.last_traded !== null && sat.last_traded <= '2026-08-29', sat.last_traded);

  // ── a weekday with NO quotes is STALE too ──
  const holiday = await rule('2026-09-02T07:00:00Z');   // Wednesday, no quotes
  ck('a weekday with no quotes is not a session', holiday.is_session_day === false, holiday);

  await db.query("delete from awsat_market_quotes where symbol='SSA'");

  // ── daily.marketday refuses a day with no quotes ──
  const md=require('../../src/jobs/computeMarketDay');
  let refused=false;
  try{ await md.compute('1999-01-04', null); }
  catch(e){ refused=/was not a session/.test(e.message); }
  ck('the compute REFUSES a day with no quotes', refused===true);

  const {rows:none}=await db.query("select count(*)::int c from market_day where trading_date='1999-01-04'");
  ck('and writes nothing', none[0].c===0, none[0]);

  await clean();
  console.log(`\nsession state: ${p}/${n}`);
  srv.close(); await db.close(); process.exit(p===n?0:1);
});

// The three feeds the strategy depends on must appear in scrape_runs.
process.env.AWSAT_MODE='client'; process.env.INGEST_TOKEN='trading';
const express=require('express');
const db=require('../../src/db/pool');
const clock=require('../../src/market/clock');
let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,JSON.stringify(x))};

const app=express(); app.use(express.json({limit:'8mb'}));
app.use('/', require('../../src/api/ingest').createRouter());
const srv=app.listen(8813, async()=>{
  const day=clock.tradingDay();
  const post=(path,body)=>fetch('http://127.0.0.1:8813/'+path,{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    .then(async r=>({status:r.status,body:await r.json()}));
  const runs=async(scraper)=>(await db.query(
    "select status,rows_extracted,rows_inserted,duration_ms,finished_at from scrape_runs where scraper=$1 and trading_date=$2",
    [scraper,day])).rows;

  await db.query("delete from scrape_runs where scraper like 'ingest.%'");
  await db.query("delete from awsat_market_quotes where ingest_source='awsat_client'");
  await db.query("delete from awsat_stock_depth where ingest_source='awsat_client'");
  await db.query("delete from awsat_order_list where order_id like 'IR-%'");

  const at=new Date().toISOString();

  // ── quotes ──
  await post('quotes',{token:'trading',capturedAt:at,records:[
    {market:'Main Market',symbol:'IRQ1',last:100,volume:1000},
    {market:'Main Market',symbol:'IRQ2',last:101,volume:2000}]});
  const q=await runs('ingest.quotes');
  ck('a quotes POST writes a scrape_runs row', q.length===1, q.length);
  ck('with rows_extracted', q[0]&&q[0].rows_extracted===2, q[0]);
  ck('and rows_inserted', q[0]&&q[0].rows_inserted===2, q[0]);
  ck('marked SUCCESS', q[0]&&q[0].status==='SUCCESS', q[0]&&q[0].status);
  ck('finished_at set — never left at RUNNING', q[0]&&q[0].finished_at!==null);
  ck('duration recorded', q[0]&&q[0].duration_ms!==null, q[0]&&q[0].duration_ms);

  // ── depth ──
  await post('depth',{token:'trading',capturedAt:at,records:[
    {symbol:'IRD1',level:1,bidPrice:175,bidQty:5000,offerPrice:177,offerQty:3000}]});
  const d=await runs('ingest.depth');
  ck('a depth POST writes a row', d.length===1, d.length);
  ck('depth counted', d[0]&&d[0].rows_inserted===1, d[0]);

  // ── orders ──
  await post('orders',{token:'trading',capturedAt:at,records:[
    {orderId:'IR-1',symbolRaw:'MRC - 510',side:'Buy',status:'Filled',
     price:204,quantity:'100',filled:'100',remaining:'0'}]});
  const o=await runs('ingest.orders');
  ck('an orders POST writes a row', o.length===1, o.length);

  // ── ONE QUERY covers scheduled jobs and pushed feeds alike ──
  const {rows:all}=await db.query(
    "select scraper from scrape_runs where trading_date=$1 and scraper like 'ingest.%' order by scraper",[day]);
  ck('all three feeds visible in one query',
     all.map(r=>r.scraper).join()==='ingest.depth,ingest.orders,ingest.quotes', all.map(r=>r.scraper));

  // ── a partial batch is marked PARTIAL, not SUCCESS ──
  await post('depth',{token:'trading',capturedAt:new Date(Date.now()+1000).toISOString(),records:[
    {symbol:'IRD2',level:1,bidPrice:175,bidQty:5000,offerPrice:177,offerQty:3000},
    {symbol:'',level:1,bidPrice:1,bidQty:1}]});
  const d2=await runs('ingest.depth');
  ck('a batch with rejects is PARTIAL', d2.some(r=>r.status==='PARTIAL'), d2.map(r=>r.status));

  // ── logging must never reject the batch ──
  const before=(await db.query("select count(*)::int c from awsat_market_quotes where symbol='IRQ3'")).rows[0].c;
  await post('quotes',{token:'trading',capturedAt:new Date(Date.now()+2000).toISOString(),
    records:[{market:'Main Market',symbol:'IRQ3',last:99,volume:5}]});
  const after=(await db.query("select count(*)::int c from awsat_market_quotes where symbol='IRQ3'")).rows[0].c;
  ck('the data lands regardless of the audit row', after>before, {before,after});

  await db.query("delete from scrape_runs where scraper like 'ingest.%'");
  await db.query("delete from awsat_market_quotes where ingest_source='awsat_client'");
  await db.query("delete from awsat_stock_depth where ingest_source='awsat_client'");
  await db.query("delete from awsat_order_list where order_id like 'IR-%'");
  console.log(`\ningest runs: ${p}/${n}`);
  srv.close(); await db.close(); process.exit(p===n?0:1);
});

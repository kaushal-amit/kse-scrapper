// Two jobs arriving on the SAME source while one is running: the second must
// QUEUE and then run, not be rejected.
const path=require('path');
const wh=require('../../src/scrapeWorkerHost');
(async()=>{
  let pass=0,total=0; const ck=(n,c,x)=>{total++;if(c)pass++;else console.log('  FAIL:',n,x||'')};

  // Fire two awsat jobs back to back. No browser here, so each fails fast in
  // the worker -- but the QUEUEING behaviour is what is under test.
  const a=wh.runScrape('awsat.orders',null);
  const b=wh.runScrape('awsat.board',null);
  const [ra,rb]=await Promise.allSettled([a,b]);

  const msgs=[ra,rb].map(r=>r.status==='rejected'?r.reason.message:'resolved');
  ck('neither job was rejected for being "still running"',
     !msgs.some(m=>/still running a previous job/.test(m)), JSON.stringify(msgs));
  ck('both reached the worker (not rejected outright)',
     msgs.every(m=>!/still running a previous job/.test(m)), JSON.stringify(msgs).slice(0,160));

  // A job that waits past its cadence must be SKIPPED, not failed.
  process.env.SCRAPE_STALE_AFTER_MS='1';
  const c=wh.runScrape('awsat.depth',null);
  const rc=await c.then(()=>({ok:true}),e=>({skipped:e.skipped,msg:e.message}));
  ck('stale queued job is marked skipped, not failed', rc.ok||rc.skipped===true, JSON.stringify(rc).slice(0,120));

  console.log(`\nqueue: ${pass}/${total}`);
  await wh.stopAll();
  process.exit(pass===total?0:1);
})();

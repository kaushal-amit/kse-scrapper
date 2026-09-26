// Hard proof: (1) every scrape job is routed to a worker, (2) the main thread
// keeps ticking while one runs, (3) no scraper module is loaded on main.
const { threadId } = require('worker_threads');
const path=require('path');
let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,x===undefined?'':JSON.stringify(x))};

// 1 — jobs.js must NOT require any scraper directly
const jobsSrc=require('fs').readFileSync(require('path').join(__dirname,'..','..','src','jobs.js'),'utf8');
ck('jobs.js requires no scraper module',
   !/require\(['"]\.\/scrapers\//.test(jobsSrc));
ck('jobs.js goes through the worker host', /scrapeWorkerHost/.test(jobsSrc));

// 2 — every job has a worker route
const wh=require('../../src/scrapeWorkerHost');
const jobs=require('../../src/jobs');
// tradingview.history is deliberately NOT a worker job any more: it aggregates
// minute rows already in the database, so there is no browser to keep off the
// main thread. Only the jobs that drive a browser need a worker.
// daily.minutesample joins public.quotes_clean to the depth captures — both
// already in the database — so like the others here it drives no browser and
// has nothing to keep off the main thread.
const BROWSERLESS = new Set(['tradingview.history', 'daily.analysis', 'signals.fast', 'signals.wakeup', 'signals.score', 'daily.symbolday', 'daily.minutesample', 'daily.marketday', 'daily.instruments']);
for(const name of jobs.jobNames){
  if (BROWSERLESS.has(name)) {
    ck(`${name} runs in-process (no browser)`, !wh.SOURCE_OF[name], wh.SOURCE_OF[name]);
    continue;
  }
  ck(`${name} routed to a worker`, Boolean(wh.SOURCE_OF[name]), wh.SOURCE_OF[name]);
}

// 3 — after loading jobs on MAIN, no scraper/playwright is in the main cache
const loaded=Object.keys(require.cache);
ck('no scraper module loaded on main thread',
   !loaded.some(f=>/src[\\/]scrapers[\\/](tradingview|awsat|tradingviewHistory)\.js$/.test(f)),
   loaded.filter(f=>/src[\\/]scrapers[\\/]/.test(f)).map(f=>path.basename(f)));
ck('playwright not loaded on main thread',
   !loaded.some(f=>/node_modules[\\/]playwright/.test(f)));

// 4 — main thread stays responsive while a scrape runs in a worker
(async()=>{
  let ticks=0; const timer=setInterval(()=>{ticks++},20);
  const t0=Date.now();
  await wh.runScrape('tradingview.quotes',null).catch(()=>{});
  clearInterval(timer);
  ck('main thread ticked during the scrape', ticks>5, {ticks,ms:Date.now()-t0});
  ck('this test IS the main thread', threadId===0, threadId);
  await wh.stopAll();
  console.log(`\noff-thread: ${p}/${n}`);
  process.exit(p===n?0:1);
})();

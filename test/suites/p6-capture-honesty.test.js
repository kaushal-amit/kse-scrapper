'use strict';
/**
 * P6 · THE CAPTURE PATHS SAY WHAT THEY ACTUALLY GOT.
 *
 * Every check here stands for one way a scrape could report success while
 * storing wrong, partial or stale data:
 *
 *  P6-AWS-1 · a failed AWSAT login latched for the life of the worker, and
 *             every job after it was SKIPPED — no rows, no alarm, all session.
 *  P6-AWS-2 · the socket tap's rows are never expired, so a dead websocket was
 *             re-stored every cycle as a live board.
 *  P6-AWS-3 · a depth sweep in which every symbol failed returned zero levels
 *             and was recorded SUCCESS.
 *  P6-AWS-5 · the DOM board path put raw text into a `time` column, failing the
 *             cast and rejecting whole chunks of quotes row by row.
 *  P6-AWS-7 · the depth sweep could outlive its worker timeout and lose every
 *             book it had already read.
 *  P6-AWS-9 · a crossed touch — a half-rendered panel — was stored as a book.
 *  P6-TV-1  · a backfill that failed 130 of 137 symbols reported SUCCESS.
 *  P6-TV-2  · a symbol whose whole history is inside the window never ended its
 *             scroll loop early.
 *  P6-TV-3  · a truncated TradingView board became the coverage REFERENCE.
 *  P6-TV-4  · "1.24M" volume was parsed as 1.
 *  P6-TV-5  · change_value meant two different things on the two write paths.
 *  P6-CLI-1/2 · the orders userscript latched `partial` and its message.
 *  P6-CLI-3 · the retry queue was twice the server's accept window, and the
 *             overflow was dropped silently.
 *  P6-CLI-4 · order_time was NULL on every client-path row.
 *  P6-CLI-5 · the frozen-board alarm fired every day after the close.
 *  P6-CLI-6 · a holiday looked like a session because the client's own frozen
 *             posts created the evidence.
 *  P6-CLI-7 · the market summary sent "845.96M" as 845.96.
 */
const fs = require('fs');
const path = require('path');
const { requireTestDb } = require('../dbguard');
requireTestDb('p6-capture-honesty');

const { close } = require('../../src/db/pool');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };
const ROOT = path.join(__dirname, '..', '..');
const src = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

(async () => {
  // ── behaviour ────────────────────────────────────────────────────────────
  const validate = require('../../src/validate');
  const base = {
    symbol: 'P6T', level: 1, created_at: new Date(), trading_date: '2026-09-21',
    bid_qty: 1000, offer_qty: 1000,
  };
  ck('P6-AWS-9 · a crossed touch is refused',
    validate.validateDepthLevel({ ...base, bid: 250, offer: 249 }).ok === false);
  ck('  and the reason names it',
    /crossed touch/.test(validate.validateDepthLevel({ ...base, bid: 250, offer: 250 }).reason || ''));
  ck('  an ordinary touch still passes',
    validate.validateDepthLevel({ ...base, bid: 249, offer: 250 }).ok === true);
  ck('  a crossed DEEPER level is left alone (levels sit inside the touch mid-update)',
    validate.validateDepthLevel({ ...base, level: 3, bid: 250, offer: 249 }).ok === true);

  const hist = require('../../src/scrapers/historyTransform');
  const num = hist.parseNumeric || (hist.__test && hist.__test.parseNumeric);
  if (typeof num === 'function') {
    ck('P6-TV-4 · abbreviated volume is scaled', num('1.24M') === 1240000 && num('845.96K') === 845960
      && num('2.1B') === 2100000000, { m: num('1.24M'), k: num('845.96K'), b: num('2.1B') });
    ck('  and an ordinary number is untouched', num('1,234.5') === 1234.5 && num('—') === null);
  } else {
    ck('P6-TV-4 · parseNumeric handles K/M/B (checked in source — not exported)',
      /\[KMB\]/.test(src('src/scrapers/historyTransform.js')));
  }

  const { clientOrderTime } = require('../../src/api/ingest');
  ck('P6-CLI-4 · a bare clock is read on the batch day, in Kuwait (+03:00)',
    clientOrderTime('09:31:05', '2026-09-21').toISOString() === '2026-09-21T06:31:05.000Z',
    String(clientOrderTime('09:31:05', '2026-09-21')));
  ck('  a dated stamp keeps its own day',
    clientOrderTime('25-08-2026 13:14:10', '2026-09-21').toISOString() === '2026-08-25T10:14:10.000Z');
  ck('  and anything unreadable is NULL, never a guess',
    clientOrderTime('', '2026-09-21') === null && clientOrderTime(null, '2026-09-21') === null
    && clientOrderTime('n/a', '2026-09-21') === null);

  const thresholds = require('../../src/config/thresholds');
  for (const k of ['board_coverage_min_pct', 'awsat_login_retry_cooldown_ms',
    'awsat_socket_max_frame_age_ms', 'awsat_depth_sweep_ms', 'history_symbol_ms']) {
    ck(`the ${k} budget is a threshold, not a literal`, Number.isFinite(thresholds.get(k)));
  }

  // ── the paths, in source ─────────────────────────────────────────────────
  const aws = src('src/scrapers/awsat.js');
  ck('P6-AWS-1 · the login latch is a COOLDOWN that clears itself',
    /loginFailedAt = 0;\s*$/m.test(aws) && /LOGIN_RETRY_COOLDOWN_MS/.test(aws)
    && !/let loginFailed = false;/.test(aws));
  ck('P6-AWS-2 · a socket with no recent frame refuses instead of storing',
    /data\.lastFrameAgeMs > maxFrameAgeMs/.test(aws) && /dead feed as a live board/.test(aws));
  ck('P6-AWS-5 · last_trade_time goes through parse.toTime',
    /col === 'last_trade_time'\) row\[col\] = parse\.toTime\(raw\)/.test(aws));
  ck('P6-AWS-7 · the depth sweep stops at its own budget and returns what it read',
    /Date\.now\(\) > deadline/.test(aws) && /return \{ levels, symbols: \[\], wanted \};/.test(aws));

  ck('P6-AWS-4 · a sweep that stalled before the bottom is reported truncated',
    /atBottom = await boardPage\.evaluate/.test(aws) && /truncated = true;/.test(aws)
    && /return \{ quotes, symbols, truncated \};/.test(aws));

  ck('P6-TV-6 · the worker kill sits above the quotes job\'s own budget',
    Number(/'tradingview\.quotes': ([0-9_]+)/.exec(src('src/scrapeWorkerHost.js'))[1].replace(/_/g, ''))
      > 60_000 + 30_000 + Number(process.env.TV_SCRAPE_TIMEOUT_MS || 90_000));

  const jobs = src('src/jobs.js');
  ck('P6-AWS-4 · and the board job records it as PARTIAL',
    /const finalStatus = truncated \? 'PARTIAL' : status;/.test(jobs));
  ck('P6-AWS-3 · a depth sweep with slots and no levels is PARTIAL',
    /status: 'PARTIAL', skipped: asked/.test(jobs));
  ck('P6-TV-3 / P6-AWS-8 · both boards are measured against the universe',
    /async function coverageStatus/.test(jobs)
    && /coverageStatus\(new Set\(quotes\.map\(\(q\) => q\.symbol\)\), 'tradingview'\)/.test(jobs)
    && /coverageStatus\(new Set\(quotes\.map\(\(q\) => q\.symbol\)\), 'awsat_server'\)/.test(jobs));
  ck('P6-TV-1 · the backfill counts its failed symbols and goes PARTIAL',
    /const \{ rows, failures, skipped \} = await workerHost\.runScrape\('tradingview\.backfill'/.test(jobs)
    && /rejected: res\.rejected \+ failed/.test(jobs));
  ck('P6-TV-9 · both ends of the backfill window are Kuwait days',
    /clock\.tradingDay\(new Date\(Date\.now\(\) - days \* 86400_000\)\)/.test(jobs));

  const tvh = src('src/scrapers/tradingviewHistory.js');
  ck('P6-TV-2 · the scroll ends on exhaustion and on a per-symbol clock',
    /exhausted = true;/.test(tvh) && /symbolDeadline/.test(tvh));

  const fin = src('src/jobs/historyFinalise.js');
  ck('P6-TV-5 · change is the venue\'s, else the previous CLOSE — never close - open',
    /prev_close/.test(fin) && !/values\.push\([^)]*close - open/.test(fin));
  ck('P6-TV-7 · only the symbols this run finalised are stamped',
    /AND symbol = ANY\(\$2::text\[\]\)/.test(fin));
  ck('P6-TV-8 · the bar carries its run_id', /volume, change_value, change_pct, run_id\)/.test(fin));

  const ing = src('src/api/ingest.js');
  ck('P6-CLI-5 · the frozen-board check runs inside the window only',
    /clock\.isWithinWindow\(new Date\(when\.capturedAt\)\)/.test(ing));
  ck('P6-CLI-6 · a holiday is not a session, whatever the quotes say',
    /clock\.isTradingDay\(captured\)/.test(ing));
  ck('P6-CLI-8 · "today" is the Kuwait day on both reads',
    !/= CURRENT_DATE/.test(ing) && !/CURRENT_DATE,/.test(ing)
    && (ing.match(/now\(\) AT TIME ZONE 'Asia\/Kuwait'\)::date/g) || []).length >= 2);

  const orders = src('userscript/awsat-orders.user.js');
  ck('P6-CLI-1/2 · the per-scan fields are reset at the start of every scan',
    /stats\.shortBy = 0;\s*\n\s*stats\.msg = null;/.test(orders));
  ck('  and a non-scrolling grid can still report short',
    /grid does not scroll/.test(orders) && /stats\.expected = expectedRowCount\(body\);/.test(orders));
  ck('P6-CLI-4 · the placement stamp is forwarded', /stamp: rec\.stamp \|\| null,/.test(orders));

  for (const f of ['awsat-capture', 'awsat-orders', 'awsat-depth-all', 'awsat-market-summary']) {
    const u = src(`userscript/${f}.user.js`);
    ck(`P6-CLI-3 · ${f} drops batches past the server's accept window, and counts them`,
      /function dropStale\(queue, statsObj\)/.test(u) && /dropStale\(retryQueue, stats\);/.test(u)
      && /stats\.dropped = \(stats\.dropped \|\| 0\) \+ 1;/.test(u));
  }
  ck('P6-CLI-7 · the market summary scales K/M/B before sending',
    /mult = \{ K: 1e3, M: 1e6, B: 1e9 \}/.test(src('userscript/awsat-market-summary.user.js')));

  console.log(`\n  p6-capture-honesty: ${p}/${n}`);
  await close();
  process.exit(p === n ? 0 : 1);
})().catch((e) => { console.log('p6 ERROR', e); process.exit(1); });

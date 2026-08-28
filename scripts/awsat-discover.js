'use strict';
/**
 * scripts/awsat-discover.js — what does the AWSAT socket actually carry?
 *
 *   HEADLESS=false xvfb-run -a npm run awsat:discover
 *
 * Logs in ONCE, watches the socket for a configurable window, and reports every
 * message type with its field names and sample frames.
 *
 * ─── WHY THIS EXISTS ───────────────────────────────────────────────────────
 * Quotes are confirmed to arrive over the socket. Depth and the order list are
 * not — they are still read from the DOM, which is where the scroll, blind-band
 * and panel-selector problems live. The honest options were to guess a message
 * type or to measure one, and a wrong guess writes plausible-looking rows into
 * order_book_levels that are not depth at all.
 *
 * This measures. It consumes one login attempt, so it is a deliberate
 * one-command run rather than something the scheduler does.
 */

const fs = require('fs');
const path = require('path');
const { config } = require('../src/config');
const awsat = require('../src/scrapers/awsat');
const tap = require('../src/scrapers/awsatSocketTap');
const log = require('../src/logger');

const WATCH_MS = Number(process.env.DISCOVER_WATCH_MS || 90_000);
const OUT_DIR = path.resolve(__dirname, '..', 'tmp');

/** Field names that would identify a frame as depth rather than a quote. */
const DEPTH_HINTS = /^(lvl|level|dpt|depth|bid\d|ask\d|bp\d|bq\d|ap\d|aq\d|mbp|mdp)/i;
const ORDER_HINTS = /^(ord|order|oid|ordid|ordsts|ordqty|filled|exec)/i;

function classify(fields) {
  const names = fields.map((f) => f.replace(/\(\d+\)$/, ''));
  if (names.some((n) => DEPTH_HINTS.test(n))) return 'looks like DEPTH';
  if (names.some((n) => ORDER_HINTS.test(n))) return 'looks like ORDERS';
  if (names.includes('ltp') || names.includes('bbp')) return 'quotes (already consumed)';
  return 'unclassified';
}

async function main() {
  if (config.runtime.headless) {
    console.error('\n  Set HEADLESS=false — AWSAT login stalls headless.\n');
    process.exit(1);
  }

  console.log(`\n  AWSAT SOCKET DISCOVERY`);
  console.log(`  watching for ${WATCH_MS / 1000}s after login`);
  console.log(`  ${'─'.repeat(72)}\n`);

  // Reuse the scraper's own session so this costs ONE login, shared with
  // nothing else. scrapeBoard establishes it and leaves the page open.
  await awsat.scrapeBoard({ runId: null }).catch((err) => {
    log.warn('board scrape reported an error; continuing to watch the socket', {
      err: err.message.split('\n')[0],
    });
  });

  const page = awsat.sharedPageForDiagnostics && awsat.sharedPageForDiagnostics();
  if (!page) {
    console.error('  no session page available — login did not complete.\n');
    process.exit(1);
  }

  // Let the socket run. Depth frames may only appear once a symbol's book is
  // opened, so this is also the window in which to click one by hand.
  console.log('  Watching... open a stock\'s DEPTH panel and the ORDER list now,');
  console.log('  so any frames those trigger are captured.\n');
  await new Promise((r) => setTimeout(r, WATCH_MS));

  const found = await tap.discover(page);
  if (!found.ready) {
    console.error('  the tap never initialised — window.__awsatTap is absent.\n');
    process.exit(1);
  }

  console.log(`  frames: ${found.frames}   master rows: ${found.masterRows}   symbols: ${found.boardSymbols}\n`);

  console.log('  SOCKETS OPENED BY THE APP');
  for (const s of found.sockets) {
    console.log(`    ${s.tapped ? '[tapped]' : '[ignored]'} ${s.url}`
      + (s.frames ? `  (${s.frames} frames)` : ''));
  }

  console.log('\n  MESSAGE TYPES ON THE QUOTE SOCKET');
  const types = Object.entries(found.messageTypes).sort((a, b) => b[1].count - a[1].count);
  for (const [type, v] of types) {
    console.log(`\n    type "${type}"  ${v.count} frames   -> ${classify(v.fields)}`);
    console.log(`      fields: ${v.fields.slice(0, 25).join(' ')}`);
    for (const sample of v.samples.slice(0, 2)) console.log(`      sample: ${sample}`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `awsat-discovery-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(found, null, 2));

  console.log(`\n  ${'─'.repeat(72)}`);
  console.log(`  full report: ${file}`);
  console.log('\n  If a type is marked "looks like DEPTH" or "looks like ORDERS", send this');
  console.log('  file and those readers can be wired to the socket instead of the DOM.');
  console.log('  If ONLY quote types appear even after opening a depth panel, then depth');
  console.log('  does not come over this socket and the DOM path is correct for it.\n');

  await awsat.closeSession();
  process.exit(0);
}

main().catch(async (err) => {
  console.error(`\n  discovery failed: ${err.message}\n`);
  await awsat.closeSession().catch(() => {});
  process.exit(1);
});

'use strict';
/**
 * scripts/probe-tradingview.js — what is the watchlist page actually serving?
 *
 *   npm run tv:probe
 *   npm run tv:probe -- --headed
 *
 * Rewritten for the data-qa-id reader. The previous version still referenced
 * ROW_SELECTORS, a list of CSS row selectors from an earlier design, and failed
 * with "not iterable" — it was probing an implementation that no longer exists,
 * which is worse than no probe because it looks like a page fault.
 *
 * It runs the SAME navigation and the SAME cell lookups as the scraper, so a
 * green probe means the scraper will work, not merely that the page loaded.
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { config } = require('../src/config');
const helpers = require('../src/browser/pageHelpers');
const { loadCookies, COOKIES_PATH } = require('../src/browser/browser');
const tv = require('../src/scrapers/tradingview');

const HEADED = process.argv.includes('--headed');
const line = (l, v) => console.log(`  ${String(l).padEnd(20)} ${v}`);

async function main() {
  console.log('\n  TRADINGVIEW PROBE');
  console.log(`  ${'─'.repeat(72)}`);
  line('url', config.tradingview.url);
  line('mode', HEADED ? 'headed' : 'headless');

  const cookies = loadCookies();
  line('cookies', cookies ? `${cookies.length} loaded` : `none (${COOKIES_PATH})`);
  line('cells sought', Object.values(tv.CELL).join(', '));
  console.log(`  ${'─'.repeat(72)}\n`);

  const browser = await chromium.launch({
    headless: !HEADED,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage',
      ...(process.env.CHROMIUM_SINGLE_PROCESS === 'true'
        ? ['--no-zygote', '--single-process', '--disable-gpu', '--disable-software-rasterizer'] : [])],
  });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  if (cookies) await context.addCookies(cookies).catch(() => {});
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  await helpers.blockHeavyResources(page);

  try {
    console.log('  [1] navigating ...');
    await page.goto(config.tradingview.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    line('landed on', page.url());
    line('title', await page.title().catch(() => '(none)'));

    console.log('\n  [2] dismissing overlays ...');
    const a = await helpers.dismissModals(page);
    await page.waitForTimeout(1_000);
    const b = await helpers.dismissModals(page);
    line('dismissed', [a, b].filter(Boolean).join(', ') || 'nothing');

    // The check that distinguishes an expired session from moved selectors.
    console.log('\n  [3] session ...');
    await page.waitForTimeout(2_000);
    const loggedIn = await page.evaluate(() => Boolean(
      document.querySelector('[data-name="header-user-menu-button"]')
      || document.querySelector('[class*="userMenuButton"]')
      || document.querySelector('[class*="header-user-menu"]'),
    )).catch(() => false);
    line('logged in', loggedIn ? 'yes' : 'NO — run npm run tv:login');

    console.log('\n  [4] waiting for symbol cells ...');
    const appeared = await page
      .waitForSelector(`[data-qa-id="${tv.CELL.symbol}"]`, { timeout: 30_000 })
      .then(() => true).catch(() => false);
    line('symbol cells', appeared ? 'present' : 'NOT FOUND within 30s');

    // Every data-qa-id on the page, so a moved identifier names its replacement.
    const ids = await page.evaluate(() => [...new Set(
      [...document.querySelectorAll('[data-qa-id]')].map((e) => e.getAttribute('data-qa-id')),
    )].slice(0, 40)).catch(() => []);
    console.log(`\n  [5] data-qa-id values on the page (${ids.length}):`);
    console.log(`    ${ids.join(', ') || '(none)'}`);

    if (!appeared) {
      const art = await helpers.saveFailureArtifacts(page, 'tv-probe');
      console.log('\n  Only marketing chrome usually means a logged-out page.');
      if (art) console.log(`  screenshot: ${art.base}.png`);
      return;
    }

    console.log('\n  [6] reading rows exactly as the scraper does ...');
    const rows = await tv.readVisibleRows(page);
    line('rows visible', rows.length);
    if (rows.length) {
      console.log('\n  first three, as they would be stored:');
      for (const r of rows.slice(0, 3)) {
        const q = tv.toQuote(r, {
          tradingDay: '1970-01-01', capturedAt: new Date(), runId: null,
        });
        if (!q) continue;
        console.log(`    ${String(q.symbol).padEnd(10)} last=${q.last_price}  chg%=${q.pct_chg}`
          + `  vol=${q.volume}  avgVol=${q.avg_volume}  mcap=${q.market_cap}`);
      }

      const quotes = rows.map((r) => tv.toQuote(r, {
        tradingDay: '1970-01-01', capturedAt: new Date(), runId: null,
      })).filter(Boolean);
      const withPrice = quotes.filter((q) => q.last_price !== null).length;
      const pct = quotes.length ? Math.round((withPrice / quotes.length) * 100) : 0;
      console.log('');
      line('price coverage', `${pct}%  ${pct >= 50 ? 'OK' : '<-- the scraper would REFUSE this'}`);
      if (pct < 50) {
        console.log('    The value cells have moved. Set TV_QA_LAST and friends to ids above.');
      }
    }

    const art = await helpers.saveFailureArtifacts(page, 'tv-probe');
    console.log(`\n  ${'─'.repeat(72)}`);
    if (art) console.log(`  screenshot ${art.base}.png\n  html       ${art.base}.html`);
    console.log('');
  } finally {
    if (HEADED) await page.waitForTimeout(10_000);
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`\n  probe failed: ${err.message}\n`);
  process.exit(1);
});

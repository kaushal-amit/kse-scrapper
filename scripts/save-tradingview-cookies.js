'use strict';
/**
 * scripts/save-tradingview-cookies.js — capture a TradingView session, once.
 *
 *   npm run tv:login
 *
 * Opens a real browser window. Log in by hand — including any captcha or
 * two-factor step — then press Enter in this terminal. The cookies are written
 * to secrets/tradingview-cookies.json and reused by the scraper.
 *
 * WHY LOG IN AT ALL for public market pages: an anonymous session is served
 * more interstitials and promos, and an overlay covering the board is the most
 * common reason a scrape returns zero rows. A logged-in session sees fewer.
 *
 * The file holds a live session. It is gitignored; treat it like a password.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { chromium } = require('playwright');
const { COOKIES_PATH } = require('../src/browser/browser');

const START_URL = process.env.TRADINGVIEW_LOGIN_URL || 'https://www.tradingview.com/#signin';

async function waitForEnter(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((resolve) => rl.question(prompt, resolve));
  rl.close();
}

async function main() {
  console.log('\n  A browser window will open.');
  console.log('  Log in to TradingView by hand, then come back here and press Enter.\n');

  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
  });
  const page = await context.newPage();
  await page.goto(START_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});

  await waitForEnter('  Press Enter once you are logged in... ');

  const cookies = await context.cookies();
  if (!cookies.length) {
    console.error('\n  No cookies found. Was the login completed?\n');
    process.exitCode = 1;
  } else {
    fs.mkdirSync(path.dirname(COOKIES_PATH), { recursive: true });
    fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2), 'utf8');
    // Owner-only: this file is a live session.
    fs.chmod(COOKIES_PATH, 0o600, () => {});
    console.log(`\n  Saved ${cookies.length} cookies to ${COOKIES_PATH}`);
    console.log('  Verify with: npm run tv:probe\n');
  }

  await context.close().catch(() => {});
  await browser.close().catch(() => {});
}

main().catch((err) => {
  console.error(`\n  could not save cookies: ${err.message}\n`);
  process.exit(1);
});

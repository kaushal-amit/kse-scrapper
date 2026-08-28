'use strict';
/**
 * Playwright browser lifecycle.
 *
 * ONE BROWSER, REUSED. Launching Chromium costs a couple of seconds and tens of
 * megabytes. Doing that every minute would spend more time starting browsers
 * than scraping. The instance is kept and only relaunched once it has died.
 *
 * SERIALISED. All AWSAT tasks share one browser and one logged-in session, so
 * they must not overlap: two tasks driving the same terminal interleave their
 * clicks and each ends up reading the other's screen. `withPage` is the only
 * way in, and it holds a simple mutex.
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { config } = require('../config');
const log = require('../logger');

/**
 * Saved TradingView cookies, if present.
 *
 * The public market pages do not strictly require a session, but a logged-in
 * one is served fewer interstitials and fewer promos — and an overlay is the
 * most common reason a scrape comes back with zero rows. Capture them once with
 * `npm run tv:login`.
 *
 * Absent cookies are not an error; the scrape simply runs anonymously.
 */
const COOKIES_PATH = process.env.TRADINGVIEW_COOKIES
  || path.resolve(__dirname, '..', '..', 'secrets', 'tradingview-cookies.json');

function loadCookies() {
  try {
    if (!fs.existsSync(COOKIES_PATH)) return null;
    const raw = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8'));
    const cookies = Array.isArray(raw) ? raw : raw.cookies;
    if (!Array.isArray(cookies) || !cookies.length) return null;
    return cookies;
  } catch (err) {
    log.warn('could not read the cookie file — continuing without a session', {
      path: COOKIES_PATH, err: err.message,
    });
    return null;
  }
}

let browser = null;
let queue = Promise.resolve();      // serialises access

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;

  if (browser) log.warn('browser was disconnected — relaunching');
  browser = await chromium.launch({
    headless: config.runtime.headless,
    // CHROMIUM_PATH lets a container supply its own browser when Playwright's
    // bundled download is unavailable (an offline build, a blocked CDN, or a
    // base image that already ships one). Unset, Playwright uses its own.
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      // Chromium's zygote pre-forks renderer processes, which needs namespace
      // permissions many containers do not grant. Without these it launches,
      // reports a version, and then hangs on the first page — a failure that
      // looks like a slow site rather than a browser that cannot render.
      ...(process.env.CHROMIUM_SINGLE_PROCESS === 'true'
        ? ['--no-zygote', '--single-process', '--disable-gpu', '--disable-software-rasterizer']
        : []),
    ],
  });
  log.info('browser launched', { headless: config.runtime.headless });
  return browser;
}

/**
 * Run `fn(page)` on a fresh page, serialised against every other caller.
 *
 * The page and context are always closed, including when fn throws. A leaked
 * page keeps its memory and its listeners for the life of the process, and over
 * a four-hour session that is the whole of a slow memory climb.
 */
async function withPage(fn, { timeoutMs = 60_000, useCookies = false } = {}) {
  const run = queue.then(async () => {
    const b = await getBrowser();
    const context = await b.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
        + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });
    if (useCookies) {
      const cookies = loadCookies();
      if (cookies) {
        await context.addCookies(cookies).catch((err) => {
          log.warn('cookies could not be applied', { err: err.message });
        });
        log.debug('session cookies applied', { count: cookies.length });
      }
    }

    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    try {
      return await fn(page);
    } finally {
      await page.close().catch(() => {});
      await context.close().catch(() => {});
    }
  });

  // Keep the chain alive even when this task fails, or every later task
  // inherits the rejection and the scraper stops for the rest of the day.
  queue = run.catch(() => {});
  return run;
}

async function closeBrowser() {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
    log.info('browser closed');
  }
}

module.exports = { withPage, closeBrowser, getBrowser, loadCookies, COOKIES_PATH };

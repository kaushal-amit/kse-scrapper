'use strict';
/**
 * TradingView watchlist — live board, once a minute.
 *
 * ─── PORTED FROM A WORKING IMPLEMENTATION ──────────────────────────────────
 * An earlier version of this file guessed at the markup: `table tbody tr`,
 * `[role="row"]`, `div[class*="row-"]`. The watchlist is none of those, and the
 * last one matched the widget's TAB STRIP — one "row" reading
 * "Price Financials Performance Risk". That is why every run returned nothing.
 *
 * The structure is:
 *
 *     [data-qa-id="column-symbol"]          <- the SYMBOL CELL, not the row
 *       .parentElement                      <- the actual row
 *         [data-qa-id="column-last_price"]  <- sibling cells, by their own id
 *         [data-qa-id="column-change_percent"]
 *         ...
 *
 * So a row is found via its symbol cell's PARENT, and every other value is a
 * sibling looked up by its own `data-qa-id`. Attribute-addressed throughout,
 * which is what makes it survive a restyle: TradingView's class names are
 * content hashes that change on every deploy, and `data-qa-id` is their own
 * test hook and stays put.
 *
 * The scroll handling is ported for the same reason — see the note on `step`.
 */

const { withPage, loadCookies } = require('../browser/browser');
const helpers = require('../browser/pageHelpers');
const { config } = require('../config');
const clock = require('../market/clock');
const parse = require('./parse');
const log = require('../logger');

const SOURCE = 'tradingview';

/**
 * TradingView's own QA identifiers. Overridable, because they are stable but
 * not guaranteed, and a change here should not need a code deploy.
 */
const CELL = {
  symbol: process.env.TV_QA_SYMBOL || 'column-symbol',
  lastPrice: process.env.TV_QA_LAST || 'column-last_price',
  changePercent: process.env.TV_QA_CHANGE_PCT || 'column-change_percent',
  change: process.env.TV_QA_CHANGE || 'column-change',
  volume: process.env.TV_QA_VOLUME || 'column-volume',
  // The table has avg_volume and market_cap columns and nothing was filling
  // them. Both are on the row already — the reference userscript reads exactly
  // these two ids — so not collecting them was a gap, not a limitation.
  avgVolume: process.env.TV_QA_AVG_VOLUME || 'column-average_volume',
  marketCap: process.env.TV_QA_MARKET_CAP || 'column-market_cap_basic',
};

const MIN_PRICE_COVERAGE = 0.5;

/**
 * The market label carried on TradingView rows.
 *
 * TradingView rows now land in their own table, which has no market column, so
 * this label is no longer part of any key. It is kept because validate.js still
 * requires a market — and because it stays meaningful if these rows are ever
 * read alongside the broker's.
 *
 * Caught by running the scraper against a real browser: every row extracted
 * cleanly and every row was then rejected as "no market", while the run still
 * reported SUCCESS.
 */
const TV_MARKET = process.env.TRADINGVIEW_MARKET || 'TRADINGVIEW';
const MAX_SCROLLS = Number(process.env.TV_MAX_SCROLLS || 120);
const SCRAPE_TIMEOUT_MS = Number(process.env.TV_SCRAPE_TIMEOUT_MS || 90_000);

/**
 * Measure the scrolling container instead of assuming there is one.
 *
 * The watchlist is virtualised inside its own scroll box, so `window.scrollTo`
 * moves the page and the list ignores it completely — which is exactly what a
 * board that renders its chrome and no rows looks like.
 */
async function measureGeometry(page) {
  return page.evaluate((symbolQa) => {
    const firstCell = document.querySelector(`[data-qa-id="${symbolQa}"]`);
    let node = firstCell;
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 4) {
        return {
          usesWindow: false,
          clientHeight: node.clientHeight,
          scrollHeight: node.scrollHeight,
        };
      }
      node = node.parentElement;
    }
    return {
      usesWindow: true,
      clientHeight: window.innerHeight,
      scrollHeight: document.documentElement.scrollHeight,
    };
  }, CELL.symbol);
}

/** Read every row currently rendered, in ONE evaluate call. */
async function readVisibleRows(page) {
  return page.evaluate((cells) => {
    // Bidi and zero-width marks are invisible in a log and break every regex
    // that does not strip them first.
    const clean = (t) => (t || '')
      .replace(/[\u202A\u202B\u202C\u200E\u200F]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    const rows = document.querySelectorAll(`[data-qa-id="${cells.symbol}"]`);
    return Array.from(rows).map((cell) => {
      const row = cell.parentElement;
      const text = (qa) => clean(row?.querySelector(`[data-qa-id="${qa}"]`)?.textContent);
      const anchor = cell.querySelector('a');
      const spans = cell.querySelectorAll('span');

      return {
        symbolText: clean(anchor?.querySelector('span')?.textContent || cell.textContent),
        companyName: clean(spans[spans.length - 1]?.textContent),
        lastPrice: text(cells.lastPrice),
        changePercent: text(cells.changePercent),
        change: text(cells.change),
        volume: text(cells.volume),
        avgVolume: text(cells.avgVolume),
        marketCap: text(cells.marketCap),
      };
    });
  }, CELL);
}

/**
 * Scroll one step and report whether the bottom has been reached.
 *
 * The step is HALF the viewport, giving ~50% overlap between consecutive
 * positions so no row can fall between two reads regardless of row height. A
 * full-viewport step assumes the two line up exactly; when they do not, a band
 * of symbols is never rendered while any single read looks perfectly healthy.
 */
async function scrollStep(page, step) {
  return page.evaluate((args) => {
    const first = document.querySelector(`[data-qa-id="${args.symbolQa}"]`);
    let node = first;
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 4) {
        node.scrollTop += args.step;
        return node.scrollTop + node.clientHeight >= node.scrollHeight - 2;
      }
      node = node.parentElement;
    }
    window.scrollBy(0, args.step);
    return window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
  }, { step, symbolQa: CELL.symbol });
}

/** Turn one raw row into a quote. Pure, so it is testable without a browser. */
function toQuote(row, meta) {
  const symbol = parse.toSymbol(row.symbolText);
  if (!symbol) return null;

  return {
    symbol,
    market: TV_MARKET,
    last_price: parse.toNumber(row.lastPrice),
    chg: parse.toNumber(row.change),
    pct_chg: parse.toNumber(row.changePercent),
    open_price: null,
    high_price: null,
    low_price: null,
    bid: null,
    bid_qty: null,
    offer: null,
    offer_qty: null,
    volume: (() => {
      const n = parse.toNumber(row.volume);
      return n === null ? null : Math.round(n);
    })(),
    avg_volume: (() => {
      const n = parse.toNumber(row.avgVolume);
      return n === null ? null : Math.round(n);
    })(),
    market_cap: parse.toNumber(row.marketCap),
    trades: null,
    code: null,
    description: row.companyName || null,
    scrape_batch_id: meta.batchId || null,
    trading_date: meta.tradingDay,
    source: SOURCE,
    ingest_source: 'tradingview',
    source_precedence: 0,
    run_id: meta.runId,
    created_at: meta.capturedAt,
  };
}

async function scrape({ runId }) {
  const capturedAt = new Date();
  const meta = {
    tradingDay: clock.tradingDay(capturedAt),
    capturedAt,
    runId,
    batchId: require('crypto').randomUUID(),
  };

  // A private watchlist without a session renders its chrome and no symbols,
  // which is indistinguishable from a broken selector and is not one.
  if (/\/watchlists?\//i.test(config.tradingview.url) && !loadCookies()) {
    throw new Error(
      'This is a private TradingView watchlist and there is no saved session.\n'
      + `  url: ${config.tradingview.url}\n`
      + '  Run: npm run tv:login',
    );
  }

  return withPage(async (page) => {
    await helpers.blockHeavyResources(page);
    await page.goto(config.tradingview.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    // ─── SESSION CHECK ──────────────────────────────────────────────────────
    // TradingView does NOT redirect a logged-out visitor away from a
    // /watchlists/ URL — it serves the page shell with marketing chrome and no
    // board. So the redirect test below never fires on an expired session, and
    // the scraper instead waits the full 30s for row cells that will never
    // appear. Seen live: the only data-qa-id values on the page were
    // "products-button" and "ui-kit-underline-tabs-underline".
    //
    // The reliable signal is the logged-in header, which is what a working
    // scraper of this site checks.
    await page.waitForTimeout(2_000);
    const loggedIn = await page.evaluate(() => Boolean(
      document.querySelector('[data-name="header-user-menu-button"]')
      || document.querySelector('[class*="userMenuButton"]')
      || document.querySelector('[class*="header-user-menu"]'),
    )).catch(() => false);

    // Not gated on the URL: a public screener works logged out, but if a
    // session was configured and is now dead we want to say THAT rather than
    // report a selector failure thirty seconds later.
    if (!loggedIn && (/\/watchlists?\//i.test(config.tradingview.url) || loadCookies())) {
      await helpers.saveFailureArtifacts(page, 'tradingview-session');
      throw new Error(
        'TradingView session has expired — the page loaded logged OUT.\n'
        + '  A private watchlist then renders marketing chrome and no board,\n'
        + '  which is why this fails without any redirect to /signin.\n\n'
        + '      npm run tv:login        capture a fresh session\n'
        + '      npm run tv:probe        confirm rows are visible again\n',
      );
    }

    await helpers.dismissModals(page);
    await page.waitForTimeout(1_000);
    await helpers.dismissModals(page);

    try {
      await page.waitForSelector(`[data-qa-id="${CELL.symbol}"]`, { timeout: 30_000 });
    } catch {
      const found = await page.evaluate(
        () => Array.from(document.querySelectorAll('[data-qa-id]'))
          .map((e) => e.getAttribute('data-qa-id'))
          .filter((v, i, a) => a.indexOf(v) === i).slice(0, 40),
      ).catch(() => []);
      await helpers.saveFailureArtifacts(page, 'tradingview-norows');
      log.error('tradingview: no symbol cells — data-qa-id values present on the page', { found });
      throw new Error(
        `watchlist rows never rendered within 30s: [data-qa-id="${CELL.symbol}"] not found.\n`
        + `  data-qa-id values seen: ${found.join(', ') || '(none at all)'}\n`
        + '  None at all usually means no session — run: npm run tv:login\n'
        + '  A different set means the identifiers moved; override with TV_QA_SYMBOL.',
      );
    }

    const geometry = await measureGeometry(page);
    // Half the viewport — see scrollStep().
    const step = Math.max(120, Math.floor(geometry.clientHeight * 0.5));

    const collected = new Map();
    const deadline = Date.now() + SCRAPE_TIMEOUT_MS;
    let previousSize = -1;
    let unchanged = 0;
    let scrolls = 0;
    let atBottom = false;

    while (scrolls < MAX_SCROLLS && Date.now() < deadline) {
      for (const row of await readVisibleRows(page)) {
        if (row.symbolText) collected.set(row.symbolText, row);
      }

      if (atBottom) break;

      if (collected.size === previousSize) {
        unchanged += 1;
        // Three unchanged rounds, not one: a slow middle section legitimately
        // adds nothing for a round while more rows are still below.
        if (unchanged >= 3) break;
      } else {
        unchanged = 0;
      }
      previousSize = collected.size;

      atBottom = await scrollStep(page, step);
      scrolls += 1;
      // Virtualised rows render on the next frame plus a data fetch. Below
      // ~250ms the newly revealed rows read as empty cells.
      await page.waitForTimeout(300);
    }

    const quotes = [];
    const symbols = [];
    for (const row of collected.values()) {
      const q = toQuote(row, meta);
      if (!q) continue;
      quotes.push(q);
      symbols.push({
        market: TV_MARKET, symbol: q.symbol, description: row.companyName || null,
      });
    }

    log.info('tradingview: extracted', {
      rows: collected.size, quotes: quotes.length, scrolls,
      usesWindow: geometry.usesWindow, step,
    });

    if (!quotes.length) {
      await helpers.saveFailureArtifacts(page, 'tradingview-noquotes');
      throw new Error(`found ${collected.size} symbol cell(s) but none yielded a usable symbol`);
    }

    // Drift guard: when the value cells move, rows still parse with real
    // symbols and every price null. Stored, that is a full board of nothing
    // recorded as a success.
    const withPrice = quotes.filter((q) => q.last_price !== null).length;
    const coverage = withPrice / quotes.length;
    if (coverage < MIN_PRICE_COVERAGE) {
      // Do not just say the cells moved — say WHERE they went. The symbol cell
      // was found, so its row is in hand; listing the data-qa-id values that
      // are actually on that row turns this from a hunt into one env var.
      const present = await page.evaluate((symbolQa) => {
        const cell = document.querySelector(`[data-qa-id="${symbolQa}"]`);
        const row = cell && cell.parentElement;
        if (!row) return { ids: [], sample: [] };
        const ids = [...row.querySelectorAll('[data-qa-id]')]
          .map((e) => e.getAttribute('data-qa-id'));
        const sample = [...row.querySelectorAll('[data-qa-id]')].slice(0, 12).map((e) => ({
          id: e.getAttribute('data-qa-id'),
          text: (e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24),
        }));
        return { ids, sample };
      }, CELL.symbol).catch(() => ({ ids: [], sample: [] }));

      await helpers.saveFailureArtifacts(page, 'tradingview-nullprices');
      log.error('tradingview: data-qa-id values actually present on a row', present);

      throw new Error(
        `only ${(coverage * 100).toFixed(0)}% of ${quotes.length} rows had a price.\n`
        + `  looking for: TV_QA_LAST="${CELL.lastPrice}"\n`
        + `  found on the row: ${present.ids.join(', ') || '(no data-qa-id siblings at all)'}\n`
        + (present.sample.length
          ? `  with values: ${present.sample.map((x) => `${x.id}="${x.text}"`).join('  ')}\n`
          : '')
        + '  Set TV_QA_LAST (and TV_QA_CHANGE_PCT / TV_QA_CHANGE / TV_QA_VOLUME)\n'
        + '  to the matching ids above and re-run.',
      );
    }

    return { quotes, symbols };
  }, { timeoutMs: 150_000, useCookies: true });
}

module.exports = { scrape, toQuote, readVisibleRows, SOURCE, CELL };

'use strict';
/**
 * TradingView history — daily OHLCV, after the session has closed.
 *
 * Opens each symbol's chart, switches to Table view, scrolls back to the start
 * of the requested range and reads the daily bars. The technique is taken from
 * a scraper of this same view that already works; the parts that look fussy
 * (right-click retries, collapsing the right panel, dismissing modals) are
 * there because the straightforward version does not reach the table.
 *
 * WHY THIS IS A DIFFERENT SCRAPER FROM THE LIVE ONE
 * A chart page per symbol takes seconds. Across ~135 symbols that is minutes,
 * which is fine once a day and impossible every minute. The live board scraper
 * reads one page for the whole market; this one reads one page per symbol and
 * gets history the board cannot show.
 */

const { withPage } = require('../browser/browser');
const helpers = require('../browser/pageHelpers');
const { config } = require('../config');
const hist = require('./historyTransform');
const log = require('../logger');

const SOURCE = 'tradingview';

/** Chart URL for a symbol. Overridable for a different exchange prefix. */
/**
 * F-18 · THE INTERVAL IS PINNED, AND THE ROWS ARE CHECKED.
 *
 * The URL carried no interval, so the chart opened on whatever the saved layout
 * held. This file's own header records having seen exactly that — it describes a
 * thead group row reading "Date·1m".
 *
 * On a 1-minute chart the failure is silent and total: `dateText` is "09:31",
 * parseRowDate cannot match it, rowDay falls through to the epoch, and every
 * minute of a session yields the same day string. buildDailyRows' dedupe then
 * keeps ONE ARBITRARY MINUTE BAR per day and writes it as that day's OHLCV —
 * open ≈ high ≈ low ≈ close, volume one minute's — and stamps it
 * session_finalised_at. Nothing errors; the row count looks healthy.
 */
const INTERVAL = process.env.TRADINGVIEW_INTERVAL || '1D';

function chartUrl(symbol) {
  const prefix = process.env.TRADINGVIEW_EXCHANGE || 'KSE';
  return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(`${prefix}:${symbol}`)}`
    + `&interval=${encodeURIComponent(INTERVAL)}`;
}

/**
 * Collapse the right-hand panel.
 * It overlays the chart, and the context menu that opens Table view is then
 * clicked underneath it.
 */
async function collapseRightPanel(page) {
  await page.evaluate(() => {
    const btn = document.querySelector(
      '[data-name="right-toolbar"] button[aria-pressed="true"], '
      + '[class*="widgetbar"] button[aria-pressed="true"], '
      + 'button[data-name="toggle-visibility-button"]',
    );
    if (btn) btn.click();
  }).catch(() => {});
  await page.waitForTimeout(800);
}

/**
 * Right-click the chart and choose the item containing "table".
 *
 * Retried up to four times because the first right-click often lands while the
 * chart is still initialising and opens nothing at all. Between attempts the
 * menu is dismissed, or the next right-click reopens the same dead menu.
 */
async function openTableView(page) {
  await helpers.dismissModals(page);

  let chart = null;
  for (const sel of ['canvas[data-name="d"]', '.chart-container canvas', '[class*="pane"] canvas', 'canvas']) {
    chart = await page.$(sel).catch(() => null);
    if (chart) break;
  }
  if (!chart) throw new Error('chart canvas not found — the page may not have loaded');

  await page.waitForTimeout(2_000);
  const box = await chart.boundingBox();
  if (!box) throw new Error('chart canvas has no box — it is not visible');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;

  const MENU = '[class*="menu"] [class*="item"], [class*="contextMenu"] li, '
    + '[role="menuitem"], [class*="menuItem"], [class*="menu-item"]';

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await page.mouse.click(x, y, { button: 'right' });
    await page.waitForTimeout(1_500);

    const clicked = await page.evaluate((sel) => {
      for (const el of document.querySelectorAll(sel)) {
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (/table/i.test(text)) { el.click(); return text; }
      }
      return null;
    }, MENU);

    if (clicked) {
      await page.waitForTimeout(2_000);
      return clicked;
    }

    await page.keyboard.press('Escape');
    await page.waitForTimeout(800);
    await helpers.dismissModals(page);
  }

  throw new Error('could not open Table view after 4 attempts');
}

/**
 * Read the header.
 *
 * The thead has TWO rows: a group row ("Date·1m", the symbol spanning five
 * columns, "Vol") and a sub-row with the real names. Reading the first row
 * gives group labels and maps nothing.
 */
async function extractHeaders(page) {
  return page.evaluate(() => {
    const thead = document.querySelector('table[aria-label="Table view"] thead');
    if (!thead) return ['Date', 'Open', 'High', 'Low', 'Close', 'Change', 'Volume'];

    const rows = thead.querySelectorAll('tr');
    if (rows.length >= 2) {
      const sub = Array.from(rows[1].querySelectorAll('th'))
        .map((th) => th.textContent.replace(/\s+/g, ' ').trim())
        .filter((t) => t.length);
      if (sub.length >= 3) return ['Date', ...sub];
    }

    // Single-row fallback: drop group headers (colspan > 1) and the date.
    const first = Array.from(rows[0] ? rows[0].querySelectorAll('th') : []);
    const out = ['Date'];
    for (const th of first) {
      const text = th.textContent.replace(/\s+/g, ' ').trim();
      if (!text || /date/i.test(text) || text.includes('·')) continue;
      if (Number(th.getAttribute('colspan') || '1') > 1) continue;
      out.push(text);
    }
    return out.length > 1 ? out : ['Date', 'Open', 'High', 'Low', 'Close', 'Change', 'Volume'];
  });
}

/** Read the visible rows. data-copy-value preferred, textContent as fallback. */
async function extractRows(page) {
  return page.evaluate(() => {
    const rows = document.querySelectorAll('table[aria-label="Table view"] tbody tr[data-row-time]');
    return Array.from(rows).map((row) => {
      const ts = Number(row.getAttribute('data-row-time') || 0);
      const cells = Array.from(row.querySelectorAll('td'));
      if (!cells.length) return null;

      const dateText = cells[0].textContent.replace(/\s+/g, ' ').trim();
      const values = cells.slice(1).map((td) => {
        // data-copy-value holds the unrounded number, but it is absent on some
        // cells -- notably negatives. Falling back is what keeps those.
        const copy = (td.getAttribute('data-copy-value') || '').trim();
        return copy !== '' ? copy : (td.textContent || '').trim();
      });
      return { ts, dateText, values };
    }).filter(Boolean);
  });
}

/** Scroll the table's own scroll container. */
async function scrollTable(page, px) {
  await page.evaluate((amount) => {
    const table = document.querySelector('table[aria-label="Table view"]');
    if (!table) return;
    let el = table.parentElement;
    while (el && el !== document.body) {
      if (el.scrollHeight > el.clientHeight + 10) { el.scrollTop += amount; return; }
      el = el.parentElement;
    }
    window.scrollBy(0, amount);
  }, px);
}

/**
 * Scrape one symbol's daily history.
 * @returns {Promise<{rows: Array, skipped: number}>}
 */
async function scrapeSymbol(page, symbol, { startDay, endDay, runId, maxScrolls = 400 }) {
  await page.goto(chartUrl(symbol), { waitUntil: 'domcontentloaded', timeout: 60_000 });

  if (/signin|login/i.test(page.url())) {
    throw new Error('redirected to sign-in — run `npm run tv:login`');
  }

  await page.waitForTimeout(5_000);
  await collapseRightPanel(page);
  await openTableView(page);
  await page.waitForSelector('table[aria-label="Table view"]', { timeout: 20_000 });

  const headers = await extractHeaders(page);

  const collected = new Map();          // ts -> row
  let reachedStart = false;
  let flat = 0;
  /*
   * P6-TV-2 · THE LOOP ENDS WHEN THE TABLE IS EXHAUSTED, NOT ONLY WHEN IT
   * REACHES BEFORE startDay.
   *
   * A symbol whose whole history is inside the window never produces a row
   * older than startDay, so `reachedStart` never became true and the loop ran
   * every one of its maxScrolls iterations (≈300ms each, plus an evaluate) for
   * that one symbol — long enough for the 45-minute worker kill to terminate
   * the run and discard every row collected for every symbol before it.
   *
   * Two exits are added: a run of flat reads AFTER a full jump has already
   * been tried (the list is not stuck, it is finished), and a per-symbol wall
   * clock.
   */
  const symbolBudgetMs = require('../config/thresholds').get('history_symbol_ms');
  const symbolDeadline = Date.now() + symbolBudgetMs;
  let jumped = false;
  let exhausted = false;

  for (let i = 0; i < maxScrolls && !reachedStart && !exhausted; i += 1) {
    if (Date.now() > symbolDeadline) {
      log.warn('history: symbol hit its time budget — keeping what was read', {
        symbol, rows: collected.size, budgetMs: symbolBudgetMs,
      });
      break;
    }
    const batch = await extractRows(page);
    const before = collected.size;

    for (const row of batch) {
      // CR-12 · same day resolution as the writer (displayed date first, epoch
      // fallback in Kuwait) so the scroll range and the stored rows agree.
      const day = hist.rowDay(row);
      if (!day) continue;

      if (day < startDay) { reachedStart = true; break; }
      if (day <= endDay) collected.set(row.ts, row);
    }

    if (collected.size === before) {
      flat += 1;
      // Several flat reads in a row can mean the virtual list is stuck rather
      // than exhausted, so jump further before concluding it is done.
      if (flat >= 8) {
        // P6-TV-2 · one full jump is the test for "stuck". A second run of
        // flat reads after it means the table has no more rows to give.
        if (jumped) {
          exhausted = true;
          log.info('history: table exhausted', { symbol, rows: collected.size });
        } else {
          await scrollTable(page, 3_000);
          jumped = true;
          flat = 0;
        }
      } else await scrollTable(page, 300);
    } else {
      flat = 0;
      jumped = false;
      await scrollTable(page, 600);
    }

    await page.waitForTimeout(300);
  }

  const built = hist.buildDailyRows([...collected.values()], headers, {
    symbol, runId, startDay, endDay,
  });

  log.info('history: symbol scraped', {
    symbol, rows: built.rows.length, skipped: built.skipped,
    reachedStart, headers: headers.slice(0, 8),
  });
  if (built.reasons.length) log.warn('history: rows dropped', { symbol, reasons: built.reasons });

  return built;
}

/**
 * Scrape history for a list of symbols.
 * Symbols come from the database, so the live scraper's discoveries feed this.
 */
async function scrape({ runId, symbols, startDay, endDay }) {
  if (!symbols || !symbols.length) {
    log.warn('history: no symbols to scrape');
    return { rows: [], skipped: 0 };
  }

  return withPage(async (page) => {
    await helpers.blockHeavyResources(page);

    const all = [];
    let skipped = 0;
    const failures = [];

    for (const symbol of symbols) {
      try {
        const built = await scrapeSymbol(page, symbol, { startDay, endDay, runId });
        all.push(...built.rows);
        skipped += built.skipped;
      } catch (err) {
        // One symbol must not lose the rest of the run. 135 symbols is a long
        // job and restarting it from zero over one bad chart is expensive.
        failures.push(symbol);
        log.error('history: symbol failed', { symbol, err: log.serializeError(err) });
      }
      await page.waitForTimeout(1_500);      // do not hammer the site
    }

    if (failures.length) {
      log.warn('history: some symbols failed', { count: failures.length, symbols: failures.slice(0, 20) });
    }
    if (!all.length) {
      throw new Error(
        `history produced no rows for any of ${symbols.length} symbol(s). `
        + 'Check the session (npm run tv:login) and TRADINGVIEW_EXCHANGE.',
      );
    }

    return { rows: all, skipped, failures };
  }, { timeoutMs: 30 * 60_000, useCookies: true });
}

module.exports = { scrape, scrapeSymbol, chartUrl, SOURCE };

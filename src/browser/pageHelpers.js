'use strict';
/**
 * Page-level helpers shared by the scrapers.
 *
 * Most of this is ported from a scraper of the same site that is already known
 * to work. The techniques here were not invented for this file — they are the
 * things that turned out to be necessary in practice, which is a much stronger
 * reason to keep them than any argument from first principles.
 */

const fs = require('fs');
const path = require('path');
const log = require('../logger');

const TMP_DIR = path.resolve(__dirname, '..', '..', 'tmp');

/**
 * Overlays TradingView puts in front of the content.
 *
 * THIS IS THE MOST LIKELY REASON A SCRAPE RETURNS ZERO ROWS. The page loads,
 * the DOM is ready, and a promo or consent dialog sits on top of everything —
 * so `waitForSelector('table tbody tr')` times out against a page that has no
 * table because the table was never rendered behind the modal.
 *
 * Ordered roughly by how often they appear.
 */
const DISMISS_LABELS = [
  'Decline offer', 'Decline', 'No thanks', 'Skip', 'Maybe later', 'Not now',
  'Accept all', 'Accept all cookies', 'I agree', 'Got it', 'Close',
];

/**
 * Try to close whatever is covering the page. Never throws: a failure to find a
 * modal is the normal case, not an error.
 *
 * @returns {Promise<string|null>} the label that was clicked, if any
 */
async function dismissModals(page) {
  for (const label of DISMISS_LABELS) {
    try {
      const btn = page.getByRole('button', { name: new RegExp(`^\\s*${label}\\s*$`, 'i') });
      if (await btn.count() > 0) {
        await btn.first().click({ timeout: 3_000 });
        await page.waitForTimeout(800);
        log.info('dismissed an overlay', { label });
        return label;
      }
    } catch { /* button vanished or was not clickable; try the next */ }
  }

  // Some dialogs have no button we can name. If something modal-looking is
  // visible, Escape usually closes it.
  try {
    const hasModal = await page.evaluate(() => {
      const els = document.querySelectorAll(
        '[class*="modal"], [class*="dialog"], [class*="overlay"], [role="dialog"]',
      );
      return Array.from(els).some((e) => {
        const s = window.getComputedStyle(e);
        return s.display !== 'none' && s.visibility !== 'hidden' && e.offsetHeight > 50;
      });
    });
    if (hasModal) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(600);
      log.info('pressed Escape to close an unnamed dialog');
      return 'Escape';
    }
  } catch { /* evaluate failed; not fatal */ }

  return null;
}

/**
 * Wait until the row count stops changing, rather than for a fixed delay.
 *
 * The board arrives over a websocket after first paint, so a fixed
 * `waitForTimeout` is a guess: too short and rows are missing, too long and
 * every scrape wastes the time. Polling until the count is stable across
 * consecutive checks adapts to whatever the connection is actually doing.
 *
 * @returns {Promise<number>} the row count settled on
 */
async function waitForStableRows(page, selector, {
  timeoutMs = 45_000, stableChecks = 3, intervalMs = 1_000, minRows = 1,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  let stable = 0;

  while (Date.now() < deadline) {
    const count = await page.evaluate((sel) => document.querySelectorAll(sel).length, selector)
      .catch(() => 0);

    if (count >= minRows && count === last) {
      stable += 1;
      if (stable >= stableChecks) return count;
    } else {
      stable = 0;
    }
    last = count;
    await page.waitForTimeout(intervalMs);
  }
  return last < 0 ? 0 : last;
}

/**
 * Scroll to the bottom repeatedly to trigger lazy loading, and click a
 * "Load More" button while one exists.
 *
 * TradingView's market pages render a first page of rows and append the rest on
 * demand. Without this the scrape silently captures only the first slice —
 * which looks like a working scraper collecting a suspiciously round number of
 * symbols.
 */
async function loadAllRows(page, selector, { maxRounds = 25, patience = 3 } = {}) {
  let previous = 0;
  let unchanged = 0;

  for (let round = 0; round < maxRounds; round += 1) {
    const count = await page.evaluate((sel) => document.querySelectorAll(sel).length, selector)
      .catch(() => 0);

    // PATIENCE, not a single unchanged reading. Stopping the first time the
    // count repeats truncates the board whenever a fetch is still in flight:
    // the sequence 10, 10, 25, 40 is completely normal, and breaking at the
    // second 10 captures a quarter of the market and looks like success.
    if (count === previous) {
      unchanged += 1;
      if (unchanged >= patience && round > 0) break;
    } else {
      unchanged = 0;
    }
    previous = count;

    // A "Load More" control, if the page uses one.
    let clickedMore = false;
    try {
      const more = page.getByRole('button', { name: /load more|show more/i });
      if (await more.count() > 0) {
        await more.first().click({ timeout: 3_000 });
        clickedMore = true;
      }
    } catch { /* no such button, or it vanished */ }

    if (clickedMore) {
      await page.waitForTimeout(1_500);
      continue;
    }

    await scrollInnerContainer(page, selector);
    await page.waitForTimeout(1_200);
  }

  return previous;
}

/**
 * Scroll the element that actually scrolls, not the window.
 *
 * TradingView's watchlist is a VIRTUALISED list inside its own scroll
 * container: only the visible slice exists in the DOM, and the rest appears as
 * that container scrolls. `window.scrollTo` moves the page, which the container
 * ignores completely — so a widget whose body has not been scrolled reports
 * zero rows while its chrome (tabs, currency footer) renders perfectly.
 *
 * This walks up from a known row, or falls back to the largest scrollable
 * element on the page, and scrolls THAT. The technique is taken from a scraper
 * of this same site that works.
 */
async function scrollInnerContainer(page, rowSelector, { by = 800 } = {}) {
  return page.evaluate(({ sel, by: px }) => {
    const scrollable = (el) => el && el.scrollHeight > el.clientHeight + 10;

    // Preferred: walk up from an actual row to its scrolling ancestor.
    const seed = document.querySelector(sel);
    let el = seed && seed.parentElement;
    while (el && el !== document.body) {
      if (scrollable(el)) { el.scrollTop += px; return { scrolled: true, from: 'row ancestor' }; }
      el = el.parentElement;
    }

    // Fallback: the biggest scrollable box on the page is almost always the
    // list we want.
    let best = null;
    for (const cand of document.querySelectorAll('div, section, main')) {
      if (!scrollable(cand)) continue;
      if (!best || cand.scrollHeight > best.scrollHeight) best = cand;
    }
    if (best) { best.scrollTop += px; return { scrolled: true, from: 'largest scrollable' }; }

    window.scrollTo(0, document.body.scrollHeight);
    return { scrolled: false, from: 'window' };
  }, { sel: rowSelector, by });
}

/**
 * Write a screenshot and the page HTML to ./tmp when a scrape fails.
 *
 * WITHOUT THIS, A FAILURE IS ONE LINE OF TEXT. "No rows found" is the same
 * message whether the page showed a consent dialog, a login wall, a Cloudflare
 * challenge, an empty table, or a completely redesigned layout — and those need
 * five different fixes. The artifacts turn a guessing exercise into looking at
 * what happened.
 */
async function saveFailureArtifacts(page, tag) {
  try {
    if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.join(TMP_DIR, `${tag}-${stamp}`);

    await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
    const html = await page.content().catch(() => '');
    if (html) fs.writeFileSync(`${base}.html`, html, 'utf8');

    const url = page.url();
    const title = await page.title().catch(() => '');

    log.error('saved failure artifacts — open these to see what the page actually was', {
      screenshot: `${base}.png`,
      html: `${base}.html`,
      url,
      title,
    });

    return { base, url, title };
  } catch (err) {
    log.warn('could not save failure artifacts', { err: err.message });
    return null;
  }
}

/**
 * Count what each candidate selector matches. Used by the probe script and in
 * the failure path, so a layout change reports which selector to switch to
 * rather than only that the current one found nothing.
 */
async function selectorCensus(page, selectors) {
  return page.evaluate((sels) => sels.map((sel) => {
    let count = 0;
    let sample = '';
    try {
      const found = document.querySelectorAll(sel);
      count = found.length;
      if (found.length) sample = (found[0].textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    } catch { count = -1; }
    return { selector: sel, count, sample };
  }), selectors);
}

/**
 * Find repeated sibling structures that look like data rows.
 *
 * When every known selector fails, this discovers the row markup instead of
 * guessing at it: group elements by parent and class signature, keep the groups
 * with many similar siblings that contain both text and numbers, and report
 * them. The answer is usually the top result, and it names a selector that can
 * be pasted straight into ROW_SELECTORS.
 */
async function discoverRepeatedRows(page, { minSiblings = 5, limit = 6 } = {}) {
  return page.evaluate((opts) => {
    const groups = new Map();

    for (const el of document.querySelectorAll('div, tr, li')) {
      const parent = el.parentElement;
      if (!parent) continue;
      const cls = (el.className && typeof el.className === 'string')
        ? el.className.trim().split(/\s+/)[0] : '';
      if (!cls) continue;

      const key = `${parent.tagName}>${el.tagName}.${cls}`;
      if (!groups.has(key)) groups.set(key, { key, cls, tag: el.tagName, items: [] });
      groups.get(key).items.push(el);
    }

    const scored = [];
    for (const g of groups.values()) {
      if (g.items.length < opts.minSiblings) continue;

      const texts = g.items.slice(0, 40).map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim());
      const withNumber = texts.filter((t) => /\d/.test(t)).length;
      const withLetter = texts.filter((t) => /[A-Za-z]/.test(t)).length;
      if (!withNumber || !withLetter) continue;

      scored.push({
        selector: `${g.tag.toLowerCase()}.${g.cls}`,
        count: g.items.length,
        numericShare: Math.round((withNumber / texts.length) * 100),
        sample: texts.find((t) => /\d/.test(t))?.slice(0, 100) || '',
      });
    }

    scored.sort((a, b) => (b.numericShare * b.count) - (a.numericShare * a.count));
    return scored.slice(0, opts.limit);
  }, { minSiblings, limit });
}

/** Block fonts, media and ads. Ported from the working scraper; pages load faster. */
async function blockHeavyResources(page) {
  await page.route('**/*.{woff,woff2,ttf,otf,mp4,mp3,avi}', (r) => r.abort()).catch(() => {});
  await page.route('**/ads/**', (r) => r.abort()).catch(() => {});
  await page.route('**/*doubleclick*', (r) => r.abort()).catch(() => {});
}

module.exports = {
  scrollInnerContainer,
  discoverRepeatedRows,
  dismissModals,
  waitForStableRows,
  loadAllRows,
  saveFailureArtifacts,
  selectorCensus,
  blockHeavyResources,
  TMP_DIR,
  DISMISS_LABELS,
};

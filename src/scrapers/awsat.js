'use strict';
/**
 * AWSAT broker terminal — Premier and Main market boards, depth, order list.
 *
 * ─── PORTED FROM THE WORKING INGESTION SERVICE ─────────────────────────────
 * The selectors here are NOT guesses. An earlier version of this file invented
 * them (`table tbody tr`, `[class*="order"] tr`) and none matched: the terminal
 * is an Ember table whose rows are split across a LEFT block holding the symbol
 * and a RIGHT block holding the values, with each value cell addressed by a
 * `cell-id` attribute rather than by position.
 *
 * ─── THE SCROLL STEP IS THE IMPORTANT NUMBER ───────────────────────────────
 * wheelDelta is 250, and it must stay BELOW the board's scroll viewport height
 * (~426px). A 500px step jumps past the bottom of the visible window and leaves
 * a ~74px band that is never rendered at any point in the scan. Because both
 * the step and the board height are fixed, the SAME rows fall in that blind
 * band on every run — in production that silently lost ACICO, ABAR, INJAZZAT,
 * SOKOUK and NIND, every single day, with every scrape reporting success.
 */

const { withPage } = require('../browser/browser');

/**
 * Run a task on the shared session, serialised.
 *
 * Serialisation matters as much as sharing: two jobs driving one page interleave
 * their clicks and each reads the other's screen.
 */
let queue = Promise.resolve();
/**
 * AWSAT AUTH DOES NOT COMPLETE HEADLESS.
 *
 * A working scraper of this terminal runs headed for exactly this reason: the
 * login stalls with no error, which burns the job timeout, kills the worker and
 * throws away the session. Attempts are capped per day, so spending one on a
 * mode that cannot succeed is the most expensive mistake available here.
 *
 * Checked BEFORE the browser is launched — a check that runs afterwards has
 * already paid most of the cost it exists to avoid.
 */
function assertHeaded() {
  if (!config.runtime.headless || process.env.AWSAT_ALLOW_HEADLESS === 'true') return;
  const err = new Error(
    'AWSAT login does not complete in headless mode.\n'
    + '  Set HEADLESS=false. On a server with no display, run under Xvfb:\n'
    + '      xvfb-run -a --server-args="-screen 0 1280x800x24" npm start\n'
    + '  Refusing to spend one of the day\'s limited login attempts on a mode\n'
    + '  that is known to stall. Override with AWSAT_ALLOW_HEADLESS=true.',
  );
  err.skipped = true;     // a configuration problem, not a scraper failure
  throw err;
}

function runOnSession(fn) {
  const run = queue.then(async () => { assertHeaded(); return fn(await getPage()); });
  // Keep the chain alive after a failure, or every later job inherits it.
  queue = run.catch(() => {});
  return run;
}
const { config } = require('../config');
const clock = require('../market/clock');
const parse = require('./parse');
const guard = require('./loginGuard');
const socketTap = require('./awsatSocketTap');
const log = require('../logger');

const SOURCE = 'awsat';

/**
 * How the board is read.
 *
 *   socket  the price WebSocket (preferred — see awsatSocketTap.js)
 *   dom     the rendered Ember table (the original path, kept for comparison)
 *   both    run each, STORE the socket result, and log a field-by-field diff
 *
 * 'both' exists to prove the socket path is complete before the DOM path is
 * deleted. It costs a full DOM sweep per cycle, so it is not a permanent
 * setting — switch to 'socket' once the comparison shows parity.
 */
const BOARD_MODE = (process.env.AWSAT_BOARD_MODE || 'both').toLowerCase();

/**
 * Read a selector from the environment, catching the `#` trap.
 *
 * dotenv treats an unquoted `#` as the start of a comment, so
 *
 *     AWSAT_SEL_SEARCH=#appGlobalSymbolSearch
 *
 * parses to an EMPTY STRING and the default is silently used instead. Most real
 * selectors are ids, so this is the most likely thing to be written and the
 * least likely to be noticed — the scraper simply behaves as if the variable
 * were never set. Quote it:
 *
 *     AWSAT_SEL_SEARCH="#appGlobalSymbolSearch"
 */
function envSelector(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (raw.trim() === '') {
    log.warn(`${name} is set but parsed as empty — using the default. `
      + 'A value starting with "#" must be QUOTED in .env, or dotenv reads it '
      + 'as a comment.', { using: fallback });
    return fallback;
  }
  return raw;
}

const SEL = {
  username: process.env.AWSAT_SEL_USER || '#txtUsername',
  password: process.env.AWSAT_SEL_PASS || '#txtPassword',
  loginBtn: envSelector('AWSAT_SEL_LOGIN', '#btnLogin'),
  terms: envSelector('AWSAT_SEL_TERMS', '#chkTermsAndConditions'),
  errorMsg: envSelector('AWSAT_SEL_ERROR', '#loginMsg'),
  langEN: envSelector('AWSAT_SEL_LANG', '#priLangRadio'),

  bodyContainer: '.ember-table-body-container',
  leftBlock: '.ember-table-left-table-block',
  rightBlock: '.ember-table-right-table-block',
  row: '.ember-table-table-row',
  symbolCell: '.symbol-fore-color',

  /**
   * The depth widget needs its OWN selector.
   *
   * The board and the depth panel are both `.ember-table-body-container` with
   * the same row and symbol classes, so a generic lookup finds whichever comes
   * first — which is the board. In testing that made every depth capture verify
   * against the BOARD's ticker and skip the symbol entirely. Set
   * AWSAT_SEL_DEPTH to the depth panel's container once its real id is known.
   */
  /**
   * The order-book ladder. NOT an Ember table.
   *
   * It is a flat list of .pos-rel rows in which bids and offers are
   * INTERLEAVED and told apart by colour class, so none of the board's
   * left/right-block machinery applies here.
   */
  depthContainer: envSelector('AWSAT_SEL_DEPTH', '.quote-page-second-row-wght'),
  depthRow: envSelector('AWSAT_SEL_DEPTH_ROW', '.pos-rel'),
  depthPrice: envSelector('AWSAT_SEL_DEPTH_PRICE', '.cursor-pointer'),
  depthQty: envSelector('AWSAT_SEL_DEPTH_QTY', '.h-right'),

  /**
   * The order list needs its OWN container.
   *
   * There is deliberately NO "last table on the page" fallback. That fallback
   * silently read the BOARD and wrote 29 watchlist rows into
   * awsat_order_list — order_id held a company name, symbol held a price.
   * Nothing errored until a decimal failed to cast to bigint, and even then 28
   * of the 29 nonsense rows had already been stored.
   *
   * A scraper that cannot find its own table must fail. Reading a different
   * table is worse than reading none, because the rows look plausible.
   */
  orderContainer: envSelector('AWSAT_SEL_ORDERS', 'div[id^="orderList-"]'),

  // The terminal's global symbol search. Taken from the live DOM.
  symbolSearch: envSelector('AWSAT_SEL_SEARCH',
    '.symbol-input-width input, input.symbol-fore-color.search-query, '
    + 'input[id^="searchField"], #appGlobalSymbolSearch'),
};

/**
 * Close any modal overlay sitting on top of the terminal.
 *
 * The terminal renders `.modal-popup-overlay` as a full-page transparent layer.
 * It is invisible in a screenshot but intercepts every pointer event, so
 * Playwright reports the target as "visible, enabled and stable" and then
 * retries the click for thirty seconds against something that can never receive
 * it. Seen live on every depth symbol.
 *
 * Escape first, then remove the overlay outright if it survives — a stuck
 * overlay otherwise blocks the terminal for the rest of the session, and the
 * session cannot be cheaply rebuilt because logins are capped.
 */
async function clearOverlays(page) {
  const found = await page.evaluate(() => {
    const sel = '.modal-popup-overlay, [class*="modal-popup-overlay"], [class*="modal-overlay"]';
    return [...document.querySelectorAll(sel)].filter((e) => e.offsetParent !== null).length;
  }).catch(() => 0);

  if (!found) return false;

  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(400);

  const removed = await page.evaluate(() => {
    const sel = '.modal-popup-overlay, [class*="modal-popup-overlay"], [class*="modal-overlay"]';
    let n = 0;
    for (const el of document.querySelectorAll(sel)) {
      if (el.offsetParent !== null) { el.remove(); n += 1; }
    }
    return n;
  }).catch(() => 0);

  if (removed) log.info('awsat: removed a modal overlay blocking the terminal', { removed });
  return true;
}

/** Both markets, Premier first — matching production. */
const MARKETS = (process.env.AWSAT_MARKETS || 'Premier Market,Main Market')
  .split(',').map((m) => m.trim()).filter(Boolean);

/** MUST stay below the board's viewport height. See the header note. */
const WHEEL_DELTA = Number(process.env.AWSAT_WHEEL_DELTA || 250);
const MAX_STALLS = Number(process.env.AWSAT_MAX_STALLS || 6);
const HARD_SCROLL_CAP = Number(process.env.AWSAT_SCROLL_CAP || 200);
const SETTLE_MS = Number(process.env.AWSAT_SETTLE_MS || 500);
const DATA_WAIT_MS = Number(process.env.AWSAT_DATA_WAIT_MS || 20_000);

/** The terminal's cell-id attributes, mapped to our column names. */
const FIELD_MAP = {
  'dataObj.lDes': 'description', 'dataObj.ltp': 'last_price', 'dataObj.ltq': 'last_qty',
  'dataObj.chg': 'chg', 'dataObj.pctChg': 'pct_chg', 'dataObj.vol': 'volume',
  'dataObj.bbp': 'bid', 'dataObj.bbq': 'bid_qty', 'dataObj.bap': 'offer',
  'dataObj.baq': 'offer_qty', 'dataObj.trades': 'trades', 'dataObj.ltd': 'last_trade_date',
  'dataObj.dltt': 'last_trade_time',
  'dataObj.open': 'open_price', 'dataObj.high': 'high_price', 'dataObj.low': 'low_price',
  'dataObj.sname': 'session', 'dataObj.nms': 'nms',
};

/** chg and pct_chg are legitimately negative; every other number is not. */
const SIGNED = new Set(['chg', 'pct_chg']);
const NUMERIC = new Set([
  'last_price', 'last_qty', 'chg', 'pct_chg', 'volume', 'bid', 'bid_qty',
  'offer', 'offer_qty', 'trades', 'open_price',
  'high_price', 'low_price', 'nms',
]);

/** Text the terminal shows while a cell is still loading. */
const TRANSIENT = /(جاري|جارٍ|authenticat|logging|loading|please\s*wait|connecting|\.\.\.\s*$)/i;

let loggedIn = false;
let loginFailed = false;

/**
 * ONE page, shared by every AWSAT job in this worker.
 *
 * withPage() builds a fresh browser context per call, which throws away cookies
 * and session storage — so the session established by the board job was gone by
 * the time the orders job ran. `loggedIn` stayed true (it is module state, not
 * page state), ensureLogin therefore skipped, and orders ran against a blank
 * page. Caught by running the jobs in sequence against a real browser: board
 * succeeded and orders timed out.
 *
 * Re-logging in per job is not an option — the terminal caps login attempts per
 * day. One page, held open, is the only shape that fits that constraint.
 */
let sharedPage = null;
let sharedContext = null;

async function getPage() {
  if (sharedPage && !sharedPage.isClosed()) return sharedPage;

  const { getBrowser } = require('../browser/browser');
  const browser = await getBrowser();
  sharedContext = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  // Install BEFORE any page exists. The terminal constructs its WebSocket
  // during startup, so a proxy added after navigation never sees it —
  // addInitScript runs at document-start on every page in this context.
  await socketTap.install(sharedContext);

  sharedPage = await sharedContext.newPage();
  sharedPage.setDefaultTimeout(60_000);

  // A page that had to be rebuilt has no session, whatever the flag says.
  loggedIn = false;
  return sharedPage;
}

/**
 * Find whatever is actually rendering the board.
 *
 * THE BOARD IS NOT NECESSARILY ON THE PAGE WE LOGGED IN WITH. The terminal may
 * render it inside an iframe, and login can open it in a NEW TAB. Querying only
 * the top-level page therefore finds nothing — which is exactly what happened:
 * the depth and order panels reported "no panel matched" and the market
 * dropdown could not be seen, while the board was visible on screen the whole
 * time.
 *
 * Returns a Frame (or Page — both expose evaluate/$/locator) plus its owning
 * page, because mouse wheel events must be sent to the PAGE while queries go to
 * the frame.
 */
async function findBoardTarget(timeoutMs = 20_000) {
  const sel = `${SEL.bodyContainer} ${SEL.symbolCell}`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const pg of sharedContext.pages()) {
      for (const frame of pg.frames()) {
        try {
          if (await frame.$(sel)) return { page: pg, target: frame };
        } catch { /* frame detached mid-walk */ }
      }
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return { page: sharedPage, target: sharedPage };
}

/** Find any panel by selector, across pages and frames. */
async function findPanelTarget(selector, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const pg of sharedContext.pages()) {
      for (const frame of pg.frames()) {
        try {
          if (await frame.$(selector)) return { page: pg, target: frame };
        } catch { /* detached */ }
      }
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

async function closeSession() {
  if (sharedPage) await sharedPage.close().catch(() => {});
  if (sharedContext) await sharedContext.close().catch(() => {});
  sharedPage = null;
  sharedContext = null;
  loggedIn = false;
}

// ─── parsing ────────────────────────────────────────────────────────────────

/** The board shows "SYMBOL - CODE"; the code survives a ticker rename. */
function parseSymbol(raw) {
  if (!raw) return { symbol: null, code: null };
  const [s, c] = String(raw).split(/\s*-\s*/);
  return { symbol: (s || '').trim().toUpperCase() || null, code: (c || '').trim() || null };
}

function num(value, allowNegative = false) {
  const n = parse.toNumber(value);
  if (n === null) return null;
  // An unsigned field that came back negative is a misread, not a negative
  // price. Production takes the absolute value rather than dropping the row.
  return (!allowNegative && n < 0) ? Math.abs(n) : n;
}

/** 'DD-MM-YYYY' -> 'YYYY-MM-DD'. Anything else is null rather than a guess. */
function toDate(v) {
  const m = String(v || '').trim().match(/^(\d{2})-(\d{2})-(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

// ─── login ──────────────────────────────────────────────────────────────────

async function ensureLogin(page) {
  if (loggedIn) return;
  if (!config.awsat.user || !config.awsat.pass) {
    throw new Error('AWSAT_USER and AWSAT_PASS are not set');
  }
  if (loginFailed) {
    const err = new Error('AWSAT login already failed in this worker; not retried here');
    err.skipped = true;
    throw err;
  }

  // Persistent, survives restarts and worker respawns. See loginGuard.js.
  const verdict = guard.check();
  if (!verdict.allowed) {
    const err = new Error(`AWSAT login refused: ${verdict.reason}`);
    err.skipped = true;
    throw err;
  }
  guard.recordAttempt();

  try {
    await page.goto(config.awsat.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForSelector(SEL.username, { state: 'visible', timeout: 30_000 });

    // English first: the board's cell text and the market names are matched by
    // string, and an Arabic session makes every one of those comparisons fail.
    const lang = await page.$(SEL.langEN);
    if (lang) await lang.click().catch(() => {});

    // pressSequentially, not fill(). Ember binds on key events; fill() sets the
    // value directly, the framework never sees it, and the form submits empty —
    // spending a login attempt for nothing.
    await page.locator(SEL.username).first().pressSequentially(config.awsat.user, { delay: 30 });
    await page.locator(SEL.password).first().pressSequentially(config.awsat.pass, { delay: 30 });

    // The terms checkbox is Ember-bound: setting .checked directly does not
    // notify the framework, so the form still considers it unticked and the
    // submit button stays inert.
    const terms = await page.$(SEL.terms);
    if (terms) {
      await terms.check().catch(() => {});
      await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (el && !el.checked) el.checked = true;
        if (el) {
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, SEL.terms).catch(() => {});
    }

    // ─── SUBMIT ────────────────────────────────────────────────────────────
    // A single .click() was not enough: on the live terminal it returned
    // without error and nothing happened, so the board wait sat for 120s, the
    // worker was killed, and the session was lost — after which a ten-minute
    // cooldown blocked every other AWSAT job.
    //
    // Ember wires submit in several ways depending on the build (an action on
    // the button, a form submit handler, a keyup on the password field), and
    // which one is live is not visible from outside. So each is tried in turn
    // and the FIRST that actually navigates wins. Trying them in sequence
    // costs a few seconds; failing to log in costs the trading day.
    const submitted = await (async () => {
      const boardAppeared = () => page
        .waitForSelector(SEL.bodyContainer, { timeout: 12_000 })
        .then(() => true).catch(() => false);

      // 1 — the ordinary click.
      await page.locator(SEL.loginBtn).first().click({ timeout: 10_000 }).catch(() => {});
      if (await boardAppeared()) return 'click';

      // 2 — Enter from the password field. Many login forms submit on Enter
      //     even when the button's handler is not attached.
      await page.locator(SEL.password).first().press('Enter').catch(() => {});
      if (await boardAppeared()) return 'enter';

      // 3 — a real click dispatched in-page, which reaches handlers bound to
      //     mousedown/mouseup rather than click.
      await page.evaluate((sel) => {
        const btn = document.querySelector(sel);
        if (!btn) return;
        btn.removeAttribute('disabled');
        for (const type of ['mousedown', 'mouseup', 'click']) {
          btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        }
      }, SEL.loginBtn).catch(() => {});
      if (await boardAppeared()) return 'dispatched events';

      // 4 — submit the enclosing form directly.
      await page.evaluate((sel) => {
        const btn = document.querySelector(sel);
        const form = btn ? btn.closest('form') : document.querySelector('form');
        if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
      }, SEL.loginBtn).catch(() => {});
      if (await boardAppeared()) return 'form submit';

      return null;
    })();

    if (!submitted) {
      const shown = await page.textContent(SEL.errorMsg).catch(() => '');
      const state = await page.evaluate((sel) => {
        const b = document.querySelector(sel);
        return b ? { found: true, disabled: b.disabled, text: (b.textContent || '').trim().slice(0, 40) }
          : { found: false };
      }, SEL.loginBtn).catch(() => ({ found: false }));

      throw new Error(
        'AWSAT login did not go through. Four submit mechanisms were tried '
        + '(click, Enter, dispatched mouse events, form submit) and the board '
        + `never appeared.\n  button: ${JSON.stringify(state)}\n`
        + `  message on page: ${shown ? shown.trim() : '(none)'}\n`
        + '  If the message names bad credentials, fix them before re-running — '
        + 'attempts are capped per day.',
      );
    }

    log.info('awsat: login submitted', { via: submitted });

    await page.waitForSelector(SEL.bodyContainer, { timeout: 90_000 });
    loggedIn = true;
    guard.recordSuccess();
    log.info('awsat: logged in', guard.summary());
  } catch (err) {
    loginFailed = true;
    const shown = await page.textContent(SEL.errorMsg).catch(() => '');
    const detail = `${err.message} ${shown || ''}`;
    // WHAT COUNTS AS A LOCKOUT, precisely.
    //
    // The previous test was /lock|1841841|too many|attempt/i and it was far too
    // loose. "lock" is a substring of BLOCKED, DEADLOCK and CLOCK, and
    // "attempt" appears in this file's own login-failure message — so an
    // ordinary network error, or a failed submit, permanently disabled the
    // account and left no way to clear it.
    //
    // A lockout is a claim the BROKER makes, so match the phrases a broker
    // actually uses. \b before "lock" is what keeps "blocked" out: the boundary
    // is at the start of the word, and "blocked" begins with b.
    const BROKER_LOCKOUT = new RegExp([
      '\\block(ed|out)\\b',
      // NOT a bare "exceeded": Playwright says "Timeout 30000ms exceeded" on
      // every slow page, and that would disable the account for a slow morning.
      // It has to be an exceeded LOGIN LIMIT.
      '(login|attempt|logon)[^.]{0,40}exceeded',
      'exceeded[^.]{0,40}(login|attempt|logon)',
      'maximum\\s+number\\s+of\\s+login',
      'already\\s+(logged|active)',
      'invalid\\s+(user|password|credential)',
      '1841841',
    ].join('|'), 'i');

    if (BROKER_LOCKOUT.test(detail)) guard.recordLockout(detail);
    else log.warn('awsat: login failed, but not a broker lockout — the account '
      + 'is NOT disabled', { detail: String(detail).slice(0, 200) });
    log.error('awsat: login failed', { err: log.serializeError(err), shown, guard: guard.summary() });
    throw err;
  }
}

// ─── board ──────────────────────────────────────────────────────────────────

/** Read every rendered row, joining the left (symbol) and right (values) blocks. */
async function readBoard(target) {
  return target.evaluate((cfg) => {
    // The terminal keeps a container per market and toggles VISIBILITY rather
    // than replacing content. Taking the first match therefore reads whichever
    // market happens to be first in the DOM — in testing that meant the Main
    // sweep silently returned Premier's rows, stored under Main's name. Prefer
    // a container that is actually on screen.
    const bodies = [...document.querySelectorAll(cfg.bodyContainer)];
    const usable = bodies.filter((b) => b.querySelector(cfg.symbolCell) && b.querySelector('[cell-id]'));
    const body = usable.find((b) => b.offsetParent !== null) || usable[0] || bodies[0];
    if (!body) return [];

    const left = body.querySelector(cfg.leftBlock);
    const right = body.querySelector(cfg.rightBlock);
    if (!left || !right) return [];

    // The two blocks are parallel lists: row N on the left is row N on the
    // right. They are joined by INDEX, which is why both are read in the same
    // evaluate call — reading them separately lets the table re-render between
    // and silently pairs one symbol with another symbol's values.
    // JOIN BY style.top, NOT BY INDEX.
    //
    // The rows are virtualised and absolutely positioned, so the left and right
    // blocks can hold them in different orders. Pairing by index then attaches
    // one symbol's ticker to another symbol's numbers — every row looks valid
    // and the data is silently wrong.
    const symByTop = {};
    left.querySelectorAll(cfg.row).forEach((r) => {
      const el = r.querySelector(cfg.symbolCell);
      if (el) symByTop[r.style.top] = el.textContent.trim();
    });

    const out = [];
    right.querySelectorAll(cfg.row).forEach((r) => {
      const rec = { __symbolRaw: symByTop[r.style.top] || null };
      r.querySelectorAll('[cell-id]').forEach((c) => {
        rec[c.getAttribute('cell-id')] = c.textContent.trim();
      });
      out.push(rec);
    });
    return out;
  }, SEL);
}

/**
 * Scroll one step with a real wheel event over the board.
 *
 * The Ember table listens for wheel events; setting scrollTop on the container
 * moves the scrollbar without asking the virtualiser to render new rows.
 */
async function wheelStep(page, box) {
  if (!box) return;
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 250));
  await page.mouse.wheel(0, WHEEL_DELTA);
}

/** Legacy container scroll, kept for the fixture path. */
async function scrollStep(page) {
  return page.evaluate((args) => {
    const bodies = [...document.querySelectorAll(args.cfg.bodyContainer)];
    const withRows = bodies.filter((b) => b.querySelector(args.cfg.symbolCell));
    const body = withRows.find((b) => b.offsetParent !== null) || withRows[0] || bodies[0];
    if (!body) return true;
    body.scrollTop += args.delta;
    return body.scrollTop + body.clientHeight >= body.scrollHeight - 2;
  }, { cfg: SEL, delta: WHEEL_DELTA });
}

/**
 * Switch the board to a named market, and VERIFY it actually switched.
 *
 * Verification is the point. A click that silently does nothing leaves the
 * previous market's rows on screen, and they are then stored under the NEW
 * market's name — which is worse than missing data, because every row looks
 * perfectly valid and the two markets become indistinguishable.
 *
 * Caught by running this against a real browser: the Main sweep returned five
 * symbols when Main has three, because it had re-read Premier.
 *
 * @returns {Promise<{switched: boolean, reason: string}>}
 */
/**
 * Click the first VISIBLE element whose text matches.
 *
 * The board renders each market name MORE THAN ONCE: the dropdown toggle, plus
 * hidden Sector-Overview labels like "Main Market Index (PR)". Taking .first()
 * resolves to one of those hidden spans and the click then spins until it times
 * out, so visibility is required and "Index" labels are excluded.
 */
async function clickVisibleText(page, label, timeout = 6_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const candidates = [
      page.getByText(label, { exact: true }).filter({ visible: true }),
      page.getByText(label, { exact: false }).filter({ visible: true, hasNotText: /index/i }),
    ];
    for (const loc of candidates) {
      const n = await loc.count().catch(() => 0);
      for (let i = 0; i < n; i += 1) {
        const el = loc.nth(i);
        if (!(await el.isVisible().catch(() => false))) continue;
        try {
          await el.click({ timeout: 1_500 });
          return true;
        } catch { /* obscured or detached — try the next match */ }
      }
    }
    await page.waitForTimeout(150);
  }
  return false;
}

/**
 * Switch markets through the dropdown.
 *
 * TWO STEPS, not one. The toggle displays the CURRENT market's label, so the
 * dropdown must be opened by clicking THAT before the target option exists in
 * the DOM. Clicking the target directly is why the first market appeared to
 * work (it was already displayed) and the second never did.
 */
async function selectMarket(page, current, target) {
  const opened = await clickVisibleText(page, current, 6_000);
  if (!opened) {
    return { switched: false, reason: `could not open the market dropdown (toggle "${current}")` };
  }
  await page.waitForTimeout(800);

  const picked = await clickVisibleText(page, target, 6_000);
  if (!picked) {
    await page.keyboard.press('Escape').catch(() => {});   // don't leave it hanging open
    return { switched: false, reason: `dropdown opened but "${target}" was not clickable` };
  }
  await page.waitForTimeout(2_500);
  return { switched: true, reason: 'dropdown' };
}

/**
 * Read the board from the price socket.
 *
 * No scrolling, no market dropdown, no left/right pairing: the socket carries
 * every symbol in both markets. Everything the DOM path needed those for was a
 * consequence of reading the render instead of the source.
 */
async function scrapeBoardFromSocket({ runId, createdAt, tradingDate, batchId }) {
  const data = await socketTap.waitForData(sharedPage, {
    timeoutMs: Number(process.env.AWSAT_SOCKET_WAIT_MS || 60_000),
    minRows: Number(process.env.AWSAT_SOCKET_MIN_ROWS || 1),
  });

  if (!data.ready) {
    throw new Error(
      'the socket tap never initialised — window.__awsatTap is absent.\n'
      + '  addInitScript must run BEFORE navigation; if the page was opened\n'
      + '  outside getPage() the tap was never installed.',
    );
  }
  if (!data.rows.length) {
    throw new Error(
      `socket tap saw ${data.frames} frame(s) and ${data.masterRows} master row(s) `
      + 'but produced no joined rows.\n'
      + '  frames but no master  -> the symbol master XHR was never seen\n'
      + '  master but no frames  -> the wsqs socket was not intercepted\n'
      + '  both present, no rows -> every sym code was unmatched',
    );
  }

  if (data.unmatchedCount) {
    // A rising unmatched count means the master is stale — which looks exactly
    // like symbols disappearing from the board.
    log.warn('awsat: socket codes with no master entry', {
      count: data.unmatchedCount, sample: data.unmatched,
    });
  }

  const quotes = [];
  const symbols = [];
  for (const r of data.rows) {
    const symbol = parse.toSymbol(r.symbol || r.code);
    if (!symbol) continue;

    quotes.push({
      scrape_batch_id: batchId,
      market: r.market || 'UNKNOWN',
      symbol,
      code: r.code || null,
      description: r.description || null,
      last_price: num(r.last),
      last_qty: num(r.lastQty),
      chg: num(r.chg, true),
      pct_chg: num(r.pctChg, true),
      volume: num(r.volume),
      bid: num(r.bid),
      bid_qty: num(r.bidQty),
      offer: num(r.offer),
      offer_qty: num(r.offerQty),
      trades: num(r.trades),
      last_trade_date: null,
      last_trade_time: parse.toTime(r.lutt),
      open_price: num(r.open),
      high_price: num(r.high),
      low_price: num(r.low),
      session: r.session || null,
      nms: num(r.nms),
      trading_date: tradingDate,
      source: SOURCE,
      ingest_source: 'awsat_server',
      source_precedence: 1,
      run_id: runId,
      created_at: createdAt,
    });
    symbols.push({
      market: r.market || 'UNKNOWN', symbol, code: r.code, description: r.description,
    });
  }

  log.info('awsat: board read from socket', {
    frames: data.frames, masterRows: data.masterRows,
    symbols: quotes.length, unmatched: data.unmatchedCount || 0,
    markets: [...new Set(quotes.map((q) => q.market))],
    stale: data.staleCount || 0,
    oldestPriceSec: Math.round((data.oldestPriceMs || 0) / 1000),
    lastFrameAgeSec: data.lastFrameAgeMs === null ? null : Math.round(data.lastFrameAgeMs / 1000),
  });

  // Stale symbols are reported, not dropped: the last known price is still the
  // last known price, and removing it turns a flat symbol into a gap.
  if (data.staleCount) {
    log.warn('awsat: symbols with no price update in the staleness window', {
      count: data.staleCount, sample: data.staleSymbols,
    });
  }

  return { quotes, symbols, diagnostics: data };
}

/**
 * Compare the two collectors field by field.
 *
 * Reported, never merged: the point is to decide whether the socket path is
 * complete, and averaging the two would hide precisely the gaps being looked
 * for.
 */
function compareBoards(socketQuotes, domQuotes) {
  const bySym = (list) => new Map(list.map((q) => [q.symbol, q]));
  const S = bySym(socketQuotes);
  const D = bySym(domQuotes);

  const onlySocket = [...S.keys()].filter((k) => !D.has(k));
  const onlyDom = [...D.keys()].filter((k) => !S.has(k));

  const FIELDS = ['last_price', 'chg', 'pct_chg', 'volume', 'bid', 'bid_qty',
    'offer', 'offer_qty', 'trades', 'open_price', 'high_price', 'low_price', 'session'];

  const fieldStats = {};
  for (const f of FIELDS) {
    fieldStats[f] = { socket: 0, dom: 0, differ: 0 };
  }
  const examples = [];

  for (const [sym, s] of S) {
    const d = D.get(sym);
    for (const f of FIELDS) {
      if (s[f] !== null && s[f] !== undefined) fieldStats[f].socket += 1;
      if (d && d[f] !== null && d[f] !== undefined) fieldStats[f].dom += 1;
      if (d && s[f] !== null && d[f] !== null && String(s[f]) !== String(d[f])) {
        fieldStats[f].differ += 1;
        if (examples.length < 8) examples.push({ symbol: sym, field: f, socket: s[f], dom: d[f] });
      }
    }
  }

  const marketsOf = (list) => {
    const m = {};
    for (const q of list) m[q.market || 'UNKNOWN'] = (m[q.market || 'UNKNOWN'] || 0) + 1;
    return m;
  };

  return {
    socketSymbols: S.size,
    domSymbols: D.size,
    socketMarkets: marketsOf(socketQuotes),
    domMarkets: marketsOf(domQuotes),
    onlyInSocket: onlySocket.slice(0, 25),
    onlyInSocketCount: onlySocket.length,
    onlyInDom: onlyDom.slice(0, 25),
    onlyInDomCount: onlyDom.length,
    duplicateSymbolsSocket: socketQuotes.length - S.size,
    duplicateSymbolsDom: domQuotes.length - D.size,
    fieldCoverage: fieldStats,
    valueDisagreements: examples,
  };
}

async function scrapeBoard({ runId }) {
  const createdAt = new Date();
  const tradingDate = clock.tradingDay(createdAt);
  const batchId = require('crypto').randomUUID();

  return runOnSession(async (page) => {
    await ensureLogin(page);

    if (BOARD_MODE === 'socket') {
      const out = await scrapeBoardFromSocket({ runId, createdAt, tradingDate, batchId });
      return { quotes: out.quotes, symbols: out.symbols };
    }

    // 'both' reads the socket FIRST: it is the result that gets stored, and a
    // DOM failure must not cost the capture.
    let socketOut = null;
    if (BOARD_MODE === 'both') {
      try {
        socketOut = await scrapeBoardFromSocket({ runId, createdAt, tradingDate, batchId });
      } catch (err) {
        log.error('awsat: socket path failed — falling back to DOM for this cycle', {
          err: err.message.split('\n')[0],
        });
      }
    }

    // The board may be in a frame, or in a tab login opened. Find it.
    const { page: boardPage, target } = await findBoardTarget(DATA_WAIT_MS);

    const boxHandle = await target.evaluateHandle((cfg) => {
      const bodies = [...document.querySelectorAll(cfg.bodyContainer)];
      return bodies.find((b) => b.querySelector(cfg.symbolCell) && b.querySelector('[cell-id]'))
        || bodies[0] || null;
    }, SEL);
    const el = boxHandle.asElement();
    const box = el ? await el.boundingBox().catch(() => null) : null;

    const quotes = [];
    const symbols = [];
    const seenAcrossMarkets = new Set();

    // The terminal opens on this market; the toggle shows whichever is current.
    let current = MARKETS[0];

    for (let i = 0; i < MARKETS.length; i += 1) {
      const market = MARKETS[i];

      if (i > 0) {
        const sw = await selectMarket(boardPage, current, market);
        if (!sw.switched) {
          log.error('awsat: market switch failed — skipping rather than storing '
            + 'another market\'s rows under its name', { market, reason: sw.reason });
          continue;
        }
        current = market;
      }

      const collected = new Map();
      let stalls = 0;

      for (let n = 0; n < HARD_SCROLL_CAP; n += 1) {
        const before = collected.size;

        for (const rec of await readBoard(target)) {
          const { symbol, code } = parseSymbol(rec.__symbolRaw);
          if (!symbol) continue;

          const row = {
            scrape_batch_id: batchId, market, symbol, code,
            trading_date: tradingDate, source: SOURCE, ingest_source: 'awsat_server',
            source_precedence: 1, run_id: runId, created_at: createdAt,
          };
          for (const [cellId, col] of Object.entries(FIELD_MAP)) {
            const raw = rec[cellId];
            if (raw === undefined || TRANSIENT.test(raw || '')) continue;
            if (col === 'last_trade_date') row[col] = toDate(raw);
            else if (NUMERIC.has(col)) row[col] = num(raw, SIGNED.has(col));
            else row[col] = parse.clean(raw);
          }

          // Keep the RICHEST version: a row read mid-render can be half empty,
          // and the later read of the same symbol is the better one.
          const prev = collected.get(symbol);
          if (!prev || Object.values(row).filter((v) => v !== null && v !== undefined).length
                     >= Object.values(prev).filter((v) => v !== null && v !== undefined).length) {
            collected.set(symbol, row);
          }
        }

        if (collected.size === before) {
          stalls += 1;
          if (stalls >= MAX_STALLS) break;
        } else stalls = 0;

        await wheelStep(boardPage, box);
        await boardPage.waitForTimeout(SETTLE_MS);
      }

      // Back to the top so the next market starts clean.
      if (box) {
        await boardPage.mouse.move(box.x + box.width / 2, box.y + 100).catch(() => {});
        await boardPage.mouse.wheel(0, -999999).catch(() => {});
      }

      let duplicates = 0;
      for (const row of collected.values()) {
        if (seenAcrossMarkets.has(row.symbol)) { duplicates += 1; continue; }
        seenAcrossMarkets.add(row.symbol);
        quotes.push(row);
        symbols.push({
          market, symbol: row.symbol, code: row.code, description: row.description,
        });
      }

      if (duplicates && duplicates === collected.size) {
        log.error('awsat: every symbol here was already seen in another market — '
          + 'the board did not change', { market, duplicates });
      }
      log.info('awsat: market swept', {
        market, symbols: collected.size, stored: collected.size - duplicates,
      });
    }

    if (BOARD_MODE === 'both' && socketOut) {
      log.info('awsat: SOCKET vs DOM comparison',
        compareBoards(socketOut.quotes, quotes));
      // The socket result is what gets stored; the DOM sweep was for comparison.
      return { quotes: socketOut.quotes, symbols: socketOut.symbols };
    }

    if (!quotes.length) {
      throw new Error(
        `AWSAT board produced no rows across: ${MARKETS.join(', ')}.`,
      );
    }
    return { quotes, symbols };
  });
}

// ─── depth ──────────────────────────────────────────────────────────────────

async function scrapeDepth({ runId }) {
  const wanted = config.awsat.depthSymbols;
  if (!wanted.length) {
    log.info('awsat: DEPTH_SYMBOLS is empty — skipping depth');
    return { levels: [], symbols: [] };
  }

  const tradingDate = clock.tradingDay();

  return runOnSession(async (page) => {
    await ensureLogin(page);
    const levels = [];
    let previousLadder = null;

    // Checked ONCE, before the loop.
    //
    // It used to live inside the per-symbol try/catch, so the abort it raised
    // was caught by that same catch and re-thrown for every symbol in turn —
    // four identical "no depth panel matched" failures where one was intended,
    // and the job still reported SUCCESS with zero rows.
    const panelCount = await page.evaluate(
      (sel) => document.querySelectorAll(sel).length, SEL.depthContainer,
    ).catch(() => 0);

    if (!panelCount) {
      throw new Error(
        `no depth panel matched AWSAT_SEL_DEPTH="${SEL.depthContainer}".\n`
        + `  Depth was NOT captured for any of ${wanted.length} symbol(s).\n`
        + '  Find the real container with:\n'
        + '      HEADLESS=false npm run run:once awsat.depth\n'
        + '  or settle whether depth arrives over the socket instead:\n'
        + '      HEADLESS=false npm run awsat:discover',
      );
    }

    for (const raw of wanted) {
      const symbol = parse.toSymbol(raw);
      if (!symbol) continue;
      const createdAt = new Date();   // one stamp per book, so it reassembles

      try {
        // Clear the overlay BEFORE reaching for the search box, or the click
        // is retried for thirty seconds against an intercepting layer.
        await clearOverlays(page);

        const search = page.locator(SEL.symbolSearch).first();
        // force: the overlay may be re-added between the check and the click,
        // and a symbol search is safe to dispatch directly.
        await search.click({ timeout: 10_000, force: true });
        await search.fill('');
        await search.pressSequentially(symbol, { delay: 40 });
        await page.keyboard.press('Enter');

        // VERIFY THE LADDER BELONGS TO THIS SYMBOL BEFORE READING IT.
        //
        // Checking that the symbol appears somewhere on the page is not enough:
        // the ticker updates as soon as the search is submitted, while the book
        // itself arrives afterwards. Reading in that gap captures the PREVIOUS
        // symbol's ladder under this symbol's name — every row valid-looking,
        // every row wrong. This waits for the depth widget's OWN label.
        const matched = await page.waitForFunction(
          (args) => {
            // Prefer a container matching the DEPTH selector; fall back to the
            // last body container, which is where the panel usually sits.
            // Dedicated container ONLY. Falling back to another table means
            // verifying against the board — which contains every symbol, so the
            // check passes trivially and the board is then read as a ladder.
            const box = [...document.querySelectorAll(args.depth)]
              .find((b) => b.querySelector(args.cell));
            if (!box) return false;
            const label = box.querySelector(args.cell);
            return label && label.textContent.toUpperCase().includes(args.symbol);
          },
          {
            container: SEL.bodyContainer, depth: SEL.depthContainer,
            cell: SEL.symbolCell, symbol,
          },
          { timeout: 15_000 },
        ).then(() => true).catch(() => false);

        if (!matched) {
          // The panel exists (checked before the loop) but never showed THIS
          // symbol, so this is a per-symbol miss and the sweep continues.
          log.warn('awsat: depth panel never showed this symbol — skipping it '
            + 'rather than storing another symbol\'s book', { symbol });
          continue;
        }
        await page.waitForTimeout(SETTLE_MS);

        const found = await findPanelTarget(SEL.depthContainer, 8_000);
        const readTarget = found ? found.target : page;

        /**
         * Read the ladder.
         *
         * Bids and offers arrive INTERLEAVED in one list and are separated by
         * colour class, not by column: up-fore-color / table-row-up is a bid,
         * down-fore-color / table-row-down is an offer. Each side is then
         * sorted on its own — bids high to low, offers low to high — and the
         * two are zipped into levels.
         *
         * Zipping matters: the two sides can have different depths, so pairing
         * by list position rather than by price is what keeps level 1 as the
         * touch on both sides.
         */
        const levelsRaw = await readTarget.evaluate((cfg) => {
          const scopes = [...document.querySelectorAll(cfg.depthContainer)];
          if (!scopes.length) return null;

          const clean = (t) => (t || '').replace(/[\u202A\u202B\u202C]/g, '').replace(/\s+/g, ' ').trim();

          let best = [];
          for (const scope of scopes) {
            const bids = [];
            const offers = [];

            scope.querySelectorAll(cfg.depthRow).forEach((row) => {
              const priceEl = row.querySelector(cfg.depthPrice);
              if (!priceEl) return;
              const price = clean(priceEl.textContent);
              if (!price || !/\d/.test(price)) return;
              const qtyEl = row.querySelector(cfg.depthQty);
              const qty = qtyEl ? clean(qtyEl.textContent) : null;

              const cls = `${priceEl.className || ''} ${row.className || ''}`;
              if (/up-fore-color|table-row-up/.test(cls)) bids.push({ price, qty });
              else if (/down-fore-color|table-row-down/.test(cls)) offers.push({ price, qty });
            });

            if (!bids.length && !offers.length) continue;
            const n = Math.max(bids.length, offers.length);
            const out = [];
            for (let i = 0; i < n; i += 1) {
              out.push({
                level: i + 1,
                bid: bids[i] ? bids[i].price : null,
                bidQty: bids[i] ? bids[i].qty : null,
                offer: offers[i] ? offers[i].price : null,
                offerQty: offers[i] ? offers[i].qty : null,
              });
            }
            if (out.length > best.length) best = out;
          }
          return best;
        }, SEL);

        if (levelsRaw === null) {
          throw new Error(
            `no ladder matched AWSAT_SEL_DEPTH="${SEL.depthContainer}".`,
          );
        }

        const rows = levelsRaw;

        // A ladder identical to the previous symbol's is almost certainly the
        // previous symbol's. Two books matching on price AND quantity at every
        // level does happen, but rarely enough to be worth saying out loud.
        const fingerprint = JSON.stringify(rows);
        if (fingerprint === previousLadder) {
          log.warn('awsat: this book is identical to the previous symbol\'s — '
            + 'the depth panel may not have refreshed', { symbol });
        }
        previousLadder = fingerprint;

        let level = 0;
        for (const L of rows) {
          const bid = num(L.bid);
          const offer = num(L.offer);
          if (bid === null && offer === null) continue;
          level += 1;
          if (level > 20) break;      // matches the awsat_stock_depth CHECK
          levels.push({
            symbol, level, bid, bid_qty: num(L.bidQty), bid_orders: null,
            offer, offer_qty: num(L.offerQty), offer_orders: null,
            trading_date: tradingDate, ingest_source: 'awsat_server',
            run_id: runId, created_at: createdAt,
          });
        }
      } catch (err) {
        // One unreadable symbol must not lose the rest of the sweep.
        log.warn('awsat: depth failed for symbol', { symbol, err: err.message });
      }
    }

    return { levels, symbols: [] };
  });
}

// ─── orders ─────────────────────────────────────────────────────────────────

async function scrapeOrders({ runId }) {
  const createdAt = new Date();
  const tradingDate = clock.tradingDay(createdAt);

  return runOnSession(async (page) => {
    await ensureLogin(page);

    /**
     * The Order List is an Ember grid read BY cell-id, not by column position.
     *
     * It splits into two DOM subtrees — a left block with the symbol and a
     * right block with everything else — and the two halves of one row share an
     * inline `top:Npx`. That is the join key. Reading positionally, as this used
     * to, gave a company name in order_id and a price in symbol.
     *
     * Some columns are scrolled out of view horizontally but still present in
     * the DOM, so every cell-id is collected regardless of visibility.
     */
    const CELL_MAP = {
      'symbolInfo.dispProp1': 'symbolRaw',
      clOrdId: 'order_id',
      ordSts: 'order_status',
      ordSide: 'side',
      ordQty: 'quantity',
      price: 'price',
      cumQty: 'filled_quantity',
      pendQty: 'remaining_qty',
      adjustedCrdDte: 'order_stamp',
    };

    const panel = await findPanelTarget(SEL.orderContainer, 10_000);
    const found = await (panel ? panel.target : page).evaluate((args) => {
      const widget = document.querySelector(args.cfg.orderContainer)
        || (document.querySelector('[cell-id="clOrdId"]') || {}).closest?.('.widget_new');
      if (!widget) return { panel: false, rows: [] };

      const body = widget.querySelector('.ember-table-body-container')
        || widget.querySelector('.ember-table-tables-container') || widget;

      const clean = (t) => (t || '').replace(/[\u202A\u202B\u202C]/g, '').replace(/\s+/g, ' ').trim();

      // Group both halves of a row by their shared inline top offset.
      const buckets = new Map();
      body.querySelectorAll('.ember-table-table-row').forEach((row) => {
        if (String(row.className).includes('header-row')) return;
        const m = (row.getAttribute('style') || '').match(/top:\s*(-?[\d.]+)px/);
        const key = m ? `T${Math.round(parseFloat(m[1]))}`
          : `R${Math.round(row.getBoundingClientRect().top)}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(row);
      });

      const out = [];
      for (const halves of buckets.values()) {
        const rec = {};
        let hits = 0;
        for (const row of halves) {
          for (const cell of row.querySelectorAll('[cell-id]')) {
            const id = cell.getAttribute('cell-id');
            const text = clean(cell.textContent);
            const title = clean(cell.getAttribute('title'));
            const value = text || title;
            if (!value) continue;
            // The broker's rejection reason lives in the status cell's title.
            if (id === 'ordSts' && title && title !== text) rec.statusReason = title;
            const field = args.map[id];
            if (field && rec[field] == null) { rec[field] = value; hits += 1; }
          }
        }
        if (hits && (rec.order_id || rec.symbolRaw)) out.push(rec);
      }
      return { panel: true, rows: out };
    }, { cfg: SEL, map: CELL_MAP });

    if (!found.panel) {
      throw new Error(
        `no order-list panel matched AWSAT_SEL_ORDERS="${SEL.orderContainer}".\n`
        + '  Orders were NOT captured. Refusing to read another table instead.\n'
        + '  Find it with: HEADLESS=false npm run run:once awsat.orders',
      );
    }

    const rows = found.rows;
    // An empty order list is normal — the trader may simply have none live.
    if (!rows.length) {
      log.info('awsat: order list is empty');
      return { orders: [] };
    }

    const orders = [];
    for (const r of rows) {
      const orderId = parse.clean(r.order_id);
      // Without an id the row cannot be deduplicated across captures or
      // reconciled against a fill later.
      if (!orderId) continue;

      const quantity = num(r.quantity);
      const filled = num(r.filled_quantity);
      const sym = parseSymbol(r.symbolRaw);

      // "10-08-2026 13:03:30" -> a real timestamp. Split before parsing: the
      // date half is DD-MM-YYYY, which Date() reads as a US date or not at all.
      let orderTime = null;
      if (r.order_stamp) {
        const [d, t] = String(r.order_stamp).trim().split(/\s+/);
        const iso = toDate(d);
        if (iso && /^\d{1,2}:\d{2}(:\d{2})?$/.test(t || '')) orderTime = new Date(`${iso}T${t}`);
      }

      orders.push({
        order_id: orderId,
        symbol: sym.symbol,
        side: parse.toSide(r.side),
        order_status: parse.clean(r.order_status),
        price: num(r.price),
        quantity,
        filled_quantity: filled,
        remaining_qty: num(r.remaining_qty)
          ?? ((quantity !== null && filled !== null && filled <= quantity)
            ? quantity - filled : null),
        order_time: orderTime,
        trading_date: tradingDate,
        ingest_source: 'awsat_server',
        run_id: runId,
        created_at: createdAt,
      });
    }

    return { orders };
  });
}

/** The live session page, for diagnostic scripts. Null before login. */
function sharedPageForDiagnostics() {
  return sharedPage && !sharedPage.isClosed() ? sharedPage : null;
}

module.exports = {
  scrapeBoard, scrapeDepth, scrapeOrders, closeSession, SOURCE,
  sharedPageForDiagnostics,
  scrapeBoardFromSocket, compareBoards, BOARD_MODE,
  parseSymbol, num, toDate, FIELD_MAP, SEL, MARKETS, WHEEL_DELTA,
};

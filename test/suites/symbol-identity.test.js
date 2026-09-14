'use strict';
/**
 * P2 · two ways the server-side scraper stored one instrument's data under
 * another instrument's name.
 *
 * ─── ABAR IS NOT ABARRE ────────────────────────────────────────────────────
 * Both of the depth path's guards tested `text.includes(symbol)`:
 *
 *   · the waitForFunction verification — "is the panel showing what I asked
 *     for?"
 *   · the F-17 owns() re-check at the read — "does this container claim this
 *     symbol?", added precisely because the read used to walk every container
 *     and keep whichever gave the most levels.
 *
 * "ABARRE" contains "ABAR". The sibling userscript solved this and says why
 * (awsat-depth-all.user.js, findResult): a substring match happily selects the
 * RIGHTS LINE when the real listing is one row further down. And this scraper
 * selects by typing the ticker and pressing Enter, which takes the highlighted
 * dropdown row — exactly the mechanism that lands on the rights line.
 *
 * So the panel shows "ABARRE - 634", both guards pass on the same wrong panel,
 * and ABARRE's ladder is written to awsat_stock_depth as ABAR's book: every
 * level, every price real, nothing to distinguish it. The guard and its backstop
 * were the same test, and one operator defeated both.
 *
 * ─── AND THE BOARD SWEEP ASSUMED WHICH MARKET IT WAS LOOKING AT ────────────
 *
 *   // The terminal opens on this market; the toggle shows whichever is current.
 *   let current = MARKETS[0];
 *
 * True of a freshly opened terminal, false of every sweep after the first: the
 * page is SHARED and PERSISTENT and the sweep never switched back, so the board
 * is left displaying Main Market. On the next sweep, i = 0 labelled that
 * 'Premier Market' — with no verification, because the selectMarket check only
 * ran for i > 0 — and then i = 1 tried to open the dropdown by clicking the
 * text "Premier Market", which the toggle no longer said, so Main was skipped
 * entirely. ~98 symbols stored under the wrong market, every price real, with
 * the log reporting a successful sweep.
 */
const fs = require('fs');
const path = require('path');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };

const REPO = path.join(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(REPO, 'src/scrapers/awsat.js'), 'utf8');
const live = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

// ── the matcher, exercised ─────────────────────────────────────────────────
//
// The token regex is lifted from the file and run against the labels the
// terminal actually renders, rather than asserted as a string.
{
  const token = (want) => new RegExp(`(^|[^A-Z0-9])${
    String(want).replace(/[^A-Z0-9]/gi, '')}([^A-Z0-9]|$)`);

  ck('ABAR matches its own panel label', token('ABAR').test('ABAR - 633'));
  ck('ABAR matches with no code', token('ABAR').test('ABAR'));
  ck('and with a description after it', token('ABAR').test('ABAR - 633 AL ARGAN'));

  ck('ABAR DOES NOT MATCH THE RIGHTS LINE', token('ABAR').test('ABARRE - 634') === false);
  ck('nor a longer ticker that merely starts the same',
    token('ABAR').test('ABARXY - 999') === false);
  ck('nor one that ENDS the same — a substring match failed both ways',
    token('BAR').test('ABAR - 633') === false);

  // The reverse must still work: the rights line is a real instrument.
  ck('ABARRE still matches its own label', token('ABARRE').test('ABARRE - 634'));

  // Real Boursa Kuwait prefix pairs.
  ck('GBK does not match GBKRE', token('GBK').test('GBKRE - 101') === false);
  ck('NIND does not match NINDRE', token('NIND').test('NINDRE - 205') === false);
  ck('but GBK matches GBK', token('GBK').test('GBK - 103'));
}

// ── and both guards in the file use it ─────────────────────────────────────
{
  ck('the depth verification no longer uses includes()',
    !/textContent\.toUpperCase\(\)\.includes\(args\.symbol\)/.test(live),
    (live.match(/.*includes\(args\.symbol\).*/g) || []));
  ck('it builds a word-boundary token instead',
    /const token = new RegExp\(`\(\^\|\[\^A-Z0-9\]\)\$\{/.test(live));
  ck('and tests the label against it', /token\.test\(label\.textContent\.toUpperCase\(\)\)/.test(live));

  ck('the F-17 owns() re-check no longer uses includes() either',
    !/text\.includes\(cfg\.want\)/.test(live), (live.match(/.*includes\(cfg\.want\).*/g) || []));
  ck('and uses the same token test', /return !!text && token\.test\(text\)/.test(live));

  // Both, not one: the whole point is that the backstop was the same test.
  const tokens = (live.match(/\(\^\|\[\^A-Z0-9\]\)/g) || []).length;
  ck('there are TWO word-boundary matchers — the guard and its backstop',
    tokens === 2, tokens);
}

// ── the market toggle is read, not assumed ─────────────────────────────────
{
  ck('the assumption is gone', !/let current = MARKETS\[0\]/.test(live),
    (live.match(/.*current = MARKETS.*/g) || []));
  ck('the toggle is read from the page', /readMarketToggle\(boardPage\)/.test(live));
  ck('and the first market is no longer exempt from the check',
    !/if \(i > 0\) \{/.test(live), (live.match(/.*if \(i > 0\).*/g) || []));
  ck('a switch is attempted whenever the board is not already there',
    /if \(current !== market\) \{/.test(live));

  ck('an UNREADABLE toggle refuses the sweep rather than guessing',
    /refusing to sweep rather than labelling rows by assumption/.test(SRC));
  ck('and a switch that reports success is VERIFIED against the toggle',
    /reported success but the toggle/.test(SRC));
  ck('with the verification reading the toggle again, not trusting the click',
    /const now = await readMarketToggle\(boardPage\);/.test(live));
}

// ── the toggle reader itself ───────────────────────────────────────────────
{
  ck('readMarketToggle returns null when nothing names a market',
    /return null;/.test(live.slice(live.indexOf('async function readMarketToggle'),
      live.indexOf('async function selectMarket'))));
  ck('and it only ever returns one of the configured markets',
    /for \(const m of markets\)/.test(live));
  ck('matching the toggle EXACTLY — a market name inside a longer label is not '
    + 'the toggle', /getByText\(m, \{ exact: true \}\)/.test(live));
}

console.log(`\nsymbol identity: ${p}/${n}`);
process.exit(p === n ? 0 : 1);

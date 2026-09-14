'use strict';
/**
 * P2 · three guards that existed, were tested, and were never reached.
 *
 * This is the shape the second review pass kept finding, and it is worth naming:
 * a guard that lives in a function nobody calls is not a guard, and it is worse
 * than no guard because the test that covers it passes.
 *
 * 1 · reportUnmapped (awsat-orders) had ONE call site, inside
 *     `if (!targets.length)` — the grid-does-not-scroll branch. The scrolling
 *     path, which is the normal case because the grid is VIRTUALISED BY DESIGN,
 *     returned without calling it.
 *
 *     It is the only writer of the strings the post guard tests for:
 *
 *       var readNothing = !/NO ORDER ID|none parsed/
 *         .test(stats.scrollNote + ' ' + stats.msg);
 *       if (!rows.length && !readNothing) { ...do not post an empty capture }
 *
 *     whose comment reads: "A grid full of rows discarded for want of an id is
 *     not an empty grid, and saying so sent us looking at the wrong thing for a
 *     session." On the scrolling path readNothing was ALWAYS true, so an empty
 *     COMPLETE capture could be posted for a grid that was full — and the server
 *     judges an order absent by its absence from a complete capture, so every
 *     live resting order reads UNSEEN and stops protecting its depth slot.
 *
 * 2 · maybeRefetchMaster's ON UNMATCHED trigger (awsat-capture) — "a symbol
 *     arrives the master does not know. Precise, and it self-heals within one
 *     poll" — had no call site at all. Only the 30-minute periodic timer called
 *     it, with no symbols, so permanentlyUnmatched was never written either.
 *
 * 3 · and the same file's POST omitted `unmatched`. The SERVER reads
 *     body.unmatched and marks those instruments UNMATCHED — proven end to end
 *     by unmatched-reporting.test.js, with no producer. The server's own
 *     comment on that handler reads "The panel showed 'unmatched: 11' and
 *     nobody read it. A number in a UI…", and the client still put it only in
 *     the panel.
 *
 * ABAR, ACICO, NIND and SOKOUK sat in state 2+3 for eight days: quotes arriving,
 * master not knowing them, dropped every poll, recovery waiting up to thirty
 * minutes instead of one, and nothing in the database or /health saying so.
 */
const fs = require('fs');
const path = require('path');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };

const REPO = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const liveOf = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const ORDERS = read('userscript/awsat-orders.user.js');
const CAPTURE = read('userscript/awsat-capture.user.js');
const SUMMARY = read('userscript/awsat-market-summary.user.js');

// ── 1 · the parse-failure report is reachable on the normal path ───────────
{
  const live = liveOf(ORDERS);
  // Calls, not the declaration — which matches the same text.
  const calls = (live.match(/(?<!function )reportUnmapped\(/g) || []).length;
  ck('reportUnmapped is called from BOTH read paths, not one',
    calls === 2, calls);

  // The scrolling path is the one that returns through the restore timeout.
  // Anchored in the RAW source: the anchor is a comment, which liveOf strips.
  // Anchored in the RAW source (the anchor is a comment, which liveOf strips),
  // then stripped of comments so the ordering checks below see CODE — the
  // explanatory comment there names reportUnmapped too.
  const anchor = ORDERS.indexOf('One last read after restoring');
  const scrolling = liveOf(ORDERS.slice(anchor, anchor + 3500));
  ck('the scrolling path calls it', /reportUnmapped\(/.test(scrolling), scrolling.slice(0, 200));
  ck('and it calls it AFTER the final collect, so it judges the whole scan',
    scrolling.indexOf('collect();') < scrolling.indexOf('reportUnmapped('), 'ordering');
  ck('and before done(), so stats are set when the guard reads them',
    scrolling.indexOf('reportUnmapped(') < scrolling.indexOf('done(['), 'ordering');

  ck('it is told how many orders the scan actually produced',
    /reportUnmapped\(noIdRows, seen, byId\.size\)/.test(live));
  ck('and returns early when the scan parsed something — a scan that read 40 '
    + 'rows and parsed 40 orders is not a parse failure',
  /if \(parsed > 0\) return;/.test(live));

  // The guard it feeds is unchanged, and still tests for those strings.
  ck('the post guard still looks for the strings reportUnmapped writes',
    /readNothing = !\/NO ORDER ID\|none parsed\/i/.test(live));
  ck('CASE-INSENSITIVELY — the scrollNote writes "NO ORDER ID" and '
    + 'reportUnmapped writes "NO order id.", and the sensitive pattern matched '
    + 'only one of them', /none parsed\/i\.test/.test(live));
  ck('and reportUnmapped still writes one of them',
    /NO order id\./.test(ORDERS) && /none parsed/.test(ORDERS));
}

// ── the guard, exercised as logic ──────────────────────────────────────────
{
  // The exact expression from the file, run against the two states it exists
  // to tell apart.
  const readNothing = (scrollNote, msg) => !/NO ORDER ID|none parsed/i.test(`${scrollNote} ${msg}`);
  const wouldPost = (rows, scrollNote, msg) => !(rows === 0 && !readNothing(scrollNote, msg));

  ck('an empty grid IS posted — absence is evidence when the read worked',
    wouldPost(0, '0 row(s) over 4 step(s)', '') === true);
  ck('a grid whose rows were READ BUT NOT PARSED is NOT posted',
    wouldPost(0, '0 row(s) over 40 step(s)',
      '37 row(s) read with NO order id. Unmapped cell-ids: ordNo') === false);
  ck('nor one where rows were present and none parsed at all',
    wouldPost(0, '0 row(s) over 40 step(s)', '37 DOM row(s) present but none parsed') === false);
  ck('and a normal scan with orders is posted', wouldPost(12, '12 row(s) over 8 step(s)', '') === true);
}

// ── 2 and 3 · the unmatched machinery is wired at both ends ────────────────
{
  const live = liveOf(CAPTURE);

  ck('the cycle collects the unmatched symbols', /unmatched\.forEach\(function \(s\) \{ missing\.push\(s\); \}\)/.test(live));
  ck('and triggers the master re-fetch ON them — the documented trigger that '
    + 'had no call site', /maybeRefetchMaster\('unmatched', missing\)/.test(live));
  ck('the periodic trigger still exists too — it catches a master that is '
    + 'WRONG rather than incomplete', /maybeRefetchMaster\('periodic'\)/.test(live));

  ck('and the POST carries them to the server', /unmatched: missing,/.test(live));
  ck('alongside the records', /records: records,/.test(live));

  // The server half is real and unchanged: it reads body.unmatched.
  const ingest = read('src/api/ingest.js');
  ck('the server still reads what the client now sends',
    /body\.unmatched/.test(ingest));
}

// ── the placeholder token refuses rather than 401-looping ──────────────────
{
  for (const [name, src] of [['capture', CAPTURE], ['market-summary', SUMMARY]]) {
    const live = liveOf(src);
    ck(`${name}: an unedited TOKEN is detected`,
      /TOKEN_PLACEHOLDER = TOKEN === 'CHANGE-ME' \|\| !TOKEN/.test(live));
    ck(`${name}: and post() refuses instead of sending`,
      /if \(TOKEN_PLACEHOLDER\) \{[\s\S]{0,300}return Promise\.resolve\(\);/.test(live));
    ck(`${name}: with the reason on the panel`,
      /NOT POSTING — TOKEN is still CHANGE-ME/.test(src));
    ck(`${name}: and once in the console`, /NOTHING will be posted until you do/.test(src));
  }

  // WHY it matters, stated as the failure it replaces: 401 is retryable, so the
  // queue fills and drops the oldest minute — and the heartbeat 401s too, so
  // the server sees nothing at all.
  ck('the reason is recorded where the next reader will find it',
    /401-LOOPING/.test(CAPTURE) && /DROPS THE OLDEST MINUTE/.test(CAPTURE));
}

// ── every script still parses and its two versions agree ───────────────────
{
  for (const [name, src] of [['orders', ORDERS], ['capture', CAPTURE], ['market-summary', SUMMARY]]) {
    const hdr = (src.match(/@version\s+(\d+\.\d+\.\d+)/) || [])[1];
    const panel = (src.match(/var VERSION\s*=\s*'(\d+\.\d+\.\d+)'/) || [])[1];
    ck(`${name}: the header and the panel constant agree`, hdr === panel, [hdr, panel]);
  }
}

console.log(`\nuserscript dead guards: ${p}/${n}`);
process.exit(p === n ? 0 : 1);

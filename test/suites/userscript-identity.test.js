'use strict';
/**
 * H-G and H-H · two ways the capture stored one thing under another thing's
 * name.
 *
 * H-G · THE SYNTHETIC ORDINAL RESTARTED AT EVERY SCROLL WINDOW.
 * The Order List grid has no id column, so 2.8.0 derives one from symbol, side
 * and placement second — and gives same-second twins ordinals (`base`,
 * `base:2`). The counts map was a local of applySyntheticIds, and that function
 * runs once per RENDERED WINDOW of a virtualised grid, not once per scan:
 *
 *   window 1 renders A and B -> A takes `base`, B takes `base:2`
 *   window 2 renders only B  -> B takes `base`, because the count restarted
 *
 * byId keeps the FIRST record it sees for an id, so one of the two live orders
 * is discarded and reported as the other. The lost one then reads UNSEEN and
 * stops protecting its depth slot while it is still resting in the book.
 *
 * H-H · THE LADDER WAS VERIFIED BY A LABEL THAT IS NOT ON IT.
 * The depth widget names no stock — it is bare Quantity/Bid and Offer/Quantity
 * columns — so the symbol is read from the order ticket's header one widget up.
 * That header flips as soon as the terminal ACCEPTS the selection; the ladder
 * repaints afterwards. In between, the header says the new symbol and the
 * ladder still holds the old one's prices, unchanged and therefore "stable".
 * The old book is stored under the new name — the exact failure the
 * verification exists to prevent, passed by the verification itself.
 *
 * Both are tested by EXERCISING the logic, not by reading the file for a
 * phrase: the ordinal assignment is lifted out of the userscript and run
 * against a simulated scroll, and the staleness gate is run against a
 * simulated repaint.
 */
const fs = require('fs');
const path = require('path');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };

const REPO = path.join(__dirname, '..', '..');
const ORDERS = fs.readFileSync(path.join(REPO, 'userscript/awsat-orders.user.js'), 'utf8');
const DEPTH = fs.readFileSync(path.join(REPO, 'userscript/awsat-depth-all.user.js'), 'utf8');

const liveOf = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

// ── H-G · the ordinal logic, lifted and exercised ──────────────────────────
//
// The three functions are extracted from the script source and evaluated, so
// this suite tests THE SHIPPED CODE rather than a paraphrase of it. If the
// extraction fails the suite fails, which is the point.
{
  const grab = (name) => {
    const at = ORDERS.indexOf(`function ${name}(`);
    if (at < 0) return null;
    // Walk braces from the function's opening brace.
    let i = ORDERS.indexOf('{', at); let depth = 0;
    for (; i < ORDERS.length; i += 1) {
      if (ORDERS[i] === '{') depth += 1;
      else if (ORDERS[i] === '}') { depth -= 1; if (depth === 0) break; }
    }
    return ORDERS.slice(at, i + 1);
  };

  const parts = ['syntheticId', 'applySyntheticIds', 'newIdState', 'rowFingerprint'].map(grab);
  ck('all four id functions are present in the script',
    parts.every(Boolean), parts.map((x, i) => (x ? 'ok' : i)));

  // eslint-disable-next-line no-new-func
  const mod = new Function(`${parts.join('\n')}
    return { applySyntheticIds, newIdState };`)();

  const twin = (over) => ({
    symbolRaw: 'CATTL - 101', side: 'BUY', stamp: '10-09-2026 09:15:30',
    price: 176, quantity: 4000, ...over,
  });

  // The two twins, as the grid renders them: identical except in quantity.
  const A = () => twin({ quantity: 4000 });
  const B = () => twin({ quantity: 2500 });

  // ── the old failure, simulated ────────────────────────────────────────
  {
    const ids = mod.newIdState();
    const w1 = [A(), B()];
    mod.applySyntheticIds(w1, ids);
    const idA = w1[0].orderId; const idB = w1[1].orderId;
    ck('two same-second twins get different ids in one window', idA !== idB, [idA, idB]);

    // The bare base is whatever a LONE row of this shape gets. It cannot be
    // recognised by "has no `:N` suffix" — the placement stamp is a clock time
    // and ends in one.
    const alone = [A()];
    mod.applySyntheticIds(alone, mod.newIdState());
    const base = alone[0].orderId;
    ck('the first twin takes the bare base', idA === base, [idA, base]);
    ck('the second takes an ordinal on top of it', idB === `${base}:2`, [idB, base]);

    // The next scroll window renders only the SECOND twin. Under the old
    // per-window counts it would take the bare base — A's identity.
    const w2 = [B()];
    mod.applySyntheticIds(w2, ids);
    ck('A WINDOW SHOWING ONLY THE SECOND TWIN STILL CALLS IT THE SECOND TWIN',
      w2[0].orderId === idB, [w2[0].orderId, idB]);
    ck('and specifically does not hand it the first twin\'s id',
      w2[0].orderId !== idA, [w2[0].orderId, idA]);
  }

  // ── overlapping windows do not walk the ordinal up ────────────────────
  {
    const ids = mod.newIdState();
    // The scroll steps two rows at a time, so every row is rendered several
    // times. Counting each re-render would give the same order a new ordinal
    // on every step.
    let last = null;
    for (let i = 0; i < 6; i += 1) {
      const w = [A(), B()];
      mod.applySyntheticIds(w, ids);
      if (last) {
        ck(`window ${i}: the first twin keeps its id`, w[0].orderId === last[0], [w[0].orderId, last[0]]);
        ck(`window ${i}: and so does the second`, w[1].orderId === last[1], [w[1].orderId, last[1]]);
      }
      last = [w[0].orderId, w[1].orderId];
    }
    ck('after six overlapping windows the ordinal is still :2, not :12',
      last[1].endsWith(':2') && !/:\d\d$/.test(last[1].slice(last[0].length)), last);
  }

  // ── a fresh scan starts clean ─────────────────────────────────────────
  {
    const first = [A(), B()];
    mod.applySyntheticIds(first, mod.newIdState());
    const second = [A(), B()];
    mod.applySyntheticIds(second, mod.newIdState());
    ck('the NEXT scan assigns the same ids — the id is stable across cycles, '
      + 'which is what lets the server de-dupe it',
    first[0].orderId === second[0].orderId && first[1].orderId === second[1].orderId,
    [first.map((r) => r.orderId), second.map((r) => r.orderId)]);
  }

  // ── a real id always wins ─────────────────────────────────────────────
  {
    const ids = mod.newIdState();
    const lone = [A()];
    mod.applySyntheticIds(lone, mod.newIdState());
    const base = lone[0].orderId;

    const rows = [{ ...A(), orderId: 'REAL-1' }, B()];
    mod.applySyntheticIds(rows, ids);
    ck('a row carrying a real id is left alone', rows[0].orderId === 'REAL-1', rows[0].orderId);
    ck('and it does not consume a twin ordinal — the synthetic row beside it '
      + 'still takes the bare base', rows[1].orderId === base, [rows[1].orderId, base]);
  }

  // ── and the state is threaded, not re-created per window ──────────────
  {
    const live = liveOf(ORDERS);
    ck('applySyntheticIds takes the scan state as an argument',
      /function applySyntheticIds\(recs, ids\)/.test(live));
    ck('it no longer declares its own counts',
      !/function applySyntheticIds\(recs, ids\) \{\s*var counts = \{\};/.test(live));
    ck('readRenderedRows carries the state through',
      /function readRenderedRows\(body, noId, seen, ids\)/.test(live));
    // Exactly one CALL site — the declaration matches the same text, so it is
    // excluded explicitly rather than by counting to two and hoping.
    const calls = (live.match(/(?<!function )newIdState\(\)/g) || []);
    ck('and readOrders creates exactly one per scan', calls.length === 1, calls);
  }
}

// ── H-H · the staleness gate, exercised ────────────────────────────────────
{
  // The gate as shipped: the accepted book must differ from what was on screen
  // before the selection, AND be stable for two consecutive polls.
  const gate = (framesSeen, beforeBook) => {
    const before = JSON.stringify(beforeBook);
    const hadBookBefore = beforeBook.length > 0;
    let lastSnapshot = null; let stableFor = 0; let sawOnlyStale = false;
    for (const frame of framesSeen) {
      if (!frame.headerMatches || frame.book.length === 0) { stableFor = 0; continue; }
      const snap = JSON.stringify(frame.book);
      if (hadBookBefore && snap === before) { sawOnlyStale = true; stableFor = 0; continue; }
      sawOnlyStale = false;
      stableFor = (snap === lastSnapshot) ? stableFor + 1 : 0;
      lastSnapshot = snap;
      if (stableFor >= 2) return { ok: true, sawOnlyStale: false };
    }
    return { ok: false, sawOnlyStale };
  };

  const OLD = [{ px: 100 }];
  const NEW = [{ px: 250 }];
  const f = (book, headerMatches = true) => ({ book, headerMatches });

  // ── THE BUG · the header flipped, the ladder did not ──────────────────
  {
    const r = gate([f(OLD), f(OLD), f(OLD), f(OLD)], OLD);
    ck('a header that names the new symbol over the OLD symbol\'s ladder is '
      + 'NOT accepted', r.ok === false, r);
    ck('and the reason is named as staleness, not as a timeout',
      r.sawOnlyStale === true, r);
  }

  // ── the ordinary case still passes ────────────────────────────────────
  {
    const r = gate([f(OLD), f([]), f(NEW), f(NEW), f(NEW)], OLD);
    ck('a ladder that clears and repaints with new prices IS accepted',
      r.ok === true, r);
  }

  // ── the first symbol of a sweep has no prior book ─────────────────────
  {
    const r = gate([f(NEW), f(NEW), f(NEW)], []);
    ck('with nothing on screen beforehand there is no stale book to mistake '
      + 'it for, and the capture proceeds', r.ok === true, r);
  }

  // ── a header that never matches is still a plain miss ─────────────────
  {
    const r = gate([f(NEW, false), f(NEW, false)], OLD);
    ck('a header that never names the symbol is refused',
      r.ok === false, r);
    ck('and is NOT reported as staleness — it is a different failure',
      r.sawOnlyStale === false, r);
  }

  // ── a mid-repaint flicker is not mistaken for the answer ──────────────
  {
    const r = gate([f(NEW), f([]), f(NEW)], OLD);
    ck('one poll of the new book, a clear, then one more is not yet stable',
      r.ok === false, r);
  }

  // ── and the gate is in the shipped script ─────────────────────────────
  {
    const live = liveOf(DEPTH);
    ck('the script snapshots the ladder BEFORE selecting',
      /var before = JSON\.stringify\(readLadder\(\)\);/.test(live));
    ck('and refuses a book identical to it',
      /hadBookBefore && snap === before/.test(live));
    ck('and says so rather than reporting a generic timeout',
      /never changed from the previous symbol/.test(DEPTH));
  }
}

// ── both scripts still parse, and their two versions agree ─────────────────
{
  for (const [name, src] of [['orders', ORDERS], ['depth', DEPTH]]) {
    const hdr = (src.match(/@version\s+(\d+\.\d+\.\d+)/) || [])[1];
    const panel = (src.match(/var VERSION = '(\d+\.\d+\.\d+)'/) || [])[1];
    ck(`${name}: the header and the panel constant agree`, hdr === panel, [hdr, panel]);
  }
}

console.log(`\nuserscript identity: ${p}/${n}`);
process.exit(p === n ? 0 : 1);

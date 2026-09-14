'use strict';
/**
 * F-05 · a negative value in an unsigned field is REFUSED, on both paths.
 *
 * Both the scraper (`awsat.js` `num()`) and the ingest mapper (`ingest.js`
 * `n()`) took `Math.abs` of a negative, with the reasoning that "an unsigned
 * field that came back negative is a misread, not a negative price".
 *
 * The reasoning is right and is exactly why the value must not be kept. A
 * misread is a cell read from the WRONG COLUMN — a `chg` of -5 drifting into
 * the `bbp` position — and taking its absolute value turns it into a bid of 5:
 * a real, tradeable-looking price that nothing downstream can distinguish from
 * a measured one.
 *
 * On the ingest path it was worse than a bad value. It made validate.js's
 * negative-price check DEAD CODE:
 *
 *     // A negative price is always a misread; the row is not worth keeping.
 *     if (isImpossible(q[f], MAX_PRICE)) return { ok: false, ... }
 *
 * isImpossible tests n < 0, and the sign was gone before it ran. The row was
 * then stored with source_precedence 2 — the highest — so it OUTRANKED the
 * server's own capture of the same minute.
 *
 * A nulled bid is a visible gap. An absolute-valued one is a lie with a
 * plausible face.
 */
const { requireTestDb } = require('../dbguard');
requireTestDb('negative-prices');

const fs = require('fs');
const path = require('path');
const { close } = require('../../src/db/pool');
const parse = require('../../src/scrapers/parse');
const { validateQuote } = require('../../src/validate');
const awsat = require('../../src/scrapers/awsat');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };

const REPO = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

/** The ingest mapper's `n`, as it now stands. */
const ingestN = (v, signed = false) => {
  const x = parse.toNumber(v);
  if (x === null) return null;
  if (!signed && x < 0) return null;
  return x;
};

(async () => {
  try {
    // ── the two shapes that produced this ─────────────────────────────────
    {
      // Both are documented, deliberate features of parse.toNumber, which is
      // why they reach the mapper looking ordinary.
      ck('accounting parentheses are a negative', parse.toNumber('(12.5)') === -12.5, parse.toNumber('(12.5)'));
      ck('U+2212 is a minus', parse.toNumber('−5') === -5, parse.toNumber('−5'));
    }

    // ── the ingest path ───────────────────────────────────────────────────
    {
      ck('a negative price becomes NULL, not its absolute value', ingestN('(12.5)') === null);
      ck('and a negative quantity too', ingestN('(300)') === null);
      ck('a positive is untouched', ingestN('176') === 176);
      ck('zero is a measurement and survives', ingestN('0') === 0);
      ck('a SIGNED field keeps its sign — chg is legitimately negative',
        ingestN('−5', true) === -5);

      // And the validator can now do the job it was written for.
      const q = (over) => ({
        symbol: 'ABAR', market: 'Main Market', created_at: new Date(),
        trading_date: '2026-09-10', ...over,
      });
      ck('a null price is not "impossible" — it is a gap, and the row survives',
        validateQuote(q({ last_price: null })).ok === true);
      ck('and a negative one reaching the validator IS refused',
        validateQuote(q({ last_price: -12.5 })).ok === false);
      ck('with a reason naming the field',
        /impossible last_price/.test(validateQuote(q({ last_price: -12.5 })).reason || ''));
    }

    // ── the scraper path ──────────────────────────────────────────────────
    {
      const num = awsat.num || null;
      if (num) {
        ck('the scraper refuses a negative in an unsigned field', num('-5') === null);
        ck('and keeps one where a sign is allowed', num('-5', true) === -5);
      } else {
        // num is module-private; assert on the source instead.
        const src = read('src/scrapers/awsat.js');
        const live = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
        ck('the scraper no longer takes an absolute value',
          !/Math\.abs\(n\) : n/.test(live), (live.match(/.*Math\.abs.*/) || [])[0]);
        ck('it returns null instead', /negativeRefusals \+= 1;[\s\S]{0,400}return null;/.test(live));
        ck('and the refusal is counted and reported, not silent',
          /refused a negative value in an unsigned field/.test(src));
      }
    }

    // ── neither path takes an absolute value anywhere ─────────────────────
    {
      for (const f of ['src/api/ingest.js', 'src/scrapers/awsat.js']) {
        const live = read(f).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
        ck(`${f} has no sign-flipping Math.abs left`,
          !/Math\.abs\((?:x|n)\)/.test(live), (live.match(/.*Math\.abs\((?:x|n)\).*/) || [])[0]);
      }
    }
  } catch (e) {
    ck('the suite ran without throwing', false, e.message);
  }

  await close();
  console.log(`\nnegative prices: ${p}/${n}`);
  process.exit(p === n ? 0 : 1);
})();

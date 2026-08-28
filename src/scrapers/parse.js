'use strict';
/**
 * Turning scraped text into values.
 *
 * Everything a page yields is a string shaped for a human reader: thousands
 * separators, currency suffixes, percent signs, parentheses for negatives, an
 * em dash where there is no value. These helpers do the conversion in one place
 * so every scraper agrees on what "empty" and "not a number" mean.
 *
 * THEY RETURN null, NOT 0, WHEN A VALUE IS ABSENT. A missing price and a price
 * of zero are different facts, and collapsing them makes an absent quote look
 * like a stock that traded at nothing.
 */

/** Placeholders pages use to mean "no value". */
const BLANKS = new Set(['', '-', '--', '—', '–', 'n/a', 'N/A', 'NA', 'null', 'undefined']);

function clean(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw)
    // Bidi and zero-width marks: invisible in a log, fatal to every regex that
    // does not strip them, and present because the terminal supports Arabic.
    .replace(/[\u202A\u202B\u202C\u200E\u200F]/g, '')
    .replace(/\u00a0/g, ' ')
    .trim();
  return BLANKS.has(s) || BLANKS.has(s.toLowerCase()) ? null : s;
}

/**
 * Parse a number written for humans.
 *
 * Handles thousands separators, a leading currency symbol, a trailing percent,
 * accounting negatives in parentheses, and the K/M/B suffixes TradingView uses
 * for volume. Returns null rather than NaN when there is nothing to parse:
 * NaN survives arithmetic silently and ends up in the database as a null
 * anyway, but only after contaminating whatever it touched on the way.
 */
function toNumber(raw) {
  const s = clean(raw);
  if (s === null) return null;

  const negative = /^\(.*\)$/.test(s);
  let body = s
    // U+2212 MINUS SIGN is NOT a hyphen. Both TradingView and the broker
    // terminal render it, and Number('\u22122.5') is NaN — so without this
    // translation every negative change silently becomes null. Measured: it
    // did exactly that on this codebase before the fix.
    .replace(/\u2212/g, '-')
    .replace(/[()]/g, '')
    .replace(/[,\s]/g, '')
    .replace(/[%$]/g, '');

  // CURRENCY SUFFIX, stripped BEFORE the multiplier.
  //
  // TradingView appends the currency to the value: "1,721KWF" for a price,
  // "845.96 MKWF" for a market cap. Number('1721KWF') is NaN, so every price on
  // the Kuwait watchlist parsed as null and 137 perfectly good rows were thrown
  // away as "0% had a price". The selector was never wrong.
  //
  // Order matters: the currency comes AFTER the K/M/B multiplier ("MKWF"), so
  // it has to come off first or the multiplier is never seen. Matching known
  // codes rather than "trailing letters" keeps a bare "23.34 K" intact, where
  // the K IS the multiplier.
  body = body.replace(
    /(KWF|KWD|USD|SAR|AED|EUR|GBP|QAR|BHD|OMR|JOD|EGP|TRY|JPY|CHF|CAD|AUD|INR)$/i,
    '',
  );

  // K / M / B multipliers, e.g. "1.24M" volume.
  let multiplier = 1;
  const suffix = /([KMB])$/i.exec(body);
  if (suffix) {
    multiplier = { K: 1e3, M: 1e6, B: 1e9 }[suffix[1].toUpperCase()];
    body = body.slice(0, -1);
  }

  if (body === '' || body === '-' || body === '+') return null;

  let n = Number(body);

  // FALLBACK: pull the first number out of surrounding noise.
  //
  // Requiring the whole string to be numeric fails whenever a character we did
  // not anticipate survives the cleaning — a currency code we do not list, a
  // footnote marker, or a page served without charset=utf-8, where UTF-8 bidi
  // marks arrive decoded as Latin-1 mojibake ("\u00e2\u20ac\u00aa1.95%") and no
  // longer match the strip. Observed exactly that against a real browser.
  //
  // A price with junk around it is still a price; discarding it loses the row.
  if (!Number.isFinite(n)) {
    const m = /-?\d[\d.]*/.exec(body);
    if (!m) return null;
    n = Number(m[0]);
    if (!Number.isFinite(n)) return null;

    // A K/M/B immediately after the digits is still a multiplier.
    const after = body.slice(m.index + m[0].length, m.index + m[0].length + 1);
    if (/[KMB]/i.test(after)) {
      multiplier = { K: 1e3, M: 1e6, B: 1e9 }[after.toUpperCase()];
    }
  }

  const value = n * multiplier;
  return negative ? -value : value;
}

/** Integers (quantities, counts). Fractional input is rounded, not truncated. */
function toInteger(raw) {
  const n = toNumber(raw);
  return n === null ? null : Math.round(n);
}

/**
 * Normalise a ticker.
 *
 * TradingView shows things like "KSE:ABAR" or "ABAR  Al Arabi"; the broker
 * shows a bare code. Take the last colon-separated part, then the leading token,
 * and uppercase it, so both sources agree on the key that joins them.
 */
function toSymbol(raw) {
  const s = clean(raw);
  if (s === null) return null;
  const afterColon = s.includes(':') ? s.split(':').pop() : s;
  const token = afterColon.trim().split(/[\s\u2014\u2013-]/)[0];
  const symbol = token.toUpperCase().replace(/[^A-Z0-9._]/g, '');
  return symbol || null;
}

/** BUY / SELL / UNKNOWN, matching the orders.side constraint. */
function toSide(raw) {
  const s = clean(raw);
  if (s === null) return null;
  const up = s.toUpperCase();
  if (up.includes('BUY') || up.startsWith('B') || up.includes('شراء')) return 'BUY';
  if (up.includes('SELL') || up.startsWith('S') || up.includes('بيع')) return 'SELL';
  return 'UNKNOWN';
}

/**
 * Normalise a clock time for a `time` column.
 *
 * last_trade_time became a real `time` in migration 014, and Postgres rejects
 * anything it cannot read — an empty string, a whitespace-only cell, an em
 * dash, or a full "25-08-2026 13:14:10" datetime, which is the shape the
 * broker uses on other cells and may well use here.
 *
 * A rejected row loses its last_trade_time entirely, so the cast has to happen
 * before the insert, not inside it. Anything unrecognisable becomes NULL:
 * "we did not get a time" is true and storable, where a guess is neither.
 */
function toTime(raw) {
  if (raw === null || raw === undefined) return null;
  const t = clean(String(raw));
  if (!t) return null;

  // Take the clock portion wherever it sits, so a datetime works too.
  // 1-2 digits per part: Postgres accepts '1:2:3', so rejecting it here would
  // be stricter than the column and would drop a time the database would
  // have taken.
  const m = /(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/.exec(t);
  if (!m) return null;

  const h = Number(m[1]);
  const min = Number(m[2]);
  const sec = m[3] === undefined ? 0 : Number(m[3]);
  if (h > 23 || min > 59 || sec > 59) return null;

  const pad = (v) => String(v).padStart(2, '0');
  return `${pad(h)}:${pad(min)}:${pad(sec)}`;
}

module.exports = {
  toTime, clean, toNumber, toInteger, toSymbol, toSide };

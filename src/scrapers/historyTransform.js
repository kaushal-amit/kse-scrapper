'use strict';
/**
 * Turning TradingView's chart "Table view" into daily OHLCV rows.
 *
 * Every rule below came out of a scraper of this same view that already works.
 * They look arbitrary in isolation and each one exists because the obvious
 * version was wrong:
 *
 *   THE DATE COLUMN SHIFTS EVERY INDEX. The table's first cell is the date and
 *   the values start at cell 1, but the HEADER includes the date too. So a
 *   header index of 3 is value index 2. Off by one here silently reads High
 *   into Open — plausible numbers, wrong column, no error ever.
 *
 *   data-copy-value IS PREFERRED BUT NOT TRUSTED. It carries the unrounded
 *   number, which is what we want — except it is missing on some cells, and
 *   notably on negative values. Falling back to textContent is not belt and
 *   braces; without it, negative changes silently become null.
 *
 *   THE MINUS SIGN IS NOT A HYPHEN. TradingView renders U+2212 MINUS SIGN.
 *   `parseFloat('\u22121.5')` is NaN, so every negative number in the table
 *   parses as missing unless it is translated first.
 *
 *   ROWS ARE KEYED BY data-row-time, NOT BY THE DATE TEXT. The text is
 *   localised and wrapped in bidi control characters; the attribute is a unix
 *   timestamp. The text is still parsed, but only as a fallback.
 */

/** Month abbreviations as the table view writes them. */
const MONTHS = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/**
 * Parse a row's date text, e.g. "1 Feb '26".
 *
 * The string arrives wrapped in bidi control characters (U+202A/U+202C) and
 * non-breaking spaces because the table supports right-to-left locales. Those
 * are invisible in a log and break every regex that does not strip them, which
 * makes this the kind of bug that gets diagnosed as "the date is just missing".
 */
function parseRowDate(text) {
  if (!text) return null;
  const clean = String(text).replace(/[\u202A\u202B\u202C\u200E\u200F\u00A0]/g, ' ').trim();
  const m = clean.match(/(\d{1,2})\s+([A-Za-z]{3})\s+'?(\d{2,4})/);
  if (!m) return null;

  const day = Number(m[1]);
  const month = MONTHS[m[2]];
  if (month === undefined) return null;

  const rawYear = Number(m[3]);
  const year = rawYear < 100 ? 2000 + rawYear : rawYear;
  return new Date(Date.UTC(year, month, day));
}

/** Unix seconds (from data-row-time) to a Date. */
function tsToDate(ts) {
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : null;
}

/** 'YYYY-MM-DD' from a Date, in UTC so a server timezone cannot shift the day. */
function toDayString(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * CR-12 · the session day of a bar's data-row-time, resolved in Asia/Kuwait.
 *
 * This is the root of a seven-month off-by-one. `new Date(ts*1000).toISOString()`
 * reads the epoch in UTC, and a TradingView daily bar stamped at Kuwait-midnight
 * (UTC+3) lands on 21:00 UTC the day BEFORE — so every stored trade_date was one
 * day early and the table filled with Saturday sessions Boursa Kuwait does not
 * have. Kuwait is UTC+3 year-round (no DST): shift the instant by +3h and take
 * the UTC calendar day, and the true session day comes out whether the epoch is
 * exchange-local-midnight OR already UTC-midnight.
 */
const KUWAIT_OFFSET_MS = 3 * 3600000;
function tsToKuwaitDay(ts) {
  const n = Number(ts);
  if (!(Number.isFinite(n) && n > 0)) return null;
  return new Date(n * 1000 + KUWAIT_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * The session day for a row: the DISPLAYED date first — parseRowDate builds it
 * with Date.UTC from the row's own label, which is timezone-free truth — and the
 * epoch only as a fallback, resolved in Kuwait. The old path trusted the epoch
 * first and read it in raw UTC, which is the CR-12 corruption.
 */
function rowDay(row) {
  return toDayString(parseRowDate(row && row.dateText)) || tsToKuwaitDay(row && row.ts);
}

/**
 * A Boursa Kuwait session runs Sunday–Thursday. A Friday or Saturday trade_date
 * cannot exist and is the signature of the CR-12 shift — the writer refuses one
 * so the corruption class can never be stored silently again.
 */
function isWeekendDay(dayStr) {
  if (!dayStr) return false;
  const dow = new Date(`${dayStr}T00:00:00Z`).getUTCDay(); // 0 Sun … 6 Sat
  return dow === 5 || dow === 6; // Friday, Saturday
}

/**
 * Parse a number as the table view writes it.
 *
 * Handles the U+2212 minus sign, thousands separators, non-breaking spaces and
 * the em-dash placeholder. Returns null rather than NaN for anything absent:
 * NaN survives arithmetic silently and only surfaces much later as a null in
 * the database, after contaminating whatever it touched.
 */
function parseNumeric(value) {
  if (value === null || value === undefined) return null;

  const s = String(value)
    .replace(/\u2212/g, '-')        // MINUS SIGN -> hyphen-minus
    .replace(/[\u202A\u202B\u202C\u200E\u200F]/g, '')
    .replace(/,/g, '')
    // ALL whitespace, including U+00A0. A non-breaking space is a thousands
    // separator in several locales, and merely trimming leaves "1 234", which
    // parseFloat reads as 1 -- a value a thousand times too small that still
    // looks like a plausible price.
    .replace(/\s/g, '');

  if (s === '' || s === '—' || s === '–' || s === '-' || s === 'N/A') return null;

  /*
   * P6-TV-4 · TradingView ABBREVIATES: 1.24M, 845.96K, 2.1B.
   *
   * extractRows falls back to the cell's textContent whenever data-copy-value
   * is absent, and the Volume column is rendered abbreviated. parseFloat
   * stopped at the suffix, so a 1,240,000-share day was stored as 1 — a
   * plausible-looking number a million times too small, which every volume
   * ratio downstream then reads as a collapse in liquidity. parse.toNumber has
   * handled this since the beginning; this function did not.
   */
  const mult = /^(-?[0-9]*\.?[0-9]+)\s*([KMB])$/i.exec(s);
  if (mult) {
    const base = parseFloat(mult[1]);
    const scale = { K: 1e3, M: 1e6, B: 1e9 }[mult[2].toUpperCase()];
    return Number.isFinite(base) ? base * scale : null;
  }

  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Map header names to VALUE indices.
 *
 * The returned index is into `row.values`, which excludes the date cell — so it
 * is the header position minus one. A header that IS the date column, or that
 * is not found, yields -1.
 */
function mapColumns(headers) {
  const lower = headers.map((h) => String(h || '').toLowerCase().trim());

  const find = (predicate) => {
    const i = lower.findIndex(predicate);
    return i <= 0 ? -1 : i - 1;      // <= 0 because index 0 is the date column
  };

  return {
    open: find((h) => h === 'open'),
    high: find((h) => h === 'high'),
    low: find((h) => h === 'low'),
    close: find((h) => h === 'close' || h === 'price'),
    change: find((h) => h.includes('change') || h.includes('chg') || h === '%'),
    volume: find((h) => h === 'volume' || h === 'vol'),
  };
}

/**
 * Build daily rows from extracted table-view rows.
 *
 * @param rows     [{ ts, dateText, values[] }]
 * @param headers  header cell text INCLUDING the date column
 * @param meta     { symbol, runId, startDay, endDay }  days are 'YYYY-MM-DD'
 * @returns {{rows, skipped, outOfRange, reasons}}
 */
function buildDailyRows(rows, headers, meta) {
  const col = mapColumns(headers);

  // Without OHLC there is nothing worth storing, and a partial map means the
  // header was misread — which would otherwise write whatever happened to sit
  // at those positions.
  if (col.open < 0 || col.high < 0 || col.low < 0 || col.close < 0) {
    const err = new Error(
      `could not map OHLC columns from headers: [${headers.join(' | ')}]. `
      + `Mapped open=${col.open} high=${col.high} low=${col.low} close=${col.close}.`,
    );
    err.headers = headers;
    throw err;
  }

  const out = [];
  const reasons = [];
  let skipped = 0;
  let outOfRange = 0;
  let weekendSkipped = 0;
  const seen = new Set();

  for (const row of rows) {
    // CR-12 · the displayed date first (timezone-free), the epoch only as a
    // fallback resolved in Kuwait — never the raw-UTC epoch, which shifted seven
    // months of history back by a day.
    const day = rowDay(row);
    if (!day) { skipped += 1; reasons.push(`unparseable date: ${row.dateText}`); continue; }
    // A session cannot fall on Fri/Sat. Refuse it loudly rather than store the
    // corruption; weekendSkipped surfaces in the run summary.
    if (isWeekendDay(day)) {
      skipped += 1; weekendSkipped += 1;
      reasons.push(`weekend date refused: ${day} (${row.dateText || 'ts ' + row.ts}) — a Boursa session cannot be Fri/Sat`);
      continue;
    }

    if (meta.startDay && day < meta.startDay) { outOfRange += 1; continue; }
    if (meta.endDay && day > meta.endDay) { outOfRange += 1; continue; }

    // The same day twice means the scroll captured overlapping slices.
    if (seen.has(day)) continue;

    const v = row.values || [];
    const at = (i) => (i >= 0 && i < v.length ? v[i] : null);

    const open = parseNumeric(at(col.open));
    const high = parseNumeric(at(col.high));
    const low = parseNumeric(at(col.low));
    const close = parseNumeric(at(col.close));

    // A bar missing any of OHLC is not a bar.
    if (open === null || high === null || low === null || close === null) {
      skipped += 1;
      reasons.push(`${day}: incomplete OHLC (o=${open} h=${high} l=${low} c=${close})`);
      continue;
    }

    // high < low is impossible and means two columns were crossed. Rejecting
    // here gives a message naming the day; the CHECK constraint would only say
    // a constraint failed.
    if (high < low) {
      skipped += 1;
      reasons.push(`${day}: high ${high} < low ${low} — columns appear crossed`);
      continue;
    }

    seen.add(day);
    out.push({
      symbol: meta.symbol,
      trade_date: day,
      open_price: open,
      high_price: high,
      low_price: low,
      close_price: close,
      change_value: parseNumeric(at(col.change)),
      change_pct: null,
      volume: (() => {
        const n = parseNumeric(at(col.volume));
        return n === null ? null : Math.round(n);
      })(),
      source: 'tradingview',
      run_id: meta.runId ?? null,
    });
  }

  // Oldest first, so a partial run leaves a contiguous head rather than gaps.
  out.sort((a, b) => (a.trade_date < b.trade_date ? -1 : 1));

  return { rows: out, skipped, outOfRange, weekendSkipped, reasons: reasons.slice(0, 10) };
}

module.exports = {
  parseRowDate, tsToDate, tsToKuwaitDay, rowDay, isWeekendDay, toDayString,
  parseNumeric, mapColumns, buildDailyRows,
};

'use strict';
/**
 * Trading-window logic, in Asia/Kuwait.
 *
 * Everything that asks "should the scraper run right now?" comes through here,
 * so there is exactly one definition of the window and one place to change it.
 *
 * WHY Intl AND NOT A TIMEZONE LIBRARY
 * The server may run anywhere. Comparing `new Date().getHours()` against 9 is
 * correct only if the server is already in Kuwait, and silently wrong by hours
 * otherwise — the kind of bug that looks like "the scraper collected nothing
 * today". Intl.DateTimeFormat resolves a real timezone using the system tz
 * database, needs no dependency, and does not go stale.
 *
 * Kuwait is UTC+3 year-round with no DST, so the arithmetic happens to be
 * simple, but it is not hardcoded here — MARKET_TIMEZONE drives it, which is
 * what makes the UAE and Saudi expansion a config change rather than a rewrite.
 */

const { config } = require('../config');

const TZ = config.market.timezone;

/**
 * Weekday index in the market's timezone, using JavaScript's convention:
 * 0=Sunday, 1=Monday ... 5=Friday, 6=Saturday.
 *
 * Kuwait's weekend is Friday and Saturday, so the trading days are 0-4. That is
 * the opposite of a Western week and is the single most common source of
 * "why did it run on Saturday" bugs.
 */
const WEEKDAY_INDEX = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** Break a Date into calendar/clock parts as seen in the market's timezone. */
function parts(date = new Date()) {
  const out = {};
  for (const p of partsFormatter.formatToParts(date)) {
    if (p.type !== 'literal') out[p.type] = p.value;
  }
  // Intl returns hour "24" for midnight in some ICU versions rather than "00".
  const hour = out.hour === '24' ? 0 : Number(out.hour);
  return {
    weekday: out.weekday,
    weekdayIndex: WEEKDAY_INDEX[out.weekday],
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour,
    minute: Number(out.minute),
    second: Number(out.second),
    minutesOfDay: hour * 60 + Number(out.minute),
  };
}

/** 'YYYY-MM-DD' as seen in the market's timezone — the trading day. */
function tradingDay(date = new Date()) {
  const p = parts(date);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** 'HH:MM' as seen in the market's timezone. */
function localTime(date = new Date()) {
  const p = parts(date);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

function isTradingDay(date = new Date()) {
  return config.market.tradingDays.includes(parts(date).weekdayIndex);
}

/**
 * Is `date` inside the trading window?
 *
 * The window is half-open: [start, end). A capture stamped exactly at END_TIME
 * belongs to the next minute bucket, and including it would produce a row for a
 * minute the market was no longer in.
 */
function isWithinWindow(date = new Date()) {
  if (!isTradingDay(date)) return false;
  const m = parts(date).minutesOfDay;
  return m >= config.market.startMinutes && m < config.market.endMinutes;
}

/**
 * Why the scraper is or is not running, in words. Used in logs and on startup
 * so an idle process explains itself rather than looking hung.
 */
function windowStatus(date = new Date()) {
  const p = parts(date);
  const open = isWithinWindow(date);
  let reason;
  if (!isTradingDay(date)) {
    reason = `${p.weekday} is not a trading day`;
  } else if (p.minutesOfDay < config.market.startMinutes) {
    const mins = config.market.startMinutes - p.minutesOfDay;
    reason = `opens in ${mins} minute(s)`;
  } else if (p.minutesOfDay >= config.market.endMinutes) {
    reason = 'window closed for today';
  } else {
    const mins = config.market.endMinutes - p.minutesOfDay;
    reason = `open, ${mins} minute(s) remaining`;
  }
  return {
    open,
    reason,
    localTime: localTime(date),
    weekday: p.weekday,
    tradingDay: tradingDay(date),
    window: `${config.market.startTime}-${config.market.endTime} ${TZ}`,
  };
}

/**
 * Timestamp truncated to the minute — the deduplication key for quotes.
 * One row per symbol per minute regardless of how often a scrape fires.
 */
function minuteBucket(date = new Date()) {
  const d = new Date(date);
  d.setSeconds(0, 0);
  return d;
}

module.exports = {
  parts,
  tradingDay,
  localTime,
  isTradingDay,
  isWithinWindow,
  windowStatus,
  minuteBucket,
};

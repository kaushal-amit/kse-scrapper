'use strict';
/**
 * Push a signal to the phone — Step 3, item 17.
 *
 * ─── WHY A WEBHOOK AND NOT A NAMED SERVICE ─────────────────────────────────
 * The task list says "push signal alerts to the phone" without naming a
 * channel. Rather than pick one and invent a credential shape, this POSTs JSON
 * to a URL. Telegram, Pushover, ntfy, Slack and a custom endpoint are all
 * reachable that way, and switching between them is an env var rather than a
 * code change.
 *
 * Disabled when NOTIFY_URL is unset — silently, because a trading system that
 * refuses to start over a missing alert channel has made the alert more
 * important than the data.
 */

const log = require('./logger');

const URL_ = process.env.NOTIFY_URL || '';
const TOKEN = process.env.NOTIFY_TOKEN || '';
const TIMEOUT_MS = Number(process.env.NOTIFY_TIMEOUT_MS || 5_000);
const MIN_GAP_MS = Number(process.env.NOTIFY_MIN_GAP_MS || 60_000);

/**
 * The last time each symbol+signal was sent.
 *
 * The fast loop runs every 15-20 seconds, so an unchanged condition would fire
 * the same alert three or four times a minute. A phone that buzzes constantly
 * gets silenced, and then the one alert that mattered is missed too.
 */
const lastSent = new Map();

/** Record a DELIVERED push against the throttle. Success only — see shouldSend. */
function throttleKey(signal) { return `${signal.symbol}|${signal.signal}`; }

function markSent(signal) {
  lastSent.set(throttleKey(signal), Date.now());
}

function shouldSend(signal) {
  const key = throttleKey(signal);
  const now = Date.now();
  const previous = lastSent.get(key);
  if (previous && now - previous < MIN_GAP_MS) return false;
  /*
   * F-18 · the throttle is NOT stamped here any more.
   *
   * It used to be: shouldSend recorded the timestamp and then push() tried to
   * deliver. A push that FAILED — a slow webhook aborted at TIMEOUT_MS — had
   * therefore already consumed its slot, so the next evaluation 15-20 s later
   * was throttled, and the aggregate counted the miss as `throttled` rather
   * than `failed`: an intentional suppression, in the report, for an alert that
   * never reached the phone.
   *
   * markSent() is called by the caller on success only.
   */
  return true;
}

function format(signal) {
  const px = signal.last_price === null || signal.last_price === undefined
    ? '' : ` @ ${signal.last_price}`;
  return `${signal.symbol}${px} — ${signal.signal}: ${signal.detail || ''}`.trim();
}

/**
 * Send one signal. Never throws.
 *
 * A failed notification must not fail the scrape that produced it: the signal
 * is already in signal_log, which is the durable record. Delivery is best
 * effort and its outcome is returned rather than raised.
 */
async function push(signal) {
  if (!URL_) return { sent: false, reason: 'NOTIFY_URL not set' };
  if (!shouldSend(signal)) return { sent: false, reason: 'throttled' };

  const body = {
    text: format(signal),
    symbol: signal.symbol,
    signal: signal.signal,
    detail: signal.detail || null,
    last_price: signal.last_price ?? null,
    at: signal.captured_at || new Date().toISOString(),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(URL_, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      log.warn('notify: rejected', { status: res.status, signal: signal.signal });
      return { sent: false, reason: `HTTP ${res.status}` };
    }
    // The slot is consumed by a DELIVERED push, not an attempted one.
    markSent(signal);
    return { sent: true };
  } catch (err) {
    log.warn('notify: failed', { err: err.message, signal: signal.signal });
    return { sent: false, reason: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Send several, in order, without letting one failure stop the rest. */
async function pushAll(signals) {
  const out = [];
  for (const s of signals) out.push(await push(s));
  return {
    sent: out.filter((r) => r.sent).length,
    throttled: out.filter((r) => r.reason === 'throttled').length,
    failed: out.filter((r) => !r.sent && r.reason !== 'throttled').length,
  };
}

module.exports = { push, pushAll, format, shouldSend, markSent, _lastSent: lastSent };

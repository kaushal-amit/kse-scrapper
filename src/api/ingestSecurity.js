'use strict';
/**
 * src/api/ingestSecurity.js — the three rules that guard the ingest surface,
 * kept out of index.js so they can be tested without standing up HTTP.
 *
 *   1. The token must be long enough, and a short one REFUSES the boot.
 *   2. The browser origins that may post are an allowlist, not '*'.
 *   3. A caller cannot spend the process on requests.
 *
 * Rebuilt from claude/spread-fix-delivery-2026-09-10.md (the ≥24-char
 * INGEST_TOKEN, the INGEST_ORIGIN allowlist).
 */

/**
 * 24 random characters is ~143 bits at base64 — far past brute force — while
 * still being pasteable into four userscripts by hand. The number is a floor on
 * LENGTH, not an estimate of entropy: this cannot tell "24 random bytes" from
 * "aaaaaaaaaaaaaaaaaaaaaaaa", and says so rather than implying a guarantee.
 */
const MIN_TOKEN_LENGTH = Number(process.env.INGEST_TOKEN_MIN_LENGTH || 24);

class ConfigRefused extends Error {}

/**
 * The token policy.
 *
 * Absent: the ingest surface does not start at all. An unauthenticated write
 * endpoint accepting market data is worse than no endpoint, so absence disables
 * the surface rather than defaulting to open — that part was already true.
 *
 * Present but SHORT: this used to be a log.warn, and a warning at boot is read
 * once, on the day it is added, by the person who already knows. The API came
 * up and accepted writes on a guessable token. Now it refuses, because the
 * failure it prevents (anyone writing to the market-data tables) is not
 * recoverable by noticing later.
 *
 * Returns { start: false } when there is no token — that is a configured state,
 * not an error. Throws ConfigRefused when a token is present and unusable.
 */
function assertTokenPolicy(token) {
  if (!token) return { start: false, reason: 'INGEST_TOKEN is not set' };
  if (String(token).length < MIN_TOKEN_LENGTH) {
    throw new ConfigRefused(
      `INGEST_TOKEN is ${String(token).length} characters — at least ${MIN_TOKEN_LENGTH} are required. `
      + 'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'base64url\'))" '
      + 'and paste the SAME value into the installed userscripts.');
  }
  return { start: true };
}

/**
 * The origin allowlist.
 *
 * '*' remains accepted and remains the documented fallback, because an
 * allowlist that silently blocks the browser you are testing from is its own
 * trap — the browser discards the response and fetch() fails with
 * "NetworkError", leaving NO trace in the server log, because nothing arrives.
 * So the refusal here is LOUD on the server side (a warn naming the origin that
 * was turned away) even though the browser will only see a missing header.
 *
 * A list echoes back the caller's own origin when it matches, never the whole
 * list — `Access-Control-Allow-Origin` takes one value, and sending the first
 * entry to every caller allows exactly one of them.
 */
function parseOrigins(raw) {
  const text = String(raw === undefined || raw === null ? '' : raw).trim();
  if (text === '' || text === '*') return { any: true, list: [] };
  const list = text.split(',').map((s) => s.trim()).filter(Boolean);
  return { any: false, list };
}

/**
 * Returns the value for Access-Control-Allow-Origin, or null when the caller's
 * origin is not allowed. A request with NO Origin header is not a browser
 * request (curl, a server-side poster, the userscript's own GM_xmlhttpRequest
 * in some builds) — CORS does not apply to it and the token still does, so it
 * is allowed through with '*' rather than blocked by a rule that cannot apply.
 */
function resolveOrigin(requestOrigin, allow) {
  if (allow.any) return '*';
  if (!requestOrigin) return '*';
  return allow.list.includes(requestOrigin) ? requestOrigin : null;
}

/**
 * A fixed-window rate limiter, per key.
 *
 * Deliberately not a token bucket: the thing being protected is a single-writer
 * Postgres pool of 10 connections behind a minute-cadence capture, and the
 * failure to prevent is one stuck client replaying a batch in a tight loop
 * while the live session's writes queue behind it. A window that simply says
 * "no more than N in the last W" is the rule an operator can reason about at
 * 09:05 with a session running.
 *
 * Keyed by caller, so one misbehaving script cannot starve the others. The map
 * is swept on write rather than on a timer — a timer would keep the process
 * alive and, at this cardinality (a handful of scripts), sweeping is cheaper
 * than scheduling.
 */
function createRateLimiter({
  windowMs = Number(process.env.INGEST_RATE_WINDOW_MS || 60_000),
  max = Number(process.env.INGEST_RATE_MAX || 240),
  now = () => Date.now(),
} = {}) {
  // A malformed env var must not silently REMOVE the limit. NaN compares false
  // against everything, so `count > NaN` would never fire.
  const windowSafe = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 60_000;
  const maxSafe = Number.isFinite(max) && max > 0 ? max : 240;
  const hits = new Map();

  function check(key) {
    const t = now();
    const cutoff = t - windowSafe;
    for (const [k, v] of hits) if (v.start < cutoff) hits.delete(k);

    let entry = hits.get(key);
    if (!entry || entry.start < cutoff) { entry = { start: t, count: 0 }; hits.set(key, entry); }
    entry.count += 1;
    if (entry.count > maxSafe) {
      return {
        allowed: false,
        count: entry.count,
        max: maxSafe,
        retryAfterSec: Math.max(1, Math.ceil((entry.start + windowSafe - t) / 1000)),
      };
    }
    return { allowed: true, count: entry.count, max: maxSafe, remaining: maxSafe - entry.count };
  }

  return { check, size: () => hits.size, windowMs: windowSafe, max: maxSafe };
}

module.exports = {
  MIN_TOKEN_LENGTH, ConfigRefused, assertTokenPolicy, parseOrigins, resolveOrigin, createRateLimiter,
};

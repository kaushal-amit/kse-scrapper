'use strict';
/**
 * src/api/boardFreshness.js — H11 · is the board still MOVING?
 *
 * The heartbeat proves a feed is posting. It cannot prove the feed is posting
 * anything new. A terminal whose websocket has died keeps rendering the last
 * board it received: the userscript reads 137 rows every cycle, posts them, the
 * server accepts them, client_heartbeat advances, /health is green — and every
 * price is frozen at whatever it was when the socket dropped.
 *
 * That is strictly worse than the feed stopping. A stopped feed leaves a gap
 * anyone can see. A frozen one writes plausible rows all session, and the range,
 * the tape quality and the still-rate are then computed from a photograph.
 *
 * WHY THE WHOLE BOARD AND NOT PER SYMBOL. Individual symbols go quiet for
 * minutes at a time — that is normal, and flagging it would fire constantly. It
 * is 137 symbols being byte-identical a minute apart that cannot happen.
 */

const crypto = require('crypto');
const { query } = require('../db/pool');
const log = require('../logger');

/**
 * Three, not two. Two identical captures can happen legitimately in a quiet
 * minute near the close; three across two minutes on a board of 137 cannot.
 * Shared with the backend's FROZEN_CAPTURES so the two services agree on what
 * "degraded" means.
 */
const FROZEN_CAPTURES = Number(process.env.FROZEN_CAPTURES || 3);

/**
 * A hash over what is supposed to MOVE. Deliberately not the whole row: a
 * column that changes every capture for uninteresting reasons (a render
 * timestamp, a sequence number) would make every board look fresh.
 */
function fingerprint(rows) {
  const h = crypto.createHash('sha256');
  const ordered = [...rows].sort((a, b) => String(a.symbol).localeCompare(String(b.symbol)));
  for (const r of ordered) {
    h.update(`${r.symbol}|${r.last_price === null || r.last_price === undefined ? '' : r.last_price}`
      + `|${r.volume === null || r.volume === undefined ? '' : r.volume}\n`);
  }
  return h.digest('hex');
}

/**
 * Record this batch's fingerprint and report whether the board has stopped
 * moving.
 *
 * Never throws: a freshness check that can fail the ingest it is observing has
 * the priority backwards. A failure here is logged and reported as "unknown",
 * which reads as neither fresh nor frozen.
 */
async function recordAndCheck({ rows, capturedAt, tradingDate, source }) {
  if (!rows || !rows.length) return { frozen: false, identical: 0, fingerprint: null };

  const fp = fingerprint(rows);
  try {
    await query(
      `INSERT INTO quote_fingerprint (trading_date, captured_at, ingest_source, fingerprint, row_count)
       VALUES ($1, $2, $3, $4, $5)`,
      [tradingDate, capturedAt, source, fp, rows.length]);

    // How many of the most recent captures TODAY carry this same fingerprint,
    // consecutively. Reading a bounded window rather than the whole day: only
    // the tail matters, and the day's table is written every minute.
    const { rows: recent } = await query(
      `SELECT fingerprint FROM quote_fingerprint
        WHERE trading_date = $1 AND ingest_source = $2
        ORDER BY captured_at DESC, id DESC
        LIMIT $3`, [tradingDate, source, Math.max(FROZEN_CAPTURES, 2)]);

    let identical = 0;
    for (const r of recent) {
      if (r.fingerprint !== fp) break;
      identical += 1;
    }

    const frozen = identical >= FROZEN_CAPTURES;
    if (frozen) {
      log.error('QUOTES FEED DEGRADED — the board has not changed', {
        identicalCaptures: identical, threshold: FROZEN_CAPTURES, rows: rows.length, source,
        note: 'the feed is posting; it is posting the same board. Check the terminal\'s '
          + 'websocket — a dead socket keeps rendering the last board it received.',
      });
    }
    return { frozen, identical, fingerprint: fp };
  } catch (err) {
    log.warn('could not record the board fingerprint', { err: err.message });
    return { frozen: false, identical: null, fingerprint: fp, error: err.message };
  }
}

/** For /health. Null when today has too few captures to say anything. */
async function status(tradingDate, source = 'awsat_client') {
  try {
    const { rows } = await query(
      `SELECT fingerprint, captured_at FROM quote_fingerprint
        WHERE trading_date = $1 AND ingest_source = $2
        ORDER BY captured_at DESC, id DESC
        LIMIT $3`, [tradingDate, source, Math.max(FROZEN_CAPTURES, 2)]);
    if (rows.length < FROZEN_CAPTURES) {
      return { state: 'UNKNOWN', captures: rows.length, need: FROZEN_CAPTURES };
    }
    const identical = rows.every((r) => r.fingerprint === rows[0].fingerprint);
    return {
      state: identical ? 'DEGRADED' : 'OK',
      captures: rows.length,
      lastCapturedAt: rows[0].captured_at,
    };
  } catch (err) {
    return { state: 'UNKNOWN', error: err.message };
  }
}

module.exports = { fingerprint, recordAndCheck, status, FROZEN_CAPTURES };

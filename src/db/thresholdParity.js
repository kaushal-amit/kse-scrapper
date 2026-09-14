'use strict';
/**
 * src/db/thresholdParity.js — the database's numbers and the code's numbers must
 * be the same numbers.
 *
 * P2 · MIGRATION 013 HARDCODES TWO VALUES THAT src/config/thresholds.js MAKES
 * CONFIGURABLE, AND NOTHING NOTICED.
 *
 *   · symbol_day_ratio_invalid_at_offer CHECKs `pct_at_offer <= 90`, while the
 *     compute job reads sd_at_offer_invalidates_pct (default 90, env
 *     SD_AT_OFFER_MAX). Set SD_AT_OFFER_MAX=95 and the job writes a row that is
 *     legal by its own rule and REJECTED BY THE CHECK — which fails the whole
 *     200-row chunked INSERT, and so the entire day's compute.
 *
 *   · regime_of() hardcodes `<35 RISK_OFF / <=50 NEUTRAL`, while
 *     marketDayMetrics.regimeOf reads md_regime_risk_off_pct and
 *     md_regime_neutral_pct. Two live definitions of market_day.regime — the
 *     column the trading backend reads to decide whether to trade at all — that
 *     an env var can move apart.
 *
 * ─── WHY NOT JUST DELETE THE SQL ───────────────────────────────────────────
 * The CHECK is worth keeping: it is what makes "was rule 5 applied?" stop being
 * a question about the job, as 013 says. A constraint enforced by the database
 * cannot be forgotten by a future writer.
 *
 * ─── AND WHY NOT PARAMETERISE IT ───────────────────────────────────────────
 * A CHECK cannot read a runtime value, and a table of thresholds read by a
 * CHECK is a table nobody can change without a lock. The numbers have to be
 * written twice.
 *
 * So they are written twice AND COMPARED AT BOOT. Drift becomes a refusal to
 * start, naming both values and which migration to change — rather than a day's
 * compute failing at 13:35 on a constraint violation, or the backend reading a
 * regime label the code would not have produced.
 */

const { query } = require('./pool');
const T = require('../config/thresholds');

/** Every number in a piece of SQL, in order. */
function numbersIn(text) {
  return (String(text).match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
}

/**
 * Check the database's copies against the configured thresholds.
 *
 * Returns { ok: true } or throws with the whole story. Never silently passes on
 * a missing object: a CHECK that is not there is not a CHECK that agrees.
 */
async function assertThresholdParity() {
  const problems = [];

  // ── the at-offer CHECK ───────────────────────────────────────────────────
  {
    const { rows } = await query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'symbol_day_ratio_invalid_at_offer'`);
    if (!rows.length) {
      problems.push('symbol_day_ratio_invalid_at_offer is MISSING — migration 013 '
        + 'has not been applied, or something dropped it');
    } else {
      const want = T.get('sd_at_offer_invalidates_pct');
      const found = numbersIn(rows[0].def);
      if (!found.includes(want)) {
        problems.push(`symbol_day_ratio_invalid_at_offer uses ${found.join(', ')} `
          + `but sd_at_offer_invalidates_pct is ${want}. The compute job would write `
          + 'rows the CHECK rejects, failing the whole day. Change the migration '
          + 'or unset SD_AT_OFFER_MAX.');
      }
    }
  }

  // ── regime_of() ──────────────────────────────────────────────────────────
  {
    const { rows } = await query(
      "SELECT prosrc FROM pg_proc WHERE proname = 'regime_of'");
    if (!rows.length) {
      problems.push('regime_of() is MISSING — migration 013 has not been applied');
    } else {
      const riskOff = T.get('md_regime_risk_off_pct');
      const neutral = T.get('md_regime_neutral_pct');
      const found = numbersIn(rows[0].prosrc);
      if (!found.includes(riskOff) || !found.includes(neutral)) {
        problems.push(`regime_of() uses ${found.join(', ')} but the thresholds are `
          + `${riskOff} (RISK_OFF) and ${neutral} (NEUTRAL). market_day.regime is `
          + 'read by the trading backend and there would be two definitions of it. '
          + 'Change the migration or unset MD_REGIME_RISK_OFF_PCT / '
          + 'MD_REGIME_NEUTRAL_PCT.');
      }
    }
  }

  if (problems.length) {
    const err = new Error(
      `${problems.length} threshold(s) differ between the database and the code:\n  - `
      + `${problems.join('\n  - ')}`);
    err.thresholdParity = true;
    throw err;
  }
  return { ok: true };
}

module.exports = { assertThresholdParity, numbersIn };

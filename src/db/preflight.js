'use strict';
/**
 * src/db/preflight.js — is the schema current enough to do this work?
 *
 * ─── WHY THIS EXISTS ───────────────────────────────────────────────────────
 * Four migrations have landed on a database other than the one the next
 * command used, and each time the failure surfaced as something else: a
 * backfill reporting "column does not exist" 28 times, a compute job writing
 * nothing, a scraper rejecting every insert.
 *
 * The check costs one query against information_schema. It reports what it
 * verified on SUCCESS as well as failure, so a green run says the schema is
 * current rather than only saying so when it is not.
 */

const { query } = require('./pool');
const log = require('../logger');

/** Checked once per process. A backfill loop must not re-verify 28 times. */
const cache = new Map();

/**
 * REQUIRED COLUMNS, not an exact count.
 *
 * An exact count breaks every consumer the moment any migration adds a column,
 * which trains people to bump the constant without reading why. Naming what the
 * caller actually needs survives additions and misses nothing that matters.
 */
async function check(label, requirements, { quiet = false } = {}) {
  if (cache.has(label)) return cache.get(label);

  const problems = [];
  const lines = [];

  for (const [table, needed] of Object.entries(requirements)) {
    const { rows } = await query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1`, [table]);

    if (!rows.length) {
      problems.push(`table "${table}" does not exist`);
      lines.push(`    ${table.padEnd(20)} MISSING`);
      continue;
    }

    const have = new Set(rows.map((r) => r.column_name));
    const missing = needed.filter((c) => !have.has(c));
    if (missing.length) {
      problems.push(`${table} is missing: ${missing.join(', ')}`);
      lines.push(`    ${table.padEnd(20)} ${rows.length} columns · MISSING ${missing.join(', ')}`);
    } else {
      lines.push(`    ${table.padEnd(20)} ${rows.length} columns · all ${needed.length} required present`);
    }
  }

  const result = { ok: !problems.length, problems, lines };
  cache.set(label, result);

  if (!quiet) for (const l of lines) console.log(l);

  if (!result.ok) {
    throw new Error(
      `schema is behind for ${label}: ${problems.join('; ')}. `
      + 'Run:  node src/db/migrate.js --to=<the database this process writes to>');
  }
  return result;
}

/** For tests, and for a long-running process that has just been migrated. */
function reset() { cache.clear(); }

module.exports = { check, reset, _cache: cache };

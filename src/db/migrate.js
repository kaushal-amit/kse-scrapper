'use strict';
/**
 * Migration runner.
 *
 * Applies every .sql file in ./migrations in filename order, once each, and
 * records what it applied in the schema_migrations table.
 *
 * Three properties worth having, each for a specific reason:
 *
 *   ONE FILE PER TRANSACTION      A migration that fails partway is rolled back
 *                                 whole. Half-applied schema is the worst state
 *                                 to debug because the file no longer describes
 *                                 the database.
 *
 *   ADVISORY LOCK                 Two processes starting at once (a restart
 *                                 loop, two containers) would otherwise both
 *                                 apply the same file. The second waits.
 *
 *   CHECKSUM ON APPLIED FILES     Editing a migration after it has run means
 *                                 the repository and the database disagree, and
 *                                 nothing would ever say so. This reports it
 *                                 instead of continuing quietly.
 *
 * Usage:
 *   node src/db/migrate.js                     apply pending migrations
 *   node src/db/migrate.js --status            report only, change nothing
 *   node src/db/migrate.js --to=<postgres url> apply to a NAMED database
 *
 * ─── WHY --to EXISTS ───────────────────────────────────────────────────────
 * The target used to come only from DATABASE_URL, so an identical command run
 * from two shells could migrate two different databases and nothing in the
 * output distinguished them. Three separate runs landed on the wrong instance
 * that way — depth, orders, and migration 021 — each time looking like a
 * success.
 *
 * The resolved database is now printed before anything is applied.
 */

// ─── --to MUST BE READ BEFORE ANYTHING ELSE ────────────────────────────────
//
// pool.js builds its Pool at module load from config.db.url, and config reads
// DATABASE_URL at ITS load. Setting the variable after those requires changes
// nothing — the connection is already open to the old target, and the run
// reports success against a database nobody asked for.
//
// This is why the override sits above the requires and not in main().
if (require.main === module) {
  const toArg = process.argv.find((a) => a.startsWith('--to='));
  if (toArg) process.env.DATABASE_URL = toArg.split('=').slice(1).join('=');
}

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pool, close } = require('./pool');
const log = require('../logger');

const DIR = path.join(__dirname, 'migrations');
const LOCK_ID = 4711;   // arbitrary but fixed; only this migrator uses it

function checksum(sql) {
  return crypto.createHash('sha256').update(sql).digest('hex').slice(0, 16);
}

/**
 * Migrations that USED to exist and have since been folded into 001_init.sql.
 *
 * Extracting a release over an existing checkout MERGES files — it never
 * deletes the ones that were removed. So a directory that has been updated in
 * place still holds these, the migrator runs them in order, and they fail
 * against tables that no longer exist:
 *
 *     002_quote_market.sql -> ALTER TABLE quotes ...
 *     ERROR: relation "quotes" does not exist        (42P01)
 *
 * That error names the symptom and not the cause, and sends you looking for a
 * missing table rather than a leftover file. Naming them here turns it into an
 * instruction.
 */
const RETIRED = new Set([
  '002_quote_market.sql',      // folded into 001_init.sql (market column)
  '003_daily_prices.sql',      // folded into 001_init.sql (daily_bars)
  '002_partition_maintenance_fix.sql',
  '003_scraper_status_failing.sql',
]);

function assertNoRetiredFiles(files) {
  const stale = files.filter((f) => RETIRED.has(f));
  if (!stale.length) return;

  throw new Error(
    `${stale.length} retired migration file(s) are still in ${DIR}:\n\n`
    + stale.map((f) => `      ${f}`).join('\n')
    + '\n\n  These were folded into 001_init.sql. They are still present because\n'
    + '  extracting a release over an existing checkout merges files rather than\n'
    + '  replacing the directory, so removed files survive.\n\n'
    + '  Delete them and re-run:\n\n'
    + `      rm ${stale.map((f) => `src/db/migrations/${f}`).join(' ')}\n`
    + `      Remove-Item ${stale.map((f) => `src\\db\\migrations\\${f}`).join(', ')}   (PowerShell)\n`,
  );
}

function migrationFiles() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
}

async function ensureLedger(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    text PRIMARY KEY,
      checksum    text        NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      duration_ms integer
    )`);
}

async function migrate({ statusOnly = false } = {}) {
  const files = migrationFiles();

  // Before anything is applied: a leftover file from an earlier layout would
  // otherwise fail mid-run and leave the schema half-migrated.
  assertNoRetiredFiles(files);

  if (files.length === 0) {
    log.warn('no migration files found', { dir: DIR });
    return { applied: [], skipped: [], drift: [] };
  }

  const client = await pool.connect();
  try {
    // Serialises concurrent migrators. Released when the session ends.
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await ensureLedger(client);

    const { rows } = await client.query('SELECT filename, checksum FROM schema_migrations');
    const applied = new Map(rows.map((r) => [r.filename, r.checksum]));

    const result = { applied: [], skipped: [], drift: [] };

    for (const filename of files) {
      const sql = fs.readFileSync(path.join(DIR, filename), 'utf8');
      const sum = checksum(sql);

      if (applied.has(filename)) {
        if (applied.get(filename) !== sum) {
          result.drift.push(filename);
          log.error('migration changed after it was applied', {
            filename,
            appliedChecksum: applied.get(filename),
            fileChecksum: sum,
          });
        } else {
          result.skipped.push(filename);
        }
        continue;
      }

      if (statusOnly) {
        result.applied.push(filename);
        log.info('would apply (status only)', { filename });
        continue;
      }

      const started = Date.now();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        const ms = Date.now() - started;
        await client.query(
          'INSERT INTO schema_migrations (filename, checksum, duration_ms) VALUES ($1, $2, $3)',
          [filename, sum, ms],
        );
        await client.query('COMMIT');
        result.applied.push(filename);
        log.info('migration applied', { filename, ms });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        log.error('migration failed — stopping', {
          filename, err: log.serializeError(err),
        });
        throw new Error(`Migration ${filename} failed: ${err.message}`);
      }
    }

    if (result.drift.length) {
      throw new Error(
        `${result.drift.length} migration(s) changed after being applied: `
        + `${result.drift.join(', ')}. The database no longer matches the repository. `
        + 'Add a new migration instead of editing an applied one.',
      );
    }

    log.info('migrations complete', {
      applied: result.applied, skipped: result.skipped.length,
    });
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
  }
}

if (require.main === module) {
  const statusOnly = process.argv.includes('--status');
  // Say WHICH database, every time. A migration that reports success without
  // naming its target cannot be told apart from one that hit the wrong one.
  require('./pool').query(
    'SELECT current_database() AS db, inet_server_addr()::text AS host, inet_server_port() AS port',
  ).then((r) => {
    const w = r.rows[0];
    log.info('migrating', { database: w.db, host: w.host, port: w.port });
  }).catch(() => { /* the run below will fail with a clearer message */ });

  migrate({ statusOnly })
    .then(async () => { await close(); process.exit(0); })
    .catch(async (err) => {
      log.error('migration run failed', { message: err.message });
      await close().catch(() => {});
      process.exit(1);
    });
}

module.exports = { migrate, migrationFiles, assertNoRetiredFiles, RETIRED };

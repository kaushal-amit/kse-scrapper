'use strict';
/**
 * S-09 · MIGRATE_ON_BOOT — off in production, and a pending migration refuses
 * the boot by name.
 *
 * Applying migrations at boot keeps a developer's environment consistent and is
 * a no-op once everything is applied. In production it is the wrong shape: a
 * deploy that restarts the process also, silently, changes the schema. Migration
 * 039 renames the table holding the trader's order history — under boot-migrate
 * that runs unattended, with no backup taken and nobody watching. The failure is
 * not "the migration is wrong", it is "nobody decided when it ran".
 *
 * And the other half: starting against a schema the code does not match is how
 * you get a scraper writing to a column that is not there — every minute, for
 * four hours, with the first error long since scrolled away. So a pending
 * migration is a refusal, not a warning.
 */
const { requireTestDb } = require('../dbguard');
requireTestDb('boot-migrate');

const fs = require('fs');
const path = require('path');
const { query, close } = require('../../src/db/pool');
const { migrate } = require('../../src/db/migrate');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };

// The default, read the way src/index.js reads it.
const resolve = (env) => (env.MIGRATE_ON_BOOT !== undefined
  ? /^(1|true)$/i.test(String(env.MIGRATE_ON_BOOT).trim())
  : env.NODE_ENV !== 'production');

(async () => {
  try {
    // ── the default depends on NODE_ENV, and an explicit value wins ────────
    {
      ck('production defaults to OFF', resolve({ NODE_ENV: 'production' }) === false);
      ck('development defaults to ON', resolve({ NODE_ENV: 'development' }) === true);
      ck('no NODE_ENV at all defaults to ON', resolve({}) === true);
      ck('MIGRATE_ON_BOOT=true wins in production', resolve({ NODE_ENV: 'production', MIGRATE_ON_BOOT: 'true' }) === true);
      ck('MIGRATE_ON_BOOT=1 also', resolve({ NODE_ENV: 'production', MIGRATE_ON_BOOT: '1' }) === true);
      ck('MIGRATE_ON_BOOT=false wins in development', resolve({ MIGRATE_ON_BOOT: 'false' }) === false);
      // Anything that is not clearly true is off. A typo must not silently
      // enable schema changes on a deploy.
      ck('MIGRATE_ON_BOOT=yes is OFF — only true/1 enable it', resolve({ MIGRATE_ON_BOOT: 'yes' }) === false);
      ck('MIGRATE_ON_BOOT= (empty) is OFF', resolve({ MIGRATE_ON_BOOT: '' }) === false);
    }

    // ── statusOnly reports PENDING under its own key ───────────────────────
    {
      const st = await migrate({ statusOnly: true });
      ck('a fully migrated database has nothing pending', st.pending.length === 0, st.pending);
      ck('and nothing is reported as applied by a status run', st.applied.length === 0, st.applied);
      ck('while the applied ones are counted as skipped', st.skipped.length > 30, st.skipped.length);
    }

    // ── a pending migration is SEEN ────────────────────────────────────────
    {
      // Remove one row from the ledger: the file is now pending again, without
      // touching the schema.
      const victim = '040_market_holidays.sql';
      await query('DELETE FROM schema_migrations WHERE filename = $1', [victim]);

      const st = await migrate({ statusOnly: true });
      ck('the pending migration is listed', st.pending.includes(victim), st.pending);
      ck('and it is NOT in applied — the key means what it says',
        !st.applied.includes(victim), st.applied);

      // Put it back so the suite leaves the database as it found it.
      await migrate();
      const after = await migrate({ statusOnly: true });
      ck('and applying it clears the pending list', after.pending.length === 0, after.pending);
    }

    // ── the boot path refuses rather than warning ──────────────────────────
    {
      const src = fs.readFileSync(path.join(__dirname, '../../src/index.js'), 'utf8');
      const block = src.slice(src.indexOf('MIGRATE_ON_BOOT'), src.indexOf('holidays.load()'));
      // H-E moved the decision into src/db/migrateOnBoot.js so that WHICH
      // STRINGS REACH WHICH BRANCH could be asserted without opening a
      // database. What boot.js has to show is that it consults that helper —
      // migrate-on-boot-default.test.js owns the rule itself.
      ck('the boot decides through the shared helper',
        /shouldMigrateOnBoot\(process\.env\)/.test(block), block.slice(0, 200));
      ck('it THROWS on a pending migration rather than logging and continuing',
        /throw new Error\(/.test(block), block.slice(-400));
      ck('and the refusal names the pending files', /status\.pending\.join/.test(block));
      ck('and tells the operator the deploy step', /npm run migrate/.test(block));
      ck('the status run is what it consults, not a blind apply',
        /migrate\(\{ statusOnly: true \}\)/.test(block));
    }
  } catch (e) {
    ck('the suite ran without throwing', false, e.message);
  }

  await close();
  console.log(`\nboot migrate: ${p}/${n}`);
  process.exit(p === n ? 0 : 1);
})();

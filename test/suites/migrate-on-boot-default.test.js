'use strict';
/**
 * H-E · boot migrations are opted into, not spelled around.
 *
 * The refusal-to-start that MIGRATE_ON_BOOT gates is correct and well argued: a
 * deploy that restarts the process must not also, silently, change the schema —
 * 039 renames the table holding the trader's order history.
 *
 * THE DEFAULT WAS THE HOLE. It was:
 *
 *   : process.env.NODE_ENV !== 'production';
 *
 * — boot migrations ON unless NODE_ENV is EXACTLY the string 'production'. So
 * `NODE_ENV=prod`, `NODE_ENV=Production`, or NODE_ENV unset — each of them
 * ordinary on a hand-rolled systemd or pm2 deploy — and the rename runs
 * unattended at boot, with no backup, on a restart nobody thought of as a
 * schema change. The failure the comment describes, reachable by a typo.
 *
 * A process that does not KNOW it is a development environment does not
 * migrate. Production has to say so to get boot migrations, rather than having
 * to spell NODE_ENV correctly to avoid them.
 */
const fs = require('fs');
const path = require('path');
const { shouldMigrateOnBoot } = require('../../src/db/migrateOnBoot');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };

// ── THE SPELLINGS THAT USED TO LET A RENAME THROUGH ────────────────────────
{
  ck('NODE_ENV unset does NOT migrate at boot',
    shouldMigrateOnBoot({}) === false);
  ck("NODE_ENV='prod' does not either — the old check compared to the exact "
    + "string 'production'", shouldMigrateOnBoot({ NODE_ENV: 'prod' }) === false);
  ck("NODE_ENV='Production' does not", shouldMigrateOnBoot({ NODE_ENV: 'Production' }) === false);
  ck("NODE_ENV='PRODUCTION' does not", shouldMigrateOnBoot({ NODE_ENV: 'PRODUCTION' }) === false);
  ck("NODE_ENV='staging' does not — an unrecognised environment is not a "
    + 'development one', shouldMigrateOnBoot({ NODE_ENV: 'staging' }) === false);
  ck('an empty NODE_ENV does not', shouldMigrateOnBoot({ NODE_ENV: '' }) === false);
  ck("and 'production' itself still does not",
    shouldMigrateOnBoot({ NODE_ENV: 'production' }) === false);
}

// ── development still works without ceremony ───────────────────────────────
{
  ck('development migrates at boot', shouldMigrateOnBoot({ NODE_ENV: 'development' }) === true);
  ck('dev does too', shouldMigrateOnBoot({ NODE_ENV: 'dev' }) === true);
  ck('test does', shouldMigrateOnBoot({ NODE_ENV: 'test' }) === true);
  ck('local does', shouldMigrateOnBoot({ NODE_ENV: 'local' }) === true);
  ck('and the match is case-insensitive', shouldMigrateOnBoot({ NODE_ENV: 'Development' }) === true);
  ck('and tolerates surrounding whitespace', shouldMigrateOnBoot({ NODE_ENV: ' test ' }) === true);
}

// ── an explicit instruction wins, in both directions ───────────────────────
{
  ck('MIGRATE_ON_BOOT=true migrates even in production',
    shouldMigrateOnBoot({ NODE_ENV: 'production', MIGRATE_ON_BOOT: 'true' }) === true);
  ck('MIGRATE_ON_BOOT=1 does too',
    shouldMigrateOnBoot({ NODE_ENV: 'production', MIGRATE_ON_BOOT: '1' }) === true);
  ck('and yes/on, because somebody will write them',
    shouldMigrateOnBoot({ MIGRATE_ON_BOOT: 'yes' }) === true
    && shouldMigrateOnBoot({ MIGRATE_ON_BOOT: 'on' }) === true);

  ck('MIGRATE_ON_BOOT=false REFUSES even in development — an explicit off is '
    + 'an instruction, not a hint',
  shouldMigrateOnBoot({ NODE_ENV: 'development', MIGRATE_ON_BOOT: 'false' }) === false);
  ck('MIGRATE_ON_BOOT=0 does the same',
    shouldMigrateOnBoot({ NODE_ENV: 'development', MIGRATE_ON_BOOT: '0' }) === false);
  ck('and an unrecognised value is treated as OFF, never as on — a typo in the '
    + 'variable must not apply a migration',
  shouldMigrateOnBoot({ NODE_ENV: 'development', MIGRATE_ON_BOOT: 'ture' }) === false);
}

// ── an empty MIGRATE_ON_BOOT is "unset", not "off" ─────────────────────────
{
  // `MIGRATE_ON_BOOT=` in a .env file is how a variable is commented out in
  // practice; it should fall through to the NODE_ENV rule rather than pin off.
  ck('MIGRATE_ON_BOOT= falls through to NODE_ENV',
    shouldMigrateOnBoot({ NODE_ENV: 'development', MIGRATE_ON_BOOT: '' }) === true);
  ck('and still refuses when NODE_ENV says nothing',
    shouldMigrateOnBoot({ MIGRATE_ON_BOOT: '   ' }) === false);
}

// ── the old comparison is gone from the source ─────────────────────────────
{
  const boot = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'db', 'migrateOnBoot.js'), 'utf8');
  const live = boot.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  ck("no `NODE_ENV !== 'production'` survives in live code",
    !/NODE_ENV\s*!==\s*'production'/.test(live), (live.match(/.*NODE_ENV.*/g) || []));

  const index = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'index.js'), 'utf8');
  ck('index.js decides through the shared helper',
    /shouldMigrateOnBoot\(process\.env\)/.test(index));
  ck('and the refusal it gates still names the fix',
    /back up the database, run `npm run migrate`/.test(index));
}

console.log(`\nmigrate on boot default: ${p}/${n}`);
process.exit(p === n ? 0 : 1);

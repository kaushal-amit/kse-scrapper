'use strict';
/**
 * H-E · MIGRATE_ON_BOOT IS OPTED INTO, NOT SPELLED AROUND.
 *
 * The refusal-to-start this gates is correct and well-argued. The DEFAULT was
 * not. It was:
 *
 *   : process.env.NODE_ENV !== 'production';
 *
 * — boot migrations on unless NODE_ENV is EXACTLY the string 'production'. So
 * `NODE_ENV=prod`, `NODE_ENV=Production`, or NODE_ENV unset (all ordinary on a
 * hand-rolled systemd or pm2 deploy) and 039 — which renames the table holding
 * the trader's order history — runs unattended at boot, with no backup, on a
 * restart nobody thought of as a schema change. Precisely the failure the
 * comment above describes, reachable by a typo.
 *
 * The safe default is the one that costs a message rather than a table: a
 * process that does not KNOW it is a development environment does not migrate.
 * A deploy has to say MIGRATE_ON_BOOT=true to get boot migrations, instead of
 * having to spell NODE_ENV correctly to avoid them.
 *
 * The cost is a developer with no NODE_ENV set seeing a refusal on their first
 * pending migration — and that refusal names the file and the command that
 * applies it. That is a message; the other way round is a rename.
 *
 * Exported for the test: the whole finding was about which strings reach which
 * branch, and that cannot be asserted through a function that also opens a
 * database.
 */
const DEV_ENVS = new Set(['development', 'dev', 'test', 'local']);

function shouldMigrateOnBoot(env = process.env) {
  const explicit = env.MIGRATE_ON_BOOT;
  if (explicit !== undefined && String(explicit).trim() !== '') {
    return /^(1|true|yes|on)$/i.test(String(explicit).trim());
  }
  // No instruction. Migrate only where we can POSITIVELY identify a
  // development environment — never merely from failing to identify production.
  return DEV_ENVS.has(String(env.NODE_ENV || '').trim().toLowerCase());
}

module.exports = { shouldMigrateOnBoot, DEV_ENVS };

'use strict';
/**
 * src/db/sslMode.js — how this process talks TLS to Postgres, decided in one
 * place from one variable.
 *
 * Rebuilt from claude/spread-fix-delivery-2026-09-10.md (DB_SSL_MODE).
 *
 * WHAT WAS WRONG. pool.js carried a hardcoded
 *
 *     ssl: { rejectUnauthorized: false }
 *
 * directly beneath a commented-out line that read the config, under a comment
 * explaining why hardcoding false is wrong. Two consequences, both real:
 *
 *   · Certificate verification was off on every connection. Against a managed
 *     Postgres, anything that can answer for the DB host — a hijacked route, a
 *     won DNS answer — presents a self-signed certificate, completes the
 *     handshake, and receives the connection credentials and the trader's own
 *     order rows. Nothing logs an anomaly; the connection looks healthy.
 *   · TLS was forced ON even for `DB_SSL=false`, so the shipped default
 *     configuration could not connect to the shipped default database:
 *     "The server does not support SSL connections".
 *
 * THREE MODES, NAMED FOR WHAT THEY ACTUALLY PROMISE:
 *
 *   disable  no TLS. Correct for a unix socket or localhost.
 *   require  TLS, but the server is NOT authenticated. The traffic is
 *            encrypted and you do not know who you are encrypting it to. This
 *            is what the old hardcoded object did, and it warns every boot,
 *            because it is a state someone chose, not a state to settle into.
 *   verify   TLS with the certificate verified. What a managed Postgres over a
 *            network should use. DB_SSL_CA_FILE supplies the CA when the
 *            provider's root is not in the system store (RDS, for one).
 *
 * There is deliberately no mode that silently picks for you. In production the
 * variable is REQUIRED: a default would be a guess about the network this
 * process is on, and both possible guesses are wrong somewhere.
 */

const fs = require('fs');

const MODES = ['disable', 'require', 'verify'];

class SslConfigRefused extends Error {}

/**
 * Resolve the mode from the environment.
 *
 * DB_SSL is the old boolean and still works: `true` means `require`, with a
 * deprecation warning naming its replacement. It loses to DB_SSL_MODE when
 * both are set, because the specific setting should win over the vague one.
 */
function resolveMode({ env = process.env, warn = () => {} } = {}) {
  const raw = env.DB_SSL_MODE;

  /*
   * P2 · THE REFUSAL IS KEYED ON KNOWING THIS IS DEVELOPMENT, NOT ON FAILING
   * TO RECOGNISE PRODUCTION.
   *
   * This was `env.NODE_ENV === 'production'` — the same defect class as H-E,
   * which src/db/migrateOnBoot.js was rewritten to eliminate and whose header
   * states the principle: identify a development environment POSITIVELY, never
   * merely fail to identify production. NODE_ENV=prod, NODE_ENV=Production and
   * NODE_ENV unset are all ordinary on a hand-rolled systemd or pm2 deploy.
   *
   * Here the consequence is heavier than a migration. With NODE_ENV=prod and no
   * DB_SSL_MODE the refusal below never fired and the function fell through to
   * `return 'disable'` — so the process connected to a managed Postgres with NO
   * TLS AT ALL, carrying the connection credentials and the trader's order rows
   * in clear text. The only trace was one INFO line at boot reading
   * "database TLS: DISABLED".
   *
   * Now only a positively identified development environment gets a default.
   * Everything else has to say what it wants.
   */
  const DEV_ENVS = new Set(['development', 'dev', 'test', 'local']);
  const knownDev = DEV_ENVS.has(String(env.NODE_ENV || '').trim().toLowerCase());

  if (raw !== undefined && String(raw).trim() !== '') {
    const mode = String(raw).trim().toLowerCase();
    if (!MODES.includes(mode)) {
      throw new SslConfigRefused(
        `DB_SSL_MODE must be one of ${MODES.join(' | ')} (got "${raw}"). `
        + 'disable = no TLS; require = encrypted but the server is NOT authenticated; '
        + 'verify = encrypted and the certificate checked.');
    }
    if (env.DB_SSL !== undefined && String(env.DB_SSL).trim() !== '') {
      warn('both DB_SSL and DB_SSL_MODE are set — DB_SSL_MODE wins; remove DB_SSL');
    }
    return mode;
  }

  if (env.DB_SSL !== undefined && String(env.DB_SSL).trim() !== '') {
    const on = String(env.DB_SSL).trim().toLowerCase();
    const mode = (on === 'true' || on === '1') ? 'require' : 'disable';
    warn(`DB_SSL is deprecated — use DB_SSL_MODE=${mode}`
      + (mode === 'require'
        ? '. Note that "require" encrypts but does NOT authenticate the server; DB_SSL_MODE=verify does.'
        : ''));
    return mode;
  }

  if (!knownDev) {
    throw new SslConfigRefused(
      'DB_SSL_MODE is not set, and there is no safe default outside a development '
      + `environment (NODE_ENV is ${env.NODE_ENV ? `"${env.NODE_ENV}"` : 'not set'}). `
      + 'Set DB_SSL_MODE=verify for a database reached over a network (add DB_SSL_CA_FILE if its root '
      + 'is not in the system store), or DB_SSL_MODE=disable for a unix socket or localhost. '
      + 'DB_SSL_MODE=require encrypts without authenticating the server — choose it deliberately, not by default.');
  }
  return 'disable';
}

/**
 * The `ssl` value for `new Pool({...})`.
 *
 * `false` — not an object with everything switched off — is what node-postgres
 * needs in order not to ATTEMPT TLS. An object, however permissive its fields,
 * makes it demand a TLS handshake the local server will refuse.
 */
function sslOptions(mode, { env = process.env } = {}) {
  if (mode === 'disable') return false;
  if (mode === 'require') return { rejectUnauthorized: false };

  const opts = { rejectUnauthorized: true };
  const caFile = env.DB_SSL_CA_FILE;
  if (caFile) {
    try {
      opts.ca = fs.readFileSync(caFile, 'utf8');
    } catch (e) {
      throw new SslConfigRefused(
        `DB_SSL_CA_FILE could not be read: ${caFile} (${e.code || e.message}). `
        + 'Refusing rather than falling back to an unverified connection.');
    }
  }
  return opts;
}

/** One line at boot, so the mode in force is in the log rather than inferred. */
function describe(mode) {
  if (mode === 'disable') return 'database TLS: DISABLED (DB_SSL_MODE=disable)';
  if (mode === 'require') return 'database TLS: ENCRYPTED BUT UNVERIFIED (DB_SSL_MODE=require) — '
    + 'the server is not authenticated; use verify for a database reached over a network';
  return 'database TLS: VERIFIED (DB_SSL_MODE=verify)';
}

module.exports = { MODES, SslConfigRefused, resolveMode, sslOptions, describe };

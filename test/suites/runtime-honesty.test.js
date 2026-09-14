'use strict';
/**
 * P2 · five places the runtime reported something other than what happened.
 *
 * · DB_SSL_MODE's refusal was keyed on NODE_ENV === 'production'. The same
 *   defect class as H-E, with a heavier consequence: NODE_ENV=prod and no
 *   DB_SSL_MODE fell through to 'disable', so the process connected to a
 *   managed Postgres with NO TLS AT ALL — credentials and the trader's order
 *   rows in clear text, under one INFO line reading "database TLS: DISABLED".
 *
 * · closeAllConnections() destroys ALL sockets INCLUDING those serving a
 *   request. The comment above it describes the IDLE-socket problem; the API
 *   used was the other one. A SIGTERM inside POST /ingest/quotes tore that
 *   request's socket out, and that minute's ~137 quotes cannot be re-scraped.
 *
 * · _runJob returned the literal 'SUCCESS'. F-04 computed the real status and
 *   passed it to finishRun — the scrape_runs row said PARTIAL — and then this
 *   discarded it. runOnce exits on the return value, so a PARTIAL run exited 0
 *   and any CI or deploy step gating on it saw green.
 *
 * · /market-summary answered `400 {"ok":false}` with no reason, reading
 *   `when.error` from a function that returns `{ ok, reason }`. The other three
 *   callers read it correctly.
 *
 * · broker_status was stamped CAPTURED from the PRE-VALIDATION list, so a
 *   symbol whose every row was refused was recorded as captured, with today's
 *   date, in the column whose purpose is to date a change of state.
 *
 * · and migration 013 hardcodes three numbers thresholds.js makes
 *   configurable, so an env var could give market_day.regime two definitions.
 */
const { requireTestDb } = require('../dbguard');
requireTestDb('runtime-honesty');

const fs = require('fs');
const path = require('path');
const { query, close } = require('../../src/db/pool');
const sslMode = require('../../src/db/sslMode');
const parity = require('../../src/db/thresholdParity');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };

const REPO = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const liveOf = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const refused = (env) => {
  try { return { mode: sslMode.resolveMode({ env }) }; } catch (e) { return { refused: e.message }; }
};

// ── TLS · every spelling that used to connect in clear text ────────────────
{
  ck('NODE_ENV unset REFUSES rather than defaulting to no TLS',
    !!refused({}).refused, refused({}));
  ck("NODE_ENV='prod' refuses", !!refused({ NODE_ENV: 'prod' }).refused);
  ck("NODE_ENV='Production' refuses", !!refused({ NODE_ENV: 'Production' }).refused);
  ck("NODE_ENV='staging' refuses", !!refused({ NODE_ENV: 'staging' }).refused);
  ck("and 'production' itself still does", !!refused({ NODE_ENV: 'production' }).refused);

  ck('the refusal names what NODE_ENV actually was, so the operator can see '
    + 'the typo', /NODE_ENV is "prod"/.test(refused({ NODE_ENV: 'prod' }).refused),
  refused({ NODE_ENV: 'prod' }).refused);
  ck('and says which value to set for a networked database',
    /DB_SSL_MODE=verify/.test(refused({}).refused));

  ck('development still defaults', refused({ NODE_ENV: 'development' }).mode === 'disable');
  ck('and test does', refused({ NODE_ENV: 'test' }).mode === 'disable');

  // An explicit setting still wins everywhere.
  ck('an explicit mode is honoured in an unknown environment',
    refused({ NODE_ENV: 'prod', DB_SSL_MODE: 'verify' }).mode === 'verify');
  ck('and disable can still be chosen deliberately for a unix socket',
    refused({ NODE_ENV: 'prod', DB_SSL_MODE: 'disable' }).mode === 'disable');

  // The one that made the whole thing dangerous: disable must be literal false.
  ck("sslOptions('disable') is literal false, not an object",
    sslMode.sslOptions('disable') === false, sslMode.sslOptions('disable'));
}

// ── shutdown closes IDLE sockets, not live requests ────────────────────────
{
  const live = liveOf(read('src/index.js'));
  ck('shutdown calls closeIdleConnections', /closeIdleConnections\(\)/.test(live));
  ck('and NOT closeAllConnections, which destroys in-flight requests too',
    !/closeAllConnections\(\)/.test(live), (live.match(/.*closeAllConnections.*/g) || []));
  ck('the budget is still the backstop for a request that never finishes',
    /SHUTDOWN_BUDGET_MS/.test(live));
}

// ── a PARTIAL run says PARTIAL to its caller ───────────────────────────────
{
  const live = liveOf(read('src/jobs.js'));
  ck('the success path returns the computed status',
    /return \{ status, extracted, inserted, rejected \};/.test(live));
  ck('and no longer returns the literal',
    !/return \{ status: 'SUCCESS', extracted/.test(live),
    (live.match(/.*status: 'SUCCESS'.*/g) || []));

  const runOnce = liveOf(read('src/runOnce.js'));
  ck('runOnce still exits on it, which is why it had to be right',
    /result\.status === 'SUCCESS' \? 0 : 1/.test(runOnce));
}

// ── the stale-capture refusal names its reason ─────────────────────────────
{
  const ingest = read('src/api/ingest.js');
  const live = liveOf(ingest);
  ck('no caller reads when.error, which does not exist',
    !/when\.error/.test(live), (live.match(/.*when\.error.*/g) || []));
  const reasons = (live.match(/error: when\.reason/g) || []).length;
  ck('all four callers read when.reason', reasons === 4, reasons);

  // And the function really does return `reason`.
  const mod = require('../../src/api/ingest');
  const verdict = mod.checkCapturedAt(new Date(Date.now() - 3600_000).toISOString());
  ck('checkCapturedAt refuses an hour-old capture', verdict.ok === false, verdict);
  ck('and the field it populates is `reason`',
    typeof verdict.reason === 'string' && verdict.reason.length > 0, verdict);
  ck('there is no `error` field to have read', verdict.error === undefined, verdict);
}

// ── CAPTURED means stored, not offered ─────────────────────────────────────
{
  const live = liveOf(read('src/api/ingest.js'));
  ck('the captured set is built from what was STORED',
    /const stored = Array\.isArray\(checked\.rows\) \? checked\.rows : \[\];/.test(live));
  ck('and not from the pre-validation list',
    !/const captured = \[\.\.\.new Set\(mapped\.map/.test(live),
    (live.match(/.*new Set\(mapped\.map.*/g) || []));
}

(async () => {
  try {
    // ── the database's numbers match the code's ──────────────────────────
    {
      const ok = await parity.assertThresholdParity();
      ck('the migration and the thresholds agree today', ok.ok === true, ok);
    }

    // ── and drift is a refusal, not a surprise at 13:35 ──────────────────
    {
      // The parity check reads process.env through the thresholds module, so
      // the drift is created by moving the threshold rather than the migration
      // — which is the direction an operator would actually move it.
      const before = process.env.SD_AT_OFFER_MAX;
      process.env.SD_AT_OFFER_MAX = '95';
      for (const k of Object.keys(require.cache)) {
        if (/config[\\/]thresholds\.js$/.test(k) || /db[\\/]thresholdParity\.js$/.test(k)) {
          delete require.cache[k];
        }
      }
      const fresh = require('../../src/db/thresholdParity');
      let caught = null;
      try { await fresh.assertThresholdParity(); } catch (e) { caught = e; }

      ck('MOVING A THRESHOLD THE DATABASE ALSO ENFORCES IS REFUSED', !!caught, 'no throw');
      ck('and the refusal names both numbers',
        caught && /uses .*90/.test(caught.message) && /is 95/.test(caught.message),
        caught && caught.message);
      ck('and says what it would have cost — the whole day\'s compute',
        caught && /failing the whole day/.test(caught.message), caught && caught.message);
      ck('and is flagged so a caller can tell it from a connection error',
        caught && caught.thresholdParity === true, caught && caught.thresholdParity);

      if (before === undefined) delete process.env.SD_AT_OFFER_MAX;
      else process.env.SD_AT_OFFER_MAX = before;
    }

    // ── a missing object is not a passing check ──────────────────────────
    {
      const nums = parity.numbersIn('CHECK ((pct_at_offer IS NULL) OR (pct_at_offer <= 90))');
      ck('the number extractor finds the cutoff', nums.includes(90), nums);
      ck('and does not invent one from an empty definition',
        parity.numbersIn('').length === 0);
    }

    // ── the boot path actually calls it ──────────────────────────────────
    {
      const live = liveOf(read('src/index.js'));
      ck('boot asserts the parity', /thresholdParity\.assertThresholdParity\(\)/.test(live));
      ck('before the calendar is loaded and the window reported',
        live.indexOf('assertThresholdParity()') < live.indexOf('holidays.load()'), 'ordering');
    }
  } catch (e) {
    ck('the suite ran without throwing', false, e.message);
  }

  await close();
  console.log(`\nruntime honesty: ${p}/${n}`);
  process.exit(p === n ? 0 : 1);
})();

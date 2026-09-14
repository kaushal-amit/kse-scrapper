'use strict';
/**
 * H-A and H-B · the execution count is money, and it now says "unmeasured"
 * rather than guessing — and the check that would have caught the guess is
 * bound to the right relation again.
 *
 * H-A · FOUR DEFECTS IN ONE CTE (039/041):
 *
 *   · the `1 +` base was added unconditionally, so an order first seen UNFILLED
 *     and then filled once reported TWO executions for one;
 *   · `GREATEST(1, …)` was unconditional, so an order cancelled having never
 *     filled reported ONE execution to charge a settlement fee on;
 *   · a NULL filled_quantity broke the lag chain, LOSING a genuine rise across
 *     the gap — an execution paid for and not counted;
 *   · the chain was not partitioned by ingest_source, so two sources
 *     interleaving INVENTED an execution that never happened.
 *
 * The decision on the one case that is a judgement rather than a repair: an
 * order FIRST SIGHTED ALREADY FILLED has no rise to count and no evidence of
 * how many executions produced the fill. NULL. Not a plausible 1. This is the
 * standing principle — refuse over a plausible-but-wrong number — applied to
 * the one column in the schema that is denominated in money.
 *
 * H-B · order_fee_check followed 039's RENAME by OID and had been reading the
 * raw observation table and its deprecated accumulator column ever since.
 */
const { requireTestDb } = require('../dbguard');
requireTestDb('executions-unmeasured');

const { query, close } = require('../../src/db/pool');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };

const at = (hhmm) => new Date(`2026-09-10T${hhmm}:00+03:00`);

/** One raw sighting, straight into the observation table. */
const see = (order_id, over = {}) => query(
  `INSERT INTO awsat_order_obs
     (order_id, symbol, side, order_status, price, quantity, filled_quantity,
      remaining_qty, trading_date, ingest_source, observed_at, last_seen_at, created_at)
   VALUES ($1, 'CATTL', 'BUY', $2, 176, 4000, $3, $4, '2026-09-10', $5, $6, $6, $6)`,
  [order_id, over.status || 'Queued',
    over.filled === undefined ? 0 : over.filled,
    over.remaining === undefined ? 4000 : over.remaining,
    over.source || 'awsat_client', over.at || at('09:00')]);

const execs = async (id) => (await query(
  'SELECT executions_observed FROM awsat_order_list WHERE order_id = $1', [id]
)).rows[0];

(async () => {
  try {
    await query("DELETE FROM awsat_order_obs WHERE order_id LIKE 'EX-%'");

    // ── THE PHANTOM · seen unfilled, then filled once, is ONE ──────────────
    {
      await see('EX-ONE', { at: at('09:00'), filled: 0, remaining: 4000 });
      await see('EX-ONE', { at: at('09:05'), filled: 4000, remaining: 0, status: 'Filled' });
      const r = await execs('EX-ONE');
      ck('ONE fill rise is ONE execution, not two — the phantom +1 is gone',
        Number(r.executions_observed) === 1, r);
    }

    // ── two rises are two ─────────────────────────────────────────────────
    {
      await see('EX-TWO', { at: at('09:00'), filled: 0 });
      await see('EX-TWO', { at: at('09:05'), filled: 1500, remaining: 2500, status: 'Partially Filled' });
      await see('EX-TWO', { at: at('09:10'), filled: 4000, remaining: 0, status: 'Filled' });
      ck('two rises are two executions', Number((await execs('EX-TWO')).executions_observed) === 2,
        await execs('EX-TWO'));
    }

    // ── CANCELLED, NEVER FILLED · zero, not one ───────────────────────────
    {
      await see('EX-ZERO', { at: at('09:00'), filled: 0 });
      await see('EX-ZERO', { at: at('09:30'), filled: 0, status: 'Cancelled' });
      const r = await execs('EX-ZERO');
      ck('an order cancelled having never filled reports ZERO executions',
        Number(r.executions_observed) === 0, r);
      ck('and specifically not the old GREATEST(1, …) answer',
        Number(r.executions_observed) !== 1, r);
    }

    // ── FIRST SIGHTED ALREADY FILLED · NULL, not a guess ──────────────────
    {
      // The capture started mid-session, or the grid rendered late: the very
      // first reading of this order already showed 4,000 filled. How many
      // executions made that fill? Nothing in the data says.
      await see('EX-NULL', { at: at('11:00'), filled: 4000, remaining: 0, status: 'Filled' });
      await see('EX-NULL', { at: at('11:05'), filled: 4000, remaining: 0, status: 'Filled' });
      const r = await execs('EX-NULL');
      ck('an order first sighted ALREADY FILLED is UNMEASURED — NULL',
        r.executions_observed === null, r);
      ck('and it is not silently 1', Number(r.executions_observed) !== 1, r);
    }

    // ── the order still EXISTS when nothing could be measured ─────────────
    {
      // Every sighting had a NULL filled cell. Under the old INNER JOIN this
      // order vanished from the list entirely — losing the order, not just its
      // execution count.
      await query(
        `INSERT INTO awsat_order_obs
           (order_id, symbol, side, order_status, price, quantity, filled_quantity,
            trading_date, ingest_source, observed_at, last_seen_at, created_at)
         VALUES ('EX-BLIND','CATTL','BUY','Queued',176,4000,NULL,'2026-09-10','awsat_client',$1,$1,$1)`,
        [at('09:00')]);
      const r = await execs('EX-BLIND');
      ck('an order whose fill cell NEVER rendered is still IN THE LIST', !!r, r);
      ck('with an unmeasured execution count', r && r.executions_observed === null, r);
    }

    // ── A NULL SIGHTING DOES NOT LOSE THE RISE ACROSS IT ──────────────────
    {
      await see('EX-GAP', { at: at('09:00'), filled: 0 });
      await query(
        `INSERT INTO awsat_order_obs
           (order_id, symbol, side, order_status, price, quantity, filled_quantity,
            trading_date, ingest_source, observed_at, last_seen_at, created_at)
         VALUES ('EX-GAP','CATTL','BUY','Queued',176,4000,NULL,'2026-09-10','awsat_client',$1,$1,$1)`,
        [at('09:05')]);
      await see('EX-GAP', { at: at('09:10'), filled: 4000, remaining: 0, status: 'Filled' });
      const r = await execs('EX-GAP');
      ck('a sighting that did not READ the fill is skipped, and the rise across '
        + 'it SURVIVES', Number(r.executions_observed) === 1, r);
      ck('it is not counted as a fall to zero and back', Number(r.executions_observed) !== 2, r);
    }

    // ── TWO SOURCES DO NOT INVENT AN EXECUTION ────────────────────────────
    {
      // The same order, one fill, watched by two clients. The second source's
      // reading at 09:07 is STALE — it still shows 0 after the fill at 09:05.
      // Interleaved in one chain that reads as fall-then-rise: two executions
      // for one fill, conjured by having two observers.
      await see('EX-SRC', { at: at('09:00'), filled: 0, source: 'awsat_client' });
      await see('EX-SRC', { at: at('09:01'), filled: 0, source: 'awsat_server' });
      await see('EX-SRC', { at: at('09:05'), filled: 4000, remaining: 0, status: 'Filled', source: 'awsat_client' });
      await see('EX-SRC', { at: at('09:07'), filled: 0, source: 'awsat_server' });
      await see('EX-SRC', { at: at('09:09'), filled: 4000, remaining: 0, status: 'Filled', source: 'awsat_server' });
      const r = await execs('EX-SRC');
      ck('two sources watching ONE fill report ONE execution, not two',
        Number(r.executions_observed) === 1, r);
    }

    // ── sources are maxed, never summed ───────────────────────────────────
    {
      // Source A saw both fills; source B only the second. They are two views
      // of the SAME two executions — summing would charge for four.
      await see('EX-MAX', { at: at('09:00'), filled: 0, source: 'awsat_client' });
      await see('EX-MAX', { at: at('09:02'), filled: 1000, remaining: 3000, source: 'awsat_client' });
      await see('EX-MAX', { at: at('09:04'), filled: 4000, remaining: 0, source: 'awsat_client' });
      await see('EX-MAX', { at: at('09:03'), filled: 0, source: 'awsat_server' });
      await see('EX-MAX', { at: at('09:06'), filled: 4000, remaining: 0, source: 'awsat_server' });
      const r = await execs('EX-MAX');
      ck('the best-informed source wins — 2, not 2+1', Number(r.executions_observed) === 2, r);
    }

    // ── and a source that started blind does not veto one that did not ────
    {
      await see('EX-MIX', { at: at('11:00'), filled: 4000, remaining: 0, source: 'awsat_server' });
      await see('EX-MIX', { at: at('09:00'), filled: 0, source: 'awsat_client' });
      await see('EX-MIX', { at: at('09:05'), filled: 4000, remaining: 0, source: 'awsat_client' });
      const r = await execs('EX-MIX');
      ck('one source measured it, so the order is measured',
        Number(r.executions_observed) === 1, r);
    }

    // ── H-B · order_fee_check reads the VIEW ──────────────────────────────
    {
      const { rows } = await query(
        `SELECT pg_get_viewdef('public.order_fee_check'::regclass, true) AS def`);
      const def = rows[0].def;
      ck('order_fee_check reads awsat_order_list', /awsat_order_list/.test(def), def.slice(0, 200));
      ck('and NOT the raw observation table — the OID the RENAME left it bound to',
        !/awsat_order_obs/.test(def), def.slice(0, 200));
    }

    // ── it exposes the unmeasured rows rather than burying them ───────────
    {
      const { rows } = await query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'order_fee_check'");
      const cols = rows.map((r) => r.column_name);
      ck('order_fee_check names the unmeasured case', cols.includes('executions_unmeasured'), cols);
      ck('and still reports fee_per_execution', cols.includes('fee_per_execution'), cols);
    }

    // ── an unmeasured order does not enter the baseline as a 1 ────────────
    {
      await query("DELETE FROM awsat_order_obs WHERE order_id LIKE 'FEE-%'");
      // A measured order: one execution, 1 KD of fee.
      await query(
        `INSERT INTO awsat_order_obs
           (order_id, symbol, side, order_status, price, quantity, filled_quantity,
            order_value, net_value, trading_date, ingest_source, observed_at, last_seen_at, created_at)
         VALUES ('FEE-OK','CATTL','BUY','Queued',176,1000,0,NULL,NULL,'2026-09-10','awsat_client',$1,$1,$1),
                ('FEE-OK','CATTL','BUY','Filled',176,1000,1000,100,101,'2026-09-10','awsat_client',$2,$2,$2),
                ('FEE-BLIND','CATTL','BUY','Filled',176,1000,1000,100,109,'2026-09-10','awsat_client',$2,$2,$2)`,
        [at('09:00'), at('09:05')]);

      const { rows } = await query(
        `SELECT order_id, executions_observed, executions_unmeasured, fee_per_execution
           FROM order_fee_check WHERE order_id LIKE 'FEE-%'`);
      const ok = rows.find((r) => r.order_id === 'FEE-OK');
      const blind = rows.find((r) => r.order_id === 'FEE-BLIND');
      ck('the measured order has a fee per execution', ok && Number(ok.fee_per_execution) > 0, ok);
      ck('the unmeasured one is FLAGGED', blind && blind.executions_unmeasured === true, blind);
      ck('and its fee_per_execution is NULL rather than fee/1',
        blind && blind.fee_per_execution === null, blind);
    }

    await query("DELETE FROM awsat_order_obs WHERE order_id LIKE 'EX-%' OR order_id LIKE 'FEE-%'");
  } catch (e) {
    ck('the suite ran without throwing', false, e.message);
  }

  await close();
  console.log(`\nexecutions unmeasured: ${p}/${n}`);
  process.exit(p === n ? 0 : 1);
})();

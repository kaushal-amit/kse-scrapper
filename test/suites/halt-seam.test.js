// B4 · the halt seam. The backend writes spread.halt_event; the scraper mirrors
// each RESUME firing into public.signal_log as the FIRST step of signals.score,
// once and only once, with a count-equality check that fails loudly on drift.
// B3/B4 · the /slots/:n endpoint applies a swap and refuses an occupied slot.
process.env.AWSAT_MODE = 'client';
const db = require('../../src/db/pool');
const mirror = require('../../src/jobs/mirrorHalts');
let p = 0, n = 0; const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, JSON.stringify(x)); };

const day = '1996-03-03';

// Whether the REAL backend spread.halt_event already exists (combined `kse` DB)
// or we must stub it (scraper-only test DB). Set once, in makeHaltEvent.
let haltPre = null;

async function makeHaltEvent() {
  // The backend's table, as this scraper-only test DB would see it on kse. But
  // this same DB may BE the combined `kse` where the real backend schema already
  // exists — so detect it and never CREATE over, nor later DROP, a real table.
  await db.query('CREATE SCHEMA IF NOT EXISTS spread');
  haltPre = await db.query("SELECT to_regclass('spread.halt_event') AS t").then((r) => !!r.rows[0].t);
  if (!haltPre) {
    await db.query(`CREATE TABLE spread.halt_event (
      id bigserial PRIMARY KEY, trading_day date, symbol text, kind text,
      detected_at timestamptz, resume_price_fils numeric, verdict text, verdict_detail text)`);
  }
  await db.query('DELETE FROM spread.halt_event WHERE trading_day = $1', [day]);
}

(async () => {
  await db.query("DELETE FROM signal_log WHERE trading_date = $1", [day]);

  // ── the mirror ──
  await makeHaltEvent();
  const at = new Date(day + 'T10:00:00Z');
  await db.query(`INSERT INTO spread.halt_event (trading_day, symbol, kind, detected_at, resume_price_fils, verdict, verdict_detail)
    VALUES ($1,'FUTUREKID','RESUME',$2,142,'EXIT BLOCKED','offer 7x your shares'),
           ($1,'FUTUREKID','HALT',$3,NULL,NULL,NULL)`, [day, at, new Date(day + 'T09:58:00Z')]);

  const r1 = await mirror.mirror(day);
  ck('the mirror copies the RESUME firing', r1.copied === 1 && r1.skipped === false, r1);
  const { rows: sig } = await db.query(
    "SELECT symbol, signal, price, message FROM signal_log WHERE trading_date = $1 AND signal = 'HALT_RESUME'", [day]);
  ck('a HALT_RESUME row appears in signal_log', sig.length === 1 && sig[0].symbol === 'FUTUREKID', sig);
  ck('  with the resume price as the scoring baseline', Number(sig[0].price) === 142, sig[0].price);
  ck('  and the verdict in the message', /EXIT BLOCKED/.test(sig[0].message), sig[0].message);
  ck('  the HALT (not a firing) is NOT mirrored', sig.length === 1, sig.length);

  // ── once and only once ──
  const r2 = await mirror.mirror(day);
  ck('a second run copies nothing (once and only once)', r2.copied === 0 && r2.present === 1, r2);
  const { rows: c2 } = await db.query(
    "SELECT count(*)::int AS n FROM signal_log WHERE trading_date = $1 AND signal = 'HALT_RESUME'", [day]);
  ck('  still exactly one row', c2[0].n === 1, c2[0].n);

  // ── the count-equality check fails loudly on drift ──
  // A stale HALT_RESUME with no matching halt_event (a deleted event) → mismatch.
  await db.query(`INSERT INTO signal_log (fired_at, trading_date, symbol, signal, price)
    VALUES ($1, $2, 'GHOST', 'HALT_RESUME', 100)`, [new Date(day + 'T11:00:00Z'), day]);
  let threw = null;
  try { await mirror.mirror(day); } catch (e) { threw = e; }
  ck('a mismatch (more signal_log than halt_event) fails the job loudly', threw != null, threw && threw.message);
  ck('  and the error names the counts', threw != null && /halt mirror mismatch/.test(threw.message), threw && threw.message);
  await db.query("DELETE FROM signal_log WHERE symbol = 'GHOST'");

  // ── G-2 · the mirror copies BACKFILL rows too, and scoreBackfill scores them ──
  const scorer = require('../../src/jobs/scoreSignals');
  const g2day = '1996-03-04';
  await db.query("DELETE FROM signal_log WHERE trading_date = $1", [g2day]);
  await db.query('ALTER TABLE spread.halt_event ADD COLUMN IF NOT EXISTS source text DEFAULT \'LIVE\'');
  const g2fired = new Date(g2day + 'T10:00:00Z');
  await db.query(`INSERT INTO spread.halt_event (trading_day, symbol, kind, detected_at, resume_price_fils, verdict, source)
    VALUES ($1,'BACKF','RESUME',$2,150,'TRADEABLE','BACKFILL')`, [g2day, g2fired]);
  // forward prices in the board-wide quotes (the symbol is not a depth slot).
  await db.query(`INSERT INTO awsat_market_quotes(market,symbol,session,last_price,trading_date,ingest_source,source_precedence,created_at)
    values ('KSE','BACKF','Trading',150,$1,'awsat_server',1,$2),('KSE','BACKF','Trading',156,$1,'awsat_server',1,$3)`,
    [g2day, g2fired, new Date(g2fired.getTime() + 5 * 60000)]);
  const g2m = await mirror.mirror(g2day);
  ck('the mirror copies the BACKFILL RESUME (no source filter)', g2m.copied === 1, g2m);
  await scorer.scoreBackfill(null);
  const { rows: g2s } = await db.query("SELECT px_5min, was_right FROM signal_log WHERE symbol='BACKF' AND signal='HALT_RESUME' AND trading_date=$1", [g2day]);
  ck('a backfilled RESUME appears in signal_log once and gets px_5min', g2s.length === 1 && Number(g2s[0].px_5min) === 156, g2s);
  await db.query("DELETE FROM signal_log WHERE trading_date = $1", [g2day]);
  await db.query("DELETE FROM awsat_market_quotes WHERE trading_date = $1", [g2day]);
  await db.query("DELETE FROM spread.halt_event WHERE trading_day = $1", [g2day]);

  // ── a scraper-only DB (no spread schema) is a skip, not a failure ──
  // Only exercisable when WE stubbed the table; on the combined `kse` the real
  // backend table exists and must never be dropped — assert the guard instead.
  await db.query("DELETE FROM signal_log WHERE trading_date = $1", [day]);
  if (!haltPre) {
    await db.query('DROP TABLE IF EXISTS spread.halt_event');
    const r3 = await mirror.mirror(day);
    ck('no spread.halt_event → skipped, not failed', r3.skipped === true && r3.copied === 0, r3);
  } else {
    ck('real backend spread.halt_event present — the stub-drop path is skipped (not dropping a real table)', true, { haltPre });
    // On the combined DB we never dropped the table, so remove OUR test rows.
    await db.query("DELETE FROM spread.halt_event WHERE trading_day = $1", [day]);
  }
  console.log(`\nhalt seam: ${p}/${n}`);
  await db.close();
  process.exit(p === n ? 0 : 1);
})();

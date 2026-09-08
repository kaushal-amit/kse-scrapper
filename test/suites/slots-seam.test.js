// B3/B4 · the slot endpoints. POST /slots/:n applies a swap and returns the
// resulting row, honours the backend's replaced_symbol, and refuses a slot the
// backend marks as holding a position (spread.order_leg). POST /depth-symbols
// sets the whole list in one transaction.
process.env.AWSAT_MODE = 'client'; process.env.INGEST_TOKEN = 'trading';
const express = require('express');
const db = require('../../src/db/pool');
const clock = require('../../src/market/clock');
let p = 0, n = 0; const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, JSON.stringify(x)); };

const app = express(); app.use(express.json());
app.use('/', require('../../src/api/ingest').createRouter());
const post = (path, body) => fetch('http://127.0.0.1:8817' + path, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-ingest-token': 'trading' }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

const srv = app.listen(8817, async () => {
  const day = clock.tradingDay();
  const clean = async () => {
    await db.query("delete from depth_watchlist where symbol like 'SLT%'");
    await db.query("delete from instruments where symbol like 'SLT%'");
  };
  await clean();
  for (const s of ['SLTA', 'SLTB', 'SLTC']) {
    await db.query("insert into instruments(symbol,market,is_tradeable) values ($1,'Main Market',true) on conflict (symbol) do update set is_tradeable=true", [s]);
  }

  // ── apply a swap and return the row ──
  const r1 = await post('/slots/4', { symbol: 'SLTA', reason: 'HALT' });
  ck('POST /slots/4 applies', r1.status === 200 && r1.body.ok === true && r1.body.slot === 4, r1.body);
  ck('  and returns the resulting slot row', r1.body.row && r1.body.row.symbol === 'SLTA' && Number(r1.body.row.slot_no) === 4, r1.body.row);

  // ── the backend names what it replaced ──
  const r2 = await post('/slots/4', { symbol: 'SLTB', reason: 'HALT', replaced_symbol: 'SLTA' });
  ck('replaced_symbol from the backend is honoured', r2.status === 200 && r2.body.replaced === 'SLTA' && r2.body.row.replaced_symbol === 'SLTA', r2.body);

  // ── a slot the backend marks as holding a position is refused ──
  // On a scraper-only test DB the backend's spread.* tables do not exist, so we
  // stub them; but this same DB may BE the combined `kse` where the real backend
  // schema is already present (NOT NULL trading_day, a quantities CHECK, an FK to
  // public.instruments). So: detect whether the tables pre-exist, insert a row
  // that satisfies the REAL schema either way, and never DROP a table we did not
  // create — dropping the operator's real spread.order_leg would be catastrophic.
  await db.query('CREATE SCHEMA IF NOT EXISTS spread');
  const olPre = await db.query("SELECT to_regclass('spread.order_leg') AS t").then((r) => !!r.rows[0].t);
  const clPre = await db.query("SELECT to_regclass('spread.claim') AS t").then((r) => !!r.rows[0].t);
  if (!olPre) {
    await db.query(`CREATE TABLE spread.order_leg (
      id bigserial PRIMARY KEY, trading_day date NOT NULL, symbol text NOT NULL,
      contract_seq int NOT NULL, side text NOT NULL, status text NOT NULL,
      price_fils numeric NOT NULL, shares bigint NOT NULL, filled_shares bigint)`);
  }
  if (!clPre) {
    await db.query('CREATE TABLE spread.claim (id bigserial PRIMARY KEY, symbol text)');
  }
  await db.query("DELETE FROM spread.order_leg WHERE symbol = 'SLTB'");
  // A full, constraint-valid FILLED leg: trading_day + all NOT NULL columns, a
  // filled_shares (FILLED legs require one), and quantities that pass the CHECK.
  // SLTB is already in public.instruments (seeded above), so the FK is satisfied.
  await db.query(`INSERT INTO spread.order_leg
    (trading_day, symbol, contract_seq, side, status, price_fils, shares, filled_shares)
    VALUES (current_date, 'SLTB', 1, 'BUY', 'FILLED', 150, 1000, 1000)`);
  const r3 = await post('/slots/4', { symbol: 'SLTC', reason: 'wake-up' });
  ck('a slot holding a backend position is refused (409)', r3.status === 409 && r3.body.ok === false, r3.body);
  ck('  and the reason names the held symbol', r3.body.holding === 'SLTB', r3.body);
  // Clean up the test row; drop the stubs ONLY if we created them this run.
  await db.query("DELETE FROM spread.order_leg WHERE symbol LIKE 'SLT%'");
  if (!olPre) await db.query('DROP TABLE IF EXISTS spread.order_leg');
  if (!clPre) await db.query('DROP TABLE IF EXISTS spread.claim');

  // ── the bulk setter, one transaction ──
  const r4 = await post('/depth-symbols', { date: day, slots: [{ slot: 1, symbol: 'SLTA' }, { slot: 2, symbol: 'SLTB' }, { slot: 3, symbol: 'SLTC' }] });
  ck('POST /depth-symbols sets the list', r4.status === 200 && r4.body.ok === true && r4.body.slots.length >= 3, r4.body);
  const r5 = await post('/depth-symbols', { date: day, slots: [{ slot: 1, symbol: 'SLTA' }, { slot: 2, symbol: 'SLTA' }] });
  ck('a duplicate symbol is refused, atomically', r5.status === 400 && /twice/.test(r5.body.error), r5.body);
  const r6 = await post('/depth-symbols', { date: day, slots: [{ slot: 9, symbol: 'SLTA' }] });
  ck('a bad slot number is refused', r6.status === 400, r6.body);

  // ── G-5 · the published slot count equals the max n the POST accepts ──
  const gsym = await fetch('http://127.0.0.1:8817/depth-symbols', { headers: { 'x-ingest-token': 'trading' } }).then((r) => r.json());
  ck('GET /depth-symbols publishes slotCount (5 by default)', gsym.slotCount === 5, gsym.slotCount);
  const overCount = await post(`/slots/${gsym.slotCount + 1}`, { symbol: 'SLTA', reason: 'test' });
  ck('a slot above slotCount is refused', overCount.status === 400, overCount.body);
  await db.query("delete from depth_watchlist where symbol like 'SLT%'"); // free the symbols
  const atCount = await post(`/slots/${gsym.slotCount}`, { symbol: 'SLTA', reason: 'test' });
  ck('the slot AT slotCount is accepted — the GET count is the max the POST takes', atCount.status === 200, atCount.body);

  await clean();
  console.log(`\nslots seam: ${p}/${n}`);
  srv.close(); await db.close();
  process.exit(p === n ? 0 : 1);
});

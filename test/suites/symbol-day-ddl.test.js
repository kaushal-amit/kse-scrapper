// The DDL landed as specified, and nothing computes yet.
process.env.AWSAT_MODE='client';
const db=require('../../src/db/pool');
let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,JSON.stringify(x))};
(async()=>{
  // SCOPED TO public. A database that also carries the backend's spread.* views
  // has a second symbol_day, and an unscoped count returns both — 167 columns
  // where there are 112.
  const cols=async(t)=>(await db.query(
    "select column_name, data_type from information_schema.columns "
    + "where table_schema='public' and table_name=$1",[t])).rows;

  // ── the retired table is gone ──
  const {rows:old}=await db.query(
    "select count(*)::int c from information_schema.tables where table_name='daily_stock_analysis'");
  ck('daily_stock_analysis dropped', old[0].c===0, old[0]);

  // ── symbol_day ──
  const sd=await cols('symbol_day');
  ck('symbol_day exists', sd.length>0, sd.length);
  // 86 from the spec DDL, +1 for pct_at_offer, which rule 5 names but the DDL
  // omitted — without it a NULL buy_sell_ratio cannot be told apart from "not
  // computed", and test S5 would pass even with the job broken.
  const name=(c)=>sd.find(x=>x.column_name===c);

  // 86 from the spec DDL, +1 pct_at_offer (rule 5 was unauditable without it),
  // +4 from the count reconciliation. The "90" headline was stale prose; the
  // DDL always had 86 and nothing was lost in transit.
  // 86 spec + pct_at_offer + 4 reconciled + prev_session_gap_days +
  // tick_band_crossed = 93. The renames (moves_2plus -> up_moves_2plus) change
  // names, not the count.
  // +close_source (028). THIN says "something was wrong"; close_source says
  // exactly what — 14 of 29 captured days have a close that is the last
  // Trading print rather than the official close.
  // +4 from 031: markup, resumed, lift, hit — the fields the front end reads
  // that had no column. resumed stays NULL: unknown, not "never suspended".
  // +9 from 032: range_source and the eight flow columns.
  // +5 from 035: the columns the backend computed and we did not. avg_spread_pct
  // is the one that matters — the raw fils figure ranks a 0.1-tick stock as
  // tighter than a 1-fil stock when it is wider in ticks.
  // +1 from 049: quality_rule_version. The column exists because data_quality
  // holds two generations of label — 3,496 rows written by a rule that is in no
  // commit, and the rest by rule 2 — and nothing else distinguishes them.
  // -45 from 053: declared, never written, and read by nothing. The count is
  // asserted rather than described because this suite is the schema's snapshot
  // — if a column comes back, or another goes, it says so here first.
  ck('68 columns after migration 053', sd.length===68, sd.length);
  for (const c of ['avg_spread_fils','avg_spread_pct','days_active','down_days','peak_hour']) {
    ck(c + ' present', !!name(c));
  }
  ck('range_source present — an unmarked short range is a wrong gate',
     !!name('range_source'));
  for (const c of ['avg_uptick_shares','avg_downtick_shares','uptick_ratio',
    'n_upticks','n_downticks','turnover_kd',
    'first_half_shares_per_min','second_half_shares_per_min']) {
    ck(c + ' present', !!name(c));
  }
  for (const c of ['markup','resumed','lift','hit']) {
    ck(c + ' present', !!name(c));
  }
  ck('close_source present', !!name('close_source'));
  ck('prev_session_gap_days present — "5d" can span 11 calendar days',
     !!name('prev_session_gap_days'));
  ck('tick_band_crossed present — two tick regimes in one session',
     !!name('tick_band_crossed'));
  ck('moves_2plus RENAMED to up_moves_2plus', !name('moves_2plus') && !!name('up_moves_2plus'));
  ck('moves_3plus RENAMED to up_moves_3plus', !name('moves_3plus') && !!name('up_moves_3plus'));
  ck('pct_at_offer present — rule 5 is auditable', !!name('pct_at_offer'));

  // prev_session_used: a chg_1d spanning the 29-30 July gap measures three
  // days while calling itself one, and nothing in the row would say so.
  ck('prev_session_used records WHICH session prev_close came from',
     !!name('prev_session_used') && name('prev_session_used').data_type==='date',
     name('prev_session_used'));

  /*
   * ─── THE PERCENTILE GROUPS ARE GONE, AND THE SYMMETRY WAS THE POINT ──────
   *
   * This asserted that spread_fils had five percentile points like bid and
   * offer, because it once had two and the asymmetry looked like an oversight.
   * It was fixed by ADDING three columns. Nothing then wrote any of the five,
   * or any of the ten on bid and offer beyond p25/p50 — depth covers 8 to 18
   * symbols of 142, so the percentiles were never computable for the market
   * they claimed to describe.
   *
   * 053 dropped thirteen of the fifteen. bid_p25 and bid_p50 survive only
   * because spread.symbol_day COALESCEs them over spread.symbol_day_stats.
   *
   * The lesson is worth more than the symmetry: a group of columns made
   * consistent with each other is not a group of columns made true. Three were
   * added to match five, and all five were empty.
   */
  for (const q of ['p10','p25','p50','p75','p90']) {
    ck('spread_fils_' + q + ' stayed dropped', !name('spread_fils_' + q), q);
  }
  const five = (prefix) => ['p10','p25','p50','p75','p90'].filter((q) => name(prefix + q)).length;
  ck('bid keeps exactly the two the view reads, offer keeps none',
     five('bid_') === 2 && five('offer_') === 0 && five('spread_fils_') === 0,
     { bid: five('bid_'), offer: five('offer_'), spread: five('spread_fils_') });
  ck('primary key columns present', !!name('symbol')&&!!name('trading_date'));
  const {rows:pk}=await db.query(`
    select string_agg(a.attname,',' order by array_position(i.indkey,a.attnum)) k
      from pg_index i join pg_attribute a on a.attrelid=i.indrelid and a.attnum=any(i.indkey)
     where i.indrelid='public.symbol_day'::regclass and i.indisprimary`);
  ck('PK is (symbol, trading_date)', pk[0].k==='symbol,trading_date', pk[0].k);

  // the nine survivors, under their new names
  for(const c of ['open_px','high_px','low_px','close_px','day_range',
                  'total_volume','highest_minute_volume','trades','avg_trade_size'])
    ck('survivor present: '+c, !!name(c));

  /*
   * The SPREAD columns the original audit said were missing — those of them
   * that are still here.
   *
   * 053 dropped spread_fils_p50, net_per_fil, refill_ratio, auction_vs_last_bid
   * and cb_events from this list. Nothing ever wrote them and nothing ever read
   * them: the audit asked for columns, the columns were added, and that was the
   * end of it. Adding a column is not implementing a measurement, and five of
   * the twelve sat here for two months proving it.
   */
  for(const c of ['pct_postable','pct_exitable','bid_p50','moves','up_moves_2plus',
                  'tiny_pct_up','buy_sell_ratio','coverage_pct'])
    ck('SPREAD column present: '+c, !!name(c));

  /*
   * And the eleven unwritten survivors are here BECAUSE spread.symbol_day
   * selects them — five directly, six as the first branch of a COALESCE over
   * spread.symbol_day_stats. If one of these disappears the board's view stops
   * working, so the suite holds them explicitly rather than by a count.
   */
  for(const c of ['markup','resumed','lift','hit','block_ratio','pct_postable',
                  'pct_exitable','exitable_best_hour','bid_p25','bid_p50','vol_ratio_5d'])
    ck('the board\'s view still has its column: '+c, !!name(c), c);

  /*
   * 053's own drops must stay dropped. A column re-added by a later migration
   * "because something wanted it" is how the first 45 arrived.
   */
  for(const c of ['spread_fils_p50','net_per_fil','refill_ratio','auction_vs_last_bid',
                  'cb_events','wall_events','best_hour','ratio_by_hour','tal_price',
                  'series_break','shares_at_budget','last_qty_p50'])
    ck('dropped by 053 and still gone: '+c, !name(c), c);

  // the retired columns must NOT be back
  for(const c of ['fib_signals','fib_win_pct','bull_swings','total_swings',
                  'est_buyer_vol','buyer_pct','best_earning_time'])
    ck('retired column absent: '+c, !name(c), c);

  /*
   * These asserted the TYPES of ratio_by_hour, wall_prices, series_break and
   * best_hour — jsonb, jsonb, boolean, smallint. All four were dropped by 053:
   * nothing ever wrote them and nothing ever read them.
   *
   * Worth keeping the shape of what was here. A jsonb column correctly typed
   * and permanently empty passes a type check forever, and a suite that only
   * asks "is the type right" will never notice. The check that would have
   * caught these is column-has-a-writer, which did.
   */
  for (const c of ['ratio_by_hour','wall_prices','series_break','best_hour'])
    ck('typed-but-never-written column gone: '+c, !name(c), c);

  const {rows:idx}=await db.query(
    "select count(*)::int c from pg_indexes where tablename='symbol_day'");
  ck('indexes created (PK + 2)', idx[0].c>=3, idx[0].c);

  // ── market_day ──
  const md=await cols('market_day');
  ck('market_day exists', md.length>0, md.length);
  // 21 from the DDL + thin_symbols + pct_advancing_ratio (migration 023).
  // +7 from 030: the broker's summary overwrites the computed breadth on the
  // same row rather than living in a second table, and computed_* keep ours so
  // the disagreement stays queryable.
  // +4 from 049: partial_symbols (PARTIAL was invisible to thin_symbols, which
  // counts only 'THIN'), no_prev_close (breadth computed it and the compute
  // deleted it before the write), and the two fingerprint columns that make a
  // market_day row refuse when the symbol_day beneath it has moved.
  ck('34 columns after migration 049', md.length===34, md.length);
  ck('broker_seen_at present — what stops a backfill overwriting the exchange count',
     md.some(c=>c.column_name==='broker_seen_at'));
  ck('computed_* kept so "do we disagree often" is a query, not a grep',
     ['computed_advancing','computed_declining','computed_symbols']
       .every(c=>md.some(x=>x.column_name===c)));
  ck('thin_symbols present — THIN rows count toward breadth but are explainable',
     md.some(c=>c.column_name==='thin_symbols'));
  ck('pct_advancing_ratio stored alongside, for comparison only',
     md.some(c=>c.column_name==='pct_advancing_ratio'));
  ck('symbols_over_3x_pace RENAMED — "pace" means the intraday scan',
     !md.some(c=>c.column_name==='symbols_over_3x_pace')
     && md.some(c=>c.column_name==='symbols_over_3x_daily'));
  ck('pct_advancing present — the gate', md.some(c=>c.column_name==='pct_advancing'));
  ck('median AND mean both kept', md.some(c=>c.column_name==='median_pct_change')
     && md.some(c=>c.column_name==='avg_pct_change'));
  ck('regime present', md.some(c=>c.column_name==='regime'));
  const {rows:mpk}=await db.query(`
    select a.attname k from pg_index i join pg_attribute a
      on a.attrelid=i.indrelid and a.attnum=any(i.indkey)
     where i.indrelid='public.market_day'::regclass and i.indisprimary`);
  ck('market_day PK is trading_date', mpk[0].k==='trading_date', mpk[0].k);

  // ── DDL only: both must be empty ──
  const {rows:e1}=await db.query('select count(*)::int c from symbol_day');
  const {rows:e2}=await db.query('select count(*)::int c from market_day');
  // No longer asserted empty: daily.symbolday populates it. What matters now
  // is that the table is WRITABLE with the shape the job produces, which the
  // metric and job suites cover directly.
  ck('symbol_day exists and is queryable', typeof e1[0].c === 'number', e1[0]);
  ck('market_day exists and is queryable', typeof e2[0].c === 'number', e2[0]);

  // ── the session list matches the spec ──
  const {rows:cs}=await db.query('select closing_sessions() s');
  ck('closing_sessions is the SPEC list',
     cs[0].s.join('|')==='Trading|Close Auction Acceptance|Trading at Last|Close-Of-Day', cs[0].s);
  ck('Pre-Open is NOT in it (my earlier guess)', !cs[0].s.includes('Pre-Open'));

  // ── prev_session(d, n) ──
  await db.query("delete from awsat_market_quotes where symbol='SDPREV'");
  for(const d of ['2026-07-28','2026-07-31','2026-08-03'])
    await db.query(`insert into awsat_market_quotes(market,symbol,last_price,trading_date,
      session,ingest_source,source_precedence,created_at)
      values ('Main Market','SDPREV',100,$1,'Close-Of-Day','awsat_server',1,$2)`,
      [d,new Date(d+'T10:00:00Z')]);
  const {rows:p1}=await db.query("select prev_session(date '2026-08-03') d");
  ck('prev_session(d) skips the July gap',
     new Date(p1[0].d).toISOString().startsWith('2026-07-31'), p1[0].d);
  const {rows:p2}=await db.query("select prev_session(date '2026-08-03', 2) d");
  ck('prev_session(d,2) goes two SESSIONS back, not two days',
     new Date(p2[0].d).toISOString().startsWith('2026-07-28'), p2[0].d);
  await db.query("delete from awsat_market_quotes where symbol='SDPREV'");

  console.log(`\nsymbol_day DDL: ${p}/${n}`);
  await db.close(); process.exit(p===n?0:1);
})().catch(async e=>{console.error('CRASH:',e.message);await db.close();process.exit(1)});

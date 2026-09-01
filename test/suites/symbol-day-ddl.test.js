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
  ck('112 columns after migration 035', sd.length===112, sd.length);
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

  // Every other percentile group has five points; spread had two.
  for (const q of ['p10','p25','p50','p75','p90']) {
    ck('spread_fils_'+q+' present', !!name('spread_fils_'+q));
  }
  const five=(prefix)=>['p10','p25','p50','p75','p90'].filter(q=>name(prefix+q)).length;
  ck('spread now matches bid and offer at five points',
     five('spread_fils_')===5 && five('bid_')===5 && five('offer_')===5,
     {spread:five('spread_fils_'),bid:five('bid_'),offer:five('offer_')});
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

  // the twelve SPREAD columns the audit said were missing
  for(const c of ['pct_postable','pct_exitable','bid_p50','moves','up_moves_2plus',
                  'tiny_pct_up','spread_fils_p50','net_per_fil','refill_ratio',
                  'buy_sell_ratio','auction_vs_last_bid','coverage_pct','cb_events'])
    ck('SPREAD column present: '+c, !!name(c));

  // the retired columns must NOT be back
  for(const c of ['fib_signals','fib_win_pct','bull_swings','total_swings',
                  'est_buyer_vol','buyer_pct','best_earning_time'])
    ck('retired column absent: '+c, !name(c), c);

  ck('jsonb used for the by-hour maps',
     name('ratio_by_hour').data_type==='jsonb'&&name('wall_prices').data_type==='jsonb');
  ck('series_break is boolean', name('series_break').data_type==='boolean');
  ck('best_hour is smallint', name('best_hour').data_type==='smallint');

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
  ck('30 columns after migration 030', md.length===30, md.length);
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

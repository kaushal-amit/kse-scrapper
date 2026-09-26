-- ===========================================================================
--  053_drop_symbol_day_orphans.sql
--
--  FORTY-FIVE COLUMNS THAT NOTHING WRITES AND NOTHING READS.
--
--  symbol_day declared 56 columns computeSymbolDay never writes. 052's suite
--  grouped them and the grouping was WRONG for eleven of them — the correction
--  is the useful part of this migration and is recorded below, because the way
--  it was wrong is the way this will go wrong again.
--
--  ─── WHAT THE FIRST CLASSIFICATION MISSED ─────────────────────────────────
--
--  The scan that produced "nothing reads these" EXCLUDED MIGRATION FILES, on
--  the reasoning that a migration declaring a column is not a reader. True of
--  a declaration; false of a VIEW, and views live in migrations.
--
--  spread.symbol_day — the view the board reads, defined in the backend's
--  migration 054 — selects eleven of the fifty-six:
--
--      p.markup, p.resumed, p.lift, p.hit            directly
--      p.block_ratio                                 directly
--      COALESCE(p.pct_postable,       s.pct_postable)
--      COALESCE(p.pct_exitable,       s.pct_exitable_ratio)
--      COALESCE(p.exitable_best_hour, s.exitable_best_hour_pct)
--      COALESCE(p.bid_p25,            s.bid_kd_p25)
--      COALESCE(p.bid_p50,            s.bid_kd_p50)
--      COALESCE(p.vol_ratio_5d,       s.volume_ratio_5d)
--
--  AND THE COALESCE CHANGES WHAT THEY ARE. They were classified as "dead,
--  already replaced by spread.symbol_day_stats". They are not replaced — they
--  are the PREFERRED source, with the backend's recompute as the fallback.
--  They read NULL today precisely so the fallback fires. A column that is NULL
--  on purpose so that something else is used is the opposite of an orphan.
--
--  Rehearsed on a copy before writing this, in both directions:
--
--      the 9 view-backed  -> ERROR: cannot drop column pct_postable ...
--                            view spread.symbol_day depends on it    REFUSED
--      the 45 below       -> ALTER TABLE                             OK
--
--  ─── WHICH IS WHY THE VIEWS STAY IN PLACE FOR THIS DROP ───────────────────
--
--  No view is dropped or recreated here, and that is deliberate. Postgres
--  refuses to drop a column a view depends on, and names the view when it
--  does. So the database — not the grep that already missed one — is the thing
--  that decides whether these forty-five are truly unread. If this migration
--  fails on deploy, it has just found a reader nobody knew about, and that is
--  the migration working rather than the migration broken.
--
--  ─── WHAT IS KEPT, AND WHY NOT EVERYTHING WENT ────────────────────────────
--
--  Eleven stay. Twenty-four others are NULL BY DESIGN with the reason already
--  in computeSymbolDay's header — the BOOK group because depth covers eight to
--  eighteen symbols of 142, so filling it "would produce a row that is
--  complete for 19 and misleading for 123", and the BUDGET group because those
--  are properties of an account rather than of a stock. Refusals, not
--  oversights, and not dropped.
--
--  The forty-five below are the remainder: names that appear NOWHERE in any of
--  the three repositories outside the migration that declared them, plus five
--  whose names appear only as columns of OTHER tables
--  (spread.symbol_day_stats, spread.symbol_profile). Designed and never built.
--
--  A column with no writer is not an empty column. It looks like a
--  measurement, passes every IS NOT NULL test nobody wrote, and is read by a
--  study as though it meant something. That is why these go rather than stay
--  as "pending".
-- ===========================================================================

ALTER TABLE public.symbol_day
  -- the hourly maps and the session-shape group
  DROP COLUMN IF EXISTS best_hour,
  DROP COLUMN IF EXISTS ratio_by_hour,
  DROP COLUMN IF EXISTS bid_by_hour,
  DROP COLUMN IF EXISTS offer_by_hour,
  DROP COLUMN IF EXISTS largest_gap_secs,
  DROP COLUMN IF EXISTS series_break,
  DROP COLUMN IF EXISTS trades_baseline_20d,
  DROP COLUMN IF EXISTS pct_both_workable,
  -- the book percentiles that were never computed for the pool
  DROP COLUMN IF EXISTS bid_p10,
  DROP COLUMN IF EXISTS bid_p75,
  DROP COLUMN IF EXISTS bid_p90,
  DROP COLUMN IF EXISTS offer_p10,
  DROP COLUMN IF EXISTS offer_p25,
  DROP COLUMN IF EXISTS offer_p50,
  DROP COLUMN IF EXISTS offer_p75,
  DROP COLUMN IF EXISTS offer_p90,
  DROP COLUMN IF EXISTS spread_fils_p10,
  DROP COLUMN IF EXISTS spread_fils_p25,
  DROP COLUMN IF EXISTS spread_fils_p50,
  DROP COLUMN IF EXISTS spread_fils_p75,
  DROP COLUMN IF EXISTS spread_fils_p90,
  DROP COLUMN IF EXISTS bid_age_p50_secs,
  DROP COLUMN IF EXISTS refill_ratio,
  -- the flow counters
  DROP COLUMN IF EXISTS offer_refilled_n,
  DROP COLUMN IF EXISTS offer_rose_n,
  DROP COLUMN IF EXISTS bid_consumed_n,
  DROP COLUMN IF EXISTS bid_withdrawn_n,
  DROP COLUMN IF EXISTS pct_bid_withdrawn,
  DROP COLUMN IF EXISTS wall_events,
  DROP COLUMN IF EXISTS wall_max_qty,
  DROP COLUMN IF EXISTS wall_prices,
  -- the auction and Trading-at-Last group
  DROP COLUMN IF EXISTS auction_price,
  DROP COLUMN IF EXISTS auction_volume,
  DROP COLUMN IF EXISTS auction_vs_last_bid,
  DROP COLUMN IF EXISTS tal_price,
  DROP COLUMN IF EXISTS tal_volume,
  DROP COLUMN IF EXISTS cb_events,
  DROP COLUMN IF EXISTS cb_total_secs,
  -- the budget group: properties of an account, and never filled here
  DROP COLUMN IF EXISTS net_per_fil,
  DROP COLUMN IF EXISTS budget_for_queue_kd,
  -- five whose names exist only as columns of OTHER tables
  -- (spread.symbol_day_stats, spread.symbol_profile), never read from here
  DROP COLUMN IF EXISTS last_qty_p10,
  DROP COLUMN IF EXISTS last_qty_p50,
  DROP COLUMN IF EXISTS last_qty_p90,
  DROP COLUMN IF EXISTS max_budget_kd,
  DROP COLUMN IF EXISTS shares_at_budget;

COMMENT ON TABLE public.symbol_day IS
  '053 · 45 declared-but-never-written columns removed. The 11 that remain '
  'unwritten are selected by spread.symbol_day (the board''s view) — five '
  'directly and six as the FIRST branch of a COALESCE over '
  'spread.symbol_day_stats, so they are the preferred source with the '
  'backend''s recompute as fallback, not dead columns. A further 24 are NULL '
  'by design with the reason in computeSymbolDay''s header: depth covers 8-18 '
  'symbols of 142, and the budget columns are properties of an account.';

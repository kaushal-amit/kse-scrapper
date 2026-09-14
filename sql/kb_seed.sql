-- ============================================================
-- kb_threshold · kb_phrase — DATA, safe to rerun.
--
-- Structure lives in migration 031. This file is one revision of the numbers
-- and can be replaced when a CR moves one, without touching the schema.
--
--     psql <kse> -1 -f sql/kb_seed.sql
--
-- ⚠ NOTHING IN THIS REPO READS public.kb_threshold (F-09, 14 Sep).
--
-- The scraper owns its thresholds in src/config/thresholds.js, by a documented
-- and tested decision: "a capture service must not refuse to boot because a
-- backend table is missing". src/kb/thresholds.js — a loader that read this
-- table — was an orphan with no production caller, and its existence was what
-- failed the policy test in scraper-thresholds.test.js. It has been deleted.
--
-- This file and migration 031's tables are kept because the BACKEND reads
-- public.* across the seam and may depend on them. If it does not, the table
-- and this seed should go together, in one change, with that established
-- first — not dropped on the assumption that "nothing here reads it" means
-- "nothing reads it".
-- ============================================================

INSERT INTO public.kb_threshold (key, value, unit, source_cr, note) VALUES
  ('bid_age_real_minutes',      30,      'minutes', 'CR-50', 'a level held this long is real support'),
  ('bid_age_bait_minutes',       5,      'minutes', 'CR-50', 'under this and large, it is bait'),
  ('bid_bait_min_qty',      100000,      'shares',  'CR-50', null),
  ('my_pct_min',                 5,      'percent', 'CR-48', 'below this you are invisible in the queue'),
  ('my_pct_max',                30,      'percent', 'CR-48', 'above this you ARE the level'),
  ('tick_min_price',           100,      'fils',    'CR-48', 'below 100 fils the tick is 0.1'),
  ('tiny_pct_max',              20,      'percent', 'CR-40', 'up-move tiny prints'),
  ('exit_depth_max_x',           3,      'x',       'CR-54', 'offer_qty as a multiple of your size'),
  ('no_protection_qty',      20000,      'shares',  'CR-37', 'touch bid below this = no protection'),
  ('snapshots_min',            100,      'count',   'chk',   'under this, no direction can be stated'),
  ('volume_vs_yesterday',       50,      'percent', 'CR-49', 'percent of the same hour yesterday'),
  ('ceiling_presence_pct',      75,      'percent', 'CR-51', 'present this share of the session'),
  ('parked_max_changes',         2,      'count',   'CR-50', null),
  ('frozen_min_qty',        100000,      'shares',  'CR-68', 'both sides above this with zero volume'),
  ('moves_min',                 15,      'count',   'CR-39', null),
  ('up2_min',                    3,      'count',   'CR-39', null),
  ('min_position_kd',          333,      'KD',      'derived', '0.50 KD minimum / 0.15% — below this the flat fee bites'),
  ('max_price_fils',           333,      'fils',    'derived', 'above this one fil never clears commission at any size'),
  ('reserve_pct',               25,      'percent', 'CR-39', 'held back until 11:00'),
  ('reserve_release_hhmm',    1100,      'hhmm',    'CR-39', null),
  ('commission_rate',       0.0015,      'rate',    'schedule', 'changes 1 October'),
  ('commission_min_kd',        0.5,      'KD',      'schedule', 'changes 1 October'),

  -- ── previously hardcoded in src/signals.js as env vars ──
  --
  -- Same problem as frozen_min_qty: a threshold nobody can change without a
  -- deploy. The values are unchanged, so the 32 signal tests still hold.
  ('sig_no_protection_bid',  20000,      'shares',  'CR-37', 'NO PROTECTION: touch bid below this'),
  ('sig_buyers_ratio',         1.6,      'ratio',   'CR-41', 'BUYERS 8:5 fires at or above this WITH price rising'),
  ('sig_big_qty',           100000,      'shares',  'CR-68', 'FROZEN: both sides above this'),
  ('sig_bait_max_age_secs',    300,      'seconds', 'CR-50', 'BAIT BID: large and younger than this'),
  ('sig_tiny_trade_shares',    100,      'shares',  'CR-40', 'a print at or below this is tiny'),
  ('sig_wall_qty',          200000,      'shares',  'CR-51', 'size at a level worth calling a wall'),
  ('wakeup_pace_min',            3,      'x',       'CR-46', 'trades today over the median for this hour'),
  ('wakeup_trades_min',         20,      'count',   'CR-46', 'below this the pace ratio is noise')
ON CONFLICT (key) DO UPDATE SET
  -- Rerunning must record what a value WAS, or a threshold that moved cannot
  -- be argued about afterwards.
  prev_value = CASE WHEN public.kb_threshold.value IS DISTINCT FROM EXCLUDED.value
                    THEN public.kb_threshold.value ELSE public.kb_threshold.prev_value END,
  changed_on = CASE WHEN public.kb_threshold.value IS DISTINCT FROM EXCLUDED.value
                    THEN current_date ELSE public.kb_threshold.changed_on END,
  changed_by = CASE WHEN public.kb_threshold.value IS DISTINCT FROM EXCLUDED.value
                    THEN 'kb_seed.sql' ELSE public.kb_threshold.changed_by END,
  value = EXCLUDED.value, unit = EXCLUDED.unit,
  source_cr = EXCLUDED.source_cr, note = EXCLUDED.note;

-- ── kb_phrase ──
INSERT INTO public.kb_phrase (event, text) VALUES
  ('AGED',      'held {n}m'),
  ('BAIT',      '{n}m old'),
  ('THIN',      'thin — clears fast'),
  ('PARKED',    'parked, {n} changes'),
  ('CEILING',   'ceiling · {n}% of session'),
  ('UNDERCUT',  'undercut — seller below {n}'),
  ('PLACED',    '+{n}, nothing traded'),
  ('PULLED',    '−{n} withdrawn'),
  ('RELOCATED', '{n} moved from {p}'),
  ('SHELF',     'round number — stops sit here'),
  ('NOPROT',    '{n} — nothing beneath'),
  ('CATCH',     'catch bid — price chosen')
ON CONFLICT (event) DO UPDATE SET text = EXCLUDED.text;

SELECT 'thresholds: ' || count(*) FROM public.kb_threshold
UNION ALL SELECT 'phrases: ' || count(*) FROM public.kb_phrase;

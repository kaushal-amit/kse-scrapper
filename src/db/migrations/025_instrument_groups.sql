-- ===========================================================================
--  025_instrument_groups.sql — ownership-group STRUCTURE
--
--  ─── WHY THE MAPPING ITSELF IS NOT HERE ────────────────────────────────────
--  These columns and this table are permanent. The 74 UPDATEs that fill them
--  are one revision of an unverified social post, and correcting a wrong group
--  assignment should not require writing a second migration to undo the first.
--
--  So: structure in the chain, data in sql/groups_mapping.sql. That file is
--  safe to rerun — with the ALTERs gone it is UPDATEs and ON CONFLICT DO
--  NOTHING inserts — which is the point. When a real source arrives, rerun it.
-- ===========================================================================

ALTER TABLE public.instruments
  ADD COLUMN IF NOT EXISTS owner_group     text,
  ADD COLUMN IF NOT EXISTS owner_group_ar  text,
  ADD COLUMN IF NOT EXISTS group_source    text,
  ADD COLUMN IF NOT EXISTS group_checked   date;

CREATE INDEX IF NOT EXISTS idx_instruments_group
  ON public.instruments (owner_group);

COMMENT ON COLUMN public.instruments.group_source IS
  'Where the assignment came from. Currently social_post_unverified — the '
  'column exists so a later, better source is distinguishable from this one '
  'rather than silently overwriting it.';

-- ---------------------------------------------------------------------------
-- Stakes are a SEPARATE RELATION, not another column.
--
-- Four symbols are held by one group while belonging to another: ATC is a
-- GHANEM member and a KIPCO stake, BOURSA a KHARAFI member and a BADR stake.
-- A single owner_group column cannot express that, and forcing it to would
-- make one of the two facts disappear.
--
-- Created EMPTY. The ten rows are the same unverified source as the UPDATEs,
-- so they live with them and change with them.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.instrument_stake (
  owner_group  text NOT NULL,
  symbol       text NOT NULL,
  source       text,
  checked_on   date,
  PRIMARY KEY (owner_group, symbol)
);

COMMENT ON TABLE public.instrument_stake IS
  'A group holding a stake in a symbol that belongs to another group. Empty '
  'until sql/groups_mapping.sql is run.';

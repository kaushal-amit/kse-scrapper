-- ============================================================
-- DATA ONLY. The columns and instrument_stake are created by
-- migration 025 — run that first:
--
--     node src/db/migrate.js --to=<the kse database>
--     psql <kse> -1 -f sql/groups_mapping.sql
--
-- -1 wraps it in a transaction, so the duplicate check below
-- rolls the whole file back rather than leaving it half applied.
--
-- SAFE TO RERUN. With the ALTERs gone this is UPDATEs and
-- ON CONFLICT DO NOTHING inserts, so re-running it when a better
-- source arrives replaces the mapping without touching structure.
-- ============================================================
-- Ownership groups · corrected mapping · 26 Aug 2026
-- Source: social post, unverified. Tickers verified against
-- Boursa Kuwait's official list.
-- ============================================================

-- ============ DUPLICATE CHECK · RUNS FIRST, ABORTS ============
--
-- The UPDATEs below run in sequence, so a symbol appearing in two member lists
-- silently lands in whichever ran LAST. The verify query at the bottom would
-- still report 19 groups and 60 symbols either way — a count that passes
-- whether or not the data is right is not a check.
--
-- This raises before anything is written, so the whole file rolls back.
DO $dupcheck$
DECLARE
  dupes text;
BEGIN
  SELECT string_agg(symbol || ' (' || n || ' groups)', ', ' ORDER BY symbol)
    INTO dupes
    FROM (
      SELECT symbol, count(*) AS n FROM (
        VALUES
          ('NINV'),('CABLE'),('BOURSA'),('ARKAN'),('ALOLA'),('SENERGY'),
          ('ALSAFAT'),('SHIP'),('OSOUL'),('OSOS'),('SHUAIBA'),('ZAIN'),
          ('IFA'),('IFAHR'),('KRE'),('SANAM'),('ALDEERA'),('FTI'),
          ('ALG'),('AAYANRE'),('AAYAN'),('MUBARRAD'),('MASHAER'),('ATC'),
          ('KFH'),('MUNSHAAT'),('SOKOUK'),('ALENMA'),
          ('NRE'),('MRC'),('BOUBYAN'),('KINV'),('BAYANINV'),
          ('NIND'),('NOOR'),('PHC'),('KCEM'),
          ('ALMANAR'),('INJAZZAT'),('AQAR'),('AMAR'),('EQUIPMENT'),
          ('JAZEERA'),('TROLLEY'),('SECH'),('RASIYAT'),('NCCI'),
          ('KIB'),('ARABREC'),('WINSRE'),
          ('KPROJ'),('BURG'),('KAMCO'),('URC'),
          ('SPEC'),('NIH'),
          ('THURAYA'),('MADAR'),('KFIC'),
          ('TAHSSILAT'),('MANAZEL'),
          ('MUNTAZAHAT'),('TAMINV'),('KCIN'),
          ('CLEANING'),
          ('BPCC'),('ALKOUT'),
          ('AREEC'),('TIJARA'),
          ('MIDAN'),('OULAFUEL'),('KBT'),
          ('MEZZAN'),('COAST')
      ) AS m(symbol)
      GROUP BY symbol HAVING count(*) > 1
    ) d;

  IF dupes IS NOT NULL THEN
    RAISE EXCEPTION
      'A symbol appears in more than one member list: %. The UPDATEs run in '
      'sequence, so the last one would win silently. Fix the lists first.', dupes;
  END IF;
END
$dupcheck$;

-- ============ MEMBERS ============

UPDATE public.instruments SET owner_group='KHARAFI', owner_group_ar='الخرافي'
 WHERE symbol IN ('NINV','CABLE','BOURSA','ARKAN','ALOLA','SENERGY',
                  'ALSAFAT','SHIP','OSOUL','OSOS','SHUAIBA','ZAIN');

UPDATE public.instruments SET owner_group='BADR', owner_group_ar='البدر'
 WHERE symbol IN ('IFA','IFAHR','KRE','SANAM','ALDEERA','FTI');

UPDATE public.instruments SET owner_group='GHANEM', owner_group_ar='الغانم'
 WHERE symbol IN ('ALG','AAYANRE','AAYAN','MUBARRAD','MASHAER','ATC');

UPDATE public.instruments SET owner_group='KFH', owner_group_ar='بيتك'
 WHERE symbol IN ('KFH','MUNSHAAT','SOKOUK','ALENMA');

UPDATE public.instruments SET owner_group='SULTAN', owner_group_ar='السلطان'
 WHERE symbol IN ('NRE','MRC','BOUBYAN','KINV','BAYANINV');

UPDATE public.instruments SET owner_group='INDUSTRIES', owner_group_ar='الصناعات'
 WHERE symbol IN ('NIND','NOOR','PHC','KCEM');

UPDATE public.instruments SET owner_group='NASSAR', owner_group_ar='الريبو والنصار'
 WHERE symbol IN ('ALMANAR','INJAZZAT','AQAR','AMAR','EQUIPMENT');

UPDATE public.instruments SET owner_group='BOODAI', owner_group_ar='بودي'
 WHERE symbol IN ('JAZEERA','TROLLEY','SECH','RASIYAT','NCCI');

UPDATE public.instruments SET owner_group='BUKHAMSEEN', owner_group_ar='بوخمسين'
 WHERE symbol IN ('KIB','ARABREC','WINSRE');

UPDATE public.instruments SET owner_group='KIPCO', owner_group_ar='المشاريع'
 WHERE symbol IN ('KPROJ','BURG','KAMCO','URC');

UPDATE public.instruments SET owner_group='KHUSUSIYA', owner_group_ar='الخصوصية'
 WHERE symbol IN ('SPEC','NIH');

UPDATE public.instruments SET owner_group='ZAKHEER', owner_group_ar='الذكير'
 WHERE symbol IN ('THURAYA','MADAR','KFIC');

UPDATE public.instruments SET owner_group='DAR', owner_group_ar='الدار'
 WHERE symbol IN ('TAHSSILAT','MANAZEL');

UPDATE public.instruments SET owner_group='SARZON', owner_group_ar='السرزون'
 WHERE symbol IN ('MUNTAZAHAT','TAMINV','KCIN');

UPDATE public.instruments SET owner_group='DASHTI', owner_group_ar='دشتي'
 WHERE symbol IN ('CLEANING');

UPDATE public.instruments SET owner_group='BOUBYAN_P', owner_group_ar='بوبيان ب'
 WHERE symbol IN ('BPCC','ALKOUT');

UPDATE public.instruments SET owner_group='AJIAL', owner_group_ar='أجيال'
 WHERE symbol IN ('AREEC','TIJARA');

UPDATE public.instruments SET owner_group='HAIDAR', owner_group_ar='محمود حيدر'
 WHERE symbol IN ('MIDAN','OULAFUEL','KBT');

UPDATE public.instruments SET owner_group='WAZZAN', owner_group_ar='الوزان'
 WHERE symbol IN ('MEZZAN','COAST');

UPDATE public.instruments
   SET group_source  = 'social_post_unverified',
       group_checked = '2026-08-26'
 WHERE owner_group IS NOT NULL;

-- ============ STAKES · ويمتلكون حصة بـ ============

INSERT INTO public.instrument_stake (owner_group, symbol, source, checked_on) VALUES
  ('KHARAFI',    'ACICO',     'social_post_unverified', '2026-08-26'),
  ('KHARAFI',    'KFOUC',     'social_post_unverified', '2026-08-26'),
  ('BADR',       'BOURSA',    'social_post_unverified', '2026-08-26'),
  ('BADR',       'GFH',       'social_post_unverified', '2026-08-26'),
  ('BADR',       'ALTIJARIA', 'social_post_unverified', '2026-08-26'),
  ('BADR',       'ACICO',     'social_post_unverified', '2026-08-26'),
  ('INDUSTRIES', 'NICBM',     'social_post_unverified', '2026-08-26'),
  ('KIPCO',      'NAPESCO',   'social_post_unverified', '2026-08-26'),
  ('KIPCO',      'JTC',       'social_post_unverified', '2026-08-26'),
  ('KIPCO',      'ATC',       'social_post_unverified', '2026-08-26')
ON CONFLICT DO NOTHING;

-- ============ VERIFY ============

SELECT owner_group, owner_group_ar, count(*) AS n,
       string_agg(symbol, ' ' ORDER BY symbol) AS members
  FROM public.instruments
 WHERE owner_group IS NOT NULL
 GROUP BY 1,2 ORDER BY 3 DESC;
-- expect 19 groups, 60 symbols

SELECT owner_group, string_agg(symbol, ' ' ORDER BY symbol) AS stakes
  FROM public.instrument_stake GROUP BY 1 ORDER BY 1;
-- expect 4 groups, 10 rows

-- ===========================================================================
--  051_close_of_day_exemption.sql
--
--  THE DOOR SHUTS AT 13:20. THE CLOSING PRINT DOES NOT ALWAYS ARRIVE FIRST.
--
--  ─── THE RATIONALE 048 CARRIED IS DISPROVED ───────────────────────────────
--
--  048 says, above the code: "Close-Of-Day starts at 13:15, so by 13:20 the
--  final print is in, and everything after it is a tab somebody left open."
--  That sentence was the whole justification for the 13:20 literal, and it is
--  wrong. Measured on `kse`, first Close-Of-Day row per day:
--
--    23 Sep   13:15:01     captured continuously through the transition
--    13 Aug   13:25:42     15.4-minute capture gap before it
--    24 Sep   14:43:35     91.8-minute capture gap before it
--
--  It is left here in full rather than deleted, because a rationale that was
--  believed and then disproved is more useful than a clean file: without it
--  somebody re-derives the same door in three months.
--
--  AND THE TWO LATE TIMES ARE NOT PUBLICATION TIMES. Both sit on the far side
--  of a gap in OUR capture. 24 September's last row before the gap is 13:11:48
--  `Trading at Last`; the next is 14:43:35 `Close-Of-Day`. The venue published
--  somewhere inside those 92 minutes and we were not looking. 14:43 is our
--  LOOKING time.
--
--  So a fixed clock cannot work. Any number picked from those three samples is
--  wrong on two of them, and the one day we watched continuously published
--  BEFORE the door — on that day the door does not bite at all. The door is
--  right about everything except the one row that ends the session.
--
--  ─── THE EXEMPTION ────────────────────────────────────────────────────────
--
--  The FIRST Close-Of-Day row per symbol per day is admitted whenever it
--  arrives, up to a backstop. Everything else at or after 13:20 stays refused,
--  exactly as before — on 24 September the client was still saving at 16:22,
--  and 17,640 of those rows are a tab nobody closed.
--
--  "Whenever it arrives" is unbounded, so it is bounded: a stuck page
--  delivering a stale board at 22:00 must not be accepted as a close. The
--  backstop is set from the one OBSERVED publication time — 13:15 — and not
--  from 14:43, which is an artefact; picking a number from an artefact is
--  picking another 13:20 with worse evidence. It is deliberately loose, at
--  15:00, because the cost of the two errors is not symmetric: a genuine late
--  publication refused is a day with no close at all, while a stale board
--  accepted is visible as cod_late and alarmed.
--
--  ─── cod_late · THE ARRIVAL TIME IS OURS, NOT THE VENUE'S ─────────────────
--
--  A row admitted by this exemption is marked. Its created_at says when WE saw
--  it, and on a gap day that is not when the venue published — the same
--  distinction halt_capture_gap_max_secs already draws for a resume seen after
--  a stall. Unmarked, a later study reads 14:43 as a venue fact, which is
--  exactly what happened in the 25 September brief.
--
--  ─── AND IT DOES NOT LENGTHEN THE DAY ─────────────────────────────────────
--
--  050 made symbol_day's numerator and denominator both the continuous session
--  (09:00-13:00), so an ingested 14:43 row cannot count as capture length.
--  Ingest door and measurement window are separate on purpose, and that
--  separation is what makes this exemption safe rather than a way to put
--  24 September back at 343 minutes.
--
--  ─── A NOTE FOR WHOEVER DEPLOYS THIS ──────────────────────────────────────
--
--  This view gains a column, and `spread.v_quote` / `spread.v_quote_screening`
--  are defined as `SELECT * FROM public.quotes_clean`. Postgres expands `*` at
--  CREATE time: rehearsed on a copy, adding a trailing column here succeeded
--  and left both those views at their old 22 columns, silently. They must be
--  dropped and recreated — from their COMMITTED definitions, never from
--  pg_get_viewdef on production — for cod_late to be visible to the backend.
--  Rehearsed ordering: drop the two spread views, drop this one, recreate all
--  three. No CASCADE is needed, the plain DROP names its dependants, and the
--  whole sequence is transactional, so BEGIN/ROLLBACK is a free rehearsal.
-- ===========================================================================

CREATE OR REPLACE VIEW public.quotes_clean AS
WITH admitted AS (
  SELECT q.*,
         (q.created_at AT TIME ZONE 'Asia/Kuwait')::time AS at_kw_time,
         /*
          * The first Close-Of-Day capture for this symbol on this day. Rank,
          * not min(created_at), so a symbol whose close is captured 200 times
          * between 14:43 and 17:16 contributes exactly one row.
          *
          * The predicate is IN THE PARTITION, not wrapped around the window.
          * `CASE WHEN session='Close-Of-Day' THEN row_number() OVER (PARTITION
          * BY trading_date, symbol ...) END` ranks over EVERY row and then
          * hides the ones that are not closes: 24 September's first closing
          * print came back rank 3, behind the 09:00 quote and the 13:11
          * Trading at Last, and was refused. Partitioning on the predicate
          * ranks the closes among themselves. Caught by the fixture below,
          * which is why it is there.
          */
         row_number() OVER (PARTITION BY q.trading_date, q.symbol,
                                         (q.session = 'Close-Of-Day')
                                ORDER BY q.created_at) AS cod_rank
    FROM awsat_market_quotes q
)
SELECT id,
       trading_date,
       (created_at AT TIME ZONE 'Asia/Kuwait') AS at_kw,
       market,
       symbol,
       session,
       NULLIF(last_price, 0::numeric)                                   AS last_price,
       NULLIF(last_qty, 0)                                              AS last_qty,
       CASE WHEN last_price > 0::numeric THEN chg     ELSE NULL::numeric END AS chg,
       CASE WHEN last_price > 0::numeric THEN pct_chg ELSE NULL::numeric END AS pct_chg,
       NULLIF(open_price, 0::numeric)                                   AS open_price,
       NULLIF(high_price, 0::numeric)                                   AS high_price,
       NULLIF(low_price, 0::numeric)                                    AS low_price,
       NULLIF(bid, 0::numeric)                                          AS bid,
       CASE WHEN bid   > 0::numeric THEN bid_qty   ELSE NULL::bigint END AS bid_qty,
       NULLIF(offer, 0::numeric)                                        AS offer,
       CASE WHEN offer > 0::numeric THEN offer_qty ELSE NULL::bigint END AS offer_qty,
       volume,
       trades,
       nms,
       ingest_source,
       created_at,
       -- Admitted by the Close-Of-Day exemption rather than by the door. On a
       -- day with a capture gap this row's time is when WE looked, not when the
       -- venue published: do not read it as a venue timestamp.
       (at_kw_time >= '13:20:00'::time) AS cod_late
  FROM admitted q
 -- `session <> ''` is NULL-unsafe on purpose: a NULL session makes the
 -- predicate NULL and the row is excluded, which is exactly what the 20
 -- September rows need. Spelled out here so nobody "fixes" it into
 -- COALESCE(session,'') <> '' and lets them back in.
 WHERE session <> ''::text
   AND (EXTRACT(isodow FROM trading_date) <> ALL (ARRAY[5::numeric, 6::numeric]))
   AND NOT EXISTS (SELECT 1 FROM public.market_holiday h
                    WHERE h.holiday_date = q.trading_date)
   AND at_kw_time >= '08:40:00'::time
   AND (
         at_kw_time < '13:20:00'::time
      OR (
           -- THE EXEMPTION: the first Close-Of-Day row for this symbol today,
           -- arriving before the backstop. Nothing else crosses the door.
           q.session = 'Close-Of-Day'
           AND q.cod_rank = 1
           AND at_kw_time < '15:00:00'::time
         )
       );

COMMENT ON VIEW public.quotes_clean IS
  'Quotes with the capture traps removed: no blank/absent session label (the 20 Sep '
  'rows that carried 17 Sep''s totals), nothing before 08:40, nothing at or after '
  '13:20 EXCEPT the first Close-Of-Day row per symbol per day (051 — the venue '
  'published at 13:15 on the one day we watched continuously and at 14:43 on a day '
  'we did not, so a fixed clock cannot work), no Friday/Saturday/holiday, and zeros '
  'as NULL because 0 means "not measured", never "measured zero". cod_late marks a '
  'row admitted by that exemption: its time is when WE saw it, not when the venue '
  'published. at_kw is Kuwait local. Session TYPE is not filtered here — '
  'spread.v_quote_screening decides which sessions are tradeable.';

COMMENT ON COLUMN public.quotes_clean.cod_late IS
  '051 · true when this row crossed the 13:20 door under the Close-Of-Day '
  'exemption. On a day with a capture gap its created_at is our LOOKING time, '
  'not the venue''s publication time — 24 September''s 14:43 print sits on the '
  'far side of a 92-minute gap. Never read a cod_late timestamp as a venue fact.';

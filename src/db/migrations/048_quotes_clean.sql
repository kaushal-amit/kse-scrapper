-- ===========================================================================
--  048_quotes_clean.sql — public.quotes_clean, in version control.
--
--  Amit built this view by hand on `kse` on 24 September 2026. It existed on
--  exactly one host and in no repository, so a second host, a restored dump or
--  a test database did not have it — and the backend is about to read its
--  quotes through it. A view the code depends on and the schema does not carry
--  is a deploy that works once.
--
--  ─── WHAT IT REMOVES, AND WHY EACH ONE IS A TRAP ─────────────────────────
--
--  A BLANK OR ABSENT SESSION LABEL. On 20 September 1,022 rows arrived with no
--  session at all, in the 07:52-07:57 window, carrying 17 SEPTEMBER's
--  cumulative trades and volume — the terminal was serving Thursday's figures
--  after the outage and the capture stored them faithfully. 79 of 140 symbols
--  still have identical day totals for the two dates. An unlabelled row is a
--  row the terminal could not say anything about, and it must not reach a
--  high, a low, a close or a gate.
--
--  BEFORE 08:40 AND AT OR AFTER 13:20. The pre-open book before 08:40 is not
--  the auction anyone studies, and Close-Of-Day starts at 13:15 — by 13:20 the
--  final print is in, and everything after it is a tab somebody left open. On
--  24 September the client was still saving at 16:22.
--
--  FRIDAY, SATURDAY AND HOLIDAYS. Boursa Kuwait is shut. A row stamped with a
--  closed date is a capture defect, and one such row used to open that day for
--  ever in the calendar.
--
--  The holiday source is public.market_holiday (migration 040), this service's
--  own. The hand-built version read spread.trading_day, which makes public.*
--  depend on the backend's schema and fails on a host that has only this one.
--
--  ZEROS THAT ARE NOT MEASUREMENTS. A last price of 0 means "no trade yet",
--  not "it traded at zero"; a bid of 0 means there is no bid. They become
--  NULL, so a reader that averages them cannot quietly average in a zero — the
--  distinction this whole system is built on, applied at the source. `chg` and
--  `pct_chg` follow the last price: a change computed from a price that does
--  not exist is not a change.
--
--  ─── WHAT IT DOES NOT DO ─────────────────────────────────────────────────
--  It does not filter by SESSION TYPE. Trading, the auctions and Close-Of-Day
--  all come through, because "which sessions are tradeable" is a different
--  question from "is this row real" and the two belong to different readers.
--  spread.v_quote_screening answers the first one.
--
--  `at_kw` is Kuwait local time, precomputed, because every reader was
--  deriving it and a clock derived in eleven places is eleven chances to
--  derive it differently.
-- ===========================================================================

CREATE OR REPLACE VIEW public.quotes_clean AS
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
       created_at
  FROM awsat_market_quotes q
 -- `session <> ''` is NULL-unsafe on purpose: a NULL session makes the
 -- predicate NULL and the row is excluded, which is exactly what the 20
 -- September rows need. Spelled out here so nobody "fixes" it into
 -- COALESCE(session,'') <> '' and lets them back in.
 WHERE session <> ''::text
   AND (EXTRACT(isodow FROM trading_date) <> ALL (ARRAY[5::numeric, 6::numeric]))
   -- The holiday source is the SCRAPER's own (migration 040), not
   -- spread.trading_day. The hand-built view on `kse` read the backend's
   -- table, which makes public.* depend on spread.* and breaks on any host
   -- that has only the scraper's schema — the scraper's test database among
   -- them. public.* is this service's, and it answers its own questions.
   AND NOT EXISTS (SELECT 1 FROM public.market_holiday h
                    WHERE h.holiday_date = q.trading_date)
   AND (created_at AT TIME ZONE 'Asia/Kuwait')::time >= '08:40:00'::time
   AND (created_at AT TIME ZONE 'Asia/Kuwait')::time <  '13:20:00'::time;

COMMENT ON VIEW public.quotes_clean IS
  'Quotes with the capture traps removed: no blank/absent session label (the 20 Sep rows that '
  'carried 17 Sep''s totals), nothing before 08:40 or at/after 13:20 (Close-Of-Day starts 13:15, '
  'so the final print is in), no Friday/Saturday/holiday, and zeros as NULL because 0 means "not '
  'measured", never "measured zero". at_kw is Kuwait local. Session TYPE is not filtered here — '
  'spread.v_quote_screening decides which sessions are tradeable. Read quotes through this view.';

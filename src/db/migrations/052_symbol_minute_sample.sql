-- ===========================================================================
--  052_symbol_minute_sample.sql
--
--  NOT `bars_1m`. THE NAME IS A CLAIM.
--
--  `bars_1m` promises open, high, low and close. There is no intra-minute
--  variation for those to describe: measured over all 1,456,376 symbol-minutes
--  of `session = 'Trading'`, quote capture yields
--
--      Jul  347,204 symbol-minutes   1.00 samples/min   0.0% with 2+
--      Aug  545,664                  1.02               2.3%
--      Sep  563,508                  1.00               0.0%
--
--  and the median gap between consecutive captures is 60 SECONDS in every
--  month (Jul 0 gaps near 30s, Sep 0, Aug 11,932 on four days only). A row
--  here is ONE OBSERVATION OF A CUMULATIVE BOARD, not an aggregate of trades.
--
--  Repeating that single sample into four OHLC fields would be the
--  plausible-but-wrong form at its purest: it passes every structural check
--  and is false, and anything downstream that sees "bar" applies bar logic —
--  range, body, wick — to a number with none. Worse, `high_price` and
--  `low_price` on a quote row are the DAY'S running extremes from the
--  terminal, so they would look like real OHLC values while being the day's
--  numbers repeated on every minute of it.
--
--  ─── QUOTES HAVE NEVER BEEN FASTER THAN 60 SECONDS ────────────────────────
--
--  Worth stating plainly because studies keep being designed as though the
--  resolution were finer: the 30-second cadence belongs to the DEPTH scraper,
--  which still runs at 30s today (median gap 30s in August and September,
--  1,027,474 of 1,107,299 September intervals). Quote capture has run at 60
--  seconds throughout. THAT BOUNDS EVERY INTRADAY MEASUREMENT IN THIS SYSTEM.
--
--  Which is why `samples_in_minute` is on the row from the first day rather
--  than inferred from a date: August already reached 3 on four days, and if a
--  future setting gives three samples a minute, that row says three. Same
--  reason data_quality needed quality_rule_version — when the cadence changes
--  the meaning of a row changes, and nothing should have to work that out.
--
--  ─── THERE IS NO EXCHANGE TRADE TIME, AND SAYING SO IS A COLUMN ───────────
--
--  awsat_market_quotes.last_trade_time and last_trade_date are the exchange's
--  own stamp. Both collapsed at the awsat_server -> awsat_client cutover:
--
--      26 Aug   awsat_server   27,608 rows   27,608 with last_trade_time
--      30 Aug   awsat_client   35,840 rows        0
--
--  and have been empty on every row since — 737,218 September rows, not one.
--  So this table cannot carry a trade time today.
--
--  A nullable `trade_time` added later would mean "not captured" on old rows
--  and "no trade" on new ones, with nothing telling them apart — the same
--  two-generations problem that forced quality_rule_version. The
--  discriminator therefore goes in NOW:
--
--      observed_at           our capture time. Always present.
--      time_basis            CAPTURE or EXCHANGE — what the row's
--                            authoritative time actually IS. NOT NULL with NO
--                            DEFAULT, so a writer that has not thought about
--                            it fails instead of quietly getting CAPTURE.
--      exchange_trade_time   NULL unless time_basis = 'EXCHANGE'.
--
--  When the feed returns, new rows say EXCHANGE and old rows still say
--  CAPTURE. No backfill, no inference from a date.
--
--  ─── EVERY SPAN IS NAMED, BECAUSE A HIDDEN DENOMINATOR IS THE BUG OF THE
--      WEEK ────────────────────────────────────────────────────────────────
--
--  volume_delta and trades_delta are "since the previous sample". That is a
--  per-minute delta ONLY when the previous sample was a minute earlier. Across
--  a capture gap it silently becomes a multi-minute delta wearing a
--  one-minute name — the same invisible-denominator shape as coverage_pct
--  dividing by its own median. So delta_span_seconds is NOT NULL and travels
--  with them.
--
--  THE SESSION'S FIRST SAMPLE CARRIES DELTA-FROM-ZERO, spanning from the
--  session open to observed_at. Stated rather than left to be discovered:
--  volume is cumulative for the day, so the first sample's volume IS what
--  traded between the open and that capture. The span says so.
--
--  ─── AND THE DEPTH JOIN IS A DECISION, NOT A QUERY DETAIL ─────────────────
--
--  Depth runs at 30s and quotes at 60s, so a minute holds about two depth
--  samples and one quote sample. WHICH depth sample belongs to this row is a
--  choice, and leaving it to whatever query gets written later is how two
--  studies disagree without either being wrong.
--
--  THE RULE: the last depth sample AT OR BEFORE observed_at, within
--  depth_lag_seconds. At-or-before rather than nearest, because a depth sample
--  taken AFTER the quote is information from the future, and lookahead is the
--  error that matters in a trading system. depth_lag_seconds records how far
--  back it reached, so a stale book is visible rather than assumed fresh, and
--  depth_samples_in_minute records how many were available to choose from.
--
--  ─── DEVIATION FROM THE BRIEF, RECORDED HERE ON PURPOSE ───────────────────
--
--  The data-tables brief says this table builds from awsat_market_quotes
--  directly. IT READS public.quotes_clean INSTEAD. That view is what refuses
--  the 20 September rows — 1,022 captures at 07:52-07:57 carrying 17
--  SEPTEMBER's cumulative totals, of which 79 of 140 symbols still show
--  identical day totals for the two dates — plus blank session labels,
--  Friday/Saturday/holiday rows, and zeros that mean "not measured". Building
--  a derived table on the raw table would re-admit every one of them.
--
--  Recorded here rather than left to be discovered later, because a deviation
--  nobody wrote down reads as a mistake the next time someone compares the
--  table to the brief.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.symbol_minute_sample (
  symbol                 text        NOT NULL,
  trading_date           date        NOT NULL,
  -- The minute bucket, from market/clock.minuteBucket — the ONE clock. Never a
  -- local truncation of observed_at at the call site: a clock derived in
  -- eleven places is eleven chances to derive it differently, which is why
  -- quotes_clean precomputes at_kw.
  minute                 timestamptz NOT NULL,
  -- Kuwait local, GENERATED from `minute` so the two cannot drift.
  minute_kw              timestamp GENERATED ALWAYS AS
                           ((minute AT TIME ZONE 'Asia/Kuwait')) STORED,

  -- ── time, and what it means ──
  observed_at            timestamptz NOT NULL,
  time_basis             text        NOT NULL
                           CHECK (time_basis IN ('CAPTURE', 'EXCHANGE')),
  exchange_trade_time    time,

  -- ── how much of a minute this row actually is ──
  samples_in_minute      integer     NOT NULL CHECK (samples_in_minute > 0),

  -- ── the board, AS AT observed_at ──
  last_price             numeric,
  bid                    numeric,
  bid_qty                bigint,
  offer                  numeric,
  offer_qty              bigint,
  session                text        NOT NULL,

  -- ── what happened since the previous sample, and over how long ──
  volume_delta           bigint,
  trades_delta           integer,
  delta_span_seconds     integer     NOT NULL CHECK (delta_span_seconds > 0),
  is_session_first       boolean     NOT NULL DEFAULT false,

  -- ── the book, joined by the rule in the header ──
  depth_samples_in_minute integer,
  depth_lag_seconds       integer,
  depth_bid_levels        integer,
  depth_offer_levels      integer,
  depth_bid_shares_5      bigint,
  depth_offer_shares_5    bigint,

  -- ── the input fingerprint, not a build version ──
  source_max_created_at  timestamptz NOT NULL,
  source_rows            integer     NOT NULL,
  computed_at            timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (symbol, trading_date, minute),

  -- A trade time may exist ONLY when the row says its basis is the exchange's.
  CONSTRAINT sms_exchange_time_matches_basis CHECK (
    (time_basis = 'EXCHANGE') OR (exchange_trade_time IS NULL)
  ),
  /*
   * THE LAG AND THE COUNT ANSWER DIFFERENT QUESTIONS, AND THE FIRST VERSION OF
   * THIS CONSTRAINT TIED THEM TOGETHER.
   *
   * It required the two to be NULL together, and the job's matching guard threw
   * on the fixture's first two minutes. The data was right and the constraint
   * was wrong: depth_samples_in_minute = 0 is a MEASUREMENT — depth was being
   * captured that day and none of it fell in this minute — while
   * depth_lag_seconds = NULL says there was no earlier book to reach back to.
   * Both true at once, and the pair is exactly what tells them apart:
   *
   *   samples = 0,    lag = NULL   depth ran; nothing in this minute and
   *                                nothing before it
   *   samples = NULL, lag = NULL   NOT COMPUTED — depth did not exist for this
   *                                day at all (before 6 August 2026)
   *   samples = 2,    lag = 5      a book five seconds before the quote
   *
   * So the only real rule is that a lag cannot exist where the depth columns
   * were never computed.
   */
  CONSTRAINT sms_depth_lag_needs_depth CHECK (
    depth_lag_seconds IS NULL OR depth_samples_in_minute IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS symbol_minute_sample_day
  ON public.symbol_minute_sample (trading_date, minute);

COMMENT ON TABLE public.symbol_minute_sample IS
  '052 · ONE OBSERVATION of the board per symbol per minute — NOT a bar. Quote '
  'capture has run at 60 seconds throughout (median gap 60s in every month; the '
  '30s cadence is the DEPTH scraper, still 30s today), so there is no '
  'intra-minute variation for open/high/low/close to describe and those columns '
  'deliberately do not exist. Built from public.quotes_clean, NOT the raw table '
  '— a deviation from the data-tables brief, for the reason in the migration.';

COMMENT ON COLUMN public.symbol_minute_sample.samples_in_minute IS
  '052 · how many captures fell in this minute. 1 today; August reached 3 on '
  'four days. On the row rather than inferred from a date, because when the '
  'cadence changes the meaning of the row changes — the same reason '
  'data_quality needed quality_rule_version.';

COMMENT ON COLUMN public.symbol_minute_sample.time_basis IS
  '052 · CAPTURE (observed_at is ours) or EXCHANGE (exchange_trade_time is the '
  'venue''s). NOT NULL with NO DEFAULT so a writer that has not considered it '
  'fails rather than quietly getting CAPTURE. Every row is CAPTURE today: '
  'last_trade_time and last_trade_date have been empty on every quote since the '
  'awsat_client cutover on 30 August 2026.';

COMMENT ON COLUMN public.symbol_minute_sample.delta_span_seconds IS
  '052 · the seconds volume_delta and trades_delta actually cover. NOT NULL, '
  'because "since the previous sample" is a per-minute delta only when the '
  'previous sample was a minute earlier; across a capture gap it is a '
  'multi-minute delta wearing a one-minute name. The session''s first sample '
  'carries delta-from-zero and spans from the session open.';

COMMENT ON COLUMN public.symbol_minute_sample.depth_lag_seconds IS
  '052 · how far back the depth join reached. The rule is the last depth sample '
  'AT OR BEFORE observed_at — at-or-before rather than nearest, because a depth '
  'sample taken after the quote is information from the future and lookahead is '
  'the error that matters here. NULL with depth_samples_in_minute NULL means NOT '
  'COMPUTED: depth starts 6 August 2026 across 136 symbols, and before that '
  'there is nothing to join, which is not the same as an empty book.';

-- ===========================================================================
--  031_knowledge_base.sql — CR-69, CR-70, CR-71
--
--  Thresholds and rules move out of code and prompts and into the database.
--  Nothing else can be built on a string literal: a number in a source file
--  cannot be changed without a deploy, and a rule in a prompt cannot be
--  scoped, dated, or marked wrong.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1 · kb_threshold — the numbers every gate reads
--
-- Each carries the CR that set it. still_true rather than DELETE: one rule in
-- the knowledge base was built on ten cases and reversed on ninety-nine, and
-- that history is why the surviving ones are worth trusting.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.kb_threshold (
  key         text PRIMARY KEY,
  value       numeric NOT NULL,
  unit        text,
  source_cr   text,
  note        text,
  prev_value  numeric,
  changed_on  date,
  changed_by  text,
  still_true  boolean NOT NULL DEFAULT true
);

COMMENT ON TABLE public.kb_threshold IS
  'Loaded ONCE at boot into a typed object, never read per query. Changing 30 '
  'to 45 must change every check with no code edit.';
COMMENT ON COLUMN public.kb_threshold.prev_value IS
  'What it was before. A threshold that moved without anyone recording the old '
  'value cannot be argued about afterwards.';

-- ---------------------------------------------------------------------------
-- 2 · kb_rule — judgement, assembled into the system prompt
--
-- Scoped because the knowledge base is roughly 9,000 words. Sending all of it
-- on every question costs money and makes answers worse: a rule about auction
-- entry inside a question about a bid is noise.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.kb_rule (
  id            bigserial PRIMARY KEY,
  rule          text NOT NULL,
  scope         text NOT NULL CHECK (scope IN ('GLOBAL', 'STOCK', 'SITUATIONAL')),
  symbol        text,
  trigger_state text,
  source_cr     text,
  added_on      date DEFAULT current_date,
  still_true    boolean NOT NULL DEFAULT true
);

-- A CHECK, not a convention. A typo in trigger_state would otherwise never
-- match and the rule would silently never load — the exact class of bug this
-- project has spent weeks removing.
ALTER TABLE public.kb_rule DROP CONSTRAINT IF EXISTS kb_rule_trigger_state_valid;
ALTER TABLE public.kb_rule ADD CONSTRAINT kb_rule_trigger_state_valid CHECK (
  trigger_state IS NULL OR trigger_state IN (
    'NO_PROTECTION', 'BUYERS_8_5', 'WALL_PLACED', 'WALL_PULLED',
    'BAIT_BID', 'FROZEN', 'BID_EMPTY', 'WAKEUP',
    'TARGET_SET', 'PRE_OPEN', 'TIP_TRADE', 'POSITION_OPEN'));

CREATE INDEX IF NOT EXISTS kb_rule_scope_idx
  ON public.kb_rule (scope, symbol, trigger_state) WHERE still_true;

-- ---------------------------------------------------------------------------
-- 3 · kb_phrase — short labels, neither hardcoded nor a model call
--
-- Ladder notes refresh every 15 seconds across 20 rows. Eighty model calls a
-- minute is too slow and too expensive, and a string literal cannot be edited
-- without a deploy.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.kb_phrase (
  event      text PRIMARY KEY,
  text       text NOT NULL,
  still_true boolean NOT NULL DEFAULT true
);

-- ---------------------------------------------------------------------------
-- 4 · app_config — settings and the API key
--
-- The key is written here and never read back to a client. A key in the
-- browser is a key in everyone's browser.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.app_config (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  is_secret  boolean NOT NULL DEFAULT false,
  updated_at timestamptz DEFAULT now(),
  updated_by text
);

COMMENT ON COLUMN public.app_config.is_secret IS
  'The endpoint that saves a secret returns only its last four characters, and '
  'the change log records the key name and time, never the value.';

-- ---------------------------------------------------------------------------
-- 5 · ai_chat — every question and answer
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_chat (
  id           bigserial PRIMARY KEY,
  asked_at     timestamptz NOT NULL DEFAULT now(),
  trading_date date NOT NULL,
  symbol       text,
  question     text NOT NULL,
  answer       text,
  context_json jsonb,
  model        text,
  tool_calls   integer,
  tokens       integer,
  flagged      boolean DEFAULT false
);

CREATE INDEX IF NOT EXISTS ai_chat_thread_idx
  ON public.ai_chat (trading_date, symbol, asked_at DESC);

COMMENT ON COLUMN public.ai_chat.context_json IS
  'NOT optional. Without it "why did it say hold at 09:31" is unanswerable a '
  'week later; with it the exact input replays.';
COMMENT ON COLUMN public.ai_chat.symbol IS
  'The thread key. One thread per stock, NULL is the TODAY thread.';

-- ---------------------------------------------------------------------------
-- 6 · ai_memory — durable facts
--
-- The mechanism by which it stops needing to be told the same thing twice.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_memory (
  id                bigserial PRIMARY KEY,
  learned_on        date NOT NULL DEFAULT current_date,
  symbol            text,
  fact              text NOT NULL,
  source            text,
  confirmed_by_user boolean DEFAULT false,
  still_true        boolean DEFAULT true,
  exported          boolean DEFAULT false
);

CREATE INDEX IF NOT EXISTS ai_memory_active_idx
  ON public.ai_memory (symbol) WHERE confirmed_by_user AND still_true;

-- ---------------------------------------------------------------------------
-- 7 · ai_query_log — the tool-use audit trail
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_query_log (
  id          bigserial PRIMARY KEY,
  chat_id     bigint REFERENCES public.ai_chat(id),
  ran_at      timestamptz DEFAULT now(),
  sql         text NOT NULL,
  rows        integer,
  duration_ms integer,
  error       text
);

-- ---------------------------------------------------------------------------
-- 8 · The read-only role
--
-- Enforced at Postgres, not in application code: a SELECT-only role cannot be
-- talked into writing, and a check in the application can be reasoned around
-- by anything that composes SQL.
--
-- NOLOGIN and no password. A password in a migration is a password in the
-- repository — grant login separately, by hand.
-- ---------------------------------------------------------------------------
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kse_ai_readonly') THEN
    CREATE ROLE kse_ai_readonly NOLOGIN;
  END IF;
END
$role$;

GRANT USAGE ON SCHEMA public TO kse_ai_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO kse_ai_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO kse_ai_readonly;
REVOKE ALL ON public.app_config FROM kse_ai_readonly;   -- it holds the API key

-- ---------------------------------------------------------------------------
-- 9 · Four symbol_day columns the front end reads
-- ---------------------------------------------------------------------------
ALTER TABLE public.symbol_day
  ADD COLUMN IF NOT EXISTS markup  numeric,
  ADD COLUMN IF NOT EXISTS resumed integer,
  ADD COLUMN IF NOT EXISTS lift    integer,
  ADD COLUMN IF NOT EXISTS hit     integer;

COMMENT ON COLUMN public.symbol_day.markup IS
  'buy_sell_ratio on the last session where chg_1d >= 5%. Near 1.0 means they '
  'sold into their own move. NULL where the symbol has never moved 5% — there '
  'is no markup to assess. CR-53.';
COMMENT ON COLUMN public.symbol_day.resumed IS
  'Sessions since the symbol resumed after a suspension. NULL means UNKNOWN, '
  'not "never suspended" — there is no suspension history behind the 28 '
  'backfilled sessions, and writing 0 would state a fact we do not have. CR-58.';
COMMENT ON COLUMN public.symbol_day.lift IS
  'Volume-bearing minutes whose print was at or above the offer. bought_at_offer '
  'counts the SHARES; this counts the minutes.';

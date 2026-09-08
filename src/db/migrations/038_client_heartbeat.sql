-- ===========================================================================
--  038_client_heartbeat.sql — a userscript that stops is currently invisible
--
--  The orders userscript posted nothing from 2 September for six sessions and
--  nothing raised it, because a userscript only leaves a trace (a
--  client_submissions row) when it POSTs DATA. On zero rows or a DOM problem it
--  returns silently, so "stopped" and "running but reading nothing" look
--  identical, and a dead capture cost a live trade on 8 September.
--
--  This is the record every script writes EVERY cycle, whether or not it had
--  data: one row per (script, source), upserted. last_seen_at going stale is
--  the signal; `problem` carries the panel's own message so the cause is known
--  remotely, without waiting to read the terminal.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.client_heartbeat (
  script       text        NOT NULL,                 -- orders | depth | quotes | market-summary
  source       text        NOT NULL DEFAULT 'awsat_client',
  version      text,
  rows_seen    integer,                              -- rows read this cycle; 0 = alive but empty
  problem      text,                                 -- the panel's stats.msg when it could not read
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (script, source)
);

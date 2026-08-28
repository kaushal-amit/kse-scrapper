-- ===========================================================================
--  006_depth_freshness.sql — is depth actually being captured in time?
--
--  The requirement is a capture at least every minute and never more than 1.5
--  minutes apart. Nothing was measuring that, and a depth sweep that quietly
--  slows down looks identical to one that is keeping up: rows keep arriving,
--  just fewer of them.
--
--  A view rather than a job: it reads the data that is already there, so it
--  cannot itself fall behind or disagree with the table it describes.
-- ===========================================================================

CREATE OR REPLACE VIEW awsat_depth_freshness AS
SELECT symbol,
       max(created_at)                                   AS last_capture,
       EXTRACT(epoch FROM (now() - max(created_at)))     AS seconds_since,
       count(DISTINCT created_at)                        AS captures_today,
       CASE
         WHEN EXTRACT(epoch FROM (now() - max(created_at))) <= 60  THEN 'OK'
         WHEN EXTRACT(epoch FROM (now() - max(created_at))) <= 90  THEN 'LATE'
         ELSE 'BREACH'          -- past the 1.5 minute ceiling
       END                                               AS status
  FROM awsat_stock_depth
 WHERE trading_date = CURRENT_DATE
 GROUP BY symbol;

COMMENT ON VIEW awsat_depth_freshness IS
  'Per-symbol depth capture age. OK <=60s, LATE <=90s, BREACH beyond the '
  '1.5-minute ceiling. A slowing sweep otherwise looks identical to a healthy '
  'one — rows keep arriving, just fewer of them.';

-- Gaps BETWEEN consecutive captures, not just the age of the newest. A sweep
-- that stalled for five minutes and then resumed looks fine by age alone.
CREATE OR REPLACE VIEW awsat_depth_gaps AS
SELECT symbol, created_at, previous_capture,
       EXTRACT(epoch FROM (created_at - previous_capture)) AS gap_seconds
  FROM (
    SELECT symbol, created_at,
           lag(created_at) OVER (PARTITION BY symbol ORDER BY created_at) AS previous_capture
      FROM (SELECT DISTINCT symbol, created_at FROM awsat_stock_depth
             WHERE trading_date = CURRENT_DATE) d
  ) g
 WHERE previous_capture IS NOT NULL
   AND created_at - previous_capture > interval '90 seconds'
 ORDER BY created_at DESC;

COMMENT ON VIEW awsat_depth_gaps IS
  'Consecutive depth captures more than 90s apart. Age alone cannot see a sweep '
  'that stalled and then resumed.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 20261017_extra_pm_work_orders.sql — READ ONLY, changes nothing
--
-- Lists every OPEN PM work order and says whether it is an extra one created
-- by the 21-day bug (fixed in 20261017_pm_frequency_intervals.sql).
-- Run AFTER that migration is committed (it uses its helper functions).
--
-- How "extra" is decided
--   Each PM's schedule is anchored on its first generation. For each open
--   WO we find the scheduled cycle it belongs to (anchor + n × interval on or
--   before the day it was created). If the same PM was ALREADY generated
--   earlier in that same cycle, this WO is an extra.
--   Example: an Annual cycle count first generated 2026-03-16 belongs to the
--   cycle that started 2026-03-16; one generated 2026-10-12 is an extra.
--   A Monthly room cleaning generated 2026-10-14 is "expected" if nothing else
--   was generated since its Oct 1 cycle started.
--
-- Close the extras you don't want from the Work Orders page as usual.
-- ═══════════════════════════════════════════════════════════════════════════

WITH gens AS (
  SELECT substring(a.details from 'from PM (\S+)')                          AS pm_id,
         coalesce(substring(a.details from 'Generated WO (\S+)'), a.entity_id) AS wo_id,
         (a.timestamp AT TIME ZONE 'America/Chicago')::date                 AS gen_day
    FROM audit_log a
   WHERE a.action IN ('Auto-Generate PM WO', 'Generate PM WO')
     AND substring(a.details from 'from PM (\S+)') IS NOT NULL
),
anchor AS (
  SELECT pm_id, min(gen_day) AS first_day FROM gens GROUP BY pm_id
),
open_wo AS (
  SELECT w.wo_id, w.pm_id, w.status, w.assigned_to, w.assigned_email,
         left(w.due_date::text, 10)                          AS due_date,
         (w.created_at AT TIME ZONE 'America/Chicago')::date AS created_day
    FROM work_orders w
   WHERE w.is_pm = 'Yes' AND coalesce(w.pm_id, '') <> ''
),
judged AS (
  SELECT o.*, p.pm_name, p.frequency, a.first_day,
         private.pm_previous(a.first_day, p.frequency, p.frequency_value::text, o.created_day) AS cycle_start,
         (SELECT max(g.gen_day) FROM gens g
           WHERE g.pm_id = o.pm_id
             AND g.wo_id IS DISTINCT FROM o.wo_id
             AND g.gen_day >= private.pm_previous(a.first_day, p.frequency, p.frequency_value::text, o.created_day)
             AND g.gen_day <= o.created_day)                                   AS earlier_this_cycle
    FROM open_wo o
    JOIN pm_schedules p ON p.pm_id = o.pm_id
    LEFT JOIN anchor a  ON a.pm_id = o.pm_id
)
SELECT CASE
         WHEN lower(trim(frequency)) IN ('daily', 'weekly') THEN 'OK — daily/weekly, not affected'
         WHEN first_day IS NULL                               THEN 'Check — no generation history'
         WHEN earlier_this_cycle IS NOT NULL                  THEN 'EXTRA — this cycle was already generated ' || to_char(earlier_this_cycle, 'Mon DD')
         ELSE                                                      'OK — expected for this cycle'
       END                                   AS verdict,
       wo_id, pm_id, left(pm_name, 60)        AS pm_name, frequency,
       created_day                            AS generated, due_date, status,
       coalesce(assigned_to, '(unassigned)')  AS assigned_to,
       cycle_start, first_day                 AS schedule_anchor
  FROM judged
 ORDER BY CASE WHEN earlier_this_cycle IS NOT NULL AND lower(trim(frequency)) NOT IN ('daily', 'weekly') THEN 0 ELSE 1 END,
          frequency, pm_name, wo_id;

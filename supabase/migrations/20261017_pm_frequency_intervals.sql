-- ═══════════════════════════════════════════════════════════════════════════
-- 20261017_pm_frequency_intervals.sql
--
-- PMs come due at their real frequency again.
--
-- The bug (since 2026-09-01)
--   auto_generate_pm_work_orders() and reset_overdue_pm_dates() used ONE table
--   for two different things:
--     WO due date (lead time):  Daily +1, Weekly +7, everything else +21
--     next generation date:     Daily +1, Weekly +7, everything else +21  ← wrong
--   So Monthly, Quarterly, Annually, "Yearly" and Custom PMs all came back
--   every 21 days (or as soon as the open WO was closed). Annual cycle counts
--   were generated 5–6 times since March. "Yearly" (54 PMs, a leftover from the
--   Google Sheets import) is not in the app's frequency list at all.
--
-- Decisions (Aaron, 2026-10-17)
--   1. The next date counts from the SCHEDULED date (no drift).
--   2. Correct existing PMs, anchored on each PM's ORIGINAL FIRST generation
--      (keeps the staggered cycle-count schedule).
--   3. New PMs generate right away (app side).
--   4. WO lead time unchanged: Daily 1, Weekly 7, everything else 21 days.
--   5. Extra open WOs are listed for review, not closed automatically
--      (see supabase/diagnostics/20261017_extra_pm_work_orders.sql).
--
-- What this does
--   1. private.pm_step(frequency, value)       → the real repeat interval
--        Daily 1 day · Weekly 7 days · Monthly 1 month · Quarterly 3 months ·
--        Annually / Yearly 1 year · Custom <value> days (21 if no value) ·
--        anything else 21 days (unchanged behaviour)
--      private.pm_advance(scheduled, freq, value, today)
--        → first scheduled + n·interval that is AFTER today (n ≥ 1). A PM that
--          fell behind skips the missed cycles instead of generating twice.
--      private.pm_previous(anchor, freq, value, day)
--        → last anchor + n·interval on or before day (used by the review list).
--   2. auto_generate_pm_work_orders(): patched IN PLACE (same technique as
--      20261017_pm_rotation_in_session.sql). Only the next-generation CASE is
--      replaced by private.pm_advance(next_due_date, …). The WO due date CASE,
--      the in-session rule, break hold and everything else stay as they are.
--   3. reset_overdue_pm_dates() ("Resume Generation"): rolls overdue PMs to
--      their next scheduled date after today, Chicago time (was today + 21 /
--      UTC). Missed break cycles are still skipped, as designed.
--   4. Data: frequency 'Yearly' → 'Annually'. Every non-Daily/Weekly PM that
--      has generated before AND whose next date is still what the bug set
--      (its last generation + 21/22 days) gets next_due_date =
--      pm_advance(original first generation date) — e.g. an annual count first
--      generated Mar 16 2026 next generates Mar 16 2027. Kept as they are:
--      PMs that never generated, and dates someone set by hand (e.g. the Fanuc
--      battery PMs on Jan 26 2027).
--      Old values are saved in private.pm_schedule_fix_20261017 (undo below).
--
-- Undo for the data step (only if ever needed):
--   UPDATE pm_schedules p SET frequency = f.old_frequency, next_due_date = f.old_next_due
--     FROM private.pm_schedule_fix_20261017 f WHERE f.pm_id = p.pm_id;
--
-- Re-runnable. Ends in ROLLBACK. The last result table is the before/after
-- list for every PM; the checks run first and STOP the script if one fails.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE SCHEMA IF NOT EXISTS private;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 1: interval helpers
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.pm_step(p_frequency text, p_value text)
 RETURNS interval
 LANGUAGE sql
 IMMUTABLE
 SET search_path = public, pg_temp
AS $function$
  SELECT CASE lower(trim(coalesce(p_frequency, '')))
           WHEN 'daily'     THEN interval '1 day'
           WHEN 'weekly'    THEN interval '7 days'
           WHEN 'monthly'   THEN interval '1 month'
           WHEN 'quarterly' THEN interval '3 months'
           WHEN 'annually'  THEN interval '1 year'
           WHEN 'annual'    THEN interval '1 year'
           WHEN 'yearly'    THEN interval '1 year'
           WHEN 'custom'    THEN CASE WHEN trim(coalesce(p_value, '')) ~ '^[0-9]+$'
                                       AND trim(p_value)::int > 0
                                      THEN make_interval(days => trim(p_value)::int)
                                      ELSE interval '21 days' END
           ELSE interval '21 days'
         END;
$function$;

-- First p_scheduled + n·step (n ≥ 1) that is after p_today.
-- n·step is computed from p_scheduled each time, so months don't drift inside
-- one call (Jan 31 + 1 month = Feb 28, + 2 months = Mar 31).
CREATE OR REPLACE FUNCTION private.pm_advance(p_scheduled date, p_frequency text, p_value text, p_today date)
 RETURNS date
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_step interval := private.pm_step(p_frequency, p_value);
  v_next date;
  n      int := 1;
BEGIN
  IF p_scheduled IS NULL THEN
    RETURN (p_today + v_step)::date;
  END IF;
  LOOP
    v_next := (p_scheduled + v_step * n)::date;
    EXIT WHEN v_next > p_today OR n >= 20000;
    n := n + 1;
  END LOOP;
  RETURN v_next;
END;
$function$;

-- Last p_anchor + n·step (n ≥ 0) on or before p_day.
CREATE OR REPLACE FUNCTION private.pm_previous(p_anchor date, p_frequency text, p_value text, p_day date)
 RETURNS date
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_step interval := private.pm_step(p_frequency, p_value);
  v_prev date := p_anchor;
  v_next date;
  n      int := 1;
BEGIN
  IF p_anchor IS NULL OR p_day IS NULL OR p_day < p_anchor THEN
    RETURN NULL;
  END IF;
  LOOP
    v_next := (p_anchor + v_step * n)::date;
    EXIT WHEN v_next > p_day OR n >= 20000;
    v_prev := v_next;
    n := n + 1;
  END LOOP;
  RETURN v_prev;
END;
$function$;

REVOKE ALL ON FUNCTION private.pm_step(text, text)                 FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.pm_advance(date, text, text, date)  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.pm_previous(date, text, text, date) FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 2: patch auto_generate_pm_work_orders() in place
-- Replaces ONLY the "v_next_pm_due := CASE … END;" block.
-- ─────────────────────────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_oid oid;
  v_def text;
  v_new text;
  v_pat text := $p$v_next_pm_due := CASE pm_rec\.frequency.*?END;$p$;
  v_rep text := $r$v_next_pm_due := private.pm_advance(pm_rec.next_due_date::date, pm_rec.frequency, pm_rec.frequency_value::text, v_today);  -- real interval from the scheduled date (2026-10-17)$r$;
  n     int;
BEGIN
  SELECT p.oid INTO v_oid
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'auto_generate_pm_work_orders' AND p.pronargs = 0;
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'public.auto_generate_pm_work_orders() not found. Nothing was changed.';
  END IF;

  v_def := replace(pg_get_functiondef(v_oid), E'\r', '');

  IF position('private.pm_advance' IN v_def) > 0 THEN
    RAISE NOTICE 'auto_generate_pm_work_orders already uses pm_advance — skipped.';
    RETURN;
  END IF;
  IF position('private.pm_student_in_session' IN v_def) = 0 THEN
    RAISE EXCEPTION 'Run 20261017_pm_rotation_in_session.sql first. Nothing was changed.';
  END IF;

  n := (SELECT count(*) FROM regexp_matches(v_def, v_pat, 'g'));
  IF n <> 1 THEN
    RAISE EXCEPTION 'Expected 1 "v_next_pm_due := CASE … END;" block in the live function, found %. Nothing was changed — send this message to Claude.', n;
  END IF;

  v_new := regexp_replace(v_def, v_pat, v_rep);
  EXECUTE v_new;   -- CREATE OR REPLACE: owner, grants and SET search_path kept
  RAISE NOTICE 'auto_generate_pm_work_orders patched.';
END
$do$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 3: reset_overdue_pm_dates() — "Resume Generation"
-- Replaced only when the live body is the known 21-day version.
-- ─────────────────────────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_def text;
BEGIN
  IF to_regprocedure('public.reset_overdue_pm_dates()') IS NULL THEN
    RAISE EXCEPTION 'public.reset_overdue_pm_dates() not found. Nothing was changed.';
  END IF;
  v_def := replace(pg_get_functiondef('public.reset_overdue_pm_dates()'::regprocedure), E'\r', '');

  IF position('private.pm_advance' IN v_def) > 0 THEN
    RAISE NOTICE 'reset_overdue_pm_dates already uses pm_advance — skipped.';
    RETURN;
  END IF;
  IF v_def !~ 'ELSE\s+v_today \+ 21' OR v_def !~ 'UPDATE pm_schedules' THEN
    RAISE EXCEPTION 'reset_overdue_pm_dates() is not the version this migration expects. Nothing was changed — send this message to Claude.';
  END IF;

  EXECUTE $fn$
CREATE OR REPLACE FUNCTION public.reset_overdue_pm_dates()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today date    := (now() AT TIME ZONE 'America/Chicago')::date;  -- Chicago, not UTC (2026-10-17)
  v_count integer := 0;
BEGIN
  -- Roll each overdue Active PM forward to its next scheduled date after
  -- today (real interval from the scheduled date). Missed break cycles are
  -- skipped; the cadence is kept. (2026-10-17: was today + 1 / 7 / 21.)
  UPDATE pm_schedules
  SET next_due_date = private.pm_advance(next_due_date::date, frequency, frequency_value::text, v_today),
      updated_at = now()
  WHERE status = 'Active'
    AND next_due_date IS NOT NULL
    AND next_due_date::date <= v_today;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$
$fn$;
  RAISE NOTICE 'reset_overdue_pm_dates replaced.';
END
$do$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 4: data — 'Yearly' → 'Annually', correct next dates
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS private.pm_schedule_fix_20261017 (
  pm_id         text PRIMARY KEY,
  old_frequency text,
  new_frequency text,
  old_next_due  text,
  new_next_due  text,
  anchor        date,
  fixed_at      timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON private.pm_schedule_fix_20261017 FROM PUBLIC, anon, authenticated;
ALTER TABLE private.pm_schedule_fix_20261017 ENABLE ROW LEVEL SECURITY;  -- no policies: only the owner (migrations) can read it

-- First generation per PM (auto or manual), Chicago date — the original anchor
CREATE TEMP TABLE _pm_anchor ON COMMIT DROP AS
SELECT substring(a.details from 'from PM (\S+)')                       AS pm_id,
       min((a.timestamp AT TIME ZONE 'America/Chicago')::date)          AS anchor,
       max((a.timestamp AT TIME ZONE 'America/Chicago')::date)          AS last_gen,
       count(*)                                                         AS times_generated
  FROM audit_log a
 WHERE a.action IN ('Auto-Generate PM WO', 'Generate PM WO')
   AND substring(a.details from 'from PM (\S+)') IS NOT NULL
 GROUP BY 1;

CREATE TEMP TABLE _pm_plan ON COMMIT DROP AS
SELECT p.pm_id,
       p.pm_name,
       p.status,
       p.frequency                                                       AS old_frequency,
       CASE WHEN lower(trim(p.frequency)) = 'yearly' THEN 'Annually' ELSE p.frequency END AS new_frequency,
       left(p.next_due_date::text, 10)                                   AS old_next_due,
       a.anchor,
       coalesce(a.times_generated, 0)                                    AS times_generated,
       -- The bug set next = generation day + 21 (UTC "today", so +22 for an
       -- evening generation). Anything else was set by hand.
       (a.last_gen IS NOT NULL AND p.next_due_date IS NOT NULL
        AND p.next_due_date::date - a.last_gen BETWEEN 20 AND 22)         AS bug_date,
       CASE
         WHEN lower(trim(coalesce(p.frequency, ''))) IN ('daily', 'weekly') THEN left(p.next_due_date::text, 10)
         WHEN a.anchor IS NULL THEN left(p.next_due_date::text, 10)        -- never generated: keep
         WHEN NOT (p.next_due_date IS NOT NULL
                   AND p.next_due_date::date - a.last_gen BETWEEN 20 AND 22)
           THEN left(p.next_due_date::text, 10)                            -- set by hand: keep
         ELSE to_char(private.pm_advance(a.anchor, p.frequency, p.frequency_value::text,
                                         (now() AT TIME ZONE 'America/Chicago')::date), 'YYYY-MM-DD')
       END                                                               AS new_next_due
  FROM pm_schedules p
  LEFT JOIN _pm_anchor a ON a.pm_id = p.pm_id;

INSERT INTO private.pm_schedule_fix_20261017 (pm_id, old_frequency, new_frequency, old_next_due, new_next_due, anchor)
SELECT pm_id, old_frequency, new_frequency, old_next_due, new_next_due, anchor
  FROM _pm_plan
 WHERE new_frequency IS DISTINCT FROM old_frequency
    OR new_next_due  IS DISTINCT FROM old_next_due
ON CONFLICT (pm_id) DO NOTHING;   -- a re-run keeps the ORIGINAL old values

UPDATE pm_schedules p
   SET frequency     = pl.new_frequency,
       next_due_date = pl.new_next_due::date,
       updated_at    = now()
  FROM _pm_plan pl
 WHERE pl.pm_id = p.pm_id
   AND (pl.new_frequency IS DISTINCT FROM pl.old_frequency
        OR pl.new_next_due IS DISTINCT FROM pl.old_next_due);

INSERT INTO audit_log (timestamp, user_email, user_name, action, entity_type, entity_id, details)
SELECT now(), 'system@rict-cmms.auto', 'System (Auto-PM)', 'PM Schedule Correction', 'PM Schedule', 'ALL',
       'Corrected PM frequencies (2026-10-17): ' ||
       count(*) FILTER (WHERE new_next_due IS DISTINCT FROM old_next_due) || ' next dates set to the real interval from each PM''s first generation; ' ||
       count(*) FILTER (WHERE new_frequency IS DISTINCT FROM old_frequency) || ' "Yearly" renamed to "Annually". Old values in private.pm_schedule_fix_20261017.'
  FROM _pm_plan
HAVING count(*) FILTER (WHERE new_next_due IS DISTINCT FROM old_next_due
                          OR new_frequency IS DISTINCT FROM old_frequency) > 0;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 5: checks — the script STOPS here with a message if any fails
-- ─────────────────────────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_gen   text := replace(pg_get_functiondef('public.auto_generate_pm_work_orders()'::regprocedure), E'\r', '');
  v_reset text := replace(pg_get_functiondef('public.reset_overdue_pm_dates()'::regprocedure), E'\r', '');
  v_bad   int;
BEGIN
  -- interval math
  IF private.pm_advance('2026-03-16', 'Annually',  '0',  '2026-10-17') <> '2027-03-16' THEN RAISE EXCEPTION 'check failed: annual step'; END IF;
  IF private.pm_advance('2026-04-01', 'Monthly',   '30', '2026-10-17') <> '2026-11-01' THEN RAISE EXCEPTION 'check failed: monthly step'; END IF;
  IF private.pm_advance('2026-04-14', 'Quarterly', '0',  '2026-10-17') <> '2027-01-14' THEN RAISE EXCEPTION 'check failed: quarterly step'; END IF;
  IF private.pm_advance('2026-10-01', 'Custom',    '10', '2026-10-17') <> '2026-10-21' THEN RAISE EXCEPTION 'check failed: custom step'; END IF;
  IF private.pm_advance('2026-10-17', 'Weekly',    '0',  '2026-10-17') <> '2026-10-24' THEN RAISE EXCEPTION 'check failed: weekly step'; END IF;
  IF private.pm_advance('2026-01-31', 'Monthly',   '0',  '2026-03-01') <> '2026-03-31' THEN RAISE EXCEPTION 'check failed: month-end'; END IF;

  -- functions
  IF position('private.pm_advance' IN v_gen) = 0 OR v_gen ~ 'v_next_pm_due := CASE' THEN
    RAISE EXCEPTION 'check failed: generator not patched';
  END IF;
  IF position('private.pm_student_in_session' IN v_gen) = 0 THEN
    RAISE EXCEPTION 'check failed: generator lost the in-session rule';
  END IF;
  IF v_gen !~ 'v_due_date := CASE pm_rec\.frequency' THEN
    RAISE EXCEPTION 'check failed: WO due-date lead time block missing';
  END IF;
  IF position('private.pm_advance' IN v_reset) = 0 OR position('America/Chicago' IN v_reset) = 0 THEN
    RAISE EXCEPTION 'check failed: reset_overdue_pm_dates not replaced';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.auto_generate_pm_work_orders()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.reset_overdue_pm_dates()', 'EXECUTE') THEN
    RAISE EXCEPTION 'check failed: the PM page can no longer call the PM functions';
  END IF;
  IF has_function_privilege('anon', 'public.auto_generate_pm_work_orders()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.reset_overdue_pm_dates()', 'EXECUTE') THEN
    RAISE EXCEPTION 'check failed: logged-out users can run the PM functions';
  END IF;

  -- data
  SELECT count(*) INTO v_bad FROM pm_schedules WHERE lower(trim(frequency)) = 'yearly';
  IF v_bad > 0 THEN RAISE EXCEPTION 'check failed: % PMs still say Yearly', v_bad; END IF;

  SELECT count(*) INTO v_bad
    FROM pm_schedules p JOIN _pm_plan pl ON pl.pm_id = p.pm_id
   WHERE pl.bug_date
     AND lower(trim(coalesce(p.frequency, ''))) NOT IN ('daily', 'weekly')
     AND p.next_due_date::date <= (now() AT TIME ZONE 'America/Chicago')::date;
  IF v_bad > 0 THEN RAISE EXCEPTION 'check failed: % corrected PMs are still due today or earlier', v_bad; END IF;

  RAISE NOTICE 'All checks passed.';
END
$do$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Result: before / after for every PM (the table the SQL Editor shows)
-- ─────────────────────────────────────────────────────────────────────────────
SELECT pl.pm_id,
       left(pl.pm_name, 60)                                         AS pm_name,
       pl.status,
       CASE WHEN pl.new_frequency IS DISTINCT FROM pl.old_frequency
            THEN pl.old_frequency || ' → ' || pl.new_frequency ELSE pl.new_frequency END AS frequency,
       pl.times_generated,
       pl.anchor                                                    AS first_generated,
       pl.old_next_due                                              AS next_generates_before,
       pl.new_next_due                                              AS next_generates_after,
       CASE WHEN pl.new_next_due IS DISTINCT FROM pl.old_next_due THEN 'changed'
            WHEN lower(trim(coalesce(pl.old_frequency, ''))) IN ('daily', 'weekly') THEN 'daily/weekly — not affected'
            WHEN pl.anchor IS NULL THEN 'kept — never generated'
            WHEN NOT pl.bug_date THEN 'kept — date set by hand'
            ELSE 'already correct' END
       || CASE WHEN pl.new_frequency IS DISTINCT FROM pl.old_frequency THEN ' · Yearly → Annually' ELSE '' END AS change
  FROM _pm_plan pl
 ORDER BY CASE WHEN pl.new_next_due IS DISTINCT FROM pl.old_next_due THEN 0 ELSE 1 END,
          pl.new_frequency, pl.new_next_due, pl.pm_id;

ROLLBACK;   -- ← swap for COMMIT once the table above looks right

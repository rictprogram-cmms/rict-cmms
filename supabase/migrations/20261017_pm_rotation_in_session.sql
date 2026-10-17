-- ═══════════════════════════════════════════════════════════════════════════
-- 20261017_pm_rotation_in_session.sql
--
-- PM work orders go only to students in a class that is in session, and PM
-- generation pauses over breaks.
--
-- Why
--   A new student who starts in January needs an account now (to see the app
--   and sign up for labs), but auto_generate_pm_work_orders() put every Active
--   Student / Work Study profile in the rotation, and never-assigned people go
--   first — so he was next in line for a PM.
--
-- Decisions (Aaron, 2026-10-17)
--   1. Rotation = Active Student / Work Study, not Time Clock Only, AND enrolled
--      (Settings → Classes roster, class_enrollments) in a class in session
--      today. A second-8-weeks-only student is out during the first half.
--   2. Breaks: when nobody qualifies, generate NOTHING and leave each PM's next
--      due date alone. Everything that came due generates the first run after
--      classes resume, due dates counted from that day.
--   3. A never-assigned student is still first in line when he joins.
--   4. (App side) Metrics Report alerts skip students with no class in session.
--   5. Pre-existing: "today" was current_date = UTC. The PM page runs this
--      function on every visit, so after ~7 PM Chicago it treated tomorrow as
--      today (PMs a day early, due dates a day late). Now Chicago time.
--
-- "In session" — per student, per semester:
--   Take the student's Active classes (blank status counts as Active) and group
--   them by semester. A semester's span runs from its earliest start_date to
--   its latest last day (end_date or finals_end, whichever is later). The
--   student is in session when today falls inside any of their spans.
--   This bridges the gap between first and second 8-week halves (RICT1500
--   ends Oct 14, RICT1510 starts Oct 19), but not breaks between semesters.
--   A missing date never excludes (listed in the last result below).
--
-- How
--   1. New helper private.pm_student_in_session(email, day). Not callable from
--      the API (private schema; EXECUTE revoked).
--   2. auto_generate_pm_work_orders() is patched IN PLACE from the live body
--      (live = the 20260901 round-robin version; SOPs are copied by a trigger)
--      (pg_get_functiondef + exact-text replace, like 20261008), so anything
--      else in the live function, its grants and its search_path are kept.
--      Three edits only:
--        a. v_today := Chicago date instead of current_date
--        b. break hold right after the pause check (one audit row per day,
--           only when PMs were actually due)
--        c. the in-session condition added to the round-robin pick
--      If the live body is not what this expects it stops and changes nothing.
--
-- Unchanged: pause setting, open-WO skip, ID generation, due-date math, SOP
-- copy, assignments, rotation stamp, audit row, return shape, the manual
-- "Generate WO" button, and the order among eligible students.
--
-- Re-runnable. Ends in ROLLBACK — check the rows, then swap for COMMIT.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 1: in-session helper
-- Dates are read through to_jsonb so text or date columns both work.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS private;

CREATE OR REPLACE FUNCTION private.pm_student_in_session(p_email text, p_day date)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM (
        SELECT coalesce(nullif(trim(c.semester), ''),
                        nullif(to_jsonb(c) ->> 'term_id', ''),
                        c.class_id::text)                                        AS grp,
               min(coalesce(nullif(left(to_jsonb(c) ->> 'start_date', 10), ''), '0001-01-01')) AS first_day,
               max(coalesce(greatest(nullif(left(to_jsonb(c) ->> 'end_date',   10), ''),
                                     nullif(left(to_jsonb(c) ->> 'finals_end', 10), '')),
                            '9999-12-31'))                                       AS last_day
          FROM public.class_enrollments e
          JOIN public.classes c ON c.class_id::text = e.class_id::text
         WHERE lower(trim(e.student_email)) = lower(trim(p_email))
           AND coalesce(nullif(trim(c.status), ''), 'Active') = 'Active'
         GROUP BY 1
      ) s
     WHERE s.first_day <= to_char(p_day, 'YYYY-MM-DD')
       AND s.last_day  >= to_char(p_day, 'YYYY-MM-DD')
  );
$function$;

REVOKE ALL ON FUNCTION private.pm_student_in_session(text, date) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION private.pm_student_in_session(text, date) IS
  'True when p_day falls inside one of the student''s semester spans (earliest start → latest end_date/finals_end of their Active classes in that semester; missing dates never exclude). Bridges the gap between 8-week halves. Used by auto_generate_pm_work_orders(). 2026-10-17.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 2: patch auto_generate_pm_work_orders() in place
-- ─────────────────────────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_oid   oid;
  v_def   text;
  v_new   text;

  -- a. today → Chicago
  v_today_pat text := $p$v_today(\s+)date(\s+):=\s*current_date\s*;$p$;
  v_today_rep text := $r$v_today\1date\2:= (now() AT TIME ZONE 'America/Chicago')::date;  -- Chicago, not UTC (2026-10-17)$r$;

  -- b. break hold, inserted after the pause check
  v_pause_anchor text := $a$IF v_paused = 'true' THEN RETURN; END IF;$a$;
  v_hold_block   text := $b$

  -- ── Break hold (2026-10-17) ──────────────────────────────────────────────
  -- No student is enrolled in a class in session → generate nothing and leave
  -- next_due_date alone, so everything due generates once classes resume.
  -- One audit row per Chicago day, and only when a PM would have generated.
  IF NOT EXISTS (
    SELECT 1 FROM profiles p
     WHERE p.role IN ('Student', 'Work Study')
       AND p.status = 'Active'
       AND (p.time_clock_only IS NULL OR p.time_clock_only = '' OR LOWER(p.time_clock_only) != 'yes')
       AND p.email IS NOT NULL AND p.email <> ''
       AND private.pm_student_in_session(p.email, v_today)
  ) THEN
    DECLARE
      v_held int;
    BEGIN
      SELECT count(*) INTO v_held
        FROM pm_schedules
       WHERE status = 'Active'
         AND next_due_date IS NOT NULL
         AND next_due_date::date <= v_today
         AND NOT EXISTS (SELECT 1 FROM work_orders w WHERE w.pm_id = pm_schedules.pm_id);

      IF v_held > 0 AND NOT EXISTS (
        SELECT 1 FROM audit_log
         WHERE action = 'PM Generation Held'
           AND entity_id = to_char(v_today, 'YYYY-MM-DD')
      ) THEN
        INSERT INTO audit_log (timestamp, user_email, user_name, action, entity_type, entity_id, details)
        VALUES (
          v_now, 'system@rict-cmms.auto', 'System (Auto-PM)', 'PM Generation Held',
          'PM Schedule', to_char(v_today, 'YYYY-MM-DD'),
          'No PM work orders generated on ' || to_char(v_today, 'Mon DD, YYYY') ||
          ': no student is enrolled in a class in session. ' || v_held ||
          ' PM(s) due will generate when classes resume.'
        );
      END IF;
    END;
    RETURN;
  END IF;$b$;

  -- c. in-session condition on the round-robin pick (single-line anchor)
  v_pick_anchor text := $a$AND p.email IS NOT NULL AND p.email <> ''$a$;
  v_pick_new    text := $a$AND p.email IS NOT NULL AND p.email <> ''
      AND private.pm_student_in_session(p.email, v_today)   -- in a class in session (2026-10-17)$a$;

  n int;
BEGIN
  SELECT p.oid INTO v_oid
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'auto_generate_pm_work_orders'
     AND p.pronargs = 0;

  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'public.auto_generate_pm_work_orders() not found. Nothing was changed.';
  END IF;

  v_def := pg_get_functiondef(v_oid);

  IF position('private.pm_student_in_session' IN v_def) > 0 THEN
    RAISE NOTICE 'auto_generate_pm_work_orders already patched — skipped.';
    RETURN;
  END IF;

  -- Normalise Windows line endings on BOTH sides: the live body may be CRLF,
  -- and so may this script if a Windows editor or OneDrive converted it.
  v_def          := replace(v_def,          E'\r', '');
  v_pause_anchor := replace(v_pause_anchor, E'\r', '');
  v_hold_block   := replace(v_hold_block,   E'\r', '');
  v_pick_anchor  := replace(v_pick_anchor,  E'\r', '');
  v_pick_new     := replace(v_pick_new,     E'\r', '');

  -- Each anchor must appear exactly once, or we stop.
  n := (SELECT count(*) FROM regexp_matches(v_def, v_today_pat, 'g'));
  IF n <> 1 THEN
    RAISE EXCEPTION 'Expected 1 "v_today date := current_date;" in the live function, found %. Nothing was changed — send this message to Claude.', n;
  END IF;
  n := (length(v_def) - length(replace(v_def, v_pause_anchor, ''))) / length(v_pause_anchor);
  IF n <> 1 THEN
    RAISE EXCEPTION 'Expected 1 pause check in the live function, found %. Nothing was changed — send this message to Claude.', n;
  END IF;
  n := (length(v_def) - length(replace(v_def, v_pick_anchor, ''))) / length(v_pick_anchor);
  IF n <> 1 THEN
    RAISE EXCEPTION 'Expected 1 round-robin email filter in the live function, found %. Nothing was changed — send this message to Claude.', n;
  END IF;

  v_new := regexp_replace(v_def, v_today_pat, v_today_rep);
  v_new := replace(v_new, v_pause_anchor, v_pause_anchor || v_hold_block);
  v_new := replace(v_new, v_pick_anchor, v_pick_new);

  EXECUTE v_new;   -- CREATE OR REPLACE: owner, grants and SET search_path kept
  RAISE NOTICE 'auto_generate_pm_work_orders patched.';
END
$do$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification (no writes). Everything below runs inside this transaction, so
-- in the dry run it shows the NEW rule even though ROLLBACK undoes it.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Checks — every row should say ok = true
WITH f AS (
  SELECT p.oid, pg_get_functiondef(p.oid) AS def, p.proconfig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'auto_generate_pm_work_orders' AND p.pronargs = 0
)
SELECT 1 AS n, 'helper installed' AS check_name,
       (to_regprocedure('private.pm_student_in_session(text,date)') IS NOT NULL) AS ok
UNION ALL
SELECT 2, 'pick uses the in-session rule',
       (SELECT position('AND private.pm_student_in_session(p.email, v_today)   -- in a class' IN def) > 0 FROM f)
UNION ALL
SELECT 3, 'break hold present',
       (SELECT position('PM Generation Held' IN def) > 0 FROM f)
UNION ALL
SELECT 4, 'today is Chicago, not current_date',
       (SELECT position('AT TIME ZONE ''America/Chicago'')::date' IN def) > 0
               AND def !~ 'v_today\s+date\s+:=\s*current_date' FROM f)
UNION ALL
SELECT 5, 'search_path still fixed',
       (SELECT EXISTS (SELECT 1 FROM unnest(coalesce(proconfig, '{}')) c WHERE c LIKE 'search_path=%') FROM f)
UNION ALL
SELECT 6, 'signed-in users can still run it (PM page)',
       has_function_privilege('authenticated', 'public.auto_generate_pm_work_orders()', 'EXECUTE')
UNION ALL
SELECT 7, 'logged-out users cannot run it',
       NOT has_function_privilege('anon', 'public.auto_generate_pm_work_orders()', 'EXECUTE')
UNION ALL
SELECT 8, 'helper not callable from the API',
       NOT has_function_privilege('authenticated', 'private.pm_student_in_session(text,date)', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'private.pm_student_in_session(text,date)', 'EXECUTE')
ORDER BY 1;

-- 2. Today in Chicago, and whether a run right now would hold for a break
--    (expect would_hold = false while classes are in session)
SELECT (now() AT TIME ZONE 'America/Chicago')::date AS chicago_today,
       current_date                                 AS utc_today_old_rule,
       (SELECT count(*) FROM profiles p
         WHERE p.role IN ('Student','Work Study') AND p.status = 'Active'
           AND (p.time_clock_only IS NULL OR p.time_clock_only = '' OR LOWER(p.time_clock_only) != 'yes')
           AND p.email IS NOT NULL AND p.email <> ''
           AND private.pm_student_in_session(p.email, (now() AT TIME ZONE 'America/Chicago')::date)
       ) AS students_in_rotation,
       (SELECT count(*) FROM pm_schedules s
         WHERE s.status = 'Active' AND s.next_due_date IS NOT NULL
           AND s.next_due_date::date <= (now() AT TIME ZONE 'America/Chicago')::date
           AND NOT EXISTS (SELECT 1 FROM work_orders w WHERE w.pm_id = s.pm_id)) AS pms_due_now,
       NOT EXISTS (SELECT 1 FROM profiles p
         WHERE p.role IN ('Student','Work Study') AND p.status = 'Active'
           AND (p.time_clock_only IS NULL OR p.time_clock_only = '' OR LOWER(p.time_clock_only) != 'yes')
           AND p.email IS NOT NULL AND p.email <> ''
           AND private.pm_student_in_session(p.email, (now() AT TIME ZONE 'America/Chicago')::date)
       ) AS would_hold;

-- 3. Who leaves the rotation today (should match the list you already ran:
--    the January student, plus anyone missing from a roster)
SELECT p.first_name, p.last_name, p.email, p.role,
       (SELECT string_agg(c.class_id::text || ' ' || coalesce(c.semester, '') ||
                          ' (' || coalesce(left(to_jsonb(c) ->> 'start_date', 10), '?') || ' → ' ||
                          coalesce(left(to_jsonb(c) ->> 'end_date', 10), '?') || ')', '; ')
          FROM class_enrollments e JOIN classes c ON c.class_id::text = e.class_id::text
         WHERE lower(trim(e.student_email)) = lower(trim(p.email))) AS enrolled_in
  FROM profiles p
 WHERE p.role IN ('Student','Work Study') AND p.status = 'Active'
   AND (p.time_clock_only IS NULL OR p.time_clock_only = '' OR LOWER(p.time_clock_only) != 'yes')
   AND p.email IS NOT NULL AND p.email <> ''
   AND NOT private.pm_student_in_session(p.email, (now() AT TIME ZONE 'America/Chicago')::date)
 ORDER BY lower(p.last_name), lower(p.first_name);

-- 4. Next 10 in rotation under the new rule
SELECT row_number() OVER () AS place, x.*
  FROM (
    SELECT TRIM(p.first_name) || ' ' || LEFT(TRIM(p.last_name), 1) || '.' AS user_name,
           p.email, p.role, r.last_assigned_date
      FROM profiles p
      LEFT JOIN LATERAL (
        SELECT ar.last_assigned_date FROM assignment_rotation ar
         WHERE LOWER(ar.user_email) = LOWER(p.email)
         ORDER BY ar.last_assigned_date DESC NULLS LAST LIMIT 1
      ) r ON TRUE
     WHERE p.role IN ('Student','Work Study') AND p.status = 'Active'
       AND (p.time_clock_only IS NULL OR p.time_clock_only = '' OR LOWER(p.time_clock_only) != 'yes')
       AND p.email IS NOT NULL AND p.email <> ''
       AND private.pm_student_in_session(p.email, (now() AT TIME ZONE 'America/Chicago')::date)
     ORDER BY r.last_assigned_date ASC NULLS FIRST,
              LOWER(p.last_name), LOWER(p.first_name), LOWER(p.email)
     LIMIT 10
  ) x;

-- 5. Active classes with a missing start or end date — these count as in
--    session every day, which would keep the rotation open over a break.
--    Expect no rows; fill in any dates shown here in Settings → Classes.
SELECT c.class_id, c.course_id, c.semester,
       to_jsonb(c) ->> 'start_date' AS start_date,
       to_jsonb(c) ->> 'end_date'   AS end_date
  FROM classes c
 WHERE coalesce(nullif(trim(c.status), ''), 'Active') = 'Active'
   AND (nullif(left(to_jsonb(c) ->> 'start_date', 10), '') IS NULL
        OR (nullif(left(to_jsonb(c) ->> 'end_date',   10), '') IS NULL
            AND nullif(left(to_jsonb(c) ->> 'finals_end', 10), '') IS NULL))
 ORDER BY c.class_id;

ROLLBACK;   -- ← swap for COMMIT once check 1 is all true and 2–5 look right

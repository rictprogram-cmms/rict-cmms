-- ═════════════════════════════════════════════════════════════════════════════
-- RICT CMMS — Advising notes visible to students (Program Planner)
-- File: supabase/migrations/20260928_advising_notes_visible_to_students.sql
--
-- Change (2026-09-28, Aaron): students now see the advising notes typed in the
-- Advising section (and the Advise popup on the list), plus who advised them.
-- Existing notes become visible too. The plan's private "Instructor Note"
-- (student_program_plans.instructor_notes, the sticky-note icon) is NOT part of
-- this and stays instructor-only.
--
-- my_advising_meetings() gains two columns: notes, advised_by. Its return type
-- changes, so it is dropped and recreated (CREATE OR REPLACE cannot change
-- RETURNS TABLE). Still SECURITY DEFINER, still only the caller's own rows.
-- advising_meetings table RLS is unchanged (instructors only).
--
-- Safe in either order with the ProgramPlannerPage.jsx change: the old page
-- ignores the extra columns; the new page simply shows no notes until this runs.
--
-- Dry run: ends in ROLLBACK. Check the verification rows, swap for COMMIT.
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

DROP FUNCTION IF EXISTS public.my_advising_meetings();

CREATE FUNCTION public.my_advising_meetings()
 RETURNS TABLE (term_name text, met_on date, notes text, advised_by text)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
  SELECT m.term_name, m.met_on, m.notes, m.advised_by
    FROM public.advising_meetings m
   WHERE lower(m.student_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
     AND coalesce(auth.jwt() ->> 'email', '') <> ''
   ORDER BY m.met_on;
$function$;

COMMENT ON FUNCTION public.my_advising_meetings() IS
  'Student read of their own advising check-offs: term, date, advising notes, and who advised. Notes are student-visible as of 2026-09-28; the plan''s instructor_notes is not exposed here.';

REVOKE ALL ON FUNCTION public.my_advising_meetings() FROM public;
REVOKE ALL ON FUNCTION public.my_advising_meetings() FROM anon;
GRANT EXECUTE ON FUNCTION public.my_advising_meetings() TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification (single result set)
-- Expect one row:
--   returns        = TABLE(term_name text, met_on date, notes text, advised_by text)
--   security_definer = true, search_path set, anon_exec = false, auth_exec = true
--   rows_with_notes = how many existing meetings have a note students will now see
-- ─────────────────────────────────────────────────────────────────────────────
SELECT p.proname                                            AS function_name,
       pg_get_function_result(p.oid)                        AS returns,
       p.prosecdef                                          AS security_definer,
       array_to_string(p.proconfig, ',')                    AS config,
       has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
       (SELECT count(*) FROM public.advising_meetings
         WHERE coalesce(btrim(notes), '') <> '')            AS rows_with_notes
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'my_advising_meetings';

ROLLBACK;   -- ← swap for COMMIT after checking the verification output

-- ═════════════════════════════════════════════════════════════════════════════
-- RICT CMMS — Advising check-off (Program Planner)
-- File: supabase/migrations/20260928_advising_meetings.sql
--
-- Purpose
--   Every student meets with their instructor for advising once a semester.
--   The Program Planner gets an "Advised <term>" check-off per student so an
--   instructor can see at a glance who has / hasn't met this term.
--
-- Decisions (2026-09-28)
--   • Keyed by STUDENT, not by plan — survives duplicating/deleting plans, and
--     a student with two plans is checked off once per term.
--   • One row per student × term (unique on lower(email), term_name).
--   • Optional instructor note per meeting.
--   • Students may see their own history, DATE ONLY — never the note. So the
--     table itself is instructor-only (RLS) and students read through the
--     SECURITY DEFINER RPC my_advising_meetings(), which returns term + date.
--   • met_on is a plain DATE (no time) — no fake-UTC concerns.
--
-- Dry run: ends in ROLLBACK. Check the verification rows, swap for COMMIT.
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 1: table
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.advising_meetings (
  meeting_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  student_email     text NOT NULL,
  student_name      text,
  term_name         text NOT NULL,                  -- e.g. 'Fall 2026' (matches academic_terms.name)
  term_id           text,                           -- informational; null when no terms calendar row
  met_on            date NOT NULL DEFAULT CURRENT_DATE,
  notes             text,                           -- instructor-only
  advised_by        text,                           -- instructor display name
  advised_by_email  text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT advising_meetings_email_check CHECK (btrim(student_email) <> ''),
  CONSTRAINT advising_meetings_term_check  CHECK (btrim(term_name) <> '')
);

-- One check-off per student per term (case-insensitive email)
CREATE UNIQUE INDEX IF NOT EXISTS advising_meetings_student_term_idx
  ON public.advising_meetings (lower(student_email), term_name);

CREATE INDEX IF NOT EXISTS advising_meetings_term_idx
  ON public.advising_meetings (term_name);

COMMENT ON TABLE public.advising_meetings IS
  'Program Planner advising check-off: one row per student per term they met with an instructor for advising. Notes are instructor-only; students read dates via my_advising_meetings().';

ALTER TABLE public.advising_meetings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS advising_meetings_instructor_select ON public.advising_meetings;
DROP POLICY IF EXISTS advising_meetings_instructor_insert ON public.advising_meetings;
DROP POLICY IF EXISTS advising_meetings_instructor_update ON public.advising_meetings;
DROP POLICY IF EXISTS advising_meetings_instructor_delete ON public.advising_meetings;

CREATE POLICY advising_meetings_instructor_select
  ON public.advising_meetings FOR SELECT TO authenticated
  USING (public.current_user_is_instructor());
CREATE POLICY advising_meetings_instructor_insert
  ON public.advising_meetings FOR INSERT TO authenticated
  WITH CHECK (public.current_user_is_instructor());
CREATE POLICY advising_meetings_instructor_update
  ON public.advising_meetings FOR UPDATE TO authenticated
  USING (public.current_user_is_instructor())
  WITH CHECK (public.current_user_is_instructor());
CREATE POLICY advising_meetings_instructor_delete
  ON public.advising_meetings FOR DELETE TO authenticated
  USING (public.current_user_is_instructor());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.advising_meetings TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 2: student read — term + date only (no notes, no instructor)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.my_advising_meetings()
 RETURNS TABLE (term_name text, met_on date)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path = public
AS $function$
  SELECT m.term_name, m.met_on
    FROM public.advising_meetings m
   WHERE lower(m.student_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
     AND coalesce(auth.jwt() ->> 'email', '') <> ''
   ORDER BY m.met_on;
$function$;

REVOKE ALL ON FUNCTION public.my_advising_meetings() FROM public;
GRANT EXECUTE ON FUNCTION public.my_advising_meetings() TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification (single result set)
-- Expect: table row (rls=true policies=4), 2 index rows, 1 function row
-- (security_definer=true).
-- ─────────────────────────────────────────────────────────────────────────────
SELECT 'table' AS kind, c.relname::text AS name,
       'rls=' || c.relrowsecurity::text || ' policies=' ||
       (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname)::text AS detail
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname = 'advising_meetings'
UNION ALL
SELECT 'index', indexname::text, 'ok'
  FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'advising_meetings' AND indexname LIKE 'advising_meetings_%'
UNION ALL
SELECT 'function', p.proname::text, 'security_definer=' || p.prosecdef::text
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'my_advising_meetings'
ORDER BY 1, 2;

ROLLBACK;   -- ← swap for COMMIT after checking the verification output

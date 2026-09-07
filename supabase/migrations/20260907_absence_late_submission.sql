-- ═══════════════════════════════════════════════════════════════════════════
-- RICT CMMS — Late Submission requests on the Absence Request page (v3)
-- File: supabase/migrations/20260907_absence_late_submission.sql
--
-- Purpose
--   The Absence Request page becomes dual-purpose: students (or instructors
--   on their behalf) can also file a LATE SUBMISSION request — why the work
--   was late, their plan, and optionally extra lab time. Late submissions
--   follow the same review flow (Approve with 20% Deduction / Waived, or
--   Reject) and the same make-up mechanics.
--
-- Design
--   • absence_requests.request_type distinguishes 'Absence' (default —
--     every existing row) from 'Late Submission'.
--   • Reused columns for a late submission:
--       absence_date  = date the work was actually turned in
--       reason        = why it was late
--       makeup_plan   = the student's plan
--       hours_missed  = ADDITIONAL LAB HOURS REQUESTED (0 allowed)
--   • Because the make-up overlay (useMakeupHours.js), Lab Signup, Time
--     Cards and trg_auto_makeup_complete all key on status = 'Approved' AND
--     hours_missed > 0 for week_start + 7, approved late submissions with
--     lab time land in the FOLLOWING week automatically and late submissions
--     with 0 hours are ignored by them. No trigger/function changes needed.
--   • new_due_at / work_received_*: on approval the instructor sets a new
--     due date+time for the missed/late work. Default (via
--     default_work_due_at) = the SECOND open lab day of the following week
--     at that day's lab_calendar.end_time (16:00 if no calendar row). Work
--     not marked received by then scores 0; the zero is DERIVED in the app
--     from the timestamps, never stored.
--   • absence_request_notes: instructor-only follow-up notes per request
--     (separate table so RLS can hide them from students at the DB layer;
--     a future Student Notes feature can absorb this table).
--
-- Convention
--   Fake-UTC timestamps (local wall-clock stored with +00) — the app writes
--   created_at via localToUtcIso(); the DB default below is only a fallback.
--
-- Contents
--   1. absence_requests columns + CHECK
--   2. absence_request_notes table + RLS (instructor-only)
--   3. Consolidated verification SELECT (Supabase SQL Editor shows only the
--      last result — this is the last statement before ROLLBACK)
--
-- DRY RUN: ends with ROLLBACK. Swap to COMMIT after the verification output
-- looks right.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ───────────────────────────────────────────────────────────────────────────
-- Section 1: absence_requests — request type + late-submission fields
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE public.absence_requests
  ADD COLUMN IF NOT EXISTS request_type       text NOT NULL DEFAULT 'Absence',
  ADD COLUMN IF NOT EXISTS assignment_name    text,
  ADD COLUMN IF NOT EXISTS due_date           date,
  -- set at approval (both types): when the missed/late work is now due
  -- (fake-UTC: local wall-clock stored with +00, per TIMESTAMP_CONVENTIONS.md)
  ADD COLUMN IF NOT EXISTS new_due_at         timestamptz,
  ADD COLUMN IF NOT EXISTS work_received      boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS work_received_date timestamptz,
  ADD COLUMN IF NOT EXISTS work_received_by   text;

-- Only the two known types.
ALTER TABLE public.absence_requests
  DROP CONSTRAINT IF EXISTS absence_requests_request_type_check;
ALTER TABLE public.absence_requests
  ADD CONSTRAINT absence_requests_request_type_check
  CHECK (request_type IN ('Absence', 'Late Submission'));

-- A late submission must name the assignment and its original due date.
-- An absence never carries them. (NOT VALID + VALIDATE so existing rows are
-- checked without a long lock — all existing rows are 'Absence' with NULLs.)
ALTER TABLE public.absence_requests
  DROP CONSTRAINT IF EXISTS absence_requests_late_fields_check;
ALTER TABLE public.absence_requests
  ADD CONSTRAINT absence_requests_late_fields_check
  CHECK (
    (request_type = 'Late Submission'
       AND assignment_name IS NOT NULL AND btrim(assignment_name) <> ''
       AND due_date IS NOT NULL)
    OR
    (request_type = 'Absence'
       AND assignment_name IS NULL AND due_date IS NULL)
  ) NOT VALID;
ALTER TABLE public.absence_requests
  VALIDATE CONSTRAINT absence_requests_late_fields_check;

-- hours_missed: absences already require > 0 in the app; late submissions may
-- be 0. Guard against negatives at the DB layer either way.
ALTER TABLE public.absence_requests
  DROP CONSTRAINT IF EXISTS absence_requests_hours_missed_nonneg;
ALTER TABLE public.absence_requests
  ADD CONSTRAINT absence_requests_hours_missed_nonneg
  CHECK (coalesce(hours_missed, 0) >= 0) NOT VALID;
ALTER TABLE public.absence_requests
  VALIDATE CONSTRAINT absence_requests_hours_missed_nonneg;

-- Instructor "Nth late this semester" chip filters by type + student.
CREATE INDEX IF NOT EXISTS absence_requests_type_email_idx
  ON public.absence_requests (request_type, lower(user_email));

COMMENT ON COLUMN public.absence_requests.request_type IS
  'Absence | Late Submission. For Late Submission: absence_date = date turned in, hours_missed = additional lab hours requested (0 allowed).';
COMMENT ON COLUMN public.absence_requests.assignment_name IS
  'Late Submission only — name of the late assignment.';
COMMENT ON COLUMN public.absence_requests.due_date IS
  'Late Submission only — original due date.';
COMMENT ON COLUMN public.absence_requests.new_due_at IS
  'Fake-UTC. Set by instructor on approval (both types). Work not received by this time scores 0 (derived in app). NULL on legacy rows = no due-date rule.';

-- ───────────────────────────────────────────────────────────────────────────
-- Section 1b: default_work_due_at(p_week_start)
--
-- Default new due date/time for a request whose absence/late week starts on
-- p_week_start (a Monday): the LAST of the make-up window days (normally the
-- second open lab day of the following week) at that day's lab end time.
-- Returns fake-UTC timestamptz. NULL when no lab day can be found.
-- Called by the app when the Approve modal opens; instructor may override.
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.default_work_due_at(p_week_start date)
 RETURNS timestamptz
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
  v_window date[];
  v_day    date;
  v_end    text;
BEGIN
  v_window := public.makeup_window_days(p_week_start + 7);
  IF v_window IS NULL OR array_length(v_window, 1) IS NULL THEN RETURN NULL; END IF;
  v_day := v_window[array_length(v_window, 1)];

  SELECT end_time::text INTO v_end
    FROM public.lab_calendar
   WHERE (date::date) = v_day
   ORDER BY end_time DESC NULLS LAST
   LIMIT 1;
  IF v_end IS NULL OR btrim(v_end) = '' THEN v_end := '16:00:00'; END IF;
  -- Normalise 'HH:MM' → 'HH:MM:SS'
  IF length(v_end) = 5 THEN v_end := v_end || ':00'; END IF;

  RETURN (v_day::text || 'T' || substr(v_end, 1, 8) || '+00')::timestamptz;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.default_work_due_at(date) TO authenticated;
COMMENT ON COLUMN public.absence_requests.work_received IS
  'Instructor confirmed the missed/late work was received (checked on the request card).';


-- ───────────────────────────────────────────────────────────────────────────
-- Section 2: absence_request_notes — instructor-only follow-up notes
--
-- One row per note; a request can accumulate several. Students can never
-- read these (RLS below), so `select('*')` on absence_requests stays safe.
-- Instructor check mirrors the existing absence_requests policies
-- (profiles.email = JWT email; role IN Instructor / Super Admin).
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.absence_request_notes (
  note_id     text PRIMARY KEY,
  request_id  text NOT NULL
              REFERENCES public.absence_requests (request_id) ON DELETE CASCADE,
  note        text NOT NULL CHECK (btrim(note) <> ''),
  created_by  text NOT NULL,   -- instructor full name (matches reviewed_by style)
  created_by_email text,
  created_at  timestamptz NOT NULL DEFAULT
              ((to_char(now() AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD"T"HH24:MI:SS') || '+00')::timestamptz),
  updated_at  timestamptz,
  updated_by  text
);

CREATE INDEX IF NOT EXISTS absence_request_notes_request_idx
  ON public.absence_request_notes (request_id, created_at);

COMMENT ON TABLE public.absence_request_notes IS
  'Instructor-only follow-up notes on absence / late-submission requests. Hidden from students by RLS.';

ALTER TABLE public.absence_request_notes ENABLE ROW LEVEL SECURITY;

-- Helper used by all four policies. Matches the instructor test in the
-- existing absence_requests policies EXACTLY (role IN Instructor/Super Admin,
-- no status filter) as confirmed from pg_policies on 2026-09-07.
-- SECURITY DEFINER so the profiles read is not itself subject to profiles RLS.
CREATE OR REPLACE FUNCTION public.current_user_is_instructor()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path = public
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM public.profiles p
     WHERE lower(p.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
       AND p.role = ANY (ARRAY['Instructor'::text, 'Super Admin'::text])
  );
$function$;

REVOKE ALL ON FUNCTION public.current_user_is_instructor() FROM public;
GRANT EXECUTE ON FUNCTION public.current_user_is_instructor() TO authenticated;

DROP POLICY IF EXISTS absence_request_notes_instructor_select ON public.absence_request_notes;
DROP POLICY IF EXISTS absence_request_notes_instructor_insert ON public.absence_request_notes;
DROP POLICY IF EXISTS absence_request_notes_instructor_update ON public.absence_request_notes;
DROP POLICY IF EXISTS absence_request_notes_instructor_delete ON public.absence_request_notes;

CREATE POLICY absence_request_notes_instructor_select
  ON public.absence_request_notes FOR SELECT TO authenticated
  USING (public.current_user_is_instructor());

CREATE POLICY absence_request_notes_instructor_insert
  ON public.absence_request_notes FOR INSERT TO authenticated
  WITH CHECK (public.current_user_is_instructor());

CREATE POLICY absence_request_notes_instructor_update
  ON public.absence_request_notes FOR UPDATE TO authenticated
  USING (public.current_user_is_instructor())
  WITH CHECK (public.current_user_is_instructor());

CREATE POLICY absence_request_notes_instructor_delete
  ON public.absence_request_notes FOR DELETE TO authenticated
  USING (public.current_user_is_instructor());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.absence_request_notes TO authenticated;


-- ───────────────────────────────────────────────────────────────────────────
-- Section 3: verification (single result set)
--
-- Expect:
--   columns   → 7 rows: request_type (default 'Absence'), assignment_name,
--               due_date, new_due_at (timestamptz), work_received (default
--               false), work_received_date, work_received_by
--   default   → default_work_due_at('2026-09-07') sample output — should be
--               the second open lab day of the week of Sep 14 at lab end time
--               (e.g. 2026-09-15 16:00:00+00 if Mon/Tue are open)
--   check     → 3 rows: _request_type_check, _late_fields_check,
--               _hours_missed_nonneg (all validated = true)
--   rows      → total existing rows, all with request_type = 'Absence'
--   notes     → table exists, rls = true, 4 policies
--   helper    → current_user_is_instructor() body, to eyeball against the
--               existing policies (should read role = ANY(Instructor, Super Admin))
--   existing  → the CURRENT absence_requests policies (unchanged by this file)
-- ───────────────────────────────────────────────────────────────────────────

WITH cols AS (
  SELECT 'column' AS kind,
         column_name AS name,
         data_type || coalesce(' default ' || column_default, '') AS detail
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'absence_requests'
     AND column_name IN ('request_type', 'assignment_name', 'due_date',
                         'new_due_at', 'work_received', 'work_received_date',
                         'work_received_by')
),
chks AS (
  SELECT 'check' AS kind,
         conname AS name,
         'validated=' || convalidated::text AS detail
    FROM pg_constraint
   WHERE conrelid = 'public.absence_requests'::regclass
     AND conname IN ('absence_requests_request_type_check',
                     'absence_requests_late_fields_check',
                     'absence_requests_hours_missed_nonneg')
),
rowsum AS (
  SELECT 'rows' AS kind,
         request_type AS name,
         count(*)::text || ' existing request(s)' AS detail
    FROM public.absence_requests
   GROUP BY request_type
),
notes_tbl AS (
  SELECT 'notes' AS kind,
         'absence_request_notes' AS name,
         'rls=' || relrowsecurity::text
           || ', policies=' || (SELECT count(*) FROM pg_policies
                                 WHERE schemaname = 'public'
                                   AND tablename = 'absence_request_notes')::text AS detail
    FROM pg_class
   WHERE oid = 'public.absence_request_notes'::regclass
),
due_sample AS (
  SELECT 'default' AS kind,
         'default_work_due_at(2026-09-07)' AS name,
         coalesce(public.default_work_due_at('2026-09-07'::date)::text, 'NULL') AS detail
),
helper_fn AS (
  SELECT 'helper' AS kind,
         'current_user_is_instructor' AS name,
         regexp_replace(pg_get_functiondef('public.current_user_is_instructor()'::regprocedure), '\s+', ' ', 'g') AS detail
),
existing_pol AS (
  SELECT 'existing policy' AS kind,
         policyname AS name,
         cmd || ' USING(' || coalesce(qual, '') || ')'
             || coalesce(' CHECK(' || with_check || ')', '') AS detail
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'absence_requests'
)
SELECT kind, name, detail FROM cols
UNION ALL SELECT kind, name, detail FROM chks
UNION ALL SELECT kind, name, detail FROM rowsum
UNION ALL SELECT kind, name, detail FROM notes_tbl
UNION ALL SELECT kind, name, detail FROM due_sample
UNION ALL SELECT kind, name, detail FROM helper_fn
UNION ALL SELECT kind, name, detail FROM existing_pol
ORDER BY 1, 2;

ROLLBACK;
-- Dry run complete. Replace ROLLBACK with COMMIT once verified.

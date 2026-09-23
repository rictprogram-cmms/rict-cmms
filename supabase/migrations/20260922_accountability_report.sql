-- ═════════════════════════════════════════════════════════════════════════════
-- RICT CMMS — Accountability Report: data the report needs that was never stored
-- File: supabase/migrations/20260922_accountability_report.sql
--
-- Purpose
--   The Accountability Report (one page per student: sign-ups, attendance,
--   absences, work orders, equipment, volunteer hours) checks 37 things. Four
--   of them depend on facts the app never wrote down. This migration adds
--   those facts, seeds the report's settings and permissions, and touches
--   nothing else. Every step is idempotent (safe to run twice).
--
-- What it does
--   1. lab_signup.cancelled_at / cancelled_by_email
--        Stamped by a trigger whenever status flips to 'Cancelled', so all
--        three cancel paths (student grid, Admin Signup, closure cancels)
--        are covered without touching app code. Cleared if a row is ever
--        re-confirmed. cancelled_at uses the table's FAKE-UTC convention
--        (local wall-clock with +00, TIMESTAMP_CONVENTIONS.md) so it can be
--        compared with `date` + `start_time` directly.
--        One-time backfill from audit_log ('Cancel Signup' rows) for rows
--        cancelled before today — audit_log.timestamp is real UTC, so it is
--        converted to Chicago wall-clock before being stored.
--   2. time_clock.closed_by_email / closed_reason
--        Set by Time Cards when an instructor punches out a student who
--        forgot ("forgotten punch-out"). History has none; the report also
--        uses a punch-out-on-a-later-day heuristic for older rows.
--   3. reminder_acknowledgements (new table)
--        The All Done modal held reminder acknowledgements in memory only.
--        One row per student × reminder × week; the modal now writes them.
--        acknowledged_at is REAL UTC (DB default now()) — Convention B.
--        RLS: a student sees, writes and removes only their own rows
--        (un-ticking a reminder deletes the row); instructors see all
--        (current_user_is_instructor() from the 2026-09-07 migration).
--   4. Settings
--        late_cancel_hours     '24'  — cancelling a sign-up inside this many
--                                      hours of its start counts as late
--        standing_trend_weeks  '3'   — "getting worse?" compares the last N
--                                      weeks with the semester as a whole
--   5. Permissions — page 'Accountability Report'
--        view_page   student ✓  work_study ✓  instructor ✓
--        view_own    student ✓  work_study ✓  instructor ✓
--        view_all    student ✗  work_study ✗  instructor ✓
--        export      student ✓  work_study ✓  instructor ✓
--        view_notes  student ✗  work_study ✗  instructor ✓  (absence notes)
--
-- Deploy order
--   Run this FIRST (before the app files go live). The app reads the new
--   columns with graceful fallbacks, but the settings + permission rows
--   must exist for the page to be visible in the sidebar.
--
-- Dry run: ends in ROLLBACK. Read the verification result set, then swap
-- the final ROLLBACK for COMMIT and run again.
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 1: lab_signup cancellation stamp
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.lab_signup
  ADD COLUMN IF NOT EXISTS cancelled_at       timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by_email text;

COMMENT ON COLUMN public.lab_signup.cancelled_at IS
  'When status became Cancelled. FAKE-UTC (local wall-clock with +00), same as date/start_time. Set by trg_lab_signup_stamp_cancel.';
COMMENT ON COLUMN public.lab_signup.cancelled_by_email IS
  'Lower-cased email of whoever cancelled (JWT email at the time). NULL when unknown (legacy rows, service-role jobs).';

CREATE OR REPLACE FUNCTION public.lab_signup_stamp_cancel()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_email text;
BEGIN
  IF NEW.status = 'Cancelled' AND coalesce(OLD.status, '') <> 'Cancelled' THEN
    -- Fake-UTC "now": Chicago wall-clock stamped +00 (TIMESTAMP_CONVENTIONS.md, Convention A)
    IF NEW.cancelled_at IS NULL THEN
      NEW.cancelled_at := (to_char(now() AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD"T"HH24:MI:SS') || '+00')::timestamptz;
    END IF;
    IF NEW.cancelled_by_email IS NULL THEN
      BEGIN
        v_email := lower(nullif(btrim(coalesce(auth.jwt() ->> 'email', '')), ''));
      EXCEPTION WHEN OTHERS THEN
        v_email := NULL;   -- no JWT in this context (service role / SQL editor)
      END;
      NEW.cancelled_by_email := v_email;
    END IF;
  ELSIF NEW.status <> 'Cancelled' AND coalesce(OLD.status, '') = 'Cancelled' THEN
    -- Re-confirmed: the cancellation never "happened" for reporting purposes
    NEW.cancelled_at := NULL;
    NEW.cancelled_by_email := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_lab_signup_stamp_cancel ON public.lab_signup;
CREATE TRIGGER trg_lab_signup_stamp_cancel
  BEFORE UPDATE OF status ON public.lab_signup
  FOR EACH ROW
  EXECUTE FUNCTION public.lab_signup_stamp_cancel();

-- Backfill from audit_log: latest 'Cancel Signup' row per signup. audit_log.timestamp
-- is real UTC → convert to Chicago wall-clock and stamp +00 (fake-UTC).
WITH latest AS (
  SELECT DISTINCT ON (a.entity_id)
         a.entity_id,
         a.timestamp,
         a.user_email
    FROM public.audit_log a
   WHERE a.entity_type = 'Lab Signup'
     AND a.action = 'Cancel Signup'
     AND a.entity_id IS NOT NULL
   ORDER BY a.entity_id, a.timestamp DESC
)
UPDATE public.lab_signup s
   SET cancelled_at = (to_char(l.timestamp AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD"T"HH24:MI:SS') || '+00')::timestamptz,
       cancelled_by_email = lower(nullif(btrim(l.user_email), ''))
  FROM latest l
 WHERE s.signup_id = l.entity_id
   AND s.status = 'Cancelled'
   AND s.cancelled_at IS NULL;

CREATE INDEX IF NOT EXISTS lab_signup_email_status_idx
  ON public.lab_signup (lower(user_email), status);

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 2: time_clock forgotten-punch-out stamp
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.time_clock
  ADD COLUMN IF NOT EXISTS closed_by_email text,
  ADD COLUMN IF NOT EXISTS closed_reason   text;

COMMENT ON COLUMN public.time_clock.closed_by_email IS
  'Email of the instructor who punched this entry out on the student''s behalf (Time Cards "forgot to punch out"). NULL for normal punch-outs.';
COMMENT ON COLUMN public.time_clock.closed_reason IS
  'Why an instructor closed the entry, e.g. forgot_punch_out. NULL for normal punch-outs.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 3: reminder_acknowledgements
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.reminder_acknowledgements (
  ack_id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_email        text NOT NULL,
  reminder_id       text NOT NULL,
  week_start        date NOT NULL,             -- Monday of the lab week
  acknowledged_at   timestamptz NOT NULL DEFAULT now(),   -- REAL UTC (Convention B)
  acknowledged_via  text NOT NULL DEFAULT 'all_done_modal',
  class_id          text,                      -- reminder scope at the time (informational)
  CONSTRAINT reminder_acknowledgements_email_check CHECK (btrim(user_email) <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS reminder_ack_unique_idx
  ON public.reminder_acknowledgements (lower(user_email), reminder_id, week_start);

CREATE INDEX IF NOT EXISTS reminder_ack_email_week_idx
  ON public.reminder_acknowledgements (lower(user_email), week_start);

COMMENT ON TABLE public.reminder_acknowledgements IS
  'A student acknowledged a weekly reminder (All Done modal) for a given lab week. Read by the Accountability Report.';

ALTER TABLE public.reminder_acknowledgements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS reminder_ack_select ON public.reminder_acknowledgements;
DROP POLICY IF EXISTS reminder_ack_insert ON public.reminder_acknowledgements;
DROP POLICY IF EXISTS reminder_ack_delete ON public.reminder_acknowledgements;

CREATE POLICY reminder_ack_select
  ON public.reminder_acknowledgements FOR SELECT TO authenticated
  USING (
    lower(user_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    OR public.current_user_is_instructor()
  );

CREATE POLICY reminder_ack_insert
  ON public.reminder_acknowledgements FOR INSERT TO authenticated
  WITH CHECK (
    lower(user_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    OR public.current_user_is_instructor()
  );

CREATE POLICY reminder_ack_delete
  ON public.reminder_acknowledgements FOR DELETE TO authenticated
  USING (
    lower(user_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    OR public.current_user_is_instructor()
  );

GRANT SELECT, INSERT, DELETE ON public.reminder_acknowledgements TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 4: settings
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO public.settings (setting_key, setting_value, description, category, updated_at, updated_by)
SELECT 'late_cancel_hours', '24',
       'Accountability Report — cancelling a lab sign-up inside this many hours of its start counts as a late cancellation.',
       'Accountability Report', now(), 'migration'
WHERE NOT EXISTS (SELECT 1 FROM public.settings WHERE setting_key = 'late_cancel_hours');

INSERT INTO public.settings (setting_key, setting_value, description, category, updated_at, updated_by)
SELECT 'standing_trend_weeks', '3',
       'Accountability Report — how many recent weeks to compare against the semester when flagging a worsening trend.',
       'Accountability Report', now(), 'migration'
WHERE NOT EXISTS (SELECT 1 FROM public.settings WHERE setting_key = 'standing_trend_weeks');

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 5: permissions (page 'Accountability Report')
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_next integer;
  r record;
BEGIN
  SELECT coalesce(max(nullif(regexp_replace(permission_id, '\D', '', 'g'), '')::integer), 0) + 1
    INTO v_next FROM public.permissions;

  FOR r IN
    SELECT * FROM (VALUES
      ('view_page',  true,  true,  true,  'Can open the Accountability Report page'),
      ('view_own',   true,  true,  true,  'Can see their own Accountability Report'),
      ('view_all',   false, false, true,  'Can pick any student or class and see every student''s Accountability Report'),
      ('export',     true,  true,  true,  'Can export the report (CSV / Excel / print)'),
      ('view_notes', false, false, true,  'Can see instructor-only absence notes on the report')
    ) AS t(feature, student, work_study, instructor, description)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM public.permissions WHERE page = 'Accountability Report' AND feature = r.feature) THEN
      INSERT INTO public.permissions
        (permission_id, page, feature, student, work_study, instructor, description, updated_at, updated_by)
      VALUES ('P' || v_next, 'Accountability Report', r.feature, r.student, r.work_study, r.instructor, r.description, now(), 'migration');
      v_next := v_next + 1;
    END IF;
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification (single result set — the SQL Editor shows only the last statement)
--
-- Expect:
--   column    → 4 rows: lab_signup.cancelled_at, lab_signup.cancelled_by_email,
--               time_clock.closed_by_email, time_clock.closed_reason
--   trigger   → trg_lab_signup_stamp_cancel on lab_signup
--   backfill  → count of Cancelled rows now stamped vs still unstamped
--   table     → reminder_acknowledgements, rls = true, 3 policies
--   setting   → late_cancel_hours = 24, standing_trend_weeks = 3
--   permission→ 5 rows for page 'Accountability Report'
-- ─────────────────────────────────────────────────────────────────────────────

SELECT 'column' AS kind, table_name || '.' || column_name AS name, data_type AS detail
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND ((table_name = 'lab_signup' AND column_name IN ('cancelled_at', 'cancelled_by_email'))
     OR (table_name = 'time_clock' AND column_name IN ('closed_by_email', 'closed_reason')))
UNION ALL
SELECT 'trigger', tgname, 'lab_signup'
  FROM pg_trigger
 WHERE tgname = 'trg_lab_signup_stamp_cancel' AND NOT tgisinternal
UNION ALL
SELECT 'backfill', 'cancelled rows stamped', count(*)::text
  FROM public.lab_signup WHERE status = 'Cancelled' AND cancelled_at IS NOT NULL
UNION ALL
SELECT 'backfill', 'cancelled rows without stamp (no audit row)', count(*)::text
  FROM public.lab_signup WHERE status = 'Cancelled' AND cancelled_at IS NULL
UNION ALL
SELECT 'table', c.relname,
       'rls=' || c.relrowsecurity::text || ' policies=' ||
       (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname)::text
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname = 'reminder_acknowledgements'
UNION ALL
SELECT 'setting', setting_key, setting_value
  FROM public.settings WHERE setting_key IN ('late_cancel_hours', 'standing_trend_weeks')
UNION ALL
SELECT 'permission', permission_id || ' ' || feature,
       'student=' || student::text || ' ws=' || work_study::text || ' instr=' || instructor::text
  FROM public.permissions WHERE page = 'Accountability Report'
ORDER BY 1, 2;

ROLLBACK;   -- ← swap for COMMIT after checking the verification output

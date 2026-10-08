-- ═══════════════════════════════════════════════════════════════════════════
-- 20261007_absence_work_turned_in.sql
--
-- Late Submission requests can now be filed BEFORE the work is turned in
-- (e.g. a student leaving for Guard duty who already knows the work will be
-- late). The form asks "Has the work been turned in yet?"; this column
-- records the answer.
--
--   work_turned_in = true   (default) absence_date = the date it was turned in
--   work_turned_in = false  absence_date = the date of the request; it may be
--                           before due_date. week_start = Monday of the later
--                           of absence_date and due_date (set by the app).
--
-- Additive only. Every existing row is a turned-in late submission or an
-- absence, so DEFAULT true is correct for all of them — no backfill needed.
-- No RLS change: the column inherits absence_requests' existing policies and
-- grants. The app tolerates this not having run (it infers from the dates).
--
-- DRY RUN: ends in ROLLBACK. Check the verification rows, then change the
-- last line to COMMIT and run again.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE public.absence_requests
  ADD COLUMN IF NOT EXISTS work_turned_in boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.absence_requests.work_turned_in IS
  'Late Submission only. false = filed before the work was turned in; absence_date is then the date of the request (may be before due_date). Always true for Absence rows.';

COMMENT ON COLUMN public.absence_requests.request_type IS
  'Absence | Late Submission. For Late Submission: absence_date = date turned in (or date of request when work_turned_in = false), hours_missed = additional lab hours requested (0 allowed).';

-- Absences are never "not yet turned in".
ALTER TABLE public.absence_requests
  DROP CONSTRAINT IF EXISTS absence_requests_work_turned_in_check;
ALTER TABLE public.absence_requests
  ADD CONSTRAINT absence_requests_work_turned_in_check
  CHECK (work_turned_in OR request_type = 'Late Submission') NOT VALID;
ALTER TABLE public.absence_requests
  VALIDATE CONSTRAINT absence_requests_work_turned_in_check;

-- Make PostgREST see the new column right away.
NOTIFY pgrst, 'reload schema';

-- ── Verification ───────────────────────────────────────────────────────────
-- Expect: one row, data_type boolean, is_nullable NO, default true.
SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'absence_requests'
   AND column_name = 'work_turned_in';

-- Expect: every row true (nothing has been filed ahead of time yet).
SELECT request_type, work_turned_in, count(*)
  FROM public.absence_requests
 GROUP BY 1, 2 ORDER BY 1, 2;

-- Expect: one row, convalidated = true.
SELECT conname, convalidated
  FROM pg_constraint
 WHERE conname = 'absence_requests_work_turned_in_check';

ROLLBACK;

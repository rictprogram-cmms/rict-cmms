-- ═══════════════════════════════════════════════════════════════════════════
-- 20261029_absence_work_not_complete.sql
--
-- "Work not complete" outcome on the Absence / Late Request page.
--
-- Until now an approved request's work had one stored outcome — Work
-- received — and "Past due — score 0" was derived from new_due_at. There was
-- no way to CLOSE a past-due request: it stayed on the list forever, still
-- inviting "Tick Work received if you choose to accept it."
--
--   work_not_complete       true  = instructor closed it: the work was not
--                                   done on time, it scores 0 and is no
--                                   longer accepted
--   work_not_complete_by    instructor full name
--   work_not_complete_date  when it was closed (fake-UTC, localToUtcIso())
--
-- Work received and Work not complete are mutually exclusive (CHECK below).
-- The app only offers Work not complete once new_due_at has passed.
--
-- Archiving is DERIVED in the app (isArchived in useAbsenceRequests.js),
-- never stored: Rejected, or Approved with the work closed (received / not
-- complete) and any owed lab time complete. Undoing an outcome un-archives.
--
-- Additive only. DEFAULT false is correct for every existing row — no
-- backfill. No RLS change: the columns inherit absence_requests' existing
-- policies and grants. The app tolerates this not having run yet (the
-- columns read as undefined → false; marking Work not complete shows a
-- "run the migration" error).
--
-- DRY RUN: ends in ROLLBACK. Check the verification row, then change the
-- last line to COMMIT and run again. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE public.absence_requests
  ADD COLUMN IF NOT EXISTS work_not_complete      boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS work_not_complete_by   text,
  ADD COLUMN IF NOT EXISTS work_not_complete_date timestamptz;

COMMENT ON COLUMN public.absence_requests.work_not_complete IS
  'true = instructor closed the request as Work not complete: not done by new_due_at, scores 0, no longer accepted. Mutually exclusive with work_received.';
COMMENT ON COLUMN public.absence_requests.work_not_complete_by IS
  'Full name of the instructor who marked Work not complete.';
COMMENT ON COLUMN public.absence_requests.work_not_complete_date IS
  'When Work not complete was marked (fake-UTC: local wall-clock stored with +00).';

-- Never both outcomes at once.
ALTER TABLE public.absence_requests
  DROP CONSTRAINT IF EXISTS absence_requests_work_outcome_check;
ALTER TABLE public.absence_requests
  ADD CONSTRAINT absence_requests_work_outcome_check
  CHECK (NOT (work_received AND work_not_complete)) NOT VALID;
ALTER TABLE public.absence_requests
  VALIDATE CONSTRAINT absence_requests_work_outcome_check;

-- Make PostgREST see the new columns right away.
NOTIFY pgrst, 'reload schema';

-- ── Verification (single result — the SQL Editor shows only the last) ──────
-- Expect: new_columns = 3, constraint_valid = true, rows_not_complete = 0,
--         rows_total = your current request count.
SELECT
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'absence_requests'
      AND column_name IN ('work_not_complete', 'work_not_complete_by', 'work_not_complete_date'))
    AS new_columns,
  (SELECT convalidated FROM pg_constraint
    WHERE conname = 'absence_requests_work_outcome_check')
    AS constraint_valid,
  (SELECT count(*) FROM public.absence_requests WHERE work_not_complete)
    AS rows_not_complete,
  (SELECT count(*) FROM public.absence_requests)
    AS rows_total;

ROLLBACK;

-- ============================================================================
-- 20260909_time_clock_early_departure_approval.sql
--
-- Adds two columns to time_clock so attendance scoring has one authoritative
-- rule for "Left Early" instead of gating on entry_type / description text:
--
--   early_departure_approved_by  text     NULL = not approved.
--                                         Set by the kiosk "Get Instructor
--                                         Permission" flow and by the Time
--                                         Cards "Excuse early departure" toggle.
--   is_break_punch_out           boolean  true when the student chose
--                                         "Taking a break — coming back" at
--                                         the kiosk. A break that is still the
--                                         day's last punch-out on a past date
--                                         is treated as an early departure.
--
-- Backfill: existing instructor-approved early departures were recorded only
-- as a description note ("Early departure approved by <name>"). Copy that name
-- into the new column so no historical approval becomes a penalty under the
-- new rule.
--
-- DRY RUN: ends with ROLLBACK. Confirm the verification SELECT, then swap the
-- final ROLLBACK for COMMIT.
-- ============================================================================

BEGIN;

ALTER TABLE public.time_clock
  ADD COLUMN IF NOT EXISTS early_departure_approved_by text NULL,
  ADD COLUMN IF NOT EXISTS is_break_punch_out boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.time_clock.early_departure_approved_by IS
  'Instructor who approved/excused an early departure for this punch. NULL = not approved. Scoring skips the Left Early penalty when set.';
COMMENT ON COLUMN public.time_clock.is_break_punch_out IS
  'true when the student punched out via "Taking a break — coming back" at the kiosk. Not penalized unless it remains the last punch-out of a past day.';

-- Backfill from the legacy description note. The note is appended as
-- "... | Early departure approved by Aaron B." and may itself be followed by
-- another " | ..." segment, so capture up to the next pipe.
UPDATE public.time_clock
SET early_departure_approved_by = COALESCE(
      NULLIF(btrim(substring(description from 'Early departure approved by ([^|]+)')), ''),
      'Instructor (backfilled)'
    )
WHERE early_departure_approved_by IS NULL
  AND description ILIKE '%Early departure approved by%';

-- Single verification SELECT (Supabase SQL Editor shows only the last result).
SELECT
  (SELECT count(*) FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'time_clock'
       AND column_name IN ('early_departure_approved_by', 'is_break_punch_out'))      AS new_columns_expect_2,
  (SELECT count(*) FROM public.time_clock
     WHERE description ILIKE '%Early departure approved by%')                          AS legacy_note_rows,
  (SELECT count(*) FROM public.time_clock
     WHERE early_departure_approved_by IS NOT NULL)                                    AS backfilled_rows,
  (SELECT string_agg(DISTINCT early_departure_approved_by, ' / ')
     FROM public.time_clock WHERE early_departure_approved_by IS NOT NULL)             AS approver_names,
  (SELECT count(*) FROM public.time_clock WHERE is_break_punch_out)                    AS break_rows_expect_0;

ROLLBACK;
-- COMMIT;

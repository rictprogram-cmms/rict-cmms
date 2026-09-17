-- ═══════════════════════════════════════════════════════════════════════════
-- RICT CMMS — Retire the Weekly Labs Tracker: classes.tracking_type → 'None'
-- File: supabase/migrations/20260916_retire_weekly_lab_tracker.sql
--
-- Purpose
--   Labs are tracked in D2L now. The Weekly Labs Tracker page is retired and
--   the "All Done" instructor swipe has moved to the Time Cards page. The
--   app no longer reads classes.tracking_type (every class behaves as 'None':
--   no weekly_lab_tracker rows are written; the time_clock 'All Done' marker
--   is the single signal). This migration makes the data match the code so
--   nothing else — reports, exports, a future query — is misled by stale
--   'Weekly' / 'Daily' values.
--
--   Nothing is dropped. weekly_lab_tracker rows stay for historical Time
--   Cards reports, the tracking_type column stays (Settings writes 'None'
--   on every save), and the 'Weekly Labs' permission rows stay (unused).
--
-- Contents
--   1. UPDATE classes SET tracking_type = 'None' where it isn't already
--   2. Consolidated verification SELECT (last statement before ROLLBACK)
--
-- DRY RUN: ends with ROLLBACK. Swap to COMMIT after the verification output
-- looks right.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ───────────────────────────────────────────────────────────────────────────
-- Section 1: normalise tracking_type
-- ───────────────────────────────────────────────────────────────────────────
UPDATE public.classes
   SET tracking_type = 'None'
 WHERE tracking_type IS DISTINCT FROM 'None';

-- ───────────────────────────────────────────────────────────────────────────
-- Section 2: verification (single SELECT — last statement before ROLLBACK)
-- ───────────────────────────────────────────────────────────────────────────
SELECT
  (SELECT count(*) FROM public.classes)                                        AS total_classes,
  (SELECT count(*) FROM public.classes WHERE tracking_type = 'None')           AS now_none,        -- expect = total_classes
  (SELECT count(*) FROM public.classes WHERE tracking_type IS DISTINCT FROM 'None') AS still_other, -- expect 0
  (SELECT count(*) FROM public.weekly_lab_tracker)                             AS tracker_rows_kept,
  (SELECT count(*) FROM public.time_clock WHERE entry_type = 'All Done')       AS all_done_markers_so_far;

ROLLBACK;

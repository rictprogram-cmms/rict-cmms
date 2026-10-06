-- ═══════════════════════════════════════════════════════════════════════════
-- RICT CMMS — announcements.notification_type may be blank again
-- File: supabase/migrations/20261006_announcements_notification_type_nullable.sql
--
-- Bug (2026-10-06)
--   Compose Message → Send failed for instructors with
--     23502  null value in column "notification_type" of relation
--            "announcements" violates not-null constraint
--   The app has always sent notification_type = NULL for an instructor's
--   ordinary message (only student messages and system notices carry a type).
--   The column picked up a NOT NULL constraint outside version control, so
--   every Compose Message send by an instructor is refused. (The Users page
--   "Message" button omits the column, so it gets the default 'announcement'
--   and was never affected.)
--
-- Fix
--   Drop the NOT NULL. Nothing else changes: existing rows, any default,
--   RLS, triggers (push, watch) are untouched. Re-runnable.
--
-- Convention
--   Ends in ROLLBACK for a dry run. Swap to COMMIT once the verification
--   SELECT shows row 1 = YES and row 4 = 1. The test insert never fires a
--   push (pg_net's queue is rolled back with the transaction).
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE public.announcements ALTER COLUMN notification_type DROP NOT NULL;

-- ───────────────────────────────────────────────────────────────────────────
-- Verification (single SELECT — the SQL Editor shows only the last result)
--   Row 1: the column now allows NULL.
--   Row 2: FYI — the column default (if someone added one).
--   Row 3: FYI — other announcements columns that are NOT NULL with no
--          default (anything listed here could refuse a send the same way).
--   Row 4: a real instructor-style insert (NULL type) succeeds
--          (inside this transaction, so it disappears on ROLLBACK).
-- ───────────────────────────────────────────────────────────────────────────
WITH probe AS (
  INSERT INTO public.announcements
    (recipient_email, sender_email, sender_name, subject, body, created_at, read, notification_type)
  VALUES
    ('dry-run@example.invalid', 'dry-run@example.invalid', 'Dry R.', 'dry run', 'dry run', now(), false, NULL)
  RETURNING 1
)
SELECT 1 AS n, 'notification_type allows NULL' AS check_name, 'YES' AS expected,
       (SELECT is_nullable FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'announcements'
           AND column_name = 'notification_type') AS actual
UNION ALL
SELECT 2, 'notification_type default (FYI)', '(any)',
       coalesce((SELECT column_default FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'announcements'
                    AND column_name = 'notification_type'), '(none)')
UNION ALL
SELECT 3, 'other NOT NULL columns without a default (FYI)', '(any)',
       coalesce((SELECT string_agg(column_name, ', ' ORDER BY ordinal_position)
                   FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'announcements'
                    AND is_nullable = 'NO' AND column_default IS NULL), '(none)')
UNION ALL
SELECT 4, 'instructor-style insert with NULL type', '1',
       (SELECT count(*)::text FROM probe)
ORDER BY n;

-- ROLLBACK;
COMMIT;   -- applied 2026-10-06 after dry run passed

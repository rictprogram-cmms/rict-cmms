-- ═════════════════════════════════════════════════════════════════════════════
-- RICT CMMS — Help requests: record when a request was actually cleared
-- File: supabase/migrations/20260922_help_request_resolved.sql
--
-- Purpose
--   help_requests already records requested_at (student raised a hand) and
--   acknowledged_at / acknowledged_by (instructor pressed "On My Way"). It
--   never recorded when the request was CLEARED: the student's click on the
--   green help button wrote status = 'cancelled' (same value as abandoning a
--   pending request) with no timestamp, and the 30-minute auto-expire is not
--   a "helped" signal. The Accountability Report needs both intervals:
--     requested_at → acknowledged_at   (how long the student waited)
--     acknowledged_at → resolved_at    (how long until it was cleared)
--
-- What it does
--   1. Adds resolved_at (REAL UTC, Convention B — same as requested_at and
--      acknowledged_at, which are written with toISOString()) and
--      resolved_by ('student' or an instructor name).
--   2. If a CHECK constraint limits `status`, widens it to allow 'resolved'
--      (no-op when there is no such constraint).
--   3. Index for the per-student term read.
--   No backfill: nothing in history says when a request was cleared.
--
-- App change that goes with it: the student's click on an ACKNOWLEDGED
-- request now writes status = 'resolved' + resolved_at; a click on a
-- still-pending request keeps writing 'cancelled'.
--
-- Dry run: ends in ROLLBACK. Check the verification rows, swap for COMMIT.
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE public.help_requests
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS resolved_by text;

COMMENT ON COLUMN public.help_requests.resolved_at IS
  'When the request was cleared as helped (student clicked the green help button). REAL UTC like requested_at / acknowledged_at. NULL for cancelled / expired / dismissed.';
COMMENT ON COLUMN public.help_requests.resolved_by IS
  '''student'' when the student cleared it; an instructor name if cleared from the bell in future.';

-- Widen a status CHECK constraint if one exists (names vary — find it by definition)
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conname, pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public' AND t.relname = 'help_requests' AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) ILIKE '%status%'
       AND pg_get_constraintdef(c.oid) NOT ILIKE '%resolved%'
  LOOP
    EXECUTE format('ALTER TABLE public.help_requests DROP CONSTRAINT %I', r.conname);
    EXECUTE format(
      'ALTER TABLE public.help_requests ADD CONSTRAINT %I CHECK (status = ANY (ARRAY[%L,%L,%L,%L,%L,%L]))',
      r.conname, 'pending', 'acknowledged', 'resolved', 'cancelled', 'expired', 'dismissed');
    RAISE NOTICE 'Widened % to allow resolved', r.conname;
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS help_requests_email_requested_idx
  ON public.help_requests (lower(user_email), requested_at);

-- ── Verification (single result set) ─────────────────────────────────────────
-- Expect: 2 column rows; constraint row(s) only if a status CHECK existed
-- (its definition should now include 'resolved'); a status breakdown of
-- existing rows so you can see what history looks like.
SELECT 'column' AS kind, column_name AS name, data_type AS detail
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'help_requests'
   AND column_name IN ('resolved_at', 'resolved_by')
UNION ALL
SELECT 'constraint', c.conname, pg_get_constraintdef(c.oid)
  FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
 WHERE n.nspname = 'public' AND t.relname = 'help_requests' AND c.contype = 'c'
UNION ALL
SELECT 'status', coalesce(status, '(null)'), count(*)::text
  FROM public.help_requests GROUP BY status
UNION ALL
SELECT 'acknowledged', 'rows with acknowledged_at', count(*)::text
  FROM public.help_requests WHERE acknowledged_at IS NOT NULL
ORDER BY 1, 2;

ROLLBACK;   -- ← swap for COMMIT after checking the verification output

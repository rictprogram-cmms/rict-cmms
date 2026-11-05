-- ═════════════════════════════════════════════════════════════════════════════
-- RICT CMMS — Orders: "Not charged to budget" (paid out of pocket, etc.)
-- File: supabase/migrations/20261105_orders_budget_excluded.sql
--
-- Purely ADDITIVE. Adds four optional columns to public.orders:
--   • budget_excluded_reason  text — NULL = counts against the program budget
--       (normal). Otherwise one of:
--         'Paid out of pocket' | 'Donated' | 'Paid from another account'
--       A marked order is left out of every Program Budget figure and is never
--       suggested as a link when a college report is imported. Its total is
--       kept, so the CMMS still records what was actually spent.
--   • budget_excluded_note    text — optional free text
--   • budget_excluded_by      text — who marked it (display name)
--   • budget_excluded_at      timestamptz — when (fake-UTC, written by the app)
--
-- RUN THIS (with COMMIT) BEFORE PUSHING THE MATCHING CODE: the new code reads
-- these columns, so the Program Budget page would not load without them.
--
-- Dry run: ends in ROLLBACK. Every verification row should show ok = true.
-- Then change the last line to COMMIT and run again.
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS budget_excluded_reason text,
  ADD COLUMN IF NOT EXISTS budget_excluded_note   text,
  ADD COLUMN IF NOT EXISTS budget_excluded_by     text,
  ADD COLUMN IF NOT EXISTS budget_excluded_at     timestamptz;

ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_budget_excluded_reason_chk;
ALTER TABLE public.orders
  ADD CONSTRAINT orders_budget_excluded_reason_chk
    CHECK (budget_excluded_reason IS NULL
           OR budget_excluded_reason IN ('Paid out of pocket', 'Donated', 'Paid from another account'));

-- ── Verification (single result table) ───────────────────────────────────────
SELECT check_name, ok, detail FROM (
  SELECT 1 AS n, 'new orders columns (4)' AS check_name,
         count(*) = 4 AS ok, string_agg(column_name || ' ' || data_type, ', ' ORDER BY column_name) AS detail
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'orders'
    AND column_name IN ('budget_excluded_reason', 'budget_excluded_note',
                        'budget_excluded_by', 'budget_excluded_at')
  UNION ALL
  SELECT 2, 'reason check constraint',
         count(*) = 1, string_agg(pg_get_constraintdef(oid), ' ')
  FROM pg_constraint
  WHERE conrelid = 'public.orders'::regclass AND conname = 'orders_budget_excluded_reason_chk'
  UNION ALL
  SELECT 3, 'existing orders untouched (all NULL = still counted)',
         count(*) FILTER (WHERE budget_excluded_reason IS NOT NULL) = 0,
         count(*)::text || ' orders checked'
  FROM public.orders
  UNION ALL
  SELECT 4, 'earlier budget migration present (orders.college_po)',
         count(*) = 1, CASE WHEN count(*) = 1 THEN 'found' ELSE 'run 20261105_budget_college_ledger.sql first' END
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'college_po'
) v
ORDER BY n;

ROLLBACK;
-- COMMIT;

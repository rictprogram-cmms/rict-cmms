-- ═════════════════════════════════════════════════════════════════════════════
-- RICT CMMS — Program Budget: college ledger, encumbrances, release requests
-- File: supabase/migrations/20261105_budget_college_ledger.sql
--
-- Step 1 of the Program Budget rework. Purely ADDITIVE — no column is removed,
-- renamed or retyped, and the app keeps working unchanged after this runs.
--
-- What this adds
--   program_budget
--     • paid_amount           numeric, default 0
--         Amount the business office has paid so far on an encumbered line
--         (the printout's "Partial Paid" column, e.g. Vestis $146.72 of $900).
--         Open encumbrance = amount − paid_amount.
--     • linked_order_ids      text[], default '{}'
--         CMMS orders (ORD####) covered by this college line. One line can
--         cover several orders and one order can be split over several lines.
--         A linked order stops counting on its own in the balance.
--     • source                'manual' | 'college_report', default 'manual'
--         Lines imported from the college printout are updated (not
--         duplicated) by later imports; manual entries are never touched.
--     • report_as_of          date — "Balanced as of" date of the printout
--                             that last created/updated the line.
--     • release_requested_at  timestamptz (fake-UTC, written by the app)
--     • release_requested_by  text
--     • release_amount        numeric — how much was asked to be released
--     • release_note          text
--         "Release requested" flag on an open encumbrance. Cleared by the app
--         when a later printout shows the line reduced or liquidated.
--     • CHECK on payment_status: NULL, Paid, Encumbered, Partial, Pending,
--       Liquidated (the four the app already uses + Liquidated for "Liq").
--     • CHECK on source and on non-negative paid_amount / release_amount.
--     • Indexes: (school_year, reference) for college-PO lookups, GIN on
--       linked_order_ids.
--
--   orders
--     • college_po            text — optional college PO number typed on the
--         order once the business office issues it. Lets the importer link
--         the order exactly instead of suggesting a match. Indexed.
--
--   Deleting an order
--     • AFTER DELETE trigger on orders removes that order id from any
--       program_budget.linked_order_ids, so a college line never points at a
--       deleted order. (The app's old "delete budget rows whose reference =
--       order id" step is replaced in the code change that follows.)
--       private.budget_unlink_order(text) does the work; the trigger calls it.
--
-- Existing data: 1 row (2026-2027 Starting Balance) — payment_status NULL,
-- passes the new CHECK. Every other row in other years is checked too
-- (verification row "existing payment_status values valid").
--
-- Dry run: ends in ROLLBACK. Every verification row should show ok = true.
-- Then change the last line to COMMIT and run again.
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── program_budget: new columns ──────────────────────────────────────────────
ALTER TABLE public.program_budget
  ADD COLUMN IF NOT EXISTS paid_amount          numeric     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS linked_order_ids     text[]      NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS source               text        NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS report_as_of         date,
  ADD COLUMN IF NOT EXISTS release_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS release_requested_by text,
  ADD COLUMN IF NOT EXISTS release_amount       numeric,
  ADD COLUMN IF NOT EXISTS release_note         text;

-- ── program_budget: checks ───────────────────────────────────────────────────
ALTER TABLE public.program_budget
  DROP CONSTRAINT IF EXISTS program_budget_payment_status_chk,
  DROP CONSTRAINT IF EXISTS program_budget_source_chk,
  DROP CONSTRAINT IF EXISTS program_budget_amounts_chk;

ALTER TABLE public.program_budget
  ADD CONSTRAINT program_budget_payment_status_chk
    CHECK (payment_status IS NULL
           OR payment_status IN ('Paid', 'Encumbered', 'Partial', 'Pending', 'Liquidated')),
  ADD CONSTRAINT program_budget_source_chk
    CHECK (source IN ('manual', 'college_report')),
  ADD CONSTRAINT program_budget_amounts_chk
    CHECK (paid_amount >= 0 AND (release_amount IS NULL OR release_amount >= 0));

-- ── program_budget: indexes ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS program_budget_year_ref_idx
  ON public.program_budget (school_year, reference);
CREATE INDEX IF NOT EXISTS program_budget_linked_orders_idx
  ON public.program_budget USING gin (linked_order_ids);

-- ── orders: college PO number ────────────────────────────────────────────────
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS college_po text;
CREATE INDEX IF NOT EXISTS orders_college_po_idx
  ON public.orders (college_po);

-- ── Unlink a deleted order from budget lines ─────────────────────────────────
CREATE OR REPLACE FUNCTION private.budget_unlink_order(p_order_id text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.program_budget
     SET linked_order_ids = array_remove(linked_order_ids, p_order_id)
   WHERE linked_order_ids @> ARRAY[p_order_id];
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION private.budget_unlink_order(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.orders_unlink_budget_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM private.budget_unlink_order(OLD.order_id);
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS orders_unlink_budget ON public.orders;
CREATE TRIGGER orders_unlink_budget
  AFTER DELETE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION private.orders_unlink_budget_trigger();

-- ── Self-test of the unlink (test row removed again below) ───────────────────
-- Uses a throw-away program_budget row only; no order is inserted, so the
-- push-orders webhook never fires.
CREATE TEMP TABLE _budget_mig_check ON COMMIT DROP AS
WITH ins AS (
  INSERT INTO public.program_budget
    (school_year, type, description, amount, source, linked_order_ids, status)
  VALUES
    ('MIGRATION-TEST', 'Manual Expense', 'migration self-test', 0,
     'college_report', ARRAY['ORD_TEST_A', 'ORD_TEST_B'], 'Voided')
  RETURNING id
)
SELECT id FROM ins;

SELECT private.budget_unlink_order('ORD_TEST_A');

CREATE TEMP TABLE _budget_mig_result ON COMMIT DROP AS
SELECT pb.linked_order_ids AS after_unlink
FROM public.program_budget pb
JOIN _budget_mig_check c ON c.id = pb.id;

DELETE FROM public.program_budget pb
USING _budget_mig_check c
WHERE pb.id = c.id;

-- ── Verification (single result table) ───────────────────────────────────────
SELECT check_name, ok, detail FROM (
  SELECT 1 AS n, 'new program_budget columns (8)' AS check_name,
         count(*) = 8 AS ok, string_agg(column_name, ', ' ORDER BY column_name) AS detail
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'program_budget'
    AND column_name IN ('paid_amount', 'linked_order_ids', 'source', 'report_as_of',
                        'release_requested_at', 'release_requested_by',
                        'release_amount', 'release_note')
  UNION ALL
  SELECT 2, 'orders.college_po column',
         count(*) = 1, string_agg(data_type, ', ')
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'college_po'
  UNION ALL
  SELECT 3, 'check constraints (3)',
         count(*) = 3, string_agg(conname, ', ' ORDER BY conname)
  FROM pg_constraint
  WHERE conrelid = 'public.program_budget'::regclass
    AND conname IN ('program_budget_payment_status_chk', 'program_budget_source_chk',
                    'program_budget_amounts_chk')
  UNION ALL
  SELECT 4, 'indexes (3)',
         count(*) = 3, string_agg(indexname, ', ' ORDER BY indexname)
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND indexname IN ('program_budget_year_ref_idx', 'program_budget_linked_orders_idx',
                      'orders_college_po_idx')
  UNION ALL
  SELECT 5, 'orders_unlink_budget trigger',
         count(*) = 1, string_agg(action_timing || ' ' || event_manipulation, ', ')
  FROM information_schema.triggers
  WHERE event_object_schema = 'public' AND event_object_table = 'orders'
    AND trigger_name = 'orders_unlink_budget'
  UNION ALL
  SELECT 6, 'unlink removes only the deleted order',
         coalesce(bool_and(after_unlink = ARRAY['ORD_TEST_B']), false),
         coalesce(string_agg(array_to_string(after_unlink, ','), '; '), 'no test row')
  FROM _budget_mig_result
  UNION ALL
  SELECT 7, 'self-test row removed',
         count(*) = 0, count(*)::text || ' left'
  FROM public.program_budget WHERE school_year = 'MIGRATION-TEST'
  UNION ALL
  SELECT 8, 'existing payment_status values valid',
         count(*) FILTER (WHERE payment_status IS NOT NULL
           AND payment_status NOT IN ('Paid','Encumbered','Partial','Pending','Liquidated')) = 0,
         count(*)::text || ' rows checked'
  FROM public.program_budget
  UNION ALL
  SELECT 9, 'existing rows default to source = manual, paid 0, no links',
         bool_and(source = 'manual' AND paid_amount = 0 AND linked_order_ids = '{}'),
         count(*)::text || ' rows'
  FROM public.program_budget
  UNION ALL
  SELECT 10, 'unlink function not callable by app users',
         NOT has_function_privilege('authenticated', 'private.budget_unlink_order(text)', 'EXECUTE')
         AND NOT has_function_privilege('anon', 'private.budget_unlink_order(text)', 'EXECUTE'),
         'authenticated/anon EXECUTE revoked'
) v
ORDER BY n;

ROLLBACK;
-- COMMIT;

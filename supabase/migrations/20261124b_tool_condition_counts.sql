-- ============================================================================
-- 2026-11-24  Tool inventory, stage 2: condition counts
-- ============================================================================
-- Tools are counted by quantity, so condition is kept as counts on the tool's
-- row: how many of the total owned are worn, broken or missing. "Good" is not
-- stored; it is whatever is left:
--     good = qty_in_stock - qty_worn - qty_broken - qty_missing
-- A missing tool still counts toward the total owned (qty_in_stock).
--
-- Parts never use these columns; they stay 0 for every part.
--
-- No permission changes. The counts are saved through the existing Inventory
-- permissions: edit_items (the tool form) and adjust_quantity (Adjust).
--
-- Needs stage 1 (20261124_tool_inventory_stage1.sql) committed first.
--
-- HOW TO RUN
--   Dry run first: run as is (ends in ROLLBACK) and check that every "ok" in
--   the result grid is true. Then change the last lines to COMMIT and run
--   again. COMMIT before testing or pushing the Stage 2 code.
-- ============================================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'inventory' AND column_name = 'item_type'
  ) THEN
    RAISE EXCEPTION 'Stage 1 is not committed yet (inventory.item_type is missing). Commit 20261124_tool_inventory_stage1.sql first.';
  END IF;
END $$;

ALTER TABLE public.inventory
  ADD COLUMN IF NOT EXISTS qty_worn    integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS qty_broken  integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS qty_missing integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'inventory_condition_counts_check'
      AND conrelid = 'public.inventory'::regclass
  ) THEN
    ALTER TABLE public.inventory
      ADD CONSTRAINT inventory_condition_counts_check
      CHECK (qty_worn >= 0 AND qty_broken >= 0 AND qty_missing >= 0);
  END IF;
END $$;

COMMENT ON COLUMN public.inventory.qty_worn    IS 'Tools only: how many of qty_in_stock are worn but usable.';
COMMENT ON COLUMN public.inventory.qty_broken  IS 'Tools only: how many of qty_in_stock are broken.';
COMMENT ON COLUMN public.inventory.qty_missing IS 'Tools only: how many of qty_in_stock cannot be found. Still counted in qty_in_stock.';

-- Verification (one result grid; every "ok" should be true) ------------------
SELECT n, check_name, ok, detail FROM (
  SELECT 1 AS n, 'three condition columns exist' AS check_name,
         (SELECT count(*) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'inventory'
             AND column_name IN ('qty_worn', 'qty_broken', 'qty_missing')) = 3 AS ok,
         NULL::text AS detail
  UNION ALL
  SELECT 2, 'every existing item starts at 0 worn / broken / missing',
         NOT EXISTS (SELECT 1 FROM public.inventory
                      WHERE qty_worn <> 0 OR qty_broken <> 0 OR qty_missing <> 0),
         (SELECT count(*) FROM public.inventory)::text || ' items'
  UNION ALL
  SELECT 3, 'negative counts are refused',
         EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'inventory_condition_counts_check'
                    AND conrelid = 'public.inventory'::regclass), NULL
  UNION ALL
  SELECT 4, 'INFO: parts and tools right now', true,
         (SELECT count(*) FILTER (WHERE item_type = 'Part')::text || ' parts, '
              || count(*) FILTER (WHERE item_type = 'Tool')::text || ' tools'
            FROM public.inventory)
) v ORDER BY n;

ROLLBACK;
-- COMMIT;

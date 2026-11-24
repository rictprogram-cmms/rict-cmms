-- ============================================================================
-- 2026-11-24  Tool inventory, stage 1: tools live in the inventory table
-- ============================================================================
-- What this does
--   1. Adds inventory.item_type ('Part' or 'Tool'). Every existing row becomes
--      'Part', so nothing that works today changes.
--   2. Adds get_next_tool_id(), which hands out TL-0001, TL-0002, ... from its
--      own sequence. Part IDs (INV-) and get_next_id() are not touched.
--
-- Tools have no min/max: the app saves both as 0 for a tool, and a minimum of
-- 0 already means "never low stock" everywhere low stock is worked out.
--
-- No permission changes: tools use the existing Inventory permissions
-- (add_items, edit_items, delete_items, adjust_quantity, print_labels), and
-- the existing row rules on inventory apply to tools as they do to parts.
--
-- HOW TO RUN
--   Dry run first: run this file as it is (it ends in ROLLBACK) and check the
--   one result row. When it looks right, change the last line to COMMIT and
--   run it again.
--   Run and COMMIT this BEFORE testing or pushing the Stage 1 code: the parts
--   pickers on Purchase Orders and Work Orders filter on the new column.
-- ============================================================================

BEGIN;

-- 1. Item type -------------------------------------------------------------
ALTER TABLE public.inventory
  ADD COLUMN IF NOT EXISTS item_type text NOT NULL DEFAULT 'Part';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'inventory_item_type_check'
      AND conrelid = 'public.inventory'::regclass
  ) THEN
    ALTER TABLE public.inventory
      ADD CONSTRAINT inventory_item_type_check CHECK (item_type IN ('Part', 'Tool'));
  END IF;
END $$;

COMMENT ON COLUMN public.inventory.item_type IS
  'Part = stocked consumable with min/max and purchasing. Tool = program-owned tool counted by quantity; no min/max, kept out of purchasing and work order parts.';

-- 2. Tool IDs (TL-0001 ...) -------------------------------------------------
-- A sequence never hands out the same number twice, so a deleted tool's ID
-- (and its printed QR label) is never reused for a different tool.
CREATE SEQUENCE IF NOT EXISTS public.inventory_tool_id_seq START WITH 1 INCREMENT BY 1;

CREATE OR REPLACE FUNCTION public.get_next_tool_id()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id text;
BEGIN
  LOOP
    v_id := 'TL-' || lpad(nextval('public.inventory_tool_id_seq')::text, 4, '0');
    -- Skip any ID that somehow already exists (e.g. typed in by hand).
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.inventory WHERE part_id = v_id);
  END LOOP;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.get_next_tool_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_next_tool_id() TO authenticated;

-- 3. Verification (one result grid; every "ok" should be true) --------------
SELECT n, check_name, ok, detail FROM (
  SELECT 1 AS n, 'every existing item is a Part' AS check_name,
         (SELECT count(*) FROM public.inventory WHERE item_type = 'Part')
           = (SELECT count(*) FROM public.inventory) AS ok,
         (SELECT count(*) FROM public.inventory)::text || ' items' AS detail
  UNION ALL
  SELECT 2, 'no tools yet',
         NOT EXISTS (SELECT 1 FROM public.inventory WHERE item_type = 'Tool'), NULL
  UNION ALL
  SELECT 3, 'new items default to Part',
         (SELECT column_default FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'inventory'
             AND column_name = 'item_type') LIKE '%Part%',
         (SELECT column_default FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'inventory'
             AND column_name = 'item_type')
  UNION ALL
  SELECT 4, 'only Part or Tool is accepted',
         EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'inventory_item_type_check'
                    AND conrelid = 'public.inventory'::regclass), NULL
  UNION ALL
  SELECT 5, 'first tool ID will be TL-0001',
         (SELECT NOT is_called AND last_value = 1 FROM public.inventory_tool_id_seq),
         'TL-' || lpad((SELECT last_value FROM public.inventory_tool_id_seq)::text, 4, '0')
  UNION ALL
  SELECT 6, 'signed-in users can get a tool ID',
         has_function_privilege('authenticated', 'public.get_next_tool_id()', 'EXECUTE'), NULL
  UNION ALL
  SELECT 7, 'logged-out visitors cannot',
         NOT has_function_privilege('anon', 'public.get_next_tool_id()', 'EXECUTE'), NULL
  UNION ALL
  SELECT 8, 'INFO: no existing ID already starts with TL-',
         NOT EXISTS (SELECT 1 FROM public.inventory WHERE part_id ILIKE 'TL-%'), NULL
) v ORDER BY n;

ROLLBACK;
-- COMMIT;

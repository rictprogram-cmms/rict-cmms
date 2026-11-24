-- ============================================================================
-- 2026-11-24  Tool inventory, stage 5: tools needed on SOPs and work orders
-- ============================================================================
-- A reference list only: it says which tools a job needs. It never changes a
-- tool's quantity or condition.
--
--   sop_tools          the tools an SOP calls for (tool + how many + note).
--   work_order_tools   tools added directly to ONE work order.
--
-- A work order shows both: the tools of every SOP linked to it (including the
-- SOPs a PM-generated work order inherits) and the ones added directly. The
-- SOP tools are looked up when the work order is opened, so changing an SOP's
-- list is seen by every work order that uses that SOP.
--
-- No foreign keys: sop_id / wo_id / part_id are plain IDs, as in the other
-- sop_* link tables, and a work order keeps its list after it is closed.
--
-- Permissions (existing ones, no new permission):
--   read              anyone signed in (the lists show on SOPs and work orders)
--   sop_tools         change: SOPs -> edit_sop      (delete also: delete_sop)
--   work_order_tools  change: Work Orders -> edit_wo (delete also: delete_wo)
--
-- Needs stage 1 committed (tools are inventory rows with item_type = 'Tool').
--
-- HOW TO RUN
--   Dry run first: run as is (ends in ROLLBACK), check every "ok" is true.
--   Then change the last lines to COMMIT and run again. COMMIT before testing
--   or pushing the Stage 5 code.
-- ============================================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'inventory' AND column_name = 'item_type'
  ) THEN
    RAISE EXCEPTION 'Stage 1 is not committed yet (inventory.item_type is missing).';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.sop_tools (
  sop_id   text NOT NULL,
  part_id  text NOT NULL,                              -- the tool's ID (TL-0001)
  qty      integer NOT NULL DEFAULT 1 CHECK (qty > 0),
  note     text NOT NULL DEFAULT '',
  added_at timestamptz NOT NULL DEFAULT now(),         -- real UTC
  added_by text NOT NULL DEFAULT '',
  PRIMARY KEY (sop_id, part_id)
);

CREATE TABLE IF NOT EXISTS public.work_order_tools (
  wo_id    text NOT NULL,
  part_id  text NOT NULL,
  qty      integer NOT NULL DEFAULT 1 CHECK (qty > 0),
  note     text NOT NULL DEFAULT '',
  added_at timestamptz NOT NULL DEFAULT now(),         -- real UTC
  added_by text NOT NULL DEFAULT '',
  PRIMARY KEY (wo_id, part_id)
);

ALTER TABLE public.sop_tools        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_order_tools ENABLE ROW LEVEL SECURITY;

-- Read: any signed-in user.
DROP POLICY IF EXISTS sop_tools_select ON public.sop_tools;
CREATE POLICY sop_tools_select ON public.sop_tools FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS work_order_tools_select ON public.work_order_tools;
CREATE POLICY work_order_tools_select ON public.work_order_tools FOR SELECT TO authenticated USING (true);

-- SOP tool list: whoever can edit SOPs. Deleting an SOP also clears its list.
DROP POLICY IF EXISTS sop_tools_insert ON public.sop_tools;
CREATE POLICY sop_tools_insert ON public.sop_tools FOR INSERT TO authenticated
  WITH CHECK (public.has_perm('SOPs', 'edit_sop'));
DROP POLICY IF EXISTS sop_tools_update ON public.sop_tools;
CREATE POLICY sop_tools_update ON public.sop_tools FOR UPDATE TO authenticated
  USING (public.has_perm('SOPs', 'edit_sop'))
  WITH CHECK (public.has_perm('SOPs', 'edit_sop'));
DROP POLICY IF EXISTS sop_tools_delete ON public.sop_tools;
CREATE POLICY sop_tools_delete ON public.sop_tools FOR DELETE TO authenticated
  USING (public.has_perm('SOPs', 'edit_sop') OR public.has_perm('SOPs', 'delete_sop'));

-- Work order tools: whoever can edit work orders. Deleting a WO clears its list.
DROP POLICY IF EXISTS work_order_tools_insert ON public.work_order_tools;
CREATE POLICY work_order_tools_insert ON public.work_order_tools FOR INSERT TO authenticated
  WITH CHECK (public.has_perm('Work Orders', 'edit_wo'));
DROP POLICY IF EXISTS work_order_tools_update ON public.work_order_tools;
CREATE POLICY work_order_tools_update ON public.work_order_tools FOR UPDATE TO authenticated
  USING (public.has_perm('Work Orders', 'edit_wo'))
  WITH CHECK (public.has_perm('Work Orders', 'edit_wo'));
DROP POLICY IF EXISTS work_order_tools_delete ON public.work_order_tools;
CREATE POLICY work_order_tools_delete ON public.work_order_tools FOR DELETE TO authenticated
  USING (public.has_perm('Work Orders', 'edit_wo') OR public.has_perm('Work Orders', 'delete_wo'));

REVOKE ALL ON public.sop_tools, public.work_order_tools FROM anon;
REVOKE ALL ON public.sop_tools, public.work_order_tools FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sop_tools, public.work_order_tools TO authenticated;

-- Verification (one result grid; every "ok" should be true) ------------------
SELECT n, check_name, ok, detail FROM (
  SELECT 1 AS n, 'both tables exist' AS check_name,
         to_regclass('public.sop_tools') IS NOT NULL
           AND to_regclass('public.work_order_tools') IS NOT NULL AS ok,
         NULL::text AS detail
  UNION ALL
  SELECT 2, 'row rules are on for both',
         (SELECT bool_and(relrowsecurity) FROM pg_class
           WHERE oid IN ('public.sop_tools'::regclass, 'public.work_order_tools'::regclass)),
         (SELECT count(*)::text || ' policies' FROM pg_policies
           WHERE schemaname = 'public' AND tablename IN ('sop_tools', 'work_order_tools'))
  UNION ALL
  SELECT 3, 'logged-out visitors cannot read either table',
         NOT has_table_privilege('anon', 'public.sop_tools', 'SELECT')
           AND NOT has_table_privilege('anon', 'public.work_order_tools', 'SELECT'), NULL
  UNION ALL
  SELECT 4, 'the permissions these rules use exist',
         (SELECT count(*) FROM public.permissions
           WHERE (page = 'SOPs' AND feature IN ('edit_sop', 'delete_sop'))
              OR (page = 'Work Orders' AND feature IN ('edit_wo', 'delete_wo'))) = 4,
         (SELECT string_agg(page || ' -> ' || feature, ', ' ORDER BY page, feature) FROM public.permissions
           WHERE (page = 'SOPs' AND feature IN ('edit_sop', 'delete_sop'))
              OR (page = 'Work Orders' AND feature IN ('edit_wo', 'delete_wo')))
  UNION ALL
  SELECT 5, 'INFO: active tools that can be picked', true,
         (SELECT count(*)::text || ' tools' FROM public.inventory
           WHERE item_type = 'Tool' AND coalesce(status, 'Active') = 'Active')
) v ORDER BY n;

ROLLBACK;
-- COMMIT;

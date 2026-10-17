-- ═══════════════════════════════════════════════════════════════════════════
-- 20261017_record_pm_sop_trigger.sql
--
-- Brings the repo in line with the live database. Changes NOTHING live.
--
-- Background
--   SOPs linked to a PM (sop_pm_schedules) are copied onto each new PM work
--   order (sop_work_orders) by the trigger trg_copy_pm_sops_to_new_wo →
--   public.copy_pm_sops_to_new_wo(). That trigger was created directly in
--   Supabase and was never in the repo. 20260909_pm_autogen_copy_sops.sql
--   describes a different approach (copying inside the PM function) that is
--   NOT what runs live — live auto_generate_pm_work_orders() is the 20260901
--   body plus the 20261017_pm_rotation_in_session.sql patch.
--
--   Live check 2026-10-17: trigger present; all 5 auto-generated PM work
--   orders since Sep 1 whose PM has SOPs received them.
--
-- What this does
--   • Records the function and trigger exactly as they are live
--     (pg_get_functiondef / pg_get_triggerdef exported 2026-10-17).
--   • Creates each one ONLY IF IT IS MISSING — on the live database both
--     exist, so neither is touched. On a rebuild from the repo they appear.
--   • Re-states the grants Phase 1 set (20260928_security_phase1.sql 8b:
--     internal trigger function → service_role only). Live already matches.
--
-- The trigger also covers the manual "Generate WO" button (usePMSchedules),
-- which copies SOPs itself; ON CONFLICT DO NOTHING keeps the two from
-- clashing.
--
-- Re-runnable. Ends in ROLLBACK — check the rows, then swap for COMMIT.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── Function (only if missing) ───────────────────────────────────────────────
DO $do$
BEGIN
  IF to_regprocedure('public.copy_pm_sops_to_new_wo()') IS NOT NULL THEN
    RAISE NOTICE 'copy_pm_sops_to_new_wo() already exists — left as is.';
    RETURN;
  END IF;

  EXECUTE $fn$
CREATE FUNCTION public.copy_pm_sops_to_new_wo()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Only act on PM-generated work orders that have a pm_id
  IF NEW.is_pm = 'Yes' AND NEW.pm_id IS NOT NULL AND NEW.pm_id <> '' THEN
    INSERT INTO public.sop_work_orders (sop_id, wo_id)
    SELECT sps.sop_id, NEW.wo_id
    FROM   public.sop_pm_schedules sps
    WHERE  sps.pm_id = NEW.pm_id
    ON CONFLICT (sop_id, wo_id) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$function$
$fn$;
  RAISE NOTICE 'copy_pm_sops_to_new_wo() created.';
END
$do$;

-- ── Trigger (only if missing) ────────────────────────────────────────────────
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger
              WHERE tgname = 'trg_copy_pm_sops_to_new_wo'
                AND tgrelid = 'public.work_orders'::regclass
                AND NOT tgisinternal) THEN
    RAISE NOTICE 'trg_copy_pm_sops_to_new_wo already exists — left as is.';
    RETURN;
  END IF;

  CREATE TRIGGER trg_copy_pm_sops_to_new_wo
    AFTER INSERT ON public.work_orders
    FOR EACH ROW EXECUTE FUNCTION public.copy_pm_sops_to_new_wo();
  RAISE NOTICE 'trg_copy_pm_sops_to_new_wo created.';
END
$do$;

-- ── Grants (same as Phase 1; no change on live) ─────────────────────────────
REVOKE EXECUTE ON FUNCTION public.copy_pm_sops_to_new_wo() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.copy_pm_sops_to_new_wo() TO service_role;

-- ── Verification — every row should say ok = true ───────────────────────────
SELECT 1 AS n, 'function exists' AS check_name,
       to_regprocedure('public.copy_pm_sops_to_new_wo()') IS NOT NULL AS ok
UNION ALL
SELECT 2, 'function copies SOPs with ON CONFLICT DO NOTHING',
       position('ON CONFLICT (sop_id, wo_id) DO NOTHING'
                IN pg_get_functiondef('public.copy_pm_sops_to_new_wo()'::regprocedure)) > 0
UNION ALL
SELECT 3, 'trigger exists on work_orders and is enabled',
       EXISTS (SELECT 1 FROM pg_trigger
                WHERE tgname = 'trg_copy_pm_sops_to_new_wo'
                  AND tgrelid = 'public.work_orders'::regclass
                  AND NOT tgisinternal AND tgenabled <> 'D')
UNION ALL
SELECT 4, 'not callable by signed-in or logged-out users',
       NOT has_function_privilege('authenticated', 'public.copy_pm_sops_to_new_wo()', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'public.copy_pm_sops_to_new_wo()', 'EXECUTE')
UNION ALL
SELECT 5, 'every auto PM work order since Sep 1 got its SOPs',
       NOT EXISTS (
         SELECT 1 FROM audit_log a
          WHERE a.action = 'Auto-Generate PM WO'
            AND a.timestamp >= '2026-09-01'
            AND EXISTS (SELECT 1 FROM sop_pm_schedules sp
                         WHERE sp.pm_id = substring(a.details from 'from PM (\S+)'))
            AND NOT EXISTS (SELECT 1 FROM sop_work_orders sw WHERE sw.wo_id = a.entity_id))
ORDER BY 1;

ROLLBACK;   -- ← swap for COMMIT once every row is true (nothing live changes either way)

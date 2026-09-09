-- ============================================================================
-- PM Auto-Generation: carry linked SOPs forward to generated work orders
-- ============================================================================
-- Bug
--   The manual "Generate WO" button (usePMSchedules.generateWO) copies every
--   SOP linked to a PM (sop_pm_schedules) onto the new work order
--   (sop_work_orders). The nightly auto_generate_pm_work_orders() function
--   never did, so scheduler-generated PM work orders — the large majority —
--   showed no SOPs in the WO detail modal even when the PM had several.
--
-- Fix
--   Add one INSERT ... SELECT inside the generation loop, right after the
--   work_orders row is created. NOT EXISTS guard keeps it idempotent.
--   Everything else in the function is byte-for-byte the 20260901 version
--   (pause check, open-WO skip, round-robin pick, ID generation, due dates,
--   assignments, rotation stamp, audit log, return shape).
--
-- Note: the PM procedure document is NOT copied here on purpose — the WO
--   modal looks it up live via pm_id (see WorkOrdersPage.fetchPmProcedure).
--
-- Dry run: ends in ROLLBACK. The verification SELECT shows, per Active PM
-- with linked SOPs, how many SOPs it has vs. how many its currently-open WO
-- carries — i.e. how many WOs this fix would have helped.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.auto_generate_pm_work_orders()
RETURNS TABLE(out_wo_id text, out_pm_id text, out_pm_name text, out_assigned_to text, out_assigned_email text)
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_paused        text;
  pm_rec          RECORD;
  assignee        RECORD;
  v_wo_id         text;
  v_now           timestamptz := now();
  v_today         date        := current_date;
  v_due_date      date;
  v_next_pm_due   date;
  v_stamp         timestamptz;
BEGIN

  SELECT setting_value INTO v_paused
  FROM settings WHERE setting_key = 'pm_generation_paused' LIMIT 1;
  IF v_paused = 'true' THEN RETURN; END IF;

  FOR pm_rec IN
    SELECT * FROM pm_schedules
    WHERE status = 'Active'
      AND next_due_date IS NOT NULL
      AND next_due_date::date <= v_today
    ORDER BY next_due_date ASC
  LOOP

    -- Skip if an open WO already exists for this PM (closed WOs live in work_orders_closed)
    PERFORM 1 FROM work_orders WHERE pm_id = pm_rec.pm_id LIMIT 1;
    IF FOUND THEN CONTINUE; END IF;

    -- ── True round-robin pick ─────────────────────────────────────────────
    -- Pool = every Active Student / Work Study profile that is not time-clock-only.
    -- Rotation row is optional (LEFT JOIN LATERAL); a missing row = never assigned.
    -- If duplicate rotation rows exist for one email (case variants), take the
    -- most recent stamp so a stale duplicate can't cause a repeat pick.
    SELECT
      p.email                                                          AS user_email,
      TRIM(p.first_name) || ' ' || LEFT(TRIM(p.last_name), 1) || '.'  AS user_name,
      p.role                                                           AS role,
      r.last_assigned_date                                             AS last_assigned_date
    INTO assignee
    FROM profiles p
    LEFT JOIN LATERAL (
      SELECT ar.last_assigned_date
      FROM assignment_rotation ar
      WHERE LOWER(ar.user_email) = LOWER(p.email)
      ORDER BY ar.last_assigned_date DESC NULLS LAST
      LIMIT 1
    ) r ON TRUE
    WHERE p.role IN ('Student', 'Work Study')
      AND p.status = 'Active'
      AND (p.time_clock_only IS NULL OR p.time_clock_only = '' OR LOWER(p.time_clock_only) != 'yes')
      AND p.email IS NOT NULL AND p.email <> ''
    ORDER BY
      r.last_assigned_date ASC NULLS FIRST,
      LOWER(p.last_name)  ASC,
      LOWER(p.first_name) ASC,
      LOWER(p.email)      ASC
    LIMIT 1;

    IF NOT FOUND THEN
      assignee.user_name  := NULL;
      assignee.user_email := NULL;
    END IF;

    -- Use get_next_id for atomic counter increment (single source of truth)
    v_wo_id := get_next_id('work_order');

    v_due_date := CASE pm_rec.frequency
      WHEN 'Daily'  THEN v_today + 1
      WHEN 'Weekly' THEN v_today + 7
      ELSE               v_today + 21
    END;

    v_next_pm_due := CASE pm_rec.frequency
      WHEN 'Daily'  THEN v_today + 1
      WHEN 'Weekly' THEN v_today + 7
      ELSE               v_today + 21
    END;

    INSERT INTO work_orders (
      wo_id, description, priority, status,
      asset_id, asset_name, assigned_to, assigned_email,
      due_date, created_at, created_by, is_pm, pm_id,
      updated_at, updated_by
    ) VALUES (
      v_wo_id, '[PM] ' || pm_rec.pm_name, 'Medium', 'Open',
      COALESCE(pm_rec.asset_id, ''), COALESCE(pm_rec.asset_name, ''),
      assignee.user_name, assignee.user_email,
      v_due_date, v_now, 'System (Auto-PM)', 'Yes', pm_rec.pm_id,
      v_now, 'System (Auto-PM)'
    );

    -- ── Carry linked SOPs forward to the new WO ──────────────────────────
    -- Mirrors the manual "Generate WO" path in usePMSchedules.generateWO():
    -- every SOP linked to this PM (sop_pm_schedules) is linked to the new
    -- work order (sop_work_orders) so it appears under "Standard Operating
    -- Procedures" in the WO detail modal. NOT EXISTS keeps it idempotent.
    INSERT INTO sop_work_orders (sop_id, wo_id)
    SELECT sp.sop_id, v_wo_id
    FROM sop_pm_schedules sp
    WHERE sp.pm_id = pm_rec.pm_id
      AND sp.sop_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM sop_work_orders sw
        WHERE sw.wo_id = v_wo_id AND sw.sop_id = sp.sop_id
      );

    IF assignee.user_email IS NOT NULL THEN
      INSERT INTO work_order_assignments (
        wo_id, user_email, user_name, assigned_by
      ) VALUES (
        v_wo_id, assignee.user_email, assignee.user_name, 'System (Auto-PM)'
      );
    END IF;

    UPDATE pm_schedules SET
      last_generated = v_now,
      next_due_date  = v_next_pm_due,
      updated_at     = v_now
    WHERE pm_id = pm_rec.pm_id;

    -- ── Stamp the rotation (upsert; per-pick timestamp so order survives a lap) ──
    IF assignee.user_email IS NOT NULL THEN
      v_stamp := clock_timestamp();

      UPDATE assignment_rotation SET
        user_name          = assignee.user_name,
        role               = assignee.role,
        status             = 'Active',
        assignment_count   = COALESCE(assignment_count, 0) + 1,
        last_assigned_date = v_stamp
      WHERE LOWER(user_email) = LOWER(assignee.user_email);

      IF NOT FOUND THEN
        INSERT INTO assignment_rotation (
          user_name, user_email, role, last_assigned_date, assignment_count, status
        ) VALUES (
          assignee.user_name, assignee.user_email, assignee.role, v_stamp, 1, 'Active'
        );
      END IF;
    END IF;

    INSERT INTO audit_log (timestamp, user_email, user_name, action, entity_type, entity_id, details)
    VALUES (
      v_now, 'system@rict-cmms.auto', 'System (Auto-PM)', 'Auto-Generate PM WO',
      'Work Order', v_wo_id,
      'Auto-generated WO ' || v_wo_id || ' from PM ' || pm_rec.pm_id ||
        ' (' || pm_rec.pm_name || ')' ||
        CASE WHEN assignee.user_name IS NOT NULL
          THEN ' → assigned to ' || assignee.user_name
          ELSE ' → unassigned (no eligible students)' END
    );

    out_wo_id := v_wo_id; out_pm_id := pm_rec.pm_id;
    out_pm_name := pm_rec.pm_name; out_assigned_to := assignee.user_name;
    out_assigned_email := assignee.user_email;
    RETURN NEXT;

  END LOOP;

END;
$function$;

-- ── Verification (no writes) ────────────────────────────────────────────────
-- fn_has_sop_copy = true confirms the new body is installed in this transaction.
-- The rows below show existing open PM WOs whose SOP count trails their PM.
-- (Those existing WOs are not backfilled by this migration — see notes.)
SELECT
  (SELECT pg_get_functiondef('public.auto_generate_pm_work_orders()'::regprocedure)
     LIKE '%Carry linked SOPs forward%')                        AS fn_has_sop_copy,
  p.pm_id,
  p.pm_name,
  w.wo_id                                                       AS open_wo_id,
  (SELECT count(*) FROM sop_pm_schedules sp WHERE sp.pm_id = p.pm_id)  AS pm_sop_count,
  (SELECT count(*) FROM sop_work_orders sw WHERE sw.wo_id = w.wo_id)   AS wo_sop_count
FROM pm_schedules p
JOIN work_orders w ON w.pm_id = p.pm_id
WHERE p.status = 'Active'
  AND EXISTS (SELECT 1 FROM sop_pm_schedules sp WHERE sp.pm_id = p.pm_id)
ORDER BY p.pm_id;

ROLLBACK;   -- swap to COMMIT once fn_has_sop_copy = true and the rows look right

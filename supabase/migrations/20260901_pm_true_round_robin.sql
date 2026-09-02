-- ============================================================================
-- PM Auto-Generation: TRUE round-robin assignment
-- ============================================================================
-- What changed
--   The assignee picker in auto_generate_pm_work_orders() previously ordered by
--   assignment_count ASC (fewest lifetime assignments first). That is a load
--   balancer, not a rotation: users with high counts were skipped while low-count
--   users absorbed entire batches. It also only considered people who already
--   had an assignment_rotation row, so anyone added outside the access-request
--   approval flow was never picked.
--
-- New behavior
--   * Eligible pool comes from `profiles` directly:
--       role IN ('Student','Work Study'), status = 'Active', not time-clock-only.
--     New users are in the rotation the moment their profile is Active.
--     Archived users drop out the moment they're archived.
--   * Pick order: whoever was assigned longest ago goes next
--     (last_assigned_date ASC NULLS FIRST), then last name / first name / email
--     as a stable tiebreak. Never-assigned users go first. The list wraps
--     naturally once everyone has had a turn.
--   * last_assigned_date is stamped with clock_timestamp() per pick (not one
--     shared batch timestamp) so a batch larger than the roster keeps rotating
--     in order on the second lap.
--   * assignment_rotation row is upserted on every pick (name/role/status kept
--     current, assignment_count still incremented for reporting). The join is
--     case-insensitive on email.
--   * Everything else — pause check, open-WO skip, ID generation, due dates,
--     work_order_assignments, audit log, return shape — is unchanged.
--
-- Dry run: ends in ROLLBACK. Verification SELECT shows the next 10 people in
-- rotation order so you can eyeball it before swapping to COMMIT.
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

-- ── Verification: the next 10 people in rotation order (no writes) ─────────
-- Row 1 is who the next generated PM will go to. NULL last_assigned = never picked.
SELECT
  ROW_NUMBER() OVER (
    ORDER BY r.last_assigned_date ASC NULLS FIRST, LOWER(p.last_name), LOWER(p.first_name), LOWER(p.email)
  )                                                                AS pick_order,
  TRIM(p.first_name) || ' ' || LEFT(TRIM(p.last_name), 1) || '.'  AS user_name,
  p.email,
  p.role,
  r.last_assigned_date,
  (r.last_assigned_date IS NULL)                                   AS never_assigned
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
ORDER BY pick_order
LIMIT 10;

ROLLBACK;   -- swap to COMMIT once the pick order above looks right

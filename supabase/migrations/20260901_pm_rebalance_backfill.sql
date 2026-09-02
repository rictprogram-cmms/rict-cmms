-- ============================================================================
-- PM Rebalance (one-off backfill): deal open PM work orders fairly
-- ============================================================================
-- Run AFTER 20260901_pm_true_round_robin.sql has been COMMITted.
--
-- What it does
--   1. Builds the eligible roster the same way the generator now does:
--      Active Student / Work Study profiles, not time-clock-only, ordered by
--      last_assigned_date ASC NULLS FIRST (people missed last batch go first),
--      then last name / first name / email.
--   2. Takes every PM work order still in `work_orders` with status = 'Open'
--      and no work_log entries (nobody has started it), ordered by created_at.
--      Anything else is left alone and listed as SKIPPED in the verification.
--   3. Deals WO #1 to roster #1, WO #2 to roster #2 … wrapping to the top.
--      Each student ends up with floor(N/M) or floor(N/M)+1 work orders.
--   4. Updates work_orders.assigned_to / assigned_email, swaps the primary row
--      in work_order_assignments (secondary assignees added by an instructor are
--      kept), adjusts assignment_count (-1 old / +1 new), and stamps
--      last_assigned_date in deal order so the next auto-generated PM continues
--      the rotation from where the deal ended.
--   5. Writes one audit_log row per reassigned WO.
--
-- Dry run: ends in ROLLBACK. The verification result shows the proposed
-- distribution (ASSIGNED rows, one per student) and any SKIPPED work orders.
-- Swap to COMMIT when it looks right.
-- ============================================================================

BEGIN;

-- ── Roster in rotation order ─────────────────────────────────────────────────
CREATE TEMP TABLE pm_rebalance_roster ON COMMIT DROP AS
SELECT
  p.email                                                          AS user_email,
  TRIM(p.first_name) || ' ' || LEFT(TRIM(p.last_name), 1) || '.'  AS user_name,
  p.role                                                           AS role,
  (ROW_NUMBER() OVER (
     ORDER BY r.last_assigned_date ASC NULLS FIRST,
              LOWER(p.last_name), LOWER(p.first_name), LOWER(p.email)
   ) - 1)::int                                                     AS idx
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
  AND p.email IS NOT NULL AND p.email <> '';

-- ── Candidate work orders ────────────────────────────────────────────────────
CREATE TEMP TABLE pm_rebalance_wos ON COMMIT DROP AS
SELECT
  w.wo_id,
  w.assigned_email      AS old_email,
  w.assigned_to         AS old_name,
  w.status,
  w.created_at,
  EXISTS (SELECT 1 FROM work_log l WHERE l.wo_id = w.wo_id)  AS has_work_log,
  CASE
    WHEN w.status <> 'Open'                                    THEN 'status is ' || COALESCE(w.status, '(null)')
    WHEN EXISTS (SELECT 1 FROM work_log l WHERE l.wo_id = w.wo_id) THEN 'work already logged'
    ELSE NULL
  END                                                          AS skip_reason
FROM work_orders w
WHERE w.is_pm = 'Yes';

-- ── The deal ─────────────────────────────────────────────────────────────────
CREATE TEMP TABLE pm_rebalance_deal ON COMMIT DROP AS
WITH eligible AS (
  SELECT wo_id, old_email, old_name, created_at,
         (ROW_NUMBER() OVER (ORDER BY created_at, wo_id) - 1)::int AS deal_idx
  FROM pm_rebalance_wos
  WHERE skip_reason IS NULL
),
n AS (SELECT COUNT(*)::int AS cnt FROM pm_rebalance_roster)
SELECT
  e.wo_id, e.old_email, e.old_name, e.deal_idx,
  ro.user_email AS new_email, ro.user_name AS new_name, ro.role AS new_role
FROM eligible e
CROSS JOIN n
JOIN pm_rebalance_roster ro ON ro.idx = (e.deal_idx % n.cnt);

-- ── Apply ────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  d        RECORD;
  v_now    timestamptz := now();
  v_base   timestamptz := clock_timestamp();
  v_stamp  timestamptz;
BEGIN
  IF (SELECT COUNT(*) FROM pm_rebalance_roster) = 0 THEN
    RAISE EXCEPTION 'No eligible students found — nothing to rebalance';
  END IF;

  FOR d IN SELECT * FROM pm_rebalance_deal ORDER BY deal_idx LOOP

    -- Stamp in deal order (1 ms apart) so the generator resumes after the last card dealt
    v_stamp := v_base + (d.deal_idx * INTERVAL '1 millisecond');

    -- Skip the write if the card landed on the same person; still stamp the rotation
    IF d.old_email IS NULL OR LOWER(d.old_email) <> LOWER(d.new_email) THEN

      UPDATE work_orders SET
        assigned_to    = d.new_name,
        assigned_email = d.new_email,
        updated_at     = v_now,
        updated_by     = 'System (PM Rebalance)'
      WHERE wo_id = d.wo_id;

      -- Swap primary assignee row; leave any instructor-added secondaries alone
      IF d.old_email IS NOT NULL THEN
        DELETE FROM work_order_assignments
        WHERE wo_id = d.wo_id AND LOWER(user_email) = LOWER(d.old_email);
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM work_order_assignments
        WHERE wo_id = d.wo_id AND LOWER(user_email) = LOWER(d.new_email)
      ) THEN
        INSERT INTO work_order_assignments (wo_id, user_email, user_name, assigned_by)
        VALUES (d.wo_id, d.new_email, d.new_name, 'System (PM Rebalance)');
      END IF;

      -- Counts: hand the credit from old to new
      IF d.old_email IS NOT NULL THEN
        UPDATE assignment_rotation
        SET assignment_count = GREATEST(COALESCE(assignment_count, 0) - 1, 0)
        WHERE LOWER(user_email) = LOWER(d.old_email);
      END IF;

      INSERT INTO audit_log (timestamp, user_email, user_name, action, entity_type, entity_id, details)
      VALUES (
        v_now, 'system@rict-cmms.auto', 'System (PM Rebalance)', 'Reassign PM WO',
        'Work Order', d.wo_id,
        'Rebalanced ' || d.wo_id || ': ' || COALESCE(d.old_name, '(unassigned)') ||
        ' → ' || d.new_name || ' (round-robin backfill)'
      );

      UPDATE assignment_rotation SET
        user_name          = d.new_name,
        role               = d.new_role,
        status             = 'Active',
        assignment_count   = COALESCE(assignment_count, 0) + 1,
        last_assigned_date = v_stamp
      WHERE LOWER(user_email) = LOWER(d.new_email);

    ELSE
      -- Same person keeps it; just refresh the rotation stamp
      UPDATE assignment_rotation SET
        user_name          = d.new_name,
        role               = d.new_role,
        status             = 'Active',
        last_assigned_date = v_stamp
      WHERE LOWER(user_email) = LOWER(d.new_email);
    END IF;

    IF NOT FOUND THEN
      INSERT INTO assignment_rotation (user_name, user_email, role, last_assigned_date, assignment_count, status)
      VALUES (d.new_name, d.new_email, d.new_role, v_stamp, 1, 'Active');
    END IF;

  END LOOP;
END $$;

-- ── Verification (single result set) ────────────────────────────────────────
-- ASSIGNED: one row per student with the WOs they now hold.
-- SKIPPED : PM WOs left untouched and why.
-- NEXT_UP : who the next auto-generated PM will go to after this deal.
SELECT * FROM (
  SELECT
    'ASSIGNED'                                  AS section,
    ro.idx + 1                                  AS roster_pos,
    ro.user_name,
    ro.user_email,
    COUNT(d.wo_id)                              AS wo_count,
    COUNT(d.wo_id) FILTER (WHERE d.old_email IS NULL OR LOWER(d.old_email) <> LOWER(d.new_email)) AS changed,
    STRING_AGG(d.wo_id, ', ' ORDER BY d.deal_idx) AS detail
  FROM pm_rebalance_roster ro
  LEFT JOIN pm_rebalance_deal d ON LOWER(d.new_email) = LOWER(ro.user_email)
  GROUP BY ro.idx, ro.user_name, ro.user_email

  UNION ALL

  SELECT
    'SKIPPED', NULL, s.old_name, s.old_email, 0, 0,
    s.wo_id || ' — ' || s.skip_reason
  FROM pm_rebalance_wos s
  WHERE s.skip_reason IS NOT NULL

  UNION ALL

  (SELECT
    'NEXT_UP', 1,
    TRIM(p.first_name) || ' ' || LEFT(TRIM(p.last_name), 1) || '.',
    p.email, 0, 0,
    'next auto-generated PM goes here'
  FROM profiles p
  LEFT JOIN LATERAL (
    SELECT ar.last_assigned_date FROM assignment_rotation ar
    WHERE LOWER(ar.user_email) = LOWER(p.email)
    ORDER BY ar.last_assigned_date DESC NULLS LAST LIMIT 1
  ) r ON TRUE
  WHERE p.role IN ('Student', 'Work Study')
    AND p.status = 'Active'
    AND (p.time_clock_only IS NULL OR p.time_clock_only = '' OR LOWER(p.time_clock_only) != 'yes')
    AND p.email IS NOT NULL AND p.email <> ''
  ORDER BY r.last_assigned_date ASC NULLS FIRST, LOWER(p.last_name), LOWER(p.first_name), LOWER(p.email)
  LIMIT 1)
) v
ORDER BY
  CASE section WHEN 'ASSIGNED' THEN 1 WHEN 'SKIPPED' THEN 2 ELSE 3 END,
  roster_pos NULLS LAST,
  detail;

ROLLBACK;   -- swap to COMMIT once the distribution looks right

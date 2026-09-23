-- ═════════════════════════════════════════════════════════════════════════════
-- RICT CMMS — One-off fix: close the orphaned AST1111 checkout (Colby Faber)
-- File: supabase/fixes/20260923_close_orphaned_checkout_ast1111.sql
--
-- Why
--   Portable PLC Trainer #3 (AST1111) was checked out to Colby Faber on
--   2026-05-06 (due 2026-05-07). It came back, but before the check-in flow
--   existed, so the row was never closed. The same asset was then checked out
--   to Austin Zahara on 2026-08-18, which proves it was in the lab by then.
--   The open row keeps Colby on the Accountability Report as "138 days
--   overdue, still out" and on the Dashboard alert card.
--
-- What this does
--   Marks that ONE row returned, exactly as the Check In button would, with:
--     returned_at      = the moment before Austin's checkout (the latest time
--                        we can prove it was back; the real date is unknown)
--     return_condition = 'Good'   (it went straight back out)
--     return_notes     = explains the manual close-out
--     checked_in_by    = 'manual fix 2026-09-23'
--   Fake-UTC convention for returned_at (Convention A, like checked_out_at).
--
--   It also clears the matching Dashboard alert row if one exists, so the
--   card updates without waiting for the next sweep.
--
-- Safety
--   Targets the row by asset + student + status = 'checked_out' and refuses
--   to touch more than one row. Dry run ends in ROLLBACK; verification shows
--   the row before/after and the two AST1111 rows side by side.
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
    FROM public.asset_checkouts
   WHERE asset_id = 'AST1111'
     AND lower(user_email) = 'yi1067kp@go.minnstate.edu'
     AND status = 'checked_out';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'Expected exactly 1 open AST1111 checkout for Colby Faber, found % — nothing changed', v_count;
  END IF;
END $$;

UPDATE public.asset_checkouts
   SET status           = 'returned',
       returned_at      = '2026-08-18T09:32:00+00'::timestamptz,   -- fake-UTC: 9:32 AM local, one minute before Austin's checkout
       return_condition = 'Good',
       return_notes     = 'Closed out manually 2026-09-23: returned before the check-in flow existed; asset was re-issued to another student on 2026-08-18. Actual return date unknown.',
       checked_in_by    = 'manual fix 2026-09-23',
       needs_repair     = false
 WHERE asset_id = 'AST1111'
   AND lower(user_email) = 'yi1067kp@go.minnstate.edu'
   AND status = 'checked_out';

-- Drop the Dashboard alert for it right away (harmless if the table / row is absent)
UPDATE public.accountability_alerts
   SET status = 'cleared', cleared_at = now()
 WHERE status = 'open'
   AND rule = 'gear_overdue'
   AND lower(user_email) = 'yi1067kp@go.minnstate.edu';

-- ── Verification: both AST1111 rows — expect Colby = returned, Austin = checked_out ──
SELECT checkout_id, user_name, status,
       checked_out_at, expected_return, returned_at, return_condition, checked_in_by
  FROM public.asset_checkouts
 WHERE asset_id = 'AST1111'
 ORDER BY checked_out_at;

ROLLBACK;   -- ← swap for COMMIT once the Colby row shows status = returned

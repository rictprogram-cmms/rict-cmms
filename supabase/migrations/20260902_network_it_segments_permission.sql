-- ============================================================================
-- Network Map: IT-managed segments (wireless AP) — permission + trigger check
-- ============================================================================
-- The wireless access point subnet (10.25.192.0/24, gateway 10.25.192.254) is
-- defined in code (src/lib/networkConfig.js → NETWORK_CONFIG.segments). No
-- schema change is needed: network_devices.subnet is free text and the only
-- constraints are UNIQUE(ip_address) and last_octet BETWEEN 1 AND 254.
--
-- This migration does two things:
--
--   1. Seeds the new permission row P177 'Network Map' / 'manage_it_segments'
--      (instructor only). Mirrors DEFAULT_PERMISSIONS in AccessPage.jsx.
--      Skipped if the row already exists (e.g. you ran "Sync" on Access first).
--
--   2. Inserts a THROWAWAY test device on 10.25.192.253 and reads it back, so
--      any trigger on network_devices (network_print_status flagging, audit,
--      etc.) that chokes on an unknown subnet surfaces here — inside the
--      transaction — instead of when you add the first printer. .253 is used
--      because nothing real should ever land there; it is rolled back below
--      either way.
--
-- Dry run: ends in ROLLBACK. Verification SELECT shows the permission row and
-- the test device. If both rows appear and there is no error, swap the final
-- ROLLBACK to COMMIT — the test device is deleted before the commit point.
-- ============================================================================

BEGIN;

-- ── 1. Permission row ────────────────────────────────────────────────────────
INSERT INTO public.permissions
  (permission_id, page, feature, student, work_study, instructor, description, updated_at, updated_by)
SELECT
  'P177', 'Network Map', 'manage_it_segments', false, false, true,
  'Can add, edit, and delete devices on IT-managed segments (e.g. the wireless access point)',
  now(), 'migration'
WHERE NOT EXISTS (
  SELECT 1 FROM public.permissions
  WHERE page = 'Network Map' AND feature = 'manage_it_segments'
);

-- ── 2. Trigger smoke test (rolled back / deleted below) ─────────────────────
INSERT INTO public.network_devices
  (device_id, subnet, ip_address, last_octet, device_name, mac_address,
   profinet_name, location, notes, asset_id, is_reserved, is_dhcp_gateway,
   status, created_at, created_by, updated_at, updated_by)
VALUES
  ('ND-MIGRATION-TEST', '10.25.192.0', '10.25.192.253', 253,
   'MIGRATION TEST — DELETE ME', NULL, NULL, NULL,
   'Temporary row inserted by 20260902_network_it_segments_permission.sql',
   NULL, false, false, 'Active', now(), 'migration', now(), 'migration');

-- ── Verification ────────────────────────────────────────────────────────────
SELECT 'permission' AS what, permission_id AS id, feature AS detail, instructor::text AS flag
FROM public.permissions
WHERE page = 'Network Map' AND feature = 'manage_it_segments'
UNION ALL
SELECT 'test_device', device_id, ip_address, subnet
FROM public.network_devices
WHERE device_id = 'ND-MIGRATION-TEST'
UNION ALL
SELECT 'print_status_rows_touched', count(*)::text, '', ''
FROM public.network_print_status
WHERE last_changed_at > now() - interval '10 seconds';

-- Remove the smoke-test row regardless of COMMIT / ROLLBACK
DELETE FROM public.network_devices WHERE device_id = 'ND-MIGRATION-TEST';

ROLLBACK;  -- ← change to COMMIT after confirming the verification output

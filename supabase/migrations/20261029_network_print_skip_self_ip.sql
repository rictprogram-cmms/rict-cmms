-- ═════════════════════════════════════════════════════════════════════════════
-- RICT CMMS — Wall sheets ignore self-assigned IP addresses
-- File: supabase/migrations/20261029_network_print_skip_self_ip.sql
--
-- Run AFTER 20261029_network_self_ip.sql has been COMMITTED.
--
-- Why
--   flag_network_print_sheet() marks a printed wall sheet "outdated" whenever a
--   device on it is added, changed or removed. Student self-assigned addresses
--   come and go, so every "Get an IP address" and "Release" flagged a sheet
--   (claim + release still left it flagged). Self-assigned addresses are not
--   printed on the wall sheets (NetworkPrintPage.jsx shows them as blank), so
--   they should not flag a sheet either.
--
-- Change
--   Same function as live (recorded verbatim from the database, 2026-10-29),
--   plus two guards: a self-assigned OLD row does not flag its sheet, and a
--   self-assigned NEW row does not flag its sheet. Everything else — instructor
--   adds/edits/deletes, change-request approvals — flags exactly as before.
--   The trigger itself is not touched (only the function body is replaced).
--
-- Does not clear sheets already flagged — use "Mark as printed" in the print view.
--
-- Dry run: ends in ROLLBACK. Every verification row should show ok = true.
-- The self-test inserts and removes test rows inside a sub-transaction that is
-- always undone, so it leaves nothing behind even after COMMIT.
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 0: pre-checks — make sure we are replacing the version we expect
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_def text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'network_devices'
                    AND column_name = 'self_assigned') THEN
    RAISE EXCEPTION 'network_devices.self_assigned not found — COMMIT 20261029_network_self_ip.sql first.';
  END IF;
  IF to_regprocedure('public.flag_network_print_sheet()') IS NULL THEN
    RAISE EXCEPTION 'public.flag_network_print_sheet() not found.';
  END IF;
  v_def := pg_get_functiondef('public.flag_network_print_sheet()'::regprocedure);
  IF position('self_assigned' IN v_def) > 0 THEN
    RAISE NOTICE 'flag_network_print_sheet() already skips self-assigned rows — replacing with the same version.';
  ELSIF position('Flag the OLD location' IN v_def) = 0
     OR position('Flag the NEW location' IN v_def) = 0
     OR position('LEAST(CEIL(OLD.last_octet / 64.0), 4)' IN v_def) = 0 THEN
    RAISE EXCEPTION 'flag_network_print_sheet() is not the version this file expects — send the current definition before running.';
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 1: function (live body + self-assigned guards)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.flag_network_print_sheet()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Skip if nothing printed actually changed
    IF NEW.device_name   IS NOT DISTINCT FROM OLD.device_name
   AND NEW.mac_address   IS NOT DISTINCT FROM OLD.mac_address
   AND NEW.profinet_name IS NOT DISTINCT FROM OLD.profinet_name
   AND NEW.location      IS NOT DISTINCT FROM OLD.location
   AND NEW.ip_address    IS NOT DISTINCT FROM OLD.ip_address
   AND NEW.subnet        IS NOT DISTINCT FROM OLD.subnet
   AND NEW.last_octet    IS NOT DISTINCT FROM OLD.last_octet
   AND NEW.is_reserved   IS NOT DISTINCT FROM OLD.is_reserved
   AND NEW.asset_id      IS NOT DISTINCT FROM OLD.asset_id
   AND NEW.self_assigned IS NOT DISTINCT FROM OLD.self_assigned
    THEN
      RETURN NULL;
    END IF;
  END IF;

  v_actor := CASE TG_OP
    WHEN 'DELETE' THEN OLD.updated_by
    ELSE NEW.updated_by
  END;

  -- Flag the OLD location (UPDATE that moved the device, or DELETE).
  -- Self-assigned addresses are not printed, so removing one changes nothing
  -- on the wall sheet (2026-10-29).
  IF TG_OP IN ('UPDATE', 'DELETE') AND NOT coalesce(OLD.self_assigned, false) THEN
    UPDATE network_print_status
       SET last_changed_at = now(),
           last_changed_by = v_actor
     WHERE subnet_id   = OLD.subnet
       AND page_number = LEAST(CEIL(OLD.last_octet / 64.0), 4)::int;
  END IF;

  -- Flag the NEW location (INSERT, or UPDATE — covers unmoved + moved).
  -- Self-assigned addresses are not printed (2026-10-29).
  IF TG_OP IN ('INSERT', 'UPDATE') AND NOT coalesce(NEW.self_assigned, false) THEN
    UPDATE network_print_status
       SET last_changed_at = now(),
           last_changed_by = v_actor
     WHERE subnet_id   = NEW.subnet
       AND page_number = LEAST(CEIL(NEW.last_octet / 64.0), 4)::int;
  END IF;

  RETURN NULL;  -- AFTER trigger; return value ignored
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 2: self-test (always undone)
--   a) self-assigned insert + delete → its sheet is NOT flagged
--   b) normal insert                 → its sheet IS flagged (unchanged behaviour)
-- Uses the first open address on .193 for both, one after the other.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TEMP TABLE _pss_tests (test text, ok boolean, detail text) ON COMMIT DROP;

DO $do$
DECLARE
  v_res    _pss_tests[] := ARRAY[]::_pss_tests[];
  v_octet  int;
  v_page   int;
  v_before timestamptz;
  v_after  timestamptz;
BEGIN
  SELECT o INTO v_octet
    FROM generate_series(1, 254) o
   WHERE NOT EXISTS (SELECT 1 FROM public.network_devices d WHERE d.ip_address = '10.171.193.' || o)
   ORDER BY o LIMIT 1;
  IF v_octet IS NULL THEN
    INSERT INTO _pss_tests VALUES ('self-test address found', false, 'no open address on .193');
    RETURN;
  END IF;
  v_page := LEAST(CEIL(v_octet / 64.0), 4)::int;

  BEGIN
    -- Known starting point for the sheet
    UPDATE public.network_print_status SET last_changed_at = '2000-01-01'
     WHERE subnet_id = '10.171.193.0' AND page_number = v_page;
    IF NOT FOUND THEN
      v_res := v_res || ROW('print sheet row exists for .193 page ' || v_page, false, NULL)::_pss_tests;
      RAISE EXCEPTION 'undo-self-test';
    END IF;

    INSERT INTO public.network_devices (device_id, subnet, ip_address, last_octet, device_name,
                                        status, self_assigned, updated_by)
    VALUES ('ND-PSS-TEST', '10.171.193.0', '10.171.193.' || v_octet, v_octet, 'Print test (self)',
            'Active', true, 'migration');
    DELETE FROM public.network_devices WHERE device_id = 'ND-PSS-TEST';

    SELECT last_changed_at INTO v_after FROM public.network_print_status
     WHERE subnet_id = '10.171.193.0' AND page_number = v_page;
    v_res := v_res || ROW('self-assigned add + remove does not flag sheet',
                          v_after = '2000-01-01'::timestamptz, '.193 page ' || v_page)::_pss_tests;

    INSERT INTO public.network_devices (device_id, subnet, ip_address, last_octet, device_name,
                                        status, self_assigned, updated_by)
    VALUES ('ND-PSS-TEST', '10.171.193.0', '10.171.193.' || v_octet, v_octet, 'Print test (normal)',
            'Active', false, 'migration');

    SELECT last_changed_at INTO v_after FROM public.network_print_status
     WHERE subnet_id = '10.171.193.0' AND page_number = v_page;
    v_res := v_res || ROW('normal add still flags sheet',
                          v_after > '2000-01-01'::timestamptz, '.193 page ' || v_page)::_pss_tests;

    RAISE EXCEPTION 'undo-self-test';
  EXCEPTION WHEN others THEN
    IF SQLERRM <> 'undo-self-test' THEN
      v_res := v_res || ROW('self-test ran without error', false, SQLERRM)::_pss_tests;
    END IF;
  END;

  INSERT INTO _pss_tests SELECT * FROM unnest(v_res);
END
$do$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification (single result set)
-- ─────────────────────────────────────────────────────────────────────────────
SELECT * FROM (
  SELECT 1 AS n, 'function skips self-assigned rows' AS test,
         position('self_assigned' IN pg_get_functiondef('public.flag_network_print_sheet()'::regprocedure)) > 0 AS ok,
         NULL::text AS detail
  UNION ALL
  SELECT 2, 'trigger still attached to network_devices',
         EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
                  WHERE t.tgrelid = 'public.network_devices'::regclass
                    AND p.proname = 'flag_network_print_sheet' AND NOT t.tgisinternal), NULL
  UNION ALL
  SELECT 100 + row_number() OVER (), 'self-test: ' || test, ok, detail FROM _pss_tests
  UNION ALL
  SELECT 200, 'self-test left no rows behind',
         NOT EXISTS (SELECT 1 FROM public.network_devices WHERE device_id = 'ND-PSS-TEST'), NULL
) v ORDER BY n;

ROLLBACK;

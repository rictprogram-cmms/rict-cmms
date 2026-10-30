-- ═════════════════════════════════════════════════════════════════════════════
-- RICT CMMS — Self-service IP addresses on the Network Map
-- File: supabase/migrations/20261029_network_self_ip.sql
--
-- What this adds
--   • A user can give themselves ONE static IP from the Network Map. The
--     database picks the lowest open address across the program's wired
--     subnets (10.171.193.x → 10.171.194.x → 10.171.195.x), skipping:
--       – addresses that already have a network_devices row
--       – the Do-Not-Use tail 10.171.195.250–254 (includes the gateway)
--       – addresses with a Pending "add" change request
--     The wireless segment (IT-managed) and the DHCP pool are never used.
--   • The user can release it again.
--   • Archiving a user (profiles.status → 'Archived') or deleting a user
--     releases their address automatically. Restoring does NOT give it back.
--   • Every claim and release is written to audit_log (entity 'Network Device'),
--     so the device's History and the audit log keep the trail.
--
-- Pieces
--   1. network_devices: assigned_user_id / _email / _name, self_assigned,
--      assigned_at  (all nullable / defaulted — existing rows untouched)
--   2. Unique index: one self-assigned address per user
--   3. Unique index on ip_address — ONLY created when no duplicate IPs exist
--      today (verification row says which happened)
--   4. Permission 'Network Map' / 'request_ip' — on for student, work_study,
--      instructor (editable in Settings like any other)
--   5. claim_self_ip(device_name, mac_address, purpose)  → jsonb row
--      release_self_ip()                                 → text (released IP)
--      Both SECURITY DEFINER: students have no add/delete rights on the table.
--      Both serialise on one advisory lock, so two people clicking at the same
--      moment can never receive the same address.
--   6. Trigger profiles_release_self_ip on profiles (archive / delete)
--
-- Keep in sync: the subnet list inside claim_self_ip() mirrors
-- SELF_ASSIGN_SUBNET_IDS / NETWORK_CONFIG.doNotUse in src/lib/networkConfig.js.
--
-- Timestamps: assigned_at is real UTC (now()), same as created_at/updated_at
-- written by useNetworkMap.js (new Date().toISOString()).
--
-- Dry run: ends in ROLLBACK. Every verification row should show ok = true
-- (rows marked INFO are facts, not checks). Then swap the last line to COMMIT.
-- The self-test claims, releases and archives inside a sub-transaction that is
-- always undone, so it leaves no data behind even after COMMIT.
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 0: pre-checks
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.network_devices') IS NULL THEN
    RAISE EXCEPTION 'public.network_devices not found.';
  END IF;
  IF to_regclass('public.network_change_requests') IS NULL THEN
    RAISE EXCEPTION 'public.network_change_requests not found.';
  END IF;
  IF to_regprocedure('public.has_perm(text, text)') IS NULL THEN
    RAISE EXCEPTION 'public.has_perm(text, text) not found — security phase 1 must be live first.';
  END IF;
  IF to_regprocedure('public.get_next_id(text)') IS NULL THEN
    RAISE EXCEPTION 'public.get_next_id(text) not found.';
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 1: columns
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.network_devices
  ADD COLUMN IF NOT EXISTS assigned_user_id    uuid,
  ADD COLUMN IF NOT EXISTS assigned_user_email text,
  ADD COLUMN IF NOT EXISTS assigned_user_name  text,
  ADD COLUMN IF NOT EXISTS self_assigned       boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS assigned_at         timestamptz;

COMMENT ON COLUMN public.network_devices.assigned_user_id IS
  'profiles.id of the user who self-assigned this address (Network Map "Get an IP address"). NULL for program/instructor entries.';
COMMENT ON COLUMN public.network_devices.self_assigned IS
  'True when the row was created by claim_self_ip(). Released by release_self_ip() or when the user is archived/deleted.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 2: one self-assigned address per user
-- ─────────────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS network_devices_one_self_ip_per_user
  ON public.network_devices (assigned_user_id)
  WHERE assigned_user_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 3: unique IP (only if the data already allows it)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_dupes int;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'network_devices'
       AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%(ip_address)%'
  ) THEN
    RETURN;   -- already unique
  END IF;

  SELECT count(*) INTO v_dupes
    FROM (SELECT ip_address FROM public.network_devices
           GROUP BY ip_address HAVING count(*) > 1) d;

  IF v_dupes = 0 THEN
    CREATE UNIQUE INDEX network_devices_ip_unique ON public.network_devices (ip_address);
  ELSE
    RAISE NOTICE 'Skipped unique IP index: % duplicated IP(s) exist. Clean them up and re-run section 3.', v_dupes;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 4: permission row
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO public.permissions
  (permission_id, page, feature, student, work_study, instructor, description, updated_at, updated_by)
SELECT
  'P' || (coalesce(max(substring(permission_id FROM 2)::int), 0) + 1),
  'Network Map', 'request_ip', true, true, true,
  'Can give themselves one static IP address from the Network Map and release it',
  now(), 'migration'
FROM public.permissions
WHERE permission_id ~ '^P[0-9]+$'
HAVING NOT EXISTS (
    SELECT 1 FROM public.permissions WHERE page = 'Network Map' AND feature = 'request_ip'
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 5: claim / release functions
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.claim_self_ip(
  p_device_name text,
  p_mac_address text DEFAULT NULL,
  p_purpose     text DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_email   text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_prof    record;
  v_name    text;       -- "First L." like the app's senderDisplayName()
  v_full    text;
  v_dev     text := btrim(coalesce(p_device_name, ''));
  v_purpose text := btrim(coalesce(p_purpose, ''));
  v_mac     text := upper(replace(btrim(coalesce(p_mac_address, '')), ':', '-'));
  v_have    text;
  v_ip      text;
  v_prefix  text;
  v_octet   int;
  v_id      text;
  v_row     public.network_devices%ROWTYPE;
BEGIN
  IF v_email = '' THEN
    RAISE EXCEPTION 'You must be signed in.' USING ERRCODE = '42501';
  END IF;

  SELECT p.id, p.first_name, p.last_name, p.email
    INTO v_prof
    FROM public.profiles p
   WHERE lower(p.email) = v_email
     AND p.status = 'Active'
   LIMIT 1;
  IF v_prof.id IS NULL THEN
    RAISE EXCEPTION 'No active profile found for your account.' USING ERRCODE = '42501';
  END IF;

  IF NOT public.has_perm('Network Map', 'request_ip') THEN
    RAISE EXCEPTION 'You do not have permission to request an IP address.' USING ERRCODE = '42501';
  END IF;

  -- Validation (mirrors the popup)
  IF length(v_dev) < 2 OR length(v_dev) > 80 THEN
    RAISE EXCEPTION 'Device name must be 2–80 characters.' USING ERRCODE = '22023';
  END IF;
  IF length(v_purpose) < 3 OR length(v_purpose) > 200 THEN
    RAISE EXCEPTION 'Purpose / class must be 3–200 characters.' USING ERRCODE = '22023';
  END IF;
  IF v_mac = '' THEN
    v_mac := NULL;
  ELSIF v_mac !~ '^([0-9A-F]{2}-){5}[0-9A-F]{2}$' THEN
    RAISE EXCEPTION 'MAC address must look like XX-XX-XX-XX-XX-XX.' USING ERRCODE = '22023';
  END IF;

  -- One claim at a time, program-wide. Released at commit.
  PERFORM pg_advisory_xact_lock(hashtext('rict_network_self_ip'));

  SELECT d.ip_address INTO v_have
    FROM public.network_devices d
   WHERE d.assigned_user_id = v_prof.id
   LIMIT 1;
  IF v_have IS NOT NULL THEN
    RAISE EXCEPTION 'You already have IP address %. Release it before requesting another.', v_have
      USING ERRCODE = '23505';
  END IF;

  -- Lowest open address: .193 first, then .194, then .195.
  SELECT s.prefix, o
    INTO v_prefix, v_octet
    FROM unnest(ARRAY['10.171.193.', '10.171.194.', '10.171.195.']) WITH ORDINALITY AS s(prefix, ord)
   CROSS JOIN generate_series(1, 254) AS o
   WHERE NOT (s.prefix = '10.171.195.' AND o BETWEEN 250 AND 254)          -- Do Not Use + gateway
     AND NOT EXISTS (SELECT 1 FROM public.network_devices d
                      WHERE d.ip_address = s.prefix || o)
     AND NOT EXISTS (SELECT 1 FROM public.network_change_requests r
                      WHERE r.ip_address = s.prefix || o
                        AND r.status = 'Pending'
                        AND r.change_type = 'add')
   ORDER BY s.ord, o
   LIMIT 1;

  IF v_prefix IS NULL THEN
    RAISE EXCEPTION 'There are no open IP addresses left. Please ask an instructor.' USING ERRCODE = 'P0001';
  END IF;

  v_ip   := v_prefix || v_octet;
  v_full := nullif(btrim(coalesce(v_prof.first_name, '') || ' ' || coalesce(v_prof.last_name, '')), '');
  v_name := CASE
              WHEN coalesce(v_prof.last_name, '') <> ''
                THEN coalesce(v_prof.first_name, '') || ' ' || left(v_prof.last_name, 1) || '.'
              ELSE coalesce(nullif(v_prof.first_name, ''), v_prof.email)
            END;
  v_id   := public.get_next_id('network_device');
  IF v_id IS NULL OR v_id = '' THEN
    RAISE EXCEPTION 'Could not create a device ID. Please try again.';
  END IF;

  INSERT INTO public.network_devices (
    device_id, subnet, ip_address, last_octet,
    device_name, mac_address, profinet_name, location, notes, asset_id,
    is_reserved, is_dhcp_gateway, status,
    created_at, created_by, updated_at, updated_by,
    assigned_user_id, assigned_user_email, assigned_user_name, self_assigned, assigned_at
  ) VALUES (
    v_id, v_prefix || '0', v_ip, v_octet,
    v_dev, v_mac, NULL, NULL, 'Purpose: ' || v_purpose, NULL,
    false, false, 'Active',
    now(), v_name, now(), v_name,
    v_prof.id, lower(v_prof.email), coalesce(v_full, v_name), true, now()
  )
  RETURNING * INTO v_row;

  INSERT INTO public.audit_log (timestamp, user_email, user_name, action, entity_type, entity_id, details)
  VALUES (now(), lower(v_prof.email), coalesce(v_full, v_name), 'Self-Assign IP', 'Network Device', v_id,
          'Self-assigned ' || v_ip || ' — ' || v_dev || ' (' || v_purpose || ')');

  RETURN to_jsonb(v_row);
END;
$function$;

COMMENT ON FUNCTION public.claim_self_ip(text, text, text) IS
  'Network Map "Get an IP address": gives the signed-in user the lowest open wired address (one per user). Needs Network Map / request_ip.';

CREATE OR REPLACE FUNCTION public.release_self_ip()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_prof  record;
  v_full  text;
  v_row   public.network_devices%ROWTYPE;
BEGIN
  IF v_email = '' THEN
    RAISE EXCEPTION 'You must be signed in.' USING ERRCODE = '42501';
  END IF;

  SELECT p.id, p.first_name, p.last_name, p.email
    INTO v_prof
    FROM public.profiles p
   WHERE lower(p.email) = v_email
   LIMIT 1;
  IF v_prof.id IS NULL THEN
    RAISE EXCEPTION 'No profile found for your account.' USING ERRCODE = '42501';
  END IF;
  -- No permission check: anyone may give back their own address, even if the
  -- request_ip permission was turned off after they claimed it.

  PERFORM pg_advisory_xact_lock(hashtext('rict_network_self_ip'));

  DELETE FROM public.network_devices d
   WHERE d.assigned_user_id = v_prof.id
  RETURNING * INTO v_row;

  IF v_row.device_id IS NULL THEN
    RAISE EXCEPTION 'You do not have an IP address to release.' USING ERRCODE = 'P0002';
  END IF;

  v_full := nullif(btrim(coalesce(v_prof.first_name, '') || ' ' || coalesce(v_prof.last_name, '')), '');
  INSERT INTO public.audit_log (timestamp, user_email, user_name, action, entity_type, entity_id, details)
  VALUES (now(), lower(v_prof.email), coalesce(v_full, v_prof.email), 'Release IP', 'Network Device', v_row.device_id,
          'Released ' || v_row.ip_address || ' — ' || coalesce(v_row.device_name, '(no name)'));

  RETURN v_row.ip_address;
END;
$function$;

COMMENT ON FUNCTION public.release_self_ip() IS
  'Network Map: the signed-in user gives back their self-assigned IP address.';

REVOKE ALL ON FUNCTION public.claim_self_ip(text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.release_self_ip()               FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_self_ip(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_self_ip()               TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 6: archive / delete → release
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.profiles_release_self_ip()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_uid   uuid;
  v_email text;
  v_name  text;
  v_why   text;
  v_me    text := lower(coalesce(auth.jwt() ->> 'email', ''));
  r       record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_uid := OLD.id; v_email := OLD.email; v_why := 'user deleted';
    v_name := nullif(btrim(coalesce(OLD.first_name, '') || ' ' || coalesce(OLD.last_name, '')), '');
  ELSE
    v_uid := NEW.id; v_email := NEW.email; v_why := 'user archived';
    v_name := nullif(btrim(coalesce(NEW.first_name, '') || ' ' || coalesce(NEW.last_name, '')), '');
  END IF;

  -- Never let this block an archive or delete: failures become a warning.
  BEGIN
    FOR r IN
      DELETE FROM public.network_devices d
       WHERE d.assigned_user_id = v_uid
      RETURNING d.device_id, d.ip_address, d.device_name
    LOOP
      INSERT INTO public.audit_log (timestamp, user_email, user_name, action, entity_type, entity_id, details)
      VALUES (now(), coalesce(nullif(v_me, ''), 'system'), 'System', 'Release IP', 'Network Device', r.device_id,
              'Released ' || r.ip_address || ' — ' || coalesce(r.device_name, '(no name)')
              || ' (' || v_why || ': ' || coalesce(v_name, v_email, v_uid::text) || ')');
    END LOOP;
  EXCEPTION WHEN others THEN
    RAISE WARNING 'profiles_release_self_ip: could not release IP for %: %', v_uid, SQLERRM;
  END;

  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.profiles_release_self_ip() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS profiles_release_self_ip_archive ON public.profiles;
CREATE TRIGGER profiles_release_self_ip_archive
  AFTER UPDATE OF status ON public.profiles
  FOR EACH ROW
  WHEN (NEW.status = 'Archived' AND OLD.status IS DISTINCT FROM 'Archived')
  EXECUTE FUNCTION public.profiles_release_self_ip();

DROP TRIGGER IF EXISTS profiles_release_self_ip_delete ON public.profiles;
CREATE TRIGGER profiles_release_self_ip_delete
  AFTER DELETE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.profiles_release_self_ip();

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 7: self-test (always undone)
-- Picks an Active student with no address and an Active instructor, then:
-- claim → second claim refused → release → claim again → archive releases it.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TEMP TABLE _sip_tests (test text, ok boolean, detail text) ON COMMIT DROP;

DO $do$
DECLARE
  v_student text;
  v_instr   text;
  v_sid     uuid;
  v_row     jsonb;
  v_ip1     text;
  v_ip2     text;
  v_rel     text;
  v_left    int;
  v_expect  text;
  v_res     _sip_tests[] := ARRAY[]::_sip_tests[];   -- kept outside the undone sub-transaction
BEGIN
  SELECT p.email, p.id INTO v_student, v_sid
    FROM public.profiles p
   WHERE p.role = 'Student' AND p.status = 'Active'
     AND NOT EXISTS (SELECT 1 FROM public.network_devices d WHERE d.assigned_user_id = p.id)
   ORDER BY p.email LIMIT 1;
  SELECT p.email INTO v_instr
    FROM public.profiles p
   WHERE p.role IN ('Instructor', 'Super Admin') AND p.status = 'Active'
   ORDER BY p.email LIMIT 1;

  IF v_student IS NULL OR v_instr IS NULL THEN
    INSERT INTO _sip_tests VALUES ('self-test users found', false,
      'need an Active student without an IP and an Active instructor');
    RETURN;
  END IF;

  -- Expected first pick, computed independently of the function
  SELECT s.prefix || o INTO v_expect
    FROM unnest(ARRAY['10.171.193.', '10.171.194.', '10.171.195.']) WITH ORDINALITY AS s(prefix, ord)
   CROSS JOIN generate_series(1, 254) AS o
   WHERE NOT (s.prefix = '10.171.195.' AND o >= 250)
     AND (s.prefix || o) NOT IN (SELECT ip_address FROM public.network_devices WHERE ip_address IS NOT NULL)
     AND (s.prefix || o) NOT IN (SELECT ip_address FROM public.network_change_requests
                                  WHERE status = 'Pending' AND change_type = 'add' AND ip_address IS NOT NULL)
   ORDER BY s.ord, o LIMIT 1;

  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_student, 'role', 'authenticated')::text, true);

    v_row := public.claim_self_ip('Self-test laptop', 'aa:bb:cc:dd:ee:ff', 'Migration self-test');
    v_ip1 := v_row ->> 'ip_address';
    v_res := v_res || ROW('claim gives lowest open address', v_ip1 = v_expect,
      'got ' || coalesce(v_ip1, 'NULL') || ', expected ' || coalesce(v_expect, 'NULL'))::_sip_tests;
    v_res := v_res || ROW('row is tagged to the student',
      (v_row ->> 'assigned_user_id')::uuid = v_sid AND (v_row ->> 'self_assigned')::boolean,
      v_row ->> 'assigned_user_name')::_sip_tests;
    v_res := v_res || ROW('MAC normalised', v_row ->> 'mac_address' = 'AA-BB-CC-DD-EE-FF', v_row ->> 'mac_address')::_sip_tests;

    BEGIN
      PERFORM public.claim_self_ip('Second', NULL, 'Should fail');
      v_res := v_res || ROW('second claim refused', false, 'was allowed')::_sip_tests;
    EXCEPTION WHEN others THEN
      v_res := v_res || ROW('second claim refused', SQLERRM LIKE 'You already have IP address%', SQLERRM)::_sip_tests;
    END;

    BEGIN
      PERFORM public.claim_self_ip('X', NULL, 'Bad name');
      v_res := v_res || ROW('validation refuses short name', false, 'was allowed')::_sip_tests;
    EXCEPTION WHEN others THEN
      v_res := v_res || ROW('validation refuses short name', SQLERRM LIKE 'Device name%', SQLERRM)::_sip_tests;
    END;

    v_rel := public.release_self_ip();
    v_res := v_res || ROW('release returns the IP', v_rel = v_ip1, v_rel)::_sip_tests;
    v_res := v_res || ROW('row removed after release',
      NOT EXISTS (SELECT 1 FROM public.network_devices WHERE ip_address = v_ip1), v_ip1)::_sip_tests;
    v_res := v_res || ROW('audit rows written',
      (SELECT count(*) FROM public.audit_log
        WHERE entity_type = 'Network Device' AND entity_id = v_row ->> 'device_id'
          AND action IN ('Self-Assign IP', 'Release IP')) = 2, NULL)::_sip_tests;

    v_row := public.claim_self_ip('Self-test laptop 2', NULL, 'Migration self-test');
    v_ip2 := v_row ->> 'ip_address';
    v_res := v_res || ROW('released address is reused', v_ip2 = v_ip1, v_ip2)::_sip_tests;

    -- Archive as an instructor (profiles write rules)
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_instr, 'role', 'authenticated')::text, true);
    UPDATE public.profiles SET status = 'Archived' WHERE id = v_sid;
    SELECT count(*) INTO v_left FROM public.network_devices WHERE assigned_user_id = v_sid;
    v_res := v_res || ROW('archiving releases the address', v_left = 0, v_left || ' left')::_sip_tests;

    RAISE EXCEPTION 'undo-self-test';
  EXCEPTION WHEN others THEN
    IF SQLERRM <> 'undo-self-test' THEN
      v_res := v_res || ROW('self-test ran without error', false, SQLERRM)::_sip_tests;
    END IF;
  END;
  PERFORM set_config('request.jwt.claims', '', true);
  INSERT INTO _sip_tests SELECT * FROM unnest(v_res);
END
$do$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification (single result set)
-- ─────────────────────────────────────────────────────────────────────────────
SELECT * FROM (
  SELECT 1 AS n, 'columns added' AS test,
         (SELECT count(*) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'network_devices'
             AND column_name IN ('assigned_user_id', 'assigned_user_email', 'assigned_user_name',
                                 'self_assigned', 'assigned_at')) = 5 AS ok,
         NULL::text AS detail
  UNION ALL
  SELECT 2, 'one-per-user index',
         to_regclass('public.network_devices_one_self_ip_per_user') IS NOT NULL, NULL
  UNION ALL
  SELECT 3, 'INFO: unique IP index present',
         NULL,
         CASE WHEN EXISTS (SELECT 1 FROM pg_indexes
                            WHERE schemaname = 'public' AND tablename = 'network_devices'
                              AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%(ip_address)%')
              THEN 'yes' ELSE 'NO — duplicate IPs exist: ' ||
                   coalesce((SELECT string_agg(ip_address, ', ') FROM (
                      SELECT ip_address FROM public.network_devices
                       GROUP BY ip_address HAVING count(*) > 1) x), '') END
  UNION ALL
  SELECT 4, 'permission request_ip (all roles on)',
         EXISTS (SELECT 1 FROM public.permissions
                  WHERE page = 'Network Map' AND feature = 'request_ip'
                    AND student AND work_study AND instructor),
         (SELECT permission_id FROM public.permissions WHERE page = 'Network Map' AND feature = 'request_ip' LIMIT 1)
  UNION ALL
  SELECT 5, 'functions installed',
         to_regprocedure('public.claim_self_ip(text, text, text)') IS NOT NULL
         AND to_regprocedure('public.release_self_ip()') IS NOT NULL, NULL
  UNION ALL
  SELECT 6, 'functions not callable logged-out',
         NOT has_function_privilege('anon', 'public.claim_self_ip(text, text, text)', 'EXECUTE')
         AND NOT has_function_privilege('anon', 'public.release_self_ip()', 'EXECUTE'), NULL
  UNION ALL
  SELECT 7, 'archive + delete triggers',
         (SELECT count(*) FROM pg_trigger
           WHERE tgrelid = 'public.profiles'::regclass AND NOT tgisinternal
             AND tgname IN ('profiles_release_self_ip_archive', 'profiles_release_self_ip_delete')) = 2, NULL
  UNION ALL
  SELECT 100 + row_number() OVER (), 'self-test: ' || test, ok, detail FROM _sip_tests
  UNION ALL
  SELECT 200, 'self-test left no rows behind',
         NOT EXISTS (SELECT 1 FROM public.network_devices WHERE device_name LIKE 'Self-test laptop%'), NULL
) v ORDER BY n;

ROLLBACK;

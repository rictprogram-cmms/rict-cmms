-- ═════════════════════════════════════════════════════════════════════════════
-- RICT CMMS — Security hardening, Phase 2 step 2: logged-out LOCK-DOWN
-- File: supabase/migrations/20260928_security_phase2b_lockdown.sql
-- Plan: project doc claude/2026-09-28-rls-security-hardening-plan.md
--
-- RUN ONLY AFTER:
--   1. 20260928_security_phase2a_kiosk_functions.sql is COMMITTED, and
--   2. the new TimeClockPage / LabStatusPage / TVDisplayPage / LoginPage are
--      deployed and a Pi has been checked (punch in/out, TV roster, Lab Status
--      help acknowledge). Pages still on the old code stop working after this.
--
-- What logged-out callers (the public "anon" key) lose
--   • profiles       — no reads (emails, badge numbers, roles)        → kiosk_* / kiosk_feed / email_status
--   • time_clock     — no reads, inserts or updates                    → kiosk_punch_in / kiosk_punch_out / kiosk_feed
--   • lab_signup     — no reads                                         → kiosk_feed / kiosk_student_state
--   • work_orders    — no reads (incl. public requesters' contact info) → kiosk_feed
--   • help_requests  — no reads or writes (logged-in users unchanged)   → kiosk_feed / kiosk_help_update
--   • permissions, assets, network_devices, network_change_requests — no reads
--   • settings       — only the 8 keys the kiosks / TV / sign-in page read
--   • access_requests — logged-out inserts must be a Pending, Student request
-- What they keep: classes, lab_calendar, lab_schedule, tv_slides (+ its images),
-- kiosk_feed_version, the kiosk_* / email_status functions, get_next_id,
-- submit_access_request, list_public_assets, submit_public_wo_request.
-- Logged-in users: no change (their existing policies are recreated as-is for
-- help_requests and the network tables, just without the logged-out role).
--
-- Dry run: ends in ROLLBACK. Every verification row should show ok = true.
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

-- profiles
DROP POLICY IF EXISTS profiles_select_public ON public.profiles;

-- time_clock (logged-out)
DROP POLICY IF EXISTS anon_insert_time_clock   ON public.time_clock;
DROP POLICY IF EXISTS anon_select_time_clock   ON public.time_clock;
DROP POLICY IF EXISTS anon_update_time_clock   ON public.time_clock;
DROP POLICY IF EXISTS time_clock_insert_public ON public.time_clock;
DROP POLICY IF EXISTS time_clock_select_public ON public.time_clock;

-- lab_signup / work_orders / permissions / assets (logged-out reads)
DROP POLICY IF EXISTS lab_signup_select_public   ON public.lab_signup;
DROP POLICY IF EXISTS work_orders_select_public  ON public.work_orders;
DROP POLICY IF EXISTS permissions_select_public  ON public.permissions;
DROP POLICY IF EXISTS assets_select_public       ON public.assets;

-- network tables: logged-in only (were every role)
DROP POLICY IF EXISTS network_devices_select_all ON public.network_devices;
CREATE POLICY network_devices_select_all
  ON public.network_devices FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS ncr_select_all ON public.network_change_requests;
CREATE POLICY ncr_select_all
  ON public.network_change_requests FOR SELECT TO authenticated USING (true);

-- help_requests: same rules for logged-in users, none for logged-out
DROP POLICY IF EXISTS "Anyone can read help requests"                ON public.help_requests;
DROP POLICY IF EXISTS "Authenticated users can delete help requests" ON public.help_requests;
DROP POLICY IF EXISTS "Authenticated users can insert help requests" ON public.help_requests;
DROP POLICY IF EXISTS "Authenticated users can update help requests" ON public.help_requests;
CREATE POLICY "Anyone can read help requests"
  ON public.help_requests FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can delete help requests"
  ON public.help_requests FOR DELETE TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert help requests"
  ON public.help_requests FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update help requests"
  ON public.help_requests FOR UPDATE TO authenticated USING (true);

-- settings: logged-out screens read only what they use
DROP POLICY IF EXISTS settings_select_public ON public.settings;
CREATE POLICY settings_select_public
  ON public.settings FOR SELECT TO anon
  USING (setting_key IN (
    'lab_access_mode', 'maintenance_end_at', 'maintenance_message',   -- Time Clock + sign-in
    'grace_period_minutes',                                            -- Time Clock
    'instructor_away_mode', 'instructor_return_time',                  -- Lab Status + TV
    'tv_rotation_seconds',                                             -- TV
    'session_timeout_hours'                                            -- sign-in
  ));

-- access_requests: a logged-out "request access" can only be a Pending Student request
DROP POLICY IF EXISTS access_requests_anon_insert ON public.access_requests;
CREATE POLICY access_requests_anon_insert
  ON public.access_requests FOR INSERT TO anon
  WITH CHECK (status = 'Pending' AND coalesce(requested_role, 'Student') = 'Student');

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification — logged-out view of every table, plus the kiosk path still works
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TEMP TABLE _p2b_tests (test text, expected text, actual text) ON COMMIT DROP;

DO $do$
DECLARE
  t     text;
  v_n   bigint;
  v_err text;
BEGIN
  FOREACH t IN ARRAY ARRAY['profiles', 'time_clock', 'lab_signup', 'work_orders', 'help_requests',
                           'permissions', 'assets', 'network_devices', 'network_change_requests']
  LOOP
    BEGIN
      PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
      EXECUTE 'SET LOCAL ROLE anon';
      EXECUTE format('SELECT count(*) FROM public.%I', t) INTO v_n;
      RAISE EXCEPTION 'rows=%', v_n;
    EXCEPTION WHEN others THEN
      INSERT INTO _p2b_tests VALUES ('logged-out reads ' || t, 'rows=0',
        CASE WHEN SQLSTATE = '42501' THEN 'rows=0' ELSE SQLERRM END);
    END;
  END LOOP;

  -- settings: only allow-listed keys visible
  BEGIN
    EXECUTE 'SET LOCAL ROLE anon';
    SELECT count(*) INTO v_n FROM public.settings
     WHERE setting_key NOT IN ('lab_access_mode', 'maintenance_end_at', 'maintenance_message',
                               'grace_period_minutes', 'instructor_away_mode', 'instructor_return_time',
                               'tv_rotation_seconds', 'session_timeout_hours');
    RAISE EXCEPTION 'other keys=%', v_n;
  EXCEPTION WHEN others THEN
    INSERT INTO _p2b_tests VALUES ('logged-out sees only allow-listed settings', 'other keys=0', SQLERRM);
  END;

  -- time_clock write blocked
  BEGIN
    EXECUTE 'SET LOCAL ROLE anon';
    INSERT INTO public.time_clock (record_id, user_email, status) VALUES ('P2B-TEST', 'x@example.com', 'Punched In');
    RAISE EXCEPTION 'inserted';
  EXCEPTION WHEN others THEN
    INSERT INTO _p2b_tests VALUES ('logged-out insert into time_clock', 'blocked',
      CASE WHEN SQLSTATE = '42501' THEN 'blocked' ELSE SQLERRM END);
  END;

  -- access request escalation blocked, normal request allowed
  BEGIN
    EXECUTE 'SET LOCAL ROLE anon';
    INSERT INTO public.access_requests (request_id, email, first_name, last_name, status, requested_role)
    VALUES ('P2B-TEST-1', 'p2b@example.com', 'P', 'Test', 'Pending', 'Instructor');
    RAISE EXCEPTION 'inserted';
  EXCEPTION WHEN others THEN
    INSERT INTO _p2b_tests VALUES ('logged-out request for Instructor role', 'blocked',
      CASE WHEN SQLSTATE = '42501' THEN 'blocked' ELSE SQLERRM END);
  END;
  BEGIN
    EXECUTE 'SET LOCAL ROLE anon';
    INSERT INTO public.access_requests (request_id, email, first_name, last_name, status, requested_role)
    VALUES ('P2B-TEST-2', 'p2b@example.com', 'P', 'Test', 'Pending', 'Student');
    RAISE EXCEPTION 'inserted';
  EXCEPTION WHEN others THEN
    INSERT INTO _p2b_tests VALUES ('logged-out Pending Student access request', 'inserted', SQLERRM);
  END;

  -- kiosk path still works while logged out
  BEGIN
    EXECUTE 'SET LOCAL ROLE anon';
    PERFORM public.kiosk_feed((now() AT TIME ZONE 'America/Chicago')::date);
    PERFORM public.kiosk_badge_lookup('no-such-badge-xyz');
    SELECT count(*) INTO v_n FROM public.kiosk_feed_version;
    RAISE EXCEPTION 'ok';
  EXCEPTION WHEN others THEN
    INSERT INTO _p2b_tests VALUES ('kiosk feed / badge lookup / live signal still work logged out', 'ok', SQLERRM);
  END;

  -- logged-in user still reads help requests + network map
  BEGIN
    PERFORM set_config('request.jwt.claims',
      json_build_object('email', (SELECT email FROM public.profiles WHERE status = 'Active' ORDER BY email LIMIT 1),
                        'role', 'authenticated')::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM 1 FROM public.help_requests LIMIT 1;
    PERFORM 1 FROM public.network_devices LIMIT 1;
    RAISE EXCEPTION 'ok';
  EXCEPTION WHEN others THEN
    INSERT INTO _p2b_tests VALUES ('logged-in reads help requests + network map', 'ok', SQLERRM);
  END;
END
$do$;

SELECT test AS check_name, expected, actual, (expected = actual) AS ok
  FROM _p2b_tests
 ORDER BY 1;

ROLLBACK;   -- ← swap for COMMIT after every row shows ok = true

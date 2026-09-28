-- ═════════════════════════════════════════════════════════════════════════════
-- RICT CMMS — Security hardening, Phase 1 (database only)
-- File: supabase/migrations/20260928_security_phase1.sql
-- Plan: project doc claude/2026-09-28-rls-security-hardening-plan.md
--
-- What this closes
--   1. Profiles: any logged-in user could edit any profile, including making
--      themselves an Instructor. Now:
--        • Staff (Active Instructor / Super Admin, or the super-admin account)
--          can do anything, as before.
--        • Users the Access Control matrix lets manage users (Users page:
--          add_users, edit_users, deactivate_users, delete_users,
--          approve_requests, change_roles, assign_card_id) can manage other
--          users' profiles, but cannot create or promote anyone to
--          Instructor / Super Admin, and cannot change a staff member's
--          role / status / email.
--        • Everyone else may only stamp their OWN last_login, last_seen,
--          last_seen_changelog_date (what the app does on sign-in / heartbeat /
--          changelog).
--   2. Temporary access requests: anyone could insert an already-Active grant
--      for themselves. Now students may only submit their own Pending requests;
--      approve / reject / expire stays with staff (and the existing RPCs).
--   3. Access Control (permissions table): writes are staff-only.
--   4. Program plans: "Anyone can manage plans" (every role, incl. logged-out)
--      is removed. Staff full access; students read their own plan only.
--   5. Instructor Note on plans moves to a new instructor-only table
--      (plan_instructor_notes). Existing notes are copied, the old column is
--      emptied, and a trigger redirects any old-style write into the new table
--      so nothing is lost while the new page deploys.
--   6. course_outline_revisions: logged-out access removed (logged-in unchanged).
--   7. Functions: logged-out callers can no longer run the internal / admin
--      functions (delete user, purge audit log, PM resets, checkouts, holds,
--      trigger functions, …). Logged-out pages keep what they use:
--      get_next_id (time clock), submit_access_request (login),
--      list_public_assets + submit_public_wo_request (public WO form), and the
--      role-check helpers used inside policies.
--      audit_log_increment_failed_count() (not called by the app) is closed to
--      both logged-out and logged-in callers.
--   8. is_instructor_or_admin() compared lowercase 'instructor'/'active' and was
--      always false — fixed to the real values.
--   9. The 20 functions flagged "search path mutable" get a fixed search_path.
--
-- NOT in Phase 1 (unchanged): kiosk / TV / Lab Status / login anonymous reads
-- and the time_clock anonymous writes (Phase 2), the other logged-in table
-- policies (Phase 3), help_requests (Phase 2 — Lab Status needs it logged out).
--
-- New helper functions (usable by later phases):
--   is_staff()              — Active Instructor / Super Admin, or super-admin email
--   has_perm(page, feature) — mirrors usePermissions(): role column in
--                             permissions + active temp permission grants;
--                             super-admin email always true
--   can_manage_profiles()   — staff, or any Users-page management permission
--
-- The last section runs live tests AS a real student and a real instructor
-- inside savepoints that are always rolled back, so the tests never change
-- data even after COMMIT.
--
-- Dry run: ends in ROLLBACK. Check the verification rows (every ok = true),
-- then swap the last line for COMMIT.
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 1: helper functions
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.is_staff()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
  SELECT lower(coalesce(auth.jwt() ->> 'email', '')) = 'rictprogram@gmail.com'
      OR EXISTS (
           SELECT 1
             FROM public.profiles p
            WHERE coalesce(auth.jwt() ->> 'email', '') <> ''
              AND lower(p.email) = lower(auth.jwt() ->> 'email')
              AND p.role IN ('Instructor', 'Super Admin')
              AND p.status = 'Active'
         );
$function$;

COMMENT ON FUNCTION public.is_staff() IS
  'True for an Active Instructor / Super Admin profile or the super-admin account. Used by RLS policies (security phase 1, 2026-09-28).';

-- Mirrors src/hooks/usePermissions.js: role column = lower(role) with the first
-- space turned into "_" (Work Study -> work_study); a value of true / 'true' /
-- 'Yes' grants. Active, unexpired temp permission grants add features.
CREATE OR REPLACE FUNCTION public.has_perm(p_page text, p_feature text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_role  text;
  v_key   text;
BEGIN
  IF v_email = '' THEN
    RETURN false;
  END IF;
  IF v_email = 'rictprogram@gmail.com' THEN
    RETURN true;
  END IF;

  SELECT p.role INTO v_role
    FROM public.profiles p
   WHERE lower(p.email) = v_email
     AND p.status = 'Active'
   LIMIT 1;
  IF v_role IS NULL THEN
    RETURN false;
  END IF;

  v_key := regexp_replace(lower(v_role), ' ', '_');

  IF EXISTS (
    SELECT 1
      FROM public.permissions x
     WHERE x.page = p_page
       AND x.feature = p_feature
       AND (to_jsonb(x) ->> v_key) IN ('true', 'Yes')
  ) THEN
    RETURN true;
  END IF;

  RETURN EXISTS (
    SELECT 1
      FROM public.temp_access_requests t
     WHERE lower(t.user_email) = v_email
       AND t.status = 'Active'
       AND t.request_type = 'permissions'
       AND (t.expiry_date IS NULL OR t.expiry_date > now())
       AND to_jsonb(t.approved_permissions)
           @> jsonb_build_array(jsonb_build_object('page', p_page, 'feature', p_feature))
  );
END;
$function$;

COMMENT ON FUNCTION public.has_perm(text, text) IS
  'Server-side twin of usePermissions().hasPerm(): permissions matrix by role + active temp permission grants; super-admin account always true.';

CREATE OR REPLACE FUNCTION public.can_manage_profiles()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
  SELECT public.is_staff()
      OR public.has_perm('Users', 'add_users')
      OR public.has_perm('Users', 'edit_users')
      OR public.has_perm('Users', 'deactivate_users')
      OR public.has_perm('Users', 'delete_users')
      OR public.has_perm('Users', 'approve_requests')
      OR public.has_perm('Users', 'change_roles')
      OR public.has_perm('Users', 'assign_card_id');
$function$;

REVOKE ALL ON FUNCTION public.is_staff()                FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.has_perm(text, text)      FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_manage_profiles()     FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_staff()             TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.has_perm(text, text)   TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_manage_profiles()  TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 2: profiles — policies + write guard
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS profiles_insert      ON public.profiles;
DROP POLICY IF EXISTS profiles_update_own  ON public.profiles;
DROP POLICY IF EXISTS profiles_update      ON public.profiles;
DROP POLICY IF EXISTS profiles_delete      ON public.profiles;

CREATE POLICY profiles_insert
  ON public.profiles FOR INSERT TO authenticated
  WITH CHECK (public.can_manage_profiles());

-- Managers: any row. Everyone: their own row (the guard trigger limits WHICH
-- columns a non-manager may change on it).
CREATE POLICY profiles_update
  ON public.profiles FOR UPDATE TO authenticated
  USING (
    public.can_manage_profiles()
    OR lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  )
  WITH CHECK (
    public.can_manage_profiles()
    OR lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );

CREATE POLICY profiles_delete
  ON public.profiles FOR DELETE TO authenticated
  USING (public.is_staff() OR public.has_perm('Users', 'delete_users'));

-- Not SECURITY DEFINER on purpose: current_user must stay the caller's role so
-- database-side work (SECURITY DEFINER functions, triggers, service role,
-- SQL editor) is never blocked.
CREATE OR REPLACE FUNCTION public.profiles_write_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_me        text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_self_cols text[] := ARRAY['last_login', 'last_seen', 'last_seen_changelog_date', 'updated_at'];
  v_staff_roles text[] := ARRAY['Instructor', 'Super Admin'];
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;
  IF public.is_staff() THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.role = ANY (v_staff_roles) THEN
      RAISE EXCEPTION 'Only an instructor can create an Instructor or Super Admin account.'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE by a user-manager (Access Control → Users permissions)
  IF public.can_manage_profiles() THEN
    IF NEW.role IS DISTINCT FROM OLD.role AND NEW.role = ANY (v_staff_roles) THEN
      RAISE EXCEPTION 'Only an instructor can give someone the % role.', NEW.role
        USING ERRCODE = '42501';
    END IF;
    IF OLD.role = ANY (v_staff_roles)
       AND (NEW.role, NEW.status, NEW.email) IS DISTINCT FROM (OLD.role, OLD.status, OLD.email) THEN
      RAISE EXCEPTION 'Only an instructor can change an instructor''s role, status or email.'
        USING ERRCODE = '42501';
    END IF;
    IF lower(OLD.email) = v_me
       AND (NEW.role, NEW.status) IS DISTINCT FROM (OLD.role, OLD.status) THEN
      RAISE EXCEPTION 'You cannot change your own role or status.'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE by anyone else: own row, sign-in / seen timestamps only
  IF lower(OLD.email) <> v_me
     OR (to_jsonb(NEW) - v_self_cols) IS DISTINCT FROM (to_jsonb(OLD) - v_self_cols) THEN
    RAISE EXCEPTION 'You do not have permission to change this profile.'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.profiles_write_guard() FROM PUBLIC, anon, authenticated;

-- "profiles_00_…" sorts before "profiles_normalize_name", so the guard sees
-- the caller's own change before the name normaliser touches the row.
DROP TRIGGER IF EXISTS profiles_00_write_guard ON public.profiles;
CREATE TRIGGER profiles_00_write_guard
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_write_guard();

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 3: temp_access_requests — no self-approval
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS temp_access_requests_insert ON public.temp_access_requests;
DROP POLICY IF EXISTS temp_access_requests_update ON public.temp_access_requests;
DROP POLICY IF EXISTS temp_access_requests_delete ON public.temp_access_requests;

CREATE POLICY temp_access_requests_insert
  ON public.temp_access_requests FOR INSERT TO authenticated
  WITH CHECK (
    public.is_staff()
    OR (lower(user_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
        AND status = 'Pending')
  );
CREATE POLICY temp_access_requests_update
  ON public.temp_access_requests FOR UPDATE TO authenticated
  USING (public.is_staff())
  WITH CHECK (public.is_staff());
CREATE POLICY temp_access_requests_delete
  ON public.temp_access_requests FOR DELETE TO authenticated
  USING (public.is_staff());
-- (temp_access_requests_select unchanged)

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 4: permissions (Access Control) — staff-only writes
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS permissions_insert ON public.permissions;
DROP POLICY IF EXISTS permissions_update ON public.permissions;
DROP POLICY IF EXISTS permissions_delete ON public.permissions;

CREATE POLICY permissions_insert
  ON public.permissions FOR INSERT TO authenticated
  WITH CHECK (public.is_staff());
CREATE POLICY permissions_update
  ON public.permissions FOR UPDATE TO authenticated
  USING (public.is_staff())
  WITH CHECK (public.is_staff());
CREATE POLICY permissions_delete
  ON public.permissions FOR DELETE TO authenticated
  USING (public.is_staff());
-- (permissions_select / permissions_select_public unchanged — Phase 2)

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 5: student_program_plans
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Anyone can manage plans"  ON public.student_program_plans;
DROP POLICY IF EXISTS instructors_full_access    ON public.student_program_plans;
DROP POLICY IF EXISTS students_read_own_plan     ON public.student_program_plans;
DROP POLICY IF EXISTS plans_staff_all            ON public.student_program_plans;
DROP POLICY IF EXISTS plans_student_read_own     ON public.student_program_plans;

CREATE POLICY plans_staff_all
  ON public.student_program_plans FOR ALL TO authenticated
  USING (public.is_staff())
  WITH CHECK (public.is_staff());
CREATE POLICY plans_student_read_own
  ON public.student_program_plans FOR SELECT TO authenticated
  USING (lower(student_email) = lower(coalesce(auth.jwt() ->> 'email', '')));

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 6: Instructor Note → instructor-only table
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.plan_instructor_notes (
  plan_id          text PRIMARY KEY,
  note             text NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by_email text
);

COMMENT ON TABLE public.plan_instructor_notes IS
  'Program Planner private Instructor Note (the sticky-note icon), one per plan. Staff only. Moved out of student_program_plans.instructor_notes on 2026-09-28 so students cannot read it.';

ALTER TABLE public.plan_instructor_notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS plan_instructor_notes_staff ON public.plan_instructor_notes;
CREATE POLICY plan_instructor_notes_staff
  ON public.plan_instructor_notes FOR ALL TO authenticated
  USING (public.is_staff())
  WITH CHECK (public.is_staff());

REVOKE ALL ON public.plan_instructor_notes FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.plan_instructor_notes TO authenticated;
GRANT ALL ON public.plan_instructor_notes TO service_role;

-- Copy existing notes (keeps a newer note if this is ever re-run)
INSERT INTO public.plan_instructor_notes (plan_id, note, updated_at, updated_by_email)
SELECT p.plan_id::text, p.instructor_notes, now(), 'migration 2026-09-28'
  FROM public.student_program_plans p
 WHERE coalesce(btrim(p.instructor_notes), '') <> ''
ON CONFLICT (plan_id) DO NOTHING;

-- Empty the old column without touching updated_at (user triggers off so an
-- updated_at trigger, if any, can't reshuffle the planner's "Recent" order)
ALTER TABLE public.student_program_plans DISABLE TRIGGER USER;
UPDATE public.student_program_plans
   SET instructor_notes = NULL
 WHERE instructor_notes IS NOT NULL;
ALTER TABLE public.student_program_plans ENABLE TRIGGER USER;

-- Any write to the old column (e.g. the previous page version) lands in the
-- new table instead and the column stays empty.
CREATE OR REPLACE FUNCTION public.plans_redirect_instructor_note()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NEW.instructor_notes IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.instructor_notes IS NOT DISTINCT FROM OLD.instructor_notes THEN
    NEW.instructor_notes := NULL;
    RETURN NEW;
  END IF;

  IF btrim(NEW.instructor_notes) = '' THEN
    DELETE FROM public.plan_instructor_notes WHERE plan_id = NEW.plan_id::text;
  ELSE
    INSERT INTO public.plan_instructor_notes (plan_id, note, updated_at, updated_by_email)
    VALUES (NEW.plan_id::text, NEW.instructor_notes, now(), auth.jwt() ->> 'email')
    ON CONFLICT (plan_id) DO UPDATE
      SET note = EXCLUDED.note,
          updated_at = EXCLUDED.updated_at,
          updated_by_email = EXCLUDED.updated_by_email;
  END IF;
  NEW.instructor_notes := NULL;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.plans_delete_instructor_note()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
BEGIN
  DELETE FROM public.plan_instructor_notes WHERE plan_id = OLD.plan_id::text;
  RETURN OLD;
END;
$function$;

REVOKE ALL ON FUNCTION public.plans_redirect_instructor_note() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.plans_delete_instructor_note()   FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS plans_redirect_instructor_note ON public.student_program_plans;
CREATE TRIGGER plans_redirect_instructor_note
  BEFORE INSERT OR UPDATE ON public.student_program_plans
  FOR EACH ROW EXECUTE FUNCTION public.plans_redirect_instructor_note();

DROP TRIGGER IF EXISTS plans_delete_instructor_note ON public.student_program_plans;
CREATE TRIGGER plans_delete_instructor_note
  AFTER DELETE ON public.student_program_plans
  FOR EACH ROW EXECUTE FUNCTION public.plans_delete_instructor_note();

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 7: course_outline_revisions — logged-in only (no change for users)
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Instructors can manage course outline revisions" ON public.course_outline_revisions;
CREATE POLICY "Instructors can manage course outline revisions"
  ON public.course_outline_revisions FOR ALL TO authenticated
  USING (true)
  WITH CHECK (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 8: function access
-- ─────────────────────────────────────────────────────────────────────────────

-- 8a. Fix is_instructor_or_admin() (was comparing lowercase values → always false)
CREATE OR REPLACE FUNCTION public.is_instructor_or_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE coalesce(auth.jwt() ->> 'email', '') <> ''
       AND lower(email) = lower(auth.jwt() ->> 'email')
       AND role IN ('Instructor', 'Super Admin')
       AND status = 'Active'
  );
$function$;

-- 8b. Logged-out callers lose functions no logged-out page uses. Logged-in
--     access is re-granted explicitly so nothing changes for signed-in users.
DO $do$
DECLARE
  r record;
  -- called by the app while signed in → keep for authenticated
  v_keep_auth text[] := ARRAY[
    'acknowledge_asset_checkout', 'audit_log_purge', 'audit_log_purge_preview',
    'audit_log_suspicious_activity', 'auto_generate_pm_work_orders',
    'cancel_pending_checkout', 'clear_hold_by_badge', 'clear_hold_target',
    'decline_asset_checkout', 'delete_user_completely', 'expire_pending_checkouts',
    'expire_student_holds', 'request_asset_checkout', 'reserve_next_ids',
    'reset_overdue_pm_dates'
  ];
  -- trigger / internal functions → nobody calls these directly
  v_internal text[] := ARRAY[
    'audit_log_increment_failed_count', 'copy_pm_sops_to_new_wo',
    'flag_network_print_on_asset_change', 'flag_network_print_sheet',
    'rls_auto_enable', 'student_holds_mark_cleared_if_all_done', 'sync_last_login',
    'trg_auto_makeup_complete', 'trg_class_sync_profiles', 'trg_enrollment_sync_profile'
  ];
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig, p.proname
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = ANY (v_keep_auth || v_internal)
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', r.sig);
    IF r.proname = ANY (v_keep_auth) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', r.sig);
    ELSE
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM authenticated', r.sig);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
    END IF;
  END LOOP;
END
$do$;

-- 8c. Fixed search_path on the 20 flagged functions (all overloads).
--     "extensions" is included so any unqualified extension call keeps working.
DO $do$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind = 'f'
       AND p.proname = ANY (ARRAY[
         'update_push_subscriptions_updated_at', 'is_instructor_or_admin',
         'update_program_tools_updated_at', 'sync_last_login',
         'syllabus_material_clean_name', 'syllabus_material_part_number',
         'get_next_id', 'is_instructor', 'is_work_study_or_instructor', 'user_email',
         'auto_generate_pm_work_orders', 'prune_reminder_history',
         'lab_signup_stamp_cancel', 'asset_checkouts_set_updated_at', 'fake_utc_now',
         '_pooled_ack_text', 'makeup_window_days', 'normalize_person_name',
         'trg_normalize_person_name', 'default_work_due_at'
       ])
       AND NOT EXISTS (SELECT 1 FROM pg_depend d
                        WHERE d.objid = p.oid AND d.deptype = 'e')   -- skip extension-owned
       AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c
                        WHERE c LIKE 'search_path=%')
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, extensions, pg_temp', r.sig);
  END LOOP;
END
$do$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 9: live tests as a real student / instructor / logged-out caller.
-- Each test runs in a savepoint that is ALWAYS rolled back (the block ends by
-- raising), so no test changes any data — even after COMMIT.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TEMP TABLE _p1_tests (test text, expected text, actual text) ON COMMIT DROP;

DO $do$
DECLARE
  v_student  text;
  v_other    text;
  v_instr    text;
  v_plan_id  text;
  v_n        bigint;
BEGIN
  SELECT email INTO v_student FROM public.profiles
   WHERE role = 'Student' AND status = 'Active' ORDER BY email LIMIT 1;
  SELECT email INTO v_other FROM public.profiles
   WHERE role = 'Student' AND status = 'Active' AND email <> v_student ORDER BY email LIMIT 1;
  SELECT email INTO v_instr FROM public.profiles
   WHERE role = 'Instructor' AND status = 'Active' ORDER BY email LIMIT 1;
  SELECT plan_id::text INTO v_plan_id FROM public.student_program_plans LIMIT 1;

  IF v_student IS NULL OR v_instr IS NULL THEN
    INSERT INTO _p1_tests VALUES ('setup', 'an Active Student and Instructor exist', 'missing — tests skipped');
    RETURN;
  END IF;

  -- Pattern: impersonate → statement → RAISE 'rows=N' (always rolls the savepoint back) → record.
  -- T1 student stamps own last_seen → allowed
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_student, 'role', 'authenticated')::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    UPDATE public.profiles SET last_seen = last_seen WHERE lower(email) = lower(v_student);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE EXCEPTION 'rows=%', v_n;
  EXCEPTION WHEN others THEN
    INSERT INTO _p1_tests VALUES ('student updates own last_seen', 'rows=1', SQLERRM);
  END;

  -- T2 student makes self Instructor → blocked
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_student, 'role', 'authenticated')::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    UPDATE public.profiles SET role = 'Instructor' WHERE lower(email) = lower(v_student);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE EXCEPTION 'rows=%', v_n;
  EXCEPTION WHEN others THEN
    INSERT INTO _p1_tests VALUES ('student makes self Instructor', 'blocked',
      CASE WHEN SQLSTATE = '42501' THEN 'blocked' ELSE SQLERRM END);
  END;

  -- T3 student edits another profile → 0 rows
  IF v_other IS NOT NULL THEN
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_student, 'role', 'authenticated')::text, true);
      EXECUTE 'SET LOCAL ROLE authenticated';
      UPDATE public.profiles SET card_id = card_id WHERE lower(email) = lower(v_other);
      GET DIAGNOSTICS v_n = ROW_COUNT;
      RAISE EXCEPTION 'rows=%', v_n;
    EXCEPTION WHEN others THEN
      INSERT INTO _p1_tests VALUES ('student edits another profile', 'rows=0', SQLERRM);
    END;
  END IF;

  -- T4 student inserts an Active temp permission grant → blocked
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_student, 'role', 'authenticated')::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    INSERT INTO public.temp_access_requests (request_id, user_email, user_name, user_current_role,
      requested_role, days_requested, reason, status, submitted_date, request_type)
    VALUES ('P1TEST-ACTIVE', v_student, 'P1 test', 'Student', NULL, 1, 'phase 1 test', 'Active', now(), 'permissions');
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE EXCEPTION 'rows=%', v_n;
  EXCEPTION WHEN others THEN
    INSERT INTO _p1_tests VALUES ('student self-grants Active temp access', 'blocked',
      CASE WHEN SQLSTATE = '42501' THEN 'blocked' ELSE SQLERRM END);
  END;

  -- T5 student submits a Pending request → allowed
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_student, 'role', 'authenticated')::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    INSERT INTO public.temp_access_requests (request_id, user_email, user_name, user_current_role,
      requested_role, days_requested, reason, status, submitted_date, request_type)
    VALUES ('P1TEST-PENDING', v_student, 'P1 test', 'Student', NULL, 1, 'phase 1 test', 'Pending', now(), 'permissions');
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE EXCEPTION 'rows=%', v_n;
  EXCEPTION WHEN others THEN
    INSERT INTO _p1_tests VALUES ('student submits Pending temp request', 'rows=1', SQLERRM);
  END;

  -- T6 student edits Access Control → 0 rows
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_student, 'role', 'authenticated')::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    UPDATE public.permissions SET description = description;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE EXCEPTION 'rows=%', v_n;
  EXCEPTION WHEN others THEN
    INSERT INTO _p1_tests VALUES ('student edits Access Control', 'rows=0', SQLERRM);
  END;

  -- T7 student reads plans → only their own
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_student, 'role', 'authenticated')::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    SELECT count(*) INTO v_n FROM public.student_program_plans
     WHERE lower(student_email) <> lower(v_student);
    RAISE EXCEPTION 'rows=%', v_n;
  EXCEPTION WHEN others THEN
    INSERT INTO _p1_tests VALUES ('student sees other students'' plans', 'rows=0', SQLERRM);
  END;

  -- T8 student reads Instructor Notes → none
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_student, 'role', 'authenticated')::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    SELECT count(*) INTO v_n FROM public.plan_instructor_notes;
    RAISE EXCEPTION 'rows=%', v_n;
  EXCEPTION WHEN others THEN
    INSERT INTO _p1_tests VALUES ('student reads Instructor Notes', 'rows=0', SQLERRM);
  END;

  -- T9 student deletes a plan → 0 rows
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_student, 'role', 'authenticated')::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    DELETE FROM public.student_program_plans;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE EXCEPTION 'rows=%', v_n;
  EXCEPTION WHEN others THEN
    INSERT INTO _p1_tests VALUES ('student deletes plans', 'rows=0', SQLERRM);
  END;

  -- T10 instructor updates a student's profile → allowed
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_instr, 'role', 'authenticated')::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    UPDATE public.profiles SET role = role, status = status WHERE lower(email) = lower(v_student);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE EXCEPTION 'rows=%', v_n;
  EXCEPTION WHEN others THEN
    INSERT INTO _p1_tests VALUES ('instructor edits a student profile', 'rows=1', SQLERRM);
  END;

  -- T11 instructor sees every plan and note
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_instr, 'role', 'authenticated')::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    SELECT count(*) INTO v_n FROM public.plan_instructor_notes;
    RAISE EXCEPTION 'rows=%', v_n;
  EXCEPTION WHEN others THEN
    INSERT INTO _p1_tests VALUES ('instructor reads Instructor Notes',
      'rows=' || (SELECT count(*) FROM public.plan_instructor_notes), SQLERRM);
  END;

  -- T12 instructor saves an Instructor Note on a plan → allowed
  IF v_plan_id IS NOT NULL THEN
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_instr, 'role', 'authenticated')::text, true);
      EXECUTE 'SET LOCAL ROLE authenticated';
      INSERT INTO public.plan_instructor_notes (plan_id, note, updated_by_email)
      VALUES (v_plan_id, 'P1 test note', v_instr)
      ON CONFLICT (plan_id) DO UPDATE SET note = EXCLUDED.note;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      RAISE EXCEPTION 'rows=%', v_n;
    EXCEPTION WHEN others THEN
      INSERT INTO _p1_tests VALUES ('instructor saves an Instructor Note', 'rows=1', SQLERRM);
    END;

    -- T13 old-style write to the column is redirected and the column stays empty
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_instr, 'role', 'authenticated')::text, true);
      EXECUTE 'SET LOCAL ROLE authenticated';
      UPDATE public.student_program_plans SET instructor_notes = 'P1 redirect test' WHERE plan_id::text = v_plan_id;
      SELECT count(*) INTO v_n FROM public.plan_instructor_notes
       WHERE plan_id = v_plan_id AND note = 'P1 redirect test';
      IF (SELECT instructor_notes FROM public.student_program_plans WHERE plan_id::text = v_plan_id) IS NOT NULL THEN
        v_n := -1;
      END IF;
      RAISE EXCEPTION 'rows=%', v_n;
    EXCEPTION WHEN others THEN
      INSERT INTO _p1_tests VALUES ('old-style note write redirected', 'rows=1', SQLERRM);
    END;
  END IF;

  -- T14 logged-out caller runs delete_user_completely → no permission
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
    EXECUTE 'SET LOCAL ROLE anon';
    PERFORM public.delete_user_completely('nobody@example.com');
    RAISE EXCEPTION 'ran';
  EXCEPTION WHEN others THEN
    INSERT INTO _p1_tests VALUES ('logged-out runs delete_user_completely', 'no permission',
      CASE WHEN SQLSTATE = '42501' THEN 'no permission' ELSE SQLERRM END);
  END;

  -- T15 logged-out caller still gets a time-clock ID (kiosk) — value discarded
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
    EXECUTE 'SET LOCAL ROLE anon';
    PERFORM public.get_next_id('time_clock');
    RAISE EXCEPTION 'ran';
  EXCEPTION WHEN others THEN
    INSERT INTO _p1_tests VALUES ('logged-out kiosk gets next time clock ID', 'ran', SQLERRM);
  END;

  -- T16 logged-out caller reads plans → none
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
    EXECUTE 'SET LOCAL ROLE anon';
    SELECT count(*) INTO v_n FROM public.student_program_plans;
    RAISE EXCEPTION 'rows=%', v_n;
  EXCEPTION WHEN others THEN
    INSERT INTO _p1_tests VALUES ('logged-out reads plans', 'rows=0',
      CASE WHEN SQLSTATE = '42501' THEN 'rows=0' ELSE SQLERRM END);
  END;
END
$do$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification (single result set) — every row should show ok = true
-- ─────────────────────────────────────────────────────────────────────────────
SELECT section, check_name, expected, actual, (expected = actual) AS ok
FROM (
  SELECT 1 AS ord, 'test' AS section, test AS check_name, expected, actual
    FROM _p1_tests

  UNION ALL
  SELECT 2, 'policy', 'open (true) write policies left on profiles / permissions / plans / temp_access_requests',
         '0',
         count(*)::text
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('profiles', 'permissions', 'student_program_plans', 'temp_access_requests')
     AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
     AND (coalesce(qual, 'true') = 'true' AND coalesce(with_check, 'true') = 'true')

  UNION ALL
  SELECT 3, 'data', 'old instructor_notes column emptied',
         'rows with a value=0',
         'rows with a value=' || (SELECT count(*) FROM public.student_program_plans WHERE instructor_notes IS NOT NULL)
  UNION ALL
  SELECT 3, 'data', 'Instructor Notes now in the new table (FYI)',
         (SELECT count(*) FROM public.plan_instructor_notes)::text,
         (SELECT count(*) FROM public.plan_instructor_notes)::text

  UNION ALL
  SELECT 4, 'function', 'logged-out can run internal/admin functions',
         '0',
         count(*)::text
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = ANY (ARRAY['delete_user_completely', 'audit_log_purge', 'audit_log_purge_preview',
                                'reset_overdue_pm_dates', 'audit_log_increment_failed_count',
                                'reserve_next_ids', 'clear_hold_by_badge', 'request_asset_checkout',
                                'is_staff', 'has_perm', 'can_manage_profiles'])
     AND has_function_privilege('anon', p.oid, 'EXECUTE')

  UNION ALL
  SELECT 4, 'function', 'logged-out pages keep get_next_id / submit_access_request / public WO form',
         '4',
         count(*)::text
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('get_next_id', 'submit_access_request', 'list_public_assets', 'submit_public_wo_request')
     AND has_function_privilege('anon', p.oid, 'EXECUTE')

  UNION ALL
  SELECT 4, 'function', 'flagged functions still without a fixed search_path',
         '0',
         count(*)::text
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = ANY (ARRAY[
         'update_push_subscriptions_updated_at', 'is_instructor_or_admin',
         'update_program_tools_updated_at', 'sync_last_login',
         'syllabus_material_clean_name', 'syllabus_material_part_number',
         'get_next_id', 'is_instructor', 'is_work_study_or_instructor', 'user_email',
         'auto_generate_pm_work_orders', 'prune_reminder_history',
         'lab_signup_stamp_cancel', 'asset_checkouts_set_updated_at', 'fake_utc_now',
         '_pooled_ack_text', 'makeup_window_days', 'normalize_person_name',
         'trg_normalize_person_name', 'default_work_due_at'])
     AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%')
) x
ORDER BY ord, section, check_name;

ROLLBACK;   -- ← swap for COMMIT after every row shows ok = true

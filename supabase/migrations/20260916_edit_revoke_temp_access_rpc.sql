-- ═══════════════════════════════════════════════════════════════════════════
-- RICT CMMS — edit_temp_access_request() + revoke_temp_access_request() RPCs
-- File: supabase/migrations/20260916_edit_revoke_temp_access_rpc.sql
--
-- Purpose
--   Instructors can now EDIT an active temporary access grant from the
--   Dashboard (change the granted permissions, change the temp role, or
--   change the expiry date) instead of having to revoke and re-grant.
--
--   A role-type edit is two writes (temp_access_requests + profiles.role),
--   the same half-apply risk that moved approvals into
--   approve_temp_access_request() (20260908). Edits follow that pattern:
--   one SECURITY DEFINER function, one transaction.
--
--   Revoke moves onto the same pattern for the same reason: the Dashboard
--   used to mark the request Revoked from the browser and then restore
--   profiles.role in a second call. If the second call failed the user kept
--   the elevated role with no active grant on record.
--
-- Design
--   • Both functions: SECURITY DEFINER, `authenticated` only, first action is
--     public.current_user_is_instructor() (from 20260907_absence_late_submission.sql).
--   • Only an Active request can be edited or revoked. Anything else raises
--     a clear error rather than silently updating.
--   • Reviewer / editor display name is derived server-side from the
--     caller's profile — never trusted from the client.
--   • The request type (role vs permissions) cannot be changed by an edit.
--   • Each call writes one audit_log row in the same transaction
--     (entity_type 'Temp Access', matching the auto-expiry entries).
--   • New columns edited_by / edited_date / edit_count record the most
--     recent edit without overwriting the original approver in
--     reviewed_by / review_date. The Dashboard History modal reads them.
--   • Both return the updated row as jsonb so the client can validate it
--     got a row back (mustData()).
--
-- Convention
--   temp_access_requests timestamps are REAL UTC (Convention B) — see
--   TIMESTAMP_CONVENTIONS.md. p_expiry_date is a true timestamptz instant.
--
-- Contents
--   0. dependency check
--   1. edited_by / edited_date / edit_count columns (idempotent)
--   2. edit_temp_access_request() + grants
--   3. revoke_temp_access_request() + grants
--   4. Consolidated verification SELECT (last statement before ROLLBACK)
--
-- DRY RUN: ends with ROLLBACK. Swap to COMMIT after the verification output
-- looks right.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ───────────────────────────────────────────────────────────────────────────
-- Section 0: dependency check
-- ───────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regprocedure('public.current_user_is_instructor()') IS NULL THEN
    RAISE EXCEPTION 'Missing public.current_user_is_instructor() — apply 20260907_absence_late_submission.sql first';
  END IF;
  IF to_regprocedure('public.approve_temp_access_request(text, integer, timestamptz, text, jsonb)') IS NULL THEN
    RAISE EXCEPTION 'Missing public.approve_temp_access_request() — apply 20260908_approve_temp_access_rpc.sql first';
  END IF;
END $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Section 1: edit tracking columns
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE public.temp_access_requests
  ADD COLUMN IF NOT EXISTS edited_by   text,
  ADD COLUMN IF NOT EXISTS edited_date timestamptz,
  ADD COLUMN IF NOT EXISTS edit_count  integer NOT NULL DEFAULT 0;

-- ───────────────────────────────────────────────────────────────────────────
-- Section 2: edit_temp_access_request()
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.edit_temp_access_request(
  p_request_id           text,
  p_expiry_date          timestamptz,
  p_approved_role        text    DEFAULT NULL,   -- role-type only
  p_approved_permissions jsonb   DEFAULT NULL    -- permissions-type only
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req            public.temp_access_requests%ROWTYPE;
  v_editor         text;
  v_caller_email   text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_rows           integer;
  v_old_role       text;
  v_old_expiry     timestamptz;
  v_old_perm_count integer;
  v_new_perm_count integer;
  v_approved_days  integer;
  v_changes        text[] := ARRAY[]::text[];
BEGIN
  -- Caller must be an instructor / super admin.
  IF NOT public.current_user_is_instructor() THEN
    RAISE EXCEPTION 'Only instructors can edit temporary access grants'
      USING ERRCODE = '42501';
  END IF;

  IF p_request_id IS NULL OR p_request_id = '' THEN
    RAISE EXCEPTION 'request_id is required';
  END IF;
  IF p_expiry_date IS NULL OR p_expiry_date <= now() THEN
    RAISE EXCEPTION 'expiry_date must be in the future';
  END IF;

  -- Editor display name from the caller's own profile.
  SELECT nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), '')
    INTO v_editor
    FROM public.profiles p
   WHERE lower(p.email) = v_caller_email
   LIMIT 1;
  v_editor := coalesce(v_editor, v_caller_email, 'Instructor');

  -- Lock the request row so an edit can't race a revoke / auto-expiry.
  SELECT * INTO v_req
    FROM public.temp_access_requests
   WHERE request_id = p_request_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request % not found', p_request_id;
  END IF;
  IF v_req.status IS DISTINCT FROM 'Active' THEN
    RAISE EXCEPTION 'Request % is % — only Active grants can be edited', p_request_id, v_req.status;
  END IF;

  v_old_expiry := v_req.expiry_date;
  -- Whole days from now to the new expiry, at least 1 (matches approved_days semantics).
  v_approved_days := greatest(1, ceil(extract(epoch FROM (p_expiry_date - now())) / 86400.0)::integer);

  -- JS sends millisecond precision; compare to the second so a "keep current"
  -- round-trip never logs a phantom expiry change.
  IF v_old_expiry IS NULL OR abs(extract(epoch FROM (v_old_expiry - p_expiry_date))) >= 1 THEN
    v_changes := v_changes || format('expiry %s → %s',
      coalesce(to_char(v_old_expiry AT TIME ZONE 'America/Chicago', 'Mon DD, YYYY'), '—'),
      to_char(p_expiry_date AT TIME ZONE 'America/Chicago', 'Mon DD, YYYY'));
  END IF;

  IF v_req.request_type = 'permissions' THEN
    -- ── Permission grant: replace the approved set, no role change ────────
    IF p_approved_permissions IS NULL
       OR jsonb_typeof(p_approved_permissions) <> 'array'
       OR jsonb_array_length(p_approved_permissions) = 0 THEN
      RAISE EXCEPTION 'At least one permission must remain granted (revoke instead to remove all)';
    END IF;

    v_old_perm_count := coalesce(jsonb_array_length(v_req.approved_permissions), 0);
    v_new_perm_count := jsonb_array_length(p_approved_permissions);
    IF v_req.approved_permissions IS DISTINCT FROM p_approved_permissions THEN
      v_changes := v_changes || format('permissions %s → %s', v_old_perm_count, v_new_perm_count);
    END IF;

    IF cardinality(v_changes) = 0 THEN
      RAISE EXCEPTION 'No changes to save';
    END IF;

    UPDATE public.temp_access_requests
       SET approved_permissions = p_approved_permissions,
           approved_days        = v_approved_days,
           expiry_date          = p_expiry_date,
           edited_by            = v_editor,
           edited_date          = now(),
           edit_count           = coalesce(edit_count, 0) + 1
     WHERE request_id = p_request_id
     RETURNING * INTO v_req;

  ELSE
    -- ── Role elevation: request + profile in the same transaction ────────
    IF p_approved_role IS NULL OR p_approved_role NOT IN ('Work Study', 'Instructor') THEN
      RAISE EXCEPTION 'approved_role must be Work Study or Instructor';
    END IF;
    IF v_req.user_email IS NULL OR v_req.user_email = '' THEN
      RAISE EXCEPTION 'Request % has no user_email — cannot change role', p_request_id;
    END IF;

    v_old_role := v_req.approved_role;
    IF v_old_role IS DISTINCT FROM p_approved_role THEN
      v_changes := v_changes || format('role %s → %s', coalesce(v_old_role, '—'), p_approved_role);
    END IF;

    IF cardinality(v_changes) = 0 THEN
      RAISE EXCEPTION 'No changes to save';
    END IF;

    UPDATE public.temp_access_requests
       SET approved_role      = p_approved_role,
           approved_days      = v_approved_days,
           expiry_date        = p_expiry_date,
           -- The profile already holds the elevated role, so the only safe
           -- fallback for "what to restore later" is the role recorded at
           -- request time — never the profile's current role.
           user_original_role = coalesce(user_original_role, user_current_role),
           edited_by          = v_editor,
           edited_date        = now(),
           edit_count         = coalesce(edit_count, 0) + 1
     WHERE request_id = p_request_id
     RETURNING * INTO v_req;

    IF v_old_role IS DISTINCT FROM p_approved_role THEN
      UPDATE public.profiles
         SET role = p_approved_role
       WHERE lower(email) = lower(v_req.user_email);
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows = 0 THEN
        -- Rolls back the request UPDATE above as well.
        RAISE EXCEPTION 'Role change for % affected no rows', v_req.user_email;
      END IF;
    END IF;
  END IF;

  INSERT INTO public.audit_log
    (log_id, timestamp, user_email, user_name, action, entity_type, entity_id, details)
  VALUES
    ('AL-' || gen_random_uuid()::text,
     now(),
     v_caller_email, v_editor, 'Edit Temp Access', 'Temp Access', p_request_id,
     format('Edited temp %s access for %s: %s',
            CASE WHEN v_req.request_type = 'permissions' THEN 'permission' ELSE 'role' END,
            coalesce(v_req.user_name, v_req.user_email),
            array_to_string(v_changes, '; ')));

  RETURN to_jsonb(v_req);
END;
$$;

REVOKE ALL ON FUNCTION public.edit_temp_access_request(text, timestamptz, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.edit_temp_access_request(text, timestamptz, text, jsonb) TO authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- Section 3: revoke_temp_access_request()
--   Same semantics the Dashboard already had (status → Revoked, reviewed_by
--   → the revoker, reverted_date → now, role-type → profiles.role restored
--   to user_original_role || user_current_role) but atomic and audited.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.revoke_temp_access_request(
  p_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req           public.temp_access_requests%ROWTYPE;
  v_reviewer      text;
  v_caller_email  text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_restore_role  text;
  v_rows          integer;
BEGIN
  IF NOT public.current_user_is_instructor() THEN
    RAISE EXCEPTION 'Only instructors can revoke temporary access grants'
      USING ERRCODE = '42501';
  END IF;

  IF p_request_id IS NULL OR p_request_id = '' THEN
    RAISE EXCEPTION 'request_id is required';
  END IF;

  SELECT nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), '')
    INTO v_reviewer
    FROM public.profiles p
   WHERE lower(p.email) = v_caller_email
   LIMIT 1;
  v_reviewer := coalesce(v_reviewer, v_caller_email, 'Instructor');

  SELECT * INTO v_req
    FROM public.temp_access_requests
   WHERE request_id = p_request_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request % not found', p_request_id;
  END IF;
  IF v_req.status IS DISTINCT FROM 'Active' THEN
    RAISE EXCEPTION 'Request % is already %', p_request_id, v_req.status;
  END IF;

  UPDATE public.temp_access_requests
     SET status        = 'Revoked',
         reviewed_by   = v_reviewer,
         reverted_date = now()
   WHERE request_id = p_request_id
   RETURNING * INTO v_req;

  IF v_req.request_type IS DISTINCT FROM 'permissions' THEN
    v_restore_role := coalesce(v_req.user_original_role, v_req.user_current_role);
    IF v_restore_role IS NOT NULL AND v_req.user_email IS NOT NULL AND v_req.user_email <> '' THEN
      UPDATE public.profiles
         SET role = v_restore_role
       WHERE lower(email) = lower(v_req.user_email);
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows = 0 THEN
        RAISE EXCEPTION 'Role restore for % affected no rows', v_req.user_email;
      END IF;
    END IF;
  END IF;

  INSERT INTO public.audit_log
    (log_id, timestamp, user_email, user_name, action, entity_type, entity_id, details)
  VALUES
    ('AL-' || gen_random_uuid()::text,
     now(),
     v_caller_email, v_reviewer, 'Revoke Temp Access', 'Temp Access', p_request_id,
     CASE WHEN v_req.request_type = 'permissions'
          THEN format('Revoked %s temp permission(s) for %s',
                      coalesce(jsonb_array_length(v_req.approved_permissions), 0),
                      coalesce(v_req.user_name, v_req.user_email))
          ELSE format('Revoked temp role access for %s — reverted from %s to %s',
                      coalesce(v_req.user_name, v_req.user_email),
                      coalesce(v_req.approved_role, '—'),
                      coalesce(v_restore_role, '—'))
     END);

  RETURN to_jsonb(v_req);
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_temp_access_request(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_temp_access_request(text) TO authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- Section 4: verification (single SELECT — last statement before ROLLBACK)
-- ───────────────────────────────────────────────────────────────────────────
SELECT
  to_regprocedure('public.edit_temp_access_request(text, timestamptz, text, jsonb)') IS NOT NULL
    AS edit_rpc_exists,
  to_regprocedure('public.revoke_temp_access_request(text)') IS NOT NULL
    AS revoke_rpc_exists,
  (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('public.edit_temp_access_request(text, timestamptz, text, jsonb)'))
    AS edit_is_security_definer,
  (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('public.revoke_temp_access_request(text)'))
    AS revoke_is_security_definer,
  has_function_privilege('authenticated', 'public.edit_temp_access_request(text, timestamptz, text, jsonb)', 'EXECUTE')
    AS auth_can_edit,
  has_function_privilege('authenticated', 'public.revoke_temp_access_request(text)', 'EXECUTE')
    AS auth_can_revoke,
  has_function_privilege('anon', 'public.edit_temp_access_request(text, timestamptz, text, jsonb)', 'EXECUTE')
    AS anon_can_edit,     -- expect false
  has_function_privilege('anon', 'public.revoke_temp_access_request(text)', 'EXECUTE')
    AS anon_can_revoke,   -- expect false
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'temp_access_requests'
      AND column_name IN ('edited_by', 'edited_date', 'edit_count')) AS new_columns_present,  -- expect 3
  (SELECT count(*) FROM public.temp_access_requests WHERE status = 'Active') AS active_grants_untouched;

ROLLBACK;

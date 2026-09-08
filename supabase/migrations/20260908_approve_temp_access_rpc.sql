-- ═══════════════════════════════════════════════════════════════════════════
-- RICT CMMS — approve_temp_access_request() RPC
-- File: supabase/migrations/20260908_approve_temp_access_rpc.sql
--
-- Purpose
--   Approving a ROLE-type temp access request is two writes from the
--   browser: mark the request Active, then elevate profiles.role. If the
--   second write fails (RLS, network) the request is already Active with
--   no role change — a half-applied approval. This RPC does both in one
--   transaction: either both land or neither does.
--
--   Permission-type approvals only touch temp_access_requests, but they go
--   through the same function so the approve path has one entry point.
--
-- Design
--   • SECURITY DEFINER, callable by `authenticated` only, and the FIRST
--     thing it does is require public.current_user_is_instructor()
--     (created in 20260907_absence_late_submission.sql — verified below).
--   • Only a Pending request can be approved. A second click, or two
--     instructors approving the same card, gets a clear error instead of a
--     silent second UPDATE.
--   • reviewed_by is derived server-side from the caller's profile
--     (first_name last_name, falling back to email) — not trusted from the
--     client.
--   • user_original_role is captured on approval (the role the user had the
--     moment they were elevated) so auto-expiry in AppLayout reverts to the
--     right role even if user_current_role was stale. AppLayout already
--     reads `user_original_role || user_current_role`.
--   • Returns the updated row as jsonb so the client can validate it got a
--     row back (mustData()).
--
-- Convention
--   temp_access_requests timestamps are REAL UTC (Convention B) — see
--   TIMESTAMP_CONVENTIONS.md. p_expiry_date is a true timestamptz instant
--   and is compared against now() / new Date() everywhere.
--
-- Contents
--   1. user_original_role column (idempotent)
--   2. approve_temp_access_request() function + grants
--   3. Consolidated verification SELECT (last statement before ROLLBACK)
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
END $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Section 1: user_original_role (already read by AppLayout auto-expiry)
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE public.temp_access_requests
  ADD COLUMN IF NOT EXISTS user_original_role text;

-- ───────────────────────────────────────────────────────────────────────────
-- Section 2: the RPC
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.approve_temp_access_request(
  p_request_id           text,
  p_approved_days        integer,
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
  v_req          public.temp_access_requests%ROWTYPE;
  v_reviewer     text;
  v_caller_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_current_role text;
  v_rows         integer;
BEGIN
  -- Caller must be an instructor / super admin.
  IF NOT public.current_user_is_instructor() THEN
    RAISE EXCEPTION 'Only instructors can approve temporary access requests'
      USING ERRCODE = '42501';
  END IF;

  IF p_request_id IS NULL OR p_request_id = '' THEN
    RAISE EXCEPTION 'request_id is required';
  END IF;
  IF p_approved_days IS NULL OR p_approved_days < 1 THEN
    RAISE EXCEPTION 'approved_days must be at least 1';
  END IF;
  IF p_expiry_date IS NULL OR p_expiry_date <= now() THEN
    RAISE EXCEPTION 'expiry_date must be in the future';
  END IF;

  -- Reviewer display name from the caller's own profile.
  SELECT nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), '')
    INTO v_reviewer
    FROM public.profiles p
   WHERE lower(p.email) = v_caller_email
   LIMIT 1;
  v_reviewer := coalesce(v_reviewer, v_caller_email, 'Instructor');

  -- Lock the request row so two approvals can't race.
  SELECT * INTO v_req
    FROM public.temp_access_requests
   WHERE request_id = p_request_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request % not found', p_request_id;
  END IF;
  IF v_req.status IS DISTINCT FROM 'Pending' THEN
    RAISE EXCEPTION 'Request % is already %', p_request_id, v_req.status;
  END IF;

  IF v_req.request_type = 'permissions' THEN
    -- ── Permission grant: no role change ─────────────────────────────────
    IF p_approved_permissions IS NULL
       OR jsonb_typeof(p_approved_permissions) <> 'array'
       OR jsonb_array_length(p_approved_permissions) = 0 THEN
      RAISE EXCEPTION 'At least one permission must be approved';
    END IF;

    UPDATE public.temp_access_requests
       SET status               = 'Active',
           approved_permissions = p_approved_permissions,
           approved_days        = p_approved_days,
           reviewed_by          = v_reviewer,
           review_date          = now(),
           expiry_date          = p_expiry_date
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

    -- Capture the role they hold right now so auto-expiry can restore it.
    SELECT p.role INTO v_current_role
      FROM public.profiles p
     WHERE lower(p.email) = lower(v_req.user_email)
     LIMIT 1;
    IF v_current_role IS NULL THEN
      RAISE EXCEPTION 'No profile found for %', v_req.user_email;
    END IF;

    UPDATE public.temp_access_requests
       SET status             = 'Active',
           approved_role      = p_approved_role,
           approved_days      = p_approved_days,
           reviewed_by        = v_reviewer,
           review_date        = now(),
           expiry_date        = p_expiry_date,
           user_original_role = coalesce(user_original_role, v_current_role)
     WHERE request_id = p_request_id
     RETURNING * INTO v_req;

    UPDATE public.profiles
       SET role = p_approved_role
     WHERE lower(email) = lower(v_req.user_email);
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 0 THEN
      -- Rolls back the request UPDATE above as well.
      RAISE EXCEPTION 'Role change for % affected no rows', v_req.user_email;
    END IF;
  END IF;

  RETURN to_jsonb(v_req);
END;
$$;

-- Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE on every new function
-- to anon/authenticated/service_role DIRECTLY, so revoking from PUBLIC alone
-- leaves anon with access. Revoke from anon explicitly.
REVOKE ALL ON FUNCTION public.approve_temp_access_request(text, integer, timestamptz, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_temp_access_request(text, integer, timestamptz, text, jsonb) TO authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- Section 3: verification (single SELECT — last statement before ROLLBACK)
-- ───────────────────────────────────────────────────────────────────────────
SELECT
  to_regprocedure('public.approve_temp_access_request(text, integer, timestamptz, text, jsonb)') IS NOT NULL
    AS rpc_exists,
  (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('public.approve_temp_access_request(text, integer, timestamptz, text, jsonb)'))
    AS is_security_definer,
  has_function_privilege('authenticated', 'public.approve_temp_access_request(text, integer, timestamptz, text, jsonb)', 'EXECUTE')
    AS authenticated_can_execute,
  has_function_privilege('anon', 'public.approve_temp_access_request(text, integer, timestamptz, text, jsonb)', 'EXECUTE')
    AS anon_can_execute,   -- expect false
  EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'temp_access_requests'
       AND column_name = 'user_original_role'
  ) AS has_user_original_role,
  (SELECT count(*) FROM public.temp_access_requests WHERE status = 'Pending') AS pending_requests_untouched;

ROLLBACK;

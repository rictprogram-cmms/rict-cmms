-- ============================================================================
-- Public Work Order Request intake (no-login page for other departments)
-- ============================================================================
-- Adds the server side of /request-work-order:
--
--   1. New columns on work_order_requests for where / what / who:
--        department, location, phone, equipment_description, source
--      (plus created_by / created_at IF NOT EXISTS — both are read by the
--      instructor UI today; adding them is a no-op if they already exist).
--
--   2. list_public_assets()  — anon-callable, returns asset_id + name of
--      Active assets only. Nothing else on `assets` is exposed.
--
--   3. submit_public_wo_request(...) — anon-callable SECURITY DEFINER RPC.
--      The table itself is NOT opened to anon. All enforcement is here:
--        * email must end in @sctcc.edu
--        * name, description required; either a valid Active asset_id OR an
--          equipment description
--        * max 5 submissions per email per rolling hour
--        * priority coerced to Low / Medium / High
--        * request_id from get_next_id('work_order_request') → REQ-xxxx
--        * status 'Pending', source 'public_form'
--      Returns the new request_id.
--
--      The existing push-wo-requests AFTER INSERT trigger fires as normal, so
--      instructors get the push and the bell / Requests tab pick it up with
--      no further changes.
--
-- Dry run: ends in ROLLBACK. Verification SELECT lists the new columns and
-- confirms both functions exist with anon EXECUTE. Swap to COMMIT when green.
-- ============================================================================

BEGIN;

-- ── 1. Columns ───────────────────────────────────────────────────────────────
ALTER TABLE public.work_order_requests
  ADD COLUMN IF NOT EXISTS department            text,
  ADD COLUMN IF NOT EXISTS location              text,
  ADD COLUMN IF NOT EXISTS phone                 text,
  ADD COLUMN IF NOT EXISTS equipment_description text,
  ADD COLUMN IF NOT EXISTS source                text,
  ADD COLUMN IF NOT EXISTS created_by            text,
  ADD COLUMN IF NOT EXISTS created_at            timestamptz DEFAULT now();

-- ── 2. Asset list for the public form ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.list_public_assets()
RETURNS TABLE(asset_id text, name text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT a.asset_id, a.name
  FROM assets a
  WHERE a.status = 'Active'
    AND a.asset_id IS NOT NULL
    AND a.name IS NOT NULL AND a.name <> ''
  ORDER BY a.name, a.asset_id;
$$;

REVOKE ALL ON FUNCTION public.list_public_assets() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_public_assets() TO anon, authenticated;

-- ── 3. Submission RPC ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.submit_public_wo_request(
  p_name                  text,
  p_email                 text,
  p_description           text,
  p_phone                 text DEFAULT NULL,
  p_department            text DEFAULT NULL,
  p_location              text DEFAULT NULL,
  p_asset_id              text DEFAULT NULL,
  p_equipment_description text DEFAULT NULL,
  p_priority              text DEFAULT 'Medium'
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name        text := NULLIF(BTRIM(p_name), '');
  v_email       text := LOWER(NULLIF(BTRIM(p_email), ''));
  v_desc        text := NULLIF(BTRIM(p_description), '');
  v_phone       text := NULLIF(BTRIM(p_phone), '');
  v_dept        text := NULLIF(BTRIM(p_department), '');
  v_loc         text := NULLIF(BTRIM(p_location), '');
  v_asset_id    text := NULLIF(BTRIM(p_asset_id), '');
  v_equip       text := NULLIF(BTRIM(p_equipment_description), '');
  v_priority    text := INITCAP(COALESCE(NULLIF(BTRIM(p_priority), ''), 'Medium'));
  v_asset_name  text;
  v_request_id  text;
  v_recent      int;
BEGIN
  -- Required fields
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'Please enter your name.' USING ERRCODE = '22023';
  END IF;
  IF v_email IS NULL OR v_email !~ '^[a-z0-9._%+-]+@sctcc\.edu$' THEN
    RAISE EXCEPTION 'Please use your SCTCC email address (ending in @sctcc.edu).' USING ERRCODE = '22023';
  END IF;
  IF v_desc IS NULL THEN
    RAISE EXCEPTION 'Please describe the problem.' USING ERRCODE = '22023';
  END IF;
  IF v_asset_id IS NULL AND v_equip IS NULL THEN
    RAISE EXCEPTION 'Please choose the equipment from the list or describe it.' USING ERRCODE = '22023';
  END IF;

  -- Length caps (defensive — the form enforces these too)
  IF length(v_name) > 120 OR length(v_desc) > 2000
     OR length(COALESCE(v_phone, '')) > 40 OR length(COALESCE(v_dept, '')) > 120
     OR length(COALESCE(v_loc, '')) > 120 OR length(COALESCE(v_equip, '')) > 200 THEN
    RAISE EXCEPTION 'One of the fields is too long. Please shorten it and try again.' USING ERRCODE = '22023';
  END IF;

  IF v_priority NOT IN ('Low', 'Medium', 'High') THEN
    v_priority := 'Medium';
  END IF;

  -- Rate limit: 5 per email per rolling hour
  SELECT COUNT(*) INTO v_recent
  FROM work_order_requests
  WHERE LOWER(email) = v_email
    AND request_date > now() - INTERVAL '1 hour';
  IF v_recent >= 5 THEN
    RAISE EXCEPTION 'You have submitted several requests recently. Please wait a bit and try again.' USING ERRCODE = '22023';
  END IF;

  -- Resolve asset. A listed asset wins; otherwise the free-text description
  -- becomes asset_name so the Requests tab and the approved WO both show it.
  IF v_asset_id IS NOT NULL THEN
    SELECT a.name INTO v_asset_name
    FROM assets a
    WHERE a.asset_id = v_asset_id AND a.status = 'Active'
    LIMIT 1;
    IF v_asset_name IS NULL THEN
      RAISE EXCEPTION 'That equipment is no longer in the list. Please pick again or describe it.' USING ERRCODE = '22023';
    END IF;
  ELSE
    v_asset_name := v_equip;
  END IF;

  v_request_id := get_next_id('work_order_request');

  INSERT INTO work_order_requests (
    request_id, name, email, phone, department, location,
    asset_id, asset_name, equipment_description,
    description, priority, status, source,
    request_date, created_at, created_by
  ) VALUES (
    v_request_id, v_name, v_email, v_phone, v_dept, v_loc,
    v_asset_id, v_asset_name, v_equip,
    v_desc, v_priority, 'Pending', 'public_form',
    now(), now(), v_name
  );

  INSERT INTO audit_log (timestamp, user_email, user_name, action, entity_type, entity_id, details)
  VALUES (
    now(), v_email, v_name, 'Submit Work Order Request', 'Work Order Request', v_request_id,
    'Public form: ' || COALESCE(v_dept, '(no dept)') || ' / ' || COALESCE(v_loc, '(no location)') ||
    ' — ' || v_asset_name
  );

  RETURN v_request_id;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_public_wo_request(text, text, text, text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_public_wo_request(text, text, text, text, text, text, text, text, text) TO anon, authenticated;

-- ── Verification (single result set) ────────────────────────────────────────
SELECT 'column' AS kind, column_name AS name, data_type AS detail
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'work_order_requests'
  AND column_name IN ('department', 'location', 'phone', 'equipment_description', 'source', 'created_by', 'created_at')
UNION ALL
SELECT 'function', p.proname,
       'anon_execute=' || has_function_privilege('anon', p.oid, 'EXECUTE')::text ||
       ' secdef=' || p.prosecdef::text
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('list_public_assets', 'submit_public_wo_request')
ORDER BY 1, 2;

ROLLBACK;   -- swap to COMMIT once the verification shows 7 columns + 2 functions with anon_execute=true

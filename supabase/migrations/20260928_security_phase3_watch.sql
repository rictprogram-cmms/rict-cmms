-- ═════════════════════════════════════════════════════════════════════════════
-- RICT CMMS — Security hardening, Phase 3 step 1: WATCH MODE (blocks nothing)
-- File: supabase/migrations/20260928_security_phase3_watch.sql
-- Plan: project doc claude/2026-09-28-rls-security-hardening-plan.md
--
-- Signed-in users can still write to 55 tables with no real rule ("always
-- true" policies). Before enforcing real rules, this records — for about a
-- week — every write a proposed rule WOULD have refused, without refusing it.
-- Then we fix any rule that caught legitimate work and enforce in 3 batches.
--
-- How it works
--   • private.p3_rule(table, op, old_row, new_row) → NULL if the proposed rule
--     allows the write, otherwise a short reason. Rules come from the Access
--     Control matrix (has_perm, same as the screens), ownership of the row, and
--     the lab sign-up Sunday 11:59 PM deadline. Staff (Active Instructor / Super
--     Admin) are always allowed — except audit_log edits/deletes (Super Admin only).
--   • An AFTER trigger on each table calls it only for signed-in API writes
--     (current_user = 'authenticated'). Kiosk functions, other database
--     functions/triggers, cron and the SQL editor are not watched.
--   • A would-be refusal is written to private.p3_watch_log. Nothing is ever
--     blocked; any error inside the check is swallowed.
--   • The private schema is not reachable through the website/API.
--
-- Decisions (Aaron, 2026-09-28): watch first; students' own records same as
-- today (lab sign-ups: own changes until the week's Sunday 11:59 PM, after that
-- a permission / request; time cards: changes need permission); any work order
-- for anyone with work-order permissions; audit log: add own entries only, no
-- edits, only the Super Admin purge.
--
-- Review after a week of normal use (SQL editor):
--   SELECT * FROM private.p3_watch_summary;          -- grouped
--   SELECT * FROM private.p3_watch_log ORDER BY at DESC LIMIT 200;   -- detail
-- Remove watch mode (if ever needed): see the block at the end of this file.
--
-- Dry run: ends in ROLLBACK. Every verification row should show ok = true.
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE SCHEMA IF NOT EXISTS private;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 1: log
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS private.p3_watch_log (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  tbl        text NOT NULL,
  op         text NOT NULL,
  user_email text,
  user_role  text,
  row_key    text,
  reason     text
);
CREATE INDEX IF NOT EXISTS p3_watch_log_at_idx ON private.p3_watch_log (at DESC);
REVOKE ALL ON private.p3_watch_log FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 2: helpers
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION private.p3_me()
 RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp
AS $f$ SELECT lower(coalesce(auth.jwt() ->> 'email', '')) $f$;

-- any Access Control feature on a page
CREATE OR REPLACE FUNCTION private.p3_any(p_page text, p_feats text[])
 RETURNS boolean LANGUAGE sql STABLE SET search_path = public, pg_temp
AS $f$ SELECT EXISTS (SELECT 1 FROM unnest(p_feats) f WHERE public.has_perm(p_page, f)) $f$;

-- the row belongs to the caller (any usual owner column)
CREATE OR REPLACE FUNCTION private.p3_owns(r jsonb)
 RETURNS boolean LANGUAGE sql STABLE SET search_path = private, pg_temp
AS $f$
  SELECT r IS NOT NULL AND private.p3_me() <> '' AND EXISTS (
    SELECT 1 FROM unnest(ARRAY['user_email', 'email', 'created_by', 'submitted_by', 'submitter_email',
                               'requested_by', 'checked_out_by', 'sender_email', 'recipient_email'])
               AS k
     WHERE lower(btrim(coalesce(r ->> k, ''))) = private.p3_me())
$f$;

-- Lab sign-up deadline: the week containing the date (weeks start Sunday)
-- closes Sunday 11:59:59 PM Central — same as isDeadlinePassed() in useLabSignup.js
CREATE OR REPLACE FUNCTION private.p3_signup_open(r jsonb)
 RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp
AS $f$
  SELECT CASE
    WHEN r IS NULL OR coalesce(r ->> 'date', '') = '' THEN false
    ELSE (now() AT TIME ZONE 'America/Chicago')
         <= ((left(r ->> 'date', 10))::date
             - extract(dow FROM (left(r ->> 'date', 10))::date)::int)::timestamp
            + interval '23 hours 59 minutes 59.999 seconds'
  END
$f$;

CREATE OR REPLACE FUNCTION private.p3_row_key(r jsonb)
 RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp
AS $f$
  SELECT coalesce(r ->> 'record_id', r ->> 'signup_id', r ->> 'request_id', r ->> 'wo_id',
                  r ->> 'order_id', r ->> 'asset_id', r ->> 'checkout_id', r ->> 'booking_id',
                  r ->> 'setting_key', r ->> 'log_id', r ->> 'sop_id', r ->> 'pm_id',
                  r ->> 'class_id', r ->> 'id')
$f$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 3: the proposed rules  (NULL = allowed, text = would be refused)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION private.p3_rule(p_tbl text, p_op text, o jsonb, n jsonb)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path = public, private, pg_temp
AS $f$
DECLARE
  r    jsonb := coalesce(n, o);                   -- the row being written
  own  boolean := CASE p_op WHEN 'INSERT' THEN private.p3_owns(n)
                            WHEN 'DELETE' THEN private.p3_owns(o)
                            ELSE private.p3_owns(o) AND private.p3_owns(n) END;
  ok   boolean;
BEGIN
  -- audit log: add your own entries; edits/deletes only the Super Admin
  IF p_tbl = 'audit_log' THEN
    IF p_op = 'INSERT' THEN
      IF coalesce(btrim(n ->> 'user_email'), '') = '' OR own OR public.is_staff() THEN RETURN NULL; END IF;
      RETURN 'audit entry under someone else''s email';
    END IF;
    IF private.p3_me() = 'rictprogram@gmail.com' THEN RETURN NULL; END IF;
    RETURN 'audit log ' || lower(p_op) || ' (Super Admin only)';
  END IF;

  IF public.is_staff() THEN
    RETURN NULL;
  END IF;

  ok := CASE p_tbl
    -- ── Batch A: attendance & grades ────────────────────────────────────────
    WHEN 'time_clock' THEN
      private.p3_any('Reports', ARRAY['edit_time'])
      OR private.p3_any('Volunteer Hours', ARRAY['view_all_students'])
      OR private.p3_any('Weekly Labs', ARRAY['view_all_students'])
    WHEN 'time_entry_requests' THEN
      (own AND p_op = 'INSERT' AND coalesce(n ->> 'status', 'Pending') = 'Pending')
      OR (own AND p_op = 'UPDATE' AND o ->> 'status' = 'Pending' AND n ->> 'status' IN ('Pending', 'Cancelled'))
      OR (own AND p_op = 'DELETE' AND o ->> 'status' = 'Pending')
      OR private.p3_any('Reports', ARRAY['edit_time'])
      OR private.p3_any('Volunteer Hours', ARRAY['view_all_students'])
    WHEN 'weekly_lab_tracker' THEN
      private.p3_any('Weekly Labs', ARRAY['view_all_students'])
      OR private.p3_any('Reports', ARRAY['edit_time'])
    WHEN 'lab_signup' THEN
      (own AND CASE p_op WHEN 'UPDATE' THEN private.p3_signup_open(o) AND private.p3_signup_open(n)
                         WHEN 'DELETE' THEN private.p3_signup_open(o)
                         ELSE private.p3_signup_open(n) END)
      OR private.p3_any('Lab Signup', ARRAY['manage_others'])
    WHEN 'lab_signup_requests' THEN
      (own AND p_op = 'INSERT' AND coalesce(n ->> 'status', 'Pending') = 'Pending')
      OR (own AND p_op IN ('UPDATE', 'DELETE') AND o ->> 'status' = 'Pending'
          AND (p_op = 'DELETE' OR n ->> 'status' IN ('Pending', 'Cancelled')))
      OR private.p3_any('Lab Signup', ARRAY['manage_others'])
    WHEN 'help_requests' THEN own

    -- ── Batch B: configuration ──────────────────────────────────────────────
    WHEN 'settings' THEN
      private.p3_any('Settings', ARRAY['edit_settings', 'manage_terms'])
      OR (r ->> 'setting_key' ILIKE 'pm%'  AND private.p3_any('PM', ARRAY['generate_wo', 'edit_pm', 'pause_generation']))
      OR (r ->> 'setting_key' ILIKE '%sop%' AND private.p3_any('SOPs', ARRAY['manage_template']))
      OR (r ->> 'setting_key' ILIKE '%woc%' AND private.p3_any('WOC Ratio', ARRAY['edit_scores']))
    WHEN 'classes' THEN
      private.p3_any('Settings', ARRAY['manage_classes', 'manage_terms'])
      OR private.p3_any('Class Schedule', ARRAY['edit_schedule'])
    WHEN 'course_end_dates' THEN private.p3_any('Settings', ARRAY['manage_classes', 'manage_terms'])
    WHEN 'course_outline_revisions' THEN private.p3_any('Settings', ARRAY['manage_classes', 'manage_terms'])
    WHEN 'syllabus_common_sections' THEN private.p3_any('Settings', ARRAY['manage_classes', 'manage_terms'])
    WHEN 'syllabus_courses' THEN private.p3_any('Settings', ARRAY['manage_classes', 'manage_terms'])
    WHEN 'syllabus_templates' THEN private.p3_any('Settings', ARRAY['manage_classes', 'manage_terms'])
    WHEN 'lab_calendar' THEN private.p3_any('Lab Signup', ARRAY['manage_calendar', 'manage_others'])
    WHEN 'lab_schedule' THEN private.p3_any('Lab Signup', ARRAY['manage_calendar', 'manage_others'])
    WHEN 'counters' THEN p_op = 'UPDATE'            -- ID sync after get_next_id, done by everyone creating records
    WHEN 'changelog' THEN false                     -- staff only
    WHEN 'message_templates' THEN private.p3_any('Announcements', ARRAY['manage_templates'])
    WHEN 'announcements' THEN
      (p_op = 'INSERT' AND (coalesce(btrim(n ->> 'sender_email'), '') = '' OR lower(n ->> 'sender_email') = private.p3_me()))
      OR (p_op <> 'INSERT' AND own)
      OR private.p3_any('Announcements', ARRAY['compose_message', 'manage_templates'])
      OR (p_op = 'DELETE' AND private.p3_any('Users', ARRAY['delete_users']))
    WHEN 'tv_slides' THEN private.p3_any('Announcements', ARRAY['manage_tv_slides'])
    WHEN 'glossary' THEN private.p3_any('Glossary', ARRAY['manage_glossary'])
    WHEN 'glossary_categories' THEN private.p3_any('Glossary', ARRAY['manage_glossary'])
    WHEN 'categories' THEN private.p3_any('Settings', ARRAY['manage_categories'])
    WHEN 'locations' THEN private.p3_any('Settings', ARRAY['manage_locations'])
    WHEN 'inventory_locations' THEN private.p3_any('Settings', ARRAY['manage_inventory_locations', 'manage_locations'])
    WHEN 'asset_locations' THEN private.p3_any('Settings', ARRAY['manage_asset_locations', 'manage_locations'])
    WHEN 'wo_status' THEN private.p3_any('Settings', ARRAY['manage_statuses'])
    WHEN 'vendors' THEN private.p3_any('Settings', ARRAY['manage_vendors']) OR private.p3_any('Inventory', ARRAY['manage_suppliers'])
    WHEN 'bug_tracker' THEN
      (own AND p_op IN ('INSERT', 'UPDATE', 'DELETE'))
      OR private.p3_any('Bug Tracker', ARRAY['update_status', 'mark_complete', 'delete_bugs'])
    WHEN 'access_requests' THEN
      (p_op = 'INSERT' AND own AND coalesce(n ->> 'status', 'Pending') = 'Pending')
      OR private.p3_any('Users', ARRAY['approve_requests', 'edit_users', 'add_users', 'delete_users'])
    WHEN 'assignment_rotation' THEN private.p3_any('Users', ARRAY['approve_requests', 'edit_users'])
    WHEN 'program_budget' THEN private.p3_any('Purchase Orders', ARRAY['approve_po'])

    -- ── Batch C: operations ─────────────────────────────────────────────────
    WHEN 'work_orders' THEN
      CASE p_op
        WHEN 'INSERT' THEN private.p3_any('Work Orders', ARRAY['create_wo'])
                           OR private.p3_any('PM', ARRAY['generate_wo'])
                           OR private.p3_any('Asset Checkouts', ARRAY['checkin_assets'])
                           OR private.p3_any('Assets', ARRAY['edit_assets', 'add_assets'])
        WHEN 'DELETE' THEN private.p3_any('Work Orders', ARRAY['delete_wo'])
        ELSE private.p3_any('Work Orders', ARRAY['edit_wo', 'edit_status', 'close_wo', 'assign_wo', 'edit_due_date',
                                                 'edit_priority', 'add_work_log', 'add_parts', 'exclude_from_woc'])
             OR private.p3_any('Purchase Orders', ARRAY['edit_po', 'receive_po', 'approve_po'])
      END
    WHEN 'work_orders_closed' THEN private.p3_any('Work Orders', ARRAY['close_wo', 'edit_status'])
    WHEN 'work_log' THEN
      CASE p_op
        WHEN 'DELETE' THEN private.p3_any('Work Orders', ARRAY['delete_work_log', 'edit_status'])
                           OR private.p3_any('Purchase Orders', ARRAY['approve_po', 'cancel_po'])
        ELSE private.p3_any('Work Orders', ARRAY['add_work_log', 'edit_status', 'close_wo'])
      END
    WHEN 'work_order_parts' THEN
      CASE p_op WHEN 'DELETE' THEN private.p3_any('Work Orders', ARRAY['delete_parts', 'edit_status'])
                ELSE private.p3_any('Work Orders', ARRAY['add_parts']) END
    WHEN 'work_order_documents' THEN
      CASE p_op WHEN 'DELETE' THEN private.p3_any('Work Orders', ARRAY['delete_documents', 'edit_status'])
                ELSE private.p3_any('Work Orders', ARRAY['create_wo', 'edit_wo', 'add_work_log']) END
    WHEN 'work_order_requests' THEN private.p3_any('Work Orders', ARRAY['create_wo', 'edit_wo'])
    WHEN 'inventory' THEN
      CASE p_op
        WHEN 'INSERT' THEN private.p3_any('Inventory', ARRAY['add_items'])
        WHEN 'DELETE' THEN private.p3_any('Inventory', ARRAY['delete_items'])
        ELSE private.p3_any('Inventory', ARRAY['edit_items', 'adjust_quantity', 'upload_images', 'manage_orders'])
             OR private.p3_any('Purchase Orders', ARRAY['receive_po', 'edit_po', 'approve_po'])
             OR private.p3_any('Work Orders', ARRAY['add_parts'])
      END
    WHEN 'orders' THEN
      CASE p_op
        WHEN 'INSERT' THEN private.p3_any('Purchase Orders', ARRAY['create_po', 'approve_po'])
                           OR private.p3_any('Inventory', ARRAY['create_order', 'manage_orders'])
                           OR private.p3_any('Work Orders', ARRAY['add_parts'])
        WHEN 'DELETE' THEN private.p3_any('Purchase Orders', ARRAY['edit_po', 'cancel_po', 'approve_po'])
        ELSE private.p3_any('Purchase Orders', ARRAY['edit_po', 'approve_po', 'cancel_po', 'send_po', 'receive_po'])
             OR private.p3_any('Inventory', ARRAY['manage_orders'])
             OR private.p3_any('Work Orders', ARRAY['add_parts'])
      END
    WHEN 'order_line_items' THEN
      private.p3_any('Purchase Orders', ARRAY['create_po', 'edit_po', 'approve_po', 'cancel_po', 'receive_po'])
      OR private.p3_any('Inventory', ARRAY['create_order', 'manage_orders'])
      OR private.p3_any('Work Orders', ARRAY['add_parts'])
    WHEN 'assets' THEN
      CASE p_op
        WHEN 'INSERT' THEN private.p3_any('Assets', ARRAY['add_assets', 'duplicate_assets'])
        WHEN 'DELETE' THEN private.p3_any('Assets', ARRAY['delete_assets'])
        ELSE private.p3_any('Assets', ARRAY['edit_assets', 'upload_docs'])
             OR private.p3_any('Asset Checkouts', ARRAY['checkin_assets', 'manage_checkoutable'])
      END
    WHEN 'asset_documents' THEN
      private.p3_any('Assets', ARRAY['upload_docs', 'edit_assets', 'delete_assets'])
      OR private.p3_any('Asset Checkouts', ARRAY['upload_docs'])
    WHEN 'asset_checkouts' THEN
      (own AND private.p3_any('Asset Checkouts', ARRAY['checkout_self']))
      OR private.p3_any('Asset Checkouts', ARRAY['checkout_others', 'checkin_assets', 'extend_due_date', 'force_return'])
    WHEN 'sops' THEN
      CASE p_op
        WHEN 'INSERT' THEN private.p3_any('SOPs', ARRAY['create_sop'])
        WHEN 'DELETE' THEN private.p3_any('SOPs', ARRAY['delete_sop'])
        ELSE private.p3_any('SOPs', ARRAY['edit_sop', 'upload_document', 'replace_document', 'delete_document', 'link_items'])
      END
    WHEN 'sop_assets' THEN private.p3_any('SOPs', ARRAY['link_items', 'create_sop', 'edit_sop', 'delete_sop'])
    WHEN 'sop_pm_schedules' THEN private.p3_any('SOPs', ARRAY['link_items', 'create_sop', 'edit_sop', 'delete_sop'])
    WHEN 'sop_work_orders' THEN
      private.p3_any('SOPs', ARRAY['link_items', 'create_sop', 'edit_sop', 'delete_sop'])
      OR private.p3_any('PM', ARRAY['generate_wo'])
      OR private.p3_any('Work Orders', ARRAY['create_wo', 'edit_wo'])
    WHEN 'pm_schedules' THEN
      CASE p_op
        WHEN 'INSERT' THEN private.p3_any('PM', ARRAY['create_pm'])
        WHEN 'DELETE' THEN private.p3_any('PM', ARRAY['delete_pm'])
        ELSE private.p3_any('PM', ARRAY['edit_pm', 'complete_pm', 'generate_wo', 'pause_generation'])
             OR private.p3_any('Assets', ARRAY['edit_assets'])
             OR private.p3_any('Work Orders', ARRAY['close_wo', 'edit_status'])
      END
    WHEN 'equipment_bookings' THEN
      (own AND p_op = 'INSERT' AND private.p3_any('Equipment Scheduling', ARRAY['book_equipment']))
      OR (own AND p_op <> 'INSERT' AND private.p3_any('Equipment Scheduling', ARRAY['edit_own_booking', 'cancel_own_booking']))
      OR private.p3_any('Equipment Scheduling', ARRAY['manage_all_bookings', 'manage_equipment'])
    WHEN 'lab_equipment' THEN private.p3_any('Equipment Scheduling', ARRAY['manage_equipment'])
    WHEN 'network_devices' THEN
      CASE p_op
        WHEN 'INSERT' THEN private.p3_any('Network Map', ARRAY['add_devices', 'approve_changes'])
        WHEN 'DELETE' THEN private.p3_any('Network Map', ARRAY['delete_devices', 'approve_changes'])
        ELSE private.p3_any('Network Map', ARRAY['edit_devices', 'approve_changes', 'manage_subnets', 'manage_it_segments'])
      END
    WHEN 'network_change_requests' THEN
      (own AND p_op = 'INSERT' AND private.p3_any('Network Map', ARRAY['suggest_changes']))
      OR (own AND p_op = 'UPDATE' AND o ->> 'status' = 'Pending')
      OR private.p3_any('Network Map', ARRAY['approve_changes'])
    WHEN 'network_print_status' THEN private.p3_any('Network Map', ARRAY['print_map', 'edit_devices', 'add_devices'])
    ELSE NULL
  END;

  IF ok IS NULL THEN
    RETURN NULL;                      -- table without a proposed rule yet: never logged
  ELSIF ok THEN
    RETURN NULL;
  END IF;
  RETURN CASE WHEN own THEN 'own row, but rule refuses this ' || lower(p_op)
              ELSE 'no matching permission for ' || lower(p_op) END;
END;
$f$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 4: watcher (never blocks)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION private.p3_watch_eval(p_tbl text, p_op text, o jsonb, n jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, private, pg_temp
AS $f$
DECLARE
  v_reason text;
BEGIN
  v_reason := private.p3_rule(p_tbl, p_op, o, n);
  IF v_reason IS NOT NULL THEN
    INSERT INTO private.p3_watch_log (tbl, op, user_email, user_role, row_key, reason)
    VALUES (p_tbl, p_op, private.p3_me(),
            (SELECT p.role FROM public.profiles p WHERE lower(p.email) = private.p3_me() LIMIT 1),
            private.p3_row_key(coalesce(n, o)), v_reason);
  END IF;
EXCEPTION WHEN others THEN
  BEGIN
    INSERT INTO private.p3_watch_log (tbl, op, user_email, row_key, reason)
    VALUES (p_tbl, p_op, private.p3_me(), private.p3_row_key(coalesce(n, o)), 'rule error: ' || left(SQLERRM, 200));
  EXCEPTION WHEN others THEN NULL;
  END;
END;
$f$;

-- Runs as the caller so it can tell a signed-in API write (current_user =
-- 'authenticated') from database-side work (functions run as their owner).
CREATE OR REPLACE FUNCTION private.p3_watch_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path = pg_catalog, pg_temp
AS $f$
BEGIN
  IF current_user = 'authenticated' THEN
    BEGIN
      PERFORM private.p3_watch_eval(TG_TABLE_NAME, TG_OP,
        CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) END,
        CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) END);
    EXCEPTION WHEN others THEN NULL;       -- never interfere with the write
    END;
  END IF;
  RETURN NULL;
END;
$f$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC, anon, authenticated;
-- Signed-in writes fire the trigger as 'authenticated': it needs to reach
-- exactly these two functions. The private schema is not exposed by the API.
GRANT USAGE ON SCHEMA private TO authenticated;
GRANT EXECUTE ON FUNCTION private.p3_watch_trigger() TO authenticated;
GRANT EXECUTE ON FUNCTION private.p3_watch_eval(text, text, jsonb, jsonb) TO authenticated;

DO $do$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'access_requests', 'announcements', 'asset_checkouts', 'asset_documents', 'asset_locations', 'assets',
    'assignment_rotation', 'audit_log', 'bug_tracker', 'categories', 'changelog', 'classes', 'counters',
    'course_end_dates', 'course_outline_revisions', 'equipment_bookings', 'glossary', 'glossary_categories',
    'help_requests', 'inventory', 'inventory_locations', 'lab_calendar', 'lab_equipment', 'lab_schedule',
    'lab_signup', 'lab_signup_requests', 'locations', 'message_templates', 'network_change_requests',
    'network_devices', 'network_print_status', 'order_line_items', 'orders', 'pm_schedules', 'program_budget',
    'settings', 'sop_assets', 'sop_pm_schedules', 'sop_work_orders', 'sops', 'syllabus_common_sections',
    'syllabus_courses', 'syllabus_templates', 'time_clock', 'time_entry_requests', 'tv_slides', 'vendors',
    'weekly_lab_tracker', 'wo_status', 'work_log', 'work_order_documents', 'work_order_parts',
    'work_order_requests', 'work_orders', 'work_orders_closed']
  LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS p3_watch ON public.%I', t);
      EXECUTE format('CREATE TRIGGER p3_watch AFTER INSERT OR UPDATE OR DELETE ON public.%I
                        FOR EACH ROW EXECUTE FUNCTION private.p3_watch_trigger()', t);
    END IF;
  END LOOP;
END
$do$;

CREATE OR REPLACE VIEW private.p3_watch_summary AS
SELECT tbl, op, coalesce(user_role, '?') AS user_role, reason,
       count(*) AS times, count(DISTINCT user_email) AS people,
       min(at) AS first_at, max(at) AS last_at,
       (array_agg(DISTINCT user_email))[1:5] AS sample_users
  FROM private.p3_watch_log
 GROUP BY tbl, op, coalesce(user_role, '?'), reason
 ORDER BY times DESC;
REVOKE ALL ON private.p3_watch_summary FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 5: tests — the rule answers for a real student and instructor.
-- (No writes; rules are evaluated directly.)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TEMP TABLE _p3_tests (test text, expected text, actual text) ON COMMIT DROP;

DO $do$
DECLARE
  v_student text;
  v_instr   text;
  v_next_mon date := (now() AT TIME ZONE 'America/Chicago')::date
                     + (8 - extract(isodow FROM (now() AT TIME ZONE 'America/Chicago'))::int);   -- next Monday
  v_last_mon date := (now() AT TIME ZONE 'America/Chicago')::date
                     - (extract(isodow FROM (now() AT TIME ZONE 'America/Chicago'))::int + 6);   -- Monday last week
BEGIN
  SELECT email INTO v_student FROM public.profiles WHERE status = 'Active' AND role = 'Student' ORDER BY email LIMIT 1;
  SELECT email INTO v_instr   FROM public.profiles WHERE status = 'Active' AND role = 'Instructor'
                                                     AND lower(email) <> 'rictprogram@gmail.com' ORDER BY email LIMIT 1;
  IF v_student IS NULL OR v_instr IS NULL THEN
    INSERT INTO _p3_tests VALUES ('setup', 'Active student + instructor', 'missing — skipped');
    RETURN;
  END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('email', v_student, 'role', 'authenticated')::text, true);
  INSERT INTO _p3_tests VALUES
    ('student: own lab sign-up next week', 'allowed',
     coalesce(private.p3_rule('lab_signup', 'INSERT', NULL, jsonb_build_object('user_email', v_student, 'date', v_next_mon)), 'allowed')),
    ('student: own lab sign-up last week (past deadline)', 'would refuse',
     CASE WHEN private.p3_rule('lab_signup', 'INSERT', NULL, jsonb_build_object('user_email', v_student, 'date', v_last_mon)) IS NULL THEN 'allowed' ELSE 'would refuse' END),
    ('student: someone else''s lab sign-up', 'would refuse',
     CASE WHEN private.p3_rule('lab_signup', 'INSERT', NULL, jsonb_build_object('user_email', 'other@example.com', 'date', v_next_mon)) IS NULL THEN 'allowed' ELSE 'would refuse' END),
    ('student: edit a time card punch', 'would refuse',
     CASE WHEN private.p3_rule('time_clock', 'UPDATE', jsonb_build_object('user_email', v_student), jsonb_build_object('user_email', v_student)) IS NULL THEN 'allowed' ELSE 'would refuse' END),
    ('student: submit own time-entry request', 'allowed',
     coalesce(private.p3_rule('time_entry_requests', 'INSERT', NULL, jsonb_build_object('user_email', v_student, 'status', 'Pending')), 'allowed')),
    ('student: approve own time-entry request', 'would refuse',
     CASE WHEN private.p3_rule('time_entry_requests', 'UPDATE', jsonb_build_object('user_email', v_student, 'status', 'Pending'),
                                                         jsonb_build_object('user_email', v_student, 'status', 'Approved')) IS NULL THEN 'allowed' ELSE 'would refuse' END),
    ('student: audit entry under own email', 'allowed',
     coalesce(private.p3_rule('audit_log', 'INSERT', NULL, jsonb_build_object('user_email', v_student)), 'allowed')),
    ('student: delete an audit entry', 'would refuse',
     CASE WHEN private.p3_rule('audit_log', 'DELETE', jsonb_build_object('user_email', v_student), NULL) IS NULL THEN 'allowed' ELSE 'would refuse' END),
    ('student: change a setting', 'would refuse',
     CASE WHEN private.p3_rule('settings', 'UPDATE', jsonb_build_object('setting_key', 'grace_period_minutes'),
                                                   jsonb_build_object('setting_key', 'grace_period_minutes')) IS NULL THEN 'allowed' ELSE 'would refuse' END),
    ('student: ID counter sync', 'allowed',
     coalesce(private.p3_rule('counters', 'UPDATE', '{}'::jsonb, '{}'::jsonb), 'allowed'));

  PERFORM set_config('request.jwt.claims', json_build_object('email', v_instr, 'role', 'authenticated')::text, true);
  INSERT INTO _p3_tests VALUES
    ('instructor: edit a time card punch', 'allowed',
     coalesce(private.p3_rule('time_clock', 'UPDATE', jsonb_build_object('user_email', v_student), jsonb_build_object('user_email', v_student)), 'allowed')),
    ('instructor: change a setting', 'allowed',
     coalesce(private.p3_rule('settings', 'UPDATE', jsonb_build_object('setting_key', 'x'), jsonb_build_object('setting_key', 'x')), 'allowed')),
    ('instructor: delete an audit entry (Super Admin only)', 'would refuse',
     CASE WHEN private.p3_rule('audit_log', 'DELETE', jsonb_build_object('user_email', v_student), NULL) IS NULL THEN 'allowed' ELSE 'would refuse' END);
END
$do$;

SELECT section, check_name, expected, actual, (expected = actual) AS ok
FROM (
  SELECT 1 AS ord, 'rule' AS section, test AS check_name, expected, actual FROM _p3_tests
  UNION ALL
  SELECT 2, 'setup', 'tables being watched',
         (SELECT count(*) FROM unnest(ARRAY[
           'access_requests','announcements','asset_checkouts','asset_documents','asset_locations','assets',
           'assignment_rotation','audit_log','bug_tracker','categories','changelog','classes','counters',
           'course_end_dates','course_outline_revisions','equipment_bookings','glossary','glossary_categories',
           'help_requests','inventory','inventory_locations','lab_calendar','lab_equipment','lab_schedule',
           'lab_signup','lab_signup_requests','locations','message_templates','network_change_requests',
           'network_devices','network_print_status','order_line_items','orders','pm_schedules','program_budget',
           'settings','sop_assets','sop_pm_schedules','sop_work_orders','sops','syllabus_common_sections',
           'syllabus_courses','syllabus_templates','time_clock','time_entry_requests','tv_slides','vendors',
           'weekly_lab_tracker','wo_status','work_log','work_order_documents','work_order_parts',
           'work_order_requests','work_orders','work_orders_closed']) t
           WHERE to_regclass('public.' || t) IS NOT NULL)::text,
         (SELECT count(*) FROM pg_trigger WHERE tgname = 'p3_watch' AND NOT tgisinternal)::text
  UNION ALL
  SELECT 2, 'setup', 'watch log hidden from website users', 'false',
         has_table_privilege('authenticated', 'private.p3_watch_log', 'SELECT')::text
) x
ORDER BY ord, check_name;

ROLLBACK;   -- ← swap for COMMIT after every row shows ok = true

-- ─────────────────────────────────────────────────────────────────────────────
-- To turn watch mode off later (not part of this migration):
--   DO $$ DECLARE t record; BEGIN
--     FOR t IN SELECT c.relname FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
--               WHERE g.tgname = 'p3_watch' LOOP
--       EXECUTE format('DROP TRIGGER p3_watch ON public.%I', t.relname);
--     END LOOP; END $$;
-- ─────────────────────────────────────────────────────────────────────────────

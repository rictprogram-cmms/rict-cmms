-- ═══════════════════════════════════════════════════════════════════════════
-- 20261025_wo_close_requires_work_log.sql
--
-- A student cannot close a work order unless it has a work log entry from
-- TODAY (America/Chicago). Instructors / Super Admin are exempt.
--
-- Decisions (Aaron, 2026-10-25)
--   D1  Anyone's entry on that work order today satisfies it (team WOs).
--   D2  Instructors / Super Admin (public.is_staff()) are exempt.
--   D4  Enforced in the database too, so the rule is not only a button state.
--   +   Description must be at least 10 characters (after trimming), so
--       "done" doesn't count as a log. MIN_WORK_LOG_CHARS in the app.
--
-- What counts as "a work log from today" — mirrors isTodayWorkLogEntry() in
-- src/pages/WorkOrdersPage.jsx:
--   • entry_type is not 'Close'       (closing notes don't count)
--   • hours > 0                       (auto rows like "Parts ordered" are 0 h)
--   • work_description at least 10 characters after trimming
--   • timestamp (real UTC) on today's Chicago calendar date
--
-- How
--   BEFORE INSERT trigger on public.work_orders_closed (closing a WO is an
--   upsert into work_orders_closed, then a delete from work_orders). A BEFORE
--   INSERT trigger fires for an upsert even when the row already exists, so
--   both paths are covered. Refusal raises
--     WORK_LOG_REQUIRED: …   (SQLSTATE P0001)
--   which the app recognises and turns into an in-dialog message.
--
--   Only signed-in API calls (JWT role 'authenticated') are checked. The SQL
--   Editor, service role, cron and Edge Functions are not affected. Nothing
--   else about closing changes; existing closed rows are untouched.
--
-- Helpers live in the private schema (not callable from the API). The two
-- "safe" casts never raise, so an odd legacy value in work_log can't block a
-- close by erroring — it just doesn't count.
--
-- Re-runnable. Ends in ROLLBACK — check the result rows (all pass = true),
-- then swap ROLLBACK for COMMIT.
--
-- Undo (after COMMIT):
--   DROP TRIGGER IF EXISTS wo_closed_00_require_work_log ON public.work_orders_closed;
--   DROP FUNCTION IF EXISTS private.wo_close_requires_work_log();
--   DROP FUNCTION IF EXISTS private.wo_safe_num(text);
--   DROP FUNCTION IF EXISTS private.wo_safe_chicago_date(text);
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE SCHEMA IF NOT EXISTS private;

-- ── Safe casts ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.wo_safe_num(p text)
 RETURNS numeric
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF p IS NULL OR btrim(p) = '' THEN RETURN 0; END IF;
  RETURN btrim(p)::numeric;
EXCEPTION WHEN others THEN
  RETURN 0;
END
$function$;

CREATE OR REPLACE FUNCTION private.wo_safe_chicago_date(p text)
 RETURNS date
 LANGUAGE plpgsql
 STABLE
 SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF p IS NULL OR btrim(p) = '' THEN RETURN NULL; END IF;
  RETURN (btrim(p)::timestamptz AT TIME ZONE 'America/Chicago')::date;
EXCEPTION WHEN others THEN
  RETURN NULL;
END
$function$;

-- ── Trigger function ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.wo_close_requires_work_log()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_role  text := coalesce(auth.jwt() ->> 'role', '');
  v_today date := (now() AT TIME ZONE 'America/Chicago')::date;
BEGIN
  -- Only signed-in API calls are checked (SQL Editor / service role / cron pass).
  IF v_role <> 'authenticated' THEN
    RETURN NEW;
  END IF;

  -- Instructors / Super Admin are exempt.
  IF public.is_staff() THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.work_log w
     WHERE w.wo_id = NEW.wo_id
       AND coalesce(btrim(w.entry_type::text), '') <> 'Close'
       AND private.wo_safe_num(w.hours::text) > 0
       AND char_length(btrim(coalesce(w.work_description::text, ''))) >= 10
       AND private.wo_safe_chicago_date(w."timestamp"::text) = v_today
  ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'WORK_LOG_REQUIRED: work order % needs a work log entry from today before it can be closed.', NEW.wo_id
    USING ERRCODE = 'P0001',
          HINT = 'Add a work log entry for today (time worked and at least 10 characters describing what you did), then close the work order.';
END
$function$;

COMMENT ON FUNCTION private.wo_close_requires_work_log() IS
  'BEFORE INSERT on work_orders_closed: non-staff signed-in users may only close a WO that has a work_log entry from today (Chicago), hours > 0, description >= 10 chars, not a Close row. 2026-10-25.';

-- Internal functions: nobody calls these through the API.
REVOKE ALL ON FUNCTION private.wo_safe_num(text)              FROM PUBLIC;
REVOKE ALL ON FUNCTION private.wo_safe_chicago_date(text)     FROM PUBLIC;
REVOKE ALL ON FUNCTION private.wo_close_requires_work_log()   FROM PUBLIC;
DO $g$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION private.wo_safe_num(text) FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION private.wo_safe_chicago_date(text) FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION private.wo_close_requires_work_log() FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION private.wo_safe_num(text) FROM authenticated';
    EXECUTE 'REVOKE ALL ON FUNCTION private.wo_safe_chicago_date(text) FROM authenticated';
    EXECUTE 'REVOKE ALL ON FUNCTION private.wo_close_requires_work_log() FROM authenticated';
  END IF;
END
$g$;

-- ── Trigger ────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS wo_closed_00_require_work_log ON public.work_orders_closed;
CREATE TRIGGER wo_closed_00_require_work_log
  BEFORE INSERT ON public.work_orders_closed
  FOR EACH ROW
  EXECUTE FUNCTION private.wo_close_requires_work_log();

-- ── Self-test (inside this transaction; test rows are removed) ─────────────
CREATE TEMP TABLE _wo_close_log_checks (check_name text, pass boolean, detail text) ON COMMIT DROP;

DO $t$
DECLARE
  v_wo    text := 'WOTEST20261025';
  v_err   text;
  v_claim_student text := json_build_object('role', 'authenticated', 'email', 'wo-close-test@example.invalid')::text;
BEGIN
  -- 1. Trigger installed
  INSERT INTO _wo_close_log_checks
  SELECT 'trigger installed', EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'wo_closed_00_require_work_log'
       AND tgrelid = 'public.work_orders_closed'::regclass
       AND NOT tgisinternal), NULL;

  -- 2. Student with no log today → refused
  PERFORM set_config('request.jwt.claims', v_claim_student, true);
  BEGIN
    INSERT INTO public.work_orders_closed (wo_id, description, status, closed_date)
    VALUES (v_wo, 'Self-test (20261025)', 'Closed', now());
    INSERT INTO _wo_close_log_checks VALUES ('student without log is refused', false, 'insert was accepted');
  EXCEPTION WHEN others THEN
    v_err := SQLERRM;
    INSERT INTO _wo_close_log_checks VALUES ('student without log is refused', v_err LIKE 'WORK_LOG_REQUIRED%', v_err);
  END;

  -- 3. A 0-hour row and a Close row do NOT count
  PERFORM set_config('request.jwt.claims', '', true);
  BEGIN
    INSERT INTO public.work_log (log_id, wo_id, "timestamp", user_name, user_email, hours, work_description, entry_type)
    VALUES ('LOGTEST20261025A', v_wo, now(), 'Test S.', 'wo-close-test@example.invalid', 0, 'Parts ordered — PO test', 'Work'),
           ('LOGTEST20261025B', v_wo, now(), 'Test S.', 'wo-close-test@example.invalid', 0.5, 'CLOSING NOTES: test', 'Close');
    PERFORM set_config('request.jwt.claims', v_claim_student, true);
    BEGIN
      INSERT INTO public.work_orders_closed (wo_id, description, status, closed_date)
      VALUES (v_wo, 'Self-test (20261025)', 'Closed', now());
      INSERT INTO _wo_close_log_checks VALUES ('0-hour and Close rows do not count', false, 'insert was accepted');
    EXCEPTION WHEN others THEN
      v_err := SQLERRM;
      INSERT INTO _wo_close_log_checks VALUES ('0-hour and Close rows do not count', v_err LIKE 'WORK_LOG_REQUIRED%', v_err);
    END;
  EXCEPTION WHEN others THEN
    INSERT INTO _wo_close_log_checks VALUES ('0-hour and Close rows do not count', NULL, 'skipped: ' || SQLERRM);
  END;

  -- 4. Yesterday's real entry does NOT count
  PERFORM set_config('request.jwt.claims', '', true);
  BEGIN
    INSERT INTO public.work_log (log_id, wo_id, "timestamp", user_name, user_email, hours, work_description, entry_type)
    VALUES ('LOGTEST20261025C', v_wo, now() - interval '1 day 1 hour', 'Test S.', 'wo-close-test@example.invalid', 1, 'Yesterday work', 'Work');
    PERFORM set_config('request.jwt.claims', v_claim_student, true);
    BEGIN
      INSERT INTO public.work_orders_closed (wo_id, description, status, closed_date)
      VALUES (v_wo, 'Self-test (20261025)', 'Closed', now());
      INSERT INTO _wo_close_log_checks VALUES ('yesterday''s entry does not count', false, 'insert was accepted');
    EXCEPTION WHEN others THEN
      v_err := SQLERRM;
      INSERT INTO _wo_close_log_checks VALUES ('yesterday''s entry does not count', v_err LIKE 'WORK_LOG_REQUIRED%', v_err);
    END;
  EXCEPTION WHEN others THEN
    INSERT INTO _wo_close_log_checks VALUES ('yesterday''s entry does not count', NULL, 'skipped: ' || SQLERRM);
  END;

  -- 4b. "done" (under 10 characters) does NOT count
  PERFORM set_config('request.jwt.claims', '', true);
  BEGIN
    INSERT INTO public.work_log (log_id, wo_id, "timestamp", user_name, user_email, hours, work_description, entry_type)
    VALUES ('LOGTEST20261025E', v_wo, now(), 'Test S.', 'wo-close-test@example.invalid', 1, '  done  ', 'Work');
    PERFORM set_config('request.jwt.claims', v_claim_student, true);
    BEGIN
      INSERT INTO public.work_orders_closed (wo_id, description, status, closed_date)
      VALUES (v_wo, 'Self-test (20261025)', 'Closed', now());
      INSERT INTO _wo_close_log_checks VALUES ('"done" (under 10 characters) does not count', false, 'insert was accepted');
    EXCEPTION WHEN others THEN
      v_err := SQLERRM;
      INSERT INTO _wo_close_log_checks VALUES ('"done" (under 10 characters) does not count', v_err LIKE 'WORK_LOG_REQUIRED%', v_err);
    END;
  EXCEPTION WHEN others THEN
    INSERT INTO _wo_close_log_checks VALUES ('"done" (under 10 characters) does not count', NULL, 'skipped: ' || SQLERRM);
  END;

  -- 5. Someone else's real entry today → accepted (D1)
  PERFORM set_config('request.jwt.claims', '', true);
  BEGIN
    INSERT INTO public.work_log (log_id, wo_id, "timestamp", user_name, user_email, hours, work_description, entry_type)
    VALUES ('LOGTEST20261025D', v_wo, now(), 'Team M.', 'wo-close-teammate@example.invalid', 0.25, 'Replaced filter', 'Work');  -- 15 characters
    PERFORM set_config('request.jwt.claims', v_claim_student, true);
    BEGIN
      INSERT INTO public.work_orders_closed (wo_id, description, status, closed_date)
      VALUES (v_wo, 'Self-test (20261025)', 'Closed', now());
      INSERT INTO _wo_close_log_checks VALUES ('teammate''s entry today allows close', true, NULL);
    EXCEPTION WHEN others THEN
      INSERT INTO _wo_close_log_checks VALUES ('teammate''s entry today allows close', false, SQLERRM);
    END;
  EXCEPTION WHEN others THEN
    INSERT INTO _wo_close_log_checks VALUES ('teammate''s entry today allows close', NULL, 'skipped: ' || SQLERRM);
  END;

  -- 6. No JWT (SQL Editor / service role) is never blocked
  PERFORM set_config('request.jwt.claims', '', true);
  DELETE FROM public.work_orders_closed WHERE wo_id = v_wo;
  DELETE FROM public.work_log WHERE wo_id = v_wo;
  BEGIN
    INSERT INTO public.work_orders_closed (wo_id, description, status, closed_date)
    VALUES (v_wo, 'Self-test (20261025)', 'Closed', now());
    INSERT INTO _wo_close_log_checks VALUES ('no JWT (SQL Editor / service) not blocked', true, NULL);
  EXCEPTION WHEN others THEN
    INSERT INTO _wo_close_log_checks VALUES ('no JWT (SQL Editor / service) not blocked', false, SQLERRM);
  END;

  -- Clean up test rows
  PERFORM set_config('request.jwt.claims', '', true);
  DELETE FROM public.work_orders_closed WHERE wo_id = v_wo;
  DELETE FROM public.work_log WHERE wo_id = v_wo;

  INSERT INTO _wo_close_log_checks
  SELECT 'test rows removed',
         NOT EXISTS (SELECT 1 FROM public.work_orders_closed WHERE wo_id = v_wo)
     AND NOT EXISTS (SELECT 1 FROM public.work_log WHERE wo_id = v_wo), NULL;

  -- 7. Internal functions not executable from the API
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    INSERT INTO _wo_close_log_checks
    SELECT 'functions not executable by signed-in users',
           NOT has_function_privilege('authenticated', 'private.wo_close_requires_work_log()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'private.wo_safe_num(text)', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'private.wo_safe_chicago_date(text)', 'EXECUTE'), NULL;
  END IF;
END
$t$;

-- One row per check (9); every "pass" should be true. A NULL means a test row
-- could not be inserted (detail says why) — tell Claude before committing.
SELECT check_name, pass, detail FROM _wo_close_log_checks ORDER BY ctid;

ROLLBACK;
-- COMMIT;

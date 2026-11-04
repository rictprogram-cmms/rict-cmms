-- ═════════════════════════════════════════════════════════════════════════════
-- RICT CMMS — Help request rules enforced by the database + kiosk "Pause help"
-- File: supabase/migrations/20261103_help_request_rules.sql
-- Run AFTER: 20261103_help_pause_settings.sql
--
-- What this adds
--   1. A BEFORE INSERT trigger on help_requests that refuses a NEW request
--      when the help button would be locked — the same rules, in the same
--      order, as src/lib/helpAvailability.js:
--        clocked in (open time_clock punch for that email)
--        → lab open today (lab_calendar row, status 'Open')
--        → inside open hours (start_time ≤ now < end_time, no grace)
--        → not inside a closure block (closed_blocks)
--        → not the lunch hour (lunch_hour)
--        → help not paused (Away – pause help, end time honoured)
--      A refused insert raises  HELP_LOCKED:<reason>  (SQLSTATE P0001), e.g.
--      HELP_LOCKED:closure. The help button turns that into the same message
--      it shows when it is locked.
--      Only inserts with status 'pending' (or no status) are checked. Cancel,
--      resolve, acknowledge and expire are UPDATEs and are never affected.
--      Times are Central wall clock (now() AT TIME ZONE 'America/Chicago').
--
--   2. Kill switch — setting help_server_rules ('true' | 'false', category
--      System). Set it to false in Settings → System to turn the database
--      rules off instantly; the app's own button locks still apply.
--
--   3. kiosk_instructor_pause_help(p_minutes, p_until_close, p_by) — used by
--      the Lab Status kiosk's "Pause help" button (logged-out screen, so it
--      is SECURITY DEFINER like kiosk_instructor_away_off). Sets the same four
--      Away settings the Settings card writes and records an audit_log entry
--      with the instructor picked on the kiosk.
--        p_minutes      5–240, or NULL with p_until_close = true
--        p_until_close  end at today's lab closing time
--        p_by           display name of the instructor picked on the kiosk
--      Returns {ok, until, label} or {ok:false, error}.
--
-- Dry run: ends in ROLLBACK. Every verification row should show ok = true
-- (rows marked INFO are for reading only). Then change the last line to
-- COMMIT and run again. The self-tests use a calendar day in 2099 and a test
-- email inside a sub-block that is always rolled back, so nothing is left
-- behind even on COMMIT.
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE SCHEMA IF NOT EXISTS private;

-- ── Settings rows (Away keys repeated so this file also works on its own) ──
INSERT INTO public.settings (setting_key, setting_value, description, category, updated_at, updated_by)
SELECT k, v, d, 'System', now(), 'migration'
FROM (VALUES
  ('help_server_rules', 'true',
   'When true, the database refuses help requests while the lab is closed, at lunch, during a closure, when the student is not clocked in, or while help is paused. Set to false to turn these server checks off.'),
  ('instructor_away_blocks_help', 'false',
   'When true (and Away Mode is on), students cannot send new help requests'),
  ('instructor_away_until', '',
   'When Away Mode turns itself off (fake-UTC); empty = no end time')
) AS seed(k, v, d)
WHERE NOT EXISTS (SELECT 1 FROM public.settings s WHERE s.setting_key = seed.k);

-- ── Helpers ─────────────────────────────────────────────────────────────────

-- 'HH:MM' / 'HH:MM:SS' → minutes since midnight, NULL if unreadable
CREATE OR REPLACE FUNCTION private.help_clock_minutes(p text)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE WHEN m IS NULL THEN NULL ELSE m[1]::int * 60 + m[2]::int END
    FROM (SELECT regexp_match(coalesce(p, ''), '^\s*(\d{1,2}):(\d{2})') AS m) x;
$function$;

-- Why a new help request would be refused right now (NULL = allowed).
--   p_local        Central wall-clock time to test (NULL = now)
--   p_check_clock  false skips the clocked-in rule (used by the INFO row)
CREATE OR REPLACE FUNCTION private.help_request_block_reason(
  p_email text, p_local timestamp DEFAULT NULL, p_check_clock boolean DEFAULT true)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_local   timestamp := coalesce(p_local, now() AT TIME ZONE 'America/Chicago');
  v_min     integer;
  v_status  text;
  v_start   integer;
  v_end     integer;
  v_lunch   text;
  v_blocks  jsonb;
  v_btxt    text;
  v_b       jsonb;
  v_bs      integer;
  v_be      integer;
  v_mode    text;
  v_pause   text;
  v_until   text;
  v_until_t timestamptz;
BEGIN
  -- Kill switch
  IF coalesce((SELECT setting_value FROM public.settings WHERE setting_key = 'help_server_rules'), 'true') <> 'true' THEN
    RETURN NULL;
  END IF;

  v_min := extract(hour FROM v_local)::int * 60 + extract(minute FROM v_local)::int;

  -- Clocked in (same test as the help button: an open punch for the email)
  IF p_check_clock AND NOT EXISTS (
       SELECT 1 FROM public.time_clock t
        WHERE lower(t.user_email) = lower(coalesce(p_email, ''))
          AND t.punch_out IS NULL) THEN
    RETURN 'not_clocked_in';
  END IF;

  -- Today's lab day
  SELECT lc.status, private.help_clock_minutes(lc.start_time::text),
         private.help_clock_minutes(lc.end_time::text), lc.lunch_hour::text, lc.closed_blocks::text
    INTO v_status, v_start, v_end, v_lunch, v_btxt
    FROM public.lab_calendar lc
   WHERE (lc.date::date) = v_local::date
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN 'no_calendar';
  END IF;
  -- closed_blocks may be JSONB or text; an unreadable value counts as none
  BEGIN
    v_blocks := CASE WHEN coalesce(btrim(v_btxt), '') IN ('', 'null') THEN NULL ELSE v_btxt::jsonb END;
  EXCEPTION WHEN others THEN
    v_blocks := NULL;
  END;
  IF coalesce(v_status, '') <> 'Open' THEN
    RETURN 'closed_day';
  END IF;

  -- Open hours (same 8–4 fallback as Lab Sign Up for rows without hours)
  IF v_min < coalesce(v_start, 8 * 60) THEN RETURN 'before_open'; END IF;
  IF v_min >= coalesce(v_end, 16 * 60) THEN RETURN 'after_close'; END IF;

  -- Closure blocks (end exclusive)
  IF v_blocks IS NOT NULL AND jsonb_typeof(v_blocks) = 'array' THEN
    FOR v_b IN SELECT * FROM jsonb_array_elements(v_blocks) LOOP
      v_bs := private.help_clock_minutes(v_b ->> 'start');
      v_be := private.help_clock_minutes(v_b ->> 'end');
      IF v_bs IS NOT NULL AND v_be IS NOT NULL AND v_be > v_bs
         AND v_min >= v_bs AND v_min < v_be THEN
        RETURN 'closure';
      END IF;
    END LOOP;
  END IF;

  -- Lunch hour
  IF v_lunch ~ '^\s*\d{1,2}\s*$' AND extract(hour FROM v_local)::int = btrim(v_lunch)::int THEN
    RETURN 'lunch';
  END IF;

  -- Help paused (Away – pause help) unless its end time has passed.
  -- instructor_away_until is fake-UTC: Central wall time labelled +00.
  SELECT max(setting_value) FILTER (WHERE setting_key = 'instructor_away_mode'),
         max(setting_value) FILTER (WHERE setting_key = 'instructor_away_blocks_help'),
         max(setting_value) FILTER (WHERE setting_key = 'instructor_away_until')
    INTO v_mode, v_pause, v_until
    FROM public.settings
   WHERE setting_key IN ('instructor_away_mode', 'instructor_away_blocks_help', 'instructor_away_until');
  IF v_mode = 'true' AND v_pause = 'true' THEN
    IF coalesce(btrim(v_until), '') = '' THEN
      RETURN 'paused';
    END IF;
    BEGIN
      v_until_t := btrim(v_until)::timestamptz;
    EXCEPTION WHEN others THEN
      v_until_t := NULL;                       -- unreadable end time = no end time
    END;
    IF v_until_t IS NULL OR v_until_t > (v_local AT TIME ZONE 'UTC') THEN
      RETURN 'paused';
    END IF;
  END IF;

  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION private.help_request_block_reason(text, timestamp, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.help_clock_minutes(text) FROM PUBLIC, anon, authenticated;

-- ── 1. Trigger ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.trg_help_requests_enforce()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_reason text;
BEGIN
  IF NEW.status IS NOT NULL AND NEW.status <> 'pending' THEN
    RETURN NEW;                                -- data fixes / imports, not a student request
  END IF;
  v_reason := private.help_request_block_reason(NEW.user_email);
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION 'HELP_LOCKED:%', v_reason
      USING ERRCODE = 'P0001',
            HINT = 'Help requests are not available right now.';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS help_requests_enforce_availability ON public.help_requests;
CREATE TRIGGER help_requests_enforce_availability
  BEFORE INSERT ON public.help_requests
  FOR EACH ROW EXECUTE FUNCTION private.trg_help_requests_enforce();

-- ── 3. Kiosk "Pause help" ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.kiosk_instructor_pause_help(
  p_minutes integer DEFAULT NULL, p_until_close boolean DEFAULT false, p_by text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_local   timestamp := now() AT TIME ZONE 'America/Chicago';
  v_by      text := nullif(left(btrim(coalesce(p_by, '')), 60), '');
  v_status  text;
  v_end     integer;
  v_until   timestamp;
  v_iso     text;
  v_label   text;
  k         text;
  v         text;
BEGIN
  IF coalesce(p_until_close, false) THEN
    SELECT lc.status, private.help_clock_minutes(lc.end_time::text)
      INTO v_status, v_end
      FROM public.lab_calendar lc
     WHERE (lc.date::date) = v_local::date
     LIMIT 1;
    IF NOT FOUND OR coalesce(v_status, '') <> 'Open' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'no_close_time');
    END IF;
    v_until := v_local::date + make_interval(mins => coalesce(v_end, 16 * 60));
    IF v_until <= v_local THEN
      RETURN jsonb_build_object('ok', false, 'error', 'no_close_time');
    END IF;
  ELSE
    IF p_minutes IS NULL OR p_minutes < 5 OR p_minutes > 240 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'bad_minutes');
    END IF;
    v_until := date_trunc('minute', v_local) + make_interval(mins => p_minutes);
  END IF;

  v_iso   := to_char(v_until, 'YYYY-MM-DD"T"HH24:MI":00+00:00"');
  v_label := to_char(v_until, 'FMHH12:MI AM');

  -- End time first, then switch on (same order as the Settings card)
  FOR k, v IN SELECT * FROM (VALUES
      ('instructor_away_blocks_help', 'true'),
      ('instructor_away_until', v_iso),
      ('instructor_return_time', v_label),
      ('instructor_away_mode', 'true')) AS kv(k, v)
  LOOP
    UPDATE public.settings
       SET setting_value = v, updated_at = now(), updated_by = coalesce(v_by, 'Lab Status kiosk')
     WHERE setting_key = k;
    IF NOT FOUND THEN
      INSERT INTO public.settings (setting_key, setting_value, description, category, updated_at, updated_by)
      VALUES (k, v, '', 'System', now(), coalesce(v_by, 'Lab Status kiosk'));
    END IF;
  END LOOP;

  BEGIN
    INSERT INTO public.audit_log (user_email, user_name, action, entity_type, entity_id,
                                  field_changed, old_value, new_value, details)
    VALUES ('kiosk', coalesce(v_by, 'Lab Status kiosk'), 'Enable Instructor Away Mode', 'Setting',
            'instructor_away_mode', 'instructor_away_mode', 'false', 'true',
            format('Help paused from the Lab Status kiosk by %s until %s.', coalesce(v_by, 'an instructor'), v_label));
  EXCEPTION WHEN others THEN
    NULL;                                      -- audit is best-effort, never blocks the pause
  END;

  RETURN jsonb_build_object('ok', true, 'until', v_iso, 'label', v_label);
END;
$function$;

REVOKE ALL ON FUNCTION public.kiosk_instructor_pause_help(integer, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kiosk_instructor_pause_help(integer, boolean, text) TO anon, authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TEMP TABLE _hr_tests (test text, ok boolean, detail text) ON COMMIT DROP;

DO $do$
DECLARE
  d      date := DATE '2099-01-05';
  em     text := 'help-rules-selftest@example.com';
  r      text;
  res    text := '';
  expect text := 'before_open,open,closure,open,lunch,after_close,not_clocked_in,paused,open(expired),closed_day,no_calendar,open(killswitch)';
  ex_msg text;
  j      jsonb;
BEGIN
  BEGIN
    -- Fixtures: an Open day 8:00–16:00, lunch 12, closure 14:00–15:00
    INSERT INTO public.lab_calendar (calendar_id, date, start_time, end_time, status, lunch_hour, notes, closed_blocks)
    VALUES ('HR-SELFTEST', (d + time '12:00'), '08:00:00', '16:00:00', 'Open', '12', '',
            '[{"start":"14:00","end":"15:00","reason":"Self-test"}]');
    INSERT INTO public.time_clock (record_id, user_email, status, punch_in)
    VALUES ('HR-SELFTEST', em, 'Punched In', (d + time '07:00'));
    UPDATE public.settings SET setting_value = 'false' WHERE setting_key IN ('instructor_away_mode', 'instructor_away_blocks_help');
    UPDATE public.settings SET setting_value = 'true'  WHERE setting_key = 'help_server_rules';

    res := coalesce(private.help_request_block_reason(em, d + time '07:59'), 'open');
    res := res || ',' || coalesce(private.help_request_block_reason(em, d + time '10:00'), 'open');
    res := res || ',' || coalesce(private.help_request_block_reason(em, d + time '14:30'), 'open');
    res := res || ',' || coalesce(private.help_request_block_reason(em, d + time '15:00'), 'open');
    res := res || ',' || coalesce(private.help_request_block_reason(em, d + time '12:10'), 'open');
    res := res || ',' || coalesce(private.help_request_block_reason(em, d + time '16:00'), 'open');
    res := res || ',' || coalesce(private.help_request_block_reason('someone-else@example.com', d + time '10:00'), 'open');

    UPDATE public.settings SET setting_value = 'true' WHERE setting_key IN ('instructor_away_mode', 'instructor_away_blocks_help');
    UPDATE public.settings SET setting_value = d::text || 'T10:30:00+00:00' WHERE setting_key = 'instructor_away_until';
    res := res || ',' || coalesce(private.help_request_block_reason(em, d + time '10:00'), 'open');
    res := res || ',' || coalesce(private.help_request_block_reason(em, d + time '10:30'), 'open(expired)');
    UPDATE public.settings SET setting_value = 'false' WHERE setting_key IN ('instructor_away_mode', 'instructor_away_blocks_help');

    UPDATE public.lab_calendar SET status = 'Closed' WHERE calendar_id = 'HR-SELFTEST';
    res := res || ',' || coalesce(private.help_request_block_reason(em, d + time '10:00'), 'open');
    res := res || ',' || coalesce(private.help_request_block_reason(em, (d + 1) + time '10:00'), 'open');

    UPDATE public.settings SET setting_value = 'false' WHERE setting_key = 'help_server_rules';
    res := res || ',' || coalesce(private.help_request_block_reason(em, (d + 1) + time '10:00'), 'open(killswitch)');

    RAISE EXCEPTION 'RESULT:%', res;
  EXCEPTION WHEN others THEN
    ex_msg := SQLERRM;
    INSERT INTO _hr_tests VALUES ('rule order at sample times', ex_msg = 'RESULT:' || expect,
      CASE WHEN ex_msg = 'RESULT:' || expect THEN expect ELSE 'got ' || ex_msg || ' | expected ' || expect END);
  END;

  -- Trigger refuses a locked insert (no calendar row on 2099-01-06 → no_calendar
  -- would apply, but the test email is not clocked in, so not_clocked_in first)
  BEGIN
    UPDATE public.settings SET setting_value = 'true' WHERE setting_key = 'help_server_rules';
    INSERT INTO public.help_requests (request_id, user_email, user_name, location, status, requested_at)
    VALUES ('HR-SELFTEST', em, 'Self Test', '1-350', 'pending', now());
    RAISE EXCEPTION 'inserted';
  EXCEPTION WHEN others THEN
    INSERT INTO _hr_tests VALUES ('trigger refuses a locked request', SQLERRM LIKE 'HELP_LOCKED:%', SQLERRM);
  END;

  -- Trigger ignores non-pending inserts
  BEGIN
    INSERT INTO public.help_requests (request_id, user_email, user_name, location, status, requested_at)
    VALUES ('HR-SELFTEST2', em, 'Self Test', '1-350', 'cancelled', now());
    RAISE EXCEPTION 'inserted';
  EXCEPTION WHEN others THEN
    INSERT INTO _hr_tests VALUES ('trigger ignores non-pending rows', SQLERRM = 'inserted', SQLERRM);
  END;

  -- Kiosk pause (as logged-out), then read back; rolled back afterwards
  BEGIN
    EXECUTE 'SET LOCAL ROLE anon';
    j := public.kiosk_instructor_pause_help(30, false, 'Self Test');
    EXECUTE 'RESET ROLE';
    RAISE EXCEPTION 'ok=% mode=% blocks=% until_set=% label_set=%',
      j ->> 'ok',
      (SELECT setting_value FROM public.settings WHERE setting_key = 'instructor_away_mode'),
      (SELECT setting_value FROM public.settings WHERE setting_key = 'instructor_away_blocks_help'),
      (SELECT setting_value = j ->> 'until' FROM public.settings WHERE setting_key = 'instructor_away_until'),
      (SELECT setting_value = j ->> 'label' FROM public.settings WHERE setting_key = 'instructor_return_time');
  EXCEPTION WHEN others THEN
    INSERT INTO _hr_tests VALUES ('kiosk pause 30 min (as logged-out)',
      SQLERRM = 'ok=true mode=true blocks=true until_set=t label_set=t', SQLERRM);
  END;

  BEGIN
    EXECUTE 'SET LOCAL ROLE anon';
    j := public.kiosk_instructor_pause_help(999, false, 'Self Test');
    RAISE EXCEPTION '%', j ->> 'error';
  EXCEPTION WHEN others THEN
    INSERT INTO _hr_tests VALUES ('kiosk pause rejects bad minutes', SQLERRM = 'bad_minutes', SQLERRM);
  END;
END;
$do$;

SELECT n, check_name, ok, detail FROM (
  SELECT 1 AS n, 'trigger installed' AS check_name,
         EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.help_requests'::regclass
                    AND tgname = 'help_requests_enforce_availability' AND NOT tgisinternal) AS ok,
         NULL::text AS detail
  UNION ALL
  SELECT 2, 'kill switch setting present',
         EXISTS (SELECT 1 FROM public.settings WHERE setting_key = 'help_server_rules'),
         (SELECT 'help_server_rules = ' || setting_value FROM public.settings WHERE setting_key = 'help_server_rules')
  UNION ALL
  SELECT 3, 'kiosk pause callable logged-out',
         has_function_privilege('anon', 'public.kiosk_instructor_pause_help(integer, boolean, text)', 'EXECUTE'), NULL
  UNION ALL
  SELECT 4, 'rule function NOT callable by app users',
         NOT has_function_privilege('authenticated', 'private.help_request_block_reason(text, timestamp, boolean)', 'EXECUTE'), NULL
  UNION ALL
  SELECT 5, 'INFO: right now (Central) a clocked-in student would be',
         NULL,
         to_char(now() AT TIME ZONE 'America/Chicago', 'Dy HH12:MI AM') || ' → ' ||
         coalesce(private.help_request_block_reason(NULL, NULL, false), 'ALLOWED')
  UNION ALL
  SELECT 10 + row_number() OVER (), 'self-test: ' || test, ok, detail FROM _hr_tests
  UNION ALL
  SELECT 100, 'self-test left no rows behind',
         NOT EXISTS (SELECT 1 FROM public.lab_calendar WHERE calendar_id = 'HR-SELFTEST')
         AND NOT EXISTS (SELECT 1 FROM public.time_clock WHERE record_id = 'HR-SELFTEST')
         AND NOT EXISTS (SELECT 1 FROM public.help_requests WHERE request_id LIKE 'HR-SELFTEST%'), NULL
) v ORDER BY n;

ROLLBACK;

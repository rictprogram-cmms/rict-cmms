-- ═══════════════════════════════════════════════════════════════════════════
-- RICT CMMS — Auto make-up completion trigger
-- File: supabase/migrations/20260831_fix_trg_auto_makeup_complete.sql
--
-- Purpose
--   When a time_clock row lands with real hours (punch-out / edit), check the
--   student's Approved, not-yet-complete absence requests whose make-up window
--   contains this punch. If logged hours in that window cover hours_missed,
--   auto-mark the absence complete and write an audit_log entry.
--
-- Bug fixed (2026-08-31)
--   makeup_complete_date, updated_at and audit_log.timestamp are timestamptz.
--   The original function assigned a TEXT expression
--   (to_char(...) || '+00') to them, which plpgsql rejects:
--     ERROR 42804: column "makeup_complete_date" is of type timestamp with
--     time zone but expression is of type text
--   This blocked EVERY punch-out that reached the trigger. Fix: build the
--   fake-UTC "now" once and cast it to timestamptz.
--
-- Convention
--   Fake-UTC timestamps: local America/Chicago wall-clock stored with +00
--   (see TIMESTAMP_CONVENTIONS.md). Nothing here changes that.
--
-- Contents
--   1. makeup_window_days(date)      helper, exported from production
--   2. trg_auto_makeup_complete()    trigger function, FIXED
--   3. trigger attachment            exported from production
--   4. smoke test                    manual, read-only
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- Section 1: makeup_window_days
--
-- Returns up to two open lab days (date[]) in the make-up week that begins on
-- the given Monday. Honors the 'lab_visible_days' setting and lab_calendar
-- 'Open' status when a calendar exists for that week.
-- (Exported from production 2026-08-31; unchanged.)
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.makeup_window_days(p_monday date)
 RETURNS date[]
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
  v_visible  int[];
  v_setting  text;
  v_week_sun date := p_monday - 1;            -- lab-signup weeks start Sunday
  v_days     date[] := '{}';
  v_d        date;
  v_open     boolean;
  v_has_cal  boolean;
BEGIN
  SELECT setting_value INTO v_setting FROM public.settings WHERE setting_key = 'lab_visible_days';
  IF v_setting IS NULL OR btrim(v_setting) = '' THEN
    v_visible := ARRAY[1,2,3,4];
  ELSE
    SELECT array_agg(x::int ORDER BY x::int) INTO v_visible
      FROM unnest(string_to_array(v_setting, ',')) AS x
     WHERE btrim(x) ~ '^[0-6]$';
    IF v_visible IS NULL THEN v_visible := ARRAY[1,2,3,4]; END IF;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.lab_calendar
     WHERE (date::date) BETWEEN v_week_sun AND v_week_sun + 6
  ) INTO v_has_cal;

  FOR i IN 0..6 LOOP
    v_d := v_week_sun + i;
    CONTINUE WHEN NOT (EXTRACT(DOW FROM v_d)::int = ANY (v_visible));
    IF v_has_cal THEN
      SELECT COALESCE(bool_or(status = 'Open'), false) INTO v_open
        FROM public.lab_calendar WHERE (date::date) = v_d;
    ELSE
      v_open := true;
    END IF;
    IF v_open THEN
      v_days := v_days || v_d;
      EXIT WHEN array_length(v_days, 1) >= 2;
    END IF;
  END LOOP;

  RETURN v_days;
END;
$function$;


-- ───────────────────────────────────────────────────────────────────────────
-- Section 2: trigger function (fixed)
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.trg_auto_makeup_complete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_email      text := lower(coalesce(NEW.user_email, ''));
  v_punch_date date;
  v_req        record;
  v_window     date[];
  v_logged     numeric;
  -- Fake-UTC "now": local Chicago wall-clock stamped as +00 (project convention).
  -- Cast to timestamptz — target columns are all timestamptz.
  v_now_ts     timestamptz := (to_char(now() AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD"T"HH24:MI:SS') || '+00')::timestamptz;
BEGIN
  -- Only act on rows with real hours (punched out / edited)
  IF v_email = '' OR coalesce(NEW.total_hours, 0) <= 0 THEN RETURN NEW; END IF;
  IF NEW.entry_type IN ('Volunteer') THEN RETURN NEW; END IF;

  -- Fake-UTC convention: the stored wall-clock date IS the local date
  v_punch_date := (NEW.punch_in AT TIME ZONE 'UTC')::date;

  -- Approved, not-yet-complete absences whose make-up week contains this punch
  FOR v_req IN
    SELECT request_id, course_id, class_id, hours_missed, week_start
      FROM public.absence_requests
     WHERE lower(user_email) = v_email
       AND status = 'Approved'
       AND coalesce(makeup_complete, false) = false
       AND coalesce(hours_missed, 0) > 0
       AND v_punch_date BETWEEN (week_start::date + 6) AND (week_start::date + 13)
       AND (
             (course_id IS NOT NULL AND course_id = NEW.course_id)
          OR (class_id  IS NOT NULL AND class_id  = NEW.class_id)
           )
  LOOP
    v_window := public.makeup_window_days(v_req.week_start::date + 7);
    IF v_window IS NULL OR array_length(v_window, 1) IS NULL THEN CONTINUE; END IF;

    SELECT coalesce(sum(total_hours), 0) INTO v_logged
      FROM public.time_clock tc
     WHERE lower(tc.user_email) = v_email
       AND coalesce(tc.entry_type, '') <> 'Volunteer'
       AND coalesce(tc.total_hours, 0) > 0
       AND (tc.punch_in AT TIME ZONE 'UTC')::date = ANY (v_window)
       AND (
             (v_req.course_id IS NOT NULL AND tc.course_id = v_req.course_id)
          OR (v_req.class_id  IS NOT NULL AND tc.class_id  = v_req.class_id)
           );

    IF v_logged >= v_req.hours_missed THEN
      UPDATE public.absence_requests
         SET makeup_complete      = true,
             makeup_complete_by   = 'System (auto — hours met)',
             makeup_complete_date = v_now_ts,
             updated_at           = v_now_ts,
             updated_by           = 'System (auto)'
       WHERE request_id = v_req.request_id
         AND coalesce(makeup_complete, false) = false;

      INSERT INTO public.audit_log
        (log_id, timestamp, user_email, user_name, action, entity_type, entity_id,
         field_changed, old_value, new_value, details)
      VALUES
        ('AL-' || gen_random_uuid()::text,
         v_now_ts,
         v_email, 'System', 'ABSENCE_MAKEUP_AUTO_COMPLETE', 'absence_request', v_req.request_id,
         'makeup_complete', 'false', 'true',
         format('Auto-marked: %s hr logged on %s (needed %s)', v_logged, array_to_string(v_window, ', '), v_req.hours_missed));
    END IF;
  END LOOP;

  RETURN NEW;
END;
$function$;


-- ───────────────────────────────────────────────────────────────────────────
-- Section 3: trigger attachment
-- (Matches production exactly, per pg_get_triggerdef on 2026-08-31.)
-- Fires only when the columns the function actually reads can change.
-- ───────────────────────────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS time_clock_auto_makeup_complete ON public.time_clock;

CREATE TRIGGER time_clock_auto_makeup_complete
  AFTER INSERT OR UPDATE OF total_hours, punch_out, course_id, class_id
  ON public.time_clock
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_auto_makeup_complete();


-- ───────────────────────────────────────────────────────────────────────────
-- Section 4: smoke test (run manually after applying; does not modify data)
-- ───────────────────────────────────────────────────────────────────────────
-- SELECT t.tgname, p.proname
--   FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
--  WHERE t.tgrelid = 'time_clock'::regclass AND NOT t.tgisinternal;
-- Expected: one row — time_clock_auto_makeup_complete / trg_auto_makeup_complete

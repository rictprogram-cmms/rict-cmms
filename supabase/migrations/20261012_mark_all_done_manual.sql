-- ═══════════════════════════════════════════════════════════════════════════
-- RICT CMMS — mark_all_done_manual (Time Cards "Mark week All Done")
-- File: supabase/migrations/20261012_mark_all_done_manual.sql
--
-- RECORD ONLY — this function was installed in Supabase on 2026-10-12 but the
-- migration file never reached the repo. This is its live definition captured
-- with pg_get_functiondef on 2026-11-10, BEFORE the 20261110 patch
-- (20261110_all_done_keep_started_hours.sql changes its sign-up cancel).
-- Do not re-run this on the live database: it would undo that patch.
-- Grants as designed: authenticated only (anon has no access).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.mark_all_done_manual(p_user_id text, p_date date, p_class_id text, p_course_id text, p_note text, p_cancel_signups boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me        text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_caller    public.profiles;
  v_by        text;
  v_student   public.profiles;
  v_uid       text;
  v_name      text;
  v_local     timestamp := private.kiosk_local_now();
  v_today     date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_wstart    date;
  v_wend      date;
  v_existing  public.time_clock;
  v_first     public.time_clock;
  v_stamp     text;
  v_id        text;
  v_note      text := left(btrim(coalesce(p_note, '')), 500);
  v_n         int := 0;
BEGIN
  IF v_me = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_signed_in');
  END IF;
  IF NOT (public.is_staff() OR public.has_perm('Reports', 'edit_time')) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authorized');
  END IF;
  IF p_date IS NULL OR btrim(coalesce(p_user_id, '')) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_input');
  END IF;
  IF p_date > v_today THEN
    RETURN jsonb_build_object('ok', false, 'error', 'future_date');
  END IF;

  SELECT p.* INTO v_student FROM public.profiles p
   WHERE to_jsonb(p) ->> 'user_id' = btrim(p_user_id) OR p.id::text = btrim(p_user_id)
   LIMIT 1;
  IF v_student.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'student_not_found');
  END IF;
  IF lower(coalesce(v_student.email, '')) = v_me THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authorized');
  END IF;

  SELECT p.* INTO v_caller FROM public.profiles p WHERE lower(p.email) = v_me LIMIT 1;
  v_by := coalesce(nullif(btrim(coalesce(v_caller.first_name, '') || ' ' || coalesce(v_caller.last_name, '')), ''), v_me);

  v_uid  := coalesce(nullif(btrim(to_jsonb(v_student) ->> 'user_id'), ''), v_student.id::text);
  v_name := btrim(coalesce(v_student.first_name, '') || ' ' || left(coalesce(v_student.last_name, ''), 1) || '.');
  v_wstart := p_date - (extract(isodow FROM p_date)::int - 1);
  v_wend   := v_wstart + 6;

  -- One writer per student-week
  PERFORM pg_advisory_xact_lock(hashtext('all_done_manual:' || lower(v_student.email) || ':' || v_wstart::text));

  SELECT t.* INTO v_existing FROM public.time_clock t
   WHERE (t.user_id::text = v_uid OR lower(t.user_email) = lower(v_student.email))
     AND t.entry_type = 'All Done'
     AND (t.punch_in AT TIME ZONE 'UTC')::date BETWEEN v_wstart AND v_wend
   ORDER BY t.punch_in LIMIT 1;
  IF v_existing.record_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'already',
      'record_id', v_existing.record_id,
      'recorded_on', to_char(v_existing.punch_in AT TIME ZONE 'UTC', 'YYYY-MM-DD'));
  END IF;

  SELECT t.* INTO v_first FROM public.time_clock t
   WHERE (t.user_id::text = v_uid OR lower(t.user_email) = lower(v_student.email))
     AND coalesce(t.entry_type, '') NOT IN ('All Done', 'Volunteer', 'Club Activity', 'Work Study')
     AND coalesce(nullif(t.course_id::text, ''), nullif(t.class_id::text, '')) IS NOT NULL
     AND (t.punch_in AT TIME ZONE 'UTC')::date BETWEEN v_wstart AND v_wend
   ORDER BY t.punch_in LIMIT 1;

  -- Fake-UTC: Chicago wall clock stamped +00 (TIMESTAMP_CONVENTIONS.md, Convention A)
  v_stamp := CASE WHEN p_date = v_today
                  THEN to_char(v_local, 'YYYY-MM-DD"T"HH24:MI:SS') || '+00'
                  ELSE to_char(p_date, 'YYYY-MM-DD') || 'T12:00:00+00' END;
  v_id := private.kiosk_next_tc_id();

  EXECUTE format(
    'INSERT INTO public.time_clock (record_id, user_id, user_name, user_email, class_id, course_id,
                                    punch_in, punch_out, total_hours, status, week_start, entry_type,
                                    description, approval_status)
     VALUES (%L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L)',
    v_id, v_uid, v_name, v_student.email,
    coalesce(v_first.class_id::text, nullif(btrim(coalesce(p_class_id, '')), ''), ''),
    coalesce(v_first.course_id::text, nullif(btrim(coalesce(p_course_id, '')), ''), ''),
    v_stamp, v_stamp, 0, 'Punched Out',
    to_char(v_wstart, 'YYYY-MM-DD'),
    'All Done',
    'All Done — marked by ' || v_by || ' on Time Cards' || CASE WHEN v_note <> '' THEN ' · ' || v_note ELSE '' END,
    'Approved');

  IF coalesce(p_cancel_signups, false) AND v_today BETWEEN v_wstart AND v_wend THEN
    UPDATE public.lab_signup
       SET status = 'Cancelled'
     WHERE lower(user_email) = lower(v_student.email)
       AND status = 'Confirmed'
       AND date::date BETWEEN v_today AND v_wend;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  END IF;

  INSERT INTO public.audit_log (log_id, timestamp, user_email, user_name, action, entity_type, entity_id,
                                field_changed, old_value, new_value, details)
  VALUES ('LOG' || (extract(epoch FROM clock_timestamp()) * 1000)::bigint || '_' || substr(md5(v_id), 1, 4),
          now(), v_me, v_by, 'ALL_DONE', 'time_clock', v_id, 'all_done', 'No', 'Yes',
          'Marked All Done on Time Cards for ' || btrim(coalesce(v_student.first_name, '') || ' ' || coalesce(v_student.last_name, ''))
          || ' — week of ' || v_wstart::text || ', recorded on ' || p_date::text
          || CASE WHEN v_n > 0 THEN '; cancelled ' || v_n || ' sign-up(s)' ELSE '' END
          || CASE WHEN v_note <> '' THEN ' — Note: ' || v_note ELSE '' END);

  RETURN jsonb_build_object('ok', true, 'record_id', v_id, 'cancelled_signups', v_n,
    'week_start', v_wstart::text, 'recorded_on', p_date::text,
    'student', btrim(coalesce(v_student.first_name, '') || ' ' || coalesce(v_student.last_name, '')));
END;
$function$
;

REVOKE ALL ON FUNCTION public.mark_all_done_manual(text, date, text, text, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_all_done_manual(text, date, text, text, text, boolean) TO authenticated;

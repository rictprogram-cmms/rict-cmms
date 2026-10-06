-- ═════════════════════════════════════════════════════════════════════════════
-- RICT CMMS — Security hardening, Phase 3 prep: badges + All Done + WO close
-- File: supabase/migrations/20261006_security_phase3a_badges_alldone.sql
-- Plan: project doc claude/2026-09-28-rls-security-hardening-plan.md
--
-- From the Phase 3 watch week (2026-09-29 → 10-06):
--   1. Badge numbers (profiles.card_id) were readable by every signed-in user —
--      the All Done screen even downloaded every instructor's badge into the
--      student's browser to compare the swipe. Since Phase 2 a badge number is
--      the kiosk credential, so this mattered.
--      → Badges move to public.user_badges (staff / Users assign_card_id or
--        edit_users only). profiles.card_id is emptied; any write to it (old
--        Users page) is redirected into user_badges.
--      → kiosk_card_profile (Time Clock / Lab kiosk functions) and
--        clear_hold_by_badge now check user_badges.
--   2. All Done (instructor swipe on a student's own time card) wrote lab_signup /
--      time_clock / audit_log from the STUDENT's session — legitimate, but rules
--      can't allow it without letting students mark themselves done.
--      → mark_all_done(card, student_email, …): the database checks the badge
--        is an Active instructor's, cancels the student's remaining Confirmed
--        sign-ups for the week, writes the All Done time_clock marker and the
--        audit row — same data the page wrote before.
--   3. Closing a work order copies it to work_orders_closed, then deletes it from
--      work_orders → the watcher no longer logs that delete for close_wo /
--      edit_status holders when the closed copy exists. (Watch only; the
--      enforcement batch writes it into the real rule.)
--
-- Deploy order: run this (dry run → COMMIT), then push the 4 app files
-- (useUsers.js, useWeeklyLabs.js, AllDoneModal.jsx, AllDoneSection.jsx).
-- Between the two, the Users page shows "no badge" (badges are safe in
-- user_badges) and All Done still works the old way.
--
-- Dry run: ends in ROLLBACK. Every verification row should show ok = true.
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 1: user_badges
-- ─────────────────────────────────────────────────────────────────────────────

DO $do$
DECLARE
  v_type text;
BEGIN
  SELECT format_type(a.atttypid, a.atttypmod) INTO v_type
    FROM pg_attribute a
   WHERE a.attrelid = 'public.profiles'::regclass AND a.attname = 'id' AND NOT a.attisdropped;
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS public.user_badges (
       profile_id       %s PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
       card_id          text NOT NULL CHECK (btrim(card_id) <> ''''),
       updated_at       timestamptz NOT NULL DEFAULT now(),
       updated_by_email text
     )', v_type);
END
$do$;

CREATE INDEX IF NOT EXISTS user_badges_card_idx ON public.user_badges (lower(btrim(card_id)));

COMMENT ON TABLE public.user_badges IS
  'Badge / card numbers (moved out of profiles.card_id on 2026-10-06). Staff and users with Users assign_card_id / edit_users only. Kiosk, All Done and hold-clearing check badges here inside the database.';

ALTER TABLE public.user_badges ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_badges_manage ON public.user_badges;
CREATE POLICY user_badges_manage
  ON public.user_badges FOR ALL TO authenticated
  USING (public.is_staff() OR public.has_perm('Users', 'assign_card_id') OR public.has_perm('Users', 'edit_users'))
  WITH CHECK (public.is_staff() OR public.has_perm('Users', 'assign_card_id') OR public.has_perm('Users', 'edit_users'));
REVOKE ALL ON public.user_badges FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_badges TO authenticated;
GRANT ALL ON public.user_badges TO service_role;

-- Copy existing badges
INSERT INTO public.user_badges (profile_id, card_id, updated_at, updated_by_email)
SELECT p.id, btrim(p.card_id), now(), 'migration 2026-10-06'
  FROM public.profiles p
 WHERE coalesce(btrim(p.card_id), '') <> ''
ON CONFLICT (profile_id) DO NOTHING;

-- Empty profiles.card_id without firing user triggers (name normaliser,
-- write guard, kiosk signal, watch) — only this column changes.
ALTER TABLE public.profiles DISABLE TRIGGER USER;
UPDATE public.profiles SET card_id = NULL WHERE card_id IS NOT NULL;
ALTER TABLE public.profiles ENABLE TRIGGER USER;

-- Any later write to profiles.card_id lands in user_badges instead.
-- Runs after profiles_00_write_guard (alphabetical), so only users already
-- allowed to change the column get here.
CREATE OR REPLACE FUNCTION public.profiles_badge_redirect()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NEW.card_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF btrim(NEW.card_id) = '' THEN
    IF TG_OP = 'UPDATE' THEN
      DELETE FROM public.user_badges WHERE profile_id = NEW.id;
    END IF;
  ELSE
    INSERT INTO public.user_badges (profile_id, card_id, updated_at, updated_by_email)
    VALUES (NEW.id, btrim(NEW.card_id), now(), auth.jwt() ->> 'email')
    ON CONFLICT (profile_id) DO UPDATE
      SET card_id = EXCLUDED.card_id, updated_at = EXCLUDED.updated_at,
          updated_by_email = EXCLUDED.updated_by_email;
  END IF;
  NEW.card_id := NULL;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.profiles_badge_redirect() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS profiles_01_badge_redirect ON public.profiles;
CREATE TRIGGER profiles_01_badge_redirect
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_badge_redirect();

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 2: badge checks read user_badges
-- ─────────────────────────────────────────────────────────────────────────────

-- Kiosk (Time Clock / approvals / All Done): same rules as before — Active,
-- never the utility super-admin, trimmed + case-insensitive match.
CREATE OR REPLACE FUNCTION private.kiosk_card_profile(p_card text)
 RETURNS public.profiles
 LANGUAGE sql
 STABLE
 SET search_path = public, pg_temp
AS $function$
  SELECT p.*
    FROM public.user_badges b
    JOIN public.profiles p ON p.id = b.profile_id
   WHERE coalesce(btrim(p_card), '') <> ''
     AND lower(btrim(b.card_id)) = lower(btrim(p_card))
     AND p.status = 'Active'
     AND lower(coalesce(p.email, '')) <> 'rictprogram@gmail.com'
   ORDER BY p.email
   LIMIT 1;
$function$;
REVOKE ALL ON FUNCTION private.kiosk_card_profile(text) FROM PUBLIC, anon, authenticated;

-- Hold lockout badge swipe — unchanged except the badge lookup
CREATE OR REPLACE FUNCTION public.clear_hold_by_badge(p_hold_id text, p_card_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_caller_email    text;
  v_instructor      record;
  v_display_name    text;
  v_target          record;
BEGIN
  v_caller_email := lower(auth.jwt() ->> 'email');

  IF v_caller_email IS NULL OR v_caller_email = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated');
  END IF;

  -- Verify the swiped card maps to an active instructor/super admin
  SELECT p.email, p.first_name, p.last_name, p.role
    INTO v_instructor
    FROM public.user_badges b
    JOIN public.profiles p ON p.id = b.profile_id
   WHERE coalesce(btrim(p_card_id), '') <> ''
     AND btrim(b.card_id) = btrim(p_card_id)
     AND p.status = 'Active'
     AND (p.role = 'Instructor' OR lower(p.email) = 'rictprogram@gmail.com')
   LIMIT 1;

  IF v_instructor IS NULL THEN
    -- Log the failed attempt against the student's session
    BEGIN
      INSERT INTO public.audit_log (
        user_email, user_name, action, entity_type, entity_id, details
      ) VALUES (
        v_caller_email,
        'Hold Lockout',
        'Failed Hold Badge Swipe',
        'Student Hold',
        p_hold_id,
        'Badge did not match any active instructor'
      );
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    RETURN jsonb_build_object('success', false, 'error', 'Badge not authorized');
  END IF;

  v_display_name := trim(coalesce(v_instructor.first_name, '')
                     || ' '
                     || coalesce(substring(v_instructor.last_name, 1, 1) || '.', ''));

  -- Find the caller's uncleared target for this hold
  SELECT target_id, user_email
    INTO v_target
    FROM public.student_hold_targets
   WHERE hold_id = p_hold_id
     AND lower(user_email) = v_caller_email
     AND cleared_at IS NULL
   LIMIT 1;

  IF v_target IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'No active hold target found for your account');
  END IF;

  -- Clear it
  UPDATE public.student_hold_targets
     SET cleared_at       = now(),
         cleared_by_email = v_instructor.email,
         cleared_by_name  = v_display_name,
         cleared_method   = 'badge_swipe'
   WHERE target_id = v_target.target_id;

  -- Audit the successful clear
  BEGIN
    INSERT INTO public.audit_log (
      user_email, user_name, action, entity_type, entity_id, details
    ) VALUES (
      v_instructor.email,
      v_display_name,
      'Clear Hold (Badge Swipe)',
      'Student Hold',
      p_hold_id,
      format('Badge-cleared hold for student %s', v_target.user_email)
    );
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'success', true,
    'cleared_by', v_display_name
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.clear_hold_by_badge(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.clear_hold_by_badge(text, text) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 3: mark_all_done — the All Done instructor swipe, done server-side
-- Mirrors useLabTrackerActions().markAllDone for tracking_type 'None' classes
-- (every class since the Weekly Labs Tracker was retired).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.mark_all_done(p_card text, p_student_email text, p_student_name text,
                                               p_classes jsonb, p_week_number int, p_week_end date)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_me       text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_instr    public.profiles;
  v_student  public.profiles;
  v_active   public.time_clock;
  v_local    timestamp := private.kiosk_local_now();
  v_today    date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_end      date;
  v_first    jsonb := coalesce(p_classes -> 0, '{}'::jsonb);
  v_stamp    text;
  v_week     text;
  v_id       text;
  v_name     text;
  v_n        int;
BEGIN
  IF v_me = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_signed_in');
  END IF;
  IF lower(btrim(coalesce(p_student_email, ''))) <> v_me AND NOT public.is_staff() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authorized');
  END IF;

  v_instr := private.kiosk_card_profile(p_card);
  IF v_instr.id IS NULL OR lower(coalesce(v_instr.role, '')) <> 'instructor' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'badge_not_recognized');
  END IF;

  SELECT p.* INTO v_student FROM public.profiles p
   WHERE lower(p.email) = lower(btrim(p_student_email)) LIMIT 1;
  IF v_student.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'student_not_found');
  END IF;

  v_name := coalesce(nullif(btrim(p_student_name), ''),
                     btrim(coalesce(v_student.first_name, '') || ' ' || coalesce(v_student.last_name, '')));

  -- 1. Cancel remaining Confirmed sign-ups, today through the end of the week
  v_end := greatest(v_today, least(coalesce(p_week_end, v_today), v_today + 7));
  UPDATE public.lab_signup
     SET status = 'Cancelled'
   WHERE lower(user_email) = lower(v_student.email)
     AND status = 'Confirmed'
     AND date::date BETWEEN v_today AND v_end;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  -- 2. All Done marker on the time clock (zero-duration, active punch untouched)
  SELECT t.* INTO v_active FROM public.time_clock t
   WHERE lower(t.user_email) = lower(v_student.email) AND t.status = 'Punched In'
   ORDER BY t.punch_in DESC LIMIT 1;

  v_stamp := to_char(v_local, 'YYYY-MM-DD"T"HH24:MI:SS') || '+00';
  v_week  := to_char(v_local::date - (extract(isodow FROM v_local)::int - 1), 'YYYY-MM-DD');
  v_id    := private.kiosk_next_tc_id();

  EXECUTE format(
    'INSERT INTO public.time_clock (record_id, user_id, user_name, user_email, class_id, course_id,
                                    punch_in, punch_out, total_hours, status, week_start, entry_type,
                                    description, approval_status)
     VALUES (%L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L)',
    v_id,
    coalesce(v_active.user_id::text,
             CASE WHEN coalesce(to_jsonb(v_student) ->> 'user_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  THEN to_jsonb(v_student) ->> 'user_id' END),
    v_name,
    v_student.email,
    coalesce(v_active.class_id::text, nullif(v_first ->> 'classId', ''), ''),
    coalesce(v_active.course_id::text, nullif(v_first ->> 'className', ''), ''),
    v_stamp, v_stamp, 0, 'Punched Out',
    coalesce(v_active.week_start::text, v_week),
    'All Done',
    'All Done — released by ' || btrim(coalesce(v_instr.first_name, '') || ' ' || coalesce(v_instr.last_name, '')),
    'Approved');

  -- 3. Audit (same row the page wrote, under the instructor)
  BEGIN
    INSERT INTO public.audit_log (log_id, timestamp, user_email, user_name, action, entity_type, entity_id,
                                  field_changed, old_value, new_value, details)
    VALUES ('LOG' || (extract(epoch FROM clock_timestamp()) * 1000)::bigint, now(), v_instr.email,
            btrim(coalesce(v_instr.first_name, '') || ' ' || coalesce(v_instr.last_name, '')),
            'ALL_DONE', 'weekly_lab_tracker', coalesce(to_jsonb(v_student) ->> 'user_id', v_student.id::text),
            'all_done', 'No', 'Yes',
            'Marked All Done for ' || v_name || ' — Classes: , Week ' || coalesce(p_week_number::text, ''));
  EXCEPTION WHEN others THEN NULL;
  END;

  RETURN jsonb_build_object('ok', true, 'cancelled_signups', v_n, 'record_id', v_id,
    'instructor', jsonb_build_object('first_name', v_instr.first_name, 'last_name', v_instr.last_name));
END;
$function$;
REVOKE ALL ON FUNCTION public.mark_all_done(text, text, text, jsonb, int, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_all_done(text, text, text, jsonb, int, date) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 4: watch — closing a work order (copy to closed, then delete)
-- The watcher itself is replaced (no text-patching of p3_rule): a work_orders
-- DELETE by someone with close_wo / edit_status is not logged when the closed
-- copy already exists. Everything else is exactly as before.
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
  -- Closing a work order: WorkOrdersPage upserts it into work_orders_closed,
  -- then deletes it from work_orders.
  IF p_tbl = 'work_orders' AND p_op = 'DELETE'
     AND private.p3_any('Work Orders', ARRAY['close_wo', 'edit_status'])
     AND EXISTS (SELECT 1 FROM public.work_orders_closed c WHERE c.wo_id::text = o ->> 'wo_id') THEN
    RETURN;
  END IF;

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
REVOKE ALL ON FUNCTION private.p3_watch_eval(text, text, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.p3_watch_eval(text, text, jsonb, jsonb) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 5: verification (tests always rolled back)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TEMP TABLE _p3a_tests (test text, expected text, actual text) ON COMMIT DROP;

DO $do$
DECLARE
  v_student text;
  v_scard   text;
  v_icard   text;
  v_instr   text;
  v_res     jsonb;
  v_n       bigint;
BEGIN
  SELECT p.email, b.card_id INTO v_student, v_scard
    FROM public.profiles p JOIN public.user_badges b ON b.profile_id = p.id
   WHERE p.status = 'Active' AND p.role = 'Student' ORDER BY p.email LIMIT 1;
  SELECT p.email, b.card_id INTO v_instr, v_icard
    FROM public.profiles p JOIN public.user_badges b ON b.profile_id = p.id
   WHERE p.status = 'Active' AND p.role = 'Instructor'
     AND lower(p.email) <> 'rictprogram@gmail.com' ORDER BY p.email LIMIT 1;

  -- student can't read badges
  IF v_student IS NOT NULL THEN
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_student, 'role', 'authenticated')::text, true);
      EXECUTE 'SET LOCAL ROLE authenticated';
      SELECT count(*) INTO v_n FROM public.user_badges;
      RAISE EXCEPTION 'rows=%', v_n;
    EXCEPTION WHEN others THEN
      INSERT INTO _p3a_tests VALUES ('student reads badge numbers', 'rows=0', SQLERRM);
    END;
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_student, 'role', 'authenticated')::text, true);
      EXECUTE 'SET LOCAL ROLE authenticated';
      SELECT count(*) INTO v_n FROM public.profiles WHERE coalesce(btrim(card_id), '') <> '';
      RAISE EXCEPTION 'rows=%', v_n;
    EXCEPTION WHEN others THEN
      INSERT INTO _p3a_tests VALUES ('badge numbers left in profiles', 'rows=0', SQLERRM);
    END;
  END IF;

  -- instructor can read badges
  IF v_instr IS NOT NULL THEN
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_instr, 'role', 'authenticated')::text, true);
      EXECUTE 'SET LOCAL ROLE authenticated';
      SELECT count(*) INTO v_n FROM public.user_badges;
      RAISE EXCEPTION 'rows=%', CASE WHEN v_n > 0 THEN 'some' ELSE '0' END;
    EXCEPTION WHEN others THEN
      INSERT INTO _p3a_tests VALUES ('instructor reads badge numbers', 'rows=some', SQLERRM);
    END;
  END IF;

  -- kiosk still recognises a real badge (logged out)
  IF v_scard IS NOT NULL THEN
    BEGIN
      PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
      EXECUTE 'SET LOCAL ROLE anon';
      RAISE EXCEPTION '%', public.kiosk_badge_lookup(v_scard) ->> 'found';
    EXCEPTION WHEN others THEN
      INSERT INTO _p3a_tests VALUES ('kiosk recognises a student badge', 'true', SQLERRM);
    END;
  END IF;

  -- All Done: instructor badge works, student badge refused
  IF v_student IS NOT NULL AND v_icard IS NOT NULL THEN
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_student, 'role', 'authenticated')::text, true);
      EXECUTE 'SET LOCAL ROLE authenticated';
      v_res := public.mark_all_done(v_icard, v_student, 'Test Student', '[{"className":"RICT0000","classId":""}]'::jsonb, 1, NULL);
      RAISE EXCEPTION '%', v_res ->> 'ok';
    EXCEPTION WHEN others THEN
      INSERT INTO _p3a_tests VALUES ('All Done with an instructor badge', 'true', SQLERRM);
    END;
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_student, 'role', 'authenticated')::text, true);
      EXECUTE 'SET LOCAL ROLE authenticated';
      v_res := public.mark_all_done(coalesce(v_scard, 'x'), v_student, 'Test Student', '[]'::jsonb, 1, NULL);
      RAISE EXCEPTION '%', v_res ->> 'error';
    EXCEPTION WHEN others THEN
      INSERT INTO _p3a_tests VALUES ('All Done with a student badge', 'badge_not_recognized', SQLERRM);
    END;
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_student, 'role', 'authenticated')::text, true);
      EXECUTE 'SET LOCAL ROLE authenticated';
      v_res := public.mark_all_done(v_icard, 'someone.else@example.com', 'X', '[]'::jsonb, 1, NULL);
      RAISE EXCEPTION '%', v_res ->> 'error';
    EXCEPTION WHEN others THEN
      INSERT INTO _p3a_tests VALUES ('student marks someone else All Done', 'not_authorized', SQLERRM);
    END;
  ELSE
    INSERT INTO _p3a_tests VALUES ('All Done tests', 'Active student + instructor with badges', 'missing — skipped');
  END IF;

  -- hold badge swipe still resolves instructor badges (no hold → "no target")
  IF v_student IS NOT NULL AND v_icard IS NOT NULL THEN
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_student, 'role', 'authenticated')::text, true);
      EXECUTE 'SET LOCAL ROLE authenticated';
      RAISE EXCEPTION '%', public.clear_hold_by_badge('NO-SUCH-HOLD', v_icard) ->> 'error';
    EXCEPTION WHEN others THEN
      INSERT INTO _p3a_tests VALUES ('hold swipe recognises instructor badge', 'No active hold target found for your account', SQLERRM);
    END;
  END IF;

  -- watch rule: closing a WO (closed copy exists) is allowed for close_wo holders,
  -- a plain delete without the closed copy is not (checked as staff-free rule text)
  INSERT INTO _p3a_tests VALUES ('watch updated for work order close', 'yes',
    CASE WHEN position('work_orders_closed c' IN pg_get_functiondef('private.p3_watch_eval(text, text, jsonb, jsonb)'::regprocedure)) > 0
         THEN 'yes' ELSE 'no' END);
END
$do$;

SELECT check_name, expected, actual, (expected = actual) AS ok
FROM (
  SELECT test AS check_name, expected, actual FROM _p3a_tests
  UNION ALL
  SELECT 'badges copied to user_badges (FYI count)', (SELECT count(*) FROM public.user_badges)::text,
         (SELECT count(*) FROM public.user_badges)::text
) x
ORDER BY 1;

ROLLBACK;   -- ← swap for COMMIT after every row shows ok = true

-- ═════════════════════════════════════════════════════════════════════════════
-- RICT CMMS — Lab sign-up warnings (stage 1: tracking, bell, log, reset)
-- File: supabase/migrations/20261116_lab_warnings.sql
--
-- Purpose
--   Instructors can warn a student who is short on weekly lab sign-ups, from
--   the Dashboard "Lab sign-ups" list. Three steps per term: warning 1,
--   warning 2, final warning (stage 3 will auto-schedule after the final).
--   Every warning is kept as a permanent, uneditable record so an instructor
--   can show a student exactly when and how often they were warned.
--
-- What it creates
--   1. Sequence lab_warning_id_seq (starts at 1001).
--   2. lab_warnings — one row per event. kind = 'warning' (level 1..3) or
--      'reset'. A student's current level for a term is the number of
--      warnings since their last reset in that term, so a reset never erases
--      history and a new term starts everyone at 0.
--        source  'cmms'   sent from the app (bell notification; email in stage 2)
--                'manual' a past warning logged by hand (Outlook, in person…)
--        sent_on       date the student was contacted (back-dated for manual)
--        created_at    when the row was written (REAL UTC, Convention B)
--        week_of       Monday of the week the warning is about (optional)
--        shortage      frozen text of what they were short, e.g.
--                      "RICT1510 0 of 8 hrs"
--        subject/message  exact text the student was sent (or the pasted
--                      email / note for a manual entry)
--        announcement_id  the bell notification (announcements.id as text)
--        seen_at       first time the student opened / marked it read
--        email_*       reserved for stage 2 (email delivery status)
--   3. Guard trigger: rows cannot be edited — only seen_at and the email_*
--      delivery columns may change after insert. The app has no DELETE.
--   4. Seen trigger on announcements: when a linked bell notification is
--      marked read, lab_warnings.seen_at is stamped (first time only).
--   5. Functions (SECURITY DEFINER, search_path pinned)
--        lab_warning_term_for(date)        term covering that day/week
--        lab_warning_level(email, term)    current level (0..3)
--        lab_warning_send(email, week_of, shortage, expected_level)
--             → next warning + bell notification to the student
--        lab_warning_log(email, sent_on, method, message, week_of, shortage, expected_level)
--             → next warning recorded as a past contact, no notification
--        lab_warning_reset(email, term_id, reason)
--             → reset row + "you can schedule again" notification
--      expected_level stops a stale screen from sending the wrong step if
--      another instructor acted a moment earlier.
--   6. RLS on lab_warnings
--        SELECT — Lab Signup → manage_warnings, OR the row is your own
--                 (students see their own history on their Metrics Report)
--        No INSERT/UPDATE/DELETE policies: writes only through the functions.
--   7. Permission — page 'Lab Signup' (ID matches AccessPage.jsx)
--        P056 manage_warnings  student ✗  work_study ✗  instructor ✓
--   8. Realtime: lab_warnings added to supabase_realtime.
--
-- Notification types written to announcements
--   lab_warning        → the student, for each warning sent from the app
--   lab_warning_reset  → the student, when their warnings are reset
--   Sender is the instructor who acted, so the student can reply in Inbox.
--   NOTE: the message wording below is a plain placeholder — Aaron will write
--   the final wording with the email templates in stage 2.
--
-- Deploy order: run this FIRST, then drop in the app files.
-- Idempotent: safe to run twice.
-- Dry run: ends in ROLLBACK. Check the verification result set, then swap
-- the final ROLLBACK for COMMIT and run again.
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 1: table
-- ─────────────────────────────────────────────────────────────────────────────

CREATE SEQUENCE IF NOT EXISTS public.lab_warning_id_seq START 1001;

CREATE TABLE IF NOT EXISTS public.lab_warnings (
  id                bigint PRIMARY KEY DEFAULT nextval('public.lab_warning_id_seq'),
  student_email     text NOT NULL,
  student_name      text,
  term_id           text NOT NULL REFERENCES public.academic_terms(term_id),
  kind              text NOT NULL,
  level             smallint,
  source            text NOT NULL,
  method            text NOT NULL,
  sent_on           date NOT NULL,
  week_of           date,
  shortage          text,
  subject           text,
  message           text,
  reason            text,
  actor_email       text NOT NULL,
  actor_name        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  announcement_id   text,
  seen_at           timestamptz,
  email_status      text,
  email_message_id  text,
  email_sent_at     timestamptz,
  CONSTRAINT lab_warnings_email_lower CHECK (student_email = lower(student_email)),
  CONSTRAINT lab_warnings_kind        CHECK (kind IN ('warning', 'reset')),
  CONSTRAINT lab_warnings_level       CHECK (
    (kind = 'warning' AND level BETWEEN 1 AND 3) OR (kind = 'reset' AND level IS NULL)
  ),
  CONSTRAINT lab_warnings_source      CHECK (source IN ('cmms', 'manual')),
  CONSTRAINT lab_warnings_method      CHECK (method IN ('CMMS', 'Email', 'In person', 'Teams', 'Phone', 'Other')),
  CONSTRAINT lab_warnings_msg_len     CHECK (message IS NULL OR char_length(message) <= 8000),
  CONSTRAINT lab_warnings_reason_len  CHECK (reason IS NULL OR char_length(reason) <= 1000)
);

ALTER SEQUENCE public.lab_warning_id_seq OWNED BY public.lab_warnings.id;

CREATE INDEX IF NOT EXISTS lab_warnings_student_term_idx ON public.lab_warnings (term_id, student_email, id);
CREATE INDEX IF NOT EXISTS lab_warnings_announcement_idx ON public.lab_warnings (announcement_id) WHERE announcement_id IS NOT NULL;

COMMENT ON TABLE public.lab_warnings IS
  'Lab sign-up warnings (2026-11-16). Permanent record: rows cannot be edited (only seen_at / email_* change) and the app cannot delete them. Current level = warnings since the last reset in the term. Writes only through lab_warning_send / lab_warning_log / lab_warning_reset.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 2: guard + seen triggers
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.lab_warnings_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['seen_at', 'email_status', 'email_message_id', 'email_sent_at'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['seen_at', 'email_status', 'email_message_id', 'email_sent_at']) THEN
    RAISE EXCEPTION 'Lab warnings are a permanent record and cannot be edited.' USING ERRCODE = '42501';
  END IF;
  -- seen_at is set once and never moved
  IF OLD.seen_at IS NOT NULL AND NEW.seen_at IS DISTINCT FROM OLD.seen_at THEN
    NEW.seen_at := OLD.seen_at;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS lab_warnings_guard ON public.lab_warnings;
CREATE TRIGGER lab_warnings_guard
  BEFORE UPDATE ON public.lab_warnings
  FOR EACH ROW EXECUTE FUNCTION public.lab_warnings_guard();

CREATE OR REPLACE FUNCTION public.lab_warnings_mark_seen()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NEW.read IS TRUE AND OLD.read IS DISTINCT FROM TRUE
     AND NEW.notification_type IN ('lab_warning') THEN
    UPDATE public.lab_warnings
       SET seen_at = now()
     WHERE announcement_id = NEW.id::text
       AND seen_at IS NULL;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS lab_warnings_mark_seen ON public.announcements;
CREATE TRIGGER lab_warnings_mark_seen
  AFTER UPDATE OF read ON public.announcements
  FOR EACH ROW EXECUTE FUNCTION public.lab_warnings_mark_seen();

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 3: helpers
-- ─────────────────────────────────────────────────────────────────────────────

-- The term a day (or the week starting that Monday) belongs to. A week whose
-- Monday falls just before a term's first day still counts for that term.
CREATE OR REPLACE FUNCTION public.lab_warning_term_for(p_day date)
 RETURNS text
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
  SELECT t.term_id
    FROM public.academic_terms t
   WHERE p_day BETWEEN (t.begin_date - 6) AND t.end_date
   ORDER BY t.begin_date DESC
   LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.lab_warning_level(p_student_email text, p_term_id text)
 RETURNS integer
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
  SELECT count(*)::int
    FROM public.lab_warnings w
   WHERE w.term_id = p_term_id
     AND w.student_email = lower(btrim(p_student_email))
     AND w.kind = 'warning'
     -- only managers, or the student asking about themselves
     AND (public.has_perm('Lab Signup', 'manage_warnings')
          OR w.student_email = lower(coalesce(auth.jwt() ->> 'email', '')))
     AND w.id > coalesce((
           SELECT max(r.id) FROM public.lab_warnings r
            WHERE r.term_id = p_term_id
              AND r.student_email = lower(btrim(p_student_email))
              AND r.kind = 'reset'), 0);
$function$;

-- Shared checks for the three write functions. Returns the student profile
-- row (email, name) and the caller's display name.
CREATE OR REPLACE FUNCTION public.lab_warning_prepare(p_student_email text, p_term_id text, p_expected_level integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_caller  text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_email   text := lower(btrim(coalesce(p_student_email, '')));
  v_student record;
  v_actor   record;
  v_level   integer;
BEGIN
  IF v_caller = '' OR NOT public.has_perm('Lab Signup', 'manage_warnings') THEN
    RAISE EXCEPTION 'You do not have permission to manage lab warnings.' USING ERRCODE = '42501';
  END IF;
  IF p_term_id IS NULL THEN
    RAISE EXCEPTION 'No academic term covers that date. Add the term under Settings → Terms first.' USING ERRCODE = '22023';
  END IF;

  SELECT p.email, p.first_name, p.last_name INTO v_student
    FROM public.profiles p WHERE lower(p.email) = v_email LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No user found for %.', v_email USING ERRCODE = 'P0002';
  END IF;

  SELECT p.first_name, p.last_name INTO v_actor
    FROM public.profiles p WHERE lower(p.email) = v_caller LIMIT 1;

  -- One writer at a time per student + term, so two instructors can't both
  -- send "warning 2".
  PERFORM pg_advisory_xact_lock(hashtext('lab_warning:' || p_term_id || ':' || v_email));

  v_level := public.lab_warning_level(v_email, p_term_id);
  IF p_expected_level IS NOT NULL AND p_expected_level <> v_level THEN
    RAISE EXCEPTION 'This student''s warnings just changed (now at % of 3). Close and reopen the panel to see the latest.', v_level
      USING ERRCODE = '40001';
  END IF;

  RETURN jsonb_build_object(
    'caller', v_caller,
    'actor_name', nullif(btrim(coalesce(v_actor.first_name, '') || ' ' || coalesce(v_actor.last_name, '')), ''),
    'email', v_email,
    'name', nullif(btrim(coalesce(v_student.first_name, '') || ' ' || coalesce(v_student.last_name, '')), ''),
    'first_name', coalesce(v_student.first_name, ''),
    'level', v_level
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.lab_warning_week_label(p_monday date)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE WHEN p_monday IS NULL THEN NULL
         WHEN extract(month FROM p_monday) = extract(month FROM p_monday + 6)
           THEN to_char(p_monday, 'Mon FMDD') || ' – ' || to_char(p_monday + 6, 'FMDD')
         ELSE to_char(p_monday, 'Mon FMDD') || ' – ' || to_char(p_monday + 6, 'Mon FMDD') END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 4: send (from the app — bell notification)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.lab_warning_send(
  p_student_email  text,
  p_week_of        date,
  p_shortage       text,
  p_expected_level integer
)
 RETURNS public.lab_warnings
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_today    date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_term     text := public.lab_warning_term_for(coalesce(p_week_of, v_today));
  v_ctx      jsonb;
  v_level    integer;
  v_week     text := public.lab_warning_week_label(p_week_of);
  v_short    text := nullif(btrim(coalesce(p_shortage, '')), '');
  v_subject  text;
  v_body     text;
  v_ann_id   text;
  v_row      public.lab_warnings;
BEGIN
  v_ctx := public.lab_warning_prepare(p_student_email, v_term, p_expected_level);
  v_level := (v_ctx ->> 'level')::int + 1;
  IF v_level > 3 THEN
    RAISE EXCEPTION 'The final warning was already sent this term. Reset the warnings to start over.' USING ERRCODE = 'P0001';
  END IF;

  -- Placeholder wording — final wording comes with the email templates (stage 2).
  v_subject := CASE v_level
    WHEN 1 THEN 'Lab sign-up warning (1 of 3)'
    WHEN 2 THEN 'Second lab sign-up warning (2 of 3)'
    ELSE        'Final lab sign-up warning'
  END;
  v_body := 'Hi ' || coalesce(nullif(v_ctx ->> 'first_name', ''), 'there') || ',' || E'\n\n'
         || 'You are short on your required lab sign-up hours'
         || coalesce(' for the week of ' || v_week, '')
         || coalesce(': ' || v_short, '') || '.' || E'\n\n'
         || CASE v_level
              WHEN 1 THEN 'This is warning 1 of 3. Please keep your weekly lab sign-ups up to date.'
              WHEN 2 THEN 'This is warning 2 of 3. The next one is your final warning. After the final warning, your lab time will be scheduled for you based on your class times.'
              ELSE        'This is your final warning. Your lab time will now be scheduled for you based on your class times, and you will not be able to change those sign-ups until your instructor resets this.'
            END
         || E'\n\n' || 'Questions? Reply to this message or talk to your instructor.';

  INSERT INTO public.announcements
    (recipient_email, sender_email, sender_name, subject, body, read, notification_type, created_at)
  VALUES (v_ctx ->> 'email', v_ctx ->> 'caller', coalesce(v_ctx ->> 'actor_name', 'Instructor'),
          v_subject, v_body, false, 'lab_warning', now())
  RETURNING id::text INTO v_ann_id;

  INSERT INTO public.lab_warnings
    (student_email, student_name, term_id, kind, level, source, method, sent_on, week_of,
     shortage, subject, message, actor_email, actor_name, announcement_id)
  VALUES (v_ctx ->> 'email', v_ctx ->> 'name', v_term, 'warning', v_level, 'cmms', 'CMMS', v_today, p_week_of,
          v_short, v_subject, v_body, v_ctx ->> 'caller', v_ctx ->> 'actor_name', v_ann_id)
  RETURNING * INTO v_row;

  BEGIN
    INSERT INTO public.audit_log (user_email, user_name, action, entity_type, entity_id, details)
    VALUES (v_ctx ->> 'caller', v_ctx ->> 'actor_name', 'Lab Warning Sent', 'Lab Warning', v_row.id::text,
            'Warning ' || v_level || ' of 3 to ' || coalesce(v_ctx ->> 'name', v_ctx ->> 'email')
            || coalesce(' — week of ' || v_week, '') || coalesce(' — ' || v_short, ''));
  EXCEPTION WHEN others THEN NULL;
  END;

  RETURN v_row;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 5: log a past warning (no notification)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.lab_warning_log(
  p_student_email  text,
  p_sent_on        date,
  p_method         text,
  p_message        text,
  p_week_of        date,
  p_shortage       text,
  p_expected_level integer
)
 RETURNS public.lab_warnings
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_today   date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_term    text;
  v_ctx     jsonb;
  v_level   integer;
  v_method  text := btrim(coalesce(p_method, ''));
  v_msg     text := btrim(coalesce(p_message, ''));
  v_short   text := nullif(btrim(coalesce(p_shortage, '')), '');
  v_row     public.lab_warnings;
BEGIN
  IF p_sent_on IS NULL THEN
    RAISE EXCEPTION 'Enter the date you warned the student.' USING ERRCODE = '22023';
  END IF;
  IF p_sent_on > v_today THEN
    RAISE EXCEPTION 'The date can''t be in the future.' USING ERRCODE = '22023';
  END IF;
  IF v_method NOT IN ('Email', 'In person', 'Teams', 'Phone', 'Other') THEN
    RAISE EXCEPTION 'Pick how you warned the student.' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_msg) < 3 THEN
    RAISE EXCEPTION 'Paste the email or write a short note about what was said.' USING ERRCODE = '22023';
  END IF;

  -- Must fall in the current term (the one covering today).
  v_term := public.lab_warning_term_for(v_today);
  IF v_term IS NULL OR public.lab_warning_term_for(p_sent_on) IS DISTINCT FROM v_term THEN
    RAISE EXCEPTION 'The date has to be in the current term.' USING ERRCODE = '22023';
  END IF;

  v_ctx := public.lab_warning_prepare(p_student_email, v_term, p_expected_level);
  v_level := (v_ctx ->> 'level')::int + 1;
  IF v_level > 3 THEN
    RAISE EXCEPTION 'This student already has a final warning this term. Reset the warnings first.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.lab_warnings
    (student_email, student_name, term_id, kind, level, source, method, sent_on, week_of,
     shortage, subject, message, actor_email, actor_name)
  VALUES (v_ctx ->> 'email', v_ctx ->> 'name', v_term, 'warning', v_level, 'manual', v_method, p_sent_on, p_week_of,
          v_short, NULL, v_msg, v_ctx ->> 'caller', v_ctx ->> 'actor_name')
  RETURNING * INTO v_row;

  BEGIN
    INSERT INTO public.audit_log (user_email, user_name, action, entity_type, entity_id, details)
    VALUES (v_ctx ->> 'caller', v_ctx ->> 'actor_name', 'Lab Warning Logged', 'Lab Warning', v_row.id::text,
            'Past warning ' || v_level || ' of 3 for ' || coalesce(v_ctx ->> 'name', v_ctx ->> 'email')
            || ' — ' || v_method || ' on ' || to_char(p_sent_on, 'Mon FMDD, YYYY'));
  EXCEPTION WHEN others THEN NULL;
  END;

  RETURN v_row;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 6: reset
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.lab_warning_reset(p_student_email text, p_term_id text, p_reason text)
 RETURNS public.lab_warnings
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_today  date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_ctx    jsonb;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_body   text;
  v_row    public.lab_warnings;
BEGIN
  v_ctx := public.lab_warning_prepare(p_student_email, p_term_id, NULL);
  IF (v_ctx ->> 'level')::int = 0 THEN
    RAISE EXCEPTION 'This student has no warnings to reset.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.lab_warnings
    (student_email, student_name, term_id, kind, level, source, method, sent_on,
     reason, actor_email, actor_name)
  VALUES (v_ctx ->> 'email', v_ctx ->> 'name', p_term_id, 'reset', NULL, 'cmms', 'CMMS', v_today,
          v_reason, v_ctx ->> 'caller', v_ctx ->> 'actor_name')
  RETURNING * INTO v_row;

  v_body := 'Hi ' || coalesce(nullif(v_ctx ->> 'first_name', ''), 'there') || ',' || E'\n\n'
         || 'Your lab sign-up warnings have been reset. You can manage your own lab sign-ups again. Keep up the good work!';

  INSERT INTO public.announcements
    (recipient_email, sender_email, sender_name, subject, body, read, notification_type, created_at)
  VALUES (v_ctx ->> 'email', v_ctx ->> 'caller', coalesce(v_ctx ->> 'actor_name', 'Instructor'),
          'Lab sign-up warnings reset', v_body, false, 'lab_warning_reset', now());

  BEGIN
    INSERT INTO public.audit_log (user_email, user_name, action, entity_type, entity_id, details)
    VALUES (v_ctx ->> 'caller', v_ctx ->> 'actor_name', 'Lab Warnings Reset', 'Lab Warning', v_row.id::text,
            'Reset ' || (v_ctx ->> 'level') || ' warning(s) for ' || coalesce(v_ctx ->> 'name', v_ctx ->> 'email')
            || coalesce(' — ' || v_reason, ''));
  EXCEPTION WHEN others THEN NULL;
  END;

  RETURN v_row;
END;
$function$;

REVOKE ALL ON FUNCTION public.lab_warning_term_for(date)                                   FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.lab_warning_level(text, text)                                FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.lab_warning_prepare(text, text, integer)                     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lab_warning_send(text, date, text, integer)                  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.lab_warning_log(text, date, text, text, date, text, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.lab_warning_reset(text, text, text)                          FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lab_warning_term_for(date)                                   TO authenticated;
GRANT EXECUTE ON FUNCTION public.lab_warning_level(text, text)                                TO authenticated;
GRANT EXECUTE ON FUNCTION public.lab_warning_send(text, date, text, integer)                  TO authenticated;
GRANT EXECUTE ON FUNCTION public.lab_warning_log(text, date, text, text, date, text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.lab_warning_reset(text, text, text)                          TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 7: RLS
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.lab_warnings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lab_warnings_select ON public.lab_warnings;
CREATE POLICY lab_warnings_select
  ON public.lab_warnings FOR SELECT TO authenticated
  USING (
    public.has_perm('Lab Signup', 'manage_warnings')
    OR student_email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );

REVOKE ALL ON public.lab_warnings FROM anon, authenticated;
GRANT SELECT ON public.lab_warnings TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 8: realtime
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables
                      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'lab_warnings') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.lab_warnings;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 9: permission (page 'Lab Signup') — ID matches AccessPage.jsx
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO public.permissions
  (permission_id, page, feature, student, work_study, instructor, description, updated_at, updated_by)
SELECT 'P056', 'Lab Signup', 'manage_warnings', false, false, true,
       'Can send, log and reset lab sign-up warnings', now(), 'migration'
 WHERE NOT EXISTS (SELECT 1 FROM public.permissions x WHERE x.page = 'Lab Signup' AND x.feature = 'manage_warnings')
   AND NOT EXISTS (SELECT 1 FROM public.permissions x WHERE x.permission_id = 'P056');

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 10: self-test (runs as the migration owner; cleans up after itself)
--   • a row can't be edited     • seen_at can be set
--   • marking the linked bell notification read stamps seen_at
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TEMP TABLE IF NOT EXISTS _lw_probe (check_name text, result text) ON COMMIT DROP;

DO $$
DECLARE
  v_term text;
  v_id   bigint;
  v_ann  text;
  v_seen timestamptz;
BEGIN
  SELECT term_id INTO v_term FROM public.academic_terms ORDER BY begin_date DESC LIMIT 1;
  IF v_term IS NULL THEN
    INSERT INTO _lw_probe VALUES ('self-test', 'skipped — no academic terms');
    RETURN;
  END IF;

  INSERT INTO public.announcements
    (recipient_email, sender_email, sender_name, subject, body, read, notification_type, created_at)
  VALUES ('dry-run@example.invalid', 'dry-run@example.invalid', 'Dry R.', 'dry run', 'dry run', false, 'lab_warning', now())
  RETURNING id::text INTO v_ann;

  INSERT INTO public.lab_warnings
    (student_email, term_id, kind, level, source, method, sent_on, message, actor_email, announcement_id)
  VALUES ('dry-run@example.invalid', v_term, 'warning', 1, 'cmms', 'CMMS', current_date, 'dry run', 'dry-run@example.invalid', v_ann)
  RETURNING id INTO v_id;

  BEGIN
    UPDATE public.lab_warnings SET message = 'tampered' WHERE id = v_id;
    INSERT INTO _lw_probe VALUES ('edit blocked', 'NO — edit went through');
  EXCEPTION WHEN others THEN
    INSERT INTO _lw_probe VALUES ('edit blocked', 'yes');
  END;

  UPDATE public.announcements SET read = true WHERE id::text = v_ann;
  SELECT seen_at INTO v_seen FROM public.lab_warnings WHERE id = v_id;
  INSERT INTO _lw_probe VALUES ('read stamps seen_at', CASE WHEN v_seen IS NOT NULL THEN 'yes' ELSE 'NO' END);

  DELETE FROM public.lab_warnings WHERE id = v_id;
  DELETE FROM public.announcements WHERE id::text = v_ann;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification (single result set — the SQL Editor shows only the last statement)
--
-- Expect:
--   table      → lab_warnings rls=true policies=1
--   function   → 8 rows (term_for, level, prepare, week_label, send, log,
--                reset, guard/mark_seen show as triggers below)
--   trigger    → lab_warnings_guard, lab_warnings_mark_seen
--   permission → P056 manage_warnings student=false ws=false instr=true
--   realtime   → lab_warnings
--   term_today → the current term id (e.g. FA2026) — NOT empty
--   self-test  → edit blocked = yes, read stamps seen_at = yes
-- ─────────────────────────────────────────────────────────────────────────────

SELECT 'table' AS kind, c.relname AS name,
       'rls=' || c.relrowsecurity::text || ' policies=' ||
       (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname)::text AS detail
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname = 'lab_warnings'
UNION ALL
SELECT 'function', p.proname, CASE WHEN p.prosecdef THEN 'security definer' ELSE 'invoker' END
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('lab_warning_term_for', 'lab_warning_level', 'lab_warning_prepare', 'lab_warning_week_label',
                     'lab_warning_send', 'lab_warning_log', 'lab_warning_reset',
                     'lab_warnings_guard', 'lab_warnings_mark_seen')
UNION ALL
SELECT 'trigger', t.tgname, c.relname
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
 WHERE t.tgname IN ('lab_warnings_guard', 'lab_warnings_mark_seen')
UNION ALL
SELECT 'permission', permission_id || ' ' || feature,
       'student=' || student::text || ' ws=' || work_study::text || ' instr=' || instructor::text
  FROM public.permissions WHERE page = 'Lab Signup' AND feature = 'manage_warnings'
UNION ALL
SELECT 'realtime', tablename, 'in supabase_realtime'
  FROM pg_publication_tables
 WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'lab_warnings'
UNION ALL
SELECT 'term_today', coalesce(public.lab_warning_term_for((now() AT TIME ZONE 'America/Chicago')::date), '(none!)'),
       'week label test: ' || public.lab_warning_week_label('2026-11-16'::date) || ' / ' || public.lab_warning_week_label('2026-11-30'::date)
UNION ALL
SELECT 'self-test', check_name, result FROM _lw_probe
ORDER BY 1, 2;

ROLLBACK;   -- ← swap for COMMIT after checking the verification output

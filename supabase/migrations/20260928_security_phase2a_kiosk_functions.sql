-- ═════════════════════════════════════════════════════════════════════════════
-- RICT CMMS — Security hardening, Phase 2 step 1: kiosk functions (ADDITIVE)
-- File: supabase/migrations/20260928_security_phase2a_kiosk_functions.sql
-- Plan: project doc claude/2026-09-28-rls-security-hardening-plan.md
--
-- Nothing is taken away here — every existing policy stays — so this is safe to
-- run before the new pages deploy. Step 2 (…_phase2b_lockdown.sql) removes the
-- logged-out table access once the new pages are tested on a Pi.
--
-- What it adds
--   • Time Clock (logged-out Pi) — the badge swipe is the proof for everything:
--       kiosk_badge_lookup(card)                     who is this badge? (+ student list for instructors)
--       kiosk_student_state(card, email, date)       open punch + today's sign-ups
--       kiosk_punch_in(card, email, class, course, entry_type)
--       kiosk_punch_out(card, email, record, early, early_minutes, approver_card, is_break)
--       kiosk_verify_instructor(card)                early-departure approval
--       kiosk_record_status(card, email, record)     "punched out elsewhere?" re-check
--     Badge only — a typed email no longer punches anyone (Aaron, 2026-09-28).
--     A card may act for its owner; an instructor's card may act for any student.
--     Punch in refuses a second open punch (no more duplicate open records).
--     Times follow the fake-UTC convention exactly like the page did
--     (local wall-clock America/Chicago written with +00).
--   • TV + Lab Status: kiosk_feed(date) returns today's roster, help queue,
--     time-clock-only list, instructors and open work orders. Emails are replaced
--     by an anonymous per-person key (same person → same key in every list), so
--     the screens' matching logic is unchanged but no email leaves the database.
--   • Lab Status actions: kiosk_help_update(request, 'acknowledge'|'resolve',
--     responder) and kiosk_instructor_away_off().
--   • Login page: email_status(email) → registered / pending / any request.
--   • Live updates: table kiosk_feed_version (topic, version) — readable by the
--     screens, contains no personal data. Triggers bump it whenever time_clock,
--     help_requests, lab_signup, work_orders or relevant profile fields change;
--     the screens subscribe to it and re-fetch the feed.
--
-- Built-in tests (always rolled back, even after COMMIT) run the feed and, when
-- an Active student with a badge exists, a full punch in → punch out cycle as a
-- logged-out caller.
--
-- Dry run: ends in ROLLBACK. Every verification row should show ok = true.
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 1: private schema — salt for anonymous keys + helpers
-- (not exposed through the API; only SECURITY DEFINER functions read it)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS private.kiosk_secret (
  id   int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  salt text NOT NULL
);
INSERT INTO private.kiosk_secret (id, salt)
VALUES (1, md5(random()::text || clock_timestamp()::text) || md5(random()::text))
ON CONFLICT (id) DO NOTHING;
REVOKE ALL ON private.kiosk_secret FROM PUBLIC, anon, authenticated;

-- Anonymous, stable per-person key used by the screens instead of an email.
CREATE OR REPLACE FUNCTION private.kiosk_key(p_email text)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path = private, pg_temp
AS $function$
  SELECT CASE WHEN coalesce(btrim(p_email), '') = '' THEN ''
              ELSE 'k' || left(md5(lower(btrim(p_email)) || (SELECT salt FROM private.kiosk_secret WHERE id = 1)), 16)
         END;
$function$;

-- "First L." exactly like the Time Clock page builds names
CREATE OR REPLACE FUNCTION private.kiosk_short_name(p_first text, p_last text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT btrim(coalesce(p_first, '') || ' ' || left(coalesce(p_last, ''), 1) || '.');
$function$;

-- The profile fields the Time Clock screens use (nothing else, no card number)
CREATE OR REPLACE FUNCTION private.kiosk_profile_json(p public.profiles)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
  SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
    FROM jsonb_each(to_jsonb(p)) e
   WHERE e.key = ANY (ARRAY['id', 'user_id', 'email', 'first_name', 'last_name',
                            'role', 'status', 'classes', 'time_clock_only']);
$function$;

-- Badge → Active profile (badge only; utility super-admin never matches)
CREATE OR REPLACE FUNCTION private.kiosk_card_profile(p_card text)
 RETURNS public.profiles
 LANGUAGE sql
 STABLE
 SET search_path = public, pg_temp
AS $function$
  SELECT p.*
    FROM public.profiles p
   WHERE coalesce(btrim(p_card), '') <> ''
     AND p.status = 'Active'
     AND lower(coalesce(p.email, '')) <> 'rictprogram@gmail.com'
     AND coalesce(btrim(p.card_id), '') <> ''
     AND lower(btrim(p.card_id)) = lower(btrim(p_card))
   ORDER BY p.email
   LIMIT 1;
$function$;

-- fake-UTC "now": local wall clock (America/Chicago) to the second
CREATE OR REPLACE FUNCTION private.kiosk_local_now()
 RETURNS timestamp
 LANGUAGE sql
 STABLE
AS $function$
  SELECT date_trunc('second', now() AT TIME ZONE 'America/Chicago');
$function$;

-- Collision-safe TC###### id — same rules as src/utils/generateSafeTcId.js
CREATE OR REPLACE FUNCTION private.kiosk_next_tc_id()
 RETURNS text
 LANGUAGE plpgsql
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_id      text;
  v_num     bigint;
  v_counter bigint;
  i         int;
BEGIN
  BEGIN
    v_id := public.get_next_id('time_clock');
  EXCEPTION WHEN others THEN
    v_id := NULL;
  END;
  v_num := nullif(regexp_replace(coalesce(v_id, ''), '\D', '', 'g'), '')::bigint;
  v_counter := v_num;

  IF v_num IS NULL THEN
    SELECT greatest(coalesce(max(nullif(regexp_replace(record_id, '\D', '', 'g'), '')::bigint), 0), 1000) + 1
      INTO v_num
      FROM public.time_clock
     WHERE record_id LIKE 'TC%';
    v_id := 'TC' || lpad(v_num::text, 6, '0');
  END IF;

  FOR i IN 1..10 LOOP
    IF NOT EXISTS (SELECT 1 FROM public.time_clock WHERE record_id = v_id) THEN
      IF v_counter IS NOT NULL AND v_num > v_counter THEN
        BEGIN
          UPDATE public.counters SET current_value = v_num, updated_at = now()
           WHERE counter_name = 'time_clock';
        EXCEPTION WHEN others THEN NULL;   -- non-critical, like the page
        END;
      END IF;
      RETURN v_id;
    END IF;
    v_num := v_num + 1;
    v_id := 'TC' || lpad(v_num::text, 6, '0');
  END LOOP;
  RETURN 'TC' || lpad(v_num::text, 6, '0') || '-' || right((extract(epoch FROM clock_timestamp()) * 1000)::bigint::text, 4);
END;
$function$;

-- "12 min" / "1h 5min" / "2h" — same as formatMinutes() on the page
CREATE OR REPLACE FUNCTION private.kiosk_format_minutes(p_mins int)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE
    WHEN coalesce(p_mins, 0) <= 0 THEN ''
    WHEN p_mins < 60 THEN p_mins || ' min'
    WHEN p_mins % 60 > 0 THEN (p_mins / 60) || 'h ' || (p_mins % 60) || 'min'
    ELSE (p_mins / 60) || 'h'
  END;
$function$;

-- Resolve (actor badge, target email) → target profile, or NULL if not allowed.
-- The badge's owner may act for themselves; an instructor badge for anyone Active.
CREATE OR REPLACE FUNCTION private.kiosk_target(p_card text, p_email text,
                                                OUT actor public.profiles,
                                                OUT target public.profiles)
 LANGUAGE plpgsql
 STABLE
 SET search_path = public, pg_temp
AS $function$
BEGIN
  actor := private.kiosk_card_profile(p_card);
  IF actor.id IS NULL THEN
    RETURN;
  END IF;
  IF coalesce(btrim(p_email), '') = '' OR lower(btrim(p_email)) = lower(actor.email) THEN
    target := actor;
    RETURN;
  END IF;
  IF lower(coalesce(actor.role, '')) <> 'instructor' THEN
    RETURN;                                    -- a student badge can't act for others
  END IF;
  SELECT p.* INTO target
    FROM public.profiles p
   WHERE lower(p.email) = lower(btrim(p_email))
     AND p.status = 'Active'
   LIMIT 1;
END;
$function$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 2: live-update signal for the screens
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.kiosk_feed_version (
  topic     text PRIMARY KEY,
  version   bigint NOT NULL DEFAULT 0,
  bumped_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.kiosk_feed_version IS
  'No personal data. Bumped by triggers when kiosk-screen data changes so logged-out screens (TV, Lab Status, Time Clock) know to re-fetch kiosk_feed(). Security phase 2, 2026-09-28.';

INSERT INTO public.kiosk_feed_version (topic)
VALUES ('time_clock'), ('help_requests'), ('lab_signup'), ('work_orders'), ('profiles')
ON CONFLICT (topic) DO NOTHING;

ALTER TABLE public.kiosk_feed_version ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kiosk_feed_version_read ON public.kiosk_feed_version;
CREATE POLICY kiosk_feed_version_read
  ON public.kiosk_feed_version FOR SELECT TO anon, authenticated
  USING (true);
REVOKE ALL ON public.kiosk_feed_version FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.kiosk_feed_version TO anon, authenticated;
GRANT ALL ON public.kiosk_feed_version TO service_role;

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables
                      WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
                        AND tablename = 'kiosk_feed_version') THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.kiosk_feed_version';
  END IF;
END
$do$;

-- Never blocks the write that fired it
CREATE OR REPLACE FUNCTION public.kiosk_bump_feed()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
BEGIN
  BEGIN
    UPDATE public.kiosk_feed_version
       SET version = version + 1, bumped_at = now()
     WHERE topic = TG_TABLE_NAME;
  EXCEPTION WHEN others THEN
    NULL;
  END;
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.kiosk_bump_feed() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS kiosk_bump_feed ON public.time_clock;
CREATE TRIGGER kiosk_bump_feed AFTER INSERT OR UPDATE OR DELETE ON public.time_clock
  FOR EACH STATEMENT EXECUTE FUNCTION public.kiosk_bump_feed();
DROP TRIGGER IF EXISTS kiosk_bump_feed ON public.help_requests;
CREATE TRIGGER kiosk_bump_feed AFTER INSERT OR UPDATE OR DELETE ON public.help_requests
  FOR EACH STATEMENT EXECUTE FUNCTION public.kiosk_bump_feed();
DROP TRIGGER IF EXISTS kiosk_bump_feed ON public.lab_signup;
CREATE TRIGGER kiosk_bump_feed AFTER INSERT OR UPDATE OR DELETE ON public.lab_signup
  FOR EACH STATEMENT EXECUTE FUNCTION public.kiosk_bump_feed();
DROP TRIGGER IF EXISTS kiosk_bump_feed ON public.work_orders;
CREATE TRIGGER kiosk_bump_feed AFTER INSERT OR UPDATE OR DELETE ON public.work_orders
  FOR EACH STATEMENT EXECUTE FUNCTION public.kiosk_bump_feed();
-- profiles: only changes the screens care about (not the 5-minute last_seen heartbeat)
DROP TRIGGER IF EXISTS kiosk_bump_feed ON public.profiles;
DROP TRIGGER IF EXISTS kiosk_bump_feed_ins_del ON public.profiles;
DROP TRIGGER IF EXISTS kiosk_bump_feed_upd ON public.profiles;
CREATE TRIGGER kiosk_bump_feed_ins_del AFTER INSERT OR DELETE ON public.profiles
  FOR EACH STATEMENT EXECUTE FUNCTION public.kiosk_bump_feed();
CREATE TRIGGER kiosk_bump_feed_upd AFTER UPDATE ON public.profiles
  FOR EACH ROW
  WHEN ((OLD.first_name, OLD.last_name, OLD.role, OLD.status, OLD.email)
        IS DISTINCT FROM (NEW.first_name, NEW.last_name, NEW.role, NEW.status, NEW.email)
        OR to_jsonb(OLD) -> 'time_clock_only' IS DISTINCT FROM to_jsonb(NEW) -> 'time_clock_only')
  EXECUTE FUNCTION public.kiosk_bump_feed();

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 3: screen feed for TV Display + Lab Status (no emails)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.kiosk_feed(p_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_from timestamptz := (p_date::timestamp) AT TIME ZONE 'UTC';        -- fake-UTC day start
  v_to   timestamptz := ((p_date + 1)::timestamp) AT TIME ZONE 'UTC';
BEGIN
  IF p_date IS NULL OR abs(p_date - (now() AT TIME ZONE 'America/Chicago')::date) > 1 THEN
    RAISE EXCEPTION 'kiosk_feed: date must be today' USING ERRCODE = '22023';
  END IF;

  RETURN jsonb_build_object(
    'punched_in', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'record_id', t.record_id, 'user_id', t.user_id, 'user_name', t.user_name,
               'user_email', private.kiosk_key(t.user_email),
               'punch_in', t.punch_in, 'punch_out', t.punch_out, 'status', t.status,
               'course_id', t.course_id, 'entry_type', t.entry_type)
             ORDER BY t.punch_in)
        FROM public.time_clock t
       WHERE t.status = 'Punched In' AND t.punch_in >= v_from AND t.punch_in < v_to), '[]'::jsonb),

    'punched_out', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'user_name', t.user_name, 'user_email', private.kiosk_key(t.user_email),
               'punch_in', t.punch_in, 'punch_out', t.punch_out, 'course_id', t.course_id,
               'is_break_punch_out', to_jsonb(t) -> 'is_break_punch_out')
             ORDER BY t.punch_in)
        FROM public.time_clock t
       WHERE t.status = 'Punched Out' AND t.punch_in >= v_from AND t.punch_in < v_to), '[]'::jsonb),

    'signups', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'user_id', s.user_id, 'user_name', s.user_name,
               'user_email', private.kiosk_key(s.user_email),
               'start_time', s.start_time, 'end_time', s.end_time, 'status', s.status))
        FROM public.lab_signup s
       WHERE s.status = 'Confirmed' AND s.date::date = p_date), '[]'::jsonb),

    'help', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'request_id', h.request_id, 'user_name', h.user_name, 'location', h.location,
               'requested_at', h.requested_at, 'status', h.status,
               'acknowledged_at', h.acknowledged_at, 'acknowledged_by', h.acknowledged_by,
               'expires_at', to_jsonb(h) -> 'expires_at')
             ORDER BY h.requested_at)
        FROM public.help_requests h
       WHERE h.status IN ('pending', 'acknowledged')), '[]'::jsonb),

    'time_clock_only', coalesce((
      SELECT jsonb_agg(jsonb_build_object('email', private.kiosk_key(p.email), 'time_clock_only', 'Yes'))
        FROM public.profiles p
       WHERE to_jsonb(p) ->> 'time_clock_only' = 'Yes'), '[]'::jsonb),

    'instructors', coalesce((
      SELECT jsonb_agg(jsonb_build_object('email', private.kiosk_key(p.email),
               'first_name', p.first_name, 'last_name', p.last_name, 'role', p.role)
             ORDER BY p.first_name)
        FROM public.profiles p
       WHERE p.role = 'Instructor' AND p.status = 'Active'
         AND lower(coalesce(p.email, '')) <> 'rictprogram@gmail.com'), '[]'::jsonb),

    'work_orders', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'wo_id', w.wo_id, 'description', w.description, 'priority', w.priority,
               'status', w.status, 'asset_name', w.asset_name, 'assigned_to', w.assigned_to,
               'due_date', w.due_date, 'created_at', w.created_at)
             ORDER BY w.due_date ASC NULLS LAST)
        FROM public.work_orders w
       WHERE w.status <> 'Closed'), '[]'::jsonb)
  );
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 4: Time Clock functions
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.kiosk_badge_lookup(p_card text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_me public.profiles;
BEGIN
  v_me := private.kiosk_card_profile(p_card);
  IF v_me.id IS NULL THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  IF lower(coalesce(v_me.role, '')) = 'instructor' THEN
    RETURN jsonb_build_object(
      'found', true,
      'user', private.kiosk_profile_json(v_me),
      'students', coalesce((
        SELECT jsonb_agg(private.kiosk_profile_json(p)
                         ORDER BY lower(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')))
          FROM public.profiles p
         WHERE p.status = 'Active'
           AND lower(coalesce(p.email, '')) <> 'rictprogram@gmail.com'
           AND lower(coalesce(p.role, '')) <> 'instructor'), '[]'::jsonb));
  END IF;

  RETURN jsonb_build_object('found', true, 'user', private.kiosk_profile_json(v_me), 'students', NULL);
END;
$function$;

CREATE OR REPLACE FUNCTION public.kiosk_verify_instructor(p_card text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_me public.profiles;
BEGIN
  v_me := private.kiosk_card_profile(p_card);
  IF v_me.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'badge_not_found');
  END IF;
  IF lower(coalesce(v_me.role, '')) <> 'instructor' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_instructor');
  END IF;
  RETURN jsonb_build_object('ok', true, 'name', private.kiosk_short_name(v_me.first_name, v_me.last_name));
END;
$function$;

-- Open punch (same search order as the page: profile id, user_id, email)
CREATE OR REPLACE FUNCTION private.kiosk_open_punch(p public.profiles)
 RETURNS public.time_clock
 LANGUAGE plpgsql
 STABLE
 SET search_path = public, pg_temp
AS $function$
DECLARE
  r public.time_clock;
BEGIN
  SELECT t.* INTO r FROM public.time_clock t
   WHERE t.user_id::text = p.id::text AND t.status = 'Punched In'
   ORDER BY t.punch_in DESC LIMIT 1;
  IF FOUND THEN RETURN r; END IF;

  IF coalesce(to_jsonb(p) ->> 'user_id', '') <> '' THEN
    SELECT t.* INTO r FROM public.time_clock t
     WHERE t.user_id::text = to_jsonb(p) ->> 'user_id' AND t.status = 'Punched In'
     ORDER BY t.punch_in DESC LIMIT 1;
    IF FOUND THEN RETURN r; END IF;
  END IF;

  SELECT t.* INTO r FROM public.time_clock t
   WHERE lower(t.user_email) = lower(p.email) AND t.status = 'Punched In'
   ORDER BY t.punch_in DESC LIMIT 1;
  RETURN r;
END;
$function$;
REVOKE ALL ON FUNCTION private.kiosk_open_punch(public.profiles) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.kiosk_student_state(p_card text, p_email text, p_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_pair   record;
  v_actor  public.profiles;
  v_target public.profiles;
  v_open   public.time_clock;
BEGIN
  SELECT * INTO v_pair FROM private.kiosk_target(p_card, p_email);
  v_actor := v_pair.actor;
  v_target := v_pair.target;
  IF v_target.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authorized');
  END IF;

  v_open := private.kiosk_open_punch(v_target);

  RETURN jsonb_build_object(
    'ok', true,
    'open_punch', CASE WHEN v_open.record_id IS NULL THEN NULL ELSE to_jsonb(v_open) END,
    'signups', coalesce((
      SELECT jsonb_agg(jsonb_build_object('date', s.date, 'start_time', s.start_time,
                                          'end_time', s.end_time, 'status', s.status))
        FROM public.lab_signup s
       WHERE lower(s.user_email) = lower(v_target.email)
         AND s.status = 'Confirmed'
         AND s.date::date = p_date), '[]'::jsonb));
END;
$function$;

CREATE OR REPLACE FUNCTION public.kiosk_record_status(p_card text, p_email text, p_record_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_pair   record;
  v_actor  public.profiles;
  v_target public.profiles;
  r        public.time_clock;
BEGIN
  SELECT * INTO v_pair FROM private.kiosk_target(p_card, p_email);
  v_actor := v_pair.actor;
  v_target := v_pair.target;
  IF v_target.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authorized');
  END IF;
  SELECT t.* INTO r FROM public.time_clock t
   WHERE t.record_id = p_record_id
     AND (lower(t.user_email) = lower(v_target.email)
          OR t.user_id::text IN (v_target.id::text, coalesce(to_jsonb(v_target) ->> 'user_id', '')));
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  RETURN jsonb_build_object('ok', true, 'status', r.status, 'total_hours', r.total_hours);
END;
$function$;

CREATE OR REPLACE FUNCTION public.kiosk_punch_in(p_card text, p_email text, p_class_id text,
                                                 p_course_id text, p_entry_type text)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_pair     record;
  v_actor    public.profiles;
  v_target   public.profiles;
  v_open     public.time_clock;
  v_local    timestamp := private.kiosk_local_now();
  v_punch_in text;
  v_week     text;
  v_entry    text;
  v_approval text;
  v_desc     text := '';
  v_id       text;
  v_row      jsonb;
  v_first    boolean;
BEGIN
  SELECT * INTO v_pair FROM private.kiosk_target(p_card, p_email);
  v_actor := v_pair.actor;
  v_target := v_pair.target;
  IF v_target.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authorized');
  END IF;

  v_open := private.kiosk_open_punch(v_target);
  IF v_open.record_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'already_punched_in', 'record', to_jsonb(v_open));
  END IF;

  v_entry := CASE WHEN p_entry_type IN ('Class', 'Volunteer', 'Work Study', 'Club Activity')
                  THEN p_entry_type ELSE 'Class' END;
  v_approval := CASE WHEN v_entry IN ('Volunteer', 'Work Study', 'Club Activity') THEN 'Approved' ELSE 'N/A' END;
  IF v_actor.id <> v_target.id THEN
    v_desc := 'Punched in by instructor: ' || coalesce(v_actor.first_name, '') || ' ' || left(coalesce(v_actor.last_name, ''), 1) || '.';
  END IF;

  v_punch_in := to_char(v_local, 'YYYY-MM-DD"T"HH24:MI:SS') || '+00';
  v_week     := to_char(v_local::date - (extract(isodow FROM v_local)::int - 1), 'YYYY-MM-DD');
  v_id       := private.kiosk_next_tc_id();

  EXECUTE format(
    'INSERT INTO public.time_clock (record_id, user_id, user_name, user_email, class_id, course_id,
                                    punch_in, status, total_hours, week_start, entry_type, description, approval_status)
     VALUES (%L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L)
     RETURNING to_jsonb(time_clock.*)',
    v_id,
    coalesce(nullif(to_jsonb(v_target) ->> 'user_id', ''), v_target.id::text),
    private.kiosk_short_name(v_target.first_name, v_target.last_name),
    v_target.email,
    p_class_id,
    coalesce(nullif(btrim(p_course_id), ''), 'Unknown'),
    v_punch_in, 'Punched In', 0, v_week, v_entry, v_desc, v_approval)
  INTO v_row;

  SELECT NOT EXISTS (
    SELECT 1 FROM public.time_clock t
     WHERE lower(t.user_email) = lower(v_target.email)
       AND t.punch_in >= (v_local::date::timestamp) AT TIME ZONE 'UTC'
       AND t.punch_in <  ((v_local::date + 1)::timestamp) AT TIME ZONE 'UTC'
       AND t.record_id <> v_id)
    INTO v_first;

  RETURN jsonb_build_object('ok', true, 'record', v_row, 'first_punch_today', v_first);
END;
$function$;

CREATE OR REPLACE FUNCTION public.kiosk_punch_out(p_card text, p_email text, p_record_id text,
                                                  p_early boolean, p_early_minutes int,
                                                  p_approver_card text, p_is_break boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_pair      record;
  v_actor     public.profiles;
  v_target    public.profiles;
  v_approver  public.profiles;
  v_approver_name text;
  r           public.time_clock;
  v_local     timestamp := private.kiosk_local_now();
  v_raw       numeric;
  v_total     numeric;
  v_club      boolean;
  v_desc      text;
  v_entry     text;
  v_note      text;
  v_row       jsonb;
  v_set       text;
BEGIN
  SELECT * INTO v_pair FROM private.kiosk_target(p_card, p_email);
  v_actor := v_pair.actor;
  v_target := v_pair.target;
  IF v_target.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authorized');
  END IF;

  SELECT t.* INTO r FROM public.time_clock t
   WHERE t.record_id = p_record_id
     AND (lower(t.user_email) = lower(v_target.email)
          OR t.user_id::text IN (v_target.id::text, coalesce(to_jsonb(v_target) ->> 'user_id', '')))
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  IF r.status IS DISTINCT FROM 'Punched In' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_open', 'status', r.status, 'total_hours', r.total_hours);
  END IF;

  IF coalesce(btrim(p_approver_card), '') <> '' THEN
    v_approver := private.kiosk_card_profile(p_approver_card);
    IF v_approver.id IS NULL OR lower(coalesce(v_approver.role, '')) <> 'instructor' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'approver_not_instructor');
    END IF;
    v_approver_name := private.kiosk_short_name(v_approver.first_name, v_approver.last_name);
  END IF;

  v_club  := r.entry_type = 'Club Activity';
  v_raw   := extract(epoch FROM (v_local - (r.punch_in AT TIME ZONE 'UTC'))) / 3600.0;
  v_total := round(CASE WHEN v_club THEN v_raw * 0.25 ELSE v_raw END, 2);

  v_desc := coalesce(r.description, '');
  IF v_actor.id <> v_target.id THEN
    v_note := 'Punched out by instructor: ' || coalesce(v_actor.first_name, '') || ' ' || left(coalesce(v_actor.last_name, ''), 1) || '.';
    v_desc := CASE WHEN v_desc <> '' THEN v_desc || ' | ' || v_note ELSE v_note END;
  END IF;
  IF coalesce(p_is_break, false) THEN
    v_note := 'Break — out ' || to_char(v_local, 'HH12:MI AM');
    v_desc := CASE WHEN v_desc <> '' THEN v_desc || ' | ' || v_note ELSE v_note END;
  ELSIF v_approver_name IS NOT NULL THEN
    v_note := 'Early departure approved by ' || v_approver_name;
    v_desc := CASE WHEN v_desc <> '' THEN v_desc || ' | ' || v_note ELSE v_note END;
  ELSIF coalesce(p_early, false) THEN
    v_note := CASE WHEN coalesce(p_early_minutes, 0) > 0
                   THEN 'Left early — ' || private.kiosk_format_minutes(p_early_minutes) || ' before scheduled end'
                   ELSE 'Left early' END;
    v_desc := CASE WHEN v_desc <> '' THEN v_desc || ' | ' || v_note ELSE v_note END;
  END IF;

  v_entry := r.entry_type;
  IF coalesce(p_early, false) AND v_approver_name IS NULL AND NOT coalesce(p_is_break, false) THEN
    v_entry := 'Left Early';
  END IF;

  IF v_club THEN
    v_note := 'Club Activity: ' || (round(v_raw, 2))::float8::text || 'h actual → '
              || v_total::float8::text || 'h credited (0.25x)';
    v_desc := CASE WHEN v_desc <> '' THEN v_desc || ' | ' || v_note ELSE v_note END;
  END IF;

  v_set := format('punch_out = %L, total_hours = %L, status = %L, description = %L, entry_type = %L, is_break_punch_out = %L',
                  to_char(v_local, 'YYYY-MM-DD"T"HH24:MI:SS') || '+00', v_total, 'Punched Out',
                  v_desc, v_entry, coalesce(p_is_break, false));
  IF v_approver_name IS NOT NULL THEN
    v_set := v_set || format(', early_departure_approved_by = %L', v_approver_name);
  END IF;
  IF r.entry_type IN ('Volunteer', 'Club Activity') THEN
    v_set := v_set || format(', approved_by = %L, approved_date = %L',
                             CASE WHEN v_actor.id <> v_target.id
                                  THEN private.kiosk_short_name(v_actor.first_name, v_actor.last_name)
                                  ELSE 'Time Clock' END,
                             now());
  END IF;

  EXECUTE format('UPDATE public.time_clock SET %s WHERE record_id = %L RETURNING to_jsonb(time_clock.*)',
                 v_set, r.record_id)
    INTO v_row;

  RETURN jsonb_build_object('ok', true, 'record', v_row, 'total_hours', v_total);
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 5: Lab Status actions + login check
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.kiosk_help_update(p_request_id text, p_action text, p_responder text)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_who  text := left(coalesce(nullif(btrim(p_responder), ''), 'Instructor'), 80);
  v_n    int;
  v_has_resolved boolean;
BEGIN
  IF p_action = 'acknowledge' THEN
    UPDATE public.help_requests
       SET status = 'acknowledged', acknowledged_by = v_who, acknowledged_at = now()
     WHERE request_id = p_request_id AND status IN ('pending', 'acknowledged');
  ELSIF p_action = 'resolve' THEN
    SELECT count(*) = 2 INTO v_has_resolved
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'help_requests'
       AND column_name IN ('resolved_at', 'resolved_by');
    IF v_has_resolved THEN
      EXECUTE format('UPDATE public.help_requests SET status = %L, resolved_at = now(), resolved_by = %L
                       WHERE request_id = %L AND status IN (%L, %L)',
                     'resolved', v_who, p_request_id, 'pending', 'acknowledged');
    ELSE
      UPDATE public.help_requests SET status = 'resolved'
       WHERE request_id = p_request_id AND status IN ('pending', 'acknowledged');
    END IF;
  ELSE
    RETURN jsonb_build_object('ok', false, 'error', 'bad_action');
  END IF;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('ok', v_n > 0, 'rows', v_n);
END;
$function$;

CREATE OR REPLACE FUNCTION public.kiosk_instructor_away_off()
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
BEGIN
  UPDATE public.settings SET setting_value = 'false' WHERE setting_key = 'instructor_away_mode';
  UPDATE public.settings SET setting_value = ''      WHERE setting_key = 'instructor_return_time';
  RETURN jsonb_build_object('ok', true);
END;
$function$;

CREATE OR REPLACE FUNCTION public.email_status(p_email text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
  SELECT jsonb_build_object(
    'registered',      EXISTS (SELECT 1 FROM public.profiles p WHERE lower(p.email) = lower(btrim(p_email))),
    'pending_request', EXISTS (SELECT 1 FROM public.access_requests a
                                WHERE lower(a.email) = lower(btrim(p_email)) AND a.status = 'Pending'),
    'any_request',     EXISTS (SELECT 1 FROM public.access_requests a WHERE lower(a.email) = lower(btrim(p_email))));
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 6: grants
-- ─────────────────────────────────────────────────────────────────────────────

DO $do$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('kiosk_feed', 'kiosk_badge_lookup', 'kiosk_verify_instructor',
                         'kiosk_student_state', 'kiosk_record_status', 'kiosk_punch_in',
                         'kiosk_punch_out', 'kiosk_help_update', 'kiosk_instructor_away_off',
                         'email_status')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO anon, authenticated, service_role', r.sig);
  END LOOP;
END
$do$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 7: tests as a logged-out caller (always rolled back)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TEMP TABLE _p2a_tests (test text, expected text, actual text) ON COMMIT DROP;

DO $do$
DECLARE
  v_today   date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_feed    jsonb;
  v_card    text;
  v_email   text;
  v_icard   text;
  v_res     jsonb;
  v_rec     text;
  v_v0      bigint;
  v_v1      bigint;
BEGIN
  -- T1 feed works for a logged-out caller and carries no emails
  BEGIN
    PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
    EXECUTE 'SET LOCAL ROLE anon';
    v_feed := public.kiosk_feed(v_today);
    RAISE EXCEPTION 'keys=%;emails=%',
      (SELECT count(*) FROM jsonb_object_keys(v_feed)),
      (SELECT count(*) FROM (
          SELECT jsonb_array_elements(v_feed -> k) AS e FROM unnest(ARRAY['punched_in','punched_out','signups','time_clock_only','instructors']) k
        ) x WHERE coalesce(x.e ->> 'user_email', x.e ->> 'email', '') LIKE '%@%');
  EXCEPTION WHEN others THEN
    INSERT INTO _p2a_tests VALUES ('logged-out screen feed (7 lists, 0 emails)', 'keys=7;emails=0', SQLERRM);
  END;

  -- T2 unknown badge
  BEGIN
    EXECUTE 'SET LOCAL ROLE anon';
    RAISE EXCEPTION '%', public.kiosk_badge_lookup('no-such-badge-xyz') ->> 'found';
  EXCEPTION WHEN others THEN
    INSERT INTO _p2a_tests VALUES ('unknown badge not found', 'false', SQLERRM);
  END;

  -- T3 typed email no longer works
  SELECT email INTO v_email FROM public.profiles WHERE status = 'Active' AND role = 'Student' ORDER BY email LIMIT 1;
  IF v_email IS NOT NULL THEN
    BEGIN
      EXECUTE 'SET LOCAL ROLE anon';
      RAISE EXCEPTION '%', public.kiosk_badge_lookup(v_email) ->> 'found';
    EXCEPTION WHEN others THEN
      INSERT INTO _p2a_tests VALUES ('typed email is not accepted as a badge', 'false', SQLERRM);
    END;
  END IF;

  -- T4 full punch cycle with a real student badge (student with no open punch)
  SELECT p.card_id, p.email INTO v_card, v_email
    FROM public.profiles p
   WHERE p.status = 'Active' AND lower(p.role) = 'student'
     AND coalesce(btrim(p.card_id), '') <> ''
     AND NOT EXISTS (SELECT 1 FROM public.time_clock t
                      WHERE lower(t.user_email) = lower(p.email) AND t.status = 'Punched In')
   ORDER BY p.email LIMIT 1;
  SELECT p.card_id INTO v_icard
    FROM public.profiles p
   WHERE p.status = 'Active' AND lower(p.role) = 'instructor' AND coalesce(btrim(p.card_id), '') <> ''
   ORDER BY p.email LIMIT 1;

  IF v_card IS NULL THEN
    INSERT INTO _p2a_tests VALUES ('punch cycle', 'an Active student with a badge', 'none found — skipped');
  ELSE
    BEGIN
      SELECT version INTO v_v0 FROM public.kiosk_feed_version WHERE topic = 'time_clock';
      PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
      EXECUTE 'SET LOCAL ROLE anon';
      v_res := public.kiosk_badge_lookup(v_card);
      IF (v_res ->> 'found') <> 'true' OR v_res -> 'user' ? 'card_id' THEN
        RAISE EXCEPTION 'lookup=%', v_res ->> 'found';
      END IF;
      v_res := public.kiosk_student_state(v_card, v_email, v_today);
      IF (v_res ->> 'ok') <> 'true' THEN RAISE EXCEPTION 'state=%', v_res; END IF;
      v_res := public.kiosk_punch_in(v_card, v_email, 'P2TEST', 'P2TEST', 'Class');
      IF (v_res ->> 'ok') <> 'true' THEN RAISE EXCEPTION 'punch_in=%', v_res; END IF;
      v_rec := v_res -> 'record' ->> 'record_id';
      v_res := public.kiosk_punch_in(v_card, v_email, 'P2TEST', 'P2TEST', 'Class');
      IF (v_res ->> 'error') IS DISTINCT FROM 'already_punched_in' THEN RAISE EXCEPTION 'double punch allowed'; END IF;
      v_res := public.kiosk_punch_out(v_card, v_email, v_rec, false, 0, NULL, false);
      IF (v_res ->> 'ok') <> 'true' OR (v_res -> 'record' ->> 'status') <> 'Punched Out' THEN
        RAISE EXCEPTION 'punch_out=%', v_res;
      END IF;
      EXECUTE 'RESET ROLE';
      SELECT version INTO v_v1 FROM public.kiosk_feed_version WHERE topic = 'time_clock';
      RAISE EXCEPTION 'cycle ok; live signal %', CASE WHEN v_v1 > v_v0 THEN 'bumped' ELSE 'NOT bumped' END;
    EXCEPTION WHEN others THEN
      INSERT INTO _p2a_tests VALUES ('badge lookup → punch in → no double punch → punch out',
                                     'cycle ok; live signal bumped', SQLERRM);
    END;

    -- T5 a student badge cannot act for someone else
    BEGIN
      EXECUTE 'SET LOCAL ROLE anon';
      RAISE EXCEPTION '%', public.kiosk_student_state(v_card, 'someone.else@example.com', v_today) ->> 'error';
    EXCEPTION WHEN others THEN
      INSERT INTO _p2a_tests VALUES ('student badge cannot act for another person', 'not_authorized', SQLERRM);
    END;
  END IF;

  -- T6 instructor badge: approver check + student list without badge numbers
  IF v_icard IS NOT NULL THEN
    BEGIN
      EXECUTE 'SET LOCAL ROLE anon';
      v_res := public.kiosk_badge_lookup(v_icard);
      RAISE EXCEPTION 'verify=%;cards_in_list=%',
        public.kiosk_verify_instructor(v_icard) ->> 'ok',
        (SELECT count(*) FROM jsonb_array_elements(coalesce(v_res -> 'students', '[]')) s WHERE s ? 'card_id');
    EXCEPTION WHEN others THEN
      INSERT INTO _p2a_tests VALUES ('instructor badge verifies; student list has no badge numbers',
                                     'verify=true;cards_in_list=0', SQLERRM);
    END;
  ELSE
    INSERT INTO _p2a_tests VALUES ('instructor badge', 'an Active instructor with a badge', 'none found — skipped');
  END IF;

  -- T7 login email check
  BEGIN
    EXECUTE 'SET LOCAL ROLE anon';
    RAISE EXCEPTION '%', public.email_status('nobody-here@example.com') ->> 'registered';
  EXCEPTION WHEN others THEN
    INSERT INTO _p2a_tests VALUES ('login email check (unknown email)', 'false', SQLERRM);
  END;
END
$do$;

SELECT section, check_name, expected, actual, (expected = actual) AS ok
FROM (
  SELECT 1 AS ord, 'test' AS section, test AS check_name, expected, actual FROM _p2a_tests
  UNION ALL
  SELECT 2, 'function', 'kiosk functions callable by logged-out screens', '10',
         count(*)::text
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('kiosk_feed', 'kiosk_badge_lookup', 'kiosk_verify_instructor',
                       'kiosk_student_state', 'kiosk_record_status', 'kiosk_punch_in',
                       'kiosk_punch_out', 'kiosk_help_update', 'kiosk_instructor_away_off',
                       'email_status')
     AND has_function_privilege('anon', p.oid, 'EXECUTE')
  UNION ALL
  SELECT 2, 'function', 'private helpers hidden from logged-out callers', '0',
         count(*)::text
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'private' AND has_function_privilege('anon', p.oid, 'EXECUTE')
  UNION ALL
  SELECT 3, 'realtime', 'kiosk_feed_version in realtime publication',
         CASE WHEN EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN 'yes' ELSE 'no publication' END,
         CASE WHEN EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime'
                            AND schemaname = 'public' AND tablename = 'kiosk_feed_version') THEN 'yes'
              WHEN NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN 'no publication'
              ELSE 'no' END
) x
ORDER BY ord, check_name;

ROLLBACK;   -- ← swap for COMMIT after every row shows ok = true

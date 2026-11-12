-- ═════════════════════════════════════════════════════════════════════════════
-- RICT CMMS — RICT Club Suggestion Box
-- File: supabase/migrations/20261110_suggestion_box.sql
--
-- Purpose
--   A suggestion box for the RICT Club. Anyone with the 'submit' permission
--   can drop in a suggestion, named or TRULY anonymous. Only people on the
--   instructor-managed viewer list (plus instructors with 'manage') can read
--   them, set a status and write a public reply. Anonymous submitters get a
--   tracking code to check on their suggestion later.
--
-- What it creates
--   1. Sequence suggestion_id_seq (starts at 1001) — no id_counters drift.
--   2. suggestions — the suggestions themselves.
--        author_email / author_name are NULL when anonymous (CHECK enforced),
--        and an anonymous row keeps only the DATE it was sent (created_at is
--        NULL), so the time of day can't be matched to who was in the lab.
--        created_at is REAL UTC (Convention B, TIMESTAMP_CONVENTIONS.md);
--        created_on is the America/Chicago date.
--   3. suggestion_tracking — sha256 hash of each anonymous tracking code.
--        RLS on with NO policies: only the SECURITY DEFINER functions read it.
--   4. suggestion_box_viewers — the per-user viewer list instructors manage
--        on the page. Viewers see every suggestion and get a bell
--        notification for each new one.
--   5. suggestion_submit_counts — per-user, per-day counter for the daily
--        limit (5). Holds only TODAY's rows: every submit deletes older days,
--        so it can't be used later to work out who sent an anonymous note.
--        RLS on with NO policies.
--   6. Functions (all SECURITY DEFINER, search_path pinned)
--        suggestion_school_year(date)        '2026-27' (July starts a year)
--        suggestion_box_can_view()           viewer list OR has_perm manage
--        submit_suggestion(body, category, anonymous)
--             → jsonb { id, tracking_code }   (code only when anonymous)
--             Never writes the author for anonymous rows, never writes
--             audit_log, and notifies viewers from "Suggestion Box".
--        update_suggestion(id, status, reply)
--             viewers + managers; notifies a NAMED author of status/reply.
--        lookup_suggestion(code)             status/reply for a tracking code
--        archive_suggestion_year(school_year) managers; returns count
--   7. RLS on suggestions
--        SELECT  — can_view() OR it is your own NAMED suggestion
--        DELETE  — has_perm('Suggestion Box','manage')
--        No INSERT/UPDATE policies: writes go through the functions above.
--   8. Permissions — page 'Suggestion Box' (IDs match AccessPage.jsx)
--        PSB1 view_page       student ✓  work_study ✓  instructor ✓
--        PSB2 submit          student ✓  work_study ✓  instructor ✓
--        PSB3 manage          student ✗  work_study ✗  instructor ✓
--        PSB4 manage_viewers  student ✗  work_study ✗  instructor ✓
--   9. Realtime: suggestions + suggestion_box_viewers added to the
--      supabase_realtime publication (RLS still applies to what each user
--      receives).
--
-- Notification types written to announcements
--   suggestion_new     → each viewer (except the submitter)
--   suggestion_update  → the author of a NAMED suggestion when its status or
--                        reply changes
--   sender_email is 'noreply@abctechllc.com' (the existing system sender, so the
--   Inbox shows no Reply button), sender_name 'Suggestion Box'.
--
-- Deploy order: run this FIRST, then drop in the app files.
-- Idempotent: safe to run twice.
-- Dry run: ends in ROLLBACK. Check the verification result set, then swap
-- the final ROLLBACK for COMMIT and run again.
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 1: tables
-- ─────────────────────────────────────────────────────────────────────────────

CREATE SEQUENCE IF NOT EXISTS public.suggestion_id_seq START 1001;

CREATE TABLE IF NOT EXISTS public.suggestions (
  id                bigint PRIMARY KEY DEFAULT nextval('public.suggestion_id_seq'),
  body              text NOT NULL,
  category          text NOT NULL DEFAULT 'Other',
  is_anonymous      boolean NOT NULL DEFAULT false,
  author_email      text,
  author_name       text,
  status            text NOT NULL DEFAULT 'New',
  reply             text,
  reply_by_name     text,
  replied_at        timestamptz,
  status_changed_at timestamptz,
  school_year       text NOT NULL,
  archived          boolean NOT NULL DEFAULT false,
  archived_at       timestamptz,
  created_on        date NOT NULL,
  created_at        timestamptz,
  CONSTRAINT suggestions_body_len   CHECK (char_length(btrim(body)) BETWEEN 3 AND 2000),
  CONSTRAINT suggestions_reply_len  CHECK (reply IS NULL OR char_length(reply) <= 2000),
  CONSTRAINT suggestions_category   CHECK (category IN ('Events', 'Lab & Equipment', 'Club Activities', 'Fundraising', 'Other')),
  CONSTRAINT suggestions_status     CHECK (status IN ('New', 'Under review', 'Planned', 'Done', 'Not doing')),
  CONSTRAINT suggestions_anon_clean CHECK (
    NOT is_anonymous OR (author_email IS NULL AND author_name IS NULL AND created_at IS NULL)
  )
);

ALTER SEQUENCE public.suggestion_id_seq OWNED BY public.suggestions.id;

CREATE INDEX IF NOT EXISTS suggestions_year_idx   ON public.suggestions (school_year, archived);
CREATE INDEX IF NOT EXISTS suggestions_author_idx ON public.suggestions (lower(author_email)) WHERE author_email IS NOT NULL;

COMMENT ON TABLE public.suggestions IS
  'RICT Club Suggestion Box (2026-11-10). Anonymous rows store no author and no time of day. Writes only through submit_suggestion / update_suggestion / archive_suggestion_year.';

CREATE TABLE IF NOT EXISTS public.suggestion_tracking (
  suggestion_id bigint PRIMARY KEY REFERENCES public.suggestions(id) ON DELETE CASCADE,
  code_hash     text NOT NULL UNIQUE
);

COMMENT ON TABLE public.suggestion_tracking IS
  'sha256 of anonymous Suggestion Box tracking codes. No RLS policies — read only by lookup_suggestion().';

CREATE TABLE IF NOT EXISTS public.suggestion_box_viewers (
  email     text PRIMARY KEY,
  added_by  text,
  added_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT suggestion_box_viewers_lower CHECK (email = lower(email))
);

COMMENT ON TABLE public.suggestion_box_viewers IS
  'Users instructors picked to read the Suggestion Box (and get a bell notification for each new suggestion).';

CREATE TABLE IF NOT EXISTS public.suggestion_submit_counts (
  user_email text NOT NULL,
  day        date NOT NULL,
  n          integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_email, day)
);

COMMENT ON TABLE public.suggestion_submit_counts IS
  'Daily Suggestion Box limit. Only today''s rows are kept (older days are deleted on every submit). No RLS policies.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 2: helper functions
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.suggestion_school_year(p_day date)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE
           WHEN extract(month FROM p_day) >= 7
             THEN extract(year FROM p_day)::int::text || '-' || right((extract(year FROM p_day)::int + 1)::text, 2)
           ELSE (extract(year FROM p_day)::int - 1)::text || '-' || right(extract(year FROM p_day)::int::text, 2)
         END;
$function$;

COMMENT ON FUNCTION public.suggestion_school_year(date) IS
  'School year label for a date: July–June, e.g. 2026-11-10 → 2026-27 (Fall 2026 + Spring 2027).';

CREATE OR REPLACE FUNCTION public.suggestion_box_can_view()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
BEGIN
  IF v_email = '' THEN
    RETURN false;
  END IF;
  IF public.has_perm('Suggestion Box', 'manage') THEN
    RETURN true;
  END IF;
  RETURN EXISTS (
    SELECT 1
      FROM public.suggestion_box_viewers v
      JOIN public.profiles p ON lower(p.email) = v.email
     WHERE v.email = v_email
       AND p.status = 'Active'
  );
END;
$function$;

COMMENT ON FUNCTION public.suggestion_box_can_view() IS
  'True for an Active user on the Suggestion Box viewer list, or anyone with Suggestion Box → manage.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 3: submit
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.submit_suggestion(p_body text, p_category text, p_anonymous boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  c_limit    constant integer := 5;
  c_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   -- no 0/O, 1/I/L
  v_email    text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_profile  record;
  v_today    date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_body     text := btrim(coalesce(p_body, ''));
  v_category text := coalesce(nullif(btrim(p_category), ''), 'Other');
  v_anon     boolean := coalesce(p_anonymous, false);
  v_count    integer;
  v_id       bigint;
  v_code     text := NULL;
  v_raw      text;
  v_bytes    bytea;
  v_preview  text;
  i          integer;
BEGIN
  IF v_email = '' THEN
    RAISE EXCEPTION 'Please sign in to send a suggestion.' USING ERRCODE = '42501';
  END IF;

  SELECT p.email, p.first_name, p.last_name, p.status
    INTO v_profile
    FROM public.profiles p
   WHERE lower(p.email) = v_email
   LIMIT 1;
  IF NOT FOUND OR v_profile.status IS DISTINCT FROM 'Active' THEN
    RAISE EXCEPTION 'Only active users can send suggestions.' USING ERRCODE = '42501';
  END IF;

  IF NOT public.has_perm('Suggestion Box', 'submit') THEN
    RAISE EXCEPTION 'You do not have permission to send suggestions.' USING ERRCODE = '42501';
  END IF;

  IF char_length(v_body) < 3 THEN
    RAISE EXCEPTION 'Please write a little more (at least 3 characters).' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_body) > 2000 THEN
    RAISE EXCEPTION 'Please keep suggestions under 2000 characters.' USING ERRCODE = '22023';
  END IF;
  IF v_category NOT IN ('Events', 'Lab & Equipment', 'Club Activities', 'Fundraising', 'Other') THEN
    v_category := 'Other';
  END IF;

  -- Daily limit. Older days are thrown away first so the table never builds
  -- a history of who submitted when.
  DELETE FROM public.suggestion_submit_counts WHERE day < v_today;

  INSERT INTO public.suggestion_submit_counts AS c (user_email, day, n)
  VALUES (v_email, v_today, 1)
  ON CONFLICT (user_email, day) DO UPDATE SET n = c.n + 1
  RETURNING c.n INTO v_count;

  IF v_count > c_limit THEN
    RAISE EXCEPTION 'You have reached today''s limit of % suggestions. Please try again tomorrow.', c_limit
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.suggestions
    (body, category, is_anonymous, author_email, author_name, school_year, created_on, created_at)
  VALUES (
    v_body,
    v_category,
    v_anon,
    CASE WHEN v_anon THEN NULL ELSE v_email END,
    CASE WHEN v_anon THEN NULL
         ELSE btrim(coalesce(v_profile.first_name, '') || ' ' || coalesce(v_profile.last_name, '')) END,
    public.suggestion_school_year(v_today),
    v_today,
    CASE WHEN v_anon THEN NULL ELSE now() END
  )
  RETURNING id INTO v_id;

  -- Tracking code for anonymous suggestions: 8 random characters shown once,
  -- only the hash is kept. Retry on the (astronomically unlikely) collision.
  IF v_anon THEN
    LOOP
      v_bytes := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
      v_raw := '';
      FOR i IN 0..7 LOOP
        v_raw := v_raw || substr(c_alphabet, (get_byte(v_bytes, i) % length(c_alphabet)) + 1, 1);
      END LOOP;
      BEGIN
        INSERT INTO public.suggestion_tracking (suggestion_id, code_hash)
        VALUES (v_id, encode(sha256(convert_to(v_raw, 'UTF8')), 'hex'));
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        -- try another code
      END;
    END LOOP;
    v_code := 'SB-' || substr(v_raw, 1, 4) || '-' || substr(v_raw, 5, 4);
  END IF;

  -- Bell notification for every Active viewer except the person who sent it.
  v_preview := CASE WHEN char_length(v_body) > 160 THEN left(v_body, 157) || '…' ELSE v_body END;

  INSERT INTO public.announcements
    (recipient_email, sender_email, sender_name, subject, body, read, notification_type, created_at)
  SELECT v.email,
         'noreply@abctechllc.com',
         'Suggestion Box',
         'New suggestion (' || v_category || ')',
         v_preview,
         false,
         'suggestion_new',
         now()
    FROM public.suggestion_box_viewers v
    JOIN public.profiles p ON lower(p.email) = v.email AND p.status = 'Active'
   WHERE v.email <> v_email;

  RETURN jsonb_build_object('id', v_id, 'tracking_code', v_code);
END;
$function$;

COMMENT ON FUNCTION public.submit_suggestion(text, text, boolean) IS
  'Suggestion Box submit. Anonymous: no author, no time of day, no audit row; returns a one-time tracking code. Limit 5 per user per day.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 4: status / reply
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.update_suggestion(p_id bigint, p_status text, p_reply text)
 RETURNS public.suggestions
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_email   text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_name    text;
  v_old     public.suggestions;
  v_new     public.suggestions;
  v_status  text := coalesce(nullif(btrim(p_status), ''), NULL);
  v_reply   text := nullif(btrim(coalesce(p_reply, '')), '');
  v_status_changed boolean;
  v_reply_changed  boolean;
  v_msg     text;
BEGIN
  IF NOT public.suggestion_box_can_view() THEN
    RAISE EXCEPTION 'You do not have permission to update suggestions.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_old FROM public.suggestions WHERE id = p_id FOR UPDATE;
  IF v_old.id IS NULL THEN
    RAISE EXCEPTION 'That suggestion no longer exists.' USING ERRCODE = 'P0002';
  END IF;
  IF v_old.archived AND NOT public.has_perm('Suggestion Box', 'manage') THEN
    RAISE EXCEPTION 'Archived suggestions can only be changed by an instructor.' USING ERRCODE = '42501';
  END IF;

  v_status := coalesce(v_status, v_old.status);
  IF v_status NOT IN ('New', 'Under review', 'Planned', 'Done', 'Not doing') THEN
    RAISE EXCEPTION 'Unknown status: %', v_status USING ERRCODE = '22023';
  END IF;
  IF v_reply IS NOT NULL AND char_length(v_reply) > 2000 THEN
    RAISE EXCEPTION 'Please keep replies under 2000 characters.' USING ERRCODE = '22023';
  END IF;

  v_status_changed := v_status IS DISTINCT FROM v_old.status;
  v_reply_changed  := v_reply  IS DISTINCT FROM v_old.reply;

  IF NOT v_status_changed AND NOT v_reply_changed THEN
    RETURN v_old;
  END IF;

  SELECT btrim(coalesce(first_name, '') || ' ' || left(coalesce(last_name, ''), 1) || '.')
    INTO v_name
    FROM public.profiles WHERE lower(email) = v_email LIMIT 1;

  UPDATE public.suggestions s
     SET status            = v_status,
         status_changed_at = CASE WHEN v_status_changed THEN now() ELSE s.status_changed_at END,
         reply             = v_reply,
         reply_by_name     = CASE WHEN v_reply_changed THEN (CASE WHEN v_reply IS NULL THEN NULL ELSE coalesce(v_name, 'Club') END) ELSE s.reply_by_name END,
         replied_at        = CASE WHEN v_reply_changed THEN (CASE WHEN v_reply IS NULL THEN NULL ELSE now() END) ELSE s.replied_at END
   WHERE s.id = p_id
  RETURNING * INTO v_new;

  -- Tell a NAMED author what happened (anonymous authors use their code).
  IF v_new.author_email IS NOT NULL AND v_new.author_email <> v_email THEN
    v_msg := 'Your suggestion #' || v_new.id || ' is now "' || v_new.status || '".';
    IF v_reply_changed AND v_new.reply IS NOT NULL THEN
      v_msg := v_msg || E'\n\nReply from ' || coalesce(v_new.reply_by_name, 'the Club') || ': ' || v_new.reply;
    END IF;
    INSERT INTO public.announcements
      (recipient_email, sender_email, sender_name, subject, body, read, notification_type, created_at)
    VALUES (v_new.author_email, 'noreply@abctechllc.com', 'Suggestion Box',
            'Update on your suggestion', v_msg, false, 'suggestion_update', now());
  END IF;

  RETURN v_new;
END;
$function$;

COMMENT ON FUNCTION public.update_suggestion(bigint, text, text) IS
  'Suggestion Box viewers/managers set status and the public reply; a named author is notified.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 5: tracking-code lookup + yearly archive
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.lookup_suggestion(p_code text)
 RETURNS TABLE (
   id bigint, category text, body text, status text, reply text,
   reply_by_name text, replied_at timestamptz, created_on date, archived boolean
 )
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_raw text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
BEGIN
  IF coalesce(auth.jwt() ->> 'email', '') = '' THEN
    RAISE EXCEPTION 'Please sign in to look up a suggestion.' USING ERRCODE = '42501';
  END IF;
  IF left(v_raw, 2) = 'SB' AND char_length(v_raw) = 10 THEN
    v_raw := substr(v_raw, 3);
  END IF;
  IF char_length(v_raw) <> 8 THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT s.id, s.category, s.body, s.status, s.reply, s.reply_by_name, s.replied_at, s.created_on, s.archived
    FROM public.suggestion_tracking t
    JOIN public.suggestions s ON s.id = t.suggestion_id
   WHERE t.code_hash = encode(sha256(convert_to(v_raw, 'UTF8')), 'hex');
END;
$function$;

COMMENT ON FUNCTION public.lookup_suggestion(text) IS
  'Anonymous Suggestion Box tracking: returns the suggestion for a code (SB-XXXX-XXXX, dashes/case ignored).';

CREATE OR REPLACE FUNCTION public.archive_suggestion_year(p_school_year text)
 RETURNS integer
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_count integer;
BEGIN
  IF NOT public.has_perm('Suggestion Box', 'manage') THEN
    RAISE EXCEPTION 'Only instructors can close out a school year.' USING ERRCODE = '42501';
  END IF;
  UPDATE public.suggestions
     SET archived = true, archived_at = now()
   WHERE school_year = p_school_year AND NOT archived;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;

COMMENT ON FUNCTION public.archive_suggestion_year(text) IS
  'Suggestion Box: archive every open suggestion of one school year (managers only). Returns rows archived.';

REVOKE ALL ON FUNCTION public.submit_suggestion(text, text, boolean)  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.update_suggestion(bigint, text, text)    FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.lookup_suggestion(text)                  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.archive_suggestion_year(text)            FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.suggestion_box_can_view()                FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_suggestion(text, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_suggestion(bigint, text, text)   TO authenticated;
GRANT EXECUTE ON FUNCTION public.lookup_suggestion(text)                 TO authenticated;
GRANT EXECUTE ON FUNCTION public.archive_suggestion_year(text)           TO authenticated;
GRANT EXECUTE ON FUNCTION public.suggestion_box_can_view()               TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 6: RLS
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.suggestions              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.suggestion_tracking      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.suggestion_box_viewers   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.suggestion_submit_counts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS suggestions_select ON public.suggestions;
CREATE POLICY suggestions_select
  ON public.suggestions FOR SELECT TO authenticated
  USING (
    public.suggestion_box_can_view()
    OR (author_email IS NOT NULL AND author_email = lower(coalesce(auth.jwt() ->> 'email', '')))
  );

DROP POLICY IF EXISTS suggestions_delete ON public.suggestions;
CREATE POLICY suggestions_delete
  ON public.suggestions FOR DELETE TO authenticated
  USING (public.has_perm('Suggestion Box', 'manage'));

-- A user can see their own viewer row (so the page knows they are a viewer);
-- managers of the list see and change all of it.
DROP POLICY IF EXISTS suggestion_viewers_select ON public.suggestion_box_viewers;
CREATE POLICY suggestion_viewers_select
  ON public.suggestion_box_viewers FOR SELECT TO authenticated
  USING (
    email = lower(coalesce(auth.jwt() ->> 'email', ''))
    OR public.has_perm('Suggestion Box', 'manage_viewers')
  );

DROP POLICY IF EXISTS suggestion_viewers_insert ON public.suggestion_box_viewers;
CREATE POLICY suggestion_viewers_insert
  ON public.suggestion_box_viewers FOR INSERT TO authenticated
  WITH CHECK (public.has_perm('Suggestion Box', 'manage_viewers'));

DROP POLICY IF EXISTS suggestion_viewers_delete ON public.suggestion_box_viewers;
CREATE POLICY suggestion_viewers_delete
  ON public.suggestion_box_viewers FOR DELETE TO authenticated
  USING (public.has_perm('Suggestion Box', 'manage_viewers'));

REVOKE ALL ON public.suggestions, public.suggestion_tracking,
              public.suggestion_box_viewers, public.suggestion_submit_counts FROM anon;
REVOKE ALL ON public.suggestion_tracking, public.suggestion_submit_counts FROM authenticated;
REVOKE ALL ON public.suggestions FROM authenticated;
GRANT SELECT, DELETE ON public.suggestions TO authenticated;
REVOKE ALL ON public.suggestion_box_viewers FROM authenticated;
GRANT SELECT, INSERT, DELETE ON public.suggestion_box_viewers TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 7: realtime
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'suggestions') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.suggestions;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'suggestion_box_viewers') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.suggestion_box_viewers;
    END IF;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 8: permissions (page 'Suggestion Box') — IDs match AccessPage.jsx
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO public.permissions
  (permission_id, page, feature, student, work_study, instructor, description, updated_at, updated_by)
SELECT t.permission_id, 'Suggestion Box', t.feature, t.student, t.work_study, t.instructor, t.description, now(), 'migration'
  FROM (VALUES
    ('PSB1', 'view_page',      true,  true,  true, 'Can open the Suggestion Box page'),
    ('PSB2', 'submit',         true,  true,  true, 'Can send suggestions (named or anonymous)'),
    ('PSB3', 'manage',         false, false, true, 'Can see every suggestion, set status, reply, delete, and close out a school year'),
    ('PSB4', 'manage_viewers', false, false, true, 'Can choose who is on the Suggestion Box viewer list')
  ) AS t(permission_id, feature, student, work_study, instructor, description)
 WHERE NOT EXISTS (SELECT 1 FROM public.permissions x WHERE x.page = 'Suggestion Box' AND x.feature = t.feature)
   AND NOT EXISTS (SELECT 1 FROM public.permissions x WHERE x.permission_id = t.permission_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification (single result set — the SQL Editor shows only the last statement)
--
-- Expect:
--   table      → 4 rows, all rls=true; policies: suggestions 2,
--                suggestion_box_viewers 3, the other two 0
--   function   → 6 rows
--   permission → 4 rows (PSB1..PSB4) for page 'Suggestion Box'
--   realtime   → suggestions, suggestion_box_viewers
--   school_year→ 2026-11-10 = 2026-27, 2027-03-01 = 2026-27, 2027-08-20 = 2027-28
--   anon_check → constraint present
-- ─────────────────────────────────────────────────────────────────────────────

SELECT 'table' AS kind, c.relname AS name,
       'rls=' || c.relrowsecurity::text || ' policies=' ||
       (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname)::text AS detail
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relname IN ('suggestions', 'suggestion_tracking', 'suggestion_box_viewers', 'suggestion_submit_counts')
UNION ALL
SELECT 'function', p.proname, CASE WHEN p.prosecdef THEN 'security definer' ELSE 'invoker' END
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('suggestion_school_year', 'suggestion_box_can_view', 'submit_suggestion',
                     'update_suggestion', 'lookup_suggestion', 'archive_suggestion_year')
UNION ALL
SELECT 'permission', permission_id || ' ' || feature,
       'student=' || student::text || ' ws=' || work_study::text || ' instr=' || instructor::text
  FROM public.permissions WHERE page = 'Suggestion Box'
UNION ALL
SELECT 'realtime', tablename, 'in supabase_realtime'
  FROM pg_publication_tables
 WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
   AND tablename IN ('suggestions', 'suggestion_box_viewers')
UNION ALL
SELECT 'school_year', d::text, public.suggestion_school_year(d)
  FROM unnest(ARRAY['2026-11-10'::date, '2027-03-01'::date, '2027-08-20'::date]) AS d
UNION ALL
SELECT 'anon_check', conname, 'present'
  FROM pg_constraint WHERE conname = 'suggestions_anon_clean'
ORDER BY 1, 2;

ROLLBACK;   -- ← swap for COMMIT after checking the verification output

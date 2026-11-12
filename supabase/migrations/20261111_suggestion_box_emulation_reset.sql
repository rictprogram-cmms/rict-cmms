-- ═════════════════════════════════════════════════════════════════════════════
-- RICT CMMS — Suggestion Box: emulation support + instructor limit reset
-- File: supabase/migrations/20261111_suggestion_box_emulation_reset.sql
-- Requires: 20261110_suggestion_box.sql
--
-- Problem
--   Emulate User only changes what the APP shows; the database still sees the
--   real Super Admin login. So every suggestion sent while emulating counted
--   against the Super Admin's daily limit of 5, and named ones were signed
--   with the Super Admin's name instead of the emulated user's.
--
-- Fix
--   1. suggestion_effective_email(p_as_email)
--        Returns the caller's email, or p_as_email when the REAL caller is
--        the Super Admin (rictprogram@gmail.com — same rule as has_perm()).
--        Anyone else passing someone else's email gets an error.
--   2. suggestion_perm_for(p_email, p_feature)
--        Permission check for the effective user: has_perm() for yourself
--        (keeps temp access), the emulated user's ROLE row otherwise.
--   3. suggestion_box_can_view_as(p_as_email)  — page uses this to decide
--        whether to show "All suggestions" for the effective user.
--        (suggestion_box_can_view() is unchanged; RLS still uses it.)
--   4. submit_suggestion(...) and update_suggestion(...) get an optional
--        p_as_email as the LAST argument (default NULL). Old calls without
--        it work exactly as before. The 3-argument versions are dropped so
--        PostgREST has one function to pick.
--   5. reset_suggestion_limits()  — instructors (Suggestion Box → manage)
--        reset TODAY's daily limit for everyone. It does not take a person:
--        listing who has used their limit would show who sent suggestions
--        today, which would weaken anonymity. Returns nothing.
--
-- Unchanged: anonymous rows still store no author and no time of day; no
-- audit_log writes; RLS policies; tables; permissions.
--
-- Dry run: ends in ROLLBACK. Check the verification row set, then swap the
-- final ROLLBACK for COMMIT and run again. Idempotent.
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 1: helpers
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.suggestion_effective_email(p_as_email text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_real text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_as   text := lower(btrim(coalesce(p_as_email, '')));
BEGIN
  IF v_as = '' OR v_as = v_real THEN
    RETURN v_real;
  END IF;
  IF v_real <> 'rictprogram@gmail.com' THEN
    RAISE EXCEPTION 'You cannot act as another user.' USING ERRCODE = '42501';
  END IF;
  RETURN v_as;
END;
$function$;

COMMENT ON FUNCTION public.suggestion_effective_email(text) IS
  'Suggestion Box: the caller''s email, or the emulated user''s when the real caller is the Super Admin.';

CREATE OR REPLACE FUNCTION public.suggestion_perm_for(p_email text, p_feature text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_role text;
  v_key  text;
BEGIN
  IF lower(coalesce(p_email, '')) = lower(coalesce(auth.jwt() ->> 'email', '')) THEN
    RETURN public.has_perm('Suggestion Box', p_feature);
  END IF;

  SELECT p.role INTO v_role
    FROM public.profiles p
   WHERE lower(p.email) = lower(p_email) AND p.status = 'Active'
   LIMIT 1;
  IF v_role IS NULL THEN
    RETURN false;
  END IF;
  v_key := regexp_replace(lower(v_role), ' ', '_');
  RETURN EXISTS (
    SELECT 1 FROM public.permissions x
     WHERE x.page = 'Suggestion Box' AND x.feature = p_feature
       AND (to_jsonb(x) ->> v_key) IN ('true', 'Yes')
  );
END;
$function$;

COMMENT ON FUNCTION public.suggestion_perm_for(text, text) IS
  'Suggestion Box permission for the effective user (has_perm for yourself, the role row for an emulated user).';

CREATE OR REPLACE FUNCTION public.suggestion_box_can_view_as(p_as_email text DEFAULT NULL)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_email text := public.suggestion_effective_email(p_as_email);
BEGIN
  IF v_email = '' THEN
    RETURN false;
  END IF;
  IF public.suggestion_perm_for(v_email, 'manage') THEN
    RETURN true;
  END IF;
  RETURN EXISTS (
    SELECT 1
      FROM public.suggestion_box_viewers v
      JOIN public.profiles p ON lower(p.email) = v.email
     WHERE v.email = v_email AND p.status = 'Active'
  );
END;
$function$;

COMMENT ON FUNCTION public.suggestion_box_can_view_as(text) IS
  'Suggestion Box: can the effective user (you, or the user the Super Admin is emulating) read all suggestions?';

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 2: submit (adds p_as_email)
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.submit_suggestion(text, text, boolean);

CREATE OR REPLACE FUNCTION public.submit_suggestion(
  p_body text, p_category text, p_anonymous boolean, p_as_email text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  c_limit    constant integer := 5;
  c_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   -- no 0/O, 1/I/L
  v_email    text;
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
  v_email := public.suggestion_effective_email(p_as_email);
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

  IF NOT public.suggestion_perm_for(v_email, 'submit') THEN
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

  -- Daily limit, per (effective) user. Older days are thrown away first so
  -- the table never builds a history of who submitted when.
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

COMMENT ON FUNCTION public.submit_suggestion(text, text, boolean, text) IS
  'Suggestion Box submit. Anonymous: no author, no time of day, no audit row; returns a one-time tracking code. Limit 5 per user per day. p_as_email: Super Admin emulation only.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 3: status / reply (adds p_as_email)
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.update_suggestion(bigint, text, text);

CREATE OR REPLACE FUNCTION public.update_suggestion(
  p_id bigint, p_status text, p_reply text, p_as_email text DEFAULT NULL)
 RETURNS public.suggestions
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_email   text;
  v_name    text;
  v_old     public.suggestions;
  v_new     public.suggestions;
  v_status  text := nullif(btrim(coalesce(p_status, '')), '');
  v_reply   text := nullif(btrim(coalesce(p_reply, '')), '');
  v_status_changed boolean;
  v_reply_changed  boolean;
  v_msg     text;
BEGIN
  v_email := public.suggestion_effective_email(p_as_email);
  IF NOT public.suggestion_box_can_view_as(p_as_email) THEN
    RAISE EXCEPTION 'You do not have permission to update suggestions.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_old FROM public.suggestions WHERE id = p_id FOR UPDATE;
  IF v_old.id IS NULL THEN
    RAISE EXCEPTION 'That suggestion no longer exists.' USING ERRCODE = 'P0002';
  END IF;
  IF v_old.archived AND NOT public.suggestion_perm_for(v_email, 'manage') THEN
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

COMMENT ON FUNCTION public.update_suggestion(bigint, text, text, text) IS
  'Suggestion Box viewers/managers set status and the public reply; a named author is notified. p_as_email: Super Admin emulation only.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 4: instructor reset of today's limit
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.reset_suggestion_limits()
 RETURNS void
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NOT public.has_perm('Suggestion Box', 'manage') THEN
    RAISE EXCEPTION 'Only instructors can reset the daily limit.' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.suggestion_submit_counts WHERE true;
END;
$function$;

COMMENT ON FUNCTION public.reset_suggestion_limits() IS
  'Suggestion Box: instructors reset everyone''s daily suggestion limit. Deliberately all-or-nothing so no one can see who sent suggestions today.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 5: grants
-- ─────────────────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.suggestion_effective_email(text)                   FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.suggestion_perm_for(text, text)                    FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.suggestion_box_can_view_as(text)                   FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.submit_suggestion(text, text, boolean, text)       FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.update_suggestion(bigint, text, text, text)        FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reset_suggestion_limits()                          FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.suggestion_box_can_view_as(text)                TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_suggestion(text, text, boolean, text)    TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_suggestion(bigint, text, text, text)     TO authenticated;
GRANT EXECUTE ON FUNCTION public.reset_suggestion_limits()                       TO authenticated;
-- suggestion_effective_email / suggestion_perm_for are internal helpers:
-- callable only by the definer functions above (owner), not by clients.

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification (single result set)
-- Expect 6 function rows, each "security definer", with the argument lists
-- shown; no 3-argument submit_suggestion / update_suggestion left.
-- ─────────────────────────────────────────────────────────────────────────────

SELECT p.proname AS function_name,
       pg_get_function_identity_arguments(p.oid) AS args,
       CASE WHEN p.prosecdef THEN 'security definer' ELSE 'invoker' END AS kind
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('suggestion_effective_email', 'suggestion_perm_for', 'suggestion_box_can_view_as',
                     'submit_suggestion', 'update_suggestion', 'reset_suggestion_limits')
 ORDER BY 1, 2;

ROLLBACK;   -- ← swap for COMMIT after checking the verification output

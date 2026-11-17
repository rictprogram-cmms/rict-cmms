-- ═════════════════════════════════════════════════════════════════════════════
-- RICT CMMS — Lab sign-up warnings: approved wording (2026-11-16)
-- File: supabase/migrations/20261116b_lab_warning_wording.sql
--
-- Replaces the placeholder text written by lab_warning_send() and
-- lab_warning_reset() (from 20261116_lab_warnings.sql) with the wording Aaron
-- approved, which follows the Program Policies:
--   §1   loss of flexible scheduling → official class times on E-Services
--   §2.2 Sunday 11:59 PM sign-up deadline; late sign-up needs approval
--   §6   weeks below hours (mentioned only as "also note" in warning 1)
-- Signed with the sending instructor's name + "RICT Instructor".
--
-- Only the message text changes. Logic, permissions, locking, levels and the
-- permanent-record rules are copied unchanged from the first migration.
-- Warnings already sent keep the text they were sent with (frozen in
-- lab_warnings.message), so this never rewrites history.
--
-- Run AFTER 20261116_lab_warnings.sql. Idempotent.
-- Dry run: ends in ROLLBACK. Check the preview rows, then swap for COMMIT.
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

-- Builds subject + body for a warning. Kept in one function so stage 2's
-- email sender can reuse the exact same text.
CREATE OR REPLACE FUNCTION public.lab_warning_text(
  p_level      integer,
  p_first_name text,
  p_week_of    date,
  p_shortage   text,
  p_actor_name text
)
 RETURNS TABLE (subject text, body text)
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
DECLARE
  v_name  text := coalesce(nullif(btrim(p_first_name), ''), 'there');
  v_week  text := public.lab_warning_week_label(p_week_of);
  v_short text := nullif(btrim(coalesce(p_shortage, '')), '');
  v_sign  text := coalesce(nullif(btrim(p_actor_name), ''), 'Your instructor') || E'\n' || 'RICT Instructor';
BEGIN
  IF p_level = 1 THEN
    subject := 'Lab sign-up warning 1 of 3' || coalesce(' — week of ' || v_week, '');
    body := 'Hi ' || v_name || ',' || E'\n\n'
      || 'You did not sign up for all of your required lab hours'
      || coalesce(' for the week of ' || v_week, '')
      || ' before the Sunday 11:59 PM deadline'
      || coalesce(': ' || v_short, '') || '.' || E'\n\n'
      || 'Under the Program Policies (Section 2.2), sign-ups for each week are due in the RICT CMMS by 11:59 PM the Sunday before. '
      || 'For this week, you can still submit a late sign-up in the CMMS, but it needs instructor approval. '
      || 'If it isn''t approved, you''re expected at the official class times posted on E-Services.' || E'\n\n'
      || 'This is warning 1 of 3. Missing sign-ups again leads to losing flexible scheduling (Section 1).' || E'\n\n'
      || 'Also note that hours you don''t complete and verify this week count as a week below hours under Section 6.' || E'\n\n'
      || 'Questions? Reply here or email RICT@sctcc.edu.' || E'\n\n'
      || v_sign;

  ELSIF p_level = 2 THEN
    subject := 'Lab sign-up warning 2 of 3' || coalesce(' — week of ' || v_week, '');
    body := 'Hi ' || v_name || ',' || E'\n\n'
      || 'This is your second time missing the Sunday sign-up deadline this semester.'
      || CASE WHEN v_week IS NOT NULL OR v_short IS NOT NULL
              THEN ' ' || coalesce('For the week of ' || v_week || ' you are short', 'You are short')
                   || coalesce(': ' || v_short, '') || '.'
              ELSE '' END || E'\n\n'
      || 'For this week, submit a late sign-up in the RICT CMMS for instructor approval. '
      || 'If it isn''t approved, attend the official class times on E-Services.' || E'\n\n'
      || 'The next warning is your final warning. After the final warning, you lose flexible scheduling under Section 1. '
      || 'Your lab time will be set to your official class times, and you won''t be able to change it.' || E'\n\n'
      || 'Flexible scheduling is meant to work like managing a work schedule. Please plan your week ahead and sign up each Sunday.' || E'\n\n'
      || v_sign;

  ELSE
    subject := 'Final lab sign-up warning — flexible scheduling removed';
    body := 'Hi ' || v_name || ',' || E'\n\n'
      || 'You have missed the Sunday sign-up deadline three times this semester'
      || CASE WHEN v_week IS NOT NULL
              THEN ', most recently for the week of ' || v_week || coalesce(' (' || v_short || ')', '')
              ELSE coalesce(' (' || v_short || ')', '') END || '.' || E'\n\n'
      || 'As stated in the Program Policies (Section 1), you have lost flexible scheduling. '
      || 'Starting this week, your lab time is your official class times as posted on E-Services, and your sign-ups in the CMMS will be set to those times. '
      || 'You won''t be able to change them.' || E'\n\n'
      || 'If your sign-ups stay on track, your instructor may restore flexible scheduling. Talk to your instructor if you have questions.' || E'\n\n'
      || v_sign;
  END IF;
  RETURN NEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION public.lab_warning_reset_text(p_first_name text, p_actor_name text)
 RETURNS TABLE (subject text, body text)
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT 'Flexible lab scheduling restored'::text,
         'Hi ' || coalesce(nullif(btrim(p_first_name), ''), 'there') || ',' || E'\n\n'
      || 'Your lab sign-up warnings have been reset, and flexible scheduling is restored. '
      || 'You can manage your own lab sign-ups in the RICT CMMS again. '
      || 'Remember that sign-ups are due by Sunday at 11:59 PM each week.' || E'\n\n'
      || 'Nice work getting back on track.' || E'\n\n'
      || coalesce(nullif(btrim(p_actor_name), ''), 'Your instructor') || E'\n' || 'RICT Instructor';
$function$;

-- ─── send: same logic as before, text from lab_warning_text() ──────────────

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

  SELECT t.subject, t.body INTO v_subject, v_body
    FROM public.lab_warning_text(v_level, v_ctx ->> 'first_name', p_week_of, v_short, v_ctx ->> 'actor_name') t;

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

-- ─── reset: same logic as before, text from lab_warning_reset_text() ───────

CREATE OR REPLACE FUNCTION public.lab_warning_reset(p_student_email text, p_term_id text, p_reason text)
 RETURNS public.lab_warnings
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_today   date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_ctx     jsonb;
  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
  v_subject text;
  v_body    text;
  v_row     public.lab_warnings;
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

  SELECT t.subject, t.body INTO v_subject, v_body
    FROM public.lab_warning_reset_text(v_ctx ->> 'first_name', v_ctx ->> 'actor_name') t;

  INSERT INTO public.announcements
    (recipient_email, sender_email, sender_name, subject, body, read, notification_type, created_at)
  VALUES (v_ctx ->> 'email', v_ctx ->> 'caller', coalesce(v_ctx ->> 'actor_name', 'Instructor'),
          v_subject, v_body, false, 'lab_warning_reset', now());

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

REVOKE ALL ON FUNCTION public.lab_warning_text(integer, text, date, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.lab_warning_reset_text(text, text)                FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lab_warning_text(integer, text, date, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.lab_warning_reset_text(text, text)                TO authenticated;
-- send/reset keep the grants from the first migration (CREATE OR REPLACE
-- preserves them); re-stated here so the file stands on its own.
REVOKE ALL ON FUNCTION public.lab_warning_send(text, date, text, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.lab_warning_reset(text, text, text)         FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lab_warning_send(text, date, text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.lab_warning_reset(text, text, text)         TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification — a preview of every message, using Ojulu's row as the example.
-- Expect 4 rows: level 1, level 2, final, reset. Read the body column to check
-- the wording (line breaks show as ↵ in the SQL Editor).
-- ─────────────────────────────────────────────────────────────────────────────

SELECT 'warning ' || l AS message, t.subject, t.body
  FROM generate_series(1, 3) l,
       LATERAL public.lab_warning_text(l, 'Ojulu', '2026-11-16'::date, 'RICT1510 0 of 8 hrs', 'Aaron Barker') t
UNION ALL
SELECT 'reset', r.subject, r.body
  FROM public.lab_warning_reset_text('Ojulu', 'Aaron Barker') r
ORDER BY 1;

ROLLBACK;   -- ← swap for COMMIT after checking the preview

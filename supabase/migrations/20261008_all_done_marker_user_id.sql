-- ═══════════════════════════════════════════════════════════════════════════
-- 20261008_all_done_marker_user_id.sql
--
-- All Done swipes not closing the week on the time card.
--
-- Cause: since 2026-09-17 the All Done marker is written even when the student
-- is no longer punched in. In that case its user_id came from a UUID-only
-- check, but profiles.user_id is the legacy 'USR####' text id, so the marker
-- was saved with user_id = NULL. The All Done card finds markers by email
-- (so the swipe looked confirmed); the time card loads entries by user_id, so
-- the marker never appeared — no All Done row, no "Week Closed by Instructor".
-- The 2026-10-06 server function mark_all_done copied the same rule.
--
-- This migration:
--   1. Patches mark_all_done IN PLACE (pg_get_functiondef + replace, like the
--      p3_rule patch) so the live body is kept and only the user_id fallback
--      changes: active punch → profiles.user_id → profiles.id (the same order
--      the kiosk punch-in uses). Grants are unchanged (CREATE OR REPLACE).
--   2. Adds a safety net: BEFORE INSERT trigger on time_clock that fills a
--      missing user_id from the profile with the same email, so no write path
--      can create an entry the time card can't see.
--   3. Repairs existing All Done markers with an empty user_id (4 rows on
--      2026-10-08: TC2090, TC2118, TC2211, TC2329).
--
-- Re-runnable. Ends in ROLLBACK — check the verification rows, then COMMIT.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 1: patch mark_all_done in place
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_oid  oid;
  v_def  text;
  v_new  text;
  v_pat  text := $p$CASE WHEN coalesce\(to_jsonb\(v_student\) ->> 'user_id', ''\) ~\* '[^']*'\s*THEN to_jsonb\(v_student\) ->> 'user_id' END$p$;
  v_rep  text := $r$nullif(to_jsonb(v_student) ->> 'user_id', ''), v_student.id::text$r$;
BEGIN
  SELECT p.oid INTO v_oid
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'mark_all_done';

  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'public.mark_all_done not found — run 20261006_security_phase3a_badges_alldone.sql first.';
  END IF;

  v_def := pg_get_functiondef(v_oid);

  IF v_def ~ v_pat THEN
    v_new := regexp_replace(v_def, v_pat, v_rep);
    EXECUTE v_new;
    RAISE NOTICE 'mark_all_done patched.';
  ELSIF position($q$nullif(to_jsonb(v_student) ->> 'user_id', ''), v_student.id::text$q$ IN v_def) > 0 THEN
    RAISE NOTICE 'mark_all_done already patched — skipped.';
  ELSE
    RAISE EXCEPTION 'mark_all_done body is not what this migration expects. Send this message to Claude; nothing was changed.';
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 2: safety net — fill a missing time_clock.user_id from the profile
-- SECURITY DEFINER so it can read the profile whoever is inserting; it only
-- ever sets user_id, and only when the insert left it empty.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.time_clock_fill_user_id()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_id text;
BEGIN
  IF coalesce(btrim(NEW.user_id::text), '') = '' AND coalesce(btrim(NEW.user_email), '') <> '' THEN
    SELECT coalesce(nullif(btrim(to_jsonb(p) ->> 'user_id'), ''), p.id::text)
      INTO v_id
      FROM public.profiles p
     WHERE lower(p.email) = lower(btrim(NEW.user_email))
     LIMIT 1;
    IF v_id IS NOT NULL THEN
      NEW.user_id := v_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.time_clock_fill_user_id() IS
  'Safety net (2026-10-08): a time_clock row inserted without user_id gets the profile''s USR#### id (or profile id) by email, so time cards — which load by user_id — always see it.';

REVOKE ALL ON FUNCTION public.time_clock_fill_user_id() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS time_clock_00_fill_user_id ON public.time_clock;
CREATE TRIGGER time_clock_00_fill_user_id
  BEFORE INSERT ON public.time_clock
  FOR EACH ROW
  EXECUTE FUNCTION public.time_clock_fill_user_id();

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 3: repair existing All Done markers
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TEMP TABLE _repaired ON COMMIT DROP AS
SELECT t.record_id
  FROM public.time_clock t
 WHERE t.entry_type = 'All Done'
   AND coalesce(btrim(t.user_id::text), '') = ''
   AND EXISTS (SELECT 1 FROM public.profiles p WHERE lower(p.email) = lower(btrim(t.user_email)));

UPDATE public.time_clock t
   SET user_id = (SELECT coalesce(nullif(btrim(to_jsonb(p) ->> 'user_id'), ''), p.id::text)
                    FROM public.profiles p
                   WHERE lower(p.email) = lower(btrim(t.user_email))
                   LIMIT 1)
 WHERE t.record_id IN (SELECT record_id FROM _repaired);

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 4: prove the safety net in a sub-transaction that is always undone
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TEMP TABLE _trigger_test (result text) ON COMMIT DROP;

DO $$
DECLARE
  v_email  text;
  v_got    text;
  v_want   text;
  v_result text;
BEGIN
  SELECT p.email, coalesce(nullif(btrim(to_jsonb(p) ->> 'user_id'), ''), p.id::text)
    INTO v_email, v_want
    FROM public.profiles p
   WHERE coalesce(p.email, '') <> ''
   ORDER BY p.email LIMIT 1;

  -- The inner block's work (the test row) is undone by the RAISE; the result
  -- lives in a variable and is recorded only after the undo.
  BEGIN
    INSERT INTO public.time_clock (record_id, user_email, user_name, punch_in, punch_out,
                                   total_hours, status, entry_type, description)
    VALUES ('TCTEST_FILL', v_email, 'Trigger test', now(), now(), 0, 'Punched Out',
            'All Done', 'migration self-test — rolled back');
    SELECT user_id::text INTO v_got FROM public.time_clock WHERE record_id = 'TCTEST_FILL';
    v_result := CASE WHEN v_got = v_want THEN 'ok: NULL user_id filled with ' || v_got
                     ELSE 'FAILED: got ' || coalesce(v_got, 'NULL') || ', expected ' || coalesce(v_want, 'NULL') END;
    RAISE EXCEPTION 'undo_self_test';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM <> 'undo_self_test' THEN
        v_result := 'test skipped: ' || SQLERRM;
      END IF;
  END;

  INSERT INTO _trigger_test VALUES (coalesce(v_result, 'test skipped: no result'));
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification (single result set)
--
-- Expect:
--   repaired        → one row per fixed marker, user_id now USR####
--   still empty     → 0
--   function        → patched = true, old UUID rule = false
--   trigger         → time_clock_00_fill_user_id, BEFORE INSERT
--   trigger test    → ok: NULL user_id filled with USR…
--   other entries   → time_clock rows of ANY type with no user_id (for information;
--                     not changed here — tell Claude if this is not 0)
-- ─────────────────────────────────────────────────────────────────────────────
SELECT 'repaired' AS kind, t.record_id AS name,
       t.user_email || ' · ' || t.punch_in::text || ' · user_id=' || t.user_id::text AS detail
  FROM public.time_clock t WHERE t.record_id IN (SELECT record_id FROM _repaired)
UNION ALL
SELECT 'still empty', 'All Done markers without user_id', count(*)::text
  FROM public.time_clock WHERE entry_type = 'All Done' AND coalesce(btrim(user_id::text), '') = ''
UNION ALL
SELECT 'function', 'mark_all_done',
       'patched=' || (position($q$v_student.id::text$q$ IN pg_get_functiondef(p.oid)) > 0)::text ||
       ' old UUID rule=' || (pg_get_functiondef(p.oid) ~ 'THEN to_jsonb\(v_student\) ->> ''user_id'' END')::text
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'mark_all_done'
UNION ALL
SELECT 'trigger', tgname, 'BEFORE INSERT on time_clock'
  FROM pg_trigger WHERE tgname = 'time_clock_00_fill_user_id' AND NOT tgisinternal
UNION ALL
SELECT 'trigger test', 'safety net', result FROM _trigger_test
UNION ALL
SELECT 'other entries', 'time_clock rows (any type) without user_id', count(*)::text
  FROM public.time_clock WHERE coalesce(btrim(user_id::text), '') = ''
ORDER BY 1, 2;

ROLLBACK;   -- ← swap for COMMIT after checking the verification output

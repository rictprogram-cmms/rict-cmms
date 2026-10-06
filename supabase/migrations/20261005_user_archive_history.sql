-- ═════════════════════════════════════════════════════════════════════════════
-- RICT CMMS — Archive history (keep past archive reasons after a restore)
-- File: supabase/migrations/20261005_user_archive_history.sql
--
-- Run AFTER 20261005_user_archive_reason.sql has been COMMITTED.
--
-- Purpose
--   profile_archive_info holds the reason for a user who is archived NOW, and
--   its row is removed when the user is restored — so restoring a student
--   erased the fact that they had previously dropped. This keeps a history:
--   each time a user leaves 'Archived', the reason / note / dates of that
--   archive are copied into profile_archive_history first.
--
-- Decisions
--   • Instructor-only, like the reason itself (staff-only row security).
--   • Written only by the database trigger. Instructors may READ entries and
--     REMOVE one (e.g. the wrong person was archived by mistake and restored);
--     nobody can add or edit entries from the app.
--   • Every restore is recorded, even when no reason had been entered.
--   • Permanently deleting a user removes their history too.
--   • Nothing can be backfilled: earlier restores were never recorded.
--
-- Timestamps: real UTC (Convention B in TIMESTAMP_CONVENTIONS.md).
--
-- Dry run: ends in ROLLBACK. Check that every verification row shows ok = true
-- (the INFO row is a count, not a check), then swap the last line for COMMIT.
-- The self-test undoes its own changes, so it alters no data even after COMMIT.
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 0: pre-checks
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.profile_archive_info') IS NULL THEN
    RAISE EXCEPTION 'public.profile_archive_info not found — COMMIT 20261005_user_archive_reason.sql first.';
  END IF;
  IF to_regprocedure('public.is_staff()') IS NULL THEN
    RAISE EXCEPTION 'public.is_staff() not found — security phase 1 must be live first.';
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 1: table (one row per archive that has ENDED in a restore)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.profile_archive_history (
  history_id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id            uuid NOT NULL,                 -- = profiles.id (no FK on purpose; cleaned up by trigger)
  reason             text,                          -- NULL = none had been recorded
  note               text,
  archived_at        timestamptz,                   -- when that archive began (NULL = not known)
  archived_by        text,
  archived_by_email  text,
  restored_at        timestamptz NOT NULL DEFAULT now(),
  restored_by        text,
  restored_by_email  text
);

CREATE INDEX IF NOT EXISTS profile_archive_history_user_idx
  ON public.profile_archive_history (user_id, restored_at DESC);

COMMENT ON TABLE public.profile_archive_history IS
  'Past archives of a user that ended in a restore (reason, note, dates). Written only by trigger profiles_track_archive. Staff (instructors) only — students must never read it.';

ALTER TABLE public.profile_archive_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS profile_archive_history_staff_select ON public.profile_archive_history;
DROP POLICY IF EXISTS profile_archive_history_staff_delete ON public.profile_archive_history;
CREATE POLICY profile_archive_history_staff_select
  ON public.profile_archive_history FOR SELECT TO authenticated
  USING (public.is_staff());
CREATE POLICY profile_archive_history_staff_delete
  ON public.profile_archive_history FOR DELETE TO authenticated
  USING (public.is_staff());

REVOKE ALL ON public.profile_archive_history FROM PUBLIC, anon, authenticated;
GRANT SELECT, DELETE ON public.profile_archive_history TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 2: trigger function — same as before, plus the history copy
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.profiles_track_archive()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_me   text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_name text;
BEGIN
  BEGIN
    IF TG_OP = 'DELETE' THEN
      DELETE FROM public.profile_archive_info    WHERE user_id = OLD.id;
      DELETE FROM public.profile_archive_history WHERE user_id = OLD.id;
      RETURN NULL;
    END IF;

    IF NEW.status IS NOT DISTINCT FROM OLD.status
       OR ('Archived' IS DISTINCT FROM NEW.status AND 'Archived' IS DISTINCT FROM OLD.status) THEN
      RETURN NULL;   -- nothing to do with archiving
    END IF;

    IF v_me <> '' THEN
      SELECT nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), '')
        INTO v_name
        FROM public.profiles p
       WHERE lower(p.email) = v_me
       LIMIT 1;
    END IF;

    IF NEW.status = 'Archived' THEN
      INSERT INTO public.profile_archive_info AS i
             (user_id, reason, note, archived_at, archived_by, archived_by_email)
      VALUES (NEW.id, NULL, NULL, now(), v_name, nullif(v_me, ''))
      ON CONFLICT (user_id) DO UPDATE
         SET reason = NULL, note = NULL, archived_at = now(),
             archived_by = EXCLUDED.archived_by,
             archived_by_email = EXCLUDED.archived_by_email;
    ELSE
      -- Leaving 'Archived': keep what that archive was, then clear the current row.
      INSERT INTO public.profile_archive_history
             (user_id, reason, note, archived_at, archived_by, archived_by_email,
              restored_at, restored_by, restored_by_email)
      SELECT i.user_id, i.reason, i.note, i.archived_at, i.archived_by, i.archived_by_email,
             now(), v_name, nullif(v_me, '')
        FROM public.profile_archive_info i
       WHERE i.user_id = NEW.id;
      DELETE FROM public.profile_archive_info WHERE user_id = NEW.id;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'profiles_track_archive: % (%)', SQLERRM, SQLSTATE;
  END;
  RETURN NULL;   -- AFTER trigger: return value is ignored
END;
$function$;

REVOKE ALL ON FUNCTION public.profiles_track_archive() FROM PUBLIC, anon, authenticated;

-- (Triggers profiles_track_archive_status / _delete already point at this function.)

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 3: realtime
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                    WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
                      AND tablename = 'profile_archive_history') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.profile_archive_history;
    END IF;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 4: self-test (archive → reason → restore → archive again, on one
-- Active student; everything is undone, even after COMMIT)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TEMP TABLE _arch_hist_tests (test text, expected text, actual text) ON COMMIT DROP;

DO $$
DECLARE
  v_id      uuid;
  v_before  int;
  v_hist    int;
  v_hist_ok boolean := false;
  v_info0   int;
  v_again   int;
  v_hist2   int;
BEGIN
  SELECT id INTO v_id FROM public.profiles
   WHERE status = 'Active' AND role = 'Student' ORDER BY id LIMIT 1;
  IF v_id IS NULL THEN
    INSERT INTO _arch_hist_tests VALUES ('self-test', 'ran', 'skipped — no Active student to test with');
    RETURN;
  END IF;

  BEGIN
    SELECT count(*) INTO v_before FROM public.profile_archive_history WHERE user_id = v_id;

    UPDATE public.profiles SET status = 'Archived' WHERE id = v_id;
    UPDATE public.profile_archive_info SET reason = 'Dropped/Withdrew', note = 'self-test' WHERE user_id = v_id;
    UPDATE public.profiles SET status = 'Active' WHERE id = v_id;

    SELECT count(*) - v_before INTO v_hist FROM public.profile_archive_history WHERE user_id = v_id;
    SELECT bool_or(reason = 'Dropped/Withdrew' AND note = 'self-test' AND archived_at IS NOT NULL AND restored_at IS NOT NULL)
      INTO v_hist_ok FROM public.profile_archive_history WHERE user_id = v_id;
    SELECT count(*) INTO v_info0 FROM public.profile_archive_info WHERE user_id = v_id;

    UPDATE public.profiles SET status = 'Archived' WHERE id = v_id;
    SELECT count(*) INTO v_again FROM public.profile_archive_info WHERE user_id = v_id AND reason IS NULL;
    SELECT count(*) - v_before INTO v_hist2 FROM public.profile_archive_history WHERE user_id = v_id;

    RAISE EXCEPTION 'undo self-test' USING ERRCODE = 'P0001';
  EXCEPTION WHEN raise_exception THEN
    NULL;   -- everything inside this block is rolled back; variables are kept
  END;

  INSERT INTO _arch_hist_tests VALUES
    ('restoring writes one history entry',           '1',    v_hist::text),
    ('the entry keeps reason, note and both dates',  'true', coalesce(v_hist_ok, false)::text),
    ('restoring still clears the current reason',    '0',    v_info0::text),
    ('archiving again starts with no reason',        '1',    v_again::text),
    ('archiving again does not add a history entry', '1',    v_hist2::text);
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification (single result set) — every row should show ok = true
-- ─────────────────────────────────────────────────────────────────────────────
SELECT * FROM (
  SELECT 1 AS ord, 'history table has row security on' AS check_name, 'true' AS expected,
         (SELECT c.relrowsecurity::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relname = 'profile_archive_history') AS actual
  UNION ALL
  SELECT 2, 'two staff-only policies (read, remove)', '2',
         (SELECT count(*)::text FROM pg_policies
           WHERE schemaname = 'public' AND tablename = 'profile_archive_history'
             AND qual LIKE '%is_staff()%' AND cmd IN ('SELECT', 'DELETE'))
  UNION ALL
  SELECT 3, 'no add / edit from the app, nothing for logged-out visitors', '0',
         (SELECT count(*)::text FROM information_schema.role_table_grants
           WHERE table_schema = 'public' AND table_name = 'profile_archive_history'
             AND (grantee = 'anon' OR (grantee = 'authenticated' AND privilege_type NOT IN ('SELECT', 'DELETE'))))
  UNION ALL
  SELECT 4, 'the two profiles triggers are still in place', '2',
         (SELECT count(*)::text FROM pg_trigger t
           WHERE t.tgrelid = 'public.profiles'::regclass AND NOT t.tgisinternal
             AND t.tgname LIKE 'profiles_track_archive_%')
  UNION ALL
  SELECT 5, 'every archived user still has a current row', '0',
         (SELECT count(*)::text FROM public.profiles p
           WHERE p.status = 'Archived'
             AND NOT EXISTS (SELECT 1 FROM public.profile_archive_info i WHERE i.user_id = p.id))
  UNION ALL
  SELECT 10 + row_number() OVER (), test, expected, actual FROM _arch_hist_tests
  UNION ALL
  SELECT 90, 'INFO: currently archived users / history entries so far',
         (SELECT count(*)::text FROM public.profile_archive_info),
         (SELECT count(*)::text FROM public.profile_archive_history)
) v
CROSS JOIN LATERAL (SELECT (v.ord >= 90 OR v.expected = v.actual) AS ok) o
ORDER BY ord;

ROLLBACK;   -- ← swap for COMMIT after every row shows ok = true

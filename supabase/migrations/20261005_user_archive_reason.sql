-- ═════════════════════════════════════════════════════════════════════════════
-- RICT CMMS — Why a user was archived (Graduated / Dropped/Withdrew / Other)
-- File: supabase/migrations/20261005_user_archive_reason.sql
--
-- Purpose
--   Archiving a user recorded nothing about WHY, and Settings → Classes
--   labelled every archived student "Former / graduated". A student who
--   dropped or did not finish is not a graduate. This adds a place to keep the
--   reason, an optional note, and when / by whom the user was archived.
--
-- Decisions (Aaron, 2026-10-05)
--   • Reasons: Graduated, Dropped/Withdrew, Other (Other needs a note).
--   • Users who are ALREADY archived keep no reason (shown as plain "Former");
--     nothing is assumed. Their archive date is filled in from the audit log
--     where an "Archive User" entry exists, otherwise left empty.
--   • Instructors only may see the reason. So it does NOT live on profiles
--     (every signed-in user can read profiles); it lives in its own table
--     with staff-only row security — same pattern as plan_instructor_notes.
--
-- How it stays correct
--   A trigger on profiles keeps this table in step with profiles.status no
--   matter which screen (or SQL) changed it:
--     status becomes 'Archived'      → row created (date + who, reason empty)
--     status leaves 'Archived'       → row removed (audit_log keeps history)
--     profile deleted                → row removed
--   The app then fills in reason + note on that row (instructors only).
--   The trigger never blocks a profile change: an error inside it is reduced
--   to a WARNING.
--
-- Timestamps: archived_at is real UTC (Convention B in TIMESTAMP_CONVENTIONS.md).
--
-- Dry run: ends in ROLLBACK. Check that every verification row shows ok = true
-- (the INFO rows are counts, not checks),
-- then swap the last line for COMMIT. The self-test in Section 5 undoes its own
-- changes, so it alters no data even after COMMIT.
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 0: pre-checks (fail early with a clear message)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'profiles'
       AND column_name = 'id' AND data_type = 'uuid'
  ) THEN
    RAISE EXCEPTION 'Expected public.profiles.id to be uuid — stop and tell Claude.';
  END IF;
  IF to_regprocedure('public.is_staff()') IS NULL THEN
    RAISE EXCEPTION 'public.is_staff() not found — security phase 1 (20260928_security_phase1.sql) must be live first.';
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 1: table (one row per archived user)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.profile_archive_info (
  user_id            uuid PRIMARY KEY,              -- = profiles.id (kept in step by trigger, no FK on purpose)
  reason             text,                          -- NULL = not recorded
  note               text,                          -- optional; required when reason = 'Other'
  archived_at        timestamptz DEFAULT now(),     -- real UTC; NULL = archived before this was tracked and not in audit_log
  archived_by        text,                          -- display name
  archived_by_email  text,
  CONSTRAINT profile_archive_info_reason_check
    CHECK (reason IS NULL OR reason IN ('Graduated', 'Dropped/Withdrew', 'Other')),
  CONSTRAINT profile_archive_info_other_needs_note
    CHECK (reason IS DISTINCT FROM 'Other' OR btrim(coalesce(note, '')) <> '')
);

CREATE INDEX IF NOT EXISTS profile_archive_info_archived_at_idx
  ON public.profile_archive_info (archived_at);

COMMENT ON TABLE public.profile_archive_info IS
  'Why / when / by whom a user was archived. One row per currently-archived profile, kept in step with profiles.status by trigger profiles_track_archive. Staff (instructors) only — students must never read it.';

ALTER TABLE public.profile_archive_info ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS profile_archive_info_staff ON public.profile_archive_info;
CREATE POLICY profile_archive_info_staff
  ON public.profile_archive_info FOR ALL TO authenticated
  USING (public.is_staff())
  WITH CHECK (public.is_staff());

REVOKE ALL ON public.profile_archive_info FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profile_archive_info TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 2: keep it in step with profiles.status
-- ─────────────────────────────────────────────────────────────────────────────
-- SECURITY DEFINER so the bookkeeping row is written even when the person
-- archiving is a non-instructor with the Users "deactivate" permission (they
-- can archive, but may not read or set the reason).
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
      DELETE FROM public.profile_archive_info WHERE user_id = OLD.id;

    ELSIF NEW.status = 'Archived' AND OLD.status IS DISTINCT FROM 'Archived' THEN
      IF v_me <> '' THEN
        SELECT nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), '')
          INTO v_name
          FROM public.profiles p
         WHERE lower(p.email) = v_me
         LIMIT 1;
      END IF;
      INSERT INTO public.profile_archive_info AS i
             (user_id, reason, note, archived_at, archived_by, archived_by_email)
      VALUES (NEW.id, NULL, NULL, now(), v_name, nullif(v_me, ''))
      ON CONFLICT (user_id) DO UPDATE
         SET reason = NULL, note = NULL, archived_at = now(),
             archived_by = EXCLUDED.archived_by,
             archived_by_email = EXCLUDED.archived_by_email;

    ELSIF OLD.status = 'Archived' AND NEW.status IS DISTINCT FROM 'Archived' THEN
      DELETE FROM public.profile_archive_info WHERE user_id = NEW.id;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'profiles_track_archive: % (%)', SQLERRM, SQLSTATE;
  END;
  RETURN NULL;   -- AFTER trigger: return value is ignored
END;
$function$;

REVOKE ALL ON FUNCTION public.profiles_track_archive() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS profiles_track_archive_status ON public.profiles;
CREATE TRIGGER profiles_track_archive_status
  AFTER UPDATE OF status ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_track_archive();

DROP TRIGGER IF EXISTS profiles_track_archive_delete ON public.profiles;
CREATE TRIGGER profiles_track_archive_delete
  AFTER DELETE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_track_archive();

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 3: users who are already archived — NO reason assumed
-- ─────────────────────────────────────────────────────────────────────────────
-- Date / who come from the newest "Archive User" audit entry when there is one.
INSERT INTO public.profile_archive_info
       (user_id, reason, note, archived_at, archived_by, archived_by_email)
SELECT p.id, NULL, NULL, a.ts, a.user_name, a.user_email
  FROM public.profiles p
  LEFT JOIN LATERAL (
         SELECT al."timestamp" AS ts, al.user_name, al.user_email
           FROM public.audit_log al
          WHERE al.action = 'Archive User'
            AND al.entity_id::text = p.id::text
          ORDER BY al."timestamp" DESC NULLS LAST
          LIMIT 1
       ) a ON true
 WHERE p.status = 'Archived'
ON CONFLICT (user_id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 4: realtime — so two instructors see each other's changes
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                    WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
                      AND tablename = 'profile_archive_info') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.profile_archive_info;
    END IF;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 5: self-test (archives one Active student, restores them, then
-- undoes everything — nothing is changed, even after COMMIT)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TEMP TABLE _arch_tests (test text, expected text, actual text) ON COMMIT DROP;

DO $$
DECLARE
  v_id        uuid;
  v_before    int;
  v_after_arc int;
  v_reason_ok boolean := false;
  v_other_blocked boolean := false;
  v_bad_blocked   boolean := false;
  v_after_res int;
BEGIN
  SELECT id INTO v_id FROM public.profiles
   WHERE status = 'Active' AND role = 'Student' ORDER BY id LIMIT 1;
  IF v_id IS NULL THEN
    INSERT INTO _arch_tests VALUES ('self-test', 'ran', 'skipped — no Active student to test with');
    RETURN;
  END IF;

  BEGIN
    SELECT count(*) INTO v_before FROM public.profile_archive_info WHERE user_id = v_id;

    UPDATE public.profiles SET status = 'Archived' WHERE id = v_id;
    SELECT count(*) INTO v_after_arc FROM public.profile_archive_info
     WHERE user_id = v_id AND reason IS NULL AND archived_at IS NOT NULL;

    UPDATE public.profile_archive_info SET reason = 'Dropped/Withdrew' WHERE user_id = v_id;
    SELECT (reason = 'Dropped/Withdrew') INTO v_reason_ok FROM public.profile_archive_info WHERE user_id = v_id;

    BEGIN
      UPDATE public.profile_archive_info SET reason = 'Other', note = '  ' WHERE user_id = v_id;
    EXCEPTION WHEN check_violation THEN v_other_blocked := true;
    END;
    BEGIN
      UPDATE public.profile_archive_info SET reason = 'Failed' WHERE user_id = v_id;
    EXCEPTION WHEN check_violation THEN v_bad_blocked := true;
    END;

    UPDATE public.profiles SET status = 'Active' WHERE id = v_id;
    SELECT count(*) INTO v_after_res FROM public.profile_archive_info WHERE user_id = v_id;

    RAISE EXCEPTION 'undo self-test' USING ERRCODE = 'P0001';
  EXCEPTION WHEN raise_exception THEN
    NULL;   -- everything inside this block is rolled back; variables are kept
  END;

  INSERT INTO _arch_tests VALUES
    ('test student starts with no archive row',  '0',    v_before::text),
    ('archiving creates a dated row, no reason', '1',    v_after_arc::text),
    ('a reason can be saved',                    'true', coalesce(v_reason_ok, false)::text),
    ('"Other" without a note is refused',        'true', v_other_blocked::text),
    ('an unknown reason is refused',             'true', v_bad_blocked::text),
    ('restoring removes the row',                '0',    v_after_res::text);
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification (single result set) — every row should show ok = true
-- ─────────────────────────────────────────────────────────────────────────────
SELECT * FROM (
  SELECT 1 AS ord, 'table has row security on' AS check_name, 'true' AS expected,
         (SELECT c.relrowsecurity::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relname = 'profile_archive_info') AS actual
  UNION ALL
  SELECT 2, 'one staff-only policy', '1',
         (SELECT count(*)::text FROM pg_policies
           WHERE schemaname = 'public' AND tablename = 'profile_archive_info'
             AND qual LIKE '%is_staff()%' AND with_check LIKE '%is_staff()%')
  UNION ALL
  SELECT 3, 'logged-out visitors have no access', '0',
         (SELECT count(*)::text FROM information_schema.role_table_grants
           WHERE table_schema = 'public' AND table_name = 'profile_archive_info' AND grantee = 'anon')
  UNION ALL
  SELECT 4, 'two triggers on profiles', '2',
         (SELECT count(*)::text FROM pg_trigger t
           WHERE t.tgrelid = 'public.profiles'::regclass AND NOT t.tgisinternal
             AND t.tgname LIKE 'profiles_track_archive_%')
  UNION ALL
  SELECT 5, 'every archived user has a row', '0',
         (SELECT count(*)::text FROM public.profiles p
           WHERE p.status = 'Archived'
             AND NOT EXISTS (SELECT 1 FROM public.profile_archive_info i WHERE i.user_id = p.id))
  UNION ALL
  SELECT 6, 'no row for a user who is not archived', '0',
         (SELECT count(*)::text FROM public.profile_archive_info i
           WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = i.user_id AND p.status = 'Archived'))
  UNION ALL
  SELECT 10 + row_number() OVER (), test, expected, actual FROM _arch_tests
  UNION ALL
  SELECT 90, 'INFO: archived users / with a date found in the audit log',
         (SELECT count(*)::text FROM public.profile_archive_info),
         (SELECT count(*)::text FROM public.profile_archive_info WHERE archived_at IS NOT NULL)
  UNION ALL
  SELECT 91, 'INFO: archived users / with a reason recorded (0 on the first run — none is assumed)',
         (SELECT count(*)::text FROM public.profile_archive_info),
         (SELECT count(*)::text FROM public.profile_archive_info WHERE reason IS NOT NULL)
) v
CROSS JOIN LATERAL (SELECT (v.ord >= 90 OR v.expected = v.actual) AS ok) o
ORDER BY ord;

ROLLBACK;   -- ← swap for COMMIT after every row shows ok = true

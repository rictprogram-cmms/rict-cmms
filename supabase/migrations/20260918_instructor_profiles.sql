-- ═══════════════════════════════════════════════════════════════════════════
-- RICT CMMS — Instructor profiles (Phase 3 of "enter once")
-- File: supabase/migrations/20260918_instructor_profiles.sql
--
-- Purpose
--   Instructor contact details (phone, office, office hours) live on the
--   instructor's profile once; a class links to that profile; the Syllabus
--   Wizard prefills Step 2 from it. Classes taught by someone who is not a
--   CMMS user (e.g. an outside instructor) keep a typed name with no link.
--
-- Contents
--   1. profiles.phone / office / office_hours
--   2. classes.instructor_email (nullable — NULL means ad-hoc typed name)
--   3. Backfill classes.instructor_email by matching the typed name to an
--      Instructor profile ("Aaron Barker" ↔ first_name + last_name)
--   4. Backfill profile contact fields from the newest syllabus that names
--      that instructor's email (so nothing already typed is lost)
--   5. Consolidated verification SELECT (last statement before COMMIT)
--
-- COMMIT version (dry run verified 2026-09-18: 18 of 18 classes linked to instructor profiles).

-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ───────────────────────────────────────────────────────────────────────────
-- Section 1: profile contact fields
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS phone        text,
  ADD COLUMN IF NOT EXISTS office       text,
  ADD COLUMN IF NOT EXISTS office_hours text;

COMMENT ON COLUMN public.profiles.phone        IS 'Instructor contact phone (printed on syllabi).';
COMMENT ON COLUMN public.profiles.office       IS 'Instructor office location, e.g. 1-352A (printed on syllabi).';
COMMENT ON COLUMN public.profiles.office_hours IS 'Instructor office hours, free text (printed on syllabi).';

-- ───────────────────────────────────────────────────────────────────────────
-- Section 2: classes.instructor_email
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE public.classes
  ADD COLUMN IF NOT EXISTS instructor_email text;

COMMENT ON COLUMN public.classes.instructor_email IS
  'Email of the instructor profile this class is linked to. NULL = ad-hoc typed name (instructor not a CMMS user). `instructor` keeps the display name either way.';

-- ───────────────────────────────────────────────────────────────────────────
-- Section 3: link classes to instructor profiles by name
-- ───────────────────────────────────────────────────────────────────────────
UPDATE public.classes c
   SET instructor_email = p.email
  FROM public.profiles p
 WHERE c.instructor_email IS NULL
   AND p.role = 'Instructor'
   AND lower(regexp_replace(coalesce(c.instructor, ''), '\s+', ' ', 'g'))
       = lower(regexp_replace(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, ''), '\s+', ' ', 'g'));

-- ───────────────────────────────────────────────────────────────────────────
-- Section 4: profile contact from the newest syllabus that names them
-- ───────────────────────────────────────────────────────────────────────────
UPDATE public.profiles p
   SET phone        = coalesce(p.phone,        s.instructor_phone),
       office       = coalesce(p.office,       s.instructor_office),
       office_hours = coalesce(p.office_hours, s.instructor_office_hours)
  FROM (
    SELECT DISTINCT ON (lower(instructor_email))
           lower(instructor_email) AS email, instructor_phone, instructor_office, instructor_office_hours
      FROM public.syllabus_templates
     WHERE coalesce(instructor_email, '') <> ''
     ORDER BY lower(instructor_email), updated_at DESC NULLS LAST
  ) s
 WHERE lower(p.email) = s.email
   AND p.role = 'Instructor'
   AND (p.phone IS NULL OR p.office IS NULL OR p.office_hours IS NULL);

-- ───────────────────────────────────────────────────────────────────────────
-- Section 5: verification (single SELECT — last statement before COMMIT)
-- ───────────────────────────────────────────────────────────────────────────
SELECT
  (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'profiles'
     AND column_name IN ('phone', 'office', 'office_hours'))                                               AS profile_cols,      -- expect 3
  (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'classes'
     AND column_name = 'instructor_email')                                                                  AS class_col,         -- expect 1
  (SELECT string_agg(first_name || ' ' || last_name || ' <' || email || '>'
                     || ' | phone ' || coalesce(phone, '—') || ' | office ' || coalesce(office, '—') || ' | hours ' || coalesce(office_hours, '—'),
                     E'\n' ORDER BY last_name)
     FROM public.profiles WHERE role = 'Instructor')                                                       AS instructors,
  (SELECT count(*) FROM public.classes WHERE instructor_email IS NOT NULL)                                  AS classes_linked_to_instructor,
  (SELECT string_agg(DISTINCT coalesce(instructor, '(blank)'), ', ')
     FROM public.classes WHERE instructor_email IS NULL)                                                    AS unlinked_instructor_names;  -- outside instructors / typos

COMMIT;

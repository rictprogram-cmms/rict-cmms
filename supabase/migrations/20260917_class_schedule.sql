-- ═══════════════════════════════════════════════════════════════════════════
-- RICT CMMS — Class Schedule (term scheduler moved into the CMMS)
-- File: supabase/migrations/20260917_class_schedule.sql
--
-- Purpose
--   The RICT Term Scheduler (a standalone artifact) becomes a CMMS page.
--   The class list, weekly hours and instructor come from Settings → Classes;
--   the schedule adds what only the scheduler needs — room, half of term,
--   colour, combined-group, note, and the half-hour blocks per weekday.
--
-- Design
--   • class_schedules — one row per semester, keyed by the exact
--     classes.semester text ("Spring 2027"). schedule_id is a slug of it.
--   • class_schedule_items — one row per class on that schedule.
--       - Linked class: class_id → classes.class_id; code/title/instructor/
--         hours are a SNAPSHOT (the app overlays live values from classes on
--         every load; the snapshot is for history and for a class that is
--         later deleted from Settings). item_id is deterministic
--         ('CSI-<schedule_id>-<class_id>') so the app can upsert without
--         tracking "new" rows.
--       - Ad-hoc class (outside instructor, not in Settings): class_id NULL,
--         is_adhoc true, all fields owned by the schedule.
--       - slots_a / slots_b: jsonb [[Mon],[Tue],[Wed],[Thu],[Fri]] of
--         half-hour slot numbers 0..47 (slot 16 = 8:00 AM), first / second
--         8 weeks. A 16-week class keeps A and B identical.
--   • RLS: every signed-in user can read (students/work study view); only
--     instructors (current_user_is_instructor(), from 20260907) can write.
--     The 'edit_schedule' permission gates the UI; RLS is the backstop.
--   • Realtime: both tables added to the supabase_realtime publication so
--     two instructors editing at once see each other's changes.
--   • Audit: the app writes one audit_log row per save (entity_type
--     'Class Schedule', entity_id = schedule_id) with a plain-English change
--     list; the page's History panel reads those rows back.
--   • Permissions: 'Class Schedule' / view_page (everyone) and
--     edit_schedule (instructor only), next free P-numbers.
--
-- Contents
--   0. dependency check
--   1. class_schedules
--   2. class_schedule_items
--   3. RLS
--   4. realtime publication
--   5. permission rows
--   6. Consolidated verification SELECT (last statement before COMMIT)
--
-- COMMIT version (dry run verified 2026-09-17). Run the Access page Sync first
-- so manage_it_segments takes P178 and these rows land on P179/P180.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ───────────────────────────────────────────────────────────────────────────
-- Section 0: dependency check
-- ───────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regprocedure('public.current_user_is_instructor()') IS NULL THEN
    RAISE EXCEPTION 'Missing public.current_user_is_instructor() — apply 20260907_absence_late_submission.sql first';
  END IF;
  IF to_regclass('public.classes') IS NULL THEN
    RAISE EXCEPTION 'public.classes not found';
  END IF;
END $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Section 1: class_schedules (one per semester)
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.class_schedules (
  schedule_id  text PRIMARY KEY,                       -- slug: 'spring-2027'
  semester     text NOT NULL UNIQUE,                   -- exact classes.semester text
  start_hour   integer NOT NULL DEFAULT 8  CHECK (start_hour BETWEEN 0 AND 22),
  end_hour     integer NOT NULL DEFAULT 18 CHECK (end_hour BETWEEN 1 AND 24 AND end_hour > start_hour),
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   text
);

COMMENT ON TABLE public.class_schedules IS
  'Class Schedule page — one row per semester (keyed by classes.semester). Grid hours + who last saved.';

-- ───────────────────────────────────────────────────────────────────────────
-- Section 2: class_schedule_items (one per class on a schedule)
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.class_schedule_items (
  item_id      text PRIMARY KEY,                       -- 'CSI-<schedule_id>-<class_id>' or 'CSI-<schedule_id>-adhoc-<rand>'
  schedule_id  text NOT NULL REFERENCES public.class_schedules (schedule_id) ON DELETE CASCADE,
  class_id     text,                                   -- classes.class_id for linked classes; NULL for ad-hoc
  is_adhoc     boolean NOT NULL DEFAULT false,
  code         text NOT NULL DEFAULT '',               -- snapshot of classes.course_id (or ad-hoc value)
  title        text NOT NULL DEFAULT '',               -- snapshot of classes.course_name
  instructor   text NOT NULL DEFAULT '',               -- snapshot of classes.instructor
  hours        numeric NOT NULL DEFAULT 0,             -- snapshot of classes.required_hours (hours / week)
  room         text NOT NULL DEFAULT '',
  span         text NOT NULL DEFAULT 'first' CHECK (span IN ('first', 'second', 'both')),
  color        text NOT NULL DEFAULT 'blue',
  group_key    text NOT NULL DEFAULT '',               -- classes sharing a key are combined (co-taught)
  note         text NOT NULL DEFAULT '',
  slots_a      jsonb NOT NULL DEFAULT '[[],[],[],[],[]]'::jsonb,
  slots_b      jsonb NOT NULL DEFAULT '[[],[],[],[],[]]'::jsonb,
  sort_order   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   text,
  CONSTRAINT class_schedule_items_link CHECK (
    (is_adhoc AND class_id IS NULL) OR (NOT is_adhoc AND class_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS class_schedule_items_schedule_idx
  ON public.class_schedule_items (schedule_id, sort_order);

CREATE UNIQUE INDEX IF NOT EXISTS class_schedule_items_schedule_class_uidx
  ON public.class_schedule_items (schedule_id, class_id)
  WHERE class_id IS NOT NULL;

COMMENT ON TABLE public.class_schedule_items IS
  'Class Schedule page — per-class placement (room, half of term, colour, combined group, note, half-hour slots per weekday).';

-- ───────────────────────────────────────────────────────────────────────────
-- Section 3: RLS — everyone signed in reads, instructors write
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE public.class_schedules      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.class_schedule_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS class_schedules_select ON public.class_schedules;
DROP POLICY IF EXISTS class_schedules_insert ON public.class_schedules;
DROP POLICY IF EXISTS class_schedules_update ON public.class_schedules;
DROP POLICY IF EXISTS class_schedules_delete ON public.class_schedules;

CREATE POLICY class_schedules_select ON public.class_schedules
  FOR SELECT TO authenticated USING (true);
CREATE POLICY class_schedules_insert ON public.class_schedules
  FOR INSERT TO authenticated WITH CHECK (public.current_user_is_instructor());
CREATE POLICY class_schedules_update ON public.class_schedules
  FOR UPDATE TO authenticated USING (public.current_user_is_instructor()) WITH CHECK (public.current_user_is_instructor());
CREATE POLICY class_schedules_delete ON public.class_schedules
  FOR DELETE TO authenticated USING (public.current_user_is_instructor());

DROP POLICY IF EXISTS class_schedule_items_select ON public.class_schedule_items;
DROP POLICY IF EXISTS class_schedule_items_insert ON public.class_schedule_items;
DROP POLICY IF EXISTS class_schedule_items_update ON public.class_schedule_items;
DROP POLICY IF EXISTS class_schedule_items_delete ON public.class_schedule_items;

CREATE POLICY class_schedule_items_select ON public.class_schedule_items
  FOR SELECT TO authenticated USING (true);
CREATE POLICY class_schedule_items_insert ON public.class_schedule_items
  FOR INSERT TO authenticated WITH CHECK (public.current_user_is_instructor());
CREATE POLICY class_schedule_items_update ON public.class_schedule_items
  FOR UPDATE TO authenticated USING (public.current_user_is_instructor()) WITH CHECK (public.current_user_is_instructor());
CREATE POLICY class_schedule_items_delete ON public.class_schedule_items
  FOR DELETE TO authenticated USING (public.current_user_is_instructor());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.class_schedules      TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.class_schedule_items TO authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- Section 4: realtime — so two instructors see each other's edits
-- ───────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'class_schedules') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.class_schedules;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'class_schedule_items') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.class_schedule_items;
    END IF;
  END IF;
END $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Section 5: permission rows — next free P-numbers, idempotent
-- ───────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_next integer;
BEGIN
  SELECT coalesce(max(nullif(regexp_replace(permission_id, '\D', '', 'g'), '')::integer), 0) + 1
    INTO v_next FROM public.permissions;

  IF NOT EXISTS (SELECT 1 FROM public.permissions WHERE page = 'Class Schedule' AND feature = 'view_page') THEN
    INSERT INTO public.permissions
      (permission_id, page, feature, student, work_study, instructor, description, updated_at, updated_by)
    VALUES ('P' || v_next, 'Class Schedule', 'view_page', true, true, true,
            'Can view the Class Schedule page', now(), 'migration');
    v_next := v_next + 1;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.permissions WHERE page = 'Class Schedule' AND feature = 'edit_schedule') THEN
    INSERT INTO public.permissions
      (permission_id, page, feature, student, work_study, instructor, description, updated_at, updated_by)
    VALUES ('P' || v_next, 'Class Schedule', 'edit_schedule', false, false, true,
            'Can place classes on the grid, edit rooms / notes / combined groups, add unlisted classes, and copy a layout from a past semester', now(), 'migration');
  END IF;
END $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Section 6: verification (single SELECT — last statement before COMMIT)
-- ───────────────────────────────────────────────────────────────────────────
SELECT
  to_regclass('public.class_schedules')      IS NOT NULL AS schedules_table,        -- expect true
  to_regclass('public.class_schedule_items') IS NOT NULL AS items_table,            -- expect true
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'class_schedules')      AS schedule_policies, -- expect 4
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'class_schedule_items') AS item_policies,     -- expect 4
  (SELECT count(*) FROM pg_publication_tables WHERE pubname = 'supabase_realtime'
     AND tablename IN ('class_schedules', 'class_schedule_items'))                  AS realtime_tables,   -- expect 2 (0 if no publication)
  (SELECT string_agg(permission_id || ' ' || feature || ' s=' || student::text || ' ws=' || work_study::text || ' i=' || instructor::text, '; ' ORDER BY permission_id)
     FROM public.permissions WHERE page = 'Class Schedule')                         AS class_schedule_perms, -- expect 2 rows: view_page all true, edit_schedule instructor only
  (SELECT count(DISTINCT semester) FROM public.classes WHERE coalesce(semester, '') <> '') AS semesters_with_classes,
  (SELECT string_agg(DISTINCT semester, ', ') FROM public.classes WHERE coalesce(semester, '') <> '') AS semester_names;

COMMIT;

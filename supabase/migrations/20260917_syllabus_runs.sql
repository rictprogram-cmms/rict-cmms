-- ═══════════════════════════════════════════════════════════════════════════
-- RICT CMMS — Syllabus: which 8 weeks a half-semester section runs
-- File: supabase/migrations/20260917_syllabus_runs.sql
--
-- Purpose
--   syllabus_templates records semester_length ('16' | '8') but never WHICH
--   half an 8-week section occupies. classes already has `runs`
--   ('full' | 'first' | 'second'), Settings → Classes has a picker for it, and
--   academicTerms.js has datesForRuns() / calendarFromTerm() built around it —
--   the Syllabus Wizard is the only place that never got it.
--
--   The visible symptom: pick "8-Week (Half Semester)" on step 3 and step 4
--   still fills in the FULL term's begin/end dates, because Step4Dates reads
--   term.begin_date / term.end_date directly instead of asking datesForRuns()
--   what an 8-week section should get.
--
--   This adds `runs` to syllabus_templates so the syllabus speaks the same
--   vocabulary as the class record and the two can actually sync.
--
--     semester_length  '8'                    (how long)
--     runs             'first' | 'second'     (which half)  ← new
--
--   semester_length is KEPT, not replaced: it drives the required-hours-per-week
--   formula (lab credits × 2, doubled for an 8-week section) in several places.
--   The wizard now derives it from runs so the two cannot disagree.
--
-- Contents
--   1. syllabus_templates.runs (nullable at first so the backfill can run)
--   2. Backfill from the matching CMMS class (course_id + semester)
--   3. Backfill the remainder by inferring from the syllabus's own dates
--      against its term — mirrors inferRuns() in src/lib/academicTerms.js
--   4. Default 'full' for everything still unset, then NOT NULL + CHECK
--   5. Consolidated verification SELECT (last statement before ROLLBACK)
--
-- DRY RUN: ends with ROLLBACK. Review the verification output, then swap the
-- final ROLLBACK to COMMIT and re-run.
--
-- Safety
--   • Additive only. semester_length and every date column are untouched.
--   • Re-runnable: ADD COLUMN IF NOT EXISTS; the backfill only fills NULLs.
--   • RLS: the new column inherits the table's existing policies and grants.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Column ────────────────────────────────────────────────────────────────
ALTER TABLE public.syllabus_templates
  ADD COLUMN IF NOT EXISTS runs text;

COMMENT ON COLUMN public.syllabus_templates.runs IS
  'Which part of the term this section runs: full | first | second. Matches '
  'classes.runs. Drives the dates Step 4 of the Syllabus Wizard fills in via '
  'datesForRuns(). semester_length stays the source for required hours/week.';


-- ── 2. Backfill from the matching class ──────────────────────────────────────
-- The class record is authoritative where one exists: Settings → Classes has
-- had a Runs picker all along, so that value was chosen deliberately.
UPDATE public.syllabus_templates t
   SET runs = c.runs
  FROM public.classes c
 WHERE t.runs IS NULL
   AND c.course_id = t.course_id
   AND c.semester  = t.semester
   AND c.runs IN ('full', 'first', 'second');


-- ── 3. Infer the remainder from the syllabus's own dates ─────────────────────
-- Mirrors inferRuns(): a section 10.5 weeks or shorter that starts within 3
-- weeks of the term begin is the first half, otherwise the second. Anything
-- longer — or with no usable dates — falls through to 'full' in section 4.
UPDATE public.syllabus_templates t
   SET runs = CASE
                WHEN (t.begin_date::date - term.begin_date::date) <= 21 THEN 'first'
                ELSE 'second'
              END
  FROM public.academic_terms term
 WHERE t.runs IS NULL
   AND term.name = t.semester
   AND t.begin_date IS NOT NULL
   AND t.end_date   IS NOT NULL
   AND term.begin_date IS NOT NULL
   -- only sections that are actually short enough to be a half
   AND (t.end_date::date - t.begin_date::date) <= 74;   -- 10.5 weeks


-- ── 4. Default, then lock the column down ────────────────────────────────────
UPDATE public.syllabus_templates SET runs = 'full' WHERE runs IS NULL;

ALTER TABLE public.syllabus_templates ALTER COLUMN runs SET DEFAULT 'full';
ALTER TABLE public.syllabus_templates ALTER COLUMN runs SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'syllabus_templates_runs_check'
       AND conrelid = 'public.syllabus_templates'::regclass
  ) THEN
    ALTER TABLE public.syllabus_templates
      ADD CONSTRAINT syllabus_templates_runs_check
      CHECK (runs IN ('full', 'first', 'second'));
  END IF;
END $$;


-- ── 5. Verification ──────────────────────────────────────────────────────────
-- Row 1 summarises. The rows after it are syllabi whose `runs` DISAGREES with
-- something: either the CMMS class for the same course + semester, or the
-- semester_length already recorded on the syllabus. Those are the ones worth
-- eyeballing before COMMIT — everything else was either copied from the class
-- or defaulted to a full term.
SELECT * FROM (
  SELECT
    0                                                          AS sort_order,
    'SUMMARY'                                                  AS scope,
    NULL::text                                                 AS course_id,
    NULL::text                                                 AS semester,
    NULL::text                                                 AS syllabus_runs,
    NULL::text                                                 AS semester_length,
    NULL::text                                                 AS class_runs,
    format('%s syllabi · %s full · %s first 8wk · %s second 8wk',
           count(*),
           count(*) FILTER (WHERE runs = 'full'),
           count(*) FILTER (WHERE runs = 'first'),
           count(*) FILTER (WHERE runs = 'second'))            AS detail
  FROM public.syllabus_templates

  UNION ALL

  SELECT
    1,
    CASE WHEN c.class_id IS NULL THEN 'CHECK (no class)' ELSE 'CHECK (differs from class)' END,
    t.course_id,
    t.semester,
    t.runs,
    t.semester_length,
    coalesce(c.runs, '—'),
    CASE
      WHEN c.class_id IS NULL
        THEN 'No CMMS class for this course + semester — the syllabus cannot sync dates, drop or withdraw until one is scheduled'
      ELSE 'Syllabus and class disagree on which part of the term this runs'
    END
  FROM public.syllabus_templates t
  LEFT JOIN public.classes c
         ON c.course_id = t.course_id AND c.semester = t.semester
  WHERE coalesce(t.status, 'active') <> 'archived'
    AND (
      c.class_id IS NULL
      OR (c.runs IS NOT NULL AND c.runs <> t.runs)
      OR (t.runs = 'full') <> (coalesce(t.semester_length, '16') = '16')
    )
) v
ORDER BY sort_order, course_id, semester;

ROLLBACK;
-- COMMIT;

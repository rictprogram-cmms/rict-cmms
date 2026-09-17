-- ═══════════════════════════════════════════════════════════════════════════
-- RICT CMMS — Classes: delivery format + credits from the course catalog
-- File: supabase/migrations/20260917_classes_delivery_credits.sql
--
-- Purpose
--   Settings → Classes now creates classes FROM the course catalog
--   (syllabus_courses) instead of re-typing them, and records how each
--   offering is delivered so required hours/week can be computed:
--
--     Face-to-Face  1 hr per lecture credit + 2 hr per lab credit
--     Hybrid        2 hr per lab credit
--     Online        0
--     × 2 for an 8-week section (start → end ≤ ~10 weeks)
--
--   Delivery is per class (per offering), not per catalog course — the same
--   course can be hybrid one semester and online the next.
--
-- Contents
--   1. classes.delivery / credits_lecture / credits_lab (idempotent)
--   2. Backfill credits from syllabus_courses by course_id where missing
--      (delivery stays at the default 'Hybrid' — flip online classes by hand)
--   3. Consolidated verification SELECT (last statement before ROLLBACK)
--
-- DRY RUN: ends with ROLLBACK. Swap to COMMIT after the verification output
-- looks right.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ───────────────────────────────────────────────────────────────────────────
-- Section 1: columns
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE public.classes
  ADD COLUMN IF NOT EXISTS delivery        text    NOT NULL DEFAULT 'Hybrid',
  ADD COLUMN IF NOT EXISTS credits_lecture numeric,
  ADD COLUMN IF NOT EXISTS credits_lab     numeric;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'classes_delivery_check') THEN
    ALTER TABLE public.classes
      ADD CONSTRAINT classes_delivery_check CHECK (delivery IN ('Face-to-Face', 'Hybrid', 'Online'));
  END IF;
END $$;

COMMENT ON COLUMN public.classes.delivery IS
  'How this offering is delivered: Face-to-Face (lecture + 2×lab hrs/wk), Hybrid (2×lab hrs/wk), Online (0). 8-week sections double.';
COMMENT ON COLUMN public.classes.credits_lecture IS 'Lecture credits, copied from syllabus_courses when the class is created from the catalog.';
COMMENT ON COLUMN public.classes.credits_lab     IS 'Lab credits, copied from syllabus_courses when the class is created from the catalog.';

-- ───────────────────────────────────────────────────────────────────────────
-- Section 2: backfill credits from the catalog (only where not yet set)
-- ───────────────────────────────────────────────────────────────────────────
UPDATE public.classes c
   SET credits_lecture = coalesce(c.credits_lecture, s.credits_lecture),
       credits_lab     = coalesce(c.credits_lab,     s.credits_lab)
  FROM public.syllabus_courses s
 WHERE upper(replace(s.course_id, ' ', '')) = upper(replace(c.course_id, ' ', ''))
   AND (c.credits_lecture IS NULL OR c.credits_lab IS NULL);

-- ───────────────────────────────────────────────────────────────────────────
-- Section 3: verification (single SELECT — last statement before ROLLBACK)
-- ───────────────────────────────────────────────────────────────────────────
SELECT
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'classes'
      AND column_name IN ('delivery', 'credits_lecture', 'credits_lab'))        AS new_columns,          -- expect 3
  (SELECT count(*) FROM pg_constraint WHERE conname = 'classes_delivery_check')   AS delivery_check,       -- expect 1
  (SELECT count(*) FROM public.classes)                                           AS total_classes,
  (SELECT count(*) FROM public.classes WHERE credits_lab IS NOT NULL)             AS classes_with_credits, -- how many matched the catalog
  (SELECT string_agg(course_id, ', ' ORDER BY course_id) FROM public.classes WHERE credits_lab IS NULL)
                                                                                  AS classes_not_in_catalog,
  (SELECT count(*) FROM public.syllabus_courses WHERE status = 'active')          AS active_catalog_courses,
  (SELECT string_agg(DISTINCT delivery, ', ') FROM public.classes)                AS delivery_values;      -- expect Hybrid

ROLLBACK;

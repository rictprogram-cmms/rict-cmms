-- ═══════════════════════════════════════════════════════════════════════════
-- RICT CMMS — Syllabus materials: durable link to the tools catalog
-- File: supabase/migrations/20260917_syllabus_material_ids.sql
--
-- Purpose
--   syllabus_templates.required_materials stores DISPLAY STRINGS, e.g.
--     "RICT TEST LEAD SET SILICONE (Part #: 2810050012254)"
--   and Program Cost re-matches those strings to program_tools by lowercased
--   name at render time. That link is fragile: rename a catalog item, add a
--   stray space, or shorten a name and the item silently drops out of the
--   cost sheet with no price and no warning.
--
--   This adds an index-aligned array of program_tools.tool_id values so the
--   link survives renames. required_materials is UNCHANGED and remains the
--   display/print source for the DOCX export, the HTML preview, the printed
--   cost report and the Required Tools usage map — nothing that reads strings
--   today has to change.
--
--     required_materials     ["RICT FLASH DRIVE (Part #: 2810050009094)", "Multimeter Fluke87-V"]
--     required_material_ids  ["PT1A2B3C",                                  "PT9Z8Y7X"]
--
--   A null at position i means "this item has never been resolved to a
--   catalog row" — Program Cost lists it but excludes it from totals and
--   names it in the unlinked-items banner.
--
-- Contents
--   1. syllabus_templates.required_material_ids (idempotent)
--   2. Name / part-number normalizer functions mirroring the JS matcher
--   3. Resolution pass into a temp table (exact name → part # → unique contains)
--   4. Backfill UPDATE
--   5. Consolidated verification SELECT (last statement before ROLLBACK)
--
-- DRY RUN: ends with ROLLBACK. Review the verification output, then swap the
-- final ROLLBACK to COMMIT and re-run.
--
-- Safety
--   • Additive only. No existing column is read-modified-written.
--   • Re-runnable: ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE, and the
--     backfill recomputes from scratch every time.
--   • RLS: the new column inherits the table's existing policies and grants;
--     no policy changes are needed.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Column ────────────────────────────────────────────────────────────────
ALTER TABLE public.syllabus_templates
  ADD COLUMN IF NOT EXISTS required_material_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.syllabus_templates.required_material_ids IS
  'Index-aligned with required_materials: program_tools.tool_id for each entry, '
  'or null when the item is not linked to a catalog row. Costing source of '
  'truth; required_materials stays the display/print source.';


-- ── 2. Normalizers (must mirror the JS in SyllabusWizard / ProgramCostPage) ──
-- Strip the trailing " (Part #: ...)" suffix, trim, lowercase.
CREATE OR REPLACE FUNCTION public.syllabus_material_clean_name(txt text)
RETURNS text
LANGUAGE sql IMMUTABLE STRICT
AS $$
  SELECT lower(btrim(regexp_replace(txt, '\s*\(Part\s*#:.*\)\s*$', '', 'i')))
$$;

-- Pull the part number out of the suffix, if present.
CREATE OR REPLACE FUNCTION public.syllabus_material_part_number(txt text)
RETURNS text
LANGUAGE sql IMMUTABLE STRICT
AS $$
  SELECT lower(btrim((regexp_match(txt, '\(Part\s*#:\s*([^)]+)\)', 'i'))[1]))
$$;


-- ── 3. Resolution pass ───────────────────────────────────────────────────────
-- One row per (template, material index). Match priority mirrors the app:
--   a. exact normalized item_name
--   b. part number extracted from the string
--   c. substring match — ONLY when exactly one active catalog row matches,
--      so an ambiguous name never binds to the wrong price.
-- Active rows win ties over retired ones.
DROP TABLE IF EXISTS _syllabus_material_resolve;
CREATE TEMP TABLE _syllabus_material_resolve ON COMMIT DROP AS
WITH exploded AS (
  SELECT
    t.id,
    t.course_id,
    t.semester,
    COALESCE(t.status, 'active') AS status,
    m.ord::int                   AS item_index,
    m.val                        AS raw_item
  FROM public.syllabus_templates t
  CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(t.required_materials) = 'array'
         THEN t.required_materials
         ELSE '[]'::jsonb END
  ) WITH ORDINALITY AS m(val, ord)
)
SELECT
  e.id,
  e.course_id,
  e.semester,
  e.status,
  e.item_index,
  e.raw_item,
  public.syllabus_material_clean_name(e.raw_item) AS clean_name,
  COALESCE(
    -- a. exact name
    (SELECT p.tool_id FROM public.program_tools p
      WHERE lower(btrim(p.item_name)) = public.syllabus_material_clean_name(e.raw_item)
      ORDER BY (p.status = 'Active') DESC, p.tool_id
      LIMIT 1),
    -- b. part number
    (SELECT p.tool_id FROM public.program_tools p
      WHERE public.syllabus_material_part_number(e.raw_item) IS NOT NULL
        AND lower(btrim(p.part_number)) = public.syllabus_material_part_number(e.raw_item)
      ORDER BY (p.status = 'Active') DESC, p.tool_id
      LIMIT 1),
    -- c. unambiguous substring match only
    -- strpos, not LIKE — item names may contain % or _ and must not be
    -- reinterpreted as wildcards
    (SELECT max(p.tool_id) FROM public.program_tools p
      WHERE length(lower(btrim(p.item_name))) > 3
        AND public.syllabus_material_clean_name(e.raw_item) <> ''
        AND ( strpos(lower(btrim(p.item_name)), public.syllabus_material_clean_name(e.raw_item)) > 0
           OR strpos(public.syllabus_material_clean_name(e.raw_item), lower(btrim(p.item_name))) > 0 )
      HAVING count(*) = 1)
  ) AS tool_id
FROM exploded e;


-- ── 4. Backfill ──────────────────────────────────────────────────────────────
UPDATE public.syllabus_templates t
SET required_material_ids = agg.ids
FROM (
  SELECT id, jsonb_agg(to_jsonb(tool_id) ORDER BY item_index) AS ids
  FROM _syllabus_material_resolve
  GROUP BY id
) agg
WHERE t.id = agg.id
  AND t.required_material_ids IS DISTINCT FROM agg.ids;

-- Templates with no materials at all get an explicit empty array.
UPDATE public.syllabus_templates
SET required_material_ids = '[]'::jsonb
WHERE jsonb_typeof(required_material_ids) IS DISTINCT FROM 'array'
   OR (id NOT IN (SELECT id FROM _syllabus_material_resolve)
       AND required_material_ids <> '[]'::jsonb);


-- ── 5. Verification ──────────────────────────────────────────────────────────
-- Row 1 is the summary. Every row after it is a syllabus item that could NOT
-- be linked — those appear in Program Cost with no price and are named in the
-- unlinked-items banner until someone adds them to Required Tools & Materials
-- or renames them to match. Non-archived templates are listed first because
-- those are the ones Program Cost actually reads.
SELECT * FROM (
  SELECT
    0                                              AS sort_order,
    'SUMMARY'                                      AS scope,
    NULL::text                                     AS course_id,
    NULL::text                                     AS semester,
    NULL::text                                     AS template_status,
    NULL::int                                      AS item_index,
    NULL::text                                     AS syllabus_item,
    format('%s of %s material entries linked · %s unresolved · %s unresolved on non-archived syllabi',
           count(tool_id), count(*), count(*) - count(tool_id),
           count(*) FILTER (WHERE tool_id IS NULL AND status <> 'archived')) AS detail
  FROM _syllabus_material_resolve

  UNION ALL

  SELECT
    CASE WHEN r.status = 'archived' THEN 2 ELSE 1 END,
    CASE WHEN r.status = 'archived' THEN 'UNLINKED (archived)' ELSE 'UNLINKED' END,
    r.course_id,
    r.semester,
    r.status,
    r.item_index,
    r.raw_item,
    'No catalog match — excluded from Program Cost totals until linked'
  FROM _syllabus_material_resolve r
  WHERE r.tool_id IS NULL
) v
ORDER BY sort_order, course_id, semester, item_index;

ROLLBACK;
-- COMMIT;

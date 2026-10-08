-- ═══════════════════════════════════════════════════════════════════════════
-- 20261008_metrics_report_rename.sql
--
-- Renames the "Accountability Report" to "Metrics Report" in the database.
-- Students read "Accountability" as grading; the page is a shared look at how
-- a student is doing, not a grade input.
--
-- What it changes (names and wording only — no data, no permission values):
--   1. permissions.page 'Accountability Report' → 'Metrics Report' (5 rows),
--      and the wording of their descriptions. Every role's true/false value
--      is left exactly as it is.
--   2. temp_access_requests.approved_permissions: any grant entry for page
--      'Accountability Report' now says 'Metrics Report', so an active temp
--      grant keeps working.
--   3. settings.category 'Accountability Report' → 'Metrics Report' (the 12
--      report/alert settings), and the two descriptions that name the report.
--
-- NOT renamed on purpose (internal, never shown to users): the
-- accountability_alerts table and the accountability_* setting keys.
--
-- Order: safe either way. The app code checks the new page name first and
-- falls back to the old one while the old rows still exist.
--
-- Re-runnable: every step only touches rows that still carry the old name.
-- Ends in ROLLBACK — check the verification rows, then swap for COMMIT.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Guard: refuse to create a duplicate (page, feature) if both names exist
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.permissions a
      JOIN public.permissions b ON b.feature = a.feature
     WHERE a.page = 'Accountability Report'
       AND b.page = 'Metrics Report'
  ) THEN
    RAISE EXCEPTION 'Both "Accountability Report" and "Metrics Report" permission rows exist for the same feature. Resolve by hand before running this migration.';
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 1: permissions
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE public.permissions
   SET page        = 'Metrics Report',
       description = replace(description, 'Accountability Report', 'Metrics Report'),
       updated_at  = now(),
       updated_by  = 'migration 20261008'
 WHERE page = 'Accountability Report';

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 2: temp permission grants
-- approved_permissions is a JSON array of {page, feature}. Rebuilt element by
-- element (order kept) and cast back to whatever type the column is.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_type text;
BEGIN
  SELECT format_type(a.atttypid, a.atttypmod)
    INTO v_type
    FROM pg_attribute a
   WHERE a.attrelid = 'public.temp_access_requests'::regclass
     AND a.attname = 'approved_permissions'
     AND NOT a.attisdropped;

  IF v_type IS NULL THEN
    RAISE NOTICE 'temp_access_requests.approved_permissions not found — skipped.';
    RETURN;
  END IF;

  IF v_type NOT IN ('jsonb', 'json') THEN
    RAISE NOTICE 'temp_access_requests.approved_permissions is %, not json/jsonb — skipped; check by hand.', v_type;
    RETURN;
  END IF;

  EXECUTE format($sql$
    UPDATE public.temp_access_requests t
       SET approved_permissions = (
             SELECT jsonb_agg(
                      CASE WHEN e ->> 'page' = 'Accountability Report'
                           THEN jsonb_set(e, '{page}', '"Metrics Report"'::jsonb)
                           ELSE e END
                      ORDER BY ord)
               FROM jsonb_array_elements(to_jsonb(t.approved_permissions)) WITH ORDINALITY AS x(e, ord)
           )::%s
     WHERE jsonb_typeof(to_jsonb(t.approved_permissions)) = 'array'
       AND to_jsonb(t.approved_permissions) @> '[{"page":"Accountability Report"}]'::jsonb
  $sql$, v_type);
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 3: settings
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE public.settings
   SET category    = 'Metrics Report',
       description = replace(description, 'Accountability Report', 'Metrics Report')
 WHERE category = 'Accountability Report';

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification (single result set — the SQL Editor shows only the last statement)
--
-- Expect:
--   permission      → 5 rows for 'Metrics Report', role values unchanged
--   old permission  → 0
--   old temp grant  → 0
--   setting         → 12 rows in category 'Metrics Report'
--   old setting     → 0
--   function body   → 0 (no database function refers to the old page name)
-- ─────────────────────────────────────────────────────────────────────────────
SELECT 'permission' AS kind, permission_id || ' ' || feature AS name,
       'student=' || student::text || ' ws=' || work_study::text || ' instr=' || instructor::text AS detail
  FROM public.permissions WHERE page = 'Metrics Report'
UNION ALL
SELECT 'old permission', 'rows still named Accountability Report', count(*)::text
  FROM public.permissions WHERE page = 'Accountability Report'
UNION ALL
SELECT 'old temp grant', 'grants still naming Accountability Report', count(*)::text
  FROM public.temp_access_requests
 WHERE to_jsonb(approved_permissions) @> '[{"page":"Accountability Report"}]'::jsonb
UNION ALL
SELECT 'setting', setting_key, setting_value
  FROM public.settings WHERE category = 'Metrics Report'
UNION ALL
SELECT 'old setting', 'settings still in Accountability Report', count(*)::text
  FROM public.settings WHERE category = 'Accountability Report'
UNION ALL
SELECT 'function body', 'functions mentioning Accountability Report', count(*)::text
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname IN ('public', 'private')
   AND p.prosrc ILIKE '%Accountability Report%'
ORDER BY 1, 2;

ROLLBACK;   -- ← swap for COMMIT after checking the verification output

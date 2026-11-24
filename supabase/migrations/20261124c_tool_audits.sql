-- ============================================================================
-- 2026-11-24  Tool inventory, stage 3: tool count audits
-- ============================================================================
-- An audit is one count of the tools (all of them, or one location), usually
-- at the end of a term. Instructors only.
--
--   tool_audits        one row per audit (TA-0001 ...): name, term, location,
--                      status Open -> Completed (or Cancelled), who and when,
--                      and when its results were applied to inventory.
--   tool_audit_lines   one row per tool in the audit. Holds a snapshot of what
--                      the inventory said when the audit started (expected)
--                      and what was counted (counted / worn / broken / note).
--
-- Flow
--   start_tool_audit()  snapshots the active tools into lines.
--   The page saves each line as it is counted (only while the audit is Open).
--   The page marks the audit Completed -> the shortage report.
--   apply_tool_audit()  writes the counts back to inventory, once:
--       counted <= owned : missing = owned - counted
--       counted >  owned : owned is raised to counted, missing = 0
--       worn / broken    : as counted
--     Tools that were not counted are left exactly as they were.
--
-- Timestamps here (started_at, completed_at, applied_at, counted_at) are REAL
-- UTC (Convention B in TIMESTAMP_CONVENTIONS.md): they are set by now() and
-- shown with toLocaleString(), never read with getUTC*().
--
-- Permission: new Inventory -> run_tool_audit (instructors only). Every read
-- and write of both tables, and both functions, require it.
--
-- Needs stages 1 and 2 committed first.
--
-- HOW TO RUN
--   Dry run first: run as is (ends in ROLLBACK), check every "ok" is true.
--   Then change the last lines to COMMIT and run again. COMMIT before testing
--   or pushing the Stage 3 code.
-- ============================================================================

BEGIN;

DO $$
BEGIN
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'inventory'
         AND column_name IN ('item_type', 'qty_worn', 'qty_broken', 'qty_missing')) < 4 THEN
    RAISE EXCEPTION 'Stages 1 and 2 are not both committed yet (inventory.item_type / qty_worn / qty_broken / qty_missing). Commit those first.';
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Tables
-- ─────────────────────────────────────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS public.tool_audit_id_seq START WITH 1 INCREMENT BY 1;

CREATE TABLE IF NOT EXISTS public.tool_audits (
  audit_id         text PRIMARY KEY,
  name             text NOT NULL,
  term             text NOT NULL DEFAULT '',          -- term name, e.g. 'Fall 2026' ('' = none)
  location         text NOT NULL DEFAULT '',          -- '' = all locations
  status           text NOT NULL DEFAULT 'Open'
                   CHECK (status IN ('Open', 'Completed', 'Cancelled')),
  notes            text NOT NULL DEFAULT '',
  started_at       timestamptz NOT NULL DEFAULT now(),
  started_by       text NOT NULL DEFAULT '',
  started_by_email text NOT NULL DEFAULT '',
  completed_at     timestamptz,
  completed_by     text,
  applied_at       timestamptz,
  applied_by       text
);

CREATE TABLE IF NOT EXISTS public.tool_audit_lines (
  line_id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  audit_id         text NOT NULL REFERENCES public.tool_audits(audit_id) ON DELETE CASCADE,
  part_id          text NOT NULL,                     -- the tool's ID (TL-0001). No FK: the history
                                                      -- must survive a tool being deleted later.
  part_name        text NOT NULL DEFAULT '',          -- snapshot
  location         text NOT NULL DEFAULT '',          -- snapshot
  expected_qty     integer NOT NULL DEFAULT 0,        -- total owned when the audit started
  expected_worn    integer NOT NULL DEFAULT 0,
  expected_broken  integer NOT NULL DEFAULT 0,
  expected_missing integer NOT NULL DEFAULT 0,
  counted_qty      integer CHECK (counted_qty IS NULL OR counted_qty >= 0),   -- NULL = not counted yet
  counted_worn     integer NOT NULL DEFAULT 0 CHECK (counted_worn >= 0),
  counted_broken   integer NOT NULL DEFAULT 0 CHECK (counted_broken >= 0),
  note             text NOT NULL DEFAULT '',
  counted_at       timestamptz,
  counted_by       text,
  UNIQUE (audit_id, part_id)
);

CREATE INDEX IF NOT EXISTS tool_audit_lines_audit_idx ON public.tool_audit_lines (audit_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Permission: Inventory -> run_tool_audit (ID matches AccessPage.jsx)
-- ─────────────────────────────────────────────────────────────────────────────
-- The ID is PTA1 (not the next P-number): the first dry run showed P182 is
-- already used in the live permissions table by a row the code's list does not
-- have, so a named ID is used, as the Suggestion Box did with PSB1-PSB4.
INSERT INTO public.permissions
  (permission_id, page, feature, student, work_study, instructor, description, updated_at, updated_by)
SELECT 'PTA1', 'Inventory', 'run_tool_audit', false, false, true,
       'Can run tool count audits and apply their results to the tool inventory', now(), 'migration'
 WHERE NOT EXISTS (SELECT 1 FROM public.permissions x WHERE x.page = 'Inventory' AND x.feature = 'run_tool_audit');

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Functions
-- ─────────────────────────────────────────────────────────────────────────────

-- Start an audit: one line per active tool (optionally one location only).
CREATE OR REPLACE FUNCTION public.start_tool_audit(p_name text, p_term text, p_location text, p_by text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id    text;
  v_loc   text := btrim(coalesce(p_location, ''));
  v_name  text := btrim(coalesce(p_name, ''));
  v_lines integer;
BEGIN
  IF NOT public.has_perm('Inventory', 'run_tool_audit') THEN
    RAISE EXCEPTION 'You do not have permission to run tool audits.' USING ERRCODE = '42501';
  END IF;
  IF v_name = '' THEN
    RAISE EXCEPTION 'Give the audit a name.';
  END IF;

  LOOP
    v_id := 'TA-' || lpad(nextval('public.tool_audit_id_seq')::text, 4, '0');
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.tool_audits WHERE audit_id = v_id);
  END LOOP;

  INSERT INTO public.tool_audits (audit_id, name, term, location, started_by, started_by_email)
  VALUES (v_id, v_name, btrim(coalesce(p_term, '')), v_loc, btrim(coalesce(p_by, '')),
          lower(coalesce(auth.jwt() ->> 'email', '')));

  -- qty_in_stock is read through text so this works whatever numeric type the column is.
  INSERT INTO public.tool_audit_lines
    (audit_id, part_id, part_name, location, expected_qty, expected_worn, expected_broken, expected_missing)
  SELECT v_id, i.part_id, coalesce(i.part_name, ''), coalesce(i.location, ''),
         greatest(0, floor(coalesce(nullif(i.qty_in_stock::text, '')::numeric, 0)))::integer,
         i.qty_worn, i.qty_broken, i.qty_missing
    FROM public.inventory i
   WHERE i.item_type = 'Tool'
     AND coalesce(i.status, 'Active') = 'Active'
     AND (v_loc = '' OR coalesce(i.location, '') = v_loc);

  GET DIAGNOSTICS v_lines = ROW_COUNT;
  IF v_lines = 0 THEN
    RAISE EXCEPTION 'There are no active tools %to count.',
      CASE WHEN v_loc = '' THEN '' ELSE 'at ' || v_loc || ' ' END;
  END IF;

  RETURN v_id;
END;
$$;

-- Apply a completed audit to the tool inventory. Runs once per audit.
-- Returns how many tools were updated.
CREATE OR REPLACE FUNCTION public.apply_tool_audit(p_audit_id text, p_by text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_audit   public.tool_audits%ROWTYPE;
  v_line    record;
  v_owned   integer;
  v_worn    integer;
  v_broken  integer;
  v_missing integer;
  v_done    integer := 0;
  v_by      text := btrim(coalesce(p_by, ''));
BEGIN
  IF NOT public.has_perm('Inventory', 'run_tool_audit') THEN
    RAISE EXCEPTION 'You do not have permission to apply tool audits.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_audit FROM public.tool_audits WHERE audit_id = p_audit_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Audit % was not found.', p_audit_id;
  END IF;
  IF v_audit.applied_at IS NOT NULL THEN
    RAISE EXCEPTION 'This audit was already applied to inventory.';
  END IF;
  IF v_audit.status <> 'Completed' THEN
    RAISE EXCEPTION 'Finish the count before applying it (the audit is %).', v_audit.status;
  END IF;

  FOR v_line IN
    SELECT l.part_id, l.counted_qty, l.counted_worn, l.counted_broken,
           greatest(0, floor(coalesce(nullif(i.qty_in_stock::text, '')::numeric, 0)))::integer AS owned_now
      FROM public.tool_audit_lines l
      JOIN public.inventory i ON i.part_id = l.part_id AND i.item_type = 'Tool'
     WHERE l.audit_id = p_audit_id
       AND l.counted_qty IS NOT NULL            -- tools nobody counted are left alone
     FOR UPDATE OF i
  LOOP
    -- More on the shelf than the record says: the record was low, so raise it.
    v_owned   := greatest(v_line.owned_now, v_line.counted_qty);
    v_missing := v_owned - v_line.counted_qty;
    -- Worn and broken are among the ones counted; keep them inside that number.
    v_worn    := least(v_line.counted_worn, v_line.counted_qty);
    v_broken  := least(v_line.counted_broken, v_line.counted_qty - v_worn);

    UPDATE public.inventory
       SET qty_in_stock = v_owned,
           qty_worn     = v_worn,
           qty_broken   = v_broken,
           qty_missing  = v_missing,
           updated_at   = now(),
           updated_by   = coalesce(nullif(v_by, ''), 'Tool audit')
     WHERE part_id = v_line.part_id;
    v_done := v_done + 1;
  END LOOP;

  UPDATE public.tool_audits
     SET applied_at = now(), applied_by = nullif(v_by, '')
   WHERE audit_id = p_audit_id;

  RETURN v_done;
END;
$$;

REVOKE ALL ON FUNCTION public.start_tool_audit(text, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.apply_tool_audit(text, text)             FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_tool_audit(text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_tool_audit(text, text)             TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Row rules: everything needs Inventory -> run_tool_audit
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.tool_audits      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tool_audit_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tool_audits_select ON public.tool_audits;
CREATE POLICY tool_audits_select
  ON public.tool_audits FOR SELECT TO authenticated
  USING (public.has_perm('Inventory', 'run_tool_audit'));

-- Audits are created only by start_tool_audit(). The page may change an audit
-- (finish, reopen, cancel, notes) until its results have been applied; after
-- that it is a fixed record.
DROP POLICY IF EXISTS tool_audits_update ON public.tool_audits;
CREATE POLICY tool_audits_update
  ON public.tool_audits FOR UPDATE TO authenticated
  USING (public.has_perm('Inventory', 'run_tool_audit') AND applied_at IS NULL)
  WITH CHECK (public.has_perm('Inventory', 'run_tool_audit') AND applied_at IS NULL);

DROP POLICY IF EXISTS tool_audit_lines_select ON public.tool_audit_lines;
CREATE POLICY tool_audit_lines_select
  ON public.tool_audit_lines FOR SELECT TO authenticated
  USING (public.has_perm('Inventory', 'run_tool_audit'));

-- Counts can be saved only while the audit is still Open.
DROP POLICY IF EXISTS tool_audit_lines_update ON public.tool_audit_lines;
CREATE POLICY tool_audit_lines_update
  ON public.tool_audit_lines FOR UPDATE TO authenticated
  USING (public.has_perm('Inventory', 'run_tool_audit')
         AND EXISTS (SELECT 1 FROM public.tool_audits a
                      WHERE a.audit_id = tool_audit_lines.audit_id AND a.status = 'Open'))
  WITH CHECK (public.has_perm('Inventory', 'run_tool_audit'));

REVOKE ALL ON public.tool_audits, public.tool_audit_lines FROM anon;
REVOKE ALL ON public.tool_audits, public.tool_audit_lines FROM authenticated;
GRANT SELECT, UPDATE ON public.tool_audits, public.tool_audit_lines TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Verification (one result grid; every "ok" should be true)
-- ─────────────────────────────────────────────────────────────────────────────
SELECT n, check_name, ok, detail FROM (
  SELECT 1 AS n, 'both audit tables exist' AS check_name,
         to_regclass('public.tool_audits') IS NOT NULL
           AND to_regclass('public.tool_audit_lines') IS NOT NULL AS ok,
         NULL::text AS detail
  UNION ALL
  SELECT 2, 'row rules are on for both tables',
         (SELECT bool_and(relrowsecurity) FROM pg_class
           WHERE oid IN ('public.tool_audits'::regclass, 'public.tool_audit_lines'::regclass)),
         (SELECT count(*)::text || ' policies' FROM pg_policies
           WHERE schemaname = 'public' AND tablename IN ('tool_audits', 'tool_audit_lines'))
  UNION ALL
  SELECT 3, 'permission run_tool_audit: instructors only',
         EXISTS (SELECT 1 FROM public.permissions
                  WHERE page = 'Inventory' AND feature = 'run_tool_audit'
                    AND lower(instructor::text) IN ('true', 't', 'yes')
                    AND lower(student::text) NOT IN ('true', 't', 'yes')
                    AND lower(work_study::text) NOT IN ('true', 't', 'yes')),
         (SELECT 'ID ' || permission_id FROM public.permissions
           WHERE page = 'Inventory' AND feature = 'run_tool_audit')
  UNION ALL
  SELECT 10, 'INFO: what already uses permission ID P182 in the database', true,
         coalesce((SELECT page || ' -> ' || feature FROM public.permissions WHERE permission_id = 'P182'), 'nothing')
  UNION ALL
  SELECT 4, 'signed-in users can call the two functions (permission is checked inside)',
         has_function_privilege('authenticated', 'public.start_tool_audit(text, text, text, text)', 'EXECUTE')
           AND has_function_privilege('authenticated', 'public.apply_tool_audit(text, text)', 'EXECUTE'), NULL
  UNION ALL
  SELECT 5, 'logged-out visitors cannot call them or read the tables',
         NOT has_function_privilege('anon', 'public.start_tool_audit(text, text, text, text)', 'EXECUTE')
           AND NOT has_function_privilege('anon', 'public.apply_tool_audit(text, text)', 'EXECUTE')
           AND NOT has_table_privilege('anon', 'public.tool_audits', 'SELECT')
           AND NOT has_table_privilege('anon', 'public.tool_audit_lines', 'SELECT'), NULL
  UNION ALL
  SELECT 6, 'the page cannot insert or delete audit rows directly',
         NOT has_table_privilege('authenticated', 'public.tool_audits', 'INSERT')
           AND NOT has_table_privilege('authenticated', 'public.tool_audits', 'DELETE')
           AND NOT has_table_privilege('authenticated', 'public.tool_audit_lines', 'INSERT')
           AND NOT has_table_privilege('authenticated', 'public.tool_audit_lines', 'DELETE'), NULL
  UNION ALL
  SELECT 7, 'first audit ID will be TA-0001',
         (SELECT NOT is_called AND last_value = 1 FROM public.tool_audit_id_seq),
         'TA-' || lpad((SELECT last_value FROM public.tool_audit_id_seq)::text, 4, '0')
  UNION ALL
  SELECT 8, 'INFO: active tools an audit would list right now', true,
         (SELECT count(*)::text || ' tools' FROM public.inventory
           WHERE item_type = 'Tool' AND coalesce(status, 'Active') = 'Active')
  UNION ALL
  SELECT 9, 'INFO: inventory.qty_in_stock column type', true,
         (SELECT data_type FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'inventory' AND column_name = 'qty_in_stock')
) v ORDER BY n;

ROLLBACK;
-- COMMIT;

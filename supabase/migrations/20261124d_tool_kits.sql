-- ============================================================================
-- 2026-11-24  Tool inventory, stage 4: tool kits
-- ============================================================================
-- A kit is a fixed set of tools kept together in one place: a student bench,
-- a toolbox. The benches are supposed to be identical, so the tool list is
-- kept ONCE on a "kit type" and every kit of that type shares it.
--
--   tool_kit_types       KT-0001 ...  e.g. "Student bench" (name, notes, status)
--   tool_kit_type_items  the tool list of a type: tool + how many per kit
--   tool_kits            TK-0001 ...  e.g. "Bench 3": its type, its own
--                        location, status, when it was last checked
--   tool_kit_holdings    what the last check found in ONE kit, per tool:
--                        how many of its share are missing / worn / broken.
--                        Written only by apply_tool_audit().
--
-- How kits fit the tool totals (decided 2026-11-24)
--   * Kit tools are PART OF the tool's total. 8 screwdrivers owned with 1 on
--     each of 4 benches = 4 in kits + 4 in general stock.
--   * A kit has its own location. A general tool audit (all locations, or one
--     location) therefore expects only the general stock: owned minus what is
--     assigned to active kits. Kits are checked one at a time ("kit check").
--   * A kit check is a tool audit scoped to one kit (tool_audits.kit_id). It
--     records counted / worn / broken like the full audit.
--   * inventory.qty_worn / qty_broken / qty_missing stay the tool's TOTALS:
--     general stock + every kit. Applying an audit replaces only the part it
--     covered, so a general audit and a kit check never double-count.
--
-- Replaces start_tool_audit() and apply_tool_audit() from stage 3 with
-- kit-aware versions. With no kits they behave exactly as before.
--
-- Permissions (Inventory page)
--   manage_tool_kits (new, instructors only) — create and change kit types
--                    and kits.
--   run_tool_audit   (stage 3) — check a kit, as for any audit.
--   view_tool_kits   (new, everyone) — READ the kit types, their tool lists
--                    and the kits, so a student can see what belongs on a
--                    bench. It does not show what a check found: the
--                    tool_kit_holdings table and the audits stay limited to
--                    manage_tool_kits / run_tool_audit.
--
-- Timestamps here are REAL UTC (Convention B in TIMESTAMP_CONVENTIONS.md).
--
-- Needs stages 1-3 committed first.
--
-- HOW TO RUN
--   Dry run first: run as is (ends in ROLLBACK), check every "ok" is true.
--   Then change the last lines to COMMIT and run again. COMMIT before testing
--   or pushing the Stage 4 code.
-- ============================================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.tool_audits') IS NULL OR to_regclass('public.tool_audit_lines') IS NULL THEN
    RAISE EXCEPTION 'Stage 3 is not committed yet (tool_audits is missing). Commit 20261124c_tool_audits.sql first.';
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Tables
-- ─────────────────────────────────────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS public.tool_kit_type_id_seq START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS public.tool_kit_id_seq      START WITH 1 INCREMENT BY 1;

CREATE TABLE IF NOT EXISTS public.tool_kit_types (
  type_id    text PRIMARY KEY,
  name       text NOT NULL,
  notes      text NOT NULL DEFAULT '',
  status     text NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS public.tool_kit_type_items (
  type_id text NOT NULL REFERENCES public.tool_kit_types(type_id) ON DELETE CASCADE,
  part_id text NOT NULL,                      -- the tool's ID (TL-0001)
  qty     integer NOT NULL DEFAULT 1 CHECK (qty > 0),   -- how many of this tool in EACH kit
  PRIMARY KEY (type_id, part_id)
);

CREATE TABLE IF NOT EXISTS public.tool_kits (
  kit_id          text PRIMARY KEY,
  type_id         text NOT NULL REFERENCES public.tool_kit_types(type_id) ON DELETE CASCADE,
  name            text NOT NULL,
  location        text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive')),
  notes           text NOT NULL DEFAULT '',
  last_checked_at timestamptz,
  last_checked_by text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS tool_kits_type_idx ON public.tool_kits (type_id);

CREATE TABLE IF NOT EXISTS public.tool_kit_holdings (
  kit_id      text NOT NULL REFERENCES public.tool_kits(kit_id) ON DELETE CASCADE,
  part_id     text NOT NULL,
  qty_missing integer NOT NULL DEFAULT 0 CHECK (qty_missing >= 0),
  qty_worn    integer NOT NULL DEFAULT 0 CHECK (qty_worn >= 0),
  qty_broken  integer NOT NULL DEFAULT 0 CHECK (qty_broken >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kit_id, part_id)
);

-- A kit check is an audit of one kit. No FK: the audit history must survive
-- the kit being deleted later, so the kit's name is kept on the audit too.
ALTER TABLE public.tool_audits
  ADD COLUMN IF NOT EXISTS kit_id   text,
  ADD COLUMN IF NOT EXISTS kit_name text NOT NULL DEFAULT '';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Permission: Inventory -> manage_tool_kits (ID matches AccessPage.jsx)
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO public.permissions
  (permission_id, page, feature, student, work_study, instructor, description, updated_at, updated_by)
SELECT 'PTK1', 'Inventory', 'manage_tool_kits', false, false, true,
       'Can create and change tool kits (benches, toolboxes) and their tool lists', now(), 'migration'
 WHERE NOT EXISTS (SELECT 1 FROM public.permissions x WHERE x.page = 'Inventory' AND x.feature = 'manage_tool_kits');

INSERT INTO public.permissions
  (permission_id, page, feature, student, work_study, instructor, description, updated_at, updated_by)
SELECT 'PTK2', 'Inventory', 'view_tool_kits', true, true, true,
       'Can see which tools belong in each tool kit (bench, toolbox) - read only', now(), 'migration'
 WHERE NOT EXISTS (SELECT 1 FROM public.permissions x WHERE x.page = 'Inventory' AND x.feature = 'view_tool_kits');

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Kit functions
-- ─────────────────────────────────────────────────────────────────────────────

-- May the caller read the kit lists (types, tool lists, kits)? Staff, or
-- anyone with the read-only view_tool_kits permission.
CREATE OR REPLACE FUNCTION public.tool_kits_can_read()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.has_perm('Inventory', 'manage_tool_kits')
      OR public.has_perm('Inventory', 'run_tool_audit')
      OR public.has_perm('Inventory', 'view_tool_kits');
$$;

-- May the caller see what kit checks FOUND (missing / worn / broken)?
-- Staff only: managing kits, or auditing them.
CREATE OR REPLACE FUNCTION public.tool_kits_can_view()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.has_perm('Inventory', 'manage_tool_kits') OR public.has_perm('Inventory', 'run_tool_audit');
$$;

-- New kit type. Returns its ID (KT-0001 ...).
CREATE OR REPLACE FUNCTION public.create_tool_kit_type(p_name text, p_notes text, p_by text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id   text;
  v_name text := btrim(coalesce(p_name, ''));
BEGIN
  IF NOT public.has_perm('Inventory', 'manage_tool_kits') THEN
    RAISE EXCEPTION 'You do not have permission to manage tool kits.' USING ERRCODE = '42501';
  END IF;
  IF v_name = '' THEN
    RAISE EXCEPTION 'Give the kit type a name.';
  END IF;
  LOOP
    v_id := 'KT-' || lpad(nextval('public.tool_kit_type_id_seq')::text, 4, '0');
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.tool_kit_types WHERE type_id = v_id);
  END LOOP;
  INSERT INTO public.tool_kit_types (type_id, name, notes, created_by, updated_by)
  VALUES (v_id, v_name, btrim(coalesce(p_notes, '')), btrim(coalesce(p_by, '')), btrim(coalesce(p_by, '')));
  RETURN v_id;
END;
$$;

-- Add one or more kits of a type in one go ("Bench 1" ... "Bench 8").
-- p_locations lines up with p_names; a blank location falls back to the name.
-- Returns how many kits were made.
CREATE OR REPLACE FUNCTION public.create_tool_kits(p_type_id text, p_names text[], p_locations text[], p_by text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id   text;
  v_name text;
  v_loc  text;
  v_n    integer := 0;
  i      integer;
BEGIN
  IF NOT public.has_perm('Inventory', 'manage_tool_kits') THEN
    RAISE EXCEPTION 'You do not have permission to manage tool kits.' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tool_kit_types WHERE type_id = p_type_id) THEN
    RAISE EXCEPTION 'Kit type % was not found.', p_type_id;
  END IF;
  IF coalesce(array_length(p_names, 1), 0) = 0 THEN
    RAISE EXCEPTION 'No kit names were given.';
  END IF;
  IF array_length(p_names, 1) > 100 THEN
    RAISE EXCEPTION 'Add at most 100 kits at a time.';
  END IF;

  FOR i IN 1 .. array_length(p_names, 1) LOOP
    v_name := btrim(coalesce(p_names[i], ''));
    CONTINUE WHEN v_name = '';
    IF EXISTS (SELECT 1 FROM public.tool_kits WHERE type_id = p_type_id AND lower(name) = lower(v_name)) THEN
      RAISE EXCEPTION 'A kit named "%" already exists in this kit type.', v_name;
    END IF;
    v_loc := btrim(coalesce(p_locations[i], ''));
    LOOP
      v_id := 'TK-' || lpad(nextval('public.tool_kit_id_seq')::text, 4, '0');
      EXIT WHEN NOT EXISTS (SELECT 1 FROM public.tool_kits WHERE kit_id = v_id);
    END LOOP;
    INSERT INTO public.tool_kits (kit_id, type_id, name, location, created_by)
    VALUES (v_id, p_type_id, v_name, CASE WHEN v_loc = '' THEN v_name ELSE v_loc END, btrim(coalesce(p_by, '')));
    v_n := v_n + 1;
  END LOOP;

  IF v_n = 0 THEN
    RAISE EXCEPTION 'No kit names were given.';
  END IF;
  RETURN v_n;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Audit functions (replace the stage 3 versions; kit-aware)
-- ─────────────────────────────────────────────────────────────────────────────

-- How many of a tool are assigned to ACTIVE kits of ACTIVE kit types.
CREATE OR REPLACE FUNCTION private.tool_qty_in_kits(p_part_id text)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(sum(ti.qty), 0)::integer
    FROM public.tool_kit_type_items ti
    JOIN public.tool_kit_types t ON t.type_id = ti.type_id AND t.status = 'Active'
    JOIN public.tool_kits k      ON k.type_id = ti.type_id AND k.status = 'Active'
   WHERE ti.part_id = p_part_id;
$$;

-- General tool audit: the general stock only (owned minus what kits hold).
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

  -- Expected = general stock. A tool whose whole quantity sits in kits is left
  -- off the list (there is nothing of it to find in general stock).
  INSERT INTO public.tool_audit_lines
    (audit_id, part_id, part_name, location, expected_qty, expected_worn, expected_broken, expected_missing)
  SELECT v_id, x.part_id, x.part_name, x.location, greatest(0, x.owned - x.in_kits),
         x.qty_worn, x.qty_broken, x.qty_missing
    FROM (
      SELECT i.part_id, coalesce(i.part_name, '') AS part_name, coalesce(i.location, '') AS location,
             greatest(0, floor(coalesce(nullif(i.qty_in_stock::text, '')::numeric, 0)))::integer AS owned,
             private.tool_qty_in_kits(i.part_id) AS in_kits,
             i.qty_worn, i.qty_broken, i.qty_missing
        FROM public.inventory i
       WHERE i.item_type = 'Tool'
         AND coalesce(i.status, 'Active') = 'Active'
         AND (v_loc = '' OR coalesce(i.location, '') = v_loc)
    ) x
   WHERE x.in_kits = 0 OR x.owned > x.in_kits;

  GET DIAGNOSTICS v_lines = ROW_COUNT;
  IF v_lines = 0 THEN
    RAISE EXCEPTION 'There are no active tools %to count.',
      CASE WHEN v_loc = '' THEN '' ELSE 'at ' || v_loc || ' ' END;
  END IF;

  RETURN v_id;
END;
$$;

-- Kit check: an audit of one kit. Expected = the kit type's tool list.
CREATE OR REPLACE FUNCTION public.start_tool_kit_check(p_kit_id text, p_name text, p_term text, p_by text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_kit   public.tool_kits%ROWTYPE;
  v_open  text;
  v_id    text;
  v_name  text := btrim(coalesce(p_name, ''));
  v_lines integer;
BEGIN
  IF NOT public.has_perm('Inventory', 'run_tool_audit') THEN
    RAISE EXCEPTION 'You do not have permission to run tool audits.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_kit FROM public.tool_kits WHERE kit_id = p_kit_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Kit % was not found.', p_kit_id;
  END IF;
  IF v_kit.status <> 'Active' THEN
    RAISE EXCEPTION 'Kit "%" is inactive. Make it active before checking it.', v_kit.name;
  END IF;
  SELECT audit_id INTO v_open FROM public.tool_audits
   WHERE kit_id = p_kit_id AND status = 'Open' LIMIT 1;
  IF v_open IS NOT NULL THEN
    RAISE EXCEPTION 'Kit "%" already has a check in progress (%). Continue or cancel that one first.', v_kit.name, v_open;
  END IF;

  LOOP
    v_id := 'TA-' || lpad(nextval('public.tool_audit_id_seq')::text, 4, '0');
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.tool_audits WHERE audit_id = v_id);
  END LOOP;

  INSERT INTO public.tool_audits (audit_id, name, term, location, kit_id, kit_name, started_by, started_by_email)
  VALUES (v_id, CASE WHEN v_name = '' THEN v_kit.name || ' check' ELSE v_name END,
          btrim(coalesce(p_term, '')), v_kit.location, v_kit.kit_id, v_kit.name,
          btrim(coalesce(p_by, '')), lower(coalesce(auth.jwt() ->> 'email', '')));

  INSERT INTO public.tool_audit_lines
    (audit_id, part_id, part_name, location, expected_qty, expected_worn, expected_broken, expected_missing)
  SELECT v_id, ti.part_id, coalesce(i.part_name, ti.part_id), v_kit.location, ti.qty,
         coalesce(h.qty_worn, 0), coalesce(h.qty_broken, 0), coalesce(h.qty_missing, 0)
    FROM public.tool_kit_type_items ti
    LEFT JOIN public.inventory i ON i.part_id = ti.part_id
    LEFT JOIN public.tool_kit_holdings h ON h.kit_id = v_kit.kit_id AND h.part_id = ti.part_id
   WHERE ti.type_id = v_kit.type_id;

  GET DIAGNOSTICS v_lines = ROW_COUNT;
  IF v_lines = 0 THEN
    RAISE EXCEPTION 'Kit "%" has no tools on its list yet. Add tools to its kit type first.', v_kit.name;
  END IF;

  RETURN v_id;
END;
$$;

-- Apply a completed audit to the tool inventory. Runs once per audit.
-- Returns how many tools were updated.
--
-- The inventory row keeps TOTALS (general stock + all kits). Each audit only
-- replaces the part it covered:
--   general audit : totals = what was just counted in general stock
--                            + what the kits' last checks recorded
--   kit check     : the kit's record is replaced, and the totals move by the
--                   difference between its old and new record
CREATE OR REPLACE FUNCTION public.apply_tool_audit(p_audit_id text, p_by text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_audit    public.tool_audits%ROWTYPE;
  v_type_id  text;
  v_line     record;
  v_inv      record;
  v_owned    integer;
  v_c        integer;     -- counted (capped at what the scope should hold, for condition maths)
  v_q        integer;     -- what this scope should hold
  v_m        integer;
  v_w        integer;
  v_b        integer;
  v_km       integer;     -- kits' recorded missing / worn / broken for this tool
  v_kw       integer;
  v_kb       integer;
  v_om       integer;     -- this kit's previous record
  v_ow       integer;
  v_ob       integer;
  v_done     integer := 0;
  v_by       text := btrim(coalesce(p_by, ''));
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

  IF v_audit.kit_id IS NOT NULL THEN
    SELECT type_id INTO v_type_id FROM public.tool_kits WHERE kit_id = v_audit.kit_id;
    IF v_type_id IS NULL THEN
      RAISE EXCEPTION 'Kit "%" no longer exists, so this check cannot be applied.', v_audit.kit_name;
    END IF;
  END IF;

  FOR v_line IN
    SELECT l.part_id, l.counted_qty, l.counted_worn, l.counted_broken
      FROM public.tool_audit_lines l
     WHERE l.audit_id = p_audit_id
       AND l.counted_qty IS NOT NULL            -- tools nobody counted are left alone
  LOOP
    SELECT greatest(0, floor(coalesce(nullif(i.qty_in_stock::text, '')::numeric, 0)))::integer AS owned,
           i.qty_worn, i.qty_broken, i.qty_missing
      INTO v_inv
      FROM public.inventory i
     WHERE i.part_id = v_line.part_id AND i.item_type = 'Tool'
       FOR UPDATE;
    CONTINUE WHEN NOT FOUND;                    -- the tool was deleted since the count
    v_owned := v_inv.owned;

    IF v_audit.kit_id IS NULL THEN
      -- ── General audit ──────────────────────────────────────────────────
      SELECT coalesce(sum(h.qty_missing), 0), coalesce(sum(h.qty_worn), 0), coalesce(sum(h.qty_broken), 0)
        INTO v_km, v_kw, v_kb
        FROM public.tool_kit_holdings h
        JOIN public.tool_kits k      ON k.kit_id = h.kit_id AND k.status = 'Active'
        JOIN public.tool_kit_types t ON t.type_id = k.type_id AND t.status = 'Active'
       WHERE h.part_id = v_line.part_id;

      v_q := greatest(0, v_owned - private.tool_qty_in_kits(v_line.part_id));   -- general stock expected
      IF v_line.counted_qty > v_q THEN
        -- More in general stock than the record allows for: the record was low.
        v_owned := v_owned + (v_line.counted_qty - v_q);
        v_m := 0;
      ELSE
        v_m := v_q - v_line.counted_qty;
      END IF;
      v_c := v_line.counted_qty;
      v_w := least(v_line.counted_worn, v_c);
      v_b := least(v_line.counted_broken, v_c - v_w);

      v_m := v_m + v_km;
      v_w := v_w + v_kw;
      v_b := v_b + v_kb;
    ELSE
      -- ── Kit check ──────────────────────────────────────────────────────
      SELECT ti.qty INTO v_q FROM public.tool_kit_type_items ti
       WHERE ti.type_id = v_type_id AND ti.part_id = v_line.part_id;
      CONTINUE WHEN v_q IS NULL;                -- the tool is no longer on this kit's list

      SELECT h.qty_missing, h.qty_worn, h.qty_broken INTO v_om, v_ow, v_ob
        FROM public.tool_kit_holdings h
       WHERE h.kit_id = v_audit.kit_id AND h.part_id = v_line.part_id;
      v_om := coalesce(v_om, 0); v_ow := coalesce(v_ow, 0); v_ob := coalesce(v_ob, 0);

      -- Extras found in a kit don't change what is owned; they just aren't missing.
      v_c  := least(v_line.counted_qty, v_q);
      v_km := v_q - v_c;
      v_kw := least(v_line.counted_worn, v_c);
      v_kb := least(v_line.counted_broken, v_c - v_kw);

      INSERT INTO public.tool_kit_holdings AS h (kit_id, part_id, qty_missing, qty_worn, qty_broken, updated_at)
      VALUES (v_audit.kit_id, v_line.part_id, v_km, v_kw, v_kb, now())
      ON CONFLICT (kit_id, part_id) DO UPDATE
        SET qty_missing = EXCLUDED.qty_missing, qty_worn = EXCLUDED.qty_worn,
            qty_broken = EXCLUDED.qty_broken, updated_at = now();

      v_m := greatest(0, v_inv.qty_missing + v_km - v_om);
      v_w := greatest(0, v_inv.qty_worn    + v_kw - v_ow);
      v_b := greatest(0, v_inv.qty_broken  + v_kb - v_ob);
    END IF;

    -- Never let the three counts add up to more than is owned.
    v_m := least(v_m, v_owned);
    v_w := least(v_w, v_owned - v_m);
    v_b := least(v_b, v_owned - v_m - v_w);

    UPDATE public.inventory
       SET qty_in_stock = v_owned,
           qty_worn     = v_w,
           qty_broken   = v_b,
           qty_missing  = v_m,
           updated_at   = now(),
           updated_by   = coalesce(nullif(v_by, ''), 'Tool audit')
     WHERE part_id = v_line.part_id;
    v_done := v_done + 1;
  END LOOP;

  UPDATE public.tool_audits
     SET applied_at = now(), applied_by = nullif(v_by, '')
   WHERE audit_id = p_audit_id;

  IF v_audit.kit_id IS NOT NULL THEN
    UPDATE public.tool_kits
       SET last_checked_at = now(), last_checked_by = nullif(v_by, '')
     WHERE kit_id = v_audit.kit_id;
  END IF;

  RETURN v_done;
END;
$$;

REVOKE ALL ON FUNCTION private.tool_qty_in_kits(text)                         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tool_kits_can_view()                            FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tool_kits_can_read()                            FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_tool_kit_type(text, text, text)          FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_tool_kits(text, text[], text[], text)    FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.start_tool_audit(text, text, text, text)        FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.start_tool_kit_check(text, text, text, text)    FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.apply_tool_audit(text, text)                    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tool_kits_can_view()                         TO authenticated;
GRANT EXECUTE ON FUNCTION public.tool_kits_can_read()                         TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_tool_kit_type(text, text, text)       TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_tool_kits(text, text[], text[], text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.start_tool_audit(text, text, text, text)     TO authenticated;
GRANT EXECUTE ON FUNCTION public.start_tool_kit_check(text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_tool_audit(text, text)                 TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Row rules
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.tool_kit_types      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tool_kit_type_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tool_kits           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tool_kit_holdings   ENABLE ROW LEVEL SECURITY;

-- Read the lists (what belongs in each kit): staff, or view_tool_kits.
-- Read what a check found (holdings): staff only.
DROP POLICY IF EXISTS tool_kit_types_select ON public.tool_kit_types;
CREATE POLICY tool_kit_types_select ON public.tool_kit_types FOR SELECT TO authenticated
  USING (public.tool_kits_can_read());
DROP POLICY IF EXISTS tool_kit_type_items_select ON public.tool_kit_type_items;
CREATE POLICY tool_kit_type_items_select ON public.tool_kit_type_items FOR SELECT TO authenticated
  USING (public.tool_kits_can_read());
DROP POLICY IF EXISTS tool_kits_select ON public.tool_kits;
CREATE POLICY tool_kits_select ON public.tool_kits FOR SELECT TO authenticated
  USING (public.tool_kits_can_read());
DROP POLICY IF EXISTS tool_kit_holdings_select ON public.tool_kit_holdings;
CREATE POLICY tool_kit_holdings_select ON public.tool_kit_holdings FOR SELECT TO authenticated
  USING (public.tool_kits_can_view());

-- Change: Inventory -> manage_tool_kits. Types and kits are created by the
-- functions above (they hand out the IDs); the page edits and deletes them.
DROP POLICY IF EXISTS tool_kit_types_update ON public.tool_kit_types;
CREATE POLICY tool_kit_types_update ON public.tool_kit_types FOR UPDATE TO authenticated
  USING (public.has_perm('Inventory', 'manage_tool_kits'))
  WITH CHECK (public.has_perm('Inventory', 'manage_tool_kits'));
DROP POLICY IF EXISTS tool_kit_types_delete ON public.tool_kit_types;
CREATE POLICY tool_kit_types_delete ON public.tool_kit_types FOR DELETE TO authenticated
  USING (public.has_perm('Inventory', 'manage_tool_kits'));

DROP POLICY IF EXISTS tool_kit_type_items_insert ON public.tool_kit_type_items;
CREATE POLICY tool_kit_type_items_insert ON public.tool_kit_type_items FOR INSERT TO authenticated
  WITH CHECK (public.has_perm('Inventory', 'manage_tool_kits'));
DROP POLICY IF EXISTS tool_kit_type_items_update ON public.tool_kit_type_items;
CREATE POLICY tool_kit_type_items_update ON public.tool_kit_type_items FOR UPDATE TO authenticated
  USING (public.has_perm('Inventory', 'manage_tool_kits'))
  WITH CHECK (public.has_perm('Inventory', 'manage_tool_kits'));
DROP POLICY IF EXISTS tool_kit_type_items_delete ON public.tool_kit_type_items;
CREATE POLICY tool_kit_type_items_delete ON public.tool_kit_type_items FOR DELETE TO authenticated
  USING (public.has_perm('Inventory', 'manage_tool_kits'));

DROP POLICY IF EXISTS tool_kits_update ON public.tool_kits;
CREATE POLICY tool_kits_update ON public.tool_kits FOR UPDATE TO authenticated
  USING (public.has_perm('Inventory', 'manage_tool_kits'))
  WITH CHECK (public.has_perm('Inventory', 'manage_tool_kits'));
DROP POLICY IF EXISTS tool_kits_delete ON public.tool_kits;
CREATE POLICY tool_kits_delete ON public.tool_kits FOR DELETE TO authenticated
  USING (public.has_perm('Inventory', 'manage_tool_kits'));

REVOKE ALL ON public.tool_kit_types, public.tool_kit_type_items, public.tool_kits, public.tool_kit_holdings FROM anon;
REVOKE ALL ON public.tool_kit_types, public.tool_kit_type_items, public.tool_kits, public.tool_kit_holdings FROM authenticated;
GRANT SELECT, UPDATE, DELETE         ON public.tool_kit_types      TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tool_kit_type_items TO authenticated;
GRANT SELECT, UPDATE, DELETE         ON public.tool_kits           TO authenticated;
GRANT SELECT                         ON public.tool_kit_holdings   TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Verification (one result grid; every "ok" should be true)
-- ─────────────────────────────────────────────────────────────────────────────
SELECT n, check_name, ok, detail FROM (
  SELECT 1 AS n, 'four kit tables exist' AS check_name,
         to_regclass('public.tool_kit_types') IS NOT NULL
           AND to_regclass('public.tool_kit_type_items') IS NOT NULL
           AND to_regclass('public.tool_kits') IS NOT NULL
           AND to_regclass('public.tool_kit_holdings') IS NOT NULL AS ok,
         NULL::text AS detail
  UNION ALL
  SELECT 2, 'row rules are on for all four',
         (SELECT bool_and(relrowsecurity) FROM pg_class
           WHERE oid IN ('public.tool_kit_types'::regclass, 'public.tool_kit_type_items'::regclass,
                         'public.tool_kits'::regclass, 'public.tool_kit_holdings'::regclass)),
         (SELECT count(*)::text || ' policies' FROM pg_policies
           WHERE schemaname = 'public'
             AND tablename IN ('tool_kit_types', 'tool_kit_type_items', 'tool_kits', 'tool_kit_holdings'))
  UNION ALL
  SELECT 3, 'permission manage_tool_kits: instructors only',
         EXISTS (SELECT 1 FROM public.permissions
                  WHERE page = 'Inventory' AND feature = 'manage_tool_kits'
                    AND lower(instructor::text) IN ('true', 't', 'yes')
                    AND lower(student::text) NOT IN ('true', 't', 'yes')
                    AND lower(work_study::text) NOT IN ('true', 't', 'yes')),
         (SELECT 'ID ' || permission_id FROM public.permissions
           WHERE page = 'Inventory' AND feature = 'manage_tool_kits')
  UNION ALL
  SELECT 10, 'permission view_tool_kits: everyone (read only)',
         EXISTS (SELECT 1 FROM public.permissions
                  WHERE page = 'Inventory' AND feature = 'view_tool_kits'
                    AND lower(instructor::text) IN ('true', 't', 'yes')
                    AND lower(student::text) IN ('true', 't', 'yes')
                    AND lower(work_study::text) IN ('true', 't', 'yes')),
         (SELECT 'ID ' || permission_id FROM public.permissions
           WHERE page = 'Inventory' AND feature = 'view_tool_kits')
  UNION ALL
  SELECT 11, 'what a kit check found is readable by staff only',
         (SELECT qual FROM pg_policies WHERE schemaname = 'public' AND tablename = 'tool_kit_holdings'
             AND policyname = 'tool_kit_holdings_select') LIKE '%tool_kits_can_view%'
           AND (SELECT qual FROM pg_policies WHERE schemaname = 'public' AND tablename = 'tool_kits'
             AND policyname = 'tool_kits_select') LIKE '%tool_kits_can_read%', NULL
  UNION ALL
  SELECT 4, 'audits can be tied to a kit',
         (SELECT count(*) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'tool_audits'
             AND column_name IN ('kit_id', 'kit_name')) = 2, NULL
  UNION ALL
  SELECT 5, 'signed-in users can call the kit and audit functions (permission is checked inside)',
         has_function_privilege('authenticated', 'public.create_tool_kit_type(text, text, text)', 'EXECUTE')
           AND has_function_privilege('authenticated', 'public.create_tool_kits(text, text[], text[], text)', 'EXECUTE')
           AND has_function_privilege('authenticated', 'public.start_tool_kit_check(text, text, text, text)', 'EXECUTE')
           AND has_function_privilege('authenticated', 'public.start_tool_audit(text, text, text, text)', 'EXECUTE')
           AND has_function_privilege('authenticated', 'public.apply_tool_audit(text, text)', 'EXECUTE'), NULL
  UNION ALL
  SELECT 6, 'logged-out visitors cannot call them or read the kit tables',
         NOT has_function_privilege('anon', 'public.create_tool_kit_type(text, text, text)', 'EXECUTE')
           AND NOT has_function_privilege('anon', 'public.create_tool_kits(text, text[], text[], text)', 'EXECUTE')
           AND NOT has_function_privilege('anon', 'public.start_tool_kit_check(text, text, text, text)', 'EXECUTE')
           AND NOT has_function_privilege('anon', 'public.apply_tool_audit(text, text)', 'EXECUTE')
           AND NOT has_table_privilege('anon', 'public.tool_kits', 'SELECT')
           AND NOT has_table_privilege('anon', 'public.tool_kit_types', 'SELECT'), NULL
  UNION ALL
  SELECT 7, 'only an applied audit can write what a kit holds',
         NOT has_table_privilege('authenticated', 'public.tool_kit_holdings', 'INSERT')
           AND NOT has_table_privilege('authenticated', 'public.tool_kit_holdings', 'UPDATE')
           AND NOT has_table_privilege('authenticated', 'public.tool_kit_holdings', 'DELETE'), NULL
  UNION ALL
  SELECT 8, 'first IDs will be KT-0001 and TK-0001',
         (SELECT NOT is_called AND last_value = 1 FROM public.tool_kit_type_id_seq)
           AND (SELECT NOT is_called AND last_value = 1 FROM public.tool_kit_id_seq), NULL
  UNION ALL
  SELECT 9, 'INFO: existing audits (unchanged; none are tied to a kit)',
         NOT EXISTS (SELECT 1 FROM public.tool_audits WHERE kit_id IS NOT NULL),
         (SELECT count(*)::text || ' audits' FROM public.tool_audits)
) v ORDER BY n;

ROLLBACK;
-- COMMIT;

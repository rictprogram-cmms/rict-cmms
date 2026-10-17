-- ═══════════════════════════════════════════════════════════════════════════
-- 20261017_pm_spread_schedule.sql
--
-- Spread PMs evenly across the school year; no PMs over summer or breaks.
--
-- Why
--   After 20261017_pm_frequency_intervals.sql the next dates follow each PM's
--   original first generation, which left piles (Mar 2027: 28 WOs, 18 of them
--   annual cycle counts; Jan 2027: 25) and anything due over summer or winter
--   break would all generate on the first day classes resume.
--
-- Decisions (Aaron, 2026-10-17)
--   • Annual PMs spread evenly over in-session days, about one every other day
--     (Mon–Thu), skipping spring break, finals weeks and summer.
--     Thanksgiving Day skipped. Spring 2027 starts Jan 18 and Fall 2027 starts
--     Sept 1 so the first week(s) of a term are free of new PMs.
--     Order: never-generated first, then the ones done longest ago.
--   • Quarterly PMs: one per week in late Jan / early Feb 2027, then every 3
--     months (Apr–May, Oct–Nov). The summer quarter is skipped (see below).
--   • Monthly PMs: staggered across days 2–22 of the month (~2 a week)
--     instead of five on the 1st.
--   • Fixed, untouched: Fanuc battery replacements PM0075–PM0082 (Jan 26) and
--     PM0084 Siemens PLC firmware (Nov 17).
--   • PM0097 Fanuc battery ORDER: Dec 26 (winter break) → Dec 1, 2026.
--   • Over a break, a PM that came due is NOT generated when classes resume;
--     it rolls to its next normal date instead (so a monthly due Jun 15 next
--     generates Sep 15, not all on the first day of Fall).
--
-- Term dates used (academic_terms, 2026-10-17)
--   Fall 2026   Aug 24 – Dec 18, finals Dec 14–18
--   Spring 2027 Jan 11 – May 14, spring break Mar 8–12, finals May 10–14
--   Fall 2027   not yet approved — PMs start Sept 1, 2027
--
-- How
--   1. private.pm_session_start(day) — first day of the current in-session
--      stretch (same semester-span rule as private.pm_student_in_session).
--   2. auto_generate_pm_work_orders() patched IN PLACE (third small patch):
--      a PM whose date fell BEFORE the current stretch began (i.e. during a
--      break) is rolled to its next normal date with private.pm_advance and
--      not generated; an audit row 'PM Rolled Past Break' records it.
--      Everything else in the function is unchanged.
--   3. Data: new next_due_date for Annual, Quarterly and Monthly PMs as above.
--      Old values saved in private.pm_spread_20261017 (undo below). Runs once:
--      if that table already has rows, the data step is skipped.
--
-- Undo for the data step:
--   UPDATE pm_schedules p SET next_due_date = s.old_next_due
--     FROM private.pm_spread_20261017 s WHERE s.pm_id = p.pm_id;
--
-- Re-runnable. Ends in ROLLBACK. Checks STOP the script if anything is off.
-- The result table is the month-by-month count, before vs after.
-- If Supabase asks about RLS, choose "Run without RLS" (this file enables it).
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE SCHEMA IF NOT EXISTS private;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 1: first day of the current in-session stretch
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.pm_session_start(p_day date)
 RETURNS date
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
  SELECT min(s.first_day)::date
    FROM (
      SELECT coalesce(nullif(trim(c.semester), ''),
                      nullif(to_jsonb(c) ->> 'term_id', ''),
                      c.class_id::text)                                         AS grp,
             min(coalesce(nullif(left(to_jsonb(c) ->> 'start_date', 10), ''), '0001-01-01')) AS first_day,
             max(coalesce(greatest(nullif(left(to_jsonb(c) ->> 'end_date',   10), ''),
                                   nullif(left(to_jsonb(c) ->> 'finals_end', 10), '')),
                          '9999-12-31'))                                        AS last_day
        FROM public.classes c
       WHERE coalesce(nullif(trim(c.status), ''), 'Active') = 'Active'
         AND EXISTS (SELECT 1 FROM public.class_enrollments e WHERE e.class_id::text = c.class_id::text)
       GROUP BY 1
    ) s
   WHERE s.first_day <= to_char(p_day, 'YYYY-MM-DD')
     AND s.last_day  >= to_char(p_day, 'YYYY-MM-DD');
$function$;

REVOKE ALL ON FUNCTION private.pm_session_start(date) FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 2: generator — roll PMs that came due over a break
-- ─────────────────────────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_oid oid;
  v_def text;
  v_new text;
  n     int;

  -- a. new variable
  v_decl_pat text := $p$v_stamp(\s+)timestamptz;$p$;
  v_decl_rep text := $r$v_stamp\1timestamptz;
  v_session_start date;  -- first day of the current in-session stretch (2026-10-17)$r$;

  -- b. compute it once, before the loop
  v_loop_anchor text := $a$FOR pm_rec IN$a$;
  v_loop_new    text := $a$v_session_start := private.pm_session_start(v_today);

  FOR pm_rec IN$a$;

  -- c. roll instead of generate when the date fell during a break
  v_skip_anchor text := $a$-- Skip if an open WO already exists for this PM$a$;
  v_roll_block  text := $a$-- ── Came due over a break (2026-10-17) ─────────────────────────────────
    -- The date fell before the current in-session stretch began, so nobody
    -- was here to do it. Don't generate it now; move it to its next normal
    -- date (a monthly due Jun 15 next generates Sep 15).
    IF v_session_start IS NOT NULL AND pm_rec.next_due_date::date < v_session_start THEN
      UPDATE pm_schedules SET
        next_due_date = private.pm_advance(pm_rec.next_due_date::date, pm_rec.frequency,
                                           pm_rec.frequency_value::text, v_today),
        updated_at    = v_now
      WHERE pm_id = pm_rec.pm_id;

      INSERT INTO audit_log (timestamp, user_email, user_name, action, entity_type, entity_id, details)
      VALUES (v_now, 'system@rict-cmms.auto', 'System (Auto-PM)', 'PM Rolled Past Break',
              'PM Schedule', pm_rec.pm_id,
              'PM ' || pm_rec.pm_id || ' (' || pm_rec.pm_name || ') was due ' ||
              to_char(pm_rec.next_due_date::date, 'Mon DD, YYYY') ||
              ' during a break; next generates ' ||
              to_char(private.pm_advance(pm_rec.next_due_date::date, pm_rec.frequency,
                                         pm_rec.frequency_value::text, v_today), 'Mon DD, YYYY') || '.');
      CONTINUE;
    END IF;

    -- Skip if an open WO already exists for this PM$a$;
BEGIN
  SELECT p.oid INTO v_oid
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'auto_generate_pm_work_orders' AND p.pronargs = 0;
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'public.auto_generate_pm_work_orders() not found. Nothing was changed.';
  END IF;

  v_def := replace(pg_get_functiondef(v_oid), E'\r', '');
  v_decl_rep    := replace(v_decl_rep,    E'\r', '');
  v_loop_new    := replace(v_loop_new,    E'\r', '');
  v_roll_block  := replace(v_roll_block,  E'\r', '');

  IF position('private.pm_session_start' IN v_def) > 0 THEN
    RAISE NOTICE 'auto_generate_pm_work_orders already rolls PMs past breaks — skipped.';
    RETURN;
  END IF;
  IF position('private.pm_advance' IN v_def) = 0 OR position('private.pm_student_in_session' IN v_def) = 0 THEN
    RAISE EXCEPTION 'Run 20261017_pm_rotation_in_session.sql and 20261017_pm_frequency_intervals.sql first. Nothing was changed.';
  END IF;

  n := (SELECT count(*) FROM regexp_matches(v_def, v_decl_pat, 'g'));
  IF n <> 1 THEN RAISE EXCEPTION 'Expected 1 "v_stamp timestamptz;" declaration, found %. Nothing was changed — send this message to Claude.', n; END IF;
  n := (length(v_def) - length(replace(v_def, v_loop_anchor, ''))) / length(v_loop_anchor);
  IF n <> 1 THEN RAISE EXCEPTION 'Expected 1 "FOR pm_rec IN", found %. Nothing was changed — send this message to Claude.', n; END IF;
  n := (length(v_def) - length(replace(v_def, v_skip_anchor, ''))) / length(v_skip_anchor);
  IF n <> 1 THEN RAISE EXCEPTION 'Expected 1 open-WO skip comment, found %. Nothing was changed — send this message to Claude.', n; END IF;

  v_new := regexp_replace(v_def, v_decl_pat, v_decl_rep);
  v_new := replace(v_new, v_loop_anchor, v_loop_new);
  v_new := replace(v_new, v_skip_anchor, v_roll_block);

  EXECUTE v_new;   -- CREATE OR REPLACE: owner, grants and SET search_path kept
  RAISE NOTICE 'auto_generate_pm_work_orders patched (roll past breaks).';
END
$do$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 3: the new schedule
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS private.pm_spread_20261017 (
  pm_id        text PRIMARY KEY,
  frequency    text,
  old_next_due text,
  new_next_due text,
  rule         text,
  spread_at    timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON private.pm_spread_20261017 FROM PUBLIC, anon, authenticated;
ALTER TABLE private.pm_spread_20261017 ENABLE ROW LEVEL SECURITY;  -- no policies: only the owner (migrations) can read it

CREATE TEMP TABLE _already ON COMMIT DROP AS
SELECT EXISTS (SELECT 1 FROM private.pm_spread_20261017) AS done;

-- Snapshot of the current dates (for the before/after table)
CREATE TEMP TABLE _before ON COMMIT DROP AS
SELECT pm_id, frequency, frequency_value, status, next_due_date::date AS next_due
  FROM pm_schedules;

-- Fixed and hand-placed PMs
CREATE TEMP TABLE _fixed ON COMMIT DROP AS
SELECT unnest(ARRAY['PM0075','PM0076','PM0077','PM0078','PM0079','PM0080','PM0081','PM0082','PM0084']) AS pm_id;

CREATE TEMP TABLE _placed (pm_id text PRIMARY KEY, new_next date, rule text) ON COMMIT DROP;

-- Fanuc battery order → Dec 1 (before winter break, ahead of the Jan 26 swaps)
INSERT INTO _placed VALUES ('PM0097', '2026-12-01', 'Fanuc order moved before winter break');

-- Quarterly: one a week from mid-Jan; repeats Apr–May / (summer skipped) / Oct–Nov
INSERT INTO _placed VALUES
  ('PM0089', '2027-01-19', 'quarterly stagger'),   -- Afinia #1 waste tray
  ('PM0090', '2027-01-21', 'quarterly stagger'),   -- Afinia #2 waste tray
  ('PM0093', '2027-01-27', 'quarterly stagger'),   -- drill press greasing
  ('PM0094', '2027-02-02', 'quarterly stagger'),   -- drill press oil spindle
  ('PM0088', '2027-02-04', 'quarterly stagger'),   -- Jet Mill spindle inspection
  ('PM0101', '2027-02-09', 'quarterly stagger');   -- Keyence laser

-- Monthly: days 2–22, about two a week, first occurrence in Nov 2026
INSERT INTO _placed VALUES
  ('PM0003', '2026-11-02', 'monthly stagger'),     -- clean 1-350
  ('PM0004', '2026-11-05', 'monthly stagger'),     -- clean 1-356
  ('PM0005', '2026-11-08', 'monthly stagger'),     -- clean 1-354
  ('PM0006', '2026-11-10', 'monthly stagger'),     -- clean 1-369
  ('PM0007', '2026-11-12', 'monthly stagger'),     -- clean 1-316B
  ('PM0102', '2026-11-15', 'monthly stagger'),     -- Zebra printer
  ('PM0100', '2026-11-17', 'monthly stagger'),     -- scrap bin
  ('PM0096', '2026-11-19', 'monthly stagger'),     -- vacuum pump
  ('PM0099', '2026-11-22', 'monthly stagger');     -- water jet

-- Only PMs that exist, are Active and still have the frequency we planned for
DELETE FROM _placed pl
 WHERE NOT EXISTS (SELECT 1 FROM pm_schedules p
                    WHERE p.pm_id = pl.pm_id AND p.status = 'Active'
                      AND ((pl.rule LIKE 'quarterly%' AND p.frequency = 'Quarterly')
                        OR (pl.rule LIKE 'monthly%'   AND p.frequency = 'Monthly')
                        OR (pl.rule LIKE 'Fanuc%'     AND p.frequency = 'Annually')));

-- Days that already carry a fixed or quarterly PM (not reused for annuals)
CREATE TEMP TABLE _busy ON COMMIT DROP AS
SELECT DISTINCT b.next_due AS d FROM _before b JOIN _fixed f ON f.pm_id = b.pm_id
UNION
SELECT (pl.new_next + interval '3 months' * k)::date
  FROM _placed pl, generate_series(0, 3) k
 WHERE pl.rule LIKE 'quarterly%' OR pl.rule LIKE 'Fanuc%';

-- In-session Mon–Thu days for the next 12 months
CREATE TEMP TABLE _slots ON COMMIT DROP AS
SELECT d::date AS d, row_number() OVER (ORDER BY d) - 1 AS idx
  FROM (
    SELECT generate_series(greatest(date '2026-10-19', (now() AT TIME ZONE 'America/Chicago')::date + 1),
                           date '2026-12-11', interval '1 day') AS d   -- Fall 2026 (finals Dec 14–18 skipped)
    UNION ALL
    SELECT generate_series(date '2027-01-18', date '2027-05-07', interval '1 day')   -- Spring 2027 (finals May 10–14 skipped)
    UNION ALL
    SELECT generate_series(date '2027-09-01', date '2027-10-15', interval '1 day')   -- Fall 2027 from Sept 1
  ) g
 WHERE extract(isodow FROM d) BETWEEN 1 AND 4                        -- Mon–Thu
   AND d::date NOT BETWEEN date '2027-03-08' AND date '2027-03-12'   -- spring break
   AND d::date <> date '2026-11-26'                                  -- Thanksgiving
   AND d::date NOT IN (SELECT d FROM _busy);

-- Annual PMs to spread: never generated first (keeping their current order),
-- then the ones generated longest ago
CREATE TEMP TABLE _annual ON COMMIT DROP AS
WITH gens AS (
  SELECT substring(a.details from 'from PM (\S+)')                AS pm_id,
         max((a.timestamp AT TIME ZONE 'America/Chicago')::date)  AS last_gen,
         min((a.timestamp AT TIME ZONE 'America/Chicago')::date)  AS first_gen
    FROM audit_log a
   WHERE a.action IN ('Auto-Generate PM WO', 'Generate PM WO')
   GROUP BY 1
)
SELECT p.pm_id, g.last_gen,
       row_number() OVER (ORDER BY (g.last_gen IS NOT NULL), g.last_gen, g.first_gen,
                                   p.next_due_date, p.pm_id) AS rn
  FROM pm_schedules p
  LEFT JOIN gens g ON g.pm_id = p.pm_id
 WHERE p.status = 'Active' AND p.frequency = 'Annually'
   AND p.pm_id NOT IN (SELECT pm_id FROM _fixed)
   AND p.pm_id NOT IN (SELECT pm_id FROM _placed);

-- Even spacing: annual #rn takes slot floor((rn − ½) × slots ÷ annuals)
INSERT INTO _placed
SELECT a.pm_id, s.d, 'annual spread'
  FROM _annual a
  JOIN _slots s ON s.idx = floor((a.rn - 0.5) * (SELECT count(*) FROM _slots)::numeric
                                 / (SELECT count(*) FROM _annual))::int;

-- Apply (once)
INSERT INTO private.pm_spread_20261017 (pm_id, frequency, old_next_due, new_next_due, rule)
SELECT pl.pm_id, b.frequency, b.next_due::text, pl.new_next::text, pl.rule
  FROM _placed pl JOIN _before b ON b.pm_id = pl.pm_id
 WHERE NOT (SELECT done FROM _already)
   AND b.next_due IS DISTINCT FROM pl.new_next
ON CONFLICT (pm_id) DO NOTHING;

UPDATE pm_schedules p
   SET next_due_date = pl.new_next, updated_at = now()
  FROM _placed pl
 WHERE pl.pm_id = p.pm_id
   AND NOT (SELECT done FROM _already)
   AND p.next_due_date::date IS DISTINCT FROM pl.new_next;

INSERT INTO audit_log (timestamp, user_email, user_name, action, entity_type, entity_id, details)
SELECT now(), 'system@rict-cmms.auto', 'System (Auto-PM)', 'PM Schedule Spread', 'PM Schedule', 'ALL',
       'Spread PM schedule (2026-10-17): ' || count(*) || ' next dates moved (annuals across in-session Mon–Thu days, quarterlies and monthlies staggered, no summer/breaks/finals). Old values in private.pm_spread_20261017.'
  FROM private.pm_spread_20261017
HAVING NOT (SELECT done FROM _already) AND count(*) > 0;

DO $do$ BEGIN
  IF (SELECT done FROM _already) THEN
    RAISE NOTICE 'Schedule was already spread (private.pm_spread_20261017 has rows) — data step skipped.';
  END IF;
END $do$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 4: checks — the script STOPS here with a message if any fails
-- ─────────────────────────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_gen text := replace(pg_get_functiondef('public.auto_generate_pm_work_orders()'::regprocedure), E'\r', '');
  v_bad int;
BEGIN
  IF position('private.pm_session_start' IN v_gen) = 0 OR position('PM Rolled Past Break' IN v_gen) = 0 THEN
    RAISE EXCEPTION 'check failed: generator not patched';
  END IF;
  IF position('private.pm_advance' IN v_gen) = 0 OR position('private.pm_student_in_session' IN v_gen) = 0 THEN
    RAISE EXCEPTION 'check failed: generator lost an earlier fix';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.auto_generate_pm_work_orders()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.auto_generate_pm_work_orders()', 'EXECUTE') THEN
    RAISE EXCEPTION 'check failed: generator permissions changed';
  END IF;

  -- fixed PMs untouched
  SELECT count(*) INTO v_bad FROM pm_schedules p JOIN _before b ON b.pm_id = p.pm_id JOIN _fixed f ON f.pm_id = p.pm_id
   WHERE p.next_due_date::date IS DISTINCT FROM b.next_due;
  IF v_bad > 0 THEN RAISE EXCEPTION 'check failed: % fixed PMs moved', v_bad; END IF;

  IF NOT (SELECT done FROM _already) THEN
    -- every annual got a distinct in-session Mon–Thu day
    SELECT count(*) INTO v_bad FROM _annual a WHERE NOT EXISTS (SELECT 1 FROM _placed pl WHERE pl.pm_id = a.pm_id);
    IF v_bad > 0 THEN RAISE EXCEPTION 'check failed: % annual PMs got no day', v_bad; END IF;
    SELECT count(*) - count(DISTINCT new_next) INTO v_bad FROM _placed WHERE rule = 'annual spread';
    IF v_bad > 0 THEN RAISE EXCEPTION 'check failed: two annual PMs share a day'; END IF;
    SELECT count(*) INTO v_bad FROM _placed pl WHERE pl.rule = 'annual spread' AND pl.new_next NOT IN (SELECT d FROM _slots);
    IF v_bad > 0 THEN RAISE EXCEPTION 'check failed: annual PM placed outside the allowed days'; END IF;
  END IF;

  -- nothing lands in the past
  SELECT count(*) INTO v_bad FROM pm_schedules
   WHERE status = 'Active' AND frequency IN ('Annually', 'Quarterly', 'Monthly')
     AND pm_id IN (SELECT pm_id FROM _placed)
     AND next_due_date::date <= (now() AT TIME ZONE 'America/Chicago')::date;
  IF v_bad > 0 THEN RAISE EXCEPTION 'check failed: % PMs would be due today or earlier', v_bad; END IF;

  RAISE NOTICE 'All checks passed.';
END
$do$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Result: work orders per month for the next 12 months, before vs after.
--   before = what you saw earlier (summer/break dates counted where they fall)
--   after  = new dates; anything landing outside class time is left out,
--            because it now rolls to its next normal date instead of generating.
-- ─────────────────────────────────────────────────────────────────────────────
WITH horizon AS (SELECT date '2026-10-17' AS d0, date '2027-10-16' AS d1),
in_session(a, b) AS (VALUES (date '2026-08-24', date '2026-12-18'),
                            (date '2027-01-11', date '2027-05-14'),
                            (date '2027-09-01', date '2027-12-17')),
occ_before AS (
  SELECT b.frequency, (b.next_due + private.pm_step(b.frequency, b.frequency_value::text) * n)::date AS d
    FROM _before b, horizon h, generate_series(0, 400) n
   WHERE b.status = 'Active' AND b.next_due IS NOT NULL
     AND (b.next_due + private.pm_step(b.frequency, b.frequency_value::text) * n)::date BETWEEN h.d0 AND h.d1
),
occ_after AS (
  SELECT p.frequency, (p.next_due_date::date + private.pm_step(p.frequency, p.frequency_value::text) * n)::date AS d
    FROM pm_schedules p, horizon h, generate_series(0, 400) n
   WHERE p.status = 'Active' AND p.next_due_date IS NOT NULL
     AND (p.next_due_date::date + private.pm_step(p.frequency, p.frequency_value::text) * n)::date BETWEEN h.d0 AND h.d1
),
occ_after_kept AS (
  SELECT o.* FROM occ_after o WHERE EXISTS (SELECT 1 FROM in_session s WHERE o.d BETWEEN s.a AND s.b)
),
months AS (SELECT to_char(m, 'YYYY-MM') AS month
             FROM generate_series(date '2026-10-01', date '2027-10-01', interval '1 month') m)
SELECT m.month,
       (SELECT count(*) FROM occ_before o WHERE to_char(o.d, 'YYYY-MM') = m.month)                                AS before_total,
       (SELECT count(*) FROM occ_after_kept o WHERE to_char(o.d, 'YYYY-MM') = m.month)                            AS after_total,
       (SELECT count(*) FROM occ_after_kept o WHERE to_char(o.d, 'YYYY-MM') = m.month AND o.frequency = 'Annually')  AS after_annual,
       (SELECT count(*) FROM occ_after_kept o WHERE to_char(o.d, 'YYYY-MM') = m.month AND o.frequency = 'Quarterly') AS after_quarterly,
       (SELECT count(*) FROM occ_after_kept o WHERE to_char(o.d, 'YYYY-MM') = m.month AND o.frequency = 'Monthly')   AS after_monthly,
       (SELECT count(*) FROM occ_after o WHERE to_char(o.d, 'YYYY-MM') = m.month)
         - (SELECT count(*) FROM occ_after_kept o WHERE to_char(o.d, 'YYYY-MM') = m.month)                        AS skipped_break_summer
  FROM months m
 ORDER BY m.month;

ROLLBACK;   -- ← swap for COMMIT once the table above looks right

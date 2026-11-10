-- ═══════════════════════════════════════════════════════════════════════════
-- RICT CMMS — All Done keeps today's hours that have already started
-- File: supabase/migrations/20261110_all_done_keep_started_hours.sql
--
-- Bug: both All Done paths cancelled Confirmed sign-ups with date >= TODAY, so
-- hours the student had already worked earlier that day were cancelled too
-- (e.g. a 3:48 PM swipe cancelled that day's 8 AM–3 PM sign-ups and the week
-- then showed 0 signed hours).
--
-- Rule now: cancel only sign-ups that have NOT started yet — later today and
-- the rest of the week. The hour the student is in, and everything earlier
-- that day, stay Confirmed. Past days were never touched and still aren't.
--
-- Also: the cancel now records WHO did it (cancelled_by_email). The badge swipe
-- runs under the student's own kiosk session, so the cancel-stamp trigger was
-- recording the STUDENT as the canceller — which the Accountability Report
-- counts as a student late cancel. It now records the instructor whose badge
-- was swiped (mark_all_done) or the signed-in instructor (mark_all_done_manual).
--
-- How: patches the LIVE function definitions in place (pg_get_functiondef →
-- exact text replace → EXECUTE). Each replacement must match exactly once or
-- the whole migration stops, so nothing else in either function changes.
-- (mark_all_done_manual's full source was never committed to the repo; its
-- live definition as of 2026-11-10 is saved alongside this file as
-- 20261012_mark_all_done_manual.sql for the record.)
--
-- RUN 1: as written (ROLLBACK) — check the grid. RUN 2: swap to COMMIT.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

DO $migrate$
DECLARE
  -- one row per edit: function, exact old text, new text
  v_edits  text[][] := ARRAY[
    -- badge swipe (kiosk)
    ARRAY['public.mark_all_done(text,text,text,jsonb,integer,date)',
          $o$SET status = 'Cancelled'$o$,
          $n$SET status = 'Cancelled',
         cancelled_by_email = coalesce(nullif(lower(btrim(coalesce(v_instr.email, ''))), ''), cancelled_by_email)$n$],
    ARRAY['public.mark_all_done(text,text,text,jsonb,integer,date)',
          $o$AND date::date BETWEEN v_today AND v_end;$o$,
          $n$AND date::date BETWEEN v_today AND v_end
     -- 2026-11-10: keep today's hours that have already started
     AND NOT (date::date = v_today AND start_time::time < v_local::time);$n$],
    -- Time Cards (manual)
    ARRAY['public.mark_all_done_manual(text,date,text,text,text,boolean)',
          $o$SET status = 'Cancelled'$o$,
          $n$SET status = 'Cancelled',
           cancelled_by_email = nullif(v_me, '')$n$],
    ARRAY['public.mark_all_done_manual(text,date,text,text,text,boolean)',
          $o$AND date::date BETWEEN v_today AND v_wend;$o$,
          $n$AND date::date BETWEEN v_today AND v_wend
       -- 2026-11-10: keep today's hours that have already started
       AND NOT (date::date = v_today AND start_time::time < v_local::time);$n$]
  ];
  v_fn    text;
  v_def   text;
  v_hits  int;
  i       int;
  v_done  text[] := '{}';
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['public.mark_all_done(text,text,text,jsonb,integer,date)',
                             'public.mark_all_done_manual(text,date,text,text,text,boolean)'] LOOP
    v_def := pg_get_functiondef(v_fn::regprocedure);
    IF position('keep today''s hours that have already started' IN v_def) > 0 THEN
      RAISE NOTICE '% already patched — skipped', v_fn;
      CONTINUE;
    END IF;
    FOR i IN 1 .. array_length(v_edits, 1) LOOP
      CONTINUE WHEN v_edits[i][1] <> v_fn;
      v_hits := (length(v_def) - length(replace(v_def, v_edits[i][2], ''))) / length(v_edits[i][2]);
      IF v_hits <> 1 THEN
        RAISE EXCEPTION '%: expected exactly 1 match for [%], found % — live function differs from what this fix expects; nothing changed',
          v_fn, v_edits[i][2], v_hits;
      END IF;
      v_def := replace(v_def, v_edits[i][2], v_edits[i][3]);
    END LOOP;
    EXECUTE v_def;   -- CREATE OR REPLACE keeps owner and GRANTs
    v_done := v_done || v_fn;
  END LOOP;
  RAISE NOTICE 'patched: %', v_done;
END
$migrate$;

-- ── Verification (one grid) — expect every check = true ───────────────────
SELECT check_name, ok FROM (VALUES
  (1, 'mark_all_done keeps started hours',
      position('start_time::time < v_local::time' IN pg_get_functiondef('public.mark_all_done(text,text,text,jsonb,integer,date)'::regprocedure)) > 0),
  (2, 'mark_all_done records instructor as canceller',
      position('cancelled_by_email = coalesce(nullif(lower(btrim(coalesce(v_instr.email' IN pg_get_functiondef('public.mark_all_done(text,text,text,jsonb,integer,date)'::regprocedure)) > 0),
  (3, 'mark_all_done_manual keeps started hours',
      position('start_time::time < v_local::time' IN pg_get_functiondef('public.mark_all_done_manual(text,date,text,text,text,boolean)'::regprocedure)) > 0),
  (4, 'mark_all_done_manual records instructor as canceller',
      position('cancelled_by_email = nullif(v_me' IN pg_get_functiondef('public.mark_all_done_manual(text,date,text,text,text,boolean)'::regprocedure)) > 0),
  (5, 'mark_all_done still SECURITY DEFINER',
      (SELECT prosecdef FROM pg_proc WHERE oid = 'public.mark_all_done(text,text,text,jsonb,integer,date)'::regprocedure)),
  (6, 'mark_all_done_manual still SECURITY DEFINER',
      (SELECT prosecdef FROM pg_proc WHERE oid = 'public.mark_all_done_manual(text,date,text,text,text,boolean)'::regprocedure)),
  (7, 'anon still cannot run mark_all_done_manual',
      NOT has_function_privilege('anon', 'public.mark_all_done_manual(text,date,text,text,text,boolean)', 'EXECUTE')),
  (8, 'signed-in users can still run mark_all_done',
      has_function_privilege('authenticated', 'public.mark_all_done(text,text,text,jsonb,integer,date)', 'EXECUTE'))
) AS c(n, check_name, ok) ORDER BY n;

ROLLBACK;
-- COMMIT;

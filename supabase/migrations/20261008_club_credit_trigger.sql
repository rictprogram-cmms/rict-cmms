-- ═══════════════════════════════════════════════════════════════════════════
-- 20261008_club_credit_trigger.sql
--
-- Club Activity always credits 0.25 h per hour on the clock.
--
-- Problem: only the kiosk punch-out and the instructor "Add entry" applied the
-- rule. Every edit path saved the FULL clock time as credit (4× too much):
--   • Volunteer Hours → Edit Volunteer Entry (instructor)
--   • Time Cards → edit a time entry
--   • approving a student's edit request (Time Cards and the notification bell)
--   • approving a new Club request on Time Cards (also left entry_type empty)
--
-- Fix: one BEFORE INSERT/UPDATE trigger on time_clock. For a Club row
-- (entry_type 'Club Activity' or class_id 'CLUB_ACTIVITY') with a punch-out
-- after its punch-in, total_hours := round(clock hours × 0.25, 2), and the
-- "Xh actual → Yh credited" note in the description is refreshed (or added).
-- On UPDATE it only acts when the times, type, class or hours change, so
-- unrelated updates (approval, notes) leave the row alone.
--
-- Repair: none needed — the check on 2026-10-08 found 0 Club rows off the
-- rule. The verification below repeats that check.
--
-- Re-runnable. Ends in ROLLBACK — check the verification rows, then COMMIT.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.time_clock_club_credit()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_raw     numeric;
  v_credit  numeric;
  v_note    text;
  v_desc    text;
BEGIN
  IF NOT (coalesce(NEW.entry_type, '') = 'Club Activity' OR coalesce(NEW.class_id::text, '') = 'CLUB_ACTIVITY') THEN
    RETURN NEW;
  END IF;
  IF NEW.punch_out IS NULL OR NEW.punch_in IS NULL OR NEW.punch_out <= NEW.punch_in THEN
    RETURN NEW;   -- still punched in (or bad times): nothing to credit yet
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.punch_in    IS NOT DISTINCT FROM OLD.punch_in
     AND NEW.punch_out   IS NOT DISTINCT FROM OLD.punch_out
     AND NEW.total_hours IS NOT DISTINCT FROM OLD.total_hours
     AND NEW.entry_type  IS NOT DISTINCT FROM OLD.entry_type
     AND NEW.class_id::text IS NOT DISTINCT FROM OLD.class_id::text THEN
    RETURN NEW;   -- unrelated update (approval, description, …)
  END IF;

  v_raw    := extract(epoch FROM (NEW.punch_out - NEW.punch_in)) / 3600.0;
  v_credit := round(v_raw * 0.25, 2);
  NEW.total_hours := v_credit;

  -- Keep the "Xh actual → Yh credited" note truthful, in whatever wording it
  -- already has (kiosk, student request, instructor add). Add one if missing.
  v_desc := coalesce(NEW.description, '');
  IF v_desc ~ '[0-9.]+h actual → [0-9.]+h credited' THEN
    NEW.description := regexp_replace(v_desc, '[0-9.]+h actual → [0-9.]+h credited',
                         round(v_raw, 2)::float8::text || 'h actual → ' || v_credit::float8::text || 'h credited');
  ELSE
    v_note := 'Club Activity: ' || round(v_raw, 2)::float8::text || 'h actual → '
              || v_credit::float8::text || 'h credited (0.25x)';
    NEW.description := CASE WHEN btrim(v_desc) <> '' THEN v_desc || ' | ' || v_note ELSE v_note END;
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.time_clock_club_credit() IS
  'Club Activity rows always credit 0.25 h per clock hour (2026-10-08). Covers every insert/edit path, not just the kiosk.';

REVOKE ALL ON FUNCTION public.time_clock_club_credit() FROM PUBLIC;

DROP TRIGGER IF EXISTS time_clock_club_credit ON public.time_clock;
CREATE TRIGGER time_clock_club_credit
  BEFORE INSERT OR UPDATE ON public.time_clock
  FOR EACH ROW
  EXECUTE FUNCTION public.time_clock_club_credit();

-- ─────────────────────────────────────────────────────────────────────────────
-- Self-test (always undone): insert a 1h01m Club row, then edit it like the
-- Volunteer Hours screen would (full clock time as credit), and read it back.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TEMP TABLE _club_test (step text, result text) ON COMMIT DROP;

DO $$
DECLARE
  v_email text;
  v_ins   numeric;
  v_upd   numeric;
  v_desc  text;
  v_res   text[];
BEGIN
  SELECT p.email INTO v_email FROM public.profiles p WHERE coalesce(p.email, '') <> '' ORDER BY p.email LIMIT 1;

  BEGIN
    INSERT INTO public.time_clock (record_id, user_email, user_name, class_id, course_id, punch_in, punch_out,
                                   total_hours, status, entry_type, description)
    VALUES ('TCTEST_CLUB', v_email, 'Club test', 'CLUB_ACTIVITY', 'Club Activity',
            '2026-10-07 12:59:00+00', '2026-10-07 14:00:00+00', 1.02, 'Punched Out', 'Club Activity',
            'Club Activity: 3.04h actual → 0.76h credited (0.25x)');
    SELECT total_hours INTO v_ins FROM public.time_clock WHERE record_id = 'TCTEST_CLUB';

    UPDATE public.time_clock SET punch_out = '2026-10-07 13:44:00+00', total_hours = 0.75
     WHERE record_id = 'TCTEST_CLUB';
    SELECT total_hours, description INTO v_upd, v_desc FROM public.time_clock WHERE record_id = 'TCTEST_CLUB';

    v_res := ARRAY[
      CASE WHEN v_ins = 0.25 THEN 'ok: 12:59–2:00 credited 0.25 h (15m)' ELSE 'FAILED: got ' || v_ins END,
      CASE WHEN v_upd = 0.19 THEN 'ok: edited to 12:59–1:44 → 0.19 h (11m)' ELSE 'FAILED: got ' || v_upd END,
      v_desc];
    RAISE EXCEPTION 'undo_club_test';
  EXCEPTION WHEN others THEN
    IF SQLERRM <> 'undo_club_test' THEN v_res := ARRAY['test skipped: ' || SQLERRM, '', '']; END IF;
  END;

  INSERT INTO _club_test VALUES ('1 insert', v_res[1]), ('2 edit', v_res[2]), ('3 note', v_res[3]);
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification (single result set)
--   trigger      → time_clock_club_credit, BEFORE INSERT OR UPDATE
--   test         → two "ok" rows; the note reads 0.75h actual → 0.19h credited
--   off rule     → 0 (Club rows whose credit is not 0.25 × clock time)
--   test row     → 0 (self-test left nothing behind)
-- ─────────────────────────────────────────────────────────────────────────────
SELECT 'trigger' AS kind, tgname AS name, 'BEFORE INSERT OR UPDATE on time_clock' AS detail
  FROM pg_trigger WHERE tgname = 'time_clock_club_credit' AND NOT tgisinternal
UNION ALL
SELECT 'test', step, result FROM _club_test
UNION ALL
SELECT 'off rule', 'Club rows not at 0.25 × clock', count(*)::text
  FROM public.time_clock
 WHERE (entry_type = 'Club Activity' OR class_id::text = 'CLUB_ACTIVITY')
   AND punch_out IS NOT NULL
   AND abs(total_hours - extract(epoch FROM (punch_out - punch_in)) / 3600.0 * 0.25) > 0.02
UNION ALL
SELECT 'test row', 'TCTEST_CLUB left behind', count(*)::text
  FROM public.time_clock WHERE record_id = 'TCTEST_CLUB'
ORDER BY 1, 2;

ROLLBACK;   -- ← swap for COMMIT after checking the verification output

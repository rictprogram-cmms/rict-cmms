-- ═════════════════════════════════════════════════════════════════════════════
-- RICT CMMS — One Confirmed lab sign-up per student per hour
-- File: supabase/migrations/20260921_lab_signup_unique_hour.sql
--
-- Purpose
--   Until 2026-09-21 both sign-up screens checked for an existing booking by
--   user_id, but every lab_signup row is written with user_id = NULL, so the
--   check never matched and the same student could hold two Confirmed rows for
--   the same hour (double-counting toward their required hours). The app-side
--   checks now match on email. This index makes the rule true in the DATABASE,
--   so it holds no matter which screen — or which future code — writes the row.
--
-- What it creates
--   UNIQUE INDEX lab_signup_one_confirmed_per_hour
--     ON lab_signup (lower(user_email), <day>, <start time>)
--     WHERE status = 'Confirmed'
--   Partial on purpose: Cancelled rows are history and may repeat freely, so a
--   cancelled hour can always be booked again.
--
-- It works out the column types itself
--   An index expression must be IMMUTABLE, and the right expression for "the
--   day" depends on how lab_signup.date is typed:
--     date                         → "date"
--     timestamp without time zone  → ("date")::date
--     timestamp with time zone     → (("date" AT TIME ZONE 'UTC'))::date
--         (a bare ::date on timestamptz depends on the session time zone and is
--          refused in an index; a literal zone is immutable. Every row is
--          written at local NOON — 17:00Z/18:00Z, or fake-UTC 12:00 — so the UTC
--          calendar day is always the lab day.)
--     text / varchar               → left("date", 10)
--   Anything else stops the migration with a clear message.
--
-- It will NOT touch your data
--   If duplicates already exist the index is NOT created and nothing is
--   changed; the result lists every duplicated student/day/hour with the
--   signup_ids involved so they can be fixed by hand (decision 2026-09-21).
--   Fix = cancel the extra in Lab Signup → Admin Signup → Edit sign-ups, then
--   run this again.
--
-- Deploy order
--   Push the app code FIRST (it turns the index's error into a plain message in
--   the grid, Admin Signup and schedule-change approval). Then run this.
--
-- Safe to re-run. DRY RUN: ends in ROLLBACK. Read the result, then change the
-- last line to COMMIT and run again.
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TEMP TABLE _result (ord int, item text, value text) ON COMMIT DROP;

DO $$
DECLARE
  v_index      constant text := 'lab_signup_one_confirmed_per_hour';
  v_date_type  text;
  v_time_type  text;
  v_day_expr   text;
  v_time_expr  text;
  v_dupes      int;
  v_confirmed  int;
  v_exists     boolean;
  r            record;
  n            int := 100;
BEGIN
  SELECT data_type INTO v_date_type FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'lab_signup' AND column_name = 'date';
  SELECT data_type INTO v_time_type FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'lab_signup' AND column_name = 'start_time';

  IF v_date_type IS NULL OR v_time_type IS NULL THEN
    RAISE EXCEPTION 'public.lab_signup.date / start_time not found — is this the right database?';
  END IF;

  v_day_expr := CASE v_date_type
    WHEN 'date'                        THEN '"date"'
    WHEN 'timestamp without time zone' THEN '(("date")::date)'
    WHEN 'timestamp with time zone'    THEN '((("date" AT TIME ZONE ''UTC''))::date)'
    WHEN 'text'                        THEN '(left("date", 10))'
    WHEN 'character varying'           THEN '(left("date", 10))'
  END;
  v_time_expr := CASE v_time_type
    WHEN 'time without time zone' THEN 'start_time'
    WHEN 'text'                   THEN '(left(start_time, 5))'
    WHEN 'character varying'      THEN '(left(start_time, 5))'
  END;
  IF v_day_expr IS NULL OR v_time_expr IS NULL THEN
    RAISE EXCEPTION 'Unhandled column type — lab_signup.date is %, start_time is %. Send this message to Claude.', v_date_type, v_time_type;
  END IF;

  INSERT INTO _result VALUES (1, 'lab_signup.date type', v_date_type), (2, 'lab_signup.start_time type', v_time_type),
                             (3, 'day expression used', v_day_expr);

  EXECUTE 'SELECT count(*) FROM public.lab_signup WHERE status = ''Confirmed''' INTO v_confirmed;
  INSERT INTO _result VALUES (4, 'Confirmed sign-ups checked', v_confirmed::text);

  -- Existing duplicates, by the SAME expressions the index will use
  EXECUTE format($q$
    SELECT count(*) FROM (
      SELECT 1 FROM public.lab_signup
       WHERE status = 'Confirmed' AND user_email IS NOT NULL
       GROUP BY lower(user_email), %1$s, %2$s HAVING count(*) > 1
    ) d $q$, v_day_expr, v_time_expr) INTO v_dupes;
  INSERT INTO _result VALUES (5, 'duplicated student/day/hour groups', v_dupes::text);

  SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = v_index) INTO v_exists;

  IF v_exists THEN
    INSERT INTO _result VALUES (6, 'RESULT', 'Index already exists — nothing to do.');
  ELSIF v_dupes > 0 THEN
    INSERT INTO _result VALUES (6, 'RESULT', 'NOT CREATED — fix the duplicates listed below (cancel the extra row of each), then run this again. Nothing was changed.');
    FOR r IN EXECUTE format($q$
      SELECT lower(user_email) AS email, (%1$s)::text AS day, (%2$s)::text AS hour, count(*) AS copies,
             string_agg(signup_id || COALESCE(' [' || NULLIF(class_id, '') || ']', ' [no class]'), ', ' ORDER BY created_at, signup_id) AS rows
        FROM public.lab_signup
       WHERE status = 'Confirmed' AND user_email IS NOT NULL
       GROUP BY lower(user_email), %1$s, %2$s HAVING count(*) > 1
       ORDER BY 2, 3, 1 LIMIT 200 $q$, v_day_expr, v_time_expr)
    LOOP
      n := n + 1;
      INSERT INTO _result VALUES (n, 'DUPLICATE', format('%s · %s %s · %s copies · %s (oldest first)', r.email, r.day, r.hour, r.copies, r.rows));
    END LOOP;
  ELSE
    EXECUTE format('CREATE UNIQUE INDEX %I ON public.lab_signup (lower(user_email), %s, %s) WHERE status = ''Confirmed''',
                   v_index, v_day_expr, v_time_expr);
    EXECUTE format('COMMENT ON INDEX public.%I IS %L', v_index,
      'One Confirmed lab sign-up per student per hour. Partial: Cancelled rows may repeat. The app reports a violation as "already booked" (src/lib/supabaseData.js LAB_SIGNUP_UNIQUE_HOUR).');
    INSERT INTO _result VALUES (6, 'RESULT', 'CREATED. It is only KEPT if this run ends in COMMIT — a ROLLBACK run is the dry run.');
  END IF;
END $$;

-- Consolidated verification (the SQL Editor shows only the last result)
SELECT r.item, r.value
  FROM (
    SELECT ord, item, value FROM _result
    UNION ALL
    SELECT 7, 'index definition', COALESCE(
      (SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'lab_signup_one_confirmed_per_hour'),
      '(none)')
  ) r
 ORDER BY r.ord;

ROLLBACK;
-- COMMIT;

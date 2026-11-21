-- ═════════════════════════════════════════════════════════════════════════════
-- RICT CMMS — Lunch can start on the half hour (11:30 AM, 12:30 PM)
-- File: supabase/migrations/20261120_lunch_half_hour.sql
-- Run AFTER: 20261103_help_request_rules.sql
--
-- What this changes
--   1. lab_calendar.lunch_hour can hold a half hour: 11.5 = 11:30 AM,
--      12.5 = 12:30 PM. Whole hours (11, 12, 13) are unchanged. If the column
--      is a whole-number type it is widened to numeric(4,2); if it is already
--      numeric or text it is left alone. Existing rows keep their values.
--   2. private.help_request_block_reason — the database help-request check
--      now treats lunch as the 60 minutes starting at lunch_hour (minute
--      precise), matching src/lib/helpAvailability.js. Everything else in the
--      function is identical to 20261103_help_request_rules.sql.
--
-- Dry run: ends in ROLLBACK. Every row should show ok = true (INFO rows are
-- for reading only). Then change the last line to COMMIT and run again.
-- The self-test uses a 2099 calendar day inside a sub-block that is always
-- rolled back, so nothing is left behind even on COMMIT.
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TEMP TABLE _lunch_info (k text, v text) ON COMMIT DROP;
INSERT INTO _lunch_info
SELECT 'type_before', data_type || coalesce('(' || numeric_precision || ',' || numeric_scale || ')', '')
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'lab_calendar' AND column_name = 'lunch_hour';

-- ── 1. Widen lunch_hour if it only holds whole numbers ──────────────────────
DO $do$
DECLARE
  v_type text;
BEGIN
  SELECT data_type INTO v_type
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'lab_calendar' AND column_name = 'lunch_hour';
  IF v_type IN ('integer', 'smallint', 'bigint') THEN
    ALTER TABLE public.lab_calendar
      ALTER COLUMN lunch_hour TYPE numeric(4,2) USING lunch_hour::numeric(4,2);
  END IF;
END;
$do$;

-- ── 2. Help-request rule: half-hour lunch ───────────────────────────────────
-- Why a new help request would be refused right now (NULL = allowed).
--   p_local        Central wall-clock time to test (NULL = now)
--   p_check_clock  false skips the clocked-in rule (used by the INFO row)
CREATE OR REPLACE FUNCTION private.help_request_block_reason(
  p_email text, p_local timestamp DEFAULT NULL, p_check_clock boolean DEFAULT true)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_local   timestamp := coalesce(p_local, now() AT TIME ZONE 'America/Chicago');
  v_min     integer;
  v_status  text;
  v_start   integer;
  v_end     integer;
  v_lunch   text;
  v_ls      integer;
  v_blocks  jsonb;
  v_btxt    text;
  v_b       jsonb;
  v_bs      integer;
  v_be      integer;
  v_mode    text;
  v_pause   text;
  v_until   text;
  v_until_t timestamptz;
BEGIN
  -- Kill switch
  IF coalesce((SELECT setting_value FROM public.settings WHERE setting_key = 'help_server_rules'), 'true') <> 'true' THEN
    RETURN NULL;
  END IF;

  v_min := extract(hour FROM v_local)::int * 60 + extract(minute FROM v_local)::int;

  -- Clocked in (same test as the help button: an open punch for the email)
  IF p_check_clock AND NOT EXISTS (
       SELECT 1 FROM public.time_clock t
        WHERE lower(t.user_email) = lower(coalesce(p_email, ''))
          AND t.punch_out IS NULL) THEN
    RETURN 'not_clocked_in';
  END IF;

  -- Today's lab day
  SELECT lc.status, private.help_clock_minutes(lc.start_time::text),
         private.help_clock_minutes(lc.end_time::text), lc.lunch_hour::text, lc.closed_blocks::text
    INTO v_status, v_start, v_end, v_lunch, v_btxt
    FROM public.lab_calendar lc
   WHERE (lc.date::date) = v_local::date
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN 'no_calendar';
  END IF;
  -- closed_blocks may be JSONB or text; an unreadable value counts as none
  BEGIN
    v_blocks := CASE WHEN coalesce(btrim(v_btxt), '') IN ('', 'null') THEN NULL ELSE v_btxt::jsonb END;
  EXCEPTION WHEN others THEN
    v_blocks := NULL;
  END;
  IF coalesce(v_status, '') <> 'Open' THEN
    RETURN 'closed_day';
  END IF;

  -- Open hours (same 8–4 fallback as Lab Sign Up for rows without hours)
  IF v_min < coalesce(v_start, 8 * 60) THEN RETURN 'before_open'; END IF;
  IF v_min >= coalesce(v_end, 16 * 60) THEN RETURN 'after_close'; END IF;

  -- Closure blocks (end exclusive)
  IF v_blocks IS NOT NULL AND jsonb_typeof(v_blocks) = 'array' THEN
    FOR v_b IN SELECT * FROM jsonb_array_elements(v_blocks) LOOP
      v_bs := private.help_clock_minutes(v_b ->> 'start');
      v_be := private.help_clock_minutes(v_b ->> 'end');
      IF v_bs IS NOT NULL AND v_be IS NOT NULL AND v_be > v_bs
         AND v_min >= v_bs AND v_min < v_be THEN
        RETURN 'closure';
      END IF;
    END LOOP;
  END IF;

  -- Lunch: 60 minutes from lunch_hour, which may be a half hour
  -- (12 = 12:00–1:00, 11.5 = 11:30–12:30). End exclusive, like the app.
  IF v_lunch ~ '^\s*\d{1,2}(\.\d+)?\s*$' THEN
    v_ls := round(btrim(v_lunch)::numeric * 60)::int;
    IF v_min >= v_ls AND v_min < v_ls + 60 THEN
      RETURN 'lunch';
    END IF;
  END IF;

  -- Help paused (Away – pause help) unless its end time has passed.
  -- instructor_away_until is fake-UTC: Central wall time labelled +00.
  SELECT max(setting_value) FILTER (WHERE setting_key = 'instructor_away_mode'),
         max(setting_value) FILTER (WHERE setting_key = 'instructor_away_blocks_help'),
         max(setting_value) FILTER (WHERE setting_key = 'instructor_away_until')
    INTO v_mode, v_pause, v_until
    FROM public.settings
   WHERE setting_key IN ('instructor_away_mode', 'instructor_away_blocks_help', 'instructor_away_until');
  IF v_mode = 'true' AND v_pause = 'true' THEN
    IF coalesce(btrim(v_until), '') = '' THEN
      RETURN 'paused';
    END IF;
    BEGIN
      v_until_t := btrim(v_until)::timestamptz;
    EXCEPTION WHEN others THEN
      v_until_t := NULL;                       -- unreadable end time = no end time
    END;
    IF v_until_t IS NULL OR v_until_t > (v_local AT TIME ZONE 'UTC') THEN
      RETURN 'paused';
    END IF;
  END IF;

  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION private.help_request_block_reason(text, timestamp, boolean) FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TEMP TABLE _lh_tests (test text, ok boolean, detail text) ON COMMIT DROP;

DO $do$
DECLARE
  d      date := DATE '2099-01-05';
  em     text := 'lunch-half-selftest@example.com';
  res    text;
  expect text;
  ex_msg text;
  t      text;
BEGIN
  BEGIN
    INSERT INTO public.lab_calendar (calendar_id, date, start_time, end_time, status, lunch_hour, notes, closed_blocks)
    VALUES ('LH-SELFTEST', (d + time '12:00'), '08:00:00', '16:00:00', 'Open', 11.5, '', '[]');
    INSERT INTO public.time_clock (record_id, user_email, status, punch_in)
    VALUES ('LH-SELFTEST', em, 'Punched In', (d + time '07:00'));
    UPDATE public.settings SET setting_value = 'false' WHERE setting_key IN ('instructor_away_mode', 'instructor_away_blocks_help');
    UPDATE public.settings SET setting_value = 'true'  WHERE setting_key = 'help_server_rules';

    -- 11:30 lunch
    res := (SELECT lunch_hour::text FROM public.lab_calendar WHERE calendar_id = 'LH-SELFTEST');
    FOREACH t IN ARRAY ARRAY['11:29','11:30','12:00','12:29','12:30'] LOOP
      res := res || ',' || coalesce(private.help_request_block_reason(em, d + t::time), 'open');
    END LOOP;
    -- 12:30 lunch
    UPDATE public.lab_calendar SET lunch_hour = 12.5 WHERE calendar_id = 'LH-SELFTEST';
    FOREACH t IN ARRAY ARRAY['12:29','12:30','13:29','13:30'] LOOP
      res := res || ',' || coalesce(private.help_request_block_reason(em, d + t::time), 'open');
    END LOOP;
    -- Whole-hour lunch still works exactly as before
    UPDATE public.lab_calendar SET lunch_hour = 12 WHERE calendar_id = 'LH-SELFTEST';
    FOREACH t IN ARRAY ARRAY['11:59','12:00','12:59','13:00'] LOOP
      res := res || ',' || coalesce(private.help_request_block_reason(em, d + t::time), 'open');
    END LOOP;
    -- No lunch
    UPDATE public.lab_calendar SET lunch_hour = NULL WHERE calendar_id = 'LH-SELFTEST';
    res := res || ',' || coalesce(private.help_request_block_reason(em, d + time '12:10'), 'open');

    RAISE EXCEPTION 'RESULT:%', res;
  EXCEPTION WHEN others THEN
    ex_msg := SQLERRM;
    -- first value is how 11.5 reads back: 11.5 / 11.50 depending on column type
    expect := 'open,lunch,lunch,lunch,open,'
           || 'open,lunch,lunch,open,'
           || 'open,lunch,lunch,open,'
           || 'open';
    INSERT INTO _lh_tests VALUES ('help lock at sample times (11:30, 12:30, 12:00, none)',
      ex_msg ~ ('^RESULT:11\.50?,' || expect || '$'), ex_msg);
  END;
END;
$do$;

SELECT n, check_name, ok, detail FROM (
  SELECT 1 AS n, 'INFO: lunch_hour type before' AS check_name, NULL::boolean AS ok,
         (SELECT v FROM _lunch_info WHERE k = 'type_before') AS detail
  UNION ALL
  SELECT 2, 'lunch_hour can hold a half hour',
         (SELECT data_type IN ('numeric', 'text', 'character varying', 'real', 'double precision')
            FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'lab_calendar' AND column_name = 'lunch_hour'),
         (SELECT data_type || coalesce('(' || numeric_precision || ',' || numeric_scale || ')', '')
            FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'lab_calendar' AND column_name = 'lunch_hour')
  UNION ALL
  SELECT 3, 'INFO: existing lunch values (value × days)', NULL,
         (SELECT string_agg(coalesce(lunch_hour::text, 'none') || ' × ' || c, ', ' ORDER BY lunch_hour NULLS FIRST)
            FROM (SELECT lunch_hour, count(*) c FROM public.lab_calendar GROUP BY lunch_hour) x)
  UNION ALL
  SELECT 4, 'rule function NOT callable by app users',
         NOT has_function_privilege('authenticated', 'private.help_request_block_reason(text, timestamp, boolean)', 'EXECUTE'), NULL
  UNION ALL
  SELECT 5, 'help trigger still installed',
         EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.help_requests'::regclass
                    AND tgname = 'help_requests_enforce_availability' AND NOT tgisinternal), NULL
  UNION ALL
  SELECT 10 + row_number() OVER (), 'self-test: ' || test, ok, detail FROM _lh_tests
  UNION ALL
  SELECT 100, 'self-test left no rows behind',
         NOT EXISTS (SELECT 1 FROM public.lab_calendar WHERE calendar_id = 'LH-SELFTEST')
         AND NOT EXISTS (SELECT 1 FROM public.time_clock WHERE record_id = 'LH-SELFTEST'), NULL
) v ORDER BY n;

ROLLBACK;

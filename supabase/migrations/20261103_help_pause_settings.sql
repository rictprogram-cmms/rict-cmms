-- ═════════════════════════════════════════════════════════════════════════════
-- RICT CMMS — Instructor Away Mode: pause help + automatic end time
-- File: supabase/migrations/20261103_help_pause_settings.sql
--
-- What this adds
--   • Two settings rows (category 'System', handled by the Instructor Away
--     Mode card in Settings — they never show as raw rows):
--       instructor_away_blocks_help  'true' | 'false'
--           Away – pause help: students cannot send NEW help requests.
--       instructor_away_until        fake-UTC timestamp text, '' = no end
--           Away Mode turns itself off at this time on every screen.
--   • The logged-out allow-list (policy settings_select_public, from
--     20260928_security_phase2b_lockdown.sql) gains those two keys, so the
--     Lab Status kiosk and TV Display can show "help paused" and clear their
--     AWAY indicators at the end time. All other keys stay hidden.
--   • kiosk_instructor_away_off() (the kiosk's "tap to return" button) also
--     clears the two new keys, so the next Away starts fresh.
--
-- The app works before this is run: the Settings card creates the two rows
-- on first save, logged-in students see them straight away, and the kiosks
-- simply keep today's behaviour (AWAY with no auto-off / pause wording)
-- until the allow-list includes them.
--
-- Not in this migration (suggested follow-up): server-side enforcement of
-- the help-request rules on INSERT into help_requests. Today the rules are
-- enforced by the app (src/lib/helpAvailability.js).
--
-- Dry run: ends in ROLLBACK. Every verification row should show ok = true.
-- Then change the last line to COMMIT and run again.
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Settings rows ────────────────────────────────────────────────────────
INSERT INTO public.settings (setting_key, setting_value, description, category, updated_at, updated_by)
SELECT k, v, d, 'System', now(), 'migration'
FROM (VALUES
  ('instructor_away_blocks_help', 'false',
   'When true (and Away Mode is on), students cannot send new help requests'),
  ('instructor_away_until', '',
   'When Away Mode turns itself off (fake-UTC); empty = no end time')
) AS seed(k, v, d)
WHERE NOT EXISTS (SELECT 1 FROM public.settings s WHERE s.setting_key = seed.k);

-- ── 2. Logged-out screens may read the two new keys ─────────────────────────
DROP POLICY IF EXISTS settings_select_public ON public.settings;
CREATE POLICY settings_select_public
  ON public.settings FOR SELECT TO anon
  USING (setting_key IN (
    'lab_access_mode', 'maintenance_end_at', 'maintenance_message',   -- Time Clock + sign-in
    'grace_period_minutes',                                            -- Time Clock
    'instructor_away_mode', 'instructor_return_time',                  -- Lab Status + TV
    'instructor_away_blocks_help', 'instructor_away_until',            -- Lab Status + TV (2026-11-03)
    'tv_rotation_seconds',                                             -- TV
    'session_timeout_hours'                                            -- sign-in
  ));

-- ── 3. Kiosk "tap to return" clears the new keys too ────────────────────────
-- CREATE OR REPLACE keeps the existing EXECUTE grants (anon, authenticated).
CREATE OR REPLACE FUNCTION public.kiosk_instructor_away_off()
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
BEGIN
  UPDATE public.settings SET setting_value = 'false' WHERE setting_key = 'instructor_away_mode';
  UPDATE public.settings SET setting_value = ''      WHERE setting_key = 'instructor_return_time';
  UPDATE public.settings SET setting_value = 'false' WHERE setting_key = 'instructor_away_blocks_help';
  UPDATE public.settings SET setting_value = ''      WHERE setting_key = 'instructor_away_until';
  RETURN jsonb_build_object('ok', true);
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TEMP TABLE _hp_tests (test text, ok boolean, detail text) ON COMMIT DROP;

DO $do$
DECLARE
  v_n     bigint;
  v_mode  text;
  v_block text;
  v_until text;
BEGIN
  -- Logged-out view: the two new keys are visible, nothing new beyond them
  BEGIN
    EXECUTE 'SET LOCAL ROLE anon';
    SELECT count(*) INTO v_n FROM public.settings
     WHERE setting_key IN ('instructor_away_blocks_help', 'instructor_away_until');
    RAISE EXCEPTION 'visible=%', v_n;
  EXCEPTION WHEN others THEN
    INSERT INTO _hp_tests VALUES ('logged-out sees both new keys', SQLERRM = 'visible=2', SQLERRM);
  END;

  BEGIN
    EXECUTE 'SET LOCAL ROLE anon';
    SELECT count(*) INTO v_n FROM public.settings
     WHERE setting_key NOT IN ('lab_access_mode', 'maintenance_end_at', 'maintenance_message',
                               'grace_period_minutes', 'instructor_away_mode', 'instructor_return_time',
                               'instructor_away_blocks_help', 'instructor_away_until',
                               'tv_rotation_seconds', 'session_timeout_hours');
    RAISE EXCEPTION 'other keys=%', v_n;
  EXCEPTION WHEN others THEN
    INSERT INTO _hp_tests VALUES ('logged-out still sees only allow-listed keys', SQLERRM = 'other keys=0', SQLERRM);
  END;

  -- Kiosk "tap to return" clears all four keys. Runs inside a sub-block that
  -- is rolled back, so live settings are untouched even on COMMIT.
  BEGIN
    UPDATE public.settings SET setting_value = 'true'                   WHERE setting_key = 'instructor_away_mode';
    UPDATE public.settings SET setting_value = 'true'                   WHERE setting_key = 'instructor_away_blocks_help';
    UPDATE public.settings SET setting_value = '2099-01-01T12:00:00+00' WHERE setting_key = 'instructor_away_until';
    EXECUTE 'SET LOCAL ROLE anon';
    PERFORM public.kiosk_instructor_away_off();
    EXECUTE 'RESET ROLE';
    SELECT setting_value INTO v_mode  FROM public.settings WHERE setting_key = 'instructor_away_mode';
    SELECT setting_value INTO v_block FROM public.settings WHERE setting_key = 'instructor_away_blocks_help';
    SELECT setting_value INTO v_until FROM public.settings WHERE setting_key = 'instructor_away_until';
    RAISE EXCEPTION 'mode=% block=% until=%', v_mode, v_block, coalesce(nullif(v_until, ''), '(empty)');
  EXCEPTION WHEN others THEN
    INSERT INTO _hp_tests VALUES ('kiosk away-off clears all four keys (as logged-out)',
      SQLERRM = 'mode=false block=false until=(empty)', SQLERRM);
  END;
END;
$do$;

SELECT n, check_name, ok, detail FROM (
  SELECT 1 AS n, 'settings rows exist' AS check_name,
         (SELECT count(*) FROM public.settings
           WHERE setting_key IN ('instructor_away_blocks_help', 'instructor_away_until')) = 2 AS ok,
         (SELECT string_agg(setting_key || '=' || quote_literal(coalesce(setting_value, '')), ', ')
            FROM public.settings
           WHERE setting_key IN ('instructor_away_mode', 'instructor_return_time',
                                 'instructor_away_blocks_help', 'instructor_away_until')) AS detail
  UNION ALL
  SELECT 2, 'policy settings_select_public present',
         EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname = 'public' AND tablename = 'settings'
                    AND policyname = 'settings_select_public'), NULL
  UNION ALL
  SELECT 3, 'kiosk_instructor_away_off still callable logged-out',
         has_function_privilege('anon', 'public.kiosk_instructor_away_off()', 'EXECUTE'), NULL
  UNION ALL
  SELECT 10 + row_number() OVER (), 'self-test: ' || test, ok, detail FROM _hp_tests
) v ORDER BY n;

ROLLBACK;

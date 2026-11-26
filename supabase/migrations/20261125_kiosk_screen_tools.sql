-- ═════════════════════════════════════════════════════════════════════════════
-- 20261125_kiosk_screen_tools.sql
-- TV Displays: screen info, remote screen settings, screenshots, software update
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Builds on 20261124f (status) and 20261124g (blank / shut down).
--
--   • kiosk_devices.screen_info (jsonb) — what the Pi reports about its screen
--     at each check-in: output, connected, TV name (from the TV's EDID),
--     current mode, modes the TV accepts, rotation, whether the colour
--     setting is normal, and the last settings error.
--   • screen_mode_requested ('auto' or 'WIDTHxHEIGHT') and
--     screen_rotate_requested (normal | left | right | inverted) — chosen in
--     Settings, sent back to the Pi at every check-in, applied by the Pi.
--     NULL = leave the Pi's own setting alone.
--   • pending_command gains 'screenshot' and 'update_software'.
--   • kiosk_screenshots + kiosk_upload_screenshot(token, device, jpeg_b64):
--     the Pi sends a small JPEG of what the browser is drawing; Settings shows
--     it. One row per display (the latest only).
--
-- Access: same as before (Settings view_page / staff). Timestamps real UTC.
-- Dry run first: ends in ROLLBACK. Swap to COMMIT after checking the output.
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Columns on kiosk_devices ─────────────────────────────────────────────
ALTER TABLE public.kiosk_devices
  ADD COLUMN IF NOT EXISTS screen_info                jsonb,
  ADD COLUMN IF NOT EXISTS screen_mode_requested      text,
  ADD COLUMN IF NOT EXISTS screen_rotate_requested    text,
  ADD COLUMN IF NOT EXISTS screen_settings_changed_at timestamptz,
  ADD COLUMN IF NOT EXISTS screen_settings_changed_by text,
  ADD COLUMN IF NOT EXISTS screenshot_taken_at        timestamptz;

ALTER TABLE public.kiosk_devices DROP CONSTRAINT IF EXISTS kiosk_devices_screen_mode_requested_check;
ALTER TABLE public.kiosk_devices ADD CONSTRAINT kiosk_devices_screen_mode_requested_check
  CHECK (screen_mode_requested IS NULL OR screen_mode_requested ~ '^(auto|[0-9]{3,4}x[0-9]{3,4})$');

ALTER TABLE public.kiosk_devices DROP CONSTRAINT IF EXISTS kiosk_devices_screen_rotate_requested_check;
ALTER TABLE public.kiosk_devices ADD CONSTRAINT kiosk_devices_screen_rotate_requested_check
  CHECK (screen_rotate_requested IS NULL OR screen_rotate_requested IN ('normal', 'left', 'right', 'inverted'));

ALTER TABLE public.kiosk_devices DROP CONSTRAINT IF EXISTS kiosk_devices_pending_command_check;
ALTER TABLE public.kiosk_devices ADD CONSTRAINT kiosk_devices_pending_command_check
  CHECK (pending_command IS NULL OR pending_command IN
         ('restart_browser', 'reboot', 'shutdown', 'screenshot', 'update_software'));

GRANT UPDATE (screen_mode_requested, screen_rotate_requested,
              screen_settings_changed_at, screen_settings_changed_by)
  ON public.kiosk_devices TO authenticated;

-- ── 2. Screenshots ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.kiosk_screenshots (
  device_name text PRIMARY KEY REFERENCES public.kiosk_devices(device_name) ON DELETE CASCADE,
  taken_at    timestamptz NOT NULL DEFAULT now(),
  jpeg_b64    text NOT NULL CHECK (length(jpeg_b64) BETWEEN 100 AND 600000)
);
COMMENT ON TABLE public.kiosk_screenshots IS
  'Latest screenshot (what the browser draws) per kiosk, sent by kiosk_upload_screenshot(). Shown in Settings → TV Displays. 2026-11-25.';

ALTER TABLE public.kiosk_screenshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kiosk_screenshots_select ON public.kiosk_screenshots;
CREATE POLICY kiosk_screenshots_select ON public.kiosk_screenshots
  FOR SELECT TO authenticated
  USING (public.is_staff() OR public.has_perm('Settings', 'view_page'));
DROP POLICY IF EXISTS kiosk_screenshots_delete ON public.kiosk_screenshots;
CREATE POLICY kiosk_screenshots_delete ON public.kiosk_screenshots
  FOR DELETE TO authenticated
  USING (public.is_staff() OR public.has_perm('Settings', 'view_page'));
REVOKE ALL ON public.kiosk_screenshots FROM PUBLIC, anon, authenticated;
GRANT SELECT, DELETE ON public.kiosk_screenshots TO authenticated;
GRANT ALL ON public.kiosk_screenshots TO service_role;

CREATE OR REPLACE FUNCTION public.kiosk_upload_screenshot(p_token text, p_device text, p_jpeg_b64 text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
BEGIN
  IF p_token IS NULL OR NOT EXISTS (SELECT 1 FROM public.kiosk_device_tokens t WHERE t.token = p_token) THEN
    RAISE EXCEPTION 'kiosk_upload_screenshot: not authorised' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.kiosk_devices WHERE device_name = p_device) THEN
    RAISE EXCEPTION 'kiosk_upload_screenshot: unknown device' USING ERRCODE = '22023';
  END IF;
  IF p_jpeg_b64 IS NULL OR length(p_jpeg_b64) NOT BETWEEN 100 AND 600000
     OR p_jpeg_b64 !~ '^/9j/[A-Za-z0-9+/=]+$' THEN           -- base64 JPEG only
    RAISE EXCEPTION 'kiosk_upload_screenshot: not a JPEG or too large' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.kiosk_screenshots (device_name, taken_at, jpeg_b64)
  VALUES (p_device, now(), p_jpeg_b64)
  ON CONFLICT (device_name) DO UPDATE SET taken_at = now(), jpeg_b64 = EXCLUDED.jpeg_b64;

  -- Touch the device row so Settings (realtime on kiosk_devices) fetches it
  UPDATE public.kiosk_devices SET screenshot_taken_at = now() WHERE device_name = p_device;

  RETURN jsonb_build_object('ok', true);
END;
$function$;
REVOKE ALL ON FUNCTION public.kiosk_upload_screenshot(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kiosk_upload_screenshot(text, text, text) TO anon, authenticated;

-- ── 3. Check-in: store screen_info, return requested screen settings ───────
CREATE OR REPLACE FUNCTION public.kiosk_heartbeat(p_token text, p_device text, p_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_cmd   text;
  v_row   public.kiosk_devices%ROWTYPE;
  d       jsonb := coalesce(p_data, '{}'::jsonb);
  v_scr   jsonb;
BEGIN
  IF p_token IS NULL OR NOT EXISTS (SELECT 1 FROM public.kiosk_device_tokens t WHERE t.token = p_token) THEN
    RAISE EXCEPTION 'kiosk_heartbeat: not authorised' USING ERRCODE = '42501';
  END IF;
  IF p_device IS NULL OR p_device !~ '^[A-Za-z0-9._-]{1,40}$' THEN
    RAISE EXCEPTION 'kiosk_heartbeat: bad device name' USING ERRCODE = '22023';
  END IF;
  IF octet_length(d::text) > 12000 THEN
    RAISE EXCEPTION 'kiosk_heartbeat: data too large' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.kiosk_devices WHERE device_name = p_device)
     AND (SELECT count(*) FROM public.kiosk_devices) >= 50 THEN
    RAISE EXCEPTION 'kiosk_heartbeat: too many devices' USING ERRCODE = '54000';
  END IF;

  v_scr := CASE WHEN jsonb_typeof(d -> 'screen_info') = 'object'
                 AND octet_length((d -> 'screen_info')::text) <= 8000
               THEN d -> 'screen_info' END;

  INSERT INTO public.kiosk_devices AS k (
    device_name, page_url, page_state, model, ip_address, script_version,
    uptime_sec, browser_uptime_sec, browser_restarts, screen_fixes,
    mem_free_mb, cpu_temp_c, throttled, undervolt_now, undervolt_since_boot,
    hot_now, screen_info, last_seen_at
  ) VALUES (
    p_device,
    left(d ->> 'page_url', 300),
    left(d ->> 'page_state', 30),
    left(d ->> 'model', 80),
    left(d ->> 'ip_address', 100),
    left(d ->> 'script_version', 30),
    CASE WHEN d ->> 'uptime_sec'         ~ '^\d{1,9}$' THEN (d ->> 'uptime_sec')::int END,
    CASE WHEN d ->> 'browser_uptime_sec' ~ '^\d{1,9}$' THEN (d ->> 'browser_uptime_sec')::int END,
    CASE WHEN d ->> 'browser_restarts'   ~ '^\d{1,6}$' THEN (d ->> 'browser_restarts')::int END,
    CASE WHEN d ->> 'screen_fixes'       ~ '^\d{1,6}$' THEN (d ->> 'screen_fixes')::int END,
    CASE WHEN d ->> 'mem_free_mb'        ~ '^\d{1,7}$' THEN (d ->> 'mem_free_mb')::int END,
    CASE WHEN d ->> 'cpu_temp_c'         ~ '^-?\d{1,3}(\.\d+)?$' THEN round((d ->> 'cpu_temp_c')::numeric, 1) END,
    left(d ->> 'throttled', 20),
    CASE WHEN jsonb_typeof(d -> 'undervolt_now')        = 'boolean' THEN (d ->> 'undervolt_now')::boolean END,
    CASE WHEN jsonb_typeof(d -> 'undervolt_since_boot') = 'boolean' THEN (d ->> 'undervolt_since_boot')::boolean END,
    CASE WHEN jsonb_typeof(d -> 'hot_now')              = 'boolean' THEN (d ->> 'hot_now')::boolean END,
    v_scr,
    now()
  )
  ON CONFLICT (device_name) DO UPDATE SET
    page_url             = EXCLUDED.page_url,
    page_state           = EXCLUDED.page_state,
    model                = EXCLUDED.model,
    ip_address           = EXCLUDED.ip_address,
    script_version       = EXCLUDED.script_version,
    uptime_sec           = EXCLUDED.uptime_sec,
    browser_uptime_sec   = EXCLUDED.browser_uptime_sec,
    browser_restarts     = EXCLUDED.browser_restarts,
    screen_fixes         = EXCLUDED.screen_fixes,
    mem_free_mb          = EXCLUDED.mem_free_mb,
    cpu_temp_c           = EXCLUDED.cpu_temp_c,
    throttled            = EXCLUDED.throttled,
    undervolt_now        = EXCLUDED.undervolt_now,
    undervolt_since_boot = EXCLUDED.undervolt_since_boot,
    hot_now              = EXCLUDED.hot_now,
    -- older Pi software doesn't send screen_info: keep the last one
    screen_info          = coalesce(EXCLUDED.screen_info, k.screen_info),
    last_seen_at         = now();

  -- Commands older than 10 minutes are dropped, not run
  UPDATE public.kiosk_devices
     SET last_command         = pending_command || ' (expired)',
         last_command_sent_at = now(),
         pending_command      = NULL
   WHERE device_name = p_device
     AND pending_command IS NOT NULL
     AND command_requested_at IS NOT NULL
     AND command_requested_at < now() - interval '10 minutes';

  -- Hand over any fresh command exactly once
  UPDATE public.kiosk_devices
     SET last_command         = pending_command,
         last_command_sent_at = now(),
         pending_command      = NULL
   WHERE device_name = p_device
     AND pending_command IS NOT NULL
  RETURNING last_command INTO v_cmd;

  SELECT * INTO v_row FROM public.kiosk_devices WHERE device_name = p_device;

  RETURN jsonb_build_object(
    'ok', true,
    'command', v_cmd,
    'blank', coalesce(v_row.screen_blanked, false),
    'screen', jsonb_build_object('mode', v_row.screen_mode_requested,
                                 'rotate', v_row.screen_rotate_requested));
END;
$function$;

COMMENT ON FUNCTION public.kiosk_heartbeat(text, text, jsonb) IS
  'Raspberry Pi kiosk check-in (every 60 s, logged-out). Validates the kiosk token, saves health + screen info, returns and clears a pending command (expires after 10 min), and returns the blank state and requested screen settings. 2026-11-25.';
REVOKE ALL ON FUNCTION public.kiosk_heartbeat(text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kiosk_heartbeat(text, text, jsonb) TO anon, authenticated;

-- ── 4. Verification (one result set) ───────────────────────────────────────
CREATE TEMP TABLE _ks_tests (n int, test text, ok boolean, detail text) ON COMMIT DROP;

DO $t$
DECLARE
  v_tok text;
  v_res jsonb;
  v_jpg text := '/9j/' || repeat('A', 200);
BEGIN
  SELECT token INTO v_tok FROM public.kiosk_device_tokens ORDER BY created_at LIMIT 1;

  v_res := public.kiosk_heartbeat(v_tok, '_selftest', jsonb_build_object(
    'screen_info', jsonb_build_object('output', 'HDMI-1', 'connected', true,
                                      'tv_name', 'TEST TV', 'mode', '1920x1080')));
  INSERT INTO _ks_tests VALUES (10, 'screen info saved',
    (SELECT screen_info ->> 'tv_name' FROM public.kiosk_devices WHERE device_name = '_selftest') = 'TEST TV', v_res::text);

  v_res := public.kiosk_heartbeat(v_tok, '_selftest', '{}'::jsonb);
  INSERT INTO _ks_tests VALUES (11, 'older Pi software keeps last screen info',
    (SELECT screen_info ->> 'tv_name' FROM public.kiosk_devices WHERE device_name = '_selftest') = 'TEST TV', NULL);

  UPDATE public.kiosk_devices SET screen_mode_requested = '1280x720', screen_rotate_requested = 'normal'
   WHERE device_name = '_selftest';
  v_res := public.kiosk_heartbeat(v_tok, '_selftest', '{}'::jsonb);
  INSERT INTO _ks_tests VALUES (12, 'requested screen settings sent to the Pi',
    v_res -> 'screen' ->> 'mode' = '1280x720', v_res::text);

  BEGIN
    UPDATE public.kiosk_devices SET screen_mode_requested = '1920x1080; rm -rf' WHERE device_name = '_selftest';
    INSERT INTO _ks_tests VALUES (13, 'bad resolution text refused', false, 'was accepted!');
  EXCEPTION WHEN check_violation THEN
    INSERT INTO _ks_tests VALUES (13, 'bad resolution text refused', true, SQLERRM);
  END;

  UPDATE public.kiosk_devices SET pending_command = 'update_software', command_requested_at = now()
   WHERE device_name = '_selftest';
  v_res := public.kiosk_heartbeat(v_tok, '_selftest', '{}'::jsonb);
  INSERT INTO _ks_tests VALUES (14, 'update_software handed over', v_res ->> 'command' = 'update_software', v_res::text);

  v_res := public.kiosk_upload_screenshot(v_tok, '_selftest', v_jpg);
  INSERT INTO _ks_tests VALUES (15, 'screenshot stored',
    EXISTS (SELECT 1 FROM public.kiosk_screenshots WHERE device_name = '_selftest')
    AND (SELECT screenshot_taken_at IS NOT NULL FROM public.kiosk_devices WHERE device_name = '_selftest'), v_res::text);

  BEGIN
    PERFORM public.kiosk_upload_screenshot(v_tok, '_selftest', '<script>alert(1)</script>' || repeat('x', 200));
    INSERT INTO _ks_tests VALUES (16, 'non-JPEG upload refused', false, 'was accepted!');
  EXCEPTION WHEN others THEN
    INSERT INTO _ks_tests VALUES (16, 'non-JPEG upload refused', true, SQLERRM);
  END;

  BEGIN
    PERFORM public.kiosk_upload_screenshot('wrong-token-wrong-token-wrong-token', '_selftest', v_jpg);
    INSERT INTO _ks_tests VALUES (17, 'screenshot with wrong token refused', false, 'was accepted!');
  EXCEPTION WHEN others THEN
    INSERT INTO _ks_tests VALUES (17, 'screenshot with wrong token refused', true, SQLERRM);
  END;

  DELETE FROM public.kiosk_devices WHERE device_name = '_selftest';
  INSERT INTO _ks_tests VALUES (18, 'removing a display removes its screenshot',
    NOT EXISTS (SELECT 1 FROM public.kiosk_screenshots WHERE device_name = '_selftest'), NULL);
END
$t$;

SELECT n, test, ok, detail FROM (
  SELECT 1 AS n, 'new columns present' AS test,
         (SELECT count(*) = 6 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'kiosk_devices'
             AND column_name IN ('screen_info', 'screen_mode_requested', 'screen_rotate_requested',
                                 'screen_settings_changed_at', 'screen_settings_changed_by',
                                 'screenshot_taken_at')) AS ok, NULL::text AS detail
  UNION ALL
  SELECT 2, 'logged-out cannot read screenshots',
         NOT has_table_privilege('anon', 'public.kiosk_screenshots', 'SELECT'), NULL
  UNION ALL
  SELECT 3, 'kiosk_upload_screenshot callable logged-out',
         has_function_privilege('anon', 'public.kiosk_upload_screenshot(text, text, text)', 'EXECUTE'), NULL
  UNION ALL
  SELECT 4, 'kiosk_heartbeat still callable logged-out',
         has_function_privilege('anon', 'public.kiosk_heartbeat(text, text, jsonb)', 'EXECUTE'), NULL
  UNION ALL
  SELECT n, test, ok, detail FROM _ks_tests
) v ORDER BY n;

ROLLBACK;

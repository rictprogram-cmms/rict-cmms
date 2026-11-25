-- ═════════════════════════════════════════════════════════════════════════════
-- 20261124g_kiosk_blank_shutdown.sql
-- TV Displays: Blank screen / Show screen, Shut down, and command expiry
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Builds on 20261124f_kiosk_device_status.sql.
--
--   • kiosk_devices.screen_blanked (+ who/when) — a lasting state, not a
--     one-time command: the Pi keeps the screen black (browser closed) until
--     it is set back to false. Returned to the Pi on every check-in as
--     "blank", so reboots and "Reload TVs now" don't bring the picture back.
--   • pending_command may now also be 'shutdown' (Pi powers off; it has to be
--     started again by hand — unplug/replug or a smart plug).
--   • Commands expire after 10 minutes. A shutdown sent to a Pi that is
--     already off must not run the moment it is switched back on after a
--     break. Expired commands are cleared and recorded as "<command> (expired)".
--
-- Who can use it: same as before (Settings view_page / staff). Only the new
-- screen_blanked / blank_changed_* columns are added to the UPDATE grant.
-- Timestamps: real UTC (Convention B).
--
-- Dry run first: ends in ROLLBACK. Swap to COMMIT after checking the output.
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Columns ──────────────────────────────────────────────────────────────
ALTER TABLE public.kiosk_devices
  ADD COLUMN IF NOT EXISTS screen_blanked   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS blank_changed_at timestamptz,
  ADD COLUMN IF NOT EXISTS blank_changed_by text;

ALTER TABLE public.kiosk_devices DROP CONSTRAINT IF EXISTS kiosk_devices_pending_command_check;
ALTER TABLE public.kiosk_devices ADD CONSTRAINT kiosk_devices_pending_command_check
  CHECK (pending_command IS NULL OR pending_command IN ('restart_browser', 'reboot', 'shutdown'));

GRANT UPDATE (screen_blanked, blank_changed_at, blank_changed_by)
  ON public.kiosk_devices TO authenticated;

-- ── 2. Check-in: return "blank", expire old commands ───────────────────────
CREATE OR REPLACE FUNCTION public.kiosk_heartbeat(p_token text, p_device text, p_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_cmd   text;
  v_blank boolean;
  d       jsonb := coalesce(p_data, '{}'::jsonb);
BEGIN
  IF p_token IS NULL OR NOT EXISTS (SELECT 1 FROM public.kiosk_device_tokens t WHERE t.token = p_token) THEN
    RAISE EXCEPTION 'kiosk_heartbeat: not authorised' USING ERRCODE = '42501';
  END IF;
  IF p_device IS NULL OR p_device !~ '^[A-Za-z0-9._-]{1,40}$' THEN
    RAISE EXCEPTION 'kiosk_heartbeat: bad device name' USING ERRCODE = '22023';
  END IF;
  IF octet_length(d::text) > 4000 THEN
    RAISE EXCEPTION 'kiosk_heartbeat: data too large' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.kiosk_devices WHERE device_name = p_device)
     AND (SELECT count(*) FROM public.kiosk_devices) >= 50 THEN
    RAISE EXCEPTION 'kiosk_heartbeat: too many devices' USING ERRCODE = '54000';
  END IF;

  INSERT INTO public.kiosk_devices AS k (
    device_name, page_url, page_state, model, ip_address, script_version,
    uptime_sec, browser_uptime_sec, browser_restarts, screen_fixes,
    mem_free_mb, cpu_temp_c, throttled, undervolt_now, undervolt_since_boot,
    hot_now, last_seen_at
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

  SELECT screen_blanked INTO v_blank FROM public.kiosk_devices WHERE device_name = p_device;

  RETURN jsonb_build_object('ok', true, 'command', v_cmd, 'blank', coalesce(v_blank, false));
END;
$function$;

COMMENT ON FUNCTION public.kiosk_heartbeat(text, text, jsonb) IS
  'Raspberry Pi kiosk check-in (every 60 s, logged-out). Validates the kiosk token, saves health, returns and clears a pending command (expires after 10 min), and returns the blank-screen state. 2026-11-24.';

-- CREATE OR REPLACE keeps grants; restate them anyway
REVOKE ALL ON FUNCTION public.kiosk_heartbeat(text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kiosk_heartbeat(text, text, jsonb) TO anon, authenticated;

-- ── 3. Verification (one result set) ───────────────────────────────────────
CREATE TEMP TABLE _kb_tests (n int, test text, ok boolean, detail text) ON COMMIT DROP;

DO $t$
DECLARE
  v_tok text;
  v_res jsonb;
BEGIN
  SELECT token INTO v_tok FROM public.kiosk_device_tokens ORDER BY created_at LIMIT 1;

  v_res := public.kiosk_heartbeat(v_tok, '_selftest', '{}'::jsonb);
  INSERT INTO _kb_tests VALUES (10, 'new display starts not blanked', (v_res ->> 'blank') = 'false', v_res::text);

  UPDATE public.kiosk_devices SET screen_blanked = true WHERE device_name = '_selftest';
  v_res := public.kiosk_heartbeat(v_tok, '_selftest', '{}'::jsonb);
  INSERT INTO _kb_tests VALUES (11, 'blank is sent to the Pi', (v_res ->> 'blank') = 'true', v_res::text);
  v_res := public.kiosk_heartbeat(v_tok, '_selftest', '{}'::jsonb);
  INSERT INTO _kb_tests VALUES (12, 'blank stays on (not one-time)', (v_res ->> 'blank') = 'true', v_res::text);

  UPDATE public.kiosk_devices SET pending_command = 'shutdown', command_requested_at = now() WHERE device_name = '_selftest';
  v_res := public.kiosk_heartbeat(v_tok, '_selftest', '{}'::jsonb);
  INSERT INTO _kb_tests VALUES (13, 'shutdown handed over', (v_res ->> 'command') = 'shutdown', v_res::text);

  UPDATE public.kiosk_devices SET pending_command = 'shutdown', command_requested_at = now() - interval '11 minutes' WHERE device_name = '_selftest';
  v_res := public.kiosk_heartbeat(v_tok, '_selftest', '{}'::jsonb);
  INSERT INTO _kb_tests VALUES (14, 'command older than 10 min is NOT run', (v_res ->> 'command') IS NULL,
    v_res::text || ' / last_command = ' || (SELECT last_command FROM public.kiosk_devices WHERE device_name = '_selftest'));

  BEGIN
    UPDATE public.kiosk_devices SET pending_command = 'format_disk' WHERE device_name = '_selftest';
    INSERT INTO _kb_tests VALUES (15, 'unknown command refused', false, 'was accepted!');
  EXCEPTION WHEN check_violation THEN
    INSERT INTO _kb_tests VALUES (15, 'unknown command refused', true, SQLERRM);
  END;

  DELETE FROM public.kiosk_devices WHERE device_name = '_selftest';
END
$t$;

SELECT n, test, ok, detail FROM (
  SELECT 1 AS n, 'screen_blanked column present' AS test,
         EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'kiosk_devices'
                    AND column_name = 'screen_blanked') AS ok, NULL::text AS detail
  UNION ALL
  SELECT 2, 'signed-in users may update screen_blanked (RLS still decides who)',
         has_column_privilege('authenticated', 'public.kiosk_devices', 'screen_blanked', 'UPDATE'), NULL
  UNION ALL
  SELECT 3, 'logged-out still cannot touch kiosk_devices',
         NOT has_table_privilege('anon', 'public.kiosk_devices', 'SELECT')
         AND NOT has_column_privilege('anon', 'public.kiosk_devices', 'screen_blanked', 'UPDATE'), NULL
  UNION ALL
  SELECT 4, 'kiosk_heartbeat still callable logged-out',
         has_function_privilege('anon', 'public.kiosk_heartbeat(text, text, jsonb)', 'EXECUTE'), NULL
  UNION ALL
  SELECT n, test, ok, detail FROM _kb_tests
) v ORDER BY n;

ROLLBACK;

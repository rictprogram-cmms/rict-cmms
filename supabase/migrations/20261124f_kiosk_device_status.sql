-- ═════════════════════════════════════════════════════════════════════════════
-- 20261124f_kiosk_device_status.sql
-- TV Display status in Settings — Raspberry Pi kiosks check in every minute
-- ═════════════════════════════════════════════════════════════════════════════
--
-- What this adds
--   • kiosk_devices          one row per Raspberry Pi kiosk (TV Display, Lab
--                            Status, Time Clock…). Health from its last
--                            check-in plus a pending remote command.
--   • kiosk_device_tokens    shared secret(s) the Pis send with each check-in.
--                            No grants and no policies: nothing but the
--                            check-in function can read it.
--   • kiosk_heartbeat(token, device, data)
--                            Called logged-out (anon) by each Pi's watchdog
--                            every 60 s. Checks the token, saves the health
--                            data, and hands back (and clears) any pending
--                            command: 'restart_browser' or 'reboot'.
--
-- Who can see / act
--   Same people who can press "Reload TVs now": has_perm('Settings',
--   'view_page') (or staff). They can read the list, rename a display
--   (label), queue a command, and remove a display. Writes go through RLS;
--   only label / pending_command / command_requested_* are updatable.
--
-- Timestamps: real UTC (Convention B) — set by now() on the server, shown in
-- the UI as "x min ago", never as wall-clock fields.
--
-- The dry run shows a token too, but ROLLBACK throws it away — use the one
-- shown by the COMMIT run.
-- After COMMIT: the verification output shows the kiosk token. Put it on the
-- Pis (setup-kiosk.sh --kiosk-token …). Never commit the token to the repo.
--
-- Dry run first: ends in ROLLBACK. Swap to COMMIT after checking the output.
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Devices ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.kiosk_devices (
  device_name           text PRIMARY KEY
                        CHECK (device_name ~ '^[A-Za-z0-9._-]{1,40}$'),
  label                 text CHECK (label IS NULL OR length(label) <= 60),
  page_url              text,
  page_state            text,        -- ok | blank | error | not_answering | starting
  model                 text,
  ip_address            text,
  script_version        text,
  uptime_sec            integer,
  browser_uptime_sec    integer,
  browser_restarts      integer,     -- since the Pi last started
  screen_fixes          integer,     -- black-screen colour resets since start
  mem_free_mb           integer,
  cpu_temp_c            numeric(5,1),
  throttled             text,        -- raw vcgencmd value, e.g. 0x50005
  undervolt_now         boolean,
  undervolt_since_boot  boolean,
  hot_now               boolean,
  first_seen_at         timestamptz NOT NULL DEFAULT now(),
  last_seen_at          timestamptz,
  pending_command       text CHECK (pending_command IS NULL
                                    OR pending_command IN ('restart_browser', 'reboot')),
  command_requested_at  timestamptz,
  command_requested_by  text,
  last_command          text,
  last_command_sent_at  timestamptz
);

COMMENT ON TABLE public.kiosk_devices IS
  'Raspberry Pi kiosks (TV Display etc.). Written by kiosk_heartbeat() every 60 s; shown in Settings → TV Displays. Real-UTC timestamps (2026-11-24).';

ALTER TABLE public.kiosk_devices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS kiosk_devices_select ON public.kiosk_devices;
CREATE POLICY kiosk_devices_select ON public.kiosk_devices
  FOR SELECT TO authenticated
  USING (public.is_staff() OR public.has_perm('Settings', 'view_page'));

DROP POLICY IF EXISTS kiosk_devices_update ON public.kiosk_devices;
CREATE POLICY kiosk_devices_update ON public.kiosk_devices
  FOR UPDATE TO authenticated
  USING      (public.is_staff() OR public.has_perm('Settings', 'view_page'))
  WITH CHECK (public.is_staff() OR public.has_perm('Settings', 'view_page'));

DROP POLICY IF EXISTS kiosk_devices_delete ON public.kiosk_devices;
CREATE POLICY kiosk_devices_delete ON public.kiosk_devices
  FOR DELETE TO authenticated
  USING (public.is_staff() OR public.has_perm('Settings', 'view_page'));

REVOKE ALL ON public.kiosk_devices FROM PUBLIC, anon, authenticated;
GRANT SELECT, DELETE ON public.kiosk_devices TO authenticated;
GRANT UPDATE (label, pending_command, command_requested_at, command_requested_by)
  ON public.kiosk_devices TO authenticated;
GRANT ALL ON public.kiosk_devices TO service_role;

-- Live updates in Settings (RLS still applies to realtime)
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables
                      WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
                        AND tablename = 'kiosk_devices') THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.kiosk_devices';
  END IF;
END
$do$;

-- ── 2. Token(s) — readable only by the SECURITY DEFINER function ───────────
CREATE TABLE IF NOT EXISTS public.kiosk_device_tokens (
  token       text PRIMARY KEY CHECK (length(token) >= 32),
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.kiosk_device_tokens ENABLE ROW LEVEL SECURITY;
-- (no policies on purpose)
REVOKE ALL ON public.kiosk_device_tokens FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.kiosk_device_tokens TO service_role;

-- One random token, created only if none exists yet
INSERT INTO public.kiosk_device_tokens (token, note)
SELECT replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
       'Raspberry Pi kiosks (created by 20261124f)'
 WHERE NOT EXISTS (SELECT 1 FROM public.kiosk_device_tokens);

-- ── 3. Check-in function (called logged-out by each Pi) ─────────────────────
CREATE OR REPLACE FUNCTION public.kiosk_heartbeat(p_token text, p_device text, p_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_cmd text;
  d     jsonb := coalesce(p_data, '{}'::jsonb);
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
  -- A runaway or abusive client can't fill the table
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

  -- Hand over any pending command exactly once
  UPDATE public.kiosk_devices
     SET last_command         = pending_command,
         last_command_sent_at = now(),
         pending_command      = NULL
   WHERE device_name = p_device
     AND pending_command IS NOT NULL
  RETURNING last_command INTO v_cmd;

  RETURN jsonb_build_object('ok', true, 'command', v_cmd);
END;
$function$;

COMMENT ON FUNCTION public.kiosk_heartbeat(text, text, jsonb) IS
  'Raspberry Pi kiosk check-in (every 60 s, logged-out). Validates the kiosk token, saves health, returns and clears a pending command. 2026-11-24.';

REVOKE ALL ON FUNCTION public.kiosk_heartbeat(text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kiosk_heartbeat(text, text, jsonb) TO anon, authenticated;

-- ── 4. Verification (one result set — the SQL Editor shows only the last) ──
CREATE TEMP TABLE _kd_tests (n int, test text, ok boolean, detail text) ON COMMIT DROP;

DO $t$
DECLARE
  v_tok text;
  v_res jsonb;
BEGIN
  SELECT token INTO v_tok FROM public.kiosk_device_tokens ORDER BY created_at LIMIT 1;

  -- a) good check-in creates the row
  v_res := public.kiosk_heartbeat(v_tok, '_selftest', jsonb_build_object(
             'page_url', 'https://rict-cmms.vercel.app/tv-display', 'page_state', 'ok',
             'cpu_temp_c', 55.3, 'mem_free_mb', 600, 'undervolt_now', false));
  INSERT INTO _kd_tests VALUES (10, 'check-in accepted', (v_res ->> 'ok') = 'true', v_res::text);

  -- b) queued command is returned once, then cleared
  UPDATE public.kiosk_devices SET pending_command = 'restart_browser' WHERE device_name = '_selftest';
  v_res := public.kiosk_heartbeat(v_tok, '_selftest', '{}'::jsonb);
  INSERT INTO _kd_tests VALUES (11, 'command handed over', (v_res ->> 'command') = 'restart_browser', v_res::text);
  v_res := public.kiosk_heartbeat(v_tok, '_selftest', '{}'::jsonb);
  INSERT INTO _kd_tests VALUES (12, 'command only once', (v_res ->> 'command') IS NULL, v_res::text);

  -- c) wrong token refused
  BEGIN
    PERFORM public.kiosk_heartbeat('wrong-token-wrong-token-wrong-token', '_selftest', '{}'::jsonb);
    INSERT INTO _kd_tests VALUES (13, 'wrong token refused', false, 'was accepted!');
  EXCEPTION WHEN others THEN
    INSERT INTO _kd_tests VALUES (13, 'wrong token refused', true, SQLERRM);
  END;

  -- d) bad device name refused
  BEGIN
    PERFORM public.kiosk_heartbeat(v_tok, 'bad name; drop', '{}'::jsonb);
    INSERT INTO _kd_tests VALUES (14, 'bad device name refused', false, 'was accepted!');
  EXCEPTION WHEN others THEN
    INSERT INTO _kd_tests VALUES (14, 'bad device name refused', true, SQLERRM);
  END;

  DELETE FROM public.kiosk_devices WHERE device_name = '_selftest';
END
$t$;

SELECT n, test, ok, detail FROM (
  SELECT 1 AS n, 'kiosk_devices table + RLS' AS test,
         (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.kiosk_devices'::regclass) AS ok,
         NULL::text AS detail
  UNION ALL
  SELECT 2, 'kiosk_device_tokens hidden from logged-out and logged-in users',
         NOT has_table_privilege('anon', 'public.kiosk_device_tokens', 'SELECT')
         AND NOT has_table_privilege('authenticated', 'public.kiosk_device_tokens', 'SELECT'), NULL
  UNION ALL
  SELECT 3, 'logged-out cannot read kiosk_devices',
         NOT has_table_privilege('anon', 'public.kiosk_devices', 'SELECT'), NULL
  UNION ALL
  SELECT 4, 'kiosk_heartbeat callable logged-out',
         has_function_privilege('anon', 'public.kiosk_heartbeat(text, text, jsonb)', 'EXECUTE'), NULL
  UNION ALL
  SELECT 5, 'realtime publication includes kiosk_devices',
         EXISTS (SELECT 1 FROM pg_publication_tables
                  WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
                    AND tablename = 'kiosk_devices'), NULL
  UNION ALL
  SELECT n, test, ok, detail FROM _kd_tests
  UNION ALL
  SELECT 99, 'KIOSK TOKEN (copy for the Pis — do not commit it anywhere)', true,
         (SELECT token FROM public.kiosk_device_tokens ORDER BY created_at LIMIT 1)
) v ORDER BY n;

ROLLBACK;

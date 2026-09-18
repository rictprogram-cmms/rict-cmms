-- ═══════════════════════════════════════════════════════════════════════════
-- RICT CMMS — Weekly work order digest (pg_cron → send-wo-weekly-summary)
-- File: supabase/migrations/20260918_wo_weekly_summary.sql
--
-- Purpose
--   Every Friday at 4:00 PM (America/Chicago) the instructors' shared inbox
--   gets ONE email listing every work order closed in the past 7 days, each
--   with its full work log. Weeks with nothing closed send nothing.
--
--   1. Seeds the recipient as a normal `settings` row (wo_close_summary_email)
--      so it is editable on Settings → General → Work Orders. Blank = off.
--   2. Enables pg_cron + pg_net and schedules two jobs, Friday 21:00 and
--      22:00 UTC. The function only sends when it is 4 PM in Chicago, so
--      exactly one fires: 21:00 UTC during CDT (Mar–Nov), 22:00 UTC during
--      CST (Nov–Mar). pg_cron itself always runs in UTC.
--
-- Auth
--   The jobs send the same `x-webhook-secret` header the push webhooks use
--   (Edge Function secret WEBHOOK_SECRET). That secret can only trigger this
--   digest — it grants no database access — so it is safe in a cron command
--   (which anyone with SQL access can read). Never put the service-role key
--   here.
--
-- BEFORE RUNNING
--   1. Deploy the function:  npx supabase functions deploy send-wo-weekly-summary --no-verify-jwt
--   2. Paste the existing WEBHOOK_SECRET value into v_secret below
--      (Dashboard → Edge Functions → Secrets). Same value the
--      20260901_push_webhook_triggers.sql migration used.
--
-- Safe to re-run: the settings INSERT is skipped when the key exists, and
-- the two jobs are unscheduled and re-created by name.
--
-- Convention
--   Ends in ROLLBACK for a dry run. Swap to COMMIT after the verification
--   SELECT shows: setting_present = true, and 2 jobs, both active, both with
--   has_secret = true.
--
-- Test after COMMIT (SQL Editor) — sends a real digest now, ignoring the
-- hour check and the empty-week rule (add "to":"you@sctcc.edu" to redirect):
--   SELECT net.http_post(
--     url := 'https://jzzfgafwyxabafaqrnho.supabase.co/functions/v1/send-wo-weekly-summary',
--     headers := '{"Content-Type":"application/json","x-webhook-secret":"<secret>"}'::jsonb,
--     body := '{"force":true}'::jsonb);
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Recipient setting ───────────────────────────────────────────────────
INSERT INTO public.settings (setting_key, setting_value, description, category, updated_at, updated_by)
SELECT
  'wo_close_summary_email',
  'RICT@sctcc.edu',
  'Shared inbox that receives the weekly digest of closed work orders (Fridays 4 PM). Blank = off.',
  'Work Orders',
  now(),
  'migration'
WHERE NOT EXISTS (
  SELECT 1 FROM public.settings WHERE setting_key = 'wo_close_summary_email'
);

-- ── 2. Extensions ──────────────────────────────────────────────────────────
-- Same statements Supabase's docs use; both are no-ops if already enabled
-- (pg_net is already on for the push webhooks).
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
GRANT USAGE ON SCHEMA cron TO postgres;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA cron TO postgres;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- ── 3. Schedule ────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_secret text := 'PASTE_SECRET_HERE';
  v_url    text := 'https://jzzfgafwyxabafaqrnho.supabase.co/functions/v1/send-wo-weekly-summary';
  v_hdrs   text;
  v_cmd    text;
  v_job    record;
BEGIN
  IF v_secret = 'PASTE_SECRET_HERE' OR length(v_secret) < 16 THEN
    RAISE EXCEPTION 'Set v_secret to the WEBHOOK_SECRET value before running this migration';
  END IF;

  v_hdrs := json_build_object(
    'Content-Type',     'application/json',
    'x-webhook-secret', v_secret
  )::text;

  -- expectLocalHour 16 = 4 PM in America/Chicago; the function skips otherwise.
  v_cmd := format(
    'SELECT net.http_post(url := %L, headers := %L::jsonb, body := %L::jsonb, timeout_milliseconds := 15000)',
    v_url, v_hdrs, '{"expectLocalHour":16}'
  );

  -- Drop any previous copies so re-running never doubles up.
  FOR v_job IN SELECT jobid FROM cron.job WHERE jobname IN ('wo-weekly-digest-cdt', 'wo-weekly-digest-cst') LOOP
    PERFORM cron.unschedule(v_job.jobid);
  END LOOP;

  -- Friday 21:00 UTC = 4 PM CDT (summer) / 3 PM CST (winter → function skips)
  PERFORM cron.schedule('wo-weekly-digest-cdt', '0 21 * * 5', v_cmd);
  -- Friday 22:00 UTC = 5 PM CDT (summer → function skips) / 4 PM CST (winter)
  PERFORM cron.schedule('wo-weekly-digest-cst', '0 22 * * 5', v_cmd);
END
$$;

-- ── Verification (single SELECT — the SQL Editor shows only the last result)
-- Expected: 2 rows, active = true, has_secret = true, has_bearer = false,
--           setting_present = true, schedule '0 21 * * 5' and '0 22 * * 5'.
SELECT
  j.jobname,
  j.schedule,
  j.active,
  j.command LIKE '%x-webhook-secret%'  AS has_secret,
  j.command LIKE '%Bearer %'           AS has_bearer,
  EXISTS (SELECT 1 FROM public.settings WHERE setting_key = 'wo_close_summary_email') AS setting_present,
  (SELECT setting_value FROM public.settings WHERE setting_key = 'wo_close_summary_email') AS recipient
FROM cron.job j
WHERE j.jobname LIKE 'wo-weekly-digest-%'
ORDER BY j.jobname;

ROLLBACK;
-- COMMIT;

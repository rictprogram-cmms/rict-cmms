-- ═══════════════════════════════════════════════════════════════════════════
-- RICT CMMS — Work order due-date reminders (pg_cron → send-wo-due-reminders)
-- File: supabase/migrations/20261012_wo_due_reminders.sql
--
-- Purpose
--   Every morning at 7:00 AM (America/Chicago) each student assigned to an
--   open work order due within the next N days (default 7) gets one email
--   listing those work orders plus one bell notification (which the existing
--   push-announcements trigger also sends as a phone push). Each student is
--   reminded once per work order per due date.
--
--   1. Creates public.wo_due_reminders — the record of who was reminded about
--      which work order for which due date (unique on all three, so a student
--      is never reminded twice for the same due date, but IS reminded again
--      if an instructor moves the due date). Written only by the Edge
--      Function (service role). Staff can read it; students cannot.
--   2. Seeds the setting wo_due_reminder_days = 7 (Settings → Work Orders →
--      "Due Date Reminder — Days Before"). 0 or blank = reminders off.
--   3. Schedules two daily pg_cron jobs, 12:00 and 13:00 UTC. The function
--      only sends when it is 7 AM in Chicago, so exactly one fires: 12:00 UTC
--      during CDT (Mar–Nov), 13:00 UTC during CST (Nov–Mar).
--
-- Auth
--   Same `x-webhook-secret` header the push webhooks and the Friday digest
--   use (Edge Function secret WEBHOOK_SECRET). It can only trigger this
--   function — it grants no database access. Never put the service-role key
--   in a cron command.
--
-- BEFORE RUNNING
--   1. Deploy the function:  npx supabase functions deploy send-wo-due-reminders --no-verify-jwt
--   2. Paste the existing WEBHOOK_SECRET value into v_secret below (same value
--      used in 20260918_wo_weekly_summary.sql).
--
-- Safe to re-run: table/index/policies use IF NOT EXISTS / DROP IF EXISTS,
-- the settings INSERT is skipped when the key exists, and the two jobs are
-- unscheduled and re-created by name.
--
-- Convention
--   Ends in ROLLBACK for a dry run. Swap to COMMIT after the verification
--   SELECT shows: 2 rows, both active, has_secret = true, has_bearer = false,
--   table_ok = true, rls_on = true, setting_value = '7'.
--
-- Test after COMMIT (SQL Editor). Preview only — sends nothing, records nothing:
--   SELECT net.http_post(
--     url := 'https://jzzfgafwyxabafaqrnho.supabase.co/functions/v1/send-wo-due-reminders',
--     headers := '{"Content-Type":"application/json","x-webhook-secret":"<secret>"}'::jsonb,
--     body := '{"dryRun":true}'::jsonb);
--   -- then read the reply:  SELECT status_code, content FROM net._http_response ORDER BY id DESC LIMIT 1;
-- Real email to YOU only (no bell, nothing recorded, students not contacted):
--     body := '{"force":true,"to":"you@sctcc.edu"}'::jsonb
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('public.is_staff()') IS NULL THEN
    RAISE EXCEPTION 'public.is_staff() not found — security phase 1 must be live first.';
  END IF;
END $$;

-- ── 1. Reminder log ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.wo_due_reminders (
  reminder_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  wo_id            text        NOT NULL,              -- no FK: closed WOs move to work_orders_closed
  due_date         date        NOT NULL,              -- the due date the reminder was about
  recipient_email  text        NOT NULL,              -- lower-case
  days_left        integer,                           -- days until due when sent (0 = due today)
  sent_at          timestamptz NOT NULL DEFAULT now(),-- real UTC
  CONSTRAINT wo_due_reminders_once UNIQUE (wo_id, due_date, recipient_email)
);

CREATE INDEX IF NOT EXISTS wo_due_reminders_recipient_idx
  ON public.wo_due_reminders (recipient_email, sent_at DESC);

COMMENT ON TABLE public.wo_due_reminders IS
  'One row per student reminded about a work order coming due (per due date). Written only by the send-wo-due-reminders Edge Function (service role). Staff can read; students cannot.';

ALTER TABLE public.wo_due_reminders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wo_due_reminders_staff_select ON public.wo_due_reminders;
CREATE POLICY wo_due_reminders_staff_select
  ON public.wo_due_reminders FOR SELECT TO authenticated
  USING (public.is_staff());

REVOKE ALL ON public.wo_due_reminders FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.wo_due_reminders TO authenticated;

-- ── 2. Setting ─────────────────────────────────────────────────────────────
INSERT INTO public.settings (setting_key, setting_value, description, category, updated_at, updated_by)
SELECT
  'wo_due_reminder_days',
  '7',
  'Days before a work order is due that assigned students get a reminder email and bell notification (7 AM daily). 0 = off.',
  'Work Orders',
  now(),
  'migration'
WHERE NOT EXISTS (
  SELECT 1 FROM public.settings WHERE setting_key = 'wo_due_reminder_days'
);

-- ── 3. Extensions — check only ─────────────────────────────────────────────
-- pg_cron and pg_net were enabled by 20260918_wo_weekly_summary.sql. Do NOT
-- re-run CREATE EXTENSION here: even with IF NOT EXISTS it fires Supabase's
-- pg_cron grant event trigger, which fails with
--   2BP01: dependent privileges exist
-- and rolls back the whole migration (seen 2026-10-12).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE EXCEPTION 'pg_cron is not enabled — enable it under Database → Extensions first.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    RAISE EXCEPTION 'pg_net is not enabled — enable it under Database → Extensions first.';
  END IF;
END $$;

-- ── 4. Schedule ────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_secret text := '32be46f6f293749ccacb9dabb4639e4951b5b653aaa4d5d9d199f414a8703bfa';
  v_url    text := 'https://jzzfgafwyxabafaqrnho.supabase.co/functions/v1/send-wo-due-reminders';
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

  -- expectLocalHour 7 = 7 AM in America/Chicago; the function skips otherwise.
  v_cmd := format(
    'SELECT net.http_post(url := %L, headers := %L::jsonb, body := %L::jsonb, timeout_milliseconds := 60000)',
    v_url, v_hdrs, '{"expectLocalHour":7}'
  );

  FOR v_job IN SELECT jobid FROM cron.job WHERE jobname IN ('wo-due-reminders-cdt', 'wo-due-reminders-cst') LOOP
    PERFORM cron.unschedule(v_job.jobid);
  END LOOP;

  -- Daily 12:00 UTC = 7 AM CDT (summer) / 6 AM CST (winter → function skips)
  PERFORM cron.schedule('wo-due-reminders-cdt', '0 12 * * *', v_cmd);
  -- Daily 13:00 UTC = 8 AM CDT (summer → function skips) / 7 AM CST (winter)
  PERFORM cron.schedule('wo-due-reminders-cst', '0 13 * * *', v_cmd);
END
$$;

-- ── Verification (single SELECT — the SQL Editor shows only the last result)
SELECT
  j.jobname,
  j.schedule,
  j.active,
  j.command LIKE '%x-webhook-secret%' AS has_secret,
  j.command LIKE '%Bearer %'          AS has_bearer,
  to_regclass('public.wo_due_reminders') IS NOT NULL AS table_ok,
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.wo_due_reminders'::regclass) AS rls_on,
  (SELECT setting_value FROM public.settings WHERE setting_key = 'wo_due_reminder_days') AS setting_value
FROM cron.job j
WHERE j.jobname LIKE 'wo-due-reminders-%'
ORDER BY j.jobname;

ROLLBACK;
-- COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- RICT CMMS — Put the real WEBHOOK_SECRET into the work-order cron jobs
-- File: supabase/migrations/20261012_fix_cron_webhook_secret.sql
--
-- Bug (2026-10-12)
--   The Friday digest jobs (wo-weekly-digest-cdt / -cst) were created with the
--   literal placeholder 'PASTE_SECRET_HERE' as their x-webhook-secret, so the
--   send-wo-weekly-summary function answered 401 Unauthorized every Friday and
--   no digest was ever sent. The guard in that migration did not catch it
--   because the placeholder is itself 17 characters long. The new due-date
--   reminder jobs (wo-due-reminders-cdt / -cst) may have the same problem.
--
-- Fix
--   Read the secret from the push-announcements trigger (push notifications
--   use the same WEBHOOK_SECRET and work) and write it into the header of all
--   four jobs with cron.alter_job. Nothing to paste — no secret lives in this
--   file, so it is safe to commit.
--
--   If the push trigger itself holds the placeholder, this stops with an
--   error: push notifications would then be broken too, and the secret has to
--   be re-set (see 20260901_push_webhook_triggers.sql).
--
-- Convention
--   Ends in ROLLBACK for a dry run. Swap to COMMIT once every row of the
--   verification SELECT shows secret_matches_push = true and
--   still_placeholder = false.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

DO $$
DECLARE
  v_secret text;
  v_job    record;
  v_n      int := 0;
BEGIN
  SELECT substring(pg_get_triggerdef(t.oid) from '"x-webhook-secret"\s*:\s*"([^"]+)"')
    INTO v_secret
    FROM pg_trigger t
   WHERE t.tgname = 'push-announcements'
   LIMIT 1;

  IF v_secret IS NULL OR v_secret ILIKE '%PASTE%' OR length(v_secret) < 16 THEN
    RAISE EXCEPTION 'Could not read a real secret from the push-announcements trigger (got: %). Push notifications may be broken too — stop and check.',
      coalesce(left(v_secret, 6) || '…', 'nothing');
  END IF;

  FOR v_job IN
    SELECT jobid, command FROM cron.job
     WHERE jobname IN ('wo-weekly-digest-cdt', 'wo-weekly-digest-cst',
                       'wo-due-reminders-cdt', 'wo-due-reminders-cst')
  LOOP
    PERFORM cron.alter_job(
      job_id  := v_job.jobid,
      command := regexp_replace(v_job.command,
                                '("x-webhook-secret"\s*:\s*")[^"]*(")',
                                '\1' || v_secret || '\2')
    );
    v_n := v_n + 1;
  END LOOP;

  RAISE NOTICE 'Updated % cron job(s)', v_n;
END $$;

-- ── Verification (single SELECT). Expect 4 rows (2 if the reminders migration
--    has not been committed yet): active = true, secret_matches_push = true,
--    still_placeholder = false.
SELECT
  j.jobname,
  j.schedule,
  j.active,
  substring(j.command from '"x-webhook-secret"\s*:\s*"([^"]+)"') =
    (SELECT substring(pg_get_triggerdef(t.oid) from '"x-webhook-secret"\s*:\s*"([^"]+)"')
       FROM pg_trigger t WHERE t.tgname = 'push-announcements' LIMIT 1) AS secret_matches_push,
  j.command LIKE '%PASTE_SECRET_HERE%' AS still_placeholder
FROM cron.job j
WHERE j.jobname LIKE 'wo-%'
ORDER BY j.jobname;

ROLLBACK;
-- COMMIT;

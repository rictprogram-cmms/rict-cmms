-- ═══════════════════════════════════════════════════════════════════════════
-- RICT CMMS — Push notification webhook triggers
-- File: supabase/migrations/20260901_push_webhook_triggers.sql
--
-- Purpose
--   Every INSERT on a "needs review" table calls the send-push Edge Function,
--   which pushes to subscribed instructor phones (or, for recipient-specific
--   types, to that one user). These triggers used to live only in the
--   Dashboard (Database → Webhooks). This file makes them version-controlled
--   and idempotent.
--
-- Bug fixed (2026-09-01)
--   The 8 Dashboard-created triggers sent an Authorization bearer that no
--   longer matched the legacy anon / service-role key the function checks
--   against, so send-push answered 401 on every webhook. Only the manual
--   "Send test push" (a direct call with a user session) still worked, which
--   made it look like push only arrives while the app is open.
--
--   Fix: the triggers now send a dedicated `x-webhook-secret` header that
--   send-push verifies against the WEBHOOK_SECRET Edge Function secret. That
--   secret can only trigger a push — it grants no database access, so it is
--   safe to embed in trigger definitions (which are readable via
--   pg_get_triggerdef by anyone with SQL access). Never put the service-role
--   key in a trigger.
--
-- New coverage
--   network_change_requests, absence_requests, asset_checkouts — all already
--   tracked by the NotificationBell, now also pushed. The function itself
--   filters rows (Pending / pending_acknowledgment only).
--
-- BEFORE RUNNING
--   1. Generate a secret (run in SQL Editor, copy the result):
--        SELECT encode(gen_random_bytes(32), 'hex');
--   2. Dashboard → Edge Functions → Secrets → add WEBHOOK_SECRET = <that value>
--   3. Deploy the updated send-push function.
--   4. Paste the same value into `v_secret` below, replacing PASTE_SECRET_HERE.
--
-- Convention
--   Ends in ROLLBACK for a dry run. Swap to COMMIT after the verification
--   SELECT shows 11 rows, all with has_secret = true.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

DO $$
DECLARE
  v_secret text := 'PASTE_SECRET_HERE';
  v_url    text := 'https://jzzfgafwyxabafaqrnho.supabase.co/functions/v1/send-push';
  v_hdrs   text;
  v_tbl    text;
  v_trg    text;
  -- (trigger name, table). Existing 8 keep their Dashboard names so nothing
  -- looks different in Database → Webhooks; 3 new ones follow the same style.
  v_map    text[][] := ARRAY[
    ['push-access-requests',     'access_requests'],
    ['push-wo-requests',         'work_order_requests'],
    ['push-orders',              'orders'],
    ['push-time-requests',       'time_entry_requests'],
    ['push-lab-requests',        'lab_signup_requests'],
    ['push-temp-access',         'temp_access_requests'],
    ['push-help-requests',       'help_requests'],
    ['push-announcements',       'announcements'],
    ['push-network-changes',     'network_change_requests'],
    ['push-absence-requests',    'absence_requests'],
    ['push-asset-checkouts',     'asset_checkouts']
  ];
BEGIN
  IF v_secret = 'PASTE_SECRET_HERE' OR length(v_secret) < 16 THEN
    RAISE EXCEPTION 'Set v_secret to the WEBHOOK_SECRET value before running this migration';
  END IF;

  -- Header JSON exactly as supabase_functions.http_request expects it.
  v_hdrs := json_build_object(
    'Content-Type',     'application/json',
    'x-webhook-secret', v_secret
  )::text;

  FOR i IN 1 .. array_length(v_map, 1) LOOP
    v_trg := v_map[i][1];
    v_tbl := v_map[i][2];

    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', v_trg, v_tbl);

    -- INSERT only (decision 2026-09-01). send-push filters by row status.
    -- 5000 ms timeout matches the Dashboard default; pg_net is async so the
    -- insert itself never waits on the function.
    EXECUTE format(
      'CREATE TRIGGER %I AFTER INSERT ON public.%I FOR EACH ROW '
      'EXECUTE FUNCTION supabase_functions.http_request(%L, %L, %L, %L, %L)',
      v_trg, v_tbl, v_url, 'POST', v_hdrs, '{}', '5000'
    );
  END LOOP;
END
$$;


-- ───────────────────────────────────────────────────────────────────────────
-- Verification (single SELECT — Supabase SQL Editor shows only the last result)
-- Expected: 11 rows, every has_secret = true, every has_bearer = false,
--           every event = 'INSERT'.
-- ───────────────────────────────────────────────────────────────────────────
SELECT
  t.tgname                                                   AS trigger_name,
  t.tgrelid::regclass                                        AS "table",
  CASE WHEN t.tgtype & 4 = 4 THEN 'INSERT' ELSE 'other' END  AS event,
  pg_get_triggerdef(t.oid) LIKE '%x-webhook-secret%'         AS has_secret,
  pg_get_triggerdef(t.oid) LIKE '%Bearer %'                  AS has_bearer,
  count(*) OVER ()                                           AS total_push_triggers
FROM pg_trigger t
WHERE t.tgfoid = 'supabase_functions.http_request'::regproc
  AND NOT t.tgisinternal
ORDER BY t.tgrelid::regclass::text;

ROLLBACK;
-- COMMIT;

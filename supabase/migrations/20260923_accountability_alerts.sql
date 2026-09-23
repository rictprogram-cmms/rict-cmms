-- ═════════════════════════════════════════════════════════════════════════════
-- RICT CMMS — Accountability alerts ("Students to check on")
-- File: supabase/migrations/20260923_accountability_alerts.sql
--
-- Purpose
--   Instructors asked to be told when a student is developing a PATTERN
--   (late 3 of the last 4 lab days, short on sign-ups two weeks running, a
--   week with no punches at all…) without being bombarded. Phase 1 is a
--   Dashboard card fed by this table; phase 2 (a Monday digest e-mail) reads
--   the same rows.
--
-- What it does
--   1. accountability_alerts — one OPEN row per student × rule. A sweep
--      (run from an instructor's browser when the last one is older than
--      `accountability_sweep_hours`) upserts: an existing open alert gets
--      last_seen / weeks_seen / detail refreshed instead of a duplicate; a
--      rule that no longer fires closes its alert (cleared_at). Acknowledge
--      is SHARED across instructors (decision 2026-09-23): it hides the row
--      from the card but leaves it open, so a pattern that persists shows up
--      again as "still open, week N" rather than as a new surprise.
--      Timestamps are REAL UTC (Convention B).
--   2. Settings — every threshold is editable in Settings → General under
--      the "Accountability Report" group (defaults agreed 2026-09-23).
--   3. RLS — instructors only (current_user_is_instructor()).
--
-- Dry run: ends in ROLLBACK. Check the verification rows, swap for COMMIT.
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 1: table
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.accountability_alerts (
  alert_id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_email       text NOT NULL,
  user_name        text,
  term_id          text,
  rule             text NOT NULL,                 -- e.g. noshow_week, late_of4 (see accountabilityAlerts.js)
  tier             text NOT NULL DEFAULT 'watch'  -- 'drastic' | 'watch'
                   CHECK (tier IN ('drastic', 'watch')),
  detail           text,                          -- one line, e.g. "Late 3 of the last 4 lab days (Sep 15, 17, 22)"
  class_ids        text,                          -- comma list of the classes involved, informational
  status           text NOT NULL DEFAULT 'open'   -- 'open' | 'cleared'
                   CHECK (status IN ('open', 'cleared')),
  first_seen       timestamptz NOT NULL DEFAULT now(),
  last_seen        timestamptz NOT NULL DEFAULT now(),
  weeks_seen       integer NOT NULL DEFAULT 1,    -- whole weeks between first_seen and last_seen, +1
  acknowledged_at  timestamptz,
  acknowledged_by  text,                          -- instructor display name
  acknowledged_by_email text,
  cleared_at       timestamptz,
  CONSTRAINT accountability_alerts_email_check CHECK (btrim(user_email) <> '')
);

-- One open alert per student per rule (case-insensitive email)
CREATE UNIQUE INDEX IF NOT EXISTS accountability_alerts_open_idx
  ON public.accountability_alerts (lower(user_email), rule)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS accountability_alerts_status_idx
  ON public.accountability_alerts (status, tier, last_seen DESC);

COMMENT ON TABLE public.accountability_alerts IS
  'Pattern alerts for the instructor Dashboard "Students to check on" card. One open row per student × rule; acknowledge is shared; cleared when the pattern stops firing.';

ALTER TABLE public.accountability_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS accountability_alerts_instructor_select ON public.accountability_alerts;
DROP POLICY IF EXISTS accountability_alerts_instructor_insert ON public.accountability_alerts;
DROP POLICY IF EXISTS accountability_alerts_instructor_update ON public.accountability_alerts;
DROP POLICY IF EXISTS accountability_alerts_instructor_delete ON public.accountability_alerts;

CREATE POLICY accountability_alerts_instructor_select
  ON public.accountability_alerts FOR SELECT TO authenticated
  USING (public.current_user_is_instructor());
CREATE POLICY accountability_alerts_instructor_insert
  ON public.accountability_alerts FOR INSERT TO authenticated
  WITH CHECK (public.current_user_is_instructor());
CREATE POLICY accountability_alerts_instructor_update
  ON public.accountability_alerts FOR UPDATE TO authenticated
  USING (public.current_user_is_instructor())
  WITH CHECK (public.current_user_is_instructor());
CREATE POLICY accountability_alerts_instructor_delete
  ON public.accountability_alerts FOR DELETE TO authenticated
  USING (public.current_user_is_instructor());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.accountability_alerts TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Section 2: settings (thresholds + sweep cadence)
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO public.settings (setting_key, setting_value, description, category, updated_at, updated_by)
SELECT k, v, d, 'Accountability Report', now(), 'migration'
FROM (VALUES
  ('alert_noshow_week',       '2', 'Alert (drastic) when a student has this many no-shows in one week.'),
  ('alert_noshow_4wk',        '3', 'Alert when a student has this many no-shows in the last 4 weeks.'),
  ('alert_late_of4',          '3', 'Alert when this many of the last 4 attended lab days were late arrivals.'),
  ('alert_early_of4',         '3', 'Alert when this many of the last 4 attended lab days were unexcused early departures.'),
  ('alert_short_weeks',       '2', 'Alert when a student has been short on sign-ups this many weeks in a row.'),
  ('alert_deadline_of4',      '3', 'Alert when the Sunday sign-up deadline was missed this many of the last 4 weeks.'),
  ('alert_wo_late_days',      '3', 'Alert when one of the student''s own work orders is this many days past due.'),
  ('alert_gear_days',         '3', 'Alert when checked-out equipment is this many days overdue.'),
  ('accountability_sweep_hours', '6', 'Re-check every student for alert patterns when the last sweep is older than this many hours (runs in the background when an instructor opens the Dashboard).'),
  ('accountability_last_sweep', '', 'Timestamp of the last alert sweep (set automatically).')
) AS t(k, v, d)
WHERE NOT EXISTS (SELECT 1 FROM public.settings s WHERE s.setting_key = t.k);

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification (single result set)
-- Expect: table row (rls=true policies=4), 2 index rows, 10 setting rows.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT 'table' AS kind, c.relname AS name,
       'rls=' || c.relrowsecurity::text || ' policies=' ||
       (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname)::text AS detail
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname = 'accountability_alerts'
UNION ALL
SELECT 'index', indexname, 'ok'
  FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'accountability_alerts' AND indexname LIKE 'accountability_alerts_%'
UNION ALL
SELECT 'setting', setting_key, setting_value
  FROM public.settings
 WHERE setting_key LIKE 'alert\_%' ESCAPE '\' OR setting_key IN ('accountability_sweep_hours', 'accountability_last_sweep')
ORDER BY 1, 2;

ROLLBACK;   -- ← swap for COMMIT after checking the verification output

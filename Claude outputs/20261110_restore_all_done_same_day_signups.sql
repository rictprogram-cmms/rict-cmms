-- ═══════════════════════════════════════════════════════════════════════════
-- RICT CMMS — Repair sign-ups cancelled by an All Done (v2, 2026-11-10)
--
-- Two problems from the old All Done (fixed going forward by
-- 20261110_all_done_keep_started_hours.sql):
--   A. It cancelled hours that had ALREADY STARTED on the day of the All Done
--      (Austin: Tue 8 AM–3 PM, all cancelled at the 3:48 PM swipe).
--   B. The badge swipe ran in the student's own session, so every cancel it
--      made was recorded as cancelled BY THE STUDENT — which the Accountability
--      Report counts as a student late cancel.
--
-- An "All Done cancel" = a Cancelled sign-up whose cancelled_at is within
-- 5 minutes of an All Done marker (time_clock.entry_type = 'All Done') for the
-- same student. (v1 also required "not cancelled by the student" — that is
-- exactly what B broke, so it found 0 rows.)
--
--   1. RESTORE to Confirmed: All Done cancels on the SAME day as the slot where
--      the slot started before the All Done. Skipped if the student already has
--      another Confirmed sign-up in that hour.
--   2. RE-ATTRIBUTE the rest (correctly cancelled, e.g. Thursday): if recorded
--      as the student, set cancelled_by_email to NULL ("not the student") so
--      they never count as the student's late cancels. Status stays Cancelled.
--
-- Range: slot dates below. Default = this week. Widen p_from (e.g. to the
-- first day of the semester) to repair every All Done this term — same rules.
--
-- RUN 1: as written (ROLLBACK). Check the grid. RUN 2: swap to COMMIT.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TEMP TABLE _ad ON COMMIT DROP AS
SELECT s.signup_id, s.user_name, s.user_email, s.class_id, s.date,
       (s.date AT TIME ZONE 'UTC')::date AS slot_date, s.start_time, s.cancelled_at,
       s.cancelled_by_email,
       ((s.cancelled_at AT TIME ZONE 'UTC')::date = (s.date AT TIME ZONE 'UTC')::date
         AND s.start_time::time < (s.cancelled_at AT TIME ZONE 'UTC')::time) AS started_before
  FROM public.lab_signup s
 WHERE s.status = 'Cancelled'
   AND (s.date AT TIME ZONE 'UTC')::date BETWEEN DATE '2026-11-09' AND DATE '2026-11-15'   -- p_from / p_to
   AND s.cancelled_at IS NOT NULL
   AND EXISTS (
         SELECT 1 FROM public.time_clock t
          WHERE lower(t.user_email) = lower(s.user_email)
            AND t.entry_type = 'All Done'
            AND abs(extract(epoch FROM (t.punch_in - s.cancelled_at))) <= 300);

CREATE TEMP TABLE _restore ON COMMIT DROP AS
SELECT a.* FROM _ad a
 WHERE a.started_before
   AND NOT EXISTS (
         SELECT 1 FROM public.lab_signup o
          WHERE lower(o.user_email) = lower(a.user_email)
            AND o.date = a.date AND o.start_time = a.start_time
            AND o.status = 'Confirmed');

CREATE TEMP TABLE _reattr ON COMMIT DROP AS
SELECT a.* FROM _ad a
 WHERE NOT a.started_before
   AND lower(coalesce(a.cancelled_by_email, '')) = lower(a.user_email);

-- 1. Restore (trigger clears cancelled_at / cancelled_by_email)
UPDATE public.lab_signup s SET status = 'Confirmed'
  FROM _restore r WHERE s.signup_id = r.signup_id;

-- 2. Re-attribute (status column not touched, so the stamp trigger doesn't fire)
UPDATE public.lab_signup s SET cancelled_by_email = NULL
  FROM _reattr r WHERE s.signup_id = r.signup_id;

INSERT INTO public.audit_log
  (user_email, user_name, action, entity_type, entity_id, field_changed, old_value, new_value, details)
SELECT '', 'SQL Editor (instructor)', 'Restore Signup (All Done fix)', 'Lab Signup', r.signup_id,
       'status', 'Cancelled', 'Confirmed',
       format('Restored %s (%s) %s %s%s — All Done had cancelled an hour that started before it',
              coalesce(nullif(r.user_name, ''), r.user_email), r.user_email,
              to_char(r.slot_date, 'Dy Mon DD'), to_char(r.start_time::time, 'FMHH12 AM'),
              CASE WHEN coalesce(r.class_id, '') <> '' THEN ' (' || r.class_id || ')' ELSE '' END)
  FROM _restore r
UNION ALL
SELECT '', 'SQL Editor (instructor)', 'Re-attribute Cancel (All Done fix)', 'Lab Signup', r.signup_id,
       'cancelled_by_email', r.cancelled_by_email, '(not the student)',
       format('%s %s %s: cancelled by All Done, not by the student — no longer counts as a student late cancel',
              coalesce(nullif(r.user_name, ''), r.user_email), to_char(r.slot_date, 'Dy Mon DD'),
              to_char(r.start_time::time, 'FMHH12 AM'))
  FROM _reattr r;

-- ── Verification (one grid): summary, then one row per student/day/action ──
SELECT 0 AS sort, 'SUMMARY' AS student, NULL::date AS slot_date, '' AS action, '' AS hours,
       format('restored=%s | reattributed=%s | now_confirmed=%s | audit_rows=%s',
         (SELECT count(*) FROM _restore), (SELECT count(*) FROM _reattr),
         (SELECT count(*) FROM public.lab_signup s JOIN _restore r USING (signup_id) WHERE s.status = 'Confirmed'),
         (SELECT count(*) FROM public.audit_log a
           WHERE a.entity_id IN (SELECT signup_id FROM _restore UNION ALL SELECT signup_id FROM _reattr)
             AND a.action IN ('Restore Signup (All Done fix)', 'Re-attribute Cancel (All Done fix)'))) AS detail
UNION ALL
SELECT 1, coalesce(nullif(user_name, ''), user_email), slot_date, 'restored', count(*)::text,
       string_agg(to_char(start_time::time, 'FMHH12 AM') || coalesce(' ' || nullif(class_id, ''), ''), ', ' ORDER BY start_time)
  FROM _restore GROUP BY user_name, user_email, slot_date
UNION ALL
SELECT 1, coalesce(nullif(user_name, ''), user_email), slot_date, 'stays cancelled, not student', count(*)::text,
       string_agg(to_char(start_time::time, 'FMHH12 AM') || coalesce(' ' || nullif(class_id, ''), ''), ', ' ORDER BY start_time)
  FROM _reattr GROUP BY user_name, user_email, slot_date
ORDER BY sort, student, slot_date, action;

ROLLBACK;
-- COMMIT;

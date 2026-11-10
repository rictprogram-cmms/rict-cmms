-- ═══════════════════════════════════════════════════════════════════════════
-- RICT CMMS — Cancel every active lab sign-up on Mon, Nov 9, 2026 (lab closed: illness)
--
-- Why: the day was marked Closed on the Lab Calendar, but the app only cancels
-- sign-ups for partial closure blocks, so these rows stayed 'Confirmed'. A Closed
-- day prorates the week's required hours down, while the stranded sign-ups still
-- count, so affected students show more hours than they need.
--
-- What it does: sets status = 'Cancelled' (the same thing the app does for a
-- closure; the row is kept for history) and writes one audit_log row per sign-up.
--   • trg_lab_signup_stamp_cancel stamps cancelled_at and leaves
--     cancelled_by_email NULL (no JWT in the SQL Editor). NULL is NOT the
--     student, so these never count as student late-cancels on the
--     Accountability Report.
--   • lab_signup.date is the real-UTC instant of local noon (~18:00Z in
--     November), so matching on the UTC calendar date is safe.
--
-- RUN 1 (dry run): as written, ends in ROLLBACK. Check the single result grid.
-- RUN 2: change ROLLBACK to COMMIT after you confirm the numbers.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- Rows to cancel (captured before the update so the audit and the check use the same set)
CREATE TEMP TABLE _nov9 ON COMMIT DROP AS
SELECT signup_id, user_name, user_email, class_id, start_time, end_time, status AS old_status
  FROM public.lab_signup
 WHERE (date AT TIME ZONE 'UTC')::date = DATE '2026-11-09'
   AND status <> 'Cancelled';

UPDATE public.lab_signup s
   SET status = 'Cancelled'
  FROM _nov9 n
 WHERE s.signup_id = n.signup_id;

INSERT INTO public.audit_log
  (user_email, user_name, action, entity_type, entity_id,
   field_changed, old_value, new_value, details)
SELECT '', 'SQL Editor (instructor)', 'Cancel Signup (Closure)', 'Lab Signup', n.signup_id,
       'status', coalesce(n.old_status, 'Confirmed'), 'Cancelled',
       format('Cancelled %s (%s) Mon, Nov 9, 2026 %s–%s%s — lab closed: instructor illness (cleanup: day was closed after sign-ups were made)',
              coalesce(nullif(n.user_name, ''), n.user_email), n.user_email,
              to_char(n.start_time::time, 'FMHH12:MI AM'), to_char(n.end_time::time, 'FMHH12:MI AM'),
              CASE WHEN coalesce(n.class_id, '') <> '' THEN ' (' || n.class_id || ')' ELSE '' END)
  FROM _nov9 n;

-- ── Verification (one grid) ────────────────────────────────────────────────
-- Top row = summary. The rows below are each student, with hours cancelled and class(es).
-- Expect: still_active_on_nov9 = 0, cancelled_now = rows_found, audit_rows = rows_found,
-- and calendar_status = 'Closed'.
SELECT 0 AS sort, 'SUMMARY' AS student,
       (SELECT count(*) FROM _nov9)::text AS hours_cancelled,
       format('rows_found=%s | cancelled_now=%s | still_active_on_nov9=%s | audit_rows=%s | calendar_status=%s',
         (SELECT count(*) FROM _nov9),
         (SELECT count(*) FROM public.lab_signup s JOIN _nov9 n USING (signup_id) WHERE s.status = 'Cancelled'),
         (SELECT count(*) FROM public.lab_signup
           WHERE (date AT TIME ZONE 'UTC')::date = DATE '2026-11-09' AND status <> 'Cancelled'),
         (SELECT count(*) FROM public.audit_log a JOIN _nov9 n ON a.entity_id = n.signup_id
           WHERE a.action = 'Cancel Signup (Closure)' AND a.user_name = 'SQL Editor (instructor)'),
         coalesce((SELECT string_agg(status, ',') FROM public.lab_calendar
                    WHERE (date AT TIME ZONE 'UTC')::date = DATE '2026-11-09'), '(no calendar row)')
       ) AS detail
UNION ALL
SELECT 1, coalesce(nullif(user_name, ''), user_email), count(*)::text,
       user_email || ' | ' || string_agg(DISTINCT coalesce(nullif(class_id, ''), '(no class)'), ', ')
         || ' | ' || string_agg(to_char(start_time::time, 'FMHH12 AM'), ', ' ORDER BY start_time)
  FROM _nov9
 GROUP BY user_name, user_email
ORDER BY sort, student;

ROLLBACK;
-- COMMIT;

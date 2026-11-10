-- Read-only: every sign-up and every time-clock row for students named Zahara, week of Nov 9–15, 2026.
-- Time-clock rows have NULL in the sign-up columns, so all of them show in one grid.
SELECT 'signup' AS kind, s.signup_id AS id,
       to_char(s.date AT TIME ZONE 'UTC', 'Dy MM/DD') AS day,
       s.start_time::text AS start_or_in, s.class_id, s.status,
       to_char(s.cancelled_at AT TIME ZONE 'UTC', 'MM/DD HH12:MI AM') AS cancelled_at,
       s.cancelled_by_email, to_char(s.created_at AT TIME ZONE 'UTC', 'MM/DD HH12:MI AM') AS created
  FROM public.lab_signup s
 WHERE s.user_email ILIKE '%zahara%'
   AND (s.date AT TIME ZONE 'UTC')::date BETWEEN DATE '2026-11-09' AND DATE '2026-11-15'
UNION ALL
SELECT 'clock', t.record_id,
       to_char(t.punch_in AT TIME ZONE 'UTC', 'Dy MM/DD'),
       to_char(t.punch_in AT TIME ZONE 'UTC', 'HH12:MI AM') || ' → ' || coalesce(to_char(t.punch_out AT TIME ZONE 'UTC', 'HH12:MI AM'), '—'),
       coalesce(nullif(t.class_id::text, ''), t.course_id::text), coalesce(t.entry_type, 'Regular') || ' / ' || t.status,
       NULL, NULL, NULL
  FROM public.time_clock t
 WHERE t.user_email ILIKE '%zahara%'
   AND (t.punch_in AT TIME ZONE 'UTC')::date BETWEEN DATE '2026-11-09' AND DATE '2026-11-15'
ORDER BY day, start_or_in;

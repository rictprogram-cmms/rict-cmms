-- RICT CMMS — accounts that may still be on the leaked temp password.
-- Run in Supabase SQL Editor. Read-only; nothing to COMMIT.
--
-- Anyone who has NEVER signed in was created with the shared temp password
-- and never changed it. Anyone who signed in but never changed it can't be
-- detected from here (Supabase doesn't expose password age), so the safe
-- move is to use the Users page "Reset password" for every row below and,
-- if you want to be thorough, for all accounts created before today.

SELECT
  u.email,
  p.first_name,
  p.last_name,
  p.role,
  p.status,
  u.created_at,
  u.last_sign_in_at
FROM auth.users u
LEFT JOIN public.profiles p ON p.email = u.email
WHERE u.last_sign_in_at IS NULL
ORDER BY u.created_at;

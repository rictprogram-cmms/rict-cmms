-- 20260928_security_invoker_views.sql
-- Fixes Supabase Security Advisor "Security Definer View" on:
--   public.network_subnet_summary
--   public.v_assets_checkout_status   (CRITICAL)
--
-- Switches both views to SECURITY INVOKER so they run with the querying
-- user's permissions and RLS on the underlying tables, instead of the view
-- owner's (which bypasses RLS). Columns and queries are unchanged.
--
-- App impact: none found. Nothing in src/ or supabase/functions reads either
-- view (Network Map / Print / Assets read the base tables directly).
--
-- DRY RUN: runs with ROLLBACK. Check the SELECT output, then change the last
-- line to COMMIT and run again.

BEGIN;

ALTER VIEW public.network_subnet_summary   SET (security_invoker = true);
ALTER VIEW public.v_assets_checkout_status SET (security_invoker = true);

-- Verification (single SELECT - the SQL Editor only shows the last result).
-- Expect 2 rows, both security_invoker = 'true'
SELECT
  c.relname                                                   AS view_name,
  COALESCE(
    (SELECT split_part(opt, '=', 2)
       FROM unnest(c.reloptions) AS opt
      WHERE opt LIKE 'security_invoker=%'),
    'false (not set)')                                        AS security_invoker,
  pg_get_userbyid(c.relowner)                                 AS owner,
  pg_get_viewdef(c.oid, true)                                 AS definition
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('network_subnet_summary', 'v_assets_checkout_status')
ORDER BY c.relname;

ROLLBACK;
-- COMMIT;

-- To undo later:
-- ALTER VIEW public.network_subnet_summary   SET (security_invoker = false);
-- ALTER VIEW public.v_assets_checkout_status SET (security_invoker = false);

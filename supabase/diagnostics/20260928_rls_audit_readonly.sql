-- 20260928_rls_audit_readonly.sql
-- READ-ONLY. Changes nothing. Run in the Supabase SQL Editor and export the
-- result as CSV (Export button) so the fixes can be planned from real data.
--
-- One result set, three kinds of rows:
--   policy    - every RLS policy on public tables + storage.objects
--   function  - SECURITY DEFINER functions: who can execute them, and their body
--   guard     - triggers on profiles (to see if a trigger blocks role changes)

SELECT kind, object_name, detail_1, detail_2, detail_3, body
FROM (
  -- 1. Policies
  SELECT
    'policy'                                   AS kind,
    p.schemaname || '.' || p.tablename         AS object_name,
    p.policyname                               AS detail_1,
    p.cmd || ' / ' || array_to_string(p.roles, ',') AS detail_2,
    p.permissive                               AS detail_3,
    'USING: ' || COALESCE(p.qual, '(none)') ||
    ' | CHECK: ' || COALESCE(p.with_check, '(none)') AS body
  FROM pg_policies p
  WHERE p.schemaname IN ('public', 'storage')

  UNION ALL

  -- 2. SECURITY DEFINER functions in public
  SELECT
    'function',
    'public.' || f.proname || '(' || pg_get_function_identity_arguments(f.oid) || ')',
    CASE WHEN has_function_privilege('anon', f.oid, 'EXECUTE')
         THEN 'anon CAN execute' ELSE 'anon cannot' END,
    CASE WHEN has_function_privilege('authenticated', f.oid, 'EXECUTE')
         THEN 'authenticated CAN execute' ELSE 'authenticated cannot' END,
    COALESCE(array_to_string(f.proconfig, ','), 'no search_path set'),
    f.prosrc
  FROM pg_proc f
  JOIN pg_namespace n ON n.oid = f.pronamespace
  WHERE n.nspname = 'public'
    AND f.prosecdef

  UNION ALL

  -- 3. Triggers on profiles
  SELECT
    'guard',
    'public.profiles',
    t.tgname,
    tf.proname,
    CASE WHEN t.tgenabled = 'D' THEN 'disabled' ELSE 'enabled' END,
    tf.prosrc
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_proc tf ON tf.oid = t.tgfoid
  WHERE n.nspname = 'public' AND c.relname = 'profiles' AND NOT t.tgisinternal
) x
ORDER BY kind, object_name, detail_1;

-- Verification for 0001. Run this after the migration and read the three
-- results. Do not take the migration's success message as evidence.
--
-- Expected:
--   1. rls_enabled   = true
--   2. policy_count  = 0        (RLS on with no policies is the goal, not a warning)
--   3. zero rows               (no grants at all to anon or authenticated)

-- 1. Is RLS actually on?
select relrowsecurity as rls_enabled
  from pg_class
 where oid = 'public.webhook_arrivals'::regclass;

-- 2. Are there any policies? There must be none.
select count(*) as policy_count
  from pg_policies
 where schemaname = 'public'
   and tablename = 'webhook_arrivals';

-- 3. Any surviving grants to the public API roles? There must be none.
select grantee, privilege_type
  from information_schema.role_table_grants
 where table_schema = 'public'
   and table_name = 'webhook_arrivals'
   and grantee in ('anon', 'authenticated');

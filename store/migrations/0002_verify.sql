-- Verification for 0001. Run it and read the three results. Do not take the
-- migration's success message as evidence.
--
-- Expected:
--   1. rls_enabled  = true
--   2. policy_count = 0      (RLS on with no policies is the goal)
--   3. zero rows             (no grants at all to anon or authenticated)

select relrowsecurity as rls_enabled
  from pg_class
 where oid = 'public.store_order_events'::regclass;

select count(*) as policy_count
  from pg_policies
 where schemaname = 'public'
   and tablename = 'store_order_events';

select grantee, privilege_type
  from information_schema.role_table_grants
 where table_schema = 'public'
   and table_name = 'store_order_events'
   and grantee in ('anon', 'authenticated');

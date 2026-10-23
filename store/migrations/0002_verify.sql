-- Verification for 0001. Run it and read the four results. Do not take the
-- migration's success message as evidence.
--
-- Expected:
--   1. rls_enabled  = true
--   2. policy_count = 0      (RLS on with no policies is the goal)
--   3. zero rows             (no grants at all to anon or authenticated)
--   4. service_select = true, service_insert = true

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

-- Can the server role actually read and write? This project does not expose
-- new tables automatically, so a missing grant is silent until the app 503s.
-- has_table_privilege measures the effective right PostgREST will check, not
-- just a row in the grant catalog.
select has_table_privilege('service_role', 'public.store_order_events', 'SELECT') as service_select,
       has_table_privilege('service_role', 'public.store_order_events', 'INSERT') as service_insert;

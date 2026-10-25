-- Verification for 0005. Run it and read the results. Do not take the
-- migration's success message as evidence.
--
-- Expected:
--   1. one row: store_record_event | security_invoker = true | search_path set
--      (config = {search_path=""})
--   2. service_execute = true, anon_execute = false, authenticated_execute = false,
--      public_execute = false
--   3. 'fulfilled', then 'duplicate_ignored'. The block calls the function
--      twice for one made-up event id inside a subtransaction, checks the two
--      answers, then raises on purpose so both rows roll back. No row is left
--      behind. Any other pair raises DEDUPE BROKEN instead.

select p.proname,
       not p.prosecdef as security_invoker,
       p.proconfig as config
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname = 'store_record_event';

select
  has_function_privilege('service_role',
    'public.store_record_event(text, text, text, text, text, text, text)', 'EXECUTE') as service_execute,
  has_function_privilege('anon',
    'public.store_record_event(text, text, text, text, text, text, text)', 'EXECUTE') as anon_execute,
  has_function_privilege('authenticated',
    'public.store_record_event(text, text, text, text, text, text, text)', 'EXECUTE') as authenticated_execute,
  exists (
    select 1
      from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     where p.oid = 'public.store_record_event(text, text, text, text, text, text, text)'::regprocedure
       and a.grantee = 0
       and a.privilege_type = 'EXECUTE'
  ) as public_execute;

do $$
declare
  first_call  text;
  second_call text;
begin
  begin
    first_call  := public.store_record_event('VERIFY-0005', 'VERIFY.0005', null, null, null, 'fulfilled', null);
    second_call := public.store_record_event('VERIFY-0005', 'VERIFY.0005', null, null, null, 'fulfilled', null);
    if first_call is distinct from 'fulfilled' or second_call is distinct from 'duplicate_ignored' then
      raise exception 'DEDUPE BROKEN: got % then %', first_call, second_call;
    end if;
    raise exception using errcode = 'P0V05', message = 'rollback the verify rows';
  exception when sqlstate 'P0V05' then
    raise notice 'fulfilled, then duplicate_ignored';
  end;
end $$;
select 'fulfilled, then duplicate_ignored' as dedupe_check;

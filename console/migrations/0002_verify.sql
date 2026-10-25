-- Verification for 0002. Run it and read the results.
--
-- Expected: the DO block finishes without raising, then one row:
--   purchases_check = 'ok'
-- Failures raise RLS MISSING, POLICY PRESENT, GRANT WRONG, FUNCTION WRONG or
-- CLAIM BROKEN. The claim check runs inside a subtransaction that rolls back
-- on purpose, so no row is left behind.

do $$
declare
  f text;
  ok boolean;
  first_order text;
  second_order text;
  third_order text;
begin
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'public' and c.relname = 'console_purchases' and c.relrowsecurity) then
    raise exception 'RLS MISSING on console_purchases';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'console_purchases') then
    raise exception 'POLICY PRESENT on console_purchases: it must have none';
  end if;
  if has_table_privilege('anon', 'public.console_purchases', 'SELECT,INSERT,UPDATE,DELETE')
     or has_table_privilege('authenticated', 'public.console_purchases', 'SELECT,INSERT,UPDATE,DELETE') then
    raise exception 'GRANT WRONG: anon or authenticated can touch console_purchases';
  end if;
  if not (has_table_privilege('service_role', 'public.console_purchases', 'SELECT')
          and has_table_privilege('service_role', 'public.console_purchases', 'INSERT')
          and has_table_privilege('service_role', 'public.console_purchases', 'UPDATE'))
     or has_table_privilege('service_role', 'public.console_purchases', 'DELETE') then
    raise exception 'GRANT WRONG: service_role needs exactly select, insert, update on console_purchases';
  end if;

  foreach f in array array['public.console_claim_purchase(text)', 'public.console_bank_counts()'] loop
    select not p.prosecdef and p.proconfig = array['search_path=""'] into ok
      from pg_proc p where p.oid = f::regprocedure;
    if ok is distinct from true then
      raise exception 'FUNCTION WRONG: % must be security invoker with search_path ''''', f;
    end if;
    if not has_function_privilege('service_role', f, 'EXECUTE')
       or has_function_privilege('anon', f, 'EXECUTE')
       or has_function_privilege('authenticated', f, 'EXECUTE')
       or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                   where p.oid = f::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE') then
      raise exception 'GRANT WRONG: only service_role may execute %', f;
    end if;
  end loop;

  begin
    insert into public.console_runs (id, kind, plan_source, plan_id, scenario_sha256, session_hash, ip_hash, status)
    values ('20000101000000-000002', 'scenario', 'recorded', 'verify-0002',
            repeat('a', 64), repeat('b', 64), repeat('c', 64), 'running');
    insert into public.console_purchases (order_id, capture_id, buyer_transaction_id, amount, currency, created_at)
    values ('VERIFY-NEWER', 'CAP-2', 'TXN-2', '1.00', 'USD', now()),
           ('VERIFY-OLDER', 'CAP-1', 'TXN-1', '1.00', 'USD', now() - interval '1 day');
    select order_id into first_order from public.console_claim_purchase('20000101000000-000002');
    select order_id into second_order from public.console_claim_purchase('20000101000000-000002');
    select order_id into third_order from public.console_claim_purchase('20000101000000-000002');
    if first_order is distinct from 'VERIFY-OLDER' or second_order is distinct from 'VERIFY-NEWER'
       or third_order is not null then
      raise exception 'CLAIM BROKEN: got %, %, % (want oldest, newer, none)', first_order, second_order, third_order;
    end if;
    raise exception using errcode = 'P0V02', message = 'rollback the verify rows';
  exception when sqlstate 'P0V02' then
    raise notice 'claims draw oldest first and never twice';
  end;
end $$;

select 'ok' as purchases_check;

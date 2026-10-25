-- Verification for 0003. Run it and read the results.
--
-- Expected: the DO block finishes without raising, then one row:
--   plans_counters_check = 'ok'
-- Failures raise RLS MISSING, POLICY PRESENT, GRANT WRONG, FUNCTION WRONG,
-- QUOTA BROKEN or GATE BROKEN. The functional checks run inside a
-- subtransaction that rolls back on purpose, so no row is left behind.

do $$
declare
  t text;
  f text;
  ok boolean;
  k text := repeat('d', 64);
  r record;
begin
  foreach t in array array['console_plans', 'console_counters'] loop
    if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'public' and c.relname = t and c.relrowsecurity) then
      raise exception 'RLS MISSING on %', t;
    end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t) then
      raise exception 'POLICY PRESENT on %: it must have none', t;
    end if;
    if has_table_privilege('anon', 'public.' || t, 'SELECT,INSERT,UPDATE,DELETE')
       or has_table_privilege('authenticated', 'public.' || t, 'SELECT,INSERT,UPDATE,DELETE') then
      raise exception 'GRANT WRONG: anon or authenticated can touch %', t;
    end if;
    if has_table_privilege('service_role', 'public.' || t, 'DELETE') then
      raise exception 'GRANT WRONG: service_role can delete from %', t;
    end if;
  end loop;
  if has_table_privilege('service_role', 'public.console_plans', 'UPDATE') then
    raise exception 'GRANT WRONG: a saved plan must never change';
  end if;
  if not (has_table_privilege('service_role', 'public.console_counters', 'SELECT')
          and has_table_privilege('service_role', 'public.console_counters', 'INSERT')
          and has_table_privilege('service_role', 'public.console_counters', 'UPDATE')
          and has_table_privilege('service_role', 'public.console_plans', 'SELECT')
          and has_table_privilege('service_role', 'public.console_plans', 'INSERT')) then
    raise exception 'GRANT WRONG: service_role is missing a grant it needs';
  end if;

  foreach f in array array[
    'public.console_save_plan(text, text, jsonb, text)',
    'public.console_get_plan(uuid)',
    'public.console_take_daily(text[], text[], integer[])',
    'public.console_daily_used(text, text)',
    'public.console_gate_take(text, integer, integer)',
    'public.console_gate_fail(integer, integer)',
    'public.console_gate_clear(text)'] loop
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
    -- A limit of 2: two takes succeed, the third names the full scope, and
    -- the refused take spent nothing on the other scope.
    if public.console_take_daily(array['model_global', 'model_session'], array['all', k], array[5, 2]) is not null
       or public.console_take_daily(array['model_global', 'model_session'], array['all', k], array[5, 2]) is not null then
      raise exception 'QUOTA BROKEN: a take under the limit was refused';
    end if;
    if public.console_take_daily(array['model_global', 'model_session'], array['all', k], array[5, 2]) is distinct from 'model_session' then
      raise exception 'QUOTA BROKEN: the third take past a limit of 2 was not refused';
    end if;
    if public.console_daily_used('model_global', 'all') <> 2 then
      raise exception 'QUOTA BROKEN: a refused take spent the global quota';
    end if;

    -- Five tries take five slots; the sixth is refused before any hashing.
    for i in 1 .. 5 loop
      select * into r from public.console_gate_take(k, 5, 3600);
      if not r.allowed or r.ip_left <> 5 - i then
        raise exception 'GATE BROKEN: try % was refused or miscounted', i;
      end if;
    end loop;
    select * into r from public.console_gate_take(k, 5, 3600);
    if r.allowed then
      raise exception 'GATE BROKEN: a sixth try within the hour was allowed';
    end if;
    perform public.console_gate_clear(k);
    select * into r from public.console_gate_take(k, 5, 3600);
    if not r.allowed or r.ip_left <> 4 then
      raise exception 'GATE BROKEN: a cleared address was not given 5 fresh tries';
    end if;
    raise exception using errcode = 'P0V03', message = 'rollback the verify rows';
  exception when sqlstate 'P0V03' then
    raise notice 'quotas and gate behave';
  end;
end $$;

select 'ok' as plans_counters_check;

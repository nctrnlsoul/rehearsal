-- Verification for 0004. Run it and read the results.
--
-- Expected: the DO block finishes without raising, then one row:
--   start_run_check = 'ok'
-- Failures raise FUNCTION WRONG, GRANT WRONG or START BROKEN. The functional
-- checks run inside a subtransaction that rolls back on purpose.

do $$
declare
  f text := 'public.console_start_run(text, text, text, text, text, text, text, integer, integer, integer, integer[])';
  ok boolean;
  a text;
  b text;
  c text;
begin
  select not p.prosecdef and p.proconfig = array['search_path=""'] into ok
    from pg_proc p where p.oid = f::regprocedure;
  if ok is distinct from true then
    raise exception 'FUNCTION WRONG: console_start_run must be security invoker with search_path ''''';
  end if;
  if not has_function_privilege('service_role', f, 'EXECUTE')
     or has_function_privilege('anon', f, 'EXECUTE')
     or has_function_privilege('authenticated', f, 'EXECUTE')
     or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
                 where p.oid = f::regprocedure and x.grantee = 0 and x.privilege_type = 'EXECUTE') then
    raise exception 'GRANT WRONG: only service_role may execute console_start_run';
  end if;

  begin
    a := public.console_start_run('20000101000000-00000a', 'scenario', 'recorded', 'verify-0004',
           repeat('a', 64), repeat('b', 64), repeat('c', 64), 20, 5, 5);
    -- A second start while the first is queued is refused and spends nothing.
    b := public.console_start_run('20000101000000-00000b', 'scenario', 'recorded', 'verify-0004',
           repeat('a', 64), repeat('b', 64), repeat('c', 64), 20, 5, 5);
    if a is distinct from 'started' or b is distinct from 'busy' then
      raise exception 'START BROKEN: got % then % (want started, busy)', a, b;
    end if;
    if public.console_daily_used('runs_global', 'all') <> 1 then
      raise exception 'START BROKEN: a busy refusal spent a run';
    end if;
    -- With the slot free and the session at its limit, the session quota refuses.
    update public.console_runs set status = 'complete' where id = '20000101000000-00000a';
    c := public.console_start_run('20000101000000-00000c', 'scenario', 'recorded', 'verify-0004',
           repeat('a', 64), repeat('b', 64), repeat('c', 64), 20, 1, 5);
    if c is distinct from 'runs_session' then
      raise exception 'START BROKEN: a full session quota gave %', c;
    end if;
    if exists (select 1 from public.console_runs where id = '20000101000000-00000c') then
      raise exception 'START BROKEN: a refused start left a row';
    end if;
    raise exception using errcode = 'P0V04', message = 'rollback the verify rows';
  exception when sqlstate 'P0V04' then
    raise notice 'start is all or nothing';
  end;
end $$;

select 'ok' as start_run_check;

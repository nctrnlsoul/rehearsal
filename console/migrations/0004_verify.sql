-- Verification for 0004, and the sweep over EVERYTHING the console owns.
-- Run it last and read the results.
--
-- Expected: the DO block finishes without raising, then one row:
--   start_run_check = 'ok'
-- Failures raise RLS MISSING, POLICY PRESENT, FUNCTION WRONG, GRANT WRONG,
-- UNEXPECTED OBJECT, START BROKEN or CANCEL BROKEN. The functional checks run inside a
-- subtransaction that rolls back on purpose.
--
-- The sweep finds every console_ table, partitioned table, view, sequence and
-- function by name in the catalog, not from a list, so one added later and left
-- open is caught here even if its own verify file forgets it. It reads column
-- grants and the raw ACL too, not only has_table_privilege.

do $$
declare
  rec record;
  ok boolean;
  a text;
  b text;
  c text;
begin
  for rec in select c.oid, c.relname, c.relkind, c.relrowsecurity, c.relacl, c.relowner
               from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relname like 'console\_%'
                and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S') loop
    -- The console reads its tables only through functions. A view runs as its
    -- owner and skips RLS, so a console_ view would expose rows to whoever can
    -- select from it.
    if rec.relkind in ('v', 'm', 'f') then
      raise exception 'UNEXPECTED OBJECT: % is a view or foreign table; the console reads only through functions', rec.relname;
    end if;
    if rec.relkind in ('r', 'p') and not rec.relrowsecurity then
      raise exception 'RLS MISSING on %', rec.relname;
    end if;
    if rec.relkind in ('r', 'p') and exists (select 1 from pg_policies where schemaname = 'public' and tablename = rec.relname) then
      raise exception 'POLICY PRESENT on %: it must have none', rec.relname;
    end if;
    if exists (select 1 from aclexplode(coalesce(rec.relacl, '{}'::aclitem[])) x where x.grantee = 0) then
      raise exception 'GRANT WRONG: PUBLIC holds a privilege on %', rec.relname;
    end if;
    -- has_table_privilege ignores column grants, so they are refused outright.
    if exists (select 1 from pg_attribute a where a.attrelid = rec.oid and not a.attisdropped and a.attacl is not null) then
      raise exception 'GRANT WRONG: % has column-level grants', rec.relname;
    end if;
    -- Read from the ACL itself too, so a privilege no list here names (MAINTAIN
    -- on Postgres 17+, or anything later) is still refused.
    if rec.relkind <> 'S'
       and exists (select 1 from aclexplode(coalesce(rec.relacl, '{}'::aclitem[])) x
                    where x.grantee <> rec.relowner
                      and (x.grantee <> 'service_role'::regrole
                           or x.privilege_type not in ('SELECT', 'INSERT', 'UPDATE'))) then
      raise exception 'GRANT WRONG: % grants something beyond service_role select, insert, update', rec.relname;
    end if;
    if rec.relkind in ('r', 'p') then
      -- Also through role membership, which the ACL alone does not show.
      if has_table_privilege('anon', rec.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         or has_table_privilege('authenticated', rec.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         or has_table_privilege('service_role', rec.oid, 'DELETE,TRUNCATE,REFERENCES,TRIGGER') then
        raise exception 'GRANT WRONG: % grants more than service_role select, insert, update', rec.relname;
      end if;
    elsif exists (select 1 from aclexplode(coalesce(rec.relacl, '{}'::aclitem[])) x where x.grantee <> rec.relowner)
          or has_sequence_privilege('anon', rec.oid, 'USAGE,SELECT,UPDATE')
          or has_sequence_privilege('authenticated', rec.oid, 'USAGE,SELECT,UPDATE')
          or has_sequence_privilege('service_role', rec.oid, 'USAGE,SELECT,UPDATE') then
      raise exception 'GRANT WRONG: sequence % is usable from the API', rec.relname;
    end if;
  end loop;

  for rec in select p.oid, p.oid::regprocedure::text as sig, p.prosecdef, p.proconfig, p.proacl, p.proowner
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname like 'console\_%' loop
    if rec.prosecdef or rec.proconfig is distinct from array['search_path=""'] then
      raise exception 'FUNCTION WRONG: % must be security invoker with search_path ''''', rec.sig;
    end if;
    if not has_function_privilege('service_role', rec.oid, 'EXECUTE')
       or has_function_privilege('anon', rec.oid, 'EXECUTE')
       or has_function_privilege('authenticated', rec.oid, 'EXECUTE')
       or exists (select 1 from aclexplode(coalesce(rec.proacl, acldefault('f', rec.proowner))) x
                   where x.grantee = 0 and x.privilege_type = 'EXECUTE') then
      raise exception 'GRANT WRONG: only service_role may execute %', rec.sig;
    end if;
  end loop;

  -- The two functions this file adds must exist (the sweep passes vacuously on a missing one).
  perform 'public.console_start_run(text, text, text, text, text, text, text, integer, integer, integer, integer[])'::regprocedure;
  perform 'public.console_cancel_start(text)'::regprocedure;

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
    -- A queued run whose worker never started is canceled and its quota given back.
    update public.console_runs set status = 'complete' where status in ('queued', 'running');
    c := public.console_start_run('20000101000000-00000d', 'scenario', 'recorded', 'verify-0004',
           repeat('a', 64), repeat('e', 64), repeat('f', 64), 20, 5, 5);
    if c is distinct from 'started' or public.console_daily_used('runs_global', 'all') <> 2 then
      raise exception 'CANCEL BROKEN: the set-up start gave %', c;
    end if;
    -- Called on its own: SQL does not promise to evaluate an OR left to right,
    -- so the reads below could otherwise run before the cancel.
    ok := public.console_cancel_start('20000101000000-00000d');
    if not ok
       or public.console_daily_used('runs_global', 'all') <> 1
       or public.console_daily_used('runs_session', repeat('e', 64)) <> 0
       or (select status from public.console_runs where id = '20000101000000-00000d') <> 'abandoned' then
      raise exception 'CANCEL BROKEN: a canceled start kept its quota or its slot';
    end if;
    ok := public.console_cancel_start('20000101000000-00000d');
    if ok then
      raise exception 'CANCEL BROKEN: a run was canceled twice';
    end if;
    raise exception using errcode = 'P0V04', message = 'rollback the verify rows';
  exception when sqlstate 'P0V04' then
    raise notice 'start is all or nothing, and a cancel gives it back';
  end;
end $$;

select 'ok' as start_run_check;

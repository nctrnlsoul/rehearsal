-- Verification for 0001. Run it and read the results. Do not take the
-- migration's success message as evidence.
--
-- Expected: the DO block finishes without raising, then one row:
--   runs_check = 'ok'
-- Any failure raises an error naming what is wrong (RLS MISSING, POLICY
-- PRESENT, GRANT WRONG, FUNCTION WRONG, FENCE BROKEN, REAPER BROKEN). The
-- functional checks run inside a subtransaction that rolls back on purpose,
-- so no row is left behind.

do $$
declare
  t text;
  f text;
  ok boolean;
begin
  foreach t in array array['console_runs', 'console_run_events'] loop
    if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'public' and c.relname = t and c.relrowsecurity) then
      raise exception 'RLS MISSING on %', t;
    end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t) then
      raise exception 'POLICY PRESENT on %: this table must have none', t;
    end if;
    if has_table_privilege('anon', 'public.' || t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       or has_table_privilege('authenticated', 'public.' || t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
      raise exception 'GRANT WRONG: anon or authenticated can touch %', t;
    end if;
    if has_table_privilege('service_role', 'public.' || t, 'DELETE,TRUNCATE,REFERENCES,TRIGGER') then
      raise exception 'GRANT WRONG: service_role can delete, truncate, reference or trigger on %', t;
    end if;
  end loop;

  if not (has_table_privilege('service_role', 'public.console_runs', 'SELECT')
          and has_table_privilege('service_role', 'public.console_runs', 'INSERT')
          and has_table_privilege('service_role', 'public.console_runs', 'UPDATE')) then
    raise exception 'GRANT WRONG: service_role needs select, insert, update on console_runs';
  end if;
  if not (has_table_privilege('service_role', 'public.console_run_events', 'SELECT')
          and has_table_privilege('service_role', 'public.console_run_events', 'INSERT')) then
    raise exception 'GRANT WRONG: service_role needs select, insert on console_run_events';
  end if;
  if has_table_privilege('service_role', 'public.console_run_events', 'UPDATE') then
    raise exception 'GRANT WRONG: console_run_events must stay append-only';
  end if;

  foreach f in array array[
    'public.console_mark_running(text)',
    'public.console_save_state(text, jsonb, jsonb)',
    'public.console_heartbeat(text)',
    'public.console_add_events(text, jsonb)',
    'public.console_finish_run(text, text, text)',
    'public.console_reap_runs()',
    'public.console_read_run(text, bigint, integer)',
    'public.console_active_run()'] loop
    select not p.prosecdef and p.proconfig = array['search_path=""']
      into ok
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
    insert into public.console_runs (id, kind, plan_source, plan_id, scenario_sha256, session_hash, ip_hash)
    values ('20000101000000-000001', 'scenario', 'recorded', 'verify-0001',
            repeat('a', 64), repeat('b', 64), repeat('c', 64));
    if not public.console_mark_running('20000101000000-000001') then
      raise exception 'FENCE BROKEN: a queued run could not be marked running';
    end if;
    if public.console_mark_running('20000101000000-000001') then
      raise exception 'FENCE BROKEN: a running run was marked running twice';
    end if;
    if not public.console_save_state('20000101000000-000001', '{"v":1}'::jsonb,
                                     '[{"kind":"step_started","step_id":"a"}]'::jsonb) then
      raise exception 'FENCE BROKEN: a running run refused its state';
    end if;
    -- Pretend the server went quiet 91 seconds ago.
    update public.console_runs set heartbeat_at = now() - interval '91 seconds'
     where id = '20000101000000-000001';
    if public.console_reap_runs() <> 1 then
      raise exception 'REAPER BROKEN: a run silent for 91 s was not abandoned';
    end if;
    if public.console_save_state('20000101000000-000001', '{"v":2}'::jsonb, '[]'::jsonb) then
      raise exception 'FENCE BROKEN: an abandoned run accepted a state write';
    end if;
    raise exception using errcode = 'P0V01', message = 'rollback the verify rows';
  exception when sqlstate 'P0V01' then
    raise notice 'fence and reaper behave';
  end;
end $$;

select 'ok' as runs_check;

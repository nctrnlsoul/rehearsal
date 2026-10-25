-- REHEARSAL console: starting a live run, all or nothing.
--
-- Run in the CONSOLE's own Supabase project (R-040), after 0003. Idempotent.
-- Run 0004_verify.sql afterwards and read every result.
--
-- Clearing dead runs, the one-active-run check, the daily quotas and the
-- insert happen in one transaction. A refused start therefore leaves nothing
-- behind: no row, and no quota spent.
--
-- Returns 'started', 'busy' (a run is already going), or the name of the
-- first daily quota that is full: 'runs_global', 'runs_session' or 'runs_ip',
-- or, for a finder run, 'model_global', 'model_session' or 'model_ip'. A
-- finder run plans its class with one model call, so it takes a run and a
-- model call together: all six quotas in one take, or none.

create or replace function public.console_start_run(
  p_id             text,
  p_kind           text,
  p_plan_source    text,
  p_plan_id        text,
  p_sha            text,
  p_session_hash   text,
  p_ip_hash        text,
  p_limit_global   integer,
  p_limit_session  integer,
  p_limit_ip       integer,
  -- global, session, IP. Required for a finder run, refused for any other.
  p_model_limits   integer[] default null
) returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_full text;
begin
  -- First, so a run whose server died never holds the slot.
  perform public.console_reap_runs();

  -- Two starts at once must not both find the slot free.
  perform pg_advisory_xact_lock(hashtextextended('console_start_run', 0));

  if exists (select 1 from public.console_runs where status in ('queued', 'running')) then
    return 'busy';
  end if;

  if (p_kind = 'finder') <> (p_model_limits is not null) then
    raise exception 'console_start_run: a finder run takes model limits, and only a finder run does';
  end if;
  if p_model_limits is not null and coalesce(array_length(p_model_limits, 1), 0) <> 3 then
    raise exception 'console_start_run: model limits are global, session, IP';
  end if;

  if p_kind = 'finder' then
    v_full := public.console_take_daily(
      array['runs_global', 'runs_session', 'runs_ip', 'model_global', 'model_session', 'model_ip'],
      array['all', p_session_hash, p_ip_hash, 'all', p_session_hash, p_ip_hash],
      array[p_limit_global, p_limit_session, p_limit_ip, p_model_limits[1], p_model_limits[2], p_model_limits[3]]);
  else
    v_full := public.console_take_daily(
      array['runs_global', 'runs_session', 'runs_ip'],
      array['all', p_session_hash, p_ip_hash],
      array[p_limit_global, p_limit_session, p_limit_ip]);
  end if;
  if v_full is not null then
    return v_full;
  end if;

  insert into public.console_runs (id, kind, plan_source, plan_id, scenario_sha256, session_hash, ip_hash)
  values (p_id, p_kind, p_plan_source, p_plan_id, p_sha, p_session_hash, p_ip_hash);
  return 'started';
end;
$$;

-- Undoes a start whose worker could not be handed off: the run is closed as
-- never started and its quotas are given back, so a server error spends
-- nothing and does not hold the one active slot for the reaper's 60 s. Only a
-- run still queued can be canceled; once a worker has marked it running,
-- something may have reached PayPal and the quota stays spent.
create or replace function public.console_cancel_start(p_id text)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  r       public.console_runs%rowtype;
  v_day   timestamptz := date_trunc('day', now() at time zone 'utc') at time zone 'utc';
begin
  update public.console_runs
     set status = 'abandoned', finished_at = now(),
         halt_reason = 'the run never started; nothing was sent to PayPal'
   where id = p_id and status = 'queued'
  returning * into r;
  if not found then
    return false;
  end if;
  insert into public.console_run_events (run_id, kind, data)
  values (p_id, 'run_abandoned', jsonb_build_object('started', false));

  -- The same lock the quota take holds, so a refund never interleaves with a take.
  perform pg_advisory_xact_lock(hashtextextended('console_take_daily', 0));
  update public.console_counters c
     set count = c.count - 1
   where c.window_start = v_day
     and c.count > 0
     and ((c.scope = 'runs_global' and c.key = 'all')
          or (c.scope = 'runs_session' and c.key = r.session_hash)
          or (c.scope = 'runs_ip' and c.key = r.ip_hash)
          or (r.kind = 'finder' and ((c.scope = 'model_global' and c.key = 'all')
                                     or (c.scope = 'model_session' and c.key = r.session_hash)
                                     or (c.scope = 'model_ip' and c.key = r.ip_hash))));
  return true;
end;
$$;

revoke all on function public.console_cancel_start(text) from public, anon, authenticated;
grant execute on function public.console_cancel_start(text) to service_role;

revoke all on function public.console_start_run(text, text, text, text, text, text, text, integer, integer, integer, integer[])
  from public, anon, authenticated;
grant execute on function public.console_start_run(text, text, text, text, text, text, text, integer, integer, integer, integer[])
  to service_role;

notify pgrst, 'reload schema';

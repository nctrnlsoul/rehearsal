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
-- first daily quota that is full: 'runs_global', 'runs_session' or 'runs_ip'.

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
  p_limit_ip       integer
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

  v_full := public.console_take_daily(
    array['runs_global', 'runs_session', 'runs_ip'],
    array['all', p_session_hash, p_ip_hash],
    array[p_limit_global, p_limit_session, p_limit_ip]);
  if v_full is not null then
    return v_full;
  end if;

  insert into public.console_runs (id, kind, plan_source, plan_id, scenario_sha256, session_hash, ip_hash)
  values (p_id, p_kind, p_plan_source, p_plan_id, p_sha, p_session_hash, p_ip_hash);
  return 'started';
end;
$$;

revoke all on function public.console_start_run(text, text, text, text, text, text, text, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.console_start_run(text, text, text, text, text, text, text, integer, integer, integer)
  to service_role;

notify pgrst, 'reload schema';

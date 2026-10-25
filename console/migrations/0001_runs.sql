-- REHEARSAL console: live runs and what happened in them.
--
-- Run in the CONSOLE's own Supabase project (R-040), never the store's or the
-- receiver's: a console bug must not be able to write the demo's evidence.
-- Idempotent: every object is created only if missing, and grants are
-- re-stated. Run 0001_verify.sql afterwards and read every result.
--
-- A run's whole RunState is saved after every step, so a poll always shows the
-- last thing the run knew, and a run whose server died is still readable.

create table if not exists public.console_runs (
  -- Same shape the CLI uses for a run id (RUN_ID_PATTERN), so an id taken
  -- from a URL can never be anything else.
  id              text        primary key
                  constraint console_runs_id_shape check (id ~ '^[0-9]{14}-[0-9a-f]{6}$'),
  kind            text        not null
                  constraint console_runs_kind check (kind in ('scenario', 'finder')),
  plan_source     text        not null
                  constraint console_runs_plan_source check (plan_source in ('recorded', 'planned', 'finder')),
  -- A recorded plan id, a planned plan's uuid, or a finder class id.
  plan_id         text        not null
                  constraint console_runs_plan_id_len check (char_length(plan_id) between 1 and 128),
  -- A finder class is planned inside the run, so it has no digest at start.
  scenario_sha256 text
                  constraint console_runs_sha_shape check (scenario_sha256 ~ '^[0-9a-f]{64}$'),
  -- Hashes only. The raw session token and the caller's address never reach the database.
  session_hash    text        not null
                  constraint console_runs_session_shape check (session_hash ~ '^[0-9a-f]{64}$'),
  ip_hash         text        not null
                  constraint console_runs_ip_shape check (ip_hash ~ '^[0-9a-f]{64}$'),
  status          text        not null default 'queued'
                  constraint console_runs_status check (status in ('queued', 'running', 'complete', 'halted', 'abandoned', 'failed')),
  -- The engine's RunState as last saved. Bounded: a scenario is at most 8
  -- steps hosted, so 64 KB is far above any honest state.
  state           jsonb
                  constraint console_runs_state_size check (state is null or pg_column_size(state) <= 65536),
  halt_reason     text
                  constraint console_runs_halt_reason_len check (char_length(halt_reason) <= 300),
  created_at      timestamptz not null default now(),
  started_at      timestamptz,
  heartbeat_at    timestamptz,
  finished_at     timestamptz,
  constraint console_runs_scenario_has_sha check (kind = 'finder' or scenario_sha256 is not null)
);

-- One live run at a time across the whole deployment. The bank and the
-- sandbox account are shared, so two runs at once could race for a purchase.
-- console_start_run checks this under a lock; the index is the backstop.
create unique index if not exists console_runs_one_active
  on public.console_runs ((true))
  where status in ('queued', 'running');

create index if not exists console_runs_created_idx
  on public.console_runs (created_at desc);

create table if not exists public.console_run_events (
  seq        bigint      generated always as identity primary key,
  run_id     text        not null references public.console_runs (id),
  at         timestamptz not null default now(),
  kind       text        not null
             constraint console_run_events_kind check (kind in (
               'run_started', 'step_started', 'step_finished', 'run_halted',
               'deliveries_wait_started', 'delivery', 'deliveries_wait_ended',
               'run_finished', 'run_abandoned', 'note')),
  step_id    text
             constraint console_run_events_step_len check (char_length(step_id) <= 64),
  -- Ids, statuses and short details only. A PayPal body never belongs here.
  data       jsonb       not null default '{}'::jsonb
             constraint console_run_events_data_size check (pg_column_size(data) <= 4096)
);

create index if not exists console_run_events_run_seq_idx
  on public.console_run_events (run_id, seq);

-- RLS on with ZERO policies: anon and authenticated can do nothing, and the
-- service role bypasses RLS. Do NOT add "force row level security".
alter table public.console_runs enable row level security;
alter table public.console_run_events enable row level security;

-- RLS hides rows; the revoke takes the tables off the API map entirely.
revoke all on public.console_runs from anon, authenticated;
revoke all on public.console_run_events from anon, authenticated;

-- A run's status and state change as it goes, so runs need update (R-042).
-- Events are append-only, like the webhook ledgers (R-008). Nothing deletes.
grant select, insert, update on public.console_runs to service_role;
grant select, insert on public.console_run_events to service_role;

-- -------------------------------------------------------------------------
-- The worker's writes. Each is FENCED on status = 'running': once the reaper
-- has called a run dead, a server that turns out to be alive cannot write
-- another step, and learns so from the false it gets back.
-- -------------------------------------------------------------------------

create or replace function public.console_mark_running(p_id text)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.console_runs
     set status = 'running', started_at = now(), heartbeat_at = now()
   where id = p_id and status = 'queued';
  if not found then
    return false;
  end if;
  insert into public.console_run_events (run_id, kind) values (p_id, 'run_started');
  return true;
end;
$$;

-- State and the events it produced land in one transaction, so a poll never
-- sees a step finished in the events but not in the state, or the reverse.
create or replace function public.console_save_state(p_id text, p_state jsonb, p_events jsonb)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if jsonb_typeof(p_events) is distinct from 'array' then
    raise exception 'console_save_state needs an array of events';
  end if;
  update public.console_runs
     set state = p_state, heartbeat_at = now()
   where id = p_id and status = 'running';
  if not found then
    return false;
  end if;
  insert into public.console_run_events (run_id, kind, step_id, data)
  select p_id, e ->> 'kind', e ->> 'step_id', coalesce(e -> 'data', '{}'::jsonb)
    from jsonb_array_elements(p_events) as e;
  return true;
end;
$$;

create or replace function public.console_heartbeat(p_id text)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.console_runs set heartbeat_at = now()
   where id = p_id and status = 'running';
  return found;
end;
$$;

create or replace function public.console_add_events(p_id text, p_events jsonb)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if jsonb_typeof(p_events) is distinct from 'array' then
    raise exception 'console_add_events needs an array of events';
  end if;
  update public.console_runs set heartbeat_at = now()
   where id = p_id and status = 'running';
  if not found then
    return false;
  end if;
  insert into public.console_run_events (run_id, kind, step_id, data)
  select p_id, e ->> 'kind', e ->> 'step_id', coalesce(e -> 'data', '{}'::jsonb)
    from jsonb_array_elements(p_events) as e;
  return true;
end;
$$;

create or replace function public.console_finish_run(p_id text, p_status text, p_reason text)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_status not in ('complete', 'halted', 'failed') then
    raise exception 'console_finish_run got a status it does not set: %', p_status;
  end if;
  update public.console_runs
     set status = p_status, halt_reason = left(p_reason, 300), finished_at = now(), heartbeat_at = now()
   where id = p_id and status = 'running';
  if not found then
    return false;
  end if;
  insert into public.console_run_events (run_id, kind, data)
  values (p_id, 'run_finished', jsonb_build_object('status', p_status));
  return true;
end;
$$;

-- -------------------------------------------------------------------------
-- The reaper. A Vercel function cannot outlive its maxDuration (800 s on the
-- run route, R-030), and a live worker heartbeats at least every 5 s. So a
-- running run with no heartbeat for 90 s, or started more than 860 s ago, has
-- no server left. A queued run nobody picked up within 60 s never started,
-- so nothing was sent for it. Called on every poll and every start: no cron.
-- -------------------------------------------------------------------------

create or replace function public.console_reap_runs()
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  reaped integer := 0;
  n integer;
begin
  with dead as (
    update public.console_runs
       set status = 'abandoned', finished_at = now(),
           halt_reason = 'the run never started; nothing was sent to PayPal'
     where status = 'queued' and created_at < now() - interval '60 seconds'
    returning id
  )
  insert into public.console_run_events (run_id, kind, data)
  select id, 'run_abandoned', jsonb_build_object('started', false) from dead;
  get diagnostics n = row_count;
  reaped := reaped + n;

  with dead as (
    update public.console_runs
       set status = 'abandoned', finished_at = now(),
           halt_reason = 'the server running this stopped; a step it had started may have written to PayPal'
     where status = 'running'
       and (heartbeat_at is null
            or heartbeat_at < now() - interval '90 seconds'
            or started_at < now() - interval '860 seconds')
    returning id
  )
  insert into public.console_run_events (run_id, kind, data)
  select id, 'run_abandoned', jsonb_build_object('started', true) from dead;
  get diagnostics n = row_count;
  reaped := reaped + n;

  return reaped;
end;
$$;

-- What a poll reads: the run and its events after a cursor. It reaps first, so
-- a run whose server died reads as abandoned on the very next poll. The
-- session and address hashes are never returned. 'now' is the database's
-- clock, so "last contact 12 s ago" is measured on one clock.
create or replace function public.console_read_run(p_id text, p_after bigint, p_limit integer)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  r public.console_runs%rowtype;
  v_events jsonb;
begin
  perform public.console_reap_runs();
  select * into r from public.console_runs where id = p_id;
  if not found then
    return null;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'seq', e.seq, 'at', e.at, 'kind', e.kind, 'step_id', e.step_id, 'data', e.data) order by e.seq), '[]'::jsonb)
    into v_events
    from (select * from public.console_run_events
           where run_id = p_id and seq > coalesce(p_after, 0)
           order by seq
           limit least(greatest(coalesce(p_limit, 200), 1), 200)) e;
  return jsonb_build_object(
    'run', jsonb_build_object(
      'id', r.id, 'kind', r.kind, 'plan_source', r.plan_source, 'plan_id', r.plan_id,
      'scenario_sha256', r.scenario_sha256, 'status', r.status, 'state', r.state,
      'halt_reason', r.halt_reason, 'created_at', r.created_at, 'started_at', r.started_at,
      'heartbeat_at', r.heartbeat_at, 'finished_at', r.finished_at),
    'events', v_events,
    'now', now());
end;
$$;

-- The run holding the one active slot, so a refused start can link to it.
create or replace function public.console_active_run()
returns text
language sql
security invoker
set search_path = ''
stable
as $$
  select id from public.console_runs where status in ('queued', 'running') limit 1;
$$;

-- A new function is executable by PUBLIC, and Supabase's default privileges
-- also grant it to anon and authenticated. Neither may call these.
revoke all on function public.console_mark_running(text) from public, anon, authenticated;
revoke all on function public.console_save_state(text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.console_heartbeat(text) from public, anon, authenticated;
revoke all on function public.console_add_events(text, jsonb) from public, anon, authenticated;
revoke all on function public.console_finish_run(text, text, text) from public, anon, authenticated;
revoke all on function public.console_reap_runs() from public, anon, authenticated;
revoke all on function public.console_read_run(text, bigint, integer) from public, anon, authenticated;
revoke all on function public.console_active_run() from public, anon, authenticated;
grant execute on function public.console_read_run(text, bigint, integer) to service_role;
grant execute on function public.console_active_run() to service_role;
grant execute on function public.console_mark_running(text) to service_role;
grant execute on function public.console_save_state(text, jsonb, jsonb) to service_role;
grant execute on function public.console_heartbeat(text) to service_role;
grant execute on function public.console_add_events(text, jsonb) to service_role;
grant execute on function public.console_finish_run(text, text, text) to service_role;
grant execute on function public.console_reap_runs() to service_role;

notify pgrst, 'reload schema';

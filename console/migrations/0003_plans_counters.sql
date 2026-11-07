-- REHEARSAL console: saved plans, and the counters behind every hosted limit.
--
-- Run in the CONSOLE's own Supabase project (R-040), after 0002. Idempotent.
-- Run 0003_verify.sql afterwards and read every result.

-- "Run this exact plan" posts a plan id and its digest, never a scenario. The
-- server loads the plan from here and recomputes the digest, so nothing the
-- browser sends can change what runs.
create table if not exists public.console_plans (
  id            uuid        primary key default gen_random_uuid(),
  session_hash  text        not null
                constraint console_plans_session_shape check (session_hash ~ '^[0-9a-f]{64}$'),
  -- What the judge typed, kept so the page can show what the plan came from.
  description   text        not null
                constraint console_plans_description_len check (char_length(description) between 1 and 2000),
  scenario      jsonb       not null
                constraint console_plans_scenario_size check (pg_column_size(scenario) <= 32768),
  sha256        text        not null
                constraint console_plans_sha_shape check (sha256 ~ '^[0-9a-f]{64}$'),
  created_at    timestamptz not null default now()
);

alter table public.console_plans enable row level security;
revoke all on public.console_plans from public, anon, authenticated, service_role;
-- A plan never changes once saved: changing it would be a different plan.
grant select, insert on public.console_plans to service_role;

create or replace function public.console_save_plan(p_session_hash text, p_description text, p_scenario jsonb, p_sha text)
returns uuid
language sql
security invoker
set search_path = ''
as $$
  insert into public.console_plans (session_hash, description, scenario, sha256)
  values (p_session_hash, p_description, p_scenario, p_sha)
  returning id;
$$;

-- Any session may load any plan: every judge holds the same passcode, so
-- there is no per-judge boundary to keep. The session hash is not returned.
create or replace function public.console_get_plan(p_id uuid)
returns jsonb
language sql
security invoker
set search_path = ''
stable
as $$
  select jsonb_build_object('id', id, 'description', description, 'scenario', scenario,
                            'sha256', sha256, 'created_at', created_at)
    from public.console_plans where id = p_id;
$$;

-- One row per (scope, key): the count in the current window. Daily scopes use
-- the UTC day; the gate scopes use an hour that starts at an address's first
-- try. Keys are HMACs, never raw addresses.
create table if not exists public.console_counters (
  scope         text        not null
                constraint console_counters_scope check (scope in (
                  'gate_ip', 'gate_global',
                  'runs_global', 'runs_session', 'runs_ip',
                  'model_global', 'model_session', 'model_ip')),
  key           text        not null
                constraint console_counters_key_shape check (key ~ '^[0-9a-f]{64}$' or key = 'all'),
  window_start  timestamptz not null,
  count         integer     not null
                constraint console_counters_count_nonneg check (count >= 0),
  primary key (scope, key)
);

alter table public.console_counters enable row level security;
revoke all on public.console_counters from public, anon, authenticated, service_role;
-- Counts change, so update (R-042). Nothing deletes: an old window is
-- overwritten in place by the next one.
grant select, insert, update on public.console_counters to service_role;

-- -------------------------------------------------------------------------
-- Daily quotas. Several are taken together (global, per session, per IP), and
-- either all are taken or none is, so a refusal never spends a quota. Under one
-- lock, so two requests cannot both see the last slot free. Returns null when
-- taken, or the first scope that is full. A limit under 1 is always full.
-- -------------------------------------------------------------------------

create or replace function public.console_take_daily(p_scopes text[], p_keys text[], p_limits integer[])
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_day   timestamptz := date_trunc('day', now() at time zone 'utc') at time zone 'utc';
  v_n     integer := coalesce(array_length(p_scopes, 1), 0);
  v_count integer;
begin
  if v_n = 0
     or coalesce(array_length(p_keys, 1), 0) <> v_n
     or coalesce(array_length(p_limits, 1), 0) <> v_n then
    raise exception 'console_take_daily needs scopes, keys and limits of one length';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('console_take_daily', 0));

  for i in 1 .. v_n loop
    if p_scopes[i] not in ('runs_global', 'runs_session', 'runs_ip', 'model_global', 'model_session', 'model_ip') then
      raise exception 'console_take_daily got a scope that is not daily: %', p_scopes[i];
    end if;
    if p_limits[i] is null or p_limits[i] < 1 then
      return p_scopes[i];
    end if;
    select case when c.window_start = v_day then c.count else 0 end
      into v_count
      from public.console_counters c
     where c.scope = p_scopes[i] and c.key = p_keys[i];
    if coalesce(v_count, 0) >= p_limits[i] then
      return p_scopes[i];
    end if;
  end loop;

  for i in 1 .. v_n loop
    insert into public.console_counters as c (scope, key, window_start, count)
    values (p_scopes[i], p_keys[i], v_day, 1)
    on conflict (scope, key) do update
      set count = case when c.window_start = v_day then c.count + 1 else 1 end,
          window_start = v_day;
  end loop;
  return null;
end;
$$;

-- Read-only: what is left today, for the page to show before anyone presses.
create or replace function public.console_daily_used(p_scope text, p_key text)
returns integer
language sql
security invoker
set search_path = ''
stable
as $$
  select coalesce((
    select case when c.window_start = date_trunc('day', now() at time zone 'utc') at time zone 'utc'
                then c.count else 0 end
      from public.console_counters c
     where c.scope = p_scope and c.key = p_key), 0);
$$;

-- -------------------------------------------------------------------------
-- The judge gate (R-034, R-036, R-038), shared by every server instance:
--   * a try TAKES its slot before the passcode is hashed, in one atomic
--     upsert, so a burst of parallel guesses cannot all read the same "5
--     left" and all be hashed (the check-then-count race a separate check
--     and count would have);
--   * only the caller's own count refuses anyone;
--   * the global count is of wrong tries, logged when it reaches its
--     ceiling, and refuses no one (R-036);
--   * a window starts at an address's first try and lasts p_window_s;
--   * a correct passcode gives back the one slot its own try took, and
--     nothing more: right passcodes never use up an address's tries, and a
--     judge logging in beside a guesser (a NAT, an IPv6 /64, the one
--     "unknown" bucket) never resets the guesser's count.
-- -------------------------------------------------------------------------

-- Allowed: the slot is taken, ip_left is what remains after it, and since
-- names the window it was taken in (the release needs it). Refused: nothing
-- changes and retry_after_s says when the window ends. Concurrent calls for
-- one key queue on the row, and each re-reads the count it sees.
create or replace function public.console_gate_take(p_key text, p_per_ip integer, p_window_s integer)
returns table (allowed boolean, ip_left integer, retry_after_s integer, since timestamptz)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_window interval := make_interval(secs => p_window_s);
  v_count integer;
  v_since timestamptz;
begin
  if p_per_ip is null or p_per_ip < 1 then
    return query select false, 0, p_window_s, null::timestamptz;
    return;
  end if;

  insert into public.console_counters as c (scope, key, window_start, count)
  values ('gate_ip', p_key, now(), 1)
  on conflict (scope, key) do update
    set count = case when now() - c.window_start >= v_window then 1 else c.count + 1 end,
        window_start = case when now() - c.window_start >= v_window then now() else c.window_start end
    where now() - c.window_start >= v_window or c.count < p_per_ip
  returning c.count, c.window_start into v_count, v_since;

  if v_count is not null then
    return query select true, p_per_ip - v_count, 0, v_since;
    return;
  end if;

  select c.window_start into v_since
    from public.console_counters c
   where c.scope = 'gate_ip' and c.key = p_key;
  return query select false, 0,
    greatest(1, ceil(extract(epoch from (v_since + v_window - now())))::integer), null::timestamptz;
end;
$$;

-- Counts one wrong try toward the global ceiling. True on the one try that
-- brings it to the ceiling, so the caller logs it once. The address's own
-- count was already taken by console_gate_take.
create or replace function public.console_gate_fail(p_global integer, p_window_s integer)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_window interval := make_interval(secs => p_window_s);
  v_global integer;
begin
  insert into public.console_counters as c (scope, key, window_start, count)
  values ('gate_global', 'all', now(), 1)
  on conflict (scope, key) do update
    set count = case when now() - c.window_start >= v_window then 1 else c.count + 1 end,
        window_start = case when now() - c.window_start >= v_window then now() else c.window_start end
  returning c.count into v_global;
  return v_global = p_global;
end;
$$;

-- The slot a correct passcode's try took, given back, and only inside the
-- window it was taken in (p_since, from the take). If that window ended while
-- the passcode was being hashed, a new window has its own count, which this
-- try never added to, so nothing is given back. Never below zero.
create or replace function public.console_gate_release(p_key text, p_since timestamptz)
returns void
language sql
security invoker
set search_path = ''
as $$
  update public.console_counters
     set count = count - 1
   where scope = 'gate_ip' and key = p_key and window_start = p_since and count > 0;
$$;

revoke all on function public.console_save_plan(text, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.console_get_plan(uuid) from public, anon, authenticated;
grant execute on function public.console_save_plan(text, text, jsonb, text) to service_role;
grant execute on function public.console_get_plan(uuid) to service_role;
revoke all on function public.console_take_daily(text[], text[], integer[]) from public, anon, authenticated;
revoke all on function public.console_daily_used(text, text) from public, anon, authenticated;
revoke all on function public.console_gate_take(text, integer, integer) from public, anon, authenticated;
revoke all on function public.console_gate_fail(integer, integer) from public, anon, authenticated;
revoke all on function public.console_gate_release(text, timestamptz) from public, anon, authenticated;
grant execute on function public.console_take_daily(text[], text[], integer[]) to service_role;
grant execute on function public.console_daily_used(text, text) to service_role;
grant execute on function public.console_gate_take(text, integer, integer) to service_role;
grant execute on function public.console_gate_fail(integer, integer) to service_role;
grant execute on function public.console_gate_release(text, timestamptz) to service_role;

notify pgrst, 'reload schema';

-- REHEARSAL sample store: record a verified event at most once per event id,
-- atomically.
--
-- Why: audit 2026-10-25 finding M1. With deduping on, the store looked the
-- event id up and then inserted, in two requests. Two verified deliveries of
-- one event arriving together both saw "not seen yet" and both fulfilled the
-- order. This function does the check and the insert in one transaction,
-- under a lock on the event id, so a second delivery waits for the first to
-- commit and then sees it.
--
-- The planted bug (R-009) stays reproducible: the store calls this function
-- only when DEDUPE_BY_EVENT_ID is true. With the flag false it inserts
-- directly, exactly as before, and event_id stays NOT unique on the table.
--
-- Run in the same Supabase project as 0001 to 0004, BEFORE deploying the
-- store code that calls it. That code answers 500 to every verified delivery
-- until this exists; PayPal retries a 500, so deliveries are delayed, not lost.
-- Idempotent: create or replace, and the grants are re-stated.

create or replace function public.store_record_event(
  p_event_id   text,
  p_event_type text,
  p_capture_id text,
  p_amount     text,
  p_currency   text,
  p_action     text,
  p_cert_host  text
) returns text
language plpgsql
-- Runs with the caller's rights, so it can do nothing service_role's table
-- grant (select, insert) does not already allow.
security invoker
set search_path = ''
as $$
begin
  if p_event_id is null then
    raise exception 'store_record_event needs an event id';
  end if;
  -- Only what the store does with a verified event. Refusals and duplicates
  -- are never passed in; a duplicate is decided here.
  if p_action not in ('fulfilled', 'refund_recorded', 'dispute_noted', 'ignored') then
    raise exception 'store_record_event got an action it does not record: %', p_action;
  end if;

  -- Held to the end of this transaction. Two deliveries of one event id
  -- queue here; different ids almost never share a lock, and when a hash
  -- collides they only wait for each other.
  perform pg_advisory_xact_lock(hashtextextended('store_order_events:' || p_event_id, 0));

  -- Same test the store used before: only a verified, non-refused row counts
  -- as seen, so a forged or unverifiable copy can never mark a real delivery
  -- as a duplicate.
  if exists (
    select 1
      from public.store_order_events
     where event_id = p_event_id
       and verified is true
       and action <> 'refused'
  ) then
    insert into public.store_order_events
      (event_id, event_type, capture_id, amount, currency, action, verified, reason, cert_host)
    values
      (p_event_id, p_event_type, p_capture_id, p_amount, p_currency, 'duplicate_ignored', true, null, p_cert_host);
    return 'duplicate_ignored';
  end if;

  insert into public.store_order_events
    (event_id, event_type, capture_id, amount, currency, action, verified, reason, cert_host)
  values
    (p_event_id, p_event_type, p_capture_id, p_amount, p_currency, p_action, true, null, p_cert_host);
  return p_action;
end;
$$;

-- A new function is executable by PUBLIC, and Supabase's default privileges
-- also grant it to anon and authenticated. Neither may call this.
revoke all on function public.store_record_event(text, text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.store_record_event(text, text, text, text, text, text, text)
  to service_role;

-- PostgREST serves RPCs from its schema cache; ask it to pick this one up now.
notify pgrst, 'reload schema';

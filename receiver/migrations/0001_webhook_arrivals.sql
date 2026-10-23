-- REHEARSAL webhook arrival ledger
--
-- Run this ONCE, in the Supabase SQL editor, on a NEW project.
--
-- Why a table at all: the receiver used to keep arrivals in process memory, and
-- on Vercel the instance that serves a read is not the instance that handled the
-- webhook POST. Arrivals were written into memory nothing could ever read. That
-- was proved directly, not inferred: a self-posted event returned HTTP 200 and
-- was then invisible across three consecutive reads from a stable instance.

create table if not exists public.webhook_arrivals (
  id              bigint generated always as identity primary key,

  -- Nullable on purpose. An event that arrives without an id is still an
  -- arrival worth recording, and a NOT NULL here would make PayPal retry a
  -- malformed delivery forever instead.
  event_id        text,
  event_type      text,

  received_at     timestamptz not null default now(),

  -- null means the receiver held no credentials and did not attempt
  -- verification. It does NOT mean the signature failed.
  verified        boolean,
  verify_detail   text,

  resource_id     text,
  transmission_id text,

  -- Which serverless instance handled the delivery. Diagnostic only now:
  -- correctness no longer depends on it, because the ledger is shared.
  instance_id     text not null
);

-- Deliberately NOT unique on event_id. PayPal redelivers, and a resend has to
-- show up as a second row; counting duplicates is what gate 5 measures.
create index if not exists webhook_arrivals_event_id_idx
  on public.webhook_arrivals (event_id);

create index if not exists webhook_arrivals_received_at_idx
  on public.webhook_arrivals (received_at desc);

-- RLS on with ZERO policies: deny by default, so anon and authenticated can do
-- nothing at all. The service role bypasses RLS, which is how the receiver
-- writes. Do NOT add "force row level security": that subjects the table owner
-- to RLS too and would break the service-role path.
alter table public.webhook_arrivals enable row level security;

-- RLS hides ROWS. Table grants still let anon and authenticated introspect the
-- table and its column names through PostgREST and pg_graphql, which advertises
-- that a payment-event table exists even when no row can be read. Revoking
-- removes it from the API surface entirely.
-- RLS is the lock; the revoke takes the door off the map.
revoke all on public.webhook_arrivals from anon, authenticated;

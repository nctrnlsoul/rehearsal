-- REHEARSAL sample store: the merchant app's own order ledger.
--
-- Run this ONCE, in the SQL editor of the SAME Supabase project the receiver
-- uses. It is a separate table, with the same deny-by-default posture.
--
-- This table belongs to the app UNDER TEST, not to REHEARSAL. It deliberately
-- contains a planted bug's consequences: a resent PAYMENT.CAPTURE.COMPLETED
-- produces a SECOND row with action = 'fulfilled' for the same capture, because
-- the store does not dedupe by event id.

create table if not exists public.store_order_events (
  id              bigint generated always as identity primary key,

  -- The PayPal webhook event id. Nullable for the same reason as the receiver's
  -- ledger: an event with no id is still something the store saw.
  event_id        text,
  event_type      text        not null,

  -- The capture this concerns, which is the store's notion of an order.
  capture_id      text,
  amount          text,
  currency        text,

  -- What the merchant app DID: fulfilled, refund_recorded, dispute_noted,
  -- duplicate_ignored, or ignored.
  action          text        not null,

  -- null means the store held no credentials and did not attempt verification.
  verified        boolean,

  received_at     timestamptz not null default now()
);

-- Deliberately NOT unique on event_id. The planted bug must be able to happen,
-- and a database constraint would hide it rather than let the finder catch it.
create index if not exists store_order_events_capture_idx
  on public.store_order_events (capture_id);

create index if not exists store_order_events_event_idx
  on public.store_order_events (event_id);

create index if not exists store_order_events_received_idx
  on public.store_order_events (received_at desc);

-- RLS on with ZERO policies: anon and authenticated can do nothing. The service
-- role bypasses RLS, which is how the store writes.
-- Do NOT add "force row level security": it would subject the owner too.
alter table public.store_order_events enable row level security;

-- RLS hides ROWS; table grants would still let anon and authenticated
-- introspect the table and its column names through PostgREST and pg_graphql.
-- RLS is the lock; the revoke takes the door off the map.
revoke all on public.store_order_events from anon, authenticated;

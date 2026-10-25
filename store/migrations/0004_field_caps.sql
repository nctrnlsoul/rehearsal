-- REHEARSAL sample store: cap every text column the public webhook can fill.
--
-- Why: audit 2026-10-25 finding H1. One unauthenticated POST stored about
-- 990 KB, because a refused delivery copied the request's own fields into its
-- row. The app now records a refused delivery as its reason only and caps every
-- event field at 128 characters (MAX_FIELD_CHARS in lib/merchant.ts); these
-- constraints are the backstop if the app ever stops doing that.
--
-- Run in the same Supabase project as 0001 to 0003. Safe to run before or after
-- deploying the matching store code: that code never writes a value these
-- constraints refuse. Every statement is idempotent.
--
-- NOT VALID on purpose: existing rows (including the audit's oversized probe
-- rows) are not checked, so this cannot fail on old data, while every new
-- insert is. The ledger is append-only, so nothing here deletes or rewrites a
-- row. Cleaning up old oversized rows, if wanted, is a separate decision.

alter table public.store_order_events
  drop constraint if exists store_order_events_event_id_len;
alter table public.store_order_events
  add constraint store_order_events_event_id_len
  check (event_id is null or char_length(event_id) <= 128) not valid;

alter table public.store_order_events
  drop constraint if exists store_order_events_event_type_len;
alter table public.store_order_events
  add constraint store_order_events_event_type_len
  check (char_length(event_type) <= 128) not valid;

alter table public.store_order_events
  drop constraint if exists store_order_events_capture_id_len;
alter table public.store_order_events
  add constraint store_order_events_capture_id_len
  check (capture_id is null or char_length(capture_id) <= 128) not valid;

alter table public.store_order_events
  drop constraint if exists store_order_events_amount_len;
alter table public.store_order_events
  add constraint store_order_events_amount_len
  check (amount is null or char_length(amount) <= 128) not valid;

alter table public.store_order_events
  drop constraint if exists store_order_events_currency_len;
alter table public.store_order_events
  add constraint store_order_events_currency_len
  check (currency is null or char_length(currency) <= 128) not valid;

-- The app only ever writes one of six short words here.
alter table public.store_order_events
  drop constraint if exists store_order_events_action_len;
alter table public.store_order_events
  add constraint store_order_events_action_len
  check (char_length(action) <= 32) not valid;

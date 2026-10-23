-- REHEARSAL sample store: record WHY a delivery was refused.
--
-- Run this ONCE, in the same Supabase project, BEFORE deploying the store code
-- that writes it. That code selects and inserts this column, so deploying first
-- makes every read and write fail with a 400 until this has run.
--
-- Why: a delivery the store refused (bad signature, missing PayPal headers, a
-- body that is not JSON) used to be recorded as "ignored" with no reason, or
-- not at all. A refused resend was then indistinguishable from one that never
-- arrived, which is exactly the question the edge-case finder has to answer.

alter table public.store_order_events
  add column if not exists reason text;

-- The webhook endpoint is public, so whatever lands here is bounded. The app
-- truncates to 200 characters; this is the backstop if it ever does not.
alter table public.store_order_events
  drop constraint if exists store_order_events_reason_len;
alter table public.store_order_events
  add constraint store_order_events_reason_len
  check (reason is null or char_length(reason) <= 300);

-- Verification. Read the result; do not take the success message as evidence.
-- Expected: one row, reason | text, and the constraint listed.
select column_name, data_type
  from information_schema.columns
 where table_schema = 'public'
   and table_name = 'store_order_events'
   and column_name = 'reason';

select conname
  from pg_constraint
 where conrelid = 'public.store_order_events'::regclass
   and conname = 'store_order_events_reason_len';

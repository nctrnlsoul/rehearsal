-- REHEARSAL sample store: record WHY a delivery was refused, and which PayPal
-- certificate host it named.
--
-- Run this in the same Supabase project BEFORE deploying the store code that
-- writes these columns. That code selects and inserts them, so deploying first
-- makes every read and write fail with a 400 until this has run. Every
-- statement is idempotent, so running it twice is harmless.
--
-- Why: a delivery the store refused (bad signature, missing PayPal headers, a
-- body that is not JSON) used to be recorded as "ignored" with no reason, or
-- not at all. A refused resend was then indistinguishable from one that never
-- arrived, which is exactly the question the edge-case finder has to answer.

alter table public.store_order_events
  add column if not exists reason text;

-- The host of the paypal-cert-url header, on every row. Lets an original
-- delivery and its resend be compared, and shows what a refused request
-- claimed. Recorded, never trusted: the signature check is what decides.
alter table public.store_order_events
  add column if not exists cert_host text;

-- The webhook endpoint is public, so whatever lands here is bounded. The app
-- truncates to 200 characters; this is the backstop if it ever does not.
alter table public.store_order_events
  drop constraint if exists store_order_events_reason_len;
alter table public.store_order_events
  add constraint store_order_events_reason_len
  check (reason is null or char_length(reason) <= 300);

-- 253 is the longest a DNS name can be; the app records nothing longer.
alter table public.store_order_events
  drop constraint if exists store_order_events_cert_host_len;
alter table public.store_order_events
  add constraint store_order_events_cert_host_len
  check (cert_host is null or char_length(cert_host) <= 253);

-- Verification. Read the results; do not take the success message as evidence.
-- Expected:
--   1. two rows: cert_host | text, reason | text
--   2. two rows: store_order_events_cert_host_len, store_order_events_reason_len
--   3. service_select = true, service_insert = true (new columns inherit the
--      table grant, but check rather than assume)
select column_name, data_type
  from information_schema.columns
 where table_schema = 'public'
   and table_name = 'store_order_events'
   and column_name in ('reason', 'cert_host')
 order by column_name;

select conname
  from pg_constraint
 where conrelid = 'public.store_order_events'::regclass
   and conname in ('store_order_events_reason_len', 'store_order_events_cert_host_len')
 order by conname;

select has_table_privilege('service_role', 'public.store_order_events', 'SELECT') as service_select,
       has_table_privilege('service_role', 'public.store_order_events', 'INSERT') as service_insert;

-- REHEARSAL webhook arrival ledger: cap every text column the public webhook
-- can fill.
--
-- Why: audit 2026-10-25 finding H1. One unauthenticated POST stored about
-- 990 KB. The receiver now records ids and types of at most 128 characters
-- (longer ones are recorded as absent) and a verify detail of at most 300;
-- these constraints are the backstop if the code ever stops doing that.
--
-- Run in the same Supabase project as 0001. Safe to run before or after
-- deploying the matching receiver code: that code never writes a value these
-- constraints refuse. Every statement is idempotent.
--
-- NOT VALID on purpose: existing rows (including the audit's oversized probe
-- rows) are not checked, so this cannot fail on old data, while every new
-- insert is. The ledger is append-only, so nothing here deletes or rewrites a
-- row. Cleaning up old oversized rows, if wanted, is a separate decision.

alter table public.webhook_arrivals
  drop constraint if exists webhook_arrivals_event_id_len;
alter table public.webhook_arrivals
  add constraint webhook_arrivals_event_id_len
  check (event_id is null or char_length(event_id) <= 128) not valid;

alter table public.webhook_arrivals
  drop constraint if exists webhook_arrivals_event_type_len;
alter table public.webhook_arrivals
  add constraint webhook_arrivals_event_type_len
  check (event_type is null or char_length(event_type) <= 128) not valid;

alter table public.webhook_arrivals
  drop constraint if exists webhook_arrivals_resource_id_len;
alter table public.webhook_arrivals
  add constraint webhook_arrivals_resource_id_len
  check (resource_id is null or char_length(resource_id) <= 128) not valid;

alter table public.webhook_arrivals
  drop constraint if exists webhook_arrivals_transmission_id_len;
alter table public.webhook_arrivals
  add constraint webhook_arrivals_transmission_id_len
  check (transmission_id is null or char_length(transmission_id) <= 128) not valid;

alter table public.webhook_arrivals
  drop constraint if exists webhook_arrivals_verify_detail_len;
alter table public.webhook_arrivals
  add constraint webhook_arrivals_verify_detail_len
  check (verify_detail is null or char_length(verify_detail) <= 300) not valid;

-- The receiver writes an 8-character instance id here.
alter table public.webhook_arrivals
  drop constraint if exists webhook_arrivals_instance_id_len;
alter table public.webhook_arrivals
  add constraint webhook_arrivals_instance_id_len
  check (char_length(instance_id) <= 64) not valid;

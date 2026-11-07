-- REHEARSAL console: the hosted purchase bank.
--
-- Run in the CONSOLE's own Supabase project (R-040), after 0001. Idempotent.
-- Run 0002_verify.sql afterwards and read every result.
--
-- A dispute needs a buyer purchase that a human approved in a browser (R-006),
-- so purchases are banked by Brian with the CLI and moved here complete. This
-- bank only ever holds purchases that are ready to dispute, or used ones: the
-- approval and capture steps stay on the CLI, where a person is present.

create table if not exists public.console_purchases (
  id                    bigint      generated always as identity primary key,
  order_id              text        not null
                        constraint console_purchases_order_id_len check (char_length(order_id) between 1 and 128),
  capture_id            text        not null
                        constraint console_purchases_capture_id_len check (char_length(capture_id) between 1 and 128),
  -- The BUYER-side id a dispute is filed against, not the seller's capture id.
  buyer_transaction_id  text        not null
                        constraint console_purchases_buyer_txn_len check (char_length(buyer_transaction_id) between 1 and 128),
  amount                text        not null
                        constraint console_purchases_amount_shape check (amount ~ '^[0-9]{1,10}(\.[0-9]{1,2})?$'),
  currency              text        not null
                        constraint console_purchases_currency_shape check (currency ~ '^[A-Z]{3}$'),
  status                text        not null default 'available'
                        constraint console_purchases_status check (status in ('available', 'used')),
  -- When the buyer made the purchase; the oldest is drawn first, as in the CLI.
  created_at            timestamptz not null,
  moved_at              timestamptz not null default now(),
  used_by_run_id        text        references public.console_runs (id),
  used_at               timestamptz,
  constraint console_purchases_order_unique unique (order_id),
  constraint console_purchases_used_has_run check (
    (status = 'used') = (used_by_run_id is not null and used_at is not null))
);

alter table public.console_purchases enable row level security;
-- Revoked from the service role too: Supabase's default privileges grant it
-- ALL, delete and truncate included (see 0001).
revoke all on public.console_purchases from public, anon, authenticated, service_role;
do $$
begin
  execute format('revoke all on sequence %s from public, anon, authenticated, service_role',
                 pg_get_serial_sequence('public.console_purchases', 'id'));
end $$;
-- A claim marks a purchase used, so update is needed (R-042). Nothing deletes:
-- a used purchase is the record of which dispute consumed it.
grant select, insert, update on public.console_purchases to service_role;

-- Draws the oldest ready purchase for a running run and marks it used, in one
-- statement. "skip locked" means two claims can never take the same row. The
-- caller does this BEFORE the dispute call: a crash between the two burns one
-- purchase (a human click), while reusing one would dispute a payment twice.
--
-- Fenced like every worker write: it reaps first, then heartbeats the run,
-- which locks the run's row until the claim commits. A reaper running at the
-- same moment waits for it and then sees the fresh heartbeat, so a run cannot
-- be called dead between its status check and its draw.
create or replace function public.console_claim_purchase(p_run_id text)
returns table (order_id text, capture_id text, buyer_transaction_id text, amount text, currency text, created_at timestamptz)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform public.console_reap_runs();
  update public.console_runs r set heartbeat_at = now()
   where r.id = p_run_id and r.status = 'running';
  if not found then
    return;
  end if;
  return query
    update public.console_purchases p
       set status = 'used', used_by_run_id = p_run_id, used_at = now()
     where p.id = (
             select q.id from public.console_purchases q
              where q.status = 'available'
              order by q.created_at, q.id
              limit 1
              for update skip locked)
    returning p.order_id, p.capture_id, p.buyer_transaction_id, p.amount, p.currency, p.created_at;
end;
$$;

-- Counts only. The console shows how many purchases are left, never which.
create or replace function public.console_bank_counts()
returns table (available bigint, used bigint)
language sql
security invoker
set search_path = ''
stable
as $$
  select count(*) filter (where status = 'available'),
         count(*) filter (where status = 'used')
    from public.console_purchases;
$$;

revoke all on function public.console_claim_purchase(text) from public, anon, authenticated;
revoke all on function public.console_bank_counts() from public, anon, authenticated;
grant execute on function public.console_claim_purchase(text) to service_role;
grant execute on function public.console_bank_counts() to service_role;

notify pgrst, 'reload schema';

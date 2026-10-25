-- Verification for 0003. Run it and read the results. Do not take the
-- migration's success message as evidence.
--
-- Expected:
--   1. six rows, every one with convalidated = false (NOT VALID):
--        webhook_arrivals_event_id_len
--        webhook_arrivals_event_type_len
--        webhook_arrivals_instance_id_len
--        webhook_arrivals_resource_id_len
--        webhook_arrivals_transmission_id_len
--        webhook_arrivals_verify_detail_len
--   2. 'refused as expected' in the result. The block tries to insert a
--      129-character event id inside a subtransaction. If the constraint holds,
--      the insert is refused and rolled back. If it does not, the block raises
--      CHECK MISSING and the whole statement rolls back. Either way no row is
--      left behind.
--   3. service_select = true, service_insert = true (unchanged by 0003, checked
--      because a broken grant is silent until the app answers 503)

select conname, convalidated
  from pg_constraint
 where conrelid = 'public.webhook_arrivals'::regclass
   and conname like 'webhook_arrivals_%_len'
 order by conname;

do $$
begin
  begin
    insert into public.webhook_arrivals (event_id, instance_id)
    values (repeat('x', 129), 'verify');
    raise exception 'CHECK MISSING: a 129-character event_id was accepted';
  exception when check_violation then
    raise notice 'refused as expected';
  end;
end $$;
select 'refused as expected' as oversized_insert;

select has_table_privilege('service_role', 'public.webhook_arrivals', 'SELECT') as service_select,
       has_table_privilege('service_role', 'public.webhook_arrivals', 'INSERT') as service_insert;

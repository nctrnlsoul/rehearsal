-- Verification for 0004. Run it and read the results. Do not take the
-- migration's success message as evidence.
--
-- Expected:
--   1. eight rows, every one with convalidated = false for the six new
--      constraints (NOT VALID) and true for the two from 0003:
--        store_order_events_action_len      | false
--        store_order_events_amount_len      | false
--        store_order_events_capture_id_len  | false
--        store_order_events_cert_host_len   | true
--        store_order_events_currency_len    | false
--        store_order_events_event_id_len    | false
--        store_order_events_event_type_len  | false
--        store_order_events_reason_len      | true
--   2. 'refused as expected' in the result. The block tries to insert a
--      129-character event id inside a subtransaction. If the constraint holds,
--      the insert is refused and rolled back. If it does not, the block raises
--      CHECK MISSING and the whole statement rolls back. Either way no row is
--      left behind.
--   3. service_select = true, service_insert = true (unchanged by 0004, checked
--      because a broken grant is silent until the app answers 503)

select conname, convalidated
  from pg_constraint
 where conrelid = 'public.store_order_events'::regclass
   and conname like 'store_order_events_%_len'
 order by conname;

do $$
begin
  begin
    insert into public.store_order_events (event_id, event_type, action)
    values (repeat('x', 129), 'VERIFY.0004', 'refused');
    raise exception 'CHECK MISSING: a 129-character event_id was accepted';
  exception when check_violation then
    raise notice 'refused as expected';
  end;
end $$;
select 'refused as expected' as oversized_insert;

select has_table_privilege('service_role', 'public.store_order_events', 'SELECT') as service_select,
       has_table_privilege('service_role', 'public.store_order_events', 'INSERT') as service_insert;

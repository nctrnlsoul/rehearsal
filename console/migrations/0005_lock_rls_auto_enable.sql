-- REHEARSAL console: lock Supabase's rls_auto_enable() (R-047).
--
-- Run in the CONSOLE's own Supabase project (R-040), after 0004. Idempotent.
-- Already applied live on 2026-10-26 as console_0005_lock_rls_auto_enable
-- (version 20261026004948); the statements below are that migration's, word
-- for word, so this file is the record of what the live database holds.
--
-- Supabase's advisor flagged the function: SECURITY DEFINER and callable over
-- RPC. It returns event_trigger, so a direct call most likely fails anyway,
-- but the API roles have no reason to reach it, so the grant is taken back.
-- R-047 records that automatic RLS still fired after this revoke.

revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
notify pgrst, 'reload schema';

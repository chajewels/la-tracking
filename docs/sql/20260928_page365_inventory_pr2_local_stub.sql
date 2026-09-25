-- ============================================================================
-- Page365 inventory PR 2 — LOCAL test stub (2026-09-28). NEVER RUN THIS ON LIVE.
--
-- Runs AFTER the #195 and PR 1 stubs + migrations, and adds only what migration
-- 20260928100000_page365_inventory_pr2.sql needs on top of them that the older
-- stubs did not model: system_settings.description (live has it). Same opt-in
-- guard as the earlier stubs.
--
--   initdb -D /tmp/p365pr2 --locale=C -E UTF8 && pg_ctl -D /tmp/p365pr2 -o "-p 55439" start
--   export PGOPTIONS='-c page365.local_stub=yes'
--   P="psql -p 55439 -U postgres -v ON_ERROR_STOP=1 -f"
--   $P docs/sql/20260926_page365_stock_sync_local_stub.sql
--   $P supabase/migrations/20260926120000_page365_stock_sync.sql
--   $P docs/sql/20260927_page365_inventory_fetch_local_stub.sql
--   $P supabase/migrations/20260927100000_page365_inventory_fetch.sql
--   $P docs/sql/20260928_page365_inventory_pr2_local_seed_held.sql      # #195-era held lines to cut over
--   $P docs/sql/20260928_page365_inventory_pr2_local_stub.sql
--   $P supabase/migrations/20260928100000_page365_inventory_pr2.sql
--   $P supabase/migrations/20260928100000_page365_inventory_pr2.sql   # re-run is safe
--   $P docs/sql/20260928_page365_inventory_pr2_local_tests.sql
-- ============================================================================
DO $guard$
BEGIN
  IF coalesce(current_setting('page365.local_stub', true), '') <> 'yes' THEN
    RAISE EXCEPTION 'Refusing: set PGOPTIONS=''-c page365.local_stub=yes''';
  END IF;
  IF to_regclass('public.customers') IS NOT NULL OR to_regclass('public.payments') IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing: this database has Hub tables. Local throwaway Postgres only.';
  END IF;
  IF to_regclass('public.page365_inventory_items') IS NULL THEN
    RAISE EXCEPTION 'Run the #195 and PR 1 stubs and migrations first';
  END IF;
END
$guard$;

ALTER TABLE public.system_settings ADD COLUMN IF NOT EXISTS description text;

-- RECORD-ONLY (repo structure catch-up, owner go 2026-10-09).
--
-- Columns, triggers and function grants that exist on live but were set in the SQL
-- Editor and never committed as a migration. Each is created ONLY IF MISSING, with the exact
-- definition read from live (pg_get_triggerdef), so applying this file to live
-- changes nothing; on an empty database it rebuilds what live has.
--
-- Placed right after 20260917070100_record_live_only_functions.sql, which
-- records the trigger functions these call, and before the first migration
-- that relies on a trigger being attached.

-- layaway_account_items (created 20260914110000): two columns live has that no
-- migration adds. Read from live 2026-10-09.
ALTER TABLE public.layaway_account_items ADD COLUMN IF NOT EXISTS product_id uuid;
ALTER TABLE public.layaway_account_items ADD COLUMN IF NOT EXISTS shopify_line_item_id text;

DO $catchup$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('trg_note_loyalty_transaction', 'public.loyalty_transactions',
     'CREATE TRIGGER trg_note_loyalty_transaction AFTER INSERT ON public.loyalty_transactions FOR EACH ROW EXECUTE FUNCTION note_loyalty_transaction()')
  ) AS t(tgname, tbl, ddl)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger
                    WHERE tgname = r.tgname AND tgrelid = r.tbl::regclass AND NOT tgisinternal) THEN
      EXECUTE r.ddl;
    END IF;
  END LOOP;
END $catchup$;

-- revoke_loyalty_points: 20260914130000 re-created it (DROP + CREATE), which
-- leaves the default PUBLIC execute; live was then locked to service_role in the
-- SQL Editor. 20261017100000's self-check requires live's grants. Read from live
-- proacl 2026-10-09. Applying to live is a no-op.
REVOKE ALL ON FUNCTION public.revoke_loyalty_points(uuid,text,numeric,uuid,uuid,uuid,text,text,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_loyalty_points(uuid,text,numeric,uuid,uuid,uuid,text,text,uuid,text) TO service_role;

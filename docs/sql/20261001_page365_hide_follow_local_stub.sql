-- ============================================================================
-- Page365 hide-follow (PR 3b) — LOCAL test stub (2026-10-01). NEVER RUN THIS
-- ON LIVE.
--
-- Runs AFTER the #195, PR 1, PR 2, PR 4 and PR 3 stubs + migrations and adds
-- only what live has and the earlier stubs do not: website_products.status as
-- the enum website_product_status ('draft','active','archived') instead of
-- text, so the migration's casts are tested against the real type. Same opt-in
-- guard as the other stubs.
--
--   (the PR 3 sequence from docs/sql/20260930_page365_inventory_schedule_local_stub.sql, then)
--   $P docs/sql/20261001_page365_hide_follow_local_stub.sql
--   $P supabase/migrations/20261001100000_page365_hide_follow.sql
--   $P supabase/migrations/20261001100000_page365_hide_follow.sql   # re-run is safe
--   $P docs/sql/20261001_page365_hide_follow_local_tests.sql
-- ============================================================================
DO $guard$
BEGIN
  IF coalesce(current_setting('page365.local_stub', true), '') <> 'yes' THEN
    RAISE EXCEPTION 'Refusing: set PGOPTIONS=''-c page365.local_stub=yes''';
  END IF;
  IF to_regclass('public.customers') IS NOT NULL OR to_regclass('public.payments') IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing: this database has Hub tables. Local throwaway Postgres only.';
  END IF;
  IF to_regprocedure('public.page365_inventory_auto_apply_run(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Run the #195, PR 1, PR 2, PR 4 and PR 3 stubs and migrations first';
  END IF;
END
$guard$;

DO $$ BEGIN
  CREATE TYPE public.website_product_status AS ENUM ('draft','active','archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  IF (SELECT udt_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'website_products' AND column_name = 'status') = 'text' THEN
    -- PR 4's guard trigger is UPDATE OF status: it has to step aside for the type change.
    DROP TRIGGER IF EXISTS trg_page365_draft_publish_guard ON public.website_products;
    ALTER TABLE public.website_products ALTER COLUMN status DROP DEFAULT;
    ALTER TABLE public.website_products ALTER COLUMN status TYPE public.website_product_status
      USING status::public.website_product_status;
    ALTER TABLE public.website_products ALTER COLUMN status SET DEFAULT 'draft';
    CREATE TRIGGER trg_page365_draft_publish_guard
      BEFORE INSERT OR UPDATE OF status ON public.website_products
      FOR EACH ROW EXECUTE FUNCTION public.page365_draft_publish_guard();
  END IF;
END $$;

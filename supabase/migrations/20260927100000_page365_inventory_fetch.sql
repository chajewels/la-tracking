-- ===========================================================================
-- page365_inventory_fetch — read the whole Page365 catalogue, propose website
-- stock from it, and let staff apply the proposal row by row (PR 1 of 4).
--
-- OWNER RUNS THIS in the SQL Editor, as-is, after the release PR is on main.
-- One transaction. It is INERT until someone presses "Fetch Page365 inventory"
-- (Website -> Page365 stock): a fetch writes only its own run tables, and stock
-- moves only through page365_inventory_apply, one ticked row at a time.
--
-- Plan: ~/Code/reference/page365-inventory-fetch-investigation.md (owner-
-- approved with every recommendation). Owner rules this file enforces:
--   * TARGET = max(0, Page365 available - website holds Page365 does not know
--     about yet). Holds = web cash orders still 'pending' + live web layaways
--     with no money received (page365_web_holds). A piece reserved on the
--     website is never put back on sale.
--   * COMPARE-AND-SET: a row is written only if stock_qty still equals what the
--     fetch saw; otherwise it is skipped as changed_since_fetch. Never below 0.
--   * Decreases and increases arrive in SEPARATE arrays; an increase is applied
--     only when the caller names it as an increase (the staff tick).
--   * Until PR 2 ships, a variant with a #195 invoice hold (page365_stock_lines
--     stock_state = 'held') is EXCLUDED: evaluated, shown, never written.
--   * MATCH per VARIANT on the product code: single-variant listing -> first
--     word of the product name; multi-variant listing -> first word of each
--     variant name (E1053 / E2057). Exact code via page365_match_line; nothing
--     fuzzy. A code seen twice in one fetch is flagged, never applied.
--   * New Page365 codes are LISTED; price differences REPORTED; Hub products
--     absent from Page365 FLAGGED (never zeroed). Only a complete read (no
--     product errors) lists Hub-only products.
--   * A run that did not read cleanly (any product error, or the catalogue
--     count fell more than 20 % against the previous complete run) is
--     'partial', and apply refuses it: a Page365 outage changes nothing.
--   * Photos: website_product_media gains page365_photo_id / _version; a
--     photo is recorded once per (variant, Page365 photo id). Staff-uploaded
--     photos are never touched or reordered. Customer reviews are never stored
--     (page365_inventory_store_product reads whitelisted keys only).
--
-- Guards: every dependency is checked first and the whole transaction aborts
-- with NOTHING changed if the live schema is not what this was written against.
-- Re-running the file is safe (IF NOT EXISTS / CREATE OR REPLACE / DROP IF
-- EXISTS on objects this file owns); the guards refuse a same-named object
-- this file did not create.
-- ===========================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Pre-flight. Nothing below runs unless every check passes.
-- ---------------------------------------------------------------------------
DO $pre$
DECLARE
  v_missing text[] := ARRAY[]::text[];
  v_cols    text[];
  v_n       integer;
BEGIN
  IF to_regclass('public.website_products')         IS NULL THEN v_missing := v_missing || 'website_products'::text; END IF;
  IF to_regclass('public.website_product_variants') IS NULL THEN v_missing := v_missing || 'website_product_variants'::text; END IF;
  IF to_regclass('public.website_product_media')    IS NULL THEN v_missing := v_missing || 'website_product_media'::text; END IF;
  IF to_regclass('public.cash_orders')              IS NULL THEN v_missing := v_missing || 'cash_orders'::text; END IF;
  IF to_regclass('public.cash_order_items')         IS NULL THEN v_missing := v_missing || 'cash_order_items'::text; END IF;
  IF to_regclass('public.layaway_accounts')         IS NULL THEN v_missing := v_missing || 'layaway_accounts'::text; END IF;
  IF to_regclass('public.layaway_account_items')    IS NULL THEN v_missing := v_missing || 'layaway_account_items'::text; END IF;
  IF to_regclass('public.page365_stock_lines')      IS NULL THEN v_missing := v_missing || 'page365_stock_lines (#195: run 20260926120000 first)'::text; END IF;
  IF to_regclass('public.audit_logs')               IS NULL THEN v_missing := v_missing || 'audit_logs'::text; END IF;
  IF to_regclass('public.system_settings')          IS NULL THEN v_missing := v_missing || 'system_settings'::text; END IF;
  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'page365_inventory_fetch: missing table(s): %', array_to_string(v_missing, ', ');
  END IF;

  SELECT array_agg(c.table_name || '.' || c.column_name) INTO v_cols
    FROM (VALUES
      ('website_products','id'), ('website_products','sku'), ('website_products','name'), ('website_products','status'),
      ('website_product_variants','id'), ('website_product_variants','product_id'),
      ('website_product_variants','stock_qty'), ('website_product_variants','price_jpy'),
      ('website_product_variants','updated_at'),
      ('website_product_media','id'), ('website_product_media','variant_id'), ('website_product_media','url'),
      ('website_product_media','alt'), ('website_product_media','sort'),
      ('cash_orders','id'), ('cash_orders','status'), ('cash_orders','source_channel'),
      ('cash_order_items','cash_order_id'), ('cash_order_items','variant_id'), ('cash_order_items','quantity'),
      ('layaway_accounts','id'), ('layaway_accounts','status'), ('layaway_accounts','source_channel'),
      ('layaway_accounts','stock_released_at'), ('layaway_accounts','total_paid'),
      ('layaway_account_items','account_id'), ('layaway_account_items','variant_id'), ('layaway_account_items','quantity'),
      ('page365_stock_lines','variant_id'), ('page365_stock_lines','stock_state'),
      ('audit_logs','entity_type'), ('audit_logs','entity_id'), ('audit_logs','action'),
      ('audit_logs','old_value_json'), ('audit_logs','new_value_json'), ('audit_logs','performed_by_user_id'),
      ('system_settings','key'), ('system_settings','value')
    ) AS c(table_name, column_name)
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns ic
      WHERE ic.table_schema = 'public' AND ic.table_name = c.table_name AND ic.column_name = c.column_name);
  IF v_cols IS NOT NULL THEN
    RAISE EXCEPTION 'page365_inventory_fetch: missing column(s): %', array_to_string(v_cols, ', ');
  END IF;

  -- #195 helpers this reuses unchanged.
  IF to_regprocedure('public.page365_first_word(text)') IS NULL
     OR to_regprocedure('public.page365_match_line(text)') IS NULL THEN
    RAISE EXCEPTION 'page365_inventory_fetch: page365_first_word / page365_match_line missing (#195: run 20260926120000 first)';
  END IF;
  IF to_regprocedure('public.is_staff(uuid)') IS NULL OR to_regprocedure('public.has_permission(uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'page365_inventory_fetch: public.is_staff(uuid) / public.has_permission(uuid,text) missing';
  END IF;

  -- The CHECK compare-and-set relies on as the never-below-zero backstop.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint k
     WHERE k.conrelid = 'public.website_product_variants'::regclass AND k.contype = 'c'
       AND pg_get_constraintdef(k.oid) ILIKE '%stock_qty >= 0%') THEN
    RAISE EXCEPTION 'page365_inventory_fetch: website_product_variants has no CHECK (stock_qty >= 0)';
  END IF;

  -- The storefront hears about a stock or photo change only through this trigger.
  SELECT count(*) INTO v_n FROM pg_trigger t
   WHERE NOT t.tgisinternal AND t.tgfoid = to_regprocedure('public.notify_website_revalidate()')
     AND t.tgrelid IN ('public.website_product_variants'::regclass, 'public.website_product_media'::regclass);
  IF v_n < 2 THEN
    RAISE EXCEPTION 'page365_inventory_fetch: notify_website_revalidate trigger missing on variants or media';
  END IF;

  -- The #195 ledger states this reads. PR 2 widens this CHECK; PR 1 must see #195's.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint k
     WHERE k.conrelid = 'public.page365_stock_lines'::regclass AND k.contype = 'c'
       AND pg_get_constraintdef(k.oid) ILIKE '%stock_state%' AND pg_get_constraintdef(k.oid) ILIKE '%held%') THEN
    RAISE EXCEPTION 'page365_inventory_fetch: page365_stock_lines.stock_state CHECK without held — not the #195 ledger';
  END IF;

  -- audit_logs must accept the new entity types: refuse any CHECK on entity_type.
  IF EXISTS (
    SELECT 1 FROM pg_constraint k
     WHERE k.conrelid = 'public.audit_logs'::regclass AND k.contype = 'c'
       AND pg_get_constraintdef(k.oid) ILIKE '%entity_type%') THEN
    RAISE EXCEPTION 'page365_inventory_fetch: audit_logs has a CHECK on entity_type; website_product_variant / page365_inventory_run would be refused';
  END IF;

  -- Name collisions: refuse a same-named object this file did not make.
  IF to_regclass('public.page365_inventory_runs') IS NOT NULL THEN
    SELECT count(*) INTO v_n FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'page365_inventory_runs'
       AND column_name IN ('id','source','started_by','status','page365_count','products_total','previous_count',
                           'chunks_started','error','created_at','updated_at','finished_at');
    IF v_n <> 12 THEN RAISE EXCEPTION 'page365_inventory_fetch: a different public.page365_inventory_runs already exists'; END IF;
  END IF;
  IF to_regclass('public.page365_inventory_items') IS NOT NULL THEN
    SELECT count(*) INTO v_n FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'page365_inventory_items'
       AND column_name IN ('run_id','kind','inventory_product_id','page365_variant_id','code','match_result',
                           'variant_id','seen_stock','web_holds','invoice_holds','proposed_stock','category','status');
    IF v_n <> 13 THEN RAISE EXCEPTION 'page365_inventory_fetch: a different public.page365_inventory_items already exists'; END IF;
  END IF;
  SELECT count(*) INTO v_n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'website_product_media'
     AND column_name IN ('page365_photo_id','page365_photo_version')
     AND NOT ((column_name = 'page365_photo_id' AND data_type = 'bigint')
           OR (column_name = 'page365_photo_version' AND data_type = 'text'));
  IF v_n > 0 THEN
    RAISE EXCEPTION 'page365_inventory_fetch: website_product_media.page365_photo_* exists with a different type';
  END IF;
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND ((p.proname = 'page365_web_holds'              AND pg_get_function_identity_arguments(p.oid) <> 'p_variant_id uuid')
       OR (p.proname = 'page365_inventory_claim'        AND pg_get_function_identity_arguments(p.oid) <> 'p_run_id uuid, p_limit integer')
       OR (p.proname = 'page365_inventory_store_product' AND pg_get_function_identity_arguments(p.oid) <> 'p_product_row_id uuid, p_detail jsonb, p_error text')
       OR (p.proname = 'page365_inventory_finish'       AND pg_get_function_identity_arguments(p.oid) <> 'p_run_id uuid')
       OR (p.proname = 'page365_inventory_apply'        AND pg_get_function_identity_arguments(p.oid) <> 'p_run_id uuid, p_decrease_ids uuid[], p_increase_ids uuid[]')
       OR (p.proname = 'page365_inventory_record_photo' AND pg_get_function_identity_arguments(p.oid)
                                                          <> 'p_item_id uuid, p_photo_id bigint, p_version text, p_url text, p_source_url text, p_index integer, p_actor uuid'));
  IF v_n > 0 THEN
    RAISE EXCEPTION 'page365_inventory_fetch: a page365_inventory function already exists with a different signature';
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. Runs. One row per press of "Fetch Page365 inventory" (PR 3: per schedule).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.page365_inventory_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source          text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','schedule')),
  started_by      uuid,
  status          text NOT NULL DEFAULT 'fetching' CHECK (status IN ('fetching','ready','partial','failed')),
  page365_count   integer CHECK (page365_count >= 0),
  products_total  integer NOT NULL DEFAULT 0 CHECK (products_total >= 0),
  previous_count  integer,
  chunks_started  integer NOT NULL DEFAULT 0,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);
COMMENT ON TABLE public.page365_inventory_runs IS
  'Page365 inventory fetch runs (2026-09-27). fetching -> ready (read cleanly) | partial (a product failed, or the catalogue count fell > 20 % against the previous ready run: apply refuses) | failed (the list could not be read). Written only by the service role (edge fn page365-inventory-fetch) and page365_inventory_finish.';
CREATE INDEX IF NOT EXISTS idx_page365_inventory_runs_created ON public.page365_inventory_runs (created_at DESC);
-- One read at a time: a second "Fetch" resumes the run in progress instead.
CREATE UNIQUE INDEX IF NOT EXISTS uq_page365_inventory_one_fetching
  ON public.page365_inventory_runs ((true)) WHERE status = 'fetching';

-- 2. Chunks. One row per "continue" call — the audit trail of a resumable read.
CREATE TABLE IF NOT EXISTS public.page365_inventory_chunks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        uuid NOT NULL REFERENCES public.page365_inventory_runs(id) ON DELETE CASCADE,
  chunk_no      integer NOT NULL CHECK (chunk_no >= 1),
  products      integer NOT NULL DEFAULT 0,
  started_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_page365_inventory_chunk UNIQUE (run_id, chunk_no)
);

-- 3. Products. The read queue (one row per Page365 listing) and what was read.
--    photos = [{id, version, url, position}] in display order. Nothing else
--    from the detail JSON is kept: no reviews, no customer names, ever.
CREATE TABLE IF NOT EXISTS public.page365_inventory_products (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id              uuid NOT NULL REFERENCES public.page365_inventory_runs(id) ON DELETE CASCADE,
  page365_product_id  bigint NOT NULL,
  list_name           text NOT NULL,
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','claimed','fetched','error')),
  attempts            integer NOT NULL DEFAULT 0,
  claimed_at          timestamptz,
  fetched_at          timestamptz,
  name                text,
  price_jpy           integer,
  full_price_jpy      integer,
  photos              jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(photos) = 'array'),
  error               text,
  CONSTRAINT uq_page365_inventory_product UNIQUE (run_id, page365_product_id)
);
CREATE INDEX IF NOT EXISTS idx_page365_inventory_products_queue
  ON public.page365_inventory_products (run_id, status, page365_product_id);

-- 4. Items. One row per Page365 VARIANT (kind 'page365'), plus one per Hub
--    product Page365 no longer lists (kind 'hub_only'). This is the review list.
CREATE TABLE IF NOT EXISTS public.page365_inventory_items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                uuid NOT NULL REFERENCES public.page365_inventory_runs(id) ON DELETE CASCADE,
  kind                  text NOT NULL DEFAULT 'page365' CHECK (kind IN ('page365','hub_only')),
  inventory_product_id  uuid REFERENCES public.page365_inventory_products(id) ON DELETE CASCADE,
  page365_product_id    bigint,
  page365_variant_id    bigint,
  page365_name          text,
  variant_name          text,
  code                  text,
  page365_price_jpy     integer,
  page365_full_price_jpy integer,
  page365_available     integer CHECK (page365_available >= 0),
  match_result          text NOT NULL DEFAULT 'pending' CHECK (match_result IN
                          ('pending','matched','unmatched','ambiguous_sku','no_variant','ambiguous_variant',
                           'no_code','duplicate_in_page365','hub_only')),
  website_product_id    uuid REFERENCES public.website_products(id) ON DELETE SET NULL,
  variant_id            uuid REFERENCES public.website_product_variants(id) ON DELETE SET NULL,
  hub_sku               text,
  hub_price_jpy         integer,
  seen_stock            integer,
  web_holds             integer,
  invoice_holds         integer,
  proposed_stock        integer CHECK (proposed_stock >= 0),
  category              text NOT NULL DEFAULT 'pending' CHECK (category IN
                          ('pending','decrease','increase','no_change','excluded','flagged','new','hub_only')),
  price_differs         boolean NOT NULL DEFAULT false,
  photos_total          integer NOT NULL DEFAULT 0,
  photos_to_copy        integer NOT NULL DEFAULT 0,
  photos_removed        integer NOT NULL DEFAULT 0,
  missing_runs          integer,
  status                text NOT NULL DEFAULT 'review' CHECK (status IN
                          ('review','applied','changed_since_fetch','failed')),
  result_note           text,
  applied_at            timestamptz,
  applied_by            uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_page365_inventory_item UNIQUE (run_id, page365_product_id, page365_variant_id),
  CONSTRAINT page365_inventory_item_kind CHECK (
    (kind = 'page365' AND page365_product_id IS NOT NULL AND page365_variant_id IS NOT NULL AND inventory_product_id IS NOT NULL)
    OR (kind = 'hub_only' AND page365_product_id IS NULL AND website_product_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_page365_inventory_hub_only
  ON public.page365_inventory_items (run_id, website_product_id) WHERE kind = 'hub_only';
CREATE INDEX IF NOT EXISTS idx_page365_inventory_items_run ON public.page365_inventory_items (run_id, category, status);
CREATE INDEX IF NOT EXISTS idx_page365_inventory_items_variant ON public.page365_inventory_items (variant_id) WHERE variant_id IS NOT NULL;
COMMENT ON TABLE public.page365_inventory_items IS
  'Review list of a Page365 inventory run (2026-09-27). category: decrease / increase (stock proposals), no_change, excluded (a #195 invoice hold on the variant), flagged (no code / duplicate / ambiguous / hub-side problem), new (code not in the Hub: listed only), hub_only (Hub product absent from Page365: flagged, never zeroed). Stock moves only through page365_inventory_apply.';

-- RLS: catalogue staff read; nobody writes through PostgREST.
ALTER TABLE public.page365_inventory_runs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.page365_inventory_chunks   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.page365_inventory_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.page365_inventory_items    ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Catalog staff read inventory runs" ON public.page365_inventory_runs;
CREATE POLICY "Catalog staff read inventory runs" ON public.page365_inventory_runs
  FOR SELECT TO authenticated USING (public.has_permission(auth.uid(), 'manage_website_catalog'));
DROP POLICY IF EXISTS "Catalog staff read inventory chunks" ON public.page365_inventory_chunks;
CREATE POLICY "Catalog staff read inventory chunks" ON public.page365_inventory_chunks
  FOR SELECT TO authenticated USING (public.has_permission(auth.uid(), 'manage_website_catalog'));
DROP POLICY IF EXISTS "Catalog staff read inventory products" ON public.page365_inventory_products;
CREATE POLICY "Catalog staff read inventory products" ON public.page365_inventory_products
  FOR SELECT TO authenticated USING (public.has_permission(auth.uid(), 'manage_website_catalog'));
DROP POLICY IF EXISTS "Catalog staff read inventory items" ON public.page365_inventory_items;
CREATE POLICY "Catalog staff read inventory items" ON public.page365_inventory_items
  FOR SELECT TO authenticated USING (public.has_permission(auth.uid(), 'manage_website_catalog'));
REVOKE ALL ON public.page365_inventory_runs, public.page365_inventory_chunks,
              public.page365_inventory_products, public.page365_inventory_items FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.page365_inventory_runs, public.page365_inventory_chunks,
                public.page365_inventory_products, public.page365_inventory_items TO authenticated;
GRANT ALL ON public.page365_inventory_runs, public.page365_inventory_chunks,
             public.page365_inventory_products, public.page365_inventory_items TO service_role;

-- ---------------------------------------------------------------------------
-- 5. Photo identity. A Page365 photo is recorded once per Hub variant; the
--    version (the ?stamp on Page365's URL) says whether it was replaced.
-- ---------------------------------------------------------------------------
ALTER TABLE public.website_product_media
  ADD COLUMN IF NOT EXISTS page365_photo_id bigint,
  ADD COLUMN IF NOT EXISTS page365_photo_version text;
CREATE UNIQUE INDEX IF NOT EXISTS uq_website_product_media_page365_photo
  ON public.website_product_media (variant_id, page365_photo_id) WHERE page365_photo_id IS NOT NULL;
COMMENT ON COLUMN public.website_product_media.page365_photo_id IS
  'Page365 photo id this row was copied from (page365_inventory_record_photo). NULL = uploaded by staff: never touched or reordered by the Page365 copy. UNIQUE per variant, so a re-fetch never duplicates a photo.';
COMMENT ON COLUMN public.website_product_media.page365_photo_version IS
  'The version stamp on the Page365 photo URL when copied. A different stamp on a later fetch = Page365 replaced the photo; the copy is refreshed in place.';

-- ---------------------------------------------------------------------------
-- 6. Website holds Page365 does not know about yet (owner rule: staff enter
--    every CONFIRMED website sale in Page365). Web cash orders still pending,
--    plus live web layaways that have received no money.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_web_holds(p_variant_id uuid)
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT (
    coalesce((SELECT sum(i.quantity) FROM public.cash_order_items i
                JOIN public.cash_orders o ON o.id = i.cash_order_id
               WHERE i.variant_id = p_variant_id AND o.source_channel = 'web' AND o.status = 'pending'), 0)
  + coalesce((SELECT sum(i.quantity) FROM public.layaway_account_items i
                JOIN public.layaway_accounts a ON a.id = i.account_id
               WHERE i.variant_id = p_variant_id AND a.source_channel = 'web' AND a.stock_released_at IS NULL
                 AND a.status IN ('active','overdue') AND coalesce(a.total_paid, 0) = 0), 0)
  )::integer
$fn$;
REVOKE ALL ON FUNCTION public.page365_web_holds(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_web_holds(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 7. Claim the next products to read. Service role only. Resumable: a claim
--    older than 3 minutes (a crashed call) is taken again; a failed product is
--    retried once. Each call is logged as a chunk.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_inventory_claim(p_run_id uuid, p_limit integer)
RETURNS TABLE (o_id uuid, o_page365_product_id bigint, o_chunk_no integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_chunk integer;
  v_ids   uuid[];
BEGIN
  UPDATE public.page365_inventory_runs
     SET chunks_started = chunks_started + 1, updated_at = now()
   WHERE id = p_run_id AND status = 'fetching'
  RETURNING chunks_started INTO v_chunk;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT array_agg(q.id) INTO v_ids FROM (
    SELECT p.id FROM public.page365_inventory_products p
     WHERE p.run_id = p_run_id
       AND (p.status = 'pending'
         OR (p.status = 'claimed' AND p.claimed_at < now() - interval '3 minutes')
         OR (p.status = 'error' AND p.attempts < 2))
     ORDER BY p.page365_product_id
     LIMIT greatest(1, least(coalesce(p_limit, 40), 100))
     FOR UPDATE SKIP LOCKED) q;

  IF v_ids IS NULL THEN RETURN; END IF;
  INSERT INTO public.page365_inventory_chunks (run_id, chunk_no, products)
  VALUES (p_run_id, v_chunk, array_length(v_ids, 1));

  RETURN QUERY
  WITH u AS (
    UPDATE public.page365_inventory_products p
       SET status = 'claimed', claimed_at = now(), attempts = p.attempts + 1
     WHERE p.id = ANY (v_ids)
    RETURNING p.id, p.page365_product_id)
  SELECT u.id, u.page365_product_id, v_chunk FROM u;
END
$fn$;
REVOKE ALL ON FUNCTION public.page365_inventory_claim(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_inventory_claim(uuid, integer) TO service_role;

-- ---------------------------------------------------------------------------
-- 8. Store one product as read (or its error). Service role only. Reads the
--    WHITELISTED keys of p_detail and nothing else — anything the edge parser
--    let through beyond them (a review, a customer name) is dropped here too.
--    p_detail = {name, price_jpy, full_price_jpy,
--                photos:[{id, version, url, position}],
--                variants:[{id, name, code, price_jpy, full_price_jpy, available}]}
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_inventory_store_product(p_product_row_id uuid, p_detail jsonb, p_error text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_p      public.page365_inventory_products%ROWTYPE;
  v_photos jsonb;
  v_v      jsonb;
BEGIN
  SELECT * INTO v_p FROM public.page365_inventory_products WHERE id = p_product_row_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF v_p.status <> 'claimed' THEN RETURN 'not_claimed'; END IF;

  -- The edge parser is strict; this is the backstop. A detail without
  -- variants, or a variant without an id or a whole non-negative quantity,
  -- is an error for this product — never a guessed 0.
  IF p_error IS NULL AND p_detail IS NOT NULL AND (
       jsonb_typeof(p_detail->'variants') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_detail->'variants') = 0
    OR jsonb_typeof(coalesce(p_detail->'photos', '[]'::jsonb)) <> 'array'
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_detail->'variants') v
                WHERE jsonb_typeof(v->'id') IS DISTINCT FROM 'number'
                   OR jsonb_typeof(v->'available') IS DISTINCT FROM 'number'
                   OR (v->>'available') !~ '^[0-9]+$')) THEN
    p_error := 'detail failed the variant check';
  END IF;

  IF p_error IS NOT NULL OR p_detail IS NULL THEN
    UPDATE public.page365_inventory_products
       SET status = 'error', error = left(coalesce(p_error, 'no detail'), 500), claimed_at = NULL
     WHERE id = p_product_row_id;
    DELETE FROM public.page365_inventory_items WHERE inventory_product_id = p_product_row_id;
    RETURN 'error';
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', (ph->>'id')::bigint, 'version', ph->>'version', 'url', ph->>'url',
           'position', (ph->>'position')::integer) ORDER BY ord), '[]'::jsonb)
    INTO v_photos
    FROM jsonb_array_elements(coalesce(p_detail->'photos', '[]'::jsonb)) WITH ORDINALITY AS t(ph, ord);

  UPDATE public.page365_inventory_products
     SET status = 'fetched', fetched_at = now(), claimed_at = NULL, error = NULL,
         name = p_detail->>'name',
         price_jpy = (p_detail->>'price_jpy')::integer,
         full_price_jpy = (p_detail->>'full_price_jpy')::integer,
         photos = v_photos
   WHERE id = p_product_row_id;

  DELETE FROM public.page365_inventory_items WHERE inventory_product_id = p_product_row_id;
  FOR v_v IN SELECT * FROM jsonb_array_elements(coalesce(p_detail->'variants', '[]'::jsonb)) LOOP
    INSERT INTO public.page365_inventory_items (
      run_id, kind, inventory_product_id, page365_product_id, page365_variant_id,
      page365_name, variant_name, code, page365_price_jpy, page365_full_price_jpy, page365_available)
    VALUES (
      v_p.run_id, 'page365', v_p.id, v_p.page365_product_id, (v_v->>'id')::bigint,
      p_detail->>'name', v_v->>'name', nullif(upper(btrim(v_v->>'code')), ''),
      (v_v->>'price_jpy')::integer, (v_v->>'full_price_jpy')::integer, (v_v->>'available')::integer);
  END LOOP;
  RETURN 'fetched';
END
$fn$;
REVOKE ALL ON FUNCTION public.page365_inventory_store_product(uuid, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_inventory_store_product(uuid, jsonb, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 9. Finish a run: match every variant, compute the proposal, list Hub-only
--    products, decide ready / partial. Service role only. All at one moment,
--    so every seen_stock in a run is from the same snapshot.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_inventory_finish(p_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_run      public.page365_inventory_runs%ROWTYPE;
  v_prev     public.page365_inventory_runs%ROWTYPE;
  v_prev_count integer;
  v_open     integer;
  v_errors   integer;
  v_it       record;
  v_m        record;
  v_status   text;
  v_reason   text;
BEGIN
  SELECT * INTO v_run FROM public.page365_inventory_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'run_not_found'); END IF;
  IF v_run.status <> 'fetching' THEN
    RETURN jsonb_build_object('ok', true, 'status', v_run.status, 'already', true);
  END IF;

  SELECT count(*) FILTER (WHERE status IN ('pending','claimed') OR (status = 'error' AND attempts < 2)),
         count(*) FILTER (WHERE status = 'error')
    INTO v_open, v_errors
    FROM public.page365_inventory_products WHERE run_id = p_run_id;
  IF v_open > 0 THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_done', 'open', v_open); END IF;

  -- (a) No code / a code seen twice in this read: flagged, never matched.
  UPDATE public.page365_inventory_items SET match_result = 'no_code', category = 'flagged'
   WHERE run_id = p_run_id AND kind = 'page365' AND code IS NULL;
  UPDATE public.page365_inventory_items i SET match_result = 'duplicate_in_page365', category = 'flagged'
   WHERE i.run_id = p_run_id AND i.kind = 'page365' AND i.code IS NOT NULL
     AND (SELECT count(*) FROM public.page365_inventory_items j
           WHERE j.run_id = p_run_id AND j.kind = 'page365' AND j.code = i.code) > 1;

  -- (b) Match the rest on the code, exactly (#195's matcher, unchanged).
  FOR v_it IN
    SELECT i.id, i.code, i.page365_available, i.page365_price_jpy, i.inventory_product_id
      FROM public.page365_inventory_items i
     WHERE i.run_id = p_run_id AND i.kind = 'page365' AND i.match_result = 'pending'
     ORDER BY i.id
  LOOP
    SELECT * INTO v_m FROM public.page365_match_line(v_it.code);
    IF v_m.o_match_result = 'matched' THEN
      UPDATE public.page365_inventory_items i
         SET match_result = 'matched', website_product_id = v_m.o_product_id, variant_id = v_m.o_variant_id,
             hub_sku = (SELECT sku FROM public.website_products WHERE id = v_m.o_product_id),
             hub_price_jpy = (SELECT price_jpy FROM public.website_product_variants WHERE id = v_m.o_variant_id),
             seen_stock = v_m.o_stock_qty,
             web_holds = public.page365_web_holds(v_m.o_variant_id),
             invoice_holds = (SELECT count(*) FROM public.page365_stock_lines l
                               WHERE l.variant_id = v_m.o_variant_id AND l.stock_state = 'held')
       WHERE i.id = v_it.id;
    ELSE
      UPDATE public.page365_inventory_items i
         SET match_result = v_m.o_match_result, website_product_id = v_m.o_product_id,
             category = CASE WHEN v_m.o_match_result = 'unmatched' THEN 'new' ELSE 'flagged' END
       WHERE i.id = v_it.id;
    END IF;
  END LOOP;

  -- (c) The proposal: max(0, Page365 available - website holds), and its direction.
  UPDATE public.page365_inventory_items i
     SET proposed_stock = greatest(0, i.page365_available - coalesce(i.web_holds, 0)),
         price_differs = i.page365_price_jpy IS DISTINCT FROM i.hub_price_jpy
   WHERE i.run_id = p_run_id AND i.match_result = 'matched';
  UPDATE public.page365_inventory_items i
     SET category = CASE
           WHEN i.invoice_holds > 0                THEN 'excluded'
           WHEN i.proposed_stock < i.seen_stock    THEN 'decrease'
           WHEN i.proposed_stock > i.seen_stock    THEN 'increase'
           ELSE 'no_change' END
   WHERE i.run_id = p_run_id AND i.match_result = 'matched';

  -- (d) Photos per matched variant: Page365 total, not yet copied (by id AND
  --     version), and copies whose Page365 photo is gone (flagged, not deleted).
  UPDATE public.page365_inventory_items i
     SET photos_total = jsonb_array_length(p.photos),
         photos_to_copy = (SELECT count(*) FROM jsonb_array_elements(p.photos) ph
                            WHERE NOT EXISTS (SELECT 1 FROM public.website_product_media m
                                               WHERE m.variant_id = i.variant_id
                                                 AND m.page365_photo_id = (ph->>'id')::bigint
                                                 AND m.page365_photo_version IS NOT DISTINCT FROM ph->>'version')),
         photos_removed = (SELECT count(*) FROM public.website_product_media m
                            WHERE m.variant_id = i.variant_id AND m.page365_photo_id IS NOT NULL
                              AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p.photos) ph
                                               WHERE (ph->>'id')::bigint = m.page365_photo_id))
    FROM public.page365_inventory_products p
   WHERE p.id = i.inventory_product_id AND i.run_id = p_run_id AND i.match_result = 'matched';

  -- (e) Hub-only: only a COMPLETE read can say a code is absent. Archived
  --     products are out of scope; a code with an inner space never matched.
  IF v_errors = 0 THEN
    SELECT * INTO v_prev FROM public.page365_inventory_runs r
     WHERE r.id <> p_run_id AND r.status = 'ready' AND r.created_at < v_run.created_at
     ORDER BY r.created_at DESC LIMIT 1;
    INSERT INTO public.page365_inventory_items (run_id, kind, website_product_id, hub_sku, match_result, category, missing_runs)
    SELECT p_run_id, 'hub_only', wp.id, wp.sku, 'hub_only', 'hub_only',
           1 + coalesce((SELECT pi.missing_runs FROM public.page365_inventory_items pi
                          WHERE pi.run_id = v_prev.id AND pi.kind = 'hub_only' AND pi.website_product_id = wp.id), 0)
      FROM public.website_products wp
     WHERE wp.status <> 'archived'
       AND public.page365_first_word(wp.sku) IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.page365_inventory_items i
                        WHERE i.run_id = p_run_id AND i.kind = 'page365'
                          AND i.code = public.page365_first_word(wp.sku))
    ON CONFLICT DO NOTHING;
  END IF;

  -- (f) Ready only if the read was clean and the catalogue did not shrink by > 20 %.
  SELECT r.page365_count INTO v_prev_count FROM public.page365_inventory_runs r
   WHERE r.id <> p_run_id AND r.status = 'ready' AND r.created_at < v_run.created_at
   ORDER BY r.created_at DESC LIMIT 1;
  IF v_errors > 0 THEN
    v_status := 'partial'; v_reason := v_errors || ' product(s) could not be read';
  ELSIF v_prev_count IS NOT NULL AND v_run.page365_count < v_prev_count * 0.8 THEN
    v_status := 'partial';
    v_reason := 'catalogue count fell from ' || v_prev_count || ' to ' || v_run.page365_count;
  ELSE
    v_status := 'ready';
  END IF;

  UPDATE public.page365_inventory_runs
     SET status = v_status, error = v_reason, previous_count = v_prev_count,
         finished_at = now(), updated_at = now()
   WHERE id = p_run_id;
  RETURN jsonb_build_object('ok', true, 'status', v_status, 'reason', v_reason);
END
$fn$;
REVOKE ALL ON FUNCTION public.page365_inventory_finish(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_inventory_finish(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 10. Apply ticked rows. A signed-in user with manage_website_catalog only
--     (the schedule is PR 3). Compare-and-set on the stock the fetch saw;
--     never below 0; an increase only when named as one; audited per row and
--     per call. Returns counts plus the item ids of each outcome.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_inventory_apply(p_run_id uuid, p_decrease_ids uuid[], p_increase_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid     uuid := auth.uid();
  v_run     public.page365_inventory_runs%ROWTYPE;
  v_id      uuid;
  v_it      public.page365_inventory_items%ROWTYPE;
  v_as_inc  boolean;
  v_found   boolean;
  v_note    text;
  v_applied uuid[] := ARRAY[]::uuid[];
  v_changed uuid[] := ARRAY[]::uuid[];
  v_skipped jsonb  := '[]'::jsonb;
  v_failed  jsonb  := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.has_permission(v_uid, 'manage_website_catalog') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'forbidden');
  END IF;
  IF cardinality(coalesce(p_decrease_ids, '{}')) + cardinality(coalesce(p_increase_ids, '{}')) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'nothing_selected');
  END IF;
  IF coalesce(p_decrease_ids, '{}') && coalesce(p_increase_ids, '{}') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'id_in_both_lists');
  END IF;

  SELECT * INTO v_run FROM public.page365_inventory_runs WHERE id = p_run_id FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'run_not_found'); END IF;
  IF v_run.status <> 'ready' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'run_not_ready', 'status', v_run.status);
  END IF;
  IF v_run.finished_at < now() - interval '24 hours' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'run_stale');
  END IF;
  IF EXISTS (SELECT 1 FROM public.page365_inventory_runs r
              WHERE r.status = 'ready' AND r.created_at > v_run.created_at) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'superseded');
  END IF;

  FOR v_id, v_as_inc IN
    SELECT x, false FROM unnest(coalesce(p_decrease_ids, '{}')) x
    UNION ALL
    SELECT x, true  FROM unnest(coalesce(p_increase_ids, '{}')) x
    ORDER BY 1
  LOOP
    SELECT * INTO v_it FROM public.page365_inventory_items WHERE id = v_id AND run_id = p_run_id FOR UPDATE;
    v_found := FOUND;
    v_note := CASE
      WHEN NOT v_found                                 THEN 'not_in_run'
      WHEN v_it.status <> 'review'                     THEN 'already_' || v_it.status
      WHEN v_it.category = 'excluded'                  THEN 'invoice_hold'
      WHEN v_it.category NOT IN ('decrease','increase') THEN 'not_a_stock_change'
      WHEN (v_it.category = 'increase') <> v_as_inc    THEN 'direction_mismatch'
      WHEN EXISTS (SELECT 1 FROM public.page365_stock_lines l
                    WHERE l.variant_id = v_it.variant_id AND l.stock_state = 'held') THEN 'invoice_hold'
      ELSE NULL END;
    IF v_note IS NOT NULL THEN
      -- A skipped row stays reviewable (status unchanged); only the note records why.
      v_skipped := v_skipped || jsonb_build_object('id', v_id, 'reason', v_note);
      IF v_found AND v_it.status = 'review' THEN
        UPDATE public.page365_inventory_items SET result_note = v_note WHERE id = v_id;
      END IF;
      CONTINUE;
    END IF;

    BEGIN
      UPDATE public.website_product_variants
         SET stock_qty = v_it.proposed_stock, updated_at = now()
       WHERE id = v_it.variant_id AND stock_qty = v_it.seen_stock;
      IF FOUND THEN
        UPDATE public.page365_inventory_items
           SET status = 'applied', applied_at = now(), applied_by = v_uid, result_note = NULL
         WHERE id = v_id;
        INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id)
        VALUES ('website_product_variant', v_it.variant_id, 'page365_inventory_applied',
                jsonb_build_object('stock_qty', v_it.seen_stock),
                jsonb_build_object('stock_qty', v_it.proposed_stock, 'run_id', p_run_id, 'item_id', v_id,
                                   'code', v_it.code, 'direction', v_it.category,
                                   'page365_available', v_it.page365_available, 'web_holds', v_it.web_holds),
                v_uid);
        v_applied := v_applied || v_id;
      ELSE
        UPDATE public.page365_inventory_items
           SET status = 'changed_since_fetch', result_note = 'stock changed after the fetch; fetch again'
         WHERE id = v_id;
        v_changed := v_changed || v_id;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.page365_inventory_items SET status = 'failed', result_note = left(SQLERRM, 300) WHERE id = v_id;
      v_failed := v_failed || jsonb_build_object('id', v_id, 'reason', left(SQLERRM, 300));
    END;
  END LOOP;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id)
  VALUES ('page365_inventory_run', p_run_id, 'page365_inventory_apply',
          jsonb_build_object('applied', cardinality(v_applied), 'changed_since_fetch', cardinality(v_changed),
                             'skipped', jsonb_array_length(v_skipped), 'failed', jsonb_array_length(v_failed),
                             'decreases_sent', cardinality(coalesce(p_decrease_ids, '{}')),
                             'increases_sent', cardinality(coalesce(p_increase_ids, '{}'))),
          v_uid);

  RETURN jsonb_build_object('ok', true,
    'applied', cardinality(v_applied), 'changed_since_fetch', cardinality(v_changed),
    'skipped', jsonb_array_length(v_skipped), 'failed', jsonb_array_length(v_failed),
    'applied_ids', to_jsonb(v_applied), 'changed_ids', to_jsonb(v_changed),
    'skipped_items', v_skipped, 'failed_items', v_failed);
END
$fn$;
REVOKE ALL ON FUNCTION public.page365_inventory_apply(uuid, uuid[], uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.page365_inventory_apply(uuid, uuid[], uuid[]) TO authenticated;

-- ---------------------------------------------------------------------------
-- 11. Record one copied photo. Service role only (edge fn
--     page365-inventory-photos, after the file is in storage).
--       same id, same version      -> 'exists'   (nothing written)
--       same id, new version       -> 'replaced' (url + version in place)
--       a staff-imported hotlink to this exact Page365 file -> 'replaced_hotlink'
--       otherwise                  -> 'inserted'
--     Page365 photos keep Page365's order (p_index 0 = Page365's main). When
--     the variant has STAFF photos they stay first and in their order; the
--     Page365 photos go after them.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_inventory_record_photo(
  p_item_id uuid, p_photo_id bigint, p_version text, p_url text, p_source_url text, p_index integer, p_actor uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_it    public.page365_inventory_items%ROWTYPE;
  v_run   text;
  v_row   public.website_product_media%ROWTYPE;
  v_have  boolean;
  v_base  integer;
  v_alt   text;
  v_out   text;
BEGIN
  SELECT * INTO v_it FROM public.page365_inventory_items WHERE id = p_item_id;
  IF NOT FOUND OR v_it.match_result <> 'matched' OR v_it.variant_id IS NULL THEN RETURN 'not_matched'; END IF;
  SELECT status INTO v_run FROM public.page365_inventory_runs WHERE id = v_it.run_id;
  IF v_run IS DISTINCT FROM 'ready' THEN RETURN 'run_not_ready'; END IF;
  IF p_photo_id IS NULL OR coalesce(p_url, '') = '' OR p_index IS NULL OR p_index < 0 THEN RETURN 'bad_input'; END IF;
  -- Never let the copy point anywhere but the Hub's own public bucket.
  IF p_url !~ '^https://[^/]+/storage/v1/object/public/promotions/website/page365/' THEN RETURN 'bad_url'; END IF;

  -- Serialise per variant so two copies cannot race the sort base.
  PERFORM 1 FROM public.website_product_variants WHERE id = v_it.variant_id FOR UPDATE;

  SELECT * INTO v_row FROM public.website_product_media
   WHERE variant_id = v_it.variant_id AND page365_photo_id = p_photo_id;
  v_have := FOUND;
  IF v_have AND v_row.page365_photo_version IS NOT DISTINCT FROM p_version THEN RETURN 'exists'; END IF;

  -- Staff photos (never a Page365 id, never a Page365 hotlink) keep their places.
  SELECT coalesce(max(m.sort) + 1, 0) INTO v_base FROM public.website_product_media m
   WHERE m.variant_id = v_it.variant_id AND m.page365_photo_id IS NULL
     AND m.url NOT LIKE 'https://assets.page365.net/%';
  SELECT coalesce(nullif(btrim(wp.name), ''), wp.sku) INTO v_alt
    FROM public.website_products wp WHERE wp.id = v_it.website_product_id;

  IF v_have THEN
    UPDATE public.website_product_media
       SET url = p_url, page365_photo_version = p_version, sort = v_base + p_index
     WHERE id = v_row.id;
    v_out := 'replaced';
  ELSE
    UPDATE public.website_product_media m
       SET url = p_url, page365_photo_id = p_photo_id, page365_photo_version = p_version, sort = v_base + p_index
     WHERE m.id = (SELECT m2.id FROM public.website_product_media m2
                    WHERE m2.variant_id = v_it.variant_id AND m2.page365_photo_id IS NULL
                      AND coalesce(p_source_url, '') <> ''
                      AND split_part(m2.url, '?', 1) = split_part(p_source_url, '?', 1)
                    ORDER BY m2.sort LIMIT 1);
    IF FOUND THEN
      v_out := 'replaced_hotlink';
    ELSE
      INSERT INTO public.website_product_media (variant_id, url, alt, sort, page365_photo_id, page365_photo_version)
      VALUES (v_it.variant_id, p_url, v_alt, v_base + p_index, p_photo_id, p_version)
      ON CONFLICT (variant_id, page365_photo_id) WHERE page365_photo_id IS NOT NULL DO NOTHING;
      IF NOT FOUND THEN RETURN 'exists'; END IF;
      v_out := 'inserted';
    END IF;
  END IF;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id)
  VALUES ('website_product_variant', v_it.variant_id, 'page365_photo_copied',
          jsonb_build_object('run_id', v_it.run_id, 'item_id', p_item_id, 'code', v_it.code, 'outcome', v_out,
                             'page365_photo_id', p_photo_id, 'version', p_version, 'url', p_url, 'sort', v_base + p_index),
          p_actor);
  RETURN v_out;
END
$fn$;
REVOKE ALL ON FUNCTION public.page365_inventory_record_photo(uuid, bigint, text, text, text, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_inventory_record_photo(uuid, bigint, text, text, text, integer, uuid) TO service_role;

-- The schedule (PR 3) reads this; seeded off and unused in PR 1.
INSERT INTO public.system_settings (key, value)
VALUES ('page365_inventory_auto_apply', 'false'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 12. Self-check, still inside the transaction. Pure reads; any failure aborts
--     the whole file with nothing changed.
-- ---------------------------------------------------------------------------
DO $self$
DECLARE
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.page365_web_holds(uuid)', 'public.page365_inventory_claim(uuid,integer)',
    'public.page365_inventory_store_product(uuid,jsonb,text)', 'public.page365_inventory_finish(uuid)',
    'public.page365_inventory_record_photo(uuid,bigint,text,text,text,integer,uuid)'] LOOP
    IF has_function_privilege('authenticated', v_fn, 'EXECUTE') OR has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'page365_inventory_fetch self-check: % is callable by a browser role', v_fn;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'public.page365_inventory_apply(uuid,uuid[],uuid[])', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.page365_inventory_apply(uuid,uuid[],uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'page365_inventory_fetch self-check: page365_inventory_apply grants are wrong';
  END IF;
  IF has_table_privilege('authenticated', 'public.page365_inventory_items', 'INSERT')
     OR has_table_privilege('authenticated', 'public.page365_inventory_items', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.page365_inventory_runs', 'INSERT')
     OR has_table_privilege('anon', 'public.page365_inventory_items', 'SELECT') THEN
    RAISE EXCEPTION 'page365_inventory_fetch self-check: a browser role can write the run tables';
  END IF;
  IF to_regclass('public.uq_website_product_media_page365_photo') IS NULL THEN
    RAISE EXCEPTION 'page365_inventory_fetch self-check: photo de-duplication index missing';
  END IF;
  IF (SELECT count(*) FROM public.website_product_media WHERE page365_photo_id IS NOT NULL) > 0
     AND NOT EXISTS (SELECT 1 FROM public.page365_inventory_runs) THEN
    RAISE EXCEPTION 'page365_inventory_fetch self-check: media rows carry a Page365 photo id before any run';
  END IF;
END
$self$;

COMMIT;

-- ===========================================================================
-- Verification (read-only). Run after COMMIT.
--
-- (1) Objects exist; expect: t | t | t | t | t | t | t | t
-- SELECT to_regclass('public.page365_inventory_runs') IS NOT NULL      AS runs,
--        to_regclass('public.page365_inventory_chunks') IS NOT NULL    AS chunks,
--        to_regclass('public.page365_inventory_products') IS NOT NULL  AS products,
--        to_regclass('public.page365_inventory_items') IS NOT NULL     AS items,
--        to_regclass('public.uq_website_product_media_page365_photo') IS NOT NULL AS photo_uniq,
--        to_regprocedure('public.page365_inventory_apply(uuid,uuid[],uuid[])') IS NOT NULL AS apply,
--        to_regprocedure('public.page365_inventory_finish(uuid)') IS NOT NULL AS finish,
--        to_regprocedure('public.page365_inventory_record_photo(uuid,bigint,text,text,text,integer,uuid)') IS NOT NULL AS photo;
--
-- (2) Nothing has run and nothing moved; expect: 0 | 0 | 0
-- SELECT (SELECT count(*) FROM public.page365_inventory_runs) AS runs,
--        (SELECT count(*) FROM public.page365_inventory_items) AS items,
--        (SELECT count(*) FROM public.website_product_media WHERE page365_photo_id IS NOT NULL) AS copied_photos;
--
-- (3) Browser roles: only apply is callable, only by signed-in users; expect: t | f | f | f | f
-- SELECT has_function_privilege('authenticated','public.page365_inventory_apply(uuid,uuid[],uuid[])','EXECUTE') AS auth_apply,
--        has_function_privilege('anon','public.page365_inventory_apply(uuid,uuid[],uuid[])','EXECUTE')          AS anon_apply,
--        has_function_privilege('authenticated','public.page365_inventory_finish(uuid)','EXECUTE')              AS auth_finish,
--        has_function_privilege('authenticated','public.page365_web_holds(uuid)','EXECUTE')                     AS auth_holds,
--        has_table_privilege('authenticated','public.page365_inventory_items','UPDATE')                         AS auth_write;
--
-- (4) Website holds today (informational: the pieces a fetch will subtract);
--     expect one row per variant with a live unconfirmed web hold, or none.
-- SELECT v.id, wp.sku, v.stock_qty, public.page365_web_holds(v.id) AS web_holds
--   FROM public.website_product_variants v JOIN public.website_products wp ON wp.id = v.product_id
--  WHERE public.page365_web_holds(v.id) > 0 ORDER BY wp.sku;
--
-- (5) #195 invoice holds that PR 1 will EXCLUDE; expect 0 or more rows.
-- SELECT wp.sku, count(*) AS held_lines FROM public.page365_stock_lines l
--   JOIN public.website_product_variants v ON v.id = l.variant_id JOIN public.website_products wp ON wp.id = v.product_id
--  WHERE l.stock_state = 'held' GROUP BY wp.sku ORDER BY wp.sku;
--
-- (6) The seeded setting; expect: false
-- SELECT value FROM public.system_settings WHERE key = 'page365_inventory_auto_apply';
-- ===========================================================================

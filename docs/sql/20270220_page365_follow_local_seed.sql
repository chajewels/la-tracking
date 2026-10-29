-- ============================================================================
-- Page365 follow + Catalog delete (2026-10-29) — LOCAL seed. Local Postgres
-- ONLY. Run AFTER 20270220_page365_follow_local_stub.sql and BEFORE the
-- migration, so the migration's link backfill and one-time name pass have
-- something to do (see the stub's header for the whole sequence).
--
-- Live shape reproduced (read-only evidence 2026-10-29):
--   * three active products read by code every time but never linked:
--     N1616, R7828, R3341 (backfill candidates); 8C100 is Hub-only (not in
--     Page365); N4020 is a website sample switched off ("Don't sync").
--   * linked products whose Hub name differs from Page365's:
--       SA100  never completed (Hub = an old Page365 text; Page365 switched
--              "[Used]" -> "[Preloved]")             -> the pass UPDATES it
--       SB200  completed by staff ("Blue Topaz" vs "B.T") -> the pass KEEPS it
--       SC300  identical                                  -> untouched
-- ============================================================================
\set ON_ERROR_STOP 1
CREATE OR REPLACE FUNCTION pg_temp.p(pid bigint, name text, avail integer DEFAULT 1) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('pid', pid, 'list_name', name,
    'detail', jsonb_build_object('name', name, 'price_jpy', 50000, 'full_price_jpy', NULL, 'photos', '[]'::jsonb,
      'variants', jsonb_build_array(jsonb_build_object('id', pid * 10, 'name', NULL, 'code', split_part(name, ' ', 1),
        'price_jpy', 50000, 'full_price_jpy', NULL, 'available', avail)))) $$;
CREATE OR REPLACE FUNCTION pg_temp.run(p_list jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_run uuid; r record; d jsonb;
BEGIN
  INSERT INTO public.page365_inventory_runs(source, kind, page365_count, products_total)
  VALUES ('manual', 'full', jsonb_array_length(p_list), jsonb_array_length(p_list)) RETURNING id INTO v_run;
  INSERT INTO public.page365_inventory_products(run_id, page365_product_id, list_name)
  SELECT v_run, (x->>'pid')::bigint, x->>'list_name' FROM jsonb_array_elements(p_list) x;
  LOOP
    FOR r IN SELECT * FROM public.page365_inventory_claim(v_run, 100) LOOP
      SELECT x INTO d FROM jsonb_array_elements(p_list) x WHERE (x->>'pid')::bigint = r.o_page365_product_id;
      PERFORM public.page365_inventory_store_product(r.o_id, d->'detail', NULL);
    END LOOP;
    EXIT WHEN (public.page365_inventory_finish(v_run)->>'ok')::boolean;
  END LOOP;
  PERFORM pg_sleep(0.01);
  RETURN v_run;
END $$;

DELETE FROM public.page365_inventory_runs;
DELETE FROM public.staff_notifications;
DELETE FROM public.audit_logs;
UPDATE public.website_products SET status = 'archived';

INSERT INTO public.website_products(sku, name, status, origin, metals, page365_sync_disabled) VALUES
  ('N1616', 'N1616 Necklace K18 Diamond Pave', 'active', 'JAPAN', ARRAY['K18'], false),
  ('R7828', 'R7828 Ring PT900 Sapphire Halo', 'active', 'JAPAN', ARRAY['PT900'], false),
  ('R3341', 'R3341 Ring K18 Ruby Solitaire', 'active', 'JAPAN', ARRAY['K18'], false),
  ('8C100', '8C100 Hub only sample', 'active', 'JAPAN', ARRAY['K18'], false),
  ('N4020', 'N4020 Website sample necklace', 'active', 'JAPAN', ARRAY['K18'], true),
  ('SA100', 'SA100 Ring Diamond [Used]', 'active', 'JAPAN', ARRAY['K18'], false),
  ('SB200', 'SB200 Necklace Blue Topaz 1.2ct', 'active', 'JAPAN', ARRAY['K18'], false),
  ('SC300', 'SC300 Bracelet Pearl 18cm', 'active', 'JAPAN', ARRAY['K18'], false);
INSERT INTO public.website_product_variants(product_id, stock_qty, price_jpy)
SELECT id, 1, 50000 FROM public.website_products WHERE status = 'active';
-- name_ja on SA100 so the pass is seen clearing it
UPDATE public.website_products SET name_ja = 'SA100 リング ダイヤ [中古]' WHERE sku = 'SA100';
-- the three already-linked ones
UPDATE public.website_products SET page365_product_id = 811005, page365_variant_id = 8110050 WHERE sku = 'SA100';
UPDATE public.website_products SET page365_product_id = 811006, page365_variant_id = 8110060 WHERE sku = 'SB200';
UPDATE public.website_products SET page365_product_id = 811007, page365_variant_id = 8110070 WHERE sku = 'SC300';

-- Two earlier complete reads (Page365 said "[Used]"), then the latest (it says "[Preloved]").
SELECT pg_temp.run(jsonb_build_array(
  pg_temp.p(811001, 'N1616 Necklace K18 Diamond Pave'), pg_temp.p(811002, 'R7828 Ring PT900 Sapphire Halo'),
  pg_temp.p(811003, 'R3341 Ring K18 Ruby Solitaire'), pg_temp.p(811004, 'N4020 Website sample necklace'),
  pg_temp.p(811005, 'SA100 Ring Diamond [Used]'), pg_temp.p(811006, 'SB200 Necklace B.T 1.2ct'),
  pg_temp.p(811007, 'SC300 Bracelet Pearl 18cm')));
SELECT pg_temp.run(jsonb_build_array(
  pg_temp.p(811001, 'N1616 Necklace K18 Diamond Pave'), pg_temp.p(811002, 'R7828 Ring PT900 Sapphire Halo'),
  pg_temp.p(811003, 'R3341 Ring K18 Ruby Solitaire'), pg_temp.p(811004, 'N4020 Website sample necklace'),
  pg_temp.p(811005, 'SA100 Ring Diamond [Used]'), pg_temp.p(811006, 'SB200 Necklace B.T 1.2ct'),
  pg_temp.p(811007, 'SC300 Bracelet Pearl 18cm')));
SELECT pg_temp.run(jsonb_build_array(
  pg_temp.p(811001, 'N1616 Necklace K18 Diamond Pave'), pg_temp.p(811002, 'R7828 Ring PT900 Sapphire Halo'),
  pg_temp.p(811003, 'R3341 Ring K18 Ruby Solitaire'), pg_temp.p(811004, 'N4020 Website sample necklace'),
  pg_temp.p(811005, 'SA100 Ring Diamond [Preloved]'), pg_temp.p(811006, 'SB200 Necklace B.T 1.2ct'),
  pg_temp.p(811007, 'SC300 Bracelet Pearl 18cm')));
SELECT count(*) AS seed_runs FROM public.page365_inventory_runs WHERE status = 'ready';

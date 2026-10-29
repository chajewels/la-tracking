-- ===========================================================================
-- page365_follow_and_catalog_delete — the Hub FOLLOWS a Page365 listing's
-- code, name and photos, and a Catalog product can be DELETED (owner
-- decisions 2026-10-29; plan: docs/PAGE365-FOLLOW-AND-DELETE-PLAN.md).
--
-- Evidence (live, read-only, 2026-10-29): Page365 listing 80622155 was re-coded
-- N1073 -> N9140 on 17 Oct; the Hub product (draft, linked page365_product_id
-- 80622155) stayed N1073 because page365_inventory_finish matches ONLY by the
-- code, so every read put the N9140 row in review as 'unmatched' / 'new' and
-- page365_inventory_land_run skipped it as 'already_landed' — silently. The
-- Catalog Delete failed for the 11 products that own kind='hub_only' rows:
-- the FK SET NULLs their website_product_id and the CHECK
-- page365_inventory_item_kind refuses a hub_only row without one; every delete
-- also scanned 878k item rows (no index on website_product_id) against the
-- 8 s statement_timeout. NO FOREIGN KEY CHANGES are made.
--
-- WHAT THIS FILE DOES
--   1. idx_page365_inventory_items_product (plain CREATE INDEX; CONCURRENTLY
--      cannot run inside a migration). Expected build: seconds to low tens of
--      seconds on ~879k rows (an estimate — not measured); writers wait.
--   2. website_products.first_published_at (stamped ONCE when a product first
--      becomes 'active'; backfilled conservatively) — the only way to tell a
--      product that was never public, whose slug may therefore be regenerated.
--   3. page365_listing_names (the Page365 name the Hub last saw; seen_names;
--      one bell per change; ja_pending), seeded from the full item history.
--   4. page365_inventory_follow_code (step a3 of finish, BEFORE matching): a
--      pending item whose listing id equals exactly one non-switched-off Hub
--      product but whose code differs renames that product (sku, name, name_ja
--      code word; slug only if never published; presence code) so matching
--      then finds it by the new code. A code another Hub product owns: no
--      write, ONE bell page365_recode_blocked.
--   5. page365_follow_names / page365_inventory_follow_listing (step h of
--      finish, after landing): NAME follow (Page365-now vs Page365-last-seen,
--      never vs the Hub name; a Hub name that is still exactly a Page365 name
--      seen before is replaced, a completed one is kept + ONE bell),
--      PHOTO follow in Page365 order (removed photos deleted, others
--      re-sorted; staff photos untouched; an empty list deletes nothing) and
--      REVIEW restore. PRICE is never written.
--   6. delete_website_product_atomic: the one delete path.
--   7. product_review_detached (+ page365_restore_reviews).
--   8. Link backfill (raises unless the candidates are exactly N1616, R7828,
--      R3341) and the one-time name pass (no per-product bells, one summary).
--   Changes no stock, no status, no price, no setting (the self-check proves it).
--
-- FUNCTION CHANGES START FROM LIVE (CLAUDE.md, Bug #280). md5(pg_proc.prosrc):
--   replaced   page365_inventory_finish   a697a6d379ec69f3cac25cd8241cef2f -> 5c5704eb68e50cf4cf2a94d95f78efcf
--   unchanged  page365_inventory_land_run                7f27675ecd45453b1577fa5f6e6ba738
--              page365_match_line                        4bec82da4f6af03df8f0827d78f42001
--              page365_first_word                        7265832b2db007bd380452531c4a1c9b
--              page365_inventory_auto_apply_run          d9d251fb68aac0acf9a5360b22fddc07
--              page365_inventory_follow                  6e26568441fc308c42426de238fb165f
--              page365_inventory_hide_item               3a0a932b88cdd1534a9c0285f8ea392b
--              page365_inventory_apply                   e65757c2f32b597b2a55047d77783df3
--              page365_inventory_record_photo            c8f94536cf40167fe43a24967a6eefe9
--              page365_inventory_store_product           6ae646ee897b92ca7aa5002f8c416743
--              page365_name_words                        95ce02b0ce70b692ce08f2f366ce1a08
--              page365_name_score                        e441174cdbed966f9611a6c9f57aaf48
--              page365_listing_text                      7608a3ccc02ec141038ea88dd6b25a67
--   new        page365_norm_name / _swap_code / _make_slug / _pending_ja_names / _set_name_ja / _inventory_follow_code /
--              _follow_names / _inventory_follow_listing / _restore_reviews /
--              delete_website_product_atomic / website_products_stamp_first_published
--   Live md5s read 2026-10-29 13:45 JST; each equals the repo text of
--   20261005100000 / 20270215100000 (proved by replaying the repo locally).
--   land_run is NOT edited: finish step (h) restores a re-landed piece's
--   reviews right after landing, so a failure there can never undo a landing.
-- ===========================================================================

SET LOCAL lock_timeout = '60s';
SET LOCAL statement_timeout = '300s';

-- ---------------------------------------------------------------------------
-- 0. Pre-flight. Nothing below runs unless every check passes.
-- ---------------------------------------------------------------------------
DO $pre$
DECLARE
  v_bad text := '';
  v_got text;
  r     record;
BEGIN
  IF to_regclass('public.page365_inventory_items') IS NULL OR to_regclass('public.page365_inventory_runs') IS NULL
     OR to_regclass('public.page365_inventory_products') IS NULL OR to_regclass('public.website_products') IS NULL
     OR to_regclass('public.website_product_media') IS NULL OR to_regclass('public.staff_notifications') IS NULL
     OR to_regclass('public.page365_product_presence') IS NULL OR to_regclass('public.website_live_claims') IS NULL
     OR to_regclass('public.product_reviews') IS NULL OR to_regclass('public.product_review_products') IS NULL THEN
    RAISE EXCEPTION 'page365_follow_and_catalog_delete: a required table is missing';
  END IF;

  FOR r IN
    SELECT * FROM (VALUES
      ('page365_inventory_finish(uuid)',          'a697a6d379ec69f3cac25cd8241cef2f', '5c5704eb68e50cf4cf2a94d95f78efcf'),
      ('page365_inventory_land_run(uuid)',        '7f27675ecd45453b1577fa5f6e6ba738', NULL),
      ('page365_match_line(text)',                '4bec82da4f6af03df8f0827d78f42001', NULL),
      ('page365_first_word(text)',                '7265832b2db007bd380452531c4a1c9b', NULL),
      ('page365_inventory_auto_apply_run(uuid)',  'd9d251fb68aac0acf9a5360b22fddc07', NULL),
      ('page365_inventory_follow(uuid)',          '6e26568441fc308c42426de238fb165f', NULL),
      ('page365_inventory_hide_item(uuid,uuid,uuid,text)', '3a0a932b88cdd1534a9c0285f8ea392b', NULL),
      ('page365_inventory_apply(uuid,uuid[],uuid[])',      'e65757c2f32b597b2a55047d77783df3', NULL),
      ('page365_inventory_record_photo(uuid,bigint,text,text,text,integer,uuid)', 'c8f94536cf40167fe43a24967a6eefe9', NULL),
      ('page365_inventory_store_product(uuid,jsonb,text)', '6ae646ee897b92ca7aa5002f8c416743', NULL),
      ('page365_name_words(text,text)',           '95ce02b0ce70b692ce08f2f366ce1a08', NULL),
      ('page365_name_score(text,text,text)',      'e441174cdbed966f9611a6c9f57aaf48', NULL),
      ('page365_listing_text(uuid)',              '7608a3ccc02ec141038ea88dd6b25a67', NULL)
    ) AS t(fn, want, or_new)
  LOOP
    SELECT md5(p.prosrc) INTO v_got FROM pg_proc p WHERE p.oid = to_regprocedure('public.' || r.fn);
    IF v_got IS DISTINCT FROM r.want AND v_got IS DISTINCT FROM r.or_new THEN
      v_bad := v_bad || format(E'\n  %s: live body md5 %s, expected %s', r.fn, coalesce(v_got, 'missing'), r.want);
    END IF;
  END LOOP;
  IF v_bad <> '' THEN
    RAISE EXCEPTION 'page365_follow_and_catalog_delete: live is not what this was written against — nothing changed:%', v_bad;
  END IF;

  -- For the self-check: no stock, no status moved (names/skus/links move by design).
  PERFORM set_config('page365.follow_before',
    (SELECT count(*)::text FROM public.website_products) || '|'
    || (SELECT md5(coalesce(string_agg(wp.id::text || ':' || wp.status::text, ',' ORDER BY wp.id), '')) FROM public.website_products wp)
    || (SELECT md5(coalesce(string_agg(v.id::text || ':' || v.stock_qty || ':' || coalesce(v.price_jpy, -1), ',' ORDER BY v.id), '')) FROM public.website_product_variants v)
    || (SELECT md5(coalesce(string_agg(s.key || '=' || s.value::text, ',' ORDER BY s.key), '')) FROM public.system_settings s
         WHERE s.key LIKE 'page365%'),
    false);   -- session-level: this file has no BEGIN/COMMIT, so each statement is its own transaction
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. The index the delete needs (the FK SET NULL scanned the whole table).
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_page365_inventory_items_product
  ON public.page365_inventory_items (website_product_id) WHERE website_product_id IS NOT NULL;

-- A listing photo that kept failing to copy: retried at most 3 times per read.
ALTER TABLE public.page365_inventory_items ADD COLUMN IF NOT EXISTS photo_attempts integer NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 2. first_published_at — "has this product ever been public?"
-- ---------------------------------------------------------------------------
ALTER TABLE public.website_products ADD COLUMN IF NOT EXISTS first_published_at timestamptz;
COMMENT ON COLUMN public.website_products.first_published_at IS
  '2026-10-29. Stamped ONCE when the product first becomes active (website_products_stamp_first_published); never cleared. NULL = never public, so a re-code may regenerate its slug (page365_inventory_follow_code). Backfilled conservatively: any sign of past publication counts.';

CREATE OR REPLACE FUNCTION public.website_products_stamp_first_published()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.first_published_at IS NOT NULL THEN
    NEW.first_published_at := OLD.first_published_at;
  ELSIF NEW.first_published_at IS NULL AND NEW.status::text = 'active' THEN
    NEW.first_published_at := now();
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.website_products_stamp_first_published() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_website_products_first_published ON public.website_products;
CREATE TRIGGER trg_website_products_first_published
  BEFORE INSERT OR UPDATE OF status, first_published_at ON public.website_products
  FOR EACH ROW EXECUTE FUNCTION public.website_products_stamp_first_published();

-- Backfill: any sign of past publication. Unsure = published (the slug is kept).
UPDATE public.website_products wp
   SET first_published_at = coalesce(wp.created_at, now())
 WHERE wp.first_published_at IS NULL
   AND ( wp.status::text <> 'draft'
      OR EXISTS (SELECT 1 FROM public.audit_logs a WHERE a.entity_id = wp.id
                  AND a.action IN ('website_product_published', 'page365_inventory_hidden'))
      OR EXISTS (SELECT 1 FROM public.cash_order_items x WHERE x.website_product_id = wp.id)
      OR EXISTS (SELECT 1 FROM public.layaway_account_items x WHERE x.website_product_id = wp.id)
      OR EXISTS (SELECT 1 FROM public.web_order_draft_lines x WHERE x.website_product_id = wp.id)
      OR EXISTS (SELECT 1 FROM public.customer_cart_lines x JOIN public.website_product_variants v ON v.id = x.variant_id
                  WHERE v.product_id = wp.id) );

-- ---------------------------------------------------------------------------
-- 3. Tables.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.page365_listing_names (
  website_product_id uuid PRIMARY KEY REFERENCES public.website_products(id) ON DELETE CASCADE,
  page365_product_id bigint,
  page365_variant_id bigint,
  last_p365_name     text,
  seen_names         text[] NOT NULL DEFAULT ARRAY[]::text[],
  bell_name          text,
  ja_pending         boolean NOT NULL DEFAULT false,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.page365_listing_names IS
  '2026-10-29. The Page365 name the Hub last saw for a linked product (last_p365_name), every distinct name seen (seen_names, newest 30) and the one we last rang a bell about (bell_name). A change is detected against last_p365_name, NEVER against the Hub name, so a Hub-completed name is never cut back. ja_pending = name_ja must be regenerated (page365-inventory-fetch).';
ALTER TABLE public.page365_listing_names ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Catalog staff read listing names" ON public.page365_listing_names;
CREATE POLICY "Catalog staff read listing names" ON public.page365_listing_names
  FOR SELECT TO authenticated USING ((SELECT public.has_permission((SELECT auth.uid()), 'manage_website_catalog')));
REVOKE ALL ON public.page365_listing_names FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.page365_listing_names TO authenticated;
GRANT ALL ON public.page365_listing_names TO service_role;

CREATE TABLE IF NOT EXISTS public.product_review_detached (
  review_id          uuid NOT NULL REFERENCES public.product_reviews(id) ON DELETE CASCADE,
  page365_product_id bigint NOT NULL,
  page365_variant_id bigint NOT NULL,
  was_linked         boolean NOT NULL DEFAULT false,
  was_primary        boolean NOT NULL DEFAULT false,
  detached_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (review_id, page365_product_id, page365_variant_id)
);
CREATE INDEX IF NOT EXISTS idx_product_review_detached_listing
  ON public.product_review_detached (page365_product_id, page365_variant_id);
COMMENT ON TABLE public.product_review_detached IS
  '2026-10-29. Which reviews a deleted Catalog product carried, by Page365 listing: was_linked = a product_review_products row, was_primary = product_reviews.website_product_id. page365_restore_reviews puts BOTH back when the listing lands again, then deletes the rows.';
ALTER TABLE public.product_review_detached ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.product_review_detached FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.product_review_detached TO service_role;

-- ---------------------------------------------------------------------------
-- 4. Helpers (chr() for U+3000 / NBSP — never a literal in SQL text).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_norm_name(p_name text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path TO 'public'
AS $fn$
  SELECT btrim(regexp_replace(lower(coalesce(p_name, '')), '[\s' || chr(12288) || chr(160) || ']+', ' ', 'g'))
$fn$;
REVOKE ALL ON FUNCTION public.page365_norm_name(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_norm_name(text) TO service_role;
COMMENT ON FUNCTION public.page365_norm_name(text) IS
  '2026-10-29. Name comparison form: lower-cased, every whitespace run (incl. U+3000, NBSP) one space, trimmed. TS twin: normalName in _shared/page365-inventory.ts.';

CREATE OR REPLACE FUNCTION public.page365_swap_code(p_name text, p_code text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path TO 'public'
AS $fn$
  SELECT CASE WHEN btrim(coalesce(p_name, '')) = '' THEN p_name
              ELSE regexp_replace(p_name, '^[\s' || chr(12288) || chr(160) || ']*[^\s' || chr(12288) || chr(160) || ']+', p_code) END
$fn$;
REVOKE ALL ON FUNCTION public.page365_swap_code(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_swap_code(text, text) TO service_role;
COMMENT ON FUNCTION public.page365_swap_code(text, text) IS
  '2026-10-29. The name with its first word (the code) replaced by p_code; the rest is kept as written. TS twin: swapCode in _shared/page365-inventory.ts.';

-- The slug land_run gives a new product (code + name minus its code), unique.
CREATE OR REPLACE FUNCTION public.page365_make_slug(p_code text, p_name text, p_variant_id bigint, p_exclude uuid)
RETURNS text LANGUAGE plpgsql STABLE SET search_path TO 'public'
AS $fn$
DECLARE v_slug text;
BEGIN
  v_slug := left(btrim(regexp_replace(lower(p_code || '-' || regexp_replace(coalesce(p_name, ''), '^\S+\s*', '')),
                                      '[^a-z0-9]+', '-', 'g'), '-'), 90);
  IF v_slug = '' THEN v_slug := lower(p_code); END IF;
  IF EXISTS (SELECT 1 FROM public.website_products x WHERE x.slug = v_slug AND x.id IS DISTINCT FROM p_exclude) THEN
    v_slug := v_slug || '-' || p_variant_id;
  END IF;
  RETURN v_slug;
END
$fn$;
REVOKE ALL ON FUNCTION public.page365_make_slug(text, text, bigint, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_make_slug(text, text, bigint, uuid) TO service_role;
COMMENT ON FUNCTION public.page365_make_slug(text, text, bigint, uuid) IS
  '2026-10-29. page365_inventory_land_run''s slug recipe as a function: lower(code-name minus code) on [a-z0-9], <= 90 chars, -<variant id> on a collision. Used only for a product that was never public (first_published_at IS NULL).';

-- ---------------------------------------------------------------------------
-- 5. Step (a3): a linked listing whose CODE changed on Page365.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_inventory_follow_code(p_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  r         record;
  v_name    text;
  v_slug    text;
  v_old_ja  text;
  v_followed integer := 0;
  v_blocked  integer := 0;
BEGIN
  FOR r IN
    SELECT i.id AS item_id, i.code AS new_code, i.page365_product_id AS ppid, i.page365_variant_id AS pvid,
           wp.id AS pid, wp.sku, wp.name, wp.name_ja, wp.slug, wp.first_published_at,
           public.page365_first_word(wp.sku) AS old_code
      FROM public.page365_inventory_items i
      JOIN public.website_products wp
        ON wp.page365_product_id = i.page365_product_id AND wp.page365_variant_id = i.page365_variant_id
     WHERE i.run_id = p_run_id AND i.kind = 'page365' AND i.match_result = 'pending' AND i.code IS NOT NULL
       AND NOT coalesce(wp.page365_sync_disabled, false)
       AND public.page365_first_word(wp.sku) IS DISTINCT FROM i.code
     ORDER BY i.id
  LOOP
    -- Another Hub product already owns the new code: never a guess.
    IF EXISTS (SELECT 1 FROM public.website_products x
                WHERE x.id <> r.pid AND public.page365_first_word(x.sku) = r.new_code) THEN
      UPDATE public.page365_inventory_items SET result_note = 'code_exists_other_piece' WHERE id = r.item_id;
      v_blocked := v_blocked + 1;
      IF NOT EXISTS (SELECT 1 FROM public.staff_notifications n
                      WHERE n.type = 'page365_recode_blocked' AND n.metadata->>'website_product_id' = r.pid::text
                        AND n.metadata->>'new_code' = r.new_code) THEN
        INSERT INTO public.staff_notifications (type, title, body, metadata)
        VALUES ('page365_recode_blocked', 'Page365: new code already used in the Hub',
                'Page365 now codes listing ' || r.ppid || ' as ' || r.new_code || ', but the Hub product ' || r.sku
                  || ' (' || coalesce(r.name, '') || ') is linked to it and another Hub product already has ' || r.new_code
                  || '. The Hub did not rename anything. Fix one of the two codes.',
                jsonb_build_object('run_id', p_run_id, 'website_product_id', r.pid, 'old_code', r.old_code,
                                   'new_code', r.new_code, 'page365_product_id', r.ppid));
      END IF;
      CONTINUE;
    END IF;

    v_name := public.page365_swap_code(r.name, r.new_code);
    v_old_ja := r.name_ja;
    v_slug := r.slug;
    -- Never public: the slug follows the new code + name (land_run's recipe).
    IF r.first_published_at IS NULL THEN
      v_slug := public.page365_make_slug(r.new_code, v_name, r.pvid, r.pid);
    END IF;

    UPDATE public.website_products
       SET sku = public.page365_swap_code(sku, r.new_code),
           name = v_name,
           name_ja = CASE WHEN name_ja IS NOT NULL AND public.page365_first_word(name_ja) = r.old_code
                          THEN public.page365_swap_code(name_ja, r.new_code) ELSE name_ja END,
           slug = v_slug
     WHERE id = r.pid;
    UPDATE public.page365_product_presence SET code = r.new_code, updated_at = now() WHERE website_product_id = r.pid;
    INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id)
    VALUES ('website_product', r.pid, 'page365_code_followed',
            jsonb_build_object('sku', r.sku, 'name', r.name, 'slug', r.slug),
            jsonb_build_object('sku', public.page365_swap_code(r.sku, r.new_code), 'name', v_name, 'slug', v_slug,
                               'run_id', p_run_id, 'page365_product_id', r.ppid, 'page365_variant_id', r.pvid,
                               'slug_regenerated', v_slug IS DISTINCT FROM r.slug),
            NULL);
    UPDATE public.page365_inventory_items SET result_note = 'code_followed' WHERE id = r.item_id;
    v_followed := v_followed + 1;
  END LOOP;
  RETURN jsonb_build_object('followed', v_followed, 'blocked', v_blocked);
END
$fn$;
REVOKE ALL ON FUNCTION public.page365_inventory_follow_code(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_inventory_follow_code(uuid) TO service_role;
COMMENT ON FUNCTION public.page365_inventory_follow_code(uuid) IS
  '2026-10-29, finish step (a3). A pending item whose (page365_product_id, page365_variant_id) is linked to exactly one Hub product that is not "Don''t sync with Page365" but whose code differs: rename the product (sku, name, name_ja code word; slug only when never published; presence code), so step (b) matches it by the new code. A code another Hub product owns: no write, one bell page365_recode_blocked.';

-- ---------------------------------------------------------------------------
-- 6. NAME follow. p_once = the one-time pass over the latest ready full read:
--    compares the Hub name with Page365's, rings no per-product bell and ends
--    with one summary bell.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_follow_names(p_run_id uuid, p_once boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  r         record;
  v_ln      public.page365_listing_names%ROWTYPE;
  v_cur     text;
  v_changed boolean;
  v_never   boolean;
  v_done    boolean;
  v_keep    boolean;
  v_updated integer := 0;
  v_kept    integer := 0;
BEGIN
  FOR r IN
    SELECT i.id AS item_id, wp.id AS pid, i.page365_product_id AS ppid, i.page365_variant_id AS pvid,
           wp.name AS hub_name, wp.sku, wp.first_published_at
      FROM public.page365_inventory_items i
      JOIN public.website_products wp ON wp.id = i.website_product_id
     WHERE i.run_id = p_run_id AND i.kind = 'page365' AND i.match_result = 'matched' AND i.category <> 'not_synced'
       AND NOT coalesce(wp.page365_sync_disabled, false)
       AND wp.page365_product_id = i.page365_product_id AND wp.page365_variant_id = i.page365_variant_id
     ORDER BY i.id
  LOOP
    v_cur := btrim(coalesce(public.page365_listing_text(r.item_id), ''));
    CONTINUE WHEN v_cur = '';
    -- A different code (blocked re-code, or the listing is the other piece): never rename here.
    CONTINUE WHEN public.page365_first_word(v_cur) IS DISTINCT FROM public.page365_first_word(r.hub_name);

    SELECT * INTO v_ln FROM public.page365_listing_names WHERE website_product_id = r.pid FOR UPDATE;
    IF NOT FOUND THEN
      -- First sight (a product that landed in this very read, or one never seen): remember, compare nothing.
      INSERT INTO public.page365_listing_names (website_product_id, page365_product_id, page365_variant_id, last_p365_name, seen_names)
      VALUES (r.pid, r.ppid, r.pvid, v_cur, ARRAY[v_cur])
      ON CONFLICT (website_product_id) DO NOTHING;
      CONTINUE;
    END IF;

    v_changed := CASE WHEN p_once THEN public.page365_norm_name(v_cur) IS DISTINCT FROM public.page365_norm_name(r.hub_name)
                      ELSE public.page365_norm_name(v_cur) IS DISTINCT FROM public.page365_norm_name(v_ln.last_p365_name) END;
    IF NOT v_changed THEN CONTINUE; END IF;
    -- The one-time pass: a kept (completed) name already counted is not counted again.
    CONTINUE WHEN p_once AND v_ln.bell_name IS NOT DISTINCT FROM v_cur;
    v_keep := false;

    IF public.page365_norm_name(r.hub_name) = public.page365_norm_name(v_cur) THEN
      -- Staff already typed Page365's new text: nothing to change or ring.
      v_done := false; v_never := false;
    ELSE
      v_never := EXISTS (SELECT 1 FROM unnest(v_ln.seen_names) s
                          WHERE public.page365_norm_name(public.page365_swap_code(s, public.page365_first_word(r.hub_name)))
                                = public.page365_norm_name(r.hub_name));
      v_done := false;
      IF v_never THEN
        -- Never completed: the Hub still carries a Page365 name verbatim -> copy the new one.
        BEGIN
          UPDATE public.website_products
             SET name = v_cur, name_ja = NULL,
                 -- never public: the slug follows the name; once public it never moves
                 slug = CASE WHEN r.first_published_at IS NULL
                             THEN public.page365_make_slug(public.page365_first_word(v_cur), v_cur, r.pvid, r.pid) ELSE slug END
           WHERE id = r.pid;
          INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id)
          VALUES ('website_product', r.pid, 'page365_name_followed',
                  jsonb_build_object('name', r.hub_name),
                  jsonb_build_object('name', v_cur, 'run_id', p_run_id, 'once', p_once, 'page365_product_id', r.ppid), NULL);
          v_done := true;
          v_updated := v_updated + 1;
        EXCEPTION WHEN OTHERS THEN
          v_done := false;    -- e.g. the terminology guard refused the text: keep, and ring below
        END;
      END IF;
      IF NOT v_done THEN
        v_keep := true;
        v_kept := v_kept + 1;
        IF NOT p_once AND v_ln.bell_name IS DISTINCT FROM v_cur THEN
          INSERT INTO public.staff_notifications (type, title, body, metadata)
          VALUES ('page365_name_changed', 'Page365 changed a name you completed',
                  r.sku || ': Page365 changed its name from "' || coalesce(v_ln.last_p365_name, '') || '" to "' || v_cur
                    || '". The Hub name was completed by staff and was left as "' || r.hub_name || '".',
                  jsonb_build_object('run_id', p_run_id, 'website_product_id', r.pid, 'code', r.sku,
                                     'page365_old', v_ln.last_p365_name, 'page365_new', v_cur, 'hub_name', r.hub_name));
        END IF;
      END IF;
    END IF;

    UPDATE public.page365_listing_names
       SET last_p365_name = v_cur,
           seen_names = CASE WHEN EXISTS (SELECT 1 FROM unnest(seen_names) s WHERE public.page365_norm_name(s) = public.page365_norm_name(v_cur))
                             THEN seen_names
                             ELSE (seen_names || v_cur)[greatest(1, cardinality(seen_names) + 1 - 29):] END,
           bell_name = CASE WHEN v_keep THEN v_cur ELSE bell_name END,
           ja_pending = ja_pending OR v_done,
           updated_at = now()
     WHERE website_product_id = r.pid;
  END LOOP;

  IF p_once AND (v_updated + v_kept) > 0 THEN
    INSERT INTO public.staff_notifications (type, title, body, metadata)
    VALUES ('page365_names_followed_summary', 'Page365 names compared with the Catalog',
            (v_updated + v_kept) || ' Catalog names differed from Page365: ' || v_updated
              || ' updated to Page365''s text (never completed), ' || v_kept
              || ' kept because staff completed them. From now on a Page365 change rings one bell for a completed name.',
            jsonb_build_object('run_id', p_run_id, 'updated', v_updated, 'kept', v_kept));
  END IF;
  RETURN jsonb_build_object('updated', v_updated, 'kept', v_kept);
END
$fn$;
REVOKE ALL ON FUNCTION public.page365_follow_names(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_follow_names(uuid, boolean) TO service_role;
COMMENT ON FUNCTION public.page365_follow_names(uuid, boolean) IS
  '2026-10-29. Name follow for the matched, linked items of a run. Change = Page365 now vs the Page365 name last seen (page365_listing_names), never vs the Hub name. Hub name still exactly a name seen before -> replaced by the new Page365 name (name_ja cleared, ja_pending); otherwise kept + ONE bell page365_name_changed per Page365 name. p_once: the one-time pass (Hub vs Page365, no per-product bell, one summary bell). Never touches price.';

-- ---------------------------------------------------------------------------
-- 7. Reviews come back to a piece that lands again (by Page365 listing id).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_restore_reviews(p_product_id uuid, p_page365_product_id bigint, p_page365_variant_id bigint)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_n integer;
BEGIN
  INSERT INTO public.product_review_products (review_id, website_product_id)
  SELECT d.review_id, p_product_id FROM public.product_review_detached d
   WHERE d.page365_product_id = p_page365_product_id AND d.page365_variant_id = p_page365_variant_id AND d.was_linked
  ON CONFLICT DO NOTHING;
  UPDATE public.product_reviews r SET website_product_id = p_product_id
   WHERE r.website_product_id IS NULL
     AND r.id IN (SELECT d.review_id FROM public.product_review_detached d
                   WHERE d.page365_product_id = p_page365_product_id AND d.page365_variant_id = p_page365_variant_id AND d.was_primary);
  DELETE FROM public.product_review_detached d
   WHERE d.page365_product_id = p_page365_product_id AND d.page365_variant_id = p_page365_variant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$fn$;
REVOKE ALL ON FUNCTION public.page365_restore_reviews(uuid, bigint, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_restore_reviews(uuid, bigint, bigint) TO service_role;

-- ---------------------------------------------------------------------------
-- 8. Step (h): names + photos + reviews for a READY run.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_inventory_follow_listing(p_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  r          record;
  v_names    jsonb;
  v_base     integer;
  v_removed  integer;
  v_resorted integer;
  v_removed_t integer := 0;
  v_resorted_t integer := 0;
  v_reviews  integer := 0;
  v_n        integer;
  v_errors   text := '';
BEGIN
  IF (SELECT status FROM public.page365_inventory_runs WHERE id = p_run_id) IS DISTINCT FROM 'ready' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'run_not_ready');
  END IF;

  BEGIN
    v_names := public.page365_follow_names(p_run_id, false);
  EXCEPTION WHEN OTHERS THEN
    v_errors := v_errors || 'names: ' || left(SQLERRM, 200) || '; ';
  END;

  -- Photos, in Page365's order. Page365-origin media only; staff photos never
  -- move; an EMPTY photo list (a glitch, or none) deletes nothing.
  FOR r IN
    SELECT i.id AS item_id, i.variant_id, p.photos
      FROM public.page365_inventory_items i
      JOIN public.page365_inventory_products p ON p.id = i.inventory_product_id
      JOIN public.website_products wp ON wp.id = i.website_product_id
     WHERE i.run_id = p_run_id AND i.kind = 'page365' AND i.match_result = 'matched' AND i.category <> 'not_synced'
       AND i.variant_id IS NOT NULL AND NOT coalesce(wp.page365_sync_disabled, false)
       AND wp.page365_product_id = i.page365_product_id AND wp.page365_variant_id = i.page365_variant_id
       AND jsonb_typeof(p.photos) = 'array' AND jsonb_array_length(p.photos) > 0
     ORDER BY i.id
  LOOP
    BEGIN
      DELETE FROM public.website_product_media m
       WHERE m.variant_id = r.variant_id AND m.page365_photo_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r.photos) ph WHERE (ph->>'id')::bigint = m.page365_photo_id);
      GET DIAGNOSTICS v_removed = ROW_COUNT;

      SELECT coalesce(max(m.sort) + 1, 0) INTO v_base FROM public.website_product_media m
       WHERE m.variant_id = r.variant_id AND m.page365_photo_id IS NULL AND m.url NOT LIKE 'https://assets.page365.net/%';
      UPDATE public.website_product_media m
         SET sort = v_base + (t.ord - 1)::integer
        FROM jsonb_array_elements(r.photos) WITH ORDINALITY AS t(ph, ord)
       WHERE m.variant_id = r.variant_id AND m.page365_photo_id = (t.ph->>'id')::bigint
         AND m.sort IS DISTINCT FROM v_base + (t.ord - 1)::integer;
      GET DIAGNOSTICS v_resorted = ROW_COUNT;

      IF v_removed > 0 OR v_resorted > 0 THEN
        INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id)
        VALUES ('website_product_variant', r.variant_id, 'page365_photos_followed',
                jsonb_build_object('run_id', p_run_id, 'item_id', r.item_id, 'removed', v_removed, 'resorted', v_resorted), NULL);
      END IF;
      v_removed_t := v_removed_t + v_removed;
      v_resorted_t := v_resorted_t + v_resorted;
    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors || 'photos ' || r.item_id || ': ' || left(SQLERRM, 120) || '; ';
    END;
  END LOOP;

  -- Reviews of an earlier, deleted copy of a listing that has landed again.
  FOR r IN
    SELECT DISTINCT i.website_product_id AS pid, i.page365_product_id AS ppid, i.page365_variant_id AS pvid
      FROM public.page365_inventory_items i
      JOIN public.website_products wp ON wp.id = i.website_product_id
     WHERE i.run_id = p_run_id AND i.kind = 'page365' AND i.match_result = 'matched'
       AND wp.page365_product_id = i.page365_product_id AND wp.page365_variant_id = i.page365_variant_id
       AND EXISTS (SELECT 1 FROM public.product_review_detached d
                    WHERE d.page365_product_id = i.page365_product_id AND d.page365_variant_id = i.page365_variant_id)
  LOOP
    BEGIN
      v_n := public.page365_restore_reviews(r.pid, r.ppid, r.pvid);
      v_reviews := v_reviews + coalesce(v_n, 0);
    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors || 'reviews ' || r.pid || ': ' || left(SQLERRM, 120) || '; ';
    END;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'names', v_names, 'photos_removed', v_removed_t,
                            'photos_resorted', v_resorted_t, 'reviews_restored', v_reviews,
                            'errors', nullif(v_errors, ''));
END
$fn$;
REVOKE ALL ON FUNCTION public.page365_inventory_follow_listing(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_inventory_follow_listing(uuid) TO service_role;
COMMENT ON FUNCTION public.page365_inventory_follow_listing(uuid) IS
  '2026-10-29, finish step (h), a READY run only: name follow (page365_follow_names), photo follow (Page365-origin media removed / re-sorted to Page365''s order; staff photos untouched; an empty list deletes nothing) and review restore for a piece that landed again. Never price, stock, status. Each part fails alone.';

-- ---------------------------------------------------------------------------
-- 8b. Japanese names for a Hub name that followed Page365 (name_ja was cleared).
--     The edge function page365-inventory-fetch reads and writes through these
--     two RPCs only: it never touches website_products directly.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_pending_ja_names(p_limit integer DEFAULT 5)
RETURNS TABLE (o_product_id uuid, o_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT n.website_product_id, wp.name
    FROM public.page365_listing_names n
    JOIN public.website_products wp ON wp.id = n.website_product_id
   WHERE n.ja_pending AND btrim(coalesce(wp.name, '')) <> ''
   ORDER BY n.updated_at, n.website_product_id
   LIMIT greatest(1, least(coalesce(p_limit, 5), 20))
$fn$;
REVOKE ALL ON FUNCTION public.page365_pending_ja_names(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_pending_ja_names(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.page365_set_name_ja(p_product_id uuid, p_expected_name text, p_name_ja text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_n integer;
BEGIN
  IF btrim(coalesce(p_name_ja, '')) = '' THEN RETURN false; END IF;
  -- Only if the English name has not moved again since it was translated.
  UPDATE public.website_products SET name_ja = btrim(p_name_ja)
   WHERE id = p_product_id AND btrim(name) = btrim(coalesce(p_expected_name, ''));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN RETURN false; END IF;   -- stays pending; the next tick translates the newer name
  UPDATE public.page365_listing_names SET ja_pending = false, updated_at = now() WHERE website_product_id = p_product_id;
  RETURN true;
END
$fn$;
REVOKE ALL ON FUNCTION public.page365_set_name_ja(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_set_name_ja(uuid, text, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 9. The one Catalog delete path.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.delete_website_product_atomic(p_product_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_p        public.website_products%ROWTYPE;
  v_hub_only integer := 0;
  v_claims   integer := 0;
  v_items    integer := 0;
  v_lines    integer := 0;
  v_reviews  integer := 0;
BEGIN
  PERFORM public.assert_staff_caller('manage_website_catalog');

  SELECT * INTO v_p FROM public.website_products WHERE id = p_product_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This product no longer exists.'; END IF;

  -- A live-selling claim that is still running blocks the delete (held / paid / layaway).
  IF EXISTS (SELECT 1 FROM public.website_live_claims c JOIN public.website_product_variants v ON v.id = c.product_variant_id
              WHERE v.product_id = p_product_id AND c.status::text IN ('held', 'paid', 'layaway')) THEN
    RAISE EXCEPTION 'This piece has an active live-selling claim.';
  END IF;
  -- Finished claims (expired / released) hold nothing: clear them so the FK does not block.
  DELETE FROM public.website_live_claims c USING public.website_product_variants v
   WHERE v.id = c.product_variant_id AND v.product_id = p_product_id AND c.status::text IN ('expired', 'released');
  GET DIAGNOSTICS v_claims = ROW_COUNT;

  -- Reviews: remember BOTH links by Page365 listing, so a re-landed piece gets them back.
  IF v_p.page365_product_id IS NOT NULL AND v_p.page365_variant_id IS NOT NULL THEN
    INSERT INTO public.product_review_detached (review_id, page365_product_id, page365_variant_id, was_linked, was_primary)
    SELECT x.review_id, v_p.page365_product_id, v_p.page365_variant_id, bool_or(x.linked), bool_or(x.prim)
      FROM (SELECT l.review_id, true AS linked, false AS prim FROM public.product_review_products l WHERE l.website_product_id = p_product_id
            UNION ALL
            SELECT pr.id, false, true FROM public.product_reviews pr WHERE pr.website_product_id = p_product_id) x
     GROUP BY x.review_id
    ON CONFLICT (review_id, page365_product_id, page365_variant_id) DO UPDATE
      SET was_linked = product_review_detached.was_linked OR EXCLUDED.was_linked,
          was_primary = product_review_detached.was_primary OR EXCLUDED.was_primary,
          detached_at = now();
    GET DIAGNOSTICS v_reviews = ROW_COUNT;
  END IF;

  -- "Not in Page365" rows only record an absence; the CHECK refuses them without a product.
  DELETE FROM public.page365_inventory_items WHERE kind = 'hub_only' AND website_product_id = p_product_id;
  GET DIAGNOSTICS v_hub_only = ROW_COUNT;

  SELECT count(*) INTO v_items FROM public.page365_inventory_items WHERE website_product_id = p_product_id;
  SELECT (SELECT count(*) FROM public.cash_order_items WHERE website_product_id = p_product_id)
       + (SELECT count(*) FROM public.layaway_account_items WHERE website_product_id = p_product_id)
       + (SELECT count(*) FROM public.web_order_draft_lines WHERE website_product_id = p_product_id)
    INTO v_lines;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id)
  VALUES ('website_product', p_product_id, 'website_product_deleted',
          jsonb_build_object('sku', v_p.sku, 'name', v_p.name, 'status', v_p.status::text,
                             'page365_product_id', v_p.page365_product_id, 'page365_variant_id', v_p.page365_variant_id),
          jsonb_build_object('reason', coalesce(nullif(btrim(p_reason), ''), 'Removed from the Catalog'),
                             'hub_only_removed', v_hub_only, 'claims_cleared', v_claims, 'items_unlinked', v_items,
                             'order_lines_unlinked', v_lines, 'reviews_detached', v_reviews),
          (SELECT auth.uid()));

  DELETE FROM public.website_products WHERE id = p_product_id;

  RETURN jsonb_build_object('ok', true, 'sku', v_p.sku, 'hub_only_removed', v_hub_only, 'claims_cleared', v_claims,
                            'items_unlinked', v_items, 'order_lines_unlinked', v_lines, 'reviews_detached', v_reviews);
END
$fn$;
REVOKE ALL ON FUNCTION public.delete_website_product_atomic(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_website_product_atomic(uuid, text) TO authenticated, service_role;
COMMENT ON FUNCTION public.delete_website_product_atomic(uuid, text) IS
  '2026-10-29. The ONE Catalog delete (Products card). Refuses a product with a held / paid / layaway live-selling claim; clears its expired / released claims; snapshots its reviews by Page365 listing; deletes its kind=hub_only item rows (the CHECK refuses them without a product); audits; deletes. Order, draft and cart lines keep their own saved code / name / price (FKs SET NULL / CASCADE as live). If Page365 still lists the piece in stock, the next complete read lands a fresh unpublished draft.';

-- ---------------------------------------------------------------------------
-- 10. page365_inventory_finish — live body (= 20270215100000), edits (a3), (h) only.
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
  -- PR 2
  v_mode     text := CASE WHEN (SELECT s.value #>> '{}' FROM public.system_settings s
                                 WHERE s.key = 'page365_stock_mode') = 'invoice'
                          THEN 'invoice' ELSE 'inventory_sync' END;
  v_hold_unpaid boolean := coalesce((SELECT s.value #>> '{}' FROM public.system_settings s
                                      WHERE s.key = 'page365_hold_unpaid_invoices'), 'true') <> 'false';
  v_off      boolean;
  -- 2026-09-26: new, in-stock codes land in the Catalog (unpublished).
  v_landed   jsonb;
  -- 2026-10-27: a code on 2+ listings is resolved by NAME (step a2).
  v_dup      record;
  v_dup_pid  uuid;
  v_hub_name text;
  v_win_id   uuid;
  v_top      integer;
  v_top_n    integer;
  v_prev_run uuid;
  -- 2026-10-29: step (h), names + photos + reviews follow Page365.
  v_followed jsonb;
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

  -- (a2) 2026-10-27, owner rule: a code on 2+ Page365 listings is told apart by
  --      the NAME. The Hub name was copied from Page365, so the 4 words after
  --      the code identify the piece. Only a code with exactly ONE Hub product
  --      is tried; each listing scores how many of the Hub's 4 words appear in
  --      its own 4 (page365_name_score). The single listing with score >= 3
  --      and no tie goes back to 'pending' and is matched in (b) like any other
  --      row; the others stay flagged. No clear winner: all stay flagged and
  --      ONE staff bell rings — only from a complete read (no read errors)
  --      and only when the previous ready read did not already have this code
  --      unresolved (never every interval).
  SELECT r.id INTO v_prev_run FROM public.page365_inventory_runs r
   WHERE r.id <> p_run_id AND r.status = 'ready' AND r.created_at < v_run.created_at
   ORDER BY r.created_at DESC LIMIT 1;
  FOR v_dup IN
    SELECT i.code FROM public.page365_inventory_items i
     WHERE i.run_id = p_run_id AND i.kind = 'page365' AND i.match_result = 'duplicate_in_page365'
     GROUP BY i.code ORDER BY i.code
  LOOP
    SELECT m.o_product_id INTO v_dup_pid FROM public.page365_match_line(v_dup.code) m;
    CONTINUE WHEN v_dup_pid IS NULL;
    SELECT wp.name INTO v_hub_name FROM public.website_products wp WHERE wp.id = v_dup_pid;

    WITH s AS (
      SELECT i.id, public.page365_name_score(v_hub_name, public.page365_listing_text(i.id), v_dup.code) AS score
        FROM public.page365_inventory_items i
       WHERE i.run_id = p_run_id AND i.kind = 'page365'
         AND i.match_result = 'duplicate_in_page365' AND i.code = v_dup.code
    )
    SELECT (array_agg(s.id ORDER BY s.score DESC, s.id))[1], max(s.score),
           count(*) FILTER (WHERE s.score = (SELECT max(x.score) FROM s x))
      INTO v_win_id, v_top, v_top_n
      FROM s;

    IF v_top >= 3 AND v_top_n = 1 THEN
      UPDATE public.page365_inventory_items
         SET match_result = 'pending', category = 'pending', result_note = 'matched_by_name'
       WHERE id = v_win_id;
      UPDATE public.page365_inventory_items
         SET result_note = 'duplicate_other_piece'
       WHERE run_id = p_run_id AND kind = 'page365' AND match_result = 'duplicate_in_page365'
         AND code = v_dup.code;
    ELSE
      UPDATE public.page365_inventory_items
         SET result_note = 'duplicate_unresolved'
       WHERE run_id = p_run_id AND kind = 'page365' AND match_result = 'duplicate_in_page365'
         AND code = v_dup.code;
      IF v_errors = 0 AND NOT EXISTS (SELECT 1 FROM public.page365_inventory_items pi
                      WHERE pi.run_id = v_prev_run AND pi.kind = 'page365' AND pi.code = v_dup.code
                        AND pi.result_note = 'duplicate_unresolved') THEN
        INSERT INTO public.staff_notifications (type, title, body, metadata)
        VALUES ('page365_duplicate_code', 'Page365: same code on two listings',
                v_dup.code || ' is on more than one Page365 listing and the Hub could not tell by the name which one is '
                  || 'its piece (' || coalesce(v_hub_name, v_dup.code) || '). Stock for ' || v_dup.code
                  || ' is not following Page365 until one listing gets its own code or the Hub name is corrected.',
                jsonb_build_object('run_id', p_run_id, 'code', v_dup.code, 'website_product_id', v_dup_pid,
                                   'listings', (SELECT jsonb_agg(jsonb_build_object(
                                                  'page365_product_id', i.page365_product_id,
                                                  'name', i.page365_name, 'available', i.page365_available)
                                                  ORDER BY i.page365_product_id)
                                                  FROM public.page365_inventory_items i
                                                 WHERE i.run_id = p_run_id AND i.kind = 'page365'
                                                   AND i.code = v_dup.code)));
      END IF;
    END IF;
  END LOOP;

  -- (a3) 2026-10-29: a listing already linked to ONE Hub product whose CODE
  --      changed on Page365 renames that product first (sku, name, name_ja,
  --      slug if never public), so (b) finds it by the new code. Only from a
  --      complete read (no read errors, catalogue not shrunk > 20 %); a
  --      failure here never fails the read.
  IF v_errors = 0 AND NOT (v_prev_run IS NOT NULL AND v_run.page365_count
        < (SELECT pr.page365_count FROM public.page365_inventory_runs pr WHERE pr.id = v_prev_run) * 0.8) THEN
    BEGIN
      PERFORM public.page365_inventory_follow_code(p_run_id);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  -- (b) Match the rest on the code, exactly (#195's matcher, unchanged). A
  --     product switched to "Don't sync with Page365" is not_synced (PR 2).
  FOR v_it IN
    SELECT i.id, i.code, i.page365_available, i.page365_price_jpy, i.inventory_product_id
      FROM public.page365_inventory_items i
     WHERE i.run_id = p_run_id AND i.kind = 'page365' AND i.match_result = 'pending'
     ORDER BY i.id
  LOOP
    SELECT * INTO v_m FROM public.page365_match_line(v_it.code);
    v_off := coalesce((SELECT wp.page365_sync_disabled FROM public.website_products wp
                        WHERE wp.id = v_m.o_product_id), false);
    IF v_m.o_match_result = 'matched' THEN
      UPDATE public.page365_inventory_items i
         SET match_result = 'matched', website_product_id = v_m.o_product_id, variant_id = v_m.o_variant_id,
             hub_sku = (SELECT sku FROM public.website_products WHERE id = v_m.o_product_id),
             hub_price_jpy = (SELECT price_jpy FROM public.website_product_variants WHERE id = v_m.o_variant_id),
             seen_stock = v_m.o_stock_qty,
             web_holds = public.page365_web_holds(v_m.o_variant_id),
             invoice_holds = CASE WHEN v_mode = 'invoice'
                                  THEN (SELECT count(*) FROM public.page365_stock_lines l
                                         WHERE l.variant_id = v_m.o_variant_id AND l.stock_state = 'held')
                                  ELSE public.page365_invoice_holds(v_m.o_variant_id) END,
             category = CASE WHEN v_off THEN 'not_synced' ELSE i.category END
       WHERE i.id = v_it.id;
    ELSE
      UPDATE public.page365_inventory_items i
         SET match_result = v_m.o_match_result, website_product_id = v_m.o_product_id,
             category = CASE WHEN v_off THEN 'not_synced'
                             WHEN v_m.o_match_result = 'unmatched' THEN 'new' ELSE 'flagged' END
       WHERE i.id = v_it.id;
    END IF;
  END LOOP;

  -- (c) The proposal: max(0, Page365 available - website holds [- unpaid
  --     invoice holds, PR 2]), and its direction. not_synced is never proposed.
  UPDATE public.page365_inventory_items i
     SET proposed_stock = greatest(0, i.page365_available - coalesce(i.web_holds, 0)
                                      - CASE WHEN v_mode = 'inventory_sync' AND v_hold_unpaid
                                             THEN coalesce(i.invoice_holds, 0) ELSE 0 END),
         price_differs = i.page365_price_jpy IS DISTINCT FROM i.hub_price_jpy
   WHERE i.run_id = p_run_id AND i.match_result = 'matched' AND i.category <> 'not_synced';
  UPDATE public.page365_inventory_items i
     SET category = CASE
           WHEN v_mode = 'invoice' AND i.invoice_holds > 0 THEN 'excluded'
           WHEN i.proposed_stock < i.seen_stock    THEN 'decrease'
           WHEN i.proposed_stock > i.seen_stock    THEN 'increase'
           ELSE 'no_change' END
   WHERE i.run_id = p_run_id AND i.match_result = 'matched' AND i.category <> 'not_synced';

  -- (d) Photos per matched variant: Page365 total, not yet copied (by id AND
  --     version), and copies whose Page365 photo is gone (flagged, not deleted).
  --     not_synced: never copied, so nothing to count.
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
   WHERE p.id = i.inventory_product_id AND i.run_id = p_run_id AND i.match_result = 'matched'
     AND i.category <> 'not_synced';

  -- (e) Hub-only: only a COMPLETE read can say a code is absent. Archived
  --     products are out of scope; a code with an inner space never matched.
  --     A switched-off product is listed as not_synced, never as missing.
  --     PR 3c: a QUICK read never opens a switched-off product's page, so it
  --     cannot say that product is missing — it is left out altogether.
  IF v_errors = 0 THEN
    SELECT * INTO v_prev FROM public.page365_inventory_runs r
     WHERE r.id <> p_run_id AND r.status = 'ready' AND r.created_at < v_run.created_at
     ORDER BY r.created_at DESC LIMIT 1;
    INSERT INTO public.page365_inventory_items (run_id, kind, website_product_id, hub_sku, match_result, category, missing_runs)
    SELECT p_run_id, 'hub_only', wp.id, wp.sku, 'hub_only',
           CASE WHEN wp.page365_sync_disabled THEN 'not_synced' ELSE 'hub_only' END,
           1 + coalesce((SELECT pi.missing_runs FROM public.page365_inventory_items pi
                          WHERE pi.run_id = v_prev.id AND pi.kind = 'hub_only' AND pi.website_product_id = wp.id), 0)
      FROM public.website_products wp
     WHERE wp.status <> 'archived'
       AND NOT (v_run.kind = 'quick' AND coalesce(wp.page365_sync_disabled, false))
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
  -- (g) 2026-09-26, replaces Create drafts: a COMPLETE read lands every new,
  --     in-stock code as an UNPUBLISHED Catalog product. A landing failure
  --     never fails the read: the run stays ready and the reason is returned.
  IF v_status = 'ready' THEN
    BEGIN
      v_landed := public.page365_inventory_land_run(p_run_id);
    EXCEPTION WHEN OTHERS THEN
      v_landed := jsonb_build_object('ok', false, 'error', left(SQLERRM, 300));
    END;
    -- (h) 2026-10-29: names, photo order and restored reviews follow Page365
    --     (never price, stock or status). A failure never fails the read.
    BEGIN
      v_followed := public.page365_inventory_follow_listing(p_run_id);
    EXCEPTION WHEN OTHERS THEN
      v_followed := jsonb_build_object('ok', false, 'error', left(SQLERRM, 300));
    END;
  END IF;
  RETURN jsonb_build_object('ok', true, 'status', v_status, 'reason', v_reason, 'mode', v_mode, 'kind', v_run.kind,
                            'landed', v_landed, 'followed', v_followed);
END
$fn$;
REVOKE ALL ON FUNCTION public.page365_inventory_finish(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_inventory_finish(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 11. Link backfill: three products Page365 reads every time by code but that
--     were never linked to their listing. REFUSES unless the candidates are
--     exactly N1616, R7828, R3341 (never 8C100 — not in Page365; never N4020 —
--     a website sample, owner: never synced). The dry-run list is
--     docs/sql/20270220_page365_follow_dry_run.sql.
-- ---------------------------------------------------------------------------
DO $backfill$
DECLARE
  v_expected text[] := string_to_array(coalesce(nullif(current_setting('page365.backfill_expected', true), ''), 'N1616,R7828,R3341'), ',');
  v_run      uuid;
  v_cand     text[];
  v_linked   text[];
  v_n        integer;
BEGIN
  SELECT r.id INTO v_run FROM public.page365_inventory_runs r
   WHERE r.kind = 'full' AND r.status = 'ready' ORDER BY r.created_at DESC LIMIT 1;
  IF v_run IS NULL THEN
    -- A database that never read Page365 (a rebuild from the repo): nothing to link.
    RAISE NOTICE 'page365 link backfill: no complete full read yet — skipped';
    RETURN;
  END IF;

  CREATE TEMP TABLE _p365_link_cand ON COMMIT DROP AS
  SELECT wp.id AS pid, wp.sku, (array_agg(i.page365_product_id))[1] AS ppid, (array_agg(i.page365_variant_id))[1] AS pvid
    FROM public.website_products wp
    JOIN public.page365_inventory_items i
      ON i.run_id = v_run AND i.kind = 'page365' AND i.code = public.page365_first_word(wp.sku)
   WHERE wp.page365_product_id IS NULL AND NOT coalesce(wp.page365_sync_disabled, false)
     AND wp.status::text <> 'archived' AND public.page365_first_word(wp.sku) IS NOT NULL
     AND wp.sku !~ ('[^\s' || chr(12288) || '' || chr(160) || '][\s' || chr(12288) || '' || chr(160) || ']+[^\s' || chr(12288) || '' || chr(160) || ']')
     -- the code is on exactly ONE listing variant in that read, and nobody is linked to it
     AND (SELECT count(*) FROM public.page365_inventory_items j WHERE j.run_id = v_run AND j.kind = 'page365' AND j.code = i.code) = 1
     AND NOT EXISTS (SELECT 1 FROM public.website_products o
                      WHERE o.page365_product_id = i.page365_product_id AND o.page365_variant_id = i.page365_variant_id)
     AND (SELECT count(*) FROM public.website_products w2 WHERE public.page365_first_word(w2.sku) = public.page365_first_word(wp.sku)) = 1
   GROUP BY wp.id, wp.sku;

  SELECT coalesce(array_agg(c.sku ORDER BY c.sku), ARRAY[]::text[]) INTO v_cand FROM _p365_link_cand c;
  IF EXISTS (SELECT 1 FROM unnest(v_cand) s WHERE NOT (s = ANY (v_expected))) THEN
    RAISE EXCEPTION 'page365 link backfill: candidates % are not within the approved list % — nothing changed. Re-run docs/sql/20270220_page365_follow_dry_run.sql.', v_cand, v_expected;
  END IF;

  UPDATE public.website_products wp SET page365_product_id = c.ppid, page365_variant_id = c.pvid
    FROM _p365_link_cand c WHERE c.pid = wp.id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id)
  SELECT 'website_product', c.pid, 'page365_link_backfilled',
         jsonb_build_object('sku', c.sku, 'page365_product_id', c.ppid, 'page365_variant_id', c.pvid, 'run_id', v_run), NULL
    FROM _p365_link_cand c;

  SELECT coalesce(array_agg(wp.sku ORDER BY wp.sku), ARRAY[]::text[]) INTO v_linked
    FROM public.website_products wp WHERE wp.sku = ANY (v_expected) AND wp.page365_product_id IS NOT NULL;
  IF v_linked IS DISTINCT FROM (SELECT array_agg(s ORDER BY s) FROM unnest(v_expected) s) THEN
    RAISE EXCEPTION 'page365 link backfill: after linking, % are linked but the approved list is % — nothing changed.', v_linked, v_expected;
  END IF;
  RAISE NOTICE 'page365 link backfill: linked % product(s): %', v_n, v_cand;
END
$backfill$;

-- ---------------------------------------------------------------------------
-- 12. Seed page365_listing_names from the FULL item history (since 2026-09-25).
--     Text = what landing copies into a Hub name (page365_listing_text's rule).
-- ---------------------------------------------------------------------------
INSERT INTO public.page365_listing_names (website_product_id, page365_product_id, page365_variant_id, last_p365_name, seen_names)
SELECT h.pid, h.ppid, h.pvid,
       (array_agg(h.txt ORDER BY h.last_at DESC))[1],
       (SELECT coalesce((array_agg(x.txt ORDER BY x.first_at))[greatest(1, count(*)::integer - 29):], ARRAY[]::text[])
          FROM (SELECT g.txt, min(g.created_at) AS first_at FROM (
                  SELECT s.txt, s.created_at FROM (
                    SELECT i2.created_at,
                           btrim(CASE WHEN count(*) OVER (PARTITION BY i2.inventory_product_id) > 1
                                           AND btrim(coalesce(i2.variant_name, '')) ~ '\S\s+\S'
                                      THEN i2.variant_name ELSE coalesce(i2.page365_name, p2.name, p2.list_name) END) AS txt
                      FROM public.page365_inventory_items i2
                      LEFT JOIN public.page365_inventory_products p2 ON p2.id = i2.inventory_product_id
                     WHERE i2.kind = 'page365' AND i2.page365_product_id = h.ppid AND i2.page365_variant_id = h.pvid
                  ) s WHERE coalesce(s.txt, '') <> '') g GROUP BY g.txt) x)
  FROM (
    SELECT wp.id AS pid, wp.page365_product_id AS ppid, wp.page365_variant_id AS pvid, t.txt, t.last_at
      FROM public.website_products wp
      JOIN LATERAL (
        SELECT s.txt, max(s.created_at) AS last_at FROM (
          SELECT i.created_at,
                 btrim(CASE WHEN count(*) OVER (PARTITION BY i.inventory_product_id) > 1
                                 AND btrim(coalesce(i.variant_name, '')) ~ '\S\s+\S'
                            THEN i.variant_name ELSE coalesce(i.page365_name, p.name, p.list_name) END) AS txt
            FROM public.page365_inventory_items i
            LEFT JOIN public.page365_inventory_products p ON p.id = i.inventory_product_id
           WHERE i.kind = 'page365' AND i.page365_product_id = wp.page365_product_id AND i.page365_variant_id = wp.page365_variant_id
        ) s WHERE coalesce(s.txt, '') <> '' GROUP BY s.txt
      ) t ON true
     WHERE wp.page365_product_id IS NOT NULL AND NOT coalesce(wp.page365_sync_disabled, false)
  ) h
 GROUP BY h.pid, h.ppid, h.pvid
ON CONFLICT (website_product_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 13. The one-time name pass over the latest ready FULL read (no per-product
--     bell; one summary bell). Idempotent: a second run finds no difference.
-- ---------------------------------------------------------------------------
DO $once$
DECLARE v_run uuid; v_res jsonb;
BEGIN
  SELECT r.id INTO v_run FROM public.page365_inventory_runs r
   WHERE r.kind = 'full' AND r.status = 'ready' ORDER BY r.created_at DESC LIMIT 1;
  IF v_run IS NOT NULL THEN
    v_res := public.page365_follow_names(v_run, true);
    RAISE NOTICE 'page365 one-time name pass: %', v_res;
  END IF;
END
$once$;

-- ---------------------------------------------------------------------------
-- 14. Self-check. RAISE = the whole file is refused.
-- ---------------------------------------------------------------------------
DO $check$
DECLARE
  v_after text;
  v_got   text;
  r       record;
BEGIN
  v_after :=
    (SELECT count(*)::text FROM public.website_products) || '|'
    || (SELECT md5(coalesce(string_agg(wp.id::text || ':' || wp.status::text, ',' ORDER BY wp.id), '')) FROM public.website_products wp)
    || (SELECT md5(coalesce(string_agg(v.id::text || ':' || v.stock_qty || ':' || coalesce(v.price_jpy, -1), ',' ORDER BY v.id), '')) FROM public.website_product_variants v)
    || (SELECT md5(coalesce(string_agg(s.key || '=' || s.value::text, ',' ORDER BY s.key), '')) FROM public.system_settings s
         WHERE s.key LIKE 'page365%');
  IF v_after IS DISTINCT FROM current_setting('page365.follow_before', true) THEN
    RAISE EXCEPTION 'page365_follow_and_catalog_delete self-check: a product count, status, stock, price or setting moved';
  END IF;

  FOR r IN SELECT * FROM (VALUES
      ('page365_inventory_finish(uuid)',         '5c5704eb68e50cf4cf2a94d95f78efcf'),
      ('page365_inventory_land_run(uuid)',       '7f27675ecd45453b1577fa5f6e6ba738'),
      ('page365_match_line(text)',               '4bec82da4f6af03df8f0827d78f42001'),
      ('page365_first_word(text)',               '7265832b2db007bd380452531c4a1c9b'),
      ('page365_inventory_auto_apply_run(uuid)', 'd9d251fb68aac0acf9a5360b22fddc07'),
      ('page365_inventory_follow(uuid)',         '6e26568441fc308c42426de238fb165f'),
      ('page365_inventory_hide_item(uuid,uuid,uuid,text)', '3a0a932b88cdd1534a9c0285f8ea392b'),
      ('page365_inventory_apply(uuid,uuid[],uuid[])',      'e65757c2f32b597b2a55047d77783df3'),
      ('page365_inventory_record_photo(uuid,bigint,text,text,text,integer,uuid)', 'c8f94536cf40167fe43a24967a6eefe9'),
      ('page365_inventory_store_product(uuid,jsonb,text)', '6ae646ee897b92ca7aa5002f8c416743')
    ) AS t(fn, want)
  LOOP
    SELECT md5(p.prosrc) INTO v_got FROM pg_proc p WHERE p.oid = to_regprocedure('public.' || r.fn);
    IF v_got IS DISTINCT FROM r.want THEN
      RAISE EXCEPTION 'page365_follow_and_catalog_delete self-check: % has md5 % (expected %)', r.fn, v_got, r.want;
    END IF;
  END LOOP;

  IF to_regclass('public.idx_page365_inventory_items_product') IS NULL THEN
    RAISE EXCEPTION 'self-check: idx_page365_inventory_items_product missing';
  END IF;
  IF public.page365_swap_code('N1073 Necklace  Tiffany', 'N9140') IS DISTINCT FROM 'N9140 Necklace  Tiffany'
     OR public.page365_norm_name(' A' || chr(12288) || 'b' || chr(160) || ' C ') IS DISTINCT FROM 'a b c' THEN
    RAISE EXCEPTION 'self-check: helper functions misbehave';
  END IF;
  IF has_function_privilege('anon', 'public.delete_website_product_atomic(uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.page365_inventory_follow_listing(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.page365_inventory_follow_code(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.page365_follow_names(uuid,boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'self-check: a new function is callable by anon / authenticated';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.delete_website_product_atomic(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'self-check: authenticated cannot call delete_website_product_atomic';
  END IF;
END
$check$;

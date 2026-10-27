-- ===========================================================================
-- page365_duplicate_code_by_name — a code on 2+ Page365 listings is told apart
-- by the NAME (owner rule 2026-10-27).
--
-- Owner evidence (27 Oct 2026): N5245 was 0 in Page365 from 23 Oct 00:32 JST
-- but stayed 1 in the Hub and on the website. Page365 lists TWO pieces coded
-- N5245 — 82590102 "N5245 Necklace PT850/950 5.20g Diamond 0.563, 0.85ct
-- Square Halo 45cm [Preloved]" (the Hub's piece) and 80537105 "N5245
-- Necklace K18g 5.28g Diamond 0.32ct Ruby 0.51ct Venetian 45cm [Preloved]".
-- page365_inventory_finish step (a) flagged every row of a code seen twice
-- 'duplicate_in_page365' and skipped it: never matched, never proposed, never
-- auto-applied, never hidden (the code IS in the read, so not Hub-only) and no
-- bell — silent. Same for N1045 (PT850/900 Triple Loop vs K18 Tahiti pearl)
-- until the pearl listing was renamed in Page365 at 17:37 JST 27 Oct.
--
-- OWNER RULE: "if two or three listings start with the same SKU or code, the
-- system should counter check the next 2 to 4 words of the description … the
-- Hub is just reading and copying what is listed in Page365".
--
-- WHAT THIS FILE DOES
--   1. page365_name_words(name, code): the name upper-cased, split on
--      whitespace (incl. U+3000 / NBSP), the code word removed, first 4 words.
--   2. page365_name_score(hub_name, listing_name, code): how many of the Hub
--      name's 4 words appear in the listing's 4 words (order ignored).
--      Order-free and >= 3 of 4 tolerates one staff edit to the Hub name:
--      on the live catalogue (full read 27 Oct) 443 of 450 matched products
--      have the same 4 words; the 7 others had a word edited in the Hub.
--   3. page365_listing_text(item): the listing text the Hub name was copied
--      from — exactly page365_inventory_land_run's naming (the variant name
--      for a multi-variant listing when it has 2+ words, else the product
--      name), so the comparison reads what landing wrote.
--   4. page365_inventory_finish, new step (a2) after (a): for each code
--      flagged duplicate that has exactly ONE Hub product (page365_match_line
--      gives a product), every listing row is scored against that product's
--      name. The single row with score >= 3 and no tie goes back to
--      'pending' (result_note 'matched_by_name') and is matched in (b) like
--      any other row — proposal, auto-apply, photos, hide-follow unchanged;
--      the others stay flagged (result_note 'duplicate_other_piece'). No
--      clear winner: all stay flagged ('duplicate_unresolved') and ONE
--      staff bell 'page365_duplicate_code' rings — only from a complete read
--      (no read errors) and only when the previous READY read did not
--      already have that code unresolved, so it never rings every interval. A duplicate code with no Hub product (N1245)
--      stays flagged with no note and no bell. Every other line of finish is
--      the live body, byte for byte.
--   Changes no stock, no product, no setting (the self-check proves it); the
--   next read applies the rule. Re-running it is a no-op.
--
-- FUNCTION CHANGES START FROM LIVE (CLAUDE.md, Bug #280). md5(pg_proc.prosrc):
--   replaced   page365_inventory_finish   e44762490fc64019a4cadfd9496fcbc6 -> a697a6d379ec69f3cac25cd8241cef2f
--   new        page365_name_words                                         -> 705121c5e64a3d0673aca885a65f14bd
--              page365_name_score                                         -> e441174cdbed966f9611a6c9f57aaf48
--              page365_listing_text                                       -> 7608a3ccc02ec141038ea88dd6b25a67
--   relied on, proved unchanged after:
--              page365_match_line                4bec82da4f6af03df8f0827d78f42001
--              page365_first_word                7265832b2db007bd380452531c4a1c9b
--              page365_inventory_auto_apply_run  d9d251fb68aac0acf9a5360b22fddc07
--              page365_inventory_follow          6e26568441fc308c42426de238fb165f
--              page365_inventory_land_run        7f27675ecd45453b1577fa5f6e6ba738
--   "before" bodies verified on live 27 Oct 2026 (query_database) and equal
--   to the repo text of 20261005100000 / 20260926120000.
-- ===========================================================================
BEGIN;

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
     OR to_regclass('public.website_products') IS NULL OR to_regclass('public.staff_notifications') IS NULL THEN
    RAISE EXCEPTION 'page365_duplicate_code_by_name: Page365 inventory / website / staff_notifications tables missing';
  END IF;

  FOR r IN
    SELECT * FROM (VALUES
      -- fn, live before, after this file (NULL = must be exactly "before")
      ('page365_inventory_finish(uuid)',         'e44762490fc64019a4cadfd9496fcbc6', 'a697a6d379ec69f3cac25cd8241cef2f'),
      ('page365_match_line(text)',               '4bec82da4f6af03df8f0827d78f42001', NULL),
      ('page365_first_word(text)',               '7265832b2db007bd380452531c4a1c9b', NULL),
      ('page365_inventory_auto_apply_run(uuid)', 'd9d251fb68aac0acf9a5360b22fddc07', NULL),
      ('page365_inventory_follow(uuid)',         '6e26568441fc308c42426de238fb165f', NULL),
      ('page365_inventory_land_run(uuid)',       '7f27675ecd45453b1577fa5f6e6ba738', NULL)
    ) AS t(fn, want, or_new)
  LOOP
    SELECT md5(p.prosrc) INTO v_got FROM pg_proc p WHERE p.oid = to_regprocedure('public.' || r.fn);
    IF v_got IS DISTINCT FROM r.want AND v_got IS DISTINCT FROM r.or_new THEN
      v_bad := v_bad || format(E'\n  %s: live body md5 %s, expected %s', r.fn, coalesce(v_got, 'missing'), r.want);
    END IF;
  END LOOP;
  -- New here: absent, or already this file's body (a re-run).
  FOR r IN
    SELECT * FROM (VALUES
      ('page365_name_words(text,text)',      '705121c5e64a3d0673aca885a65f14bd'),
      ('page365_name_score(text,text,text)', 'e441174cdbed966f9611a6c9f57aaf48'),
      ('page365_listing_text(uuid)',         '7608a3ccc02ec141038ea88dd6b25a67')
    ) AS t(fn, want)
  LOOP
    SELECT md5(p.prosrc) INTO v_got FROM pg_proc p WHERE p.oid = to_regprocedure('public.' || r.fn);
    IF v_got IS NOT NULL AND v_got <> r.want THEN
      v_bad := v_bad || format(E'\n  %s: a different body already exists (md5 %s)', r.fn, v_got);
    END IF;
  END LOOP;
  IF v_bad <> '' THEN
    RAISE EXCEPTION 'page365_duplicate_code_by_name: live is not what this was written against — nothing changed:%', v_bad;
  END IF;

  -- For the self-check: no product, status, stock or setting moved.
  PERFORM set_config('page365.dupname_before',
    (SELECT count(*)::text FROM public.website_products) || '|'
    || (SELECT md5(coalesce(string_agg(wp.id::text || ':' || wp.status::text || ':' || wp.name, ',' ORDER BY wp.id), '')) FROM public.website_products wp)
    || (SELECT md5(coalesce(string_agg(v.id::text || ':' || v.stock_qty, ',' ORDER BY v.id), '')) FROM public.website_product_variants v)
    || (SELECT md5(coalesce(string_agg(s.key || '=' || s.value::text, ',' ORDER BY s.key), '')) FROM public.system_settings s
         WHERE s.key LIKE 'page365%'),
    true);
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. page365_name_words — the name after the code, first 4 words.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_name_words(p_name text, p_code text)
RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path TO 'public'
AS $fn$
  SELECT coalesce((array_agg(u.w ORDER BY u.ord))[1:4], ARRAY[]::text[])
    FROM unnest(regexp_split_to_array(upper(coalesce(p_name, '')), '[\s\u3000\u00a0]+')) WITH ORDINALITY AS u(w, ord)
   WHERE u.w <> '' AND u.w IS DISTINCT FROM upper(btrim(coalesce(p_code, '')))
$fn$;
REVOKE ALL ON FUNCTION public.page365_name_words(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_name_words(text, text) TO service_role;
COMMENT ON FUNCTION public.page365_name_words(text, text) IS
  '2026-10-27. The first 4 words of a Page365 / Hub name with the code word removed, upper-cased, split on whitespace (incl. U+3000, NBSP). Used only to tell apart listings that share one code (page365_name_score). TS twin: nameWords in _shared/page365-inventory.ts.';

-- ---------------------------------------------------------------------------
-- 2. page365_name_score — how many of the Hub's 4 words the listing has.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_name_score(p_hub_name text, p_listing_name text, p_code text)
RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path TO 'public'
AS $fn$
  SELECT count(DISTINCT h.w)::integer
    FROM unnest(public.page365_name_words(p_hub_name, p_code)) AS h(w)
   WHERE h.w = ANY (public.page365_name_words(p_listing_name, p_code))
$fn$;
REVOKE ALL ON FUNCTION public.page365_name_score(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_name_score(text, text, text) TO service_role;
COMMENT ON FUNCTION public.page365_name_score(text, text, text) IS
  '2026-10-27, owner rule. 0-4: how many of the Hub name''s 4 words after the code appear in the listing''s 4 words (order ignored). page365_inventory_finish (a2) follows a duplicated code''s listing only when it alone scores >= 3. TS twin: nameScore in _shared/page365-inventory.ts.';

-- ---------------------------------------------------------------------------
-- 3. page365_listing_text — the text landing copies into the Hub name.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_listing_text(p_item_id uuid)
RETURNS text
LANGUAGE sql STABLE SET search_path TO 'public'
AS $fn$
  SELECT btrim(CASE WHEN (SELECT count(*) FROM public.page365_inventory_items j
                           WHERE j.inventory_product_id = i.inventory_product_id) > 1
                         AND btrim(coalesce(i.variant_name, '')) ~ '\S\s+\S'
                    THEN i.variant_name
                    ELSE coalesce(i.page365_name, p.name, p.list_name) END)
    FROM public.page365_inventory_items i
    LEFT JOIN public.page365_inventory_products p ON p.id = i.inventory_product_id
   WHERE i.id = p_item_id
$fn$;
REVOKE ALL ON FUNCTION public.page365_listing_text(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_listing_text(uuid) TO service_role;
COMMENT ON FUNCTION public.page365_listing_text(uuid) IS
  '2026-10-27. The listing text a Hub product name is copied from — the same choice page365_inventory_land_run makes (variant name of a multi-variant listing when it has 2+ words, else the product name).';

-- ---------------------------------------------------------------------------
-- 4. page365_inventory_finish — live body; new step (a2) only.
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
  END IF;
  RETURN jsonb_build_object('ok', true, 'status', v_status, 'reason', v_reason, 'mode', v_mode, 'kind', v_run.kind,
                            'landed', v_landed);
END
$fn$;
REVOKE ALL ON FUNCTION public.page365_inventory_finish(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_inventory_finish(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 5. Self-check. Raises (and the whole file rolls back) on any mismatch.
-- ---------------------------------------------------------------------------
DO $chk$
DECLARE
  v_got text;
  r     record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('page365_inventory_finish(uuid)',         'a697a6d379ec69f3cac25cd8241cef2f'),
      ('page365_name_words(text,text)',          '705121c5e64a3d0673aca885a65f14bd'),
      ('page365_name_score(text,text,text)',     'e441174cdbed966f9611a6c9f57aaf48'),
      ('page365_listing_text(uuid)',             '7608a3ccc02ec141038ea88dd6b25a67'),
      ('page365_match_line(text)',               '4bec82da4f6af03df8f0827d78f42001'),
      ('page365_first_word(text)',               '7265832b2db007bd380452531c4a1c9b'),
      ('page365_inventory_auto_apply_run(uuid)', 'd9d251fb68aac0acf9a5360b22fddc07'),
      ('page365_inventory_follow(uuid)',         '6e26568441fc308c42426de238fb165f'),
      ('page365_inventory_land_run(uuid)',       '7f27675ecd45453b1577fa5f6e6ba738')
    ) AS t(fn, want)
  LOOP
    SELECT md5(p.prosrc) INTO v_got FROM pg_proc p WHERE p.oid = to_regprocedure('public.' || r.fn);
    IF v_got IS DISTINCT FROM r.want THEN
      RAISE EXCEPTION 'page365_duplicate_code_by_name self-check: % body md5 %, expected %', r.fn, v_got, r.want;
    END IF;
  END LOOP;

  -- The owner's own pieces (live names, 27 Oct 2026).
  IF public.page365_name_score('N5245 Necklace PT850/950 5.20g Diamond 0.563, 0.85ct Square Halo 45cm [Preloved]',
                               'N5245 Necklace PT850/950 5.20g Diamond 0.563, 0.85ct Square Halo 45cm [Preloved]', 'N5245') <> 4
     OR public.page365_name_score('N5245 Necklace PT850/950 5.20g Diamond 0.563, 0.85ct Square Halo 45cm [Preloved]',
                                  'N5245 Necklace K18g 5.28g Diamond 0.32ct Ruby 0.51ct Venetian 45cm [Preloved]', 'N5245') <> 2
     OR public.page365_name_score('N1045 Necklace PT850/900 10.80g Diamond 0.54ct Triple Loop 45cm [Preloved]',
                                  'N1045 Necklace K18 2.15g Black SSP Tahiti 10mm Pearl 45cm Pinslide', 'N1045') <> 1
     OR public.page365_name_score('R1111 Ring PT900 10.0g Sapphire 2.44ct Diamond 0.79ct  Halo Cocktail Sz# 11 [Preloved]',
                                  'R1111 Ring PT900 10.0g Sapp 2.44ct Dia 0.79ct  Halo Cocktail Sz# 11 [Preloved]', 'R1111') <> 3 THEN
    RAISE EXCEPTION 'page365_duplicate_code_by_name self-check: name score of the owner''s examples is wrong';
  END IF;

  IF current_setting('page365.dupname_before', true) IS DISTINCT FROM
     (SELECT count(*)::text FROM public.website_products) || '|'
     || (SELECT md5(coalesce(string_agg(wp.id::text || ':' || wp.status::text || ':' || wp.name, ',' ORDER BY wp.id), '')) FROM public.website_products wp)
     || (SELECT md5(coalesce(string_agg(v.id::text || ':' || v.stock_qty, ',' ORDER BY v.id), '')) FROM public.website_product_variants v)
     || (SELECT md5(coalesce(string_agg(s.key || '=' || s.value::text, ',' ORDER BY s.key), '')) FROM public.system_settings s
          WHERE s.key LIKE 'page365%') THEN
    RAISE EXCEPTION 'page365_duplicate_code_by_name self-check: a product, stock or Page365 setting changed — this file must change none';
  END IF;
END
$chk$;

COMMIT;

-- ---------------------------------------------------------------------------
-- VERIFICATION (read-only; run after applying):
-- (1) bodies:
--   SELECT proname, md5(prosrc) FROM pg_proc
--    WHERE proname IN ('page365_inventory_finish','page365_name_words','page365_name_score','page365_listing_text')
--    ORDER BY 1;
--   -- finish a697a6d379ec69f3cac25cd8241cef2f · words 705121c5e64a3d0673aca885a65f14bd · score e441174cdbed966f9611a6c9f57aaf48 · text 7608a3ccc02ec141038ea88dd6b25a67
-- (2) after the next ready read, N5245 is matched by name and proposed 0:
--   SELECT i.code, i.page365_product_id, i.match_result, i.category, i.result_note, i.seen_stock, i.proposed_stock, i.status
--     FROM public.page365_inventory_items i
--    WHERE i.run_id = (SELECT id FROM public.page365_inventory_runs WHERE status = 'ready' ORDER BY created_at DESC LIMIT 1)
--      AND i.code IN ('N5245', 'N1045') ORDER BY 1, 2;
-- (3) bells raised by this rule:
--   SELECT created_at, title, body FROM public.staff_notifications
--    WHERE type = 'page365_duplicate_code' ORDER BY created_at DESC LIMIT 10;
-- ---------------------------------------------------------------------------

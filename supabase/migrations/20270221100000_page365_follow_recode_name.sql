-- ===========================================================================
-- page365_follow_recode_name — a listing whose CODE and NAME changed on
-- Page365 in the same edit (N1073 -> N9140, listing 80622155) now has its
-- NAME followed too. Fixes the gap left by 20270220100000
-- (docs/PAGE365-FOLLOW-AND-DELETE-PLAN.md §2.2; docs/PAGE365-IMPORT.md
-- "FOLLOW"). Owner rules unchanged: a staff-completed name is never
-- overwritten; price, stock, status, photos and the delete path are untouched.
--
-- ROOT CAUSE
--   page365_follow_names (finish step h) decides "the name changed" by
--   comparing Page365-now with page365_listing_names.last_p365_name, the
--   Page365 name the Hub LAST SAW — never with the Hub name (by design, so a
--   completed name is never cut back). That memory is seeded by 20270220100000
--   from the FULL item history, and the history of a listing re-coded BEFORE
--   that release already carries the NEW code and NEW name (80622155 has read
--   as N9140 since 17 Oct). So after the release:
--     1. step (a3) page365_inventory_follow_code renames the Hub product to
--        the new code and keeps the REST of the OLD name ("N9140 <old words>"),
--     2. step (h) finds Page365-now = last_p365_name -> "unchanged" -> skips,
--   and the Hub keeps a hybrid name that was never on Page365: no follow, no
--   bell, no ja_pending, and never re-evaluated (last_p365_name is already the
--   current text). A code-only or a name-only change, and a simultaneous change
--   made AFTER the release, work: there last_p365_name still holds the previous
--   Page365 text. The one-time pass of 20270220100000 could not help: it only
--   sees MATCHED items, and a re-coded listing was unmatched until (a3) existed.
--
-- WHAT THIS FILE DOES
--   1. page365_follow_names: when step (a3) renamed the product in THIS read
--      (the item's result_note = 'code_followed'), the name is also compared
--      with the Hub name, so "Page365 moved on while the Hub still shows the
--      old text behind the new code" counts as a change. The rest is the
--      existing rule: Hub name still verbatim a Page365 text seen before ->
--      replaced (name_ja cleared, ja_pending); otherwise kept + ONE bell
--      page365_name_changed. The bell now names the PREVIOUS distinct Page365
--      text when last_p365_name already equals the new one (else it would read
--      "from X to X"). A completed name is still never compared outside that
--      one read.
--   2. The one-time pass again (page365_follow_names(latest ready full run,
--      true)): repairs a product that a read BETWEEN the two releases already
--      renamed to the hybrid text (matched by its new code every read since,
--      so rule 1 alone would never see it). Idempotent; no per-product bell;
--      one summary bell only when something differed.
--   Changes no stock, no status, no price, no setting, no link (self-check).
--   No table, index, policy, trigger or FK change. Comments stay OUTSIDE the
--   function body (Lovable strips in-body comment lines on apply).
--
-- FUNCTION CHANGES START FROM LIVE (CLAUDE.md, Bug #280). md5(pg_proc.prosrc):
--   replaced   page365_follow_names(uuid,boolean)
--              f94cc7a8650f239d705095e95dd677f1 (20270220100000 as applied from the
--              repo text) -> df6874f35c21f527191d0d06153278c1
--   unchanged  page365_inventory_finish        5c5704eb68e50cf4cf2a94d95f78efcf
--              page365_inventory_follow_code   ee37a40f30c9cc1fa394b2184486c5e1
--              page365_inventory_follow_listing 45a3249317c8ecb30f86b772130a57f2
--   The pre-flight REFUSES the whole file when live's page365_follow_names is
--   neither the 20270220100000 body nor already this one. UNVERIFIED against
--   live at build time (read-only: docs/sql/20270221_page365_follow_recode_name_dry_run.sql): if Lovable applied
--   20270220100000 (it strips in-body comment lines) the md5 differs and the
--   owner re-reads the live body before applying this file.
--
-- ROLLBACK: re-run section 6 of 20270220100000 (the CREATE OR REPLACE of
-- page365_follow_names and its REVOKE/GRANT). Names already followed by the
-- pass are listed in audit_logs (action page365_name_followed, new_value_json
-- ->> 'once' = 'true', run_id of this pass) with old_value_json ->> 'name'.
-- ===========================================================================

SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 0. Pre-flight. Nothing below runs unless every check passes.
-- ---------------------------------------------------------------------------
DO $pre$
DECLARE
  v_got text;
BEGIN
  IF to_regclass('public.page365_listing_names') IS NULL OR to_regclass('public.page365_inventory_items') IS NULL
     OR to_regprocedure('public.page365_inventory_follow_code(uuid)') IS NULL
     OR to_regprocedure('public.page365_inventory_follow_listing(uuid)') IS NULL
     OR to_regprocedure('public.page365_listing_text(uuid)') IS NULL
     OR to_regprocedure('public.page365_make_slug(text,text,bigint,uuid)') IS NULL THEN
    RAISE EXCEPTION 'page365_follow_recode_name: 20270220100000_page365_follow_and_catalog_delete has not been applied — nothing changed';
  END IF;

  SELECT md5(p.prosrc) INTO v_got FROM pg_proc p WHERE p.oid = to_regprocedure('public.page365_follow_names(uuid,boolean)');
  IF v_got IS DISTINCT FROM 'f94cc7a8650f239d705095e95dd677f1' AND v_got IS DISTINCT FROM 'df6874f35c21f527191d0d06153278c1' THEN
    RAISE EXCEPTION 'page365_follow_recode_name: live page365_follow_names has md5 % (expected the 20270220100000 body f94cc7a8… or this file''s df6874f3…) — nothing changed. Read pg_get_functiondef on live first.', coalesce(v_got, 'missing');
  END IF;

  -- For the self-check: no stock, status, price, setting or link moves (names may, by design).
  PERFORM set_config('page365.recode_name_before',
    (SELECT count(*)::text FROM public.website_products) || '|'
    || (SELECT md5(coalesce(string_agg(wp.id::text || ':' || wp.status::text || ':' || coalesce(wp.page365_product_id::text, '-'), ',' ORDER BY wp.id), '')) FROM public.website_products wp)
    || (SELECT md5(coalesce(string_agg(v.id::text || ':' || v.stock_qty || ':' || coalesce(v.price_jpy, -1), ',' ORDER BY v.id), '')) FROM public.website_product_variants v)
    || (SELECT md5(coalesce(string_agg(s.key || '=' || s.value::text, ',' ORDER BY s.key), '')) FROM public.system_settings s
         WHERE s.key LIKE 'page365%'),
    false);
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. page365_follow_names — the 20270220100000 body with two edits:
--    (i)  v_changed also true when this read's (a3) renamed the product and
--         Page365's text differs from the Hub's (r.recoded);
--    (ii) the bell names the previous DISTINCT Page365 text (v_prev).
--    In-body comments of the 20270220100000 text are moved up here:
--    - the first-sight INSERT: a product that landed in this very read, or one
--      never seen: remember, compare nothing;
--    - the one-time pass skips a kept (completed) name already counted
--      (bell_name = the current text);
--    - Hub name = Page365's text: staff already typed it, nothing to change
--      or ring;
--    - never completed (Hub still carries a Page365 text verbatim): copy the
--      new one; never public -> the slug follows the name, once public it
--      never moves; the UPDATE's EXCEPTION (e.g. the terminology guard refused
--      the text) keeps the name and rings below.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_follow_names(p_run_id uuid, p_once boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  r         record;
  v_ln      public.page365_listing_names%ROWTYPE;
  v_cur     text;
  v_prev    text;
  v_changed boolean;
  v_never   boolean;
  v_done    boolean;
  v_keep    boolean;
  v_updated integer := 0;
  v_kept    integer := 0;
BEGIN
  FOR r IN
    SELECT i.id AS item_id, wp.id AS pid, i.page365_product_id AS ppid, i.page365_variant_id AS pvid,
           wp.name AS hub_name, wp.sku, wp.first_published_at,
           (i.result_note IS NOT DISTINCT FROM 'code_followed') AS recoded
      FROM public.page365_inventory_items i
      JOIN public.website_products wp ON wp.id = i.website_product_id
     WHERE i.run_id = p_run_id AND i.kind = 'page365' AND i.match_result = 'matched' AND i.category <> 'not_synced'
       AND NOT coalesce(wp.page365_sync_disabled, false)
       AND wp.page365_product_id = i.page365_product_id AND wp.page365_variant_id = i.page365_variant_id
     ORDER BY i.id
  LOOP
    v_cur := btrim(coalesce(public.page365_listing_text(r.item_id), ''));
    CONTINUE WHEN v_cur = '';
    CONTINUE WHEN public.page365_first_word(v_cur) IS DISTINCT FROM public.page365_first_word(r.hub_name);

    SELECT * INTO v_ln FROM public.page365_listing_names WHERE website_product_id = r.pid FOR UPDATE;
    IF NOT FOUND THEN
      INSERT INTO public.page365_listing_names (website_product_id, page365_product_id, page365_variant_id, last_p365_name, seen_names)
      VALUES (r.pid, r.ppid, r.pvid, v_cur, ARRAY[v_cur])
      ON CONFLICT (website_product_id) DO NOTHING;
      CONTINUE;
    END IF;

    v_changed := CASE WHEN p_once THEN public.page365_norm_name(v_cur) IS DISTINCT FROM public.page365_norm_name(r.hub_name)
                      ELSE public.page365_norm_name(v_cur) IS DISTINCT FROM public.page365_norm_name(v_ln.last_p365_name)
                        OR (r.recoded AND public.page365_norm_name(v_cur) IS DISTINCT FROM public.page365_norm_name(r.hub_name)) END;
    IF NOT v_changed THEN CONTINUE; END IF;
    CONTINUE WHEN p_once AND v_ln.bell_name IS NOT DISTINCT FROM v_cur;
    v_keep := false;

    v_prev := v_ln.last_p365_name;
    IF public.page365_norm_name(v_prev) = public.page365_norm_name(v_cur) THEN
      SELECT t.s INTO v_prev FROM unnest(v_ln.seen_names) WITH ORDINALITY AS t(s, ord)
       WHERE public.page365_norm_name(t.s) <> public.page365_norm_name(v_cur)
       ORDER BY t.ord DESC LIMIT 1;
      v_prev := coalesce(v_prev, v_ln.last_p365_name);
    END IF;

    IF public.page365_norm_name(r.hub_name) = public.page365_norm_name(v_cur) THEN
      v_done := false; v_never := false;
    ELSE
      v_never := EXISTS (SELECT 1 FROM unnest(v_ln.seen_names) s
                          WHERE public.page365_norm_name(public.page365_swap_code(s, public.page365_first_word(r.hub_name)))
                                = public.page365_norm_name(r.hub_name));
      v_done := false;
      IF v_never THEN
        BEGIN
          UPDATE public.website_products
             SET name = v_cur, name_ja = NULL,
                 slug = CASE WHEN r.first_published_at IS NULL
                             THEN public.page365_make_slug(public.page365_first_word(v_cur), v_cur, r.pvid, r.pid) ELSE slug END
           WHERE id = r.pid;
          INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id)
          VALUES ('website_product', r.pid, 'page365_name_followed',
                  jsonb_build_object('name', r.hub_name),
                  jsonb_build_object('name', v_cur, 'run_id', p_run_id, 'once', p_once, 'recoded', r.recoded,
                                     'page365_product_id', r.ppid), NULL);
          v_done := true;
          v_updated := v_updated + 1;
        EXCEPTION WHEN OTHERS THEN
          v_done := false;
        END;
      END IF;
      IF NOT v_done THEN
        v_keep := true;
        v_kept := v_kept + 1;
        IF NOT p_once AND v_ln.bell_name IS DISTINCT FROM v_cur THEN
          INSERT INTO public.staff_notifications (type, title, body, metadata)
          VALUES ('page365_name_changed', 'Page365 changed a name you completed',
                  r.sku || ': Page365 changed its name from "' || coalesce(v_prev, '') || '" to "' || v_cur
                    || '". The Hub name was completed by staff and was left as "' || r.hub_name || '".',
                  jsonb_build_object('run_id', p_run_id, 'website_product_id', r.pid, 'code', r.sku,
                                     'page365_old', v_prev, 'page365_new', v_cur, 'hub_name', r.hub_name,
                                     'recoded', r.recoded));
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
  '2026-10-29 (+ recode fix). Name follow for the matched, linked items of a run. Change = Page365 now vs the Page365 name last seen (page365_listing_names), never vs the Hub name — EXCEPT in the read where step (a3) renamed the product to a new code (item result_note code_followed): then Page365 now vs the Hub name too, so a code + name changed in one Page365 edit is followed. Hub name still exactly a name seen before -> replaced by the new Page365 name (name_ja cleared, ja_pending); otherwise kept + ONE bell page365_name_changed per Page365 name, naming the previous distinct Page365 text. p_once: the one-time pass (Hub vs Page365, no per-product bell, one summary bell). Never touches price.';

-- ---------------------------------------------------------------------------
-- 2. The one-time pass again, over the latest ready FULL read: repairs a
--    product that a read between the two releases already renamed to the
--    hybrid text (compared Hub vs Page365; never-completed -> updated,
--    completed -> kept; no per-product bell; one summary bell only if any).
-- ---------------------------------------------------------------------------
DO $once$
DECLARE v_run uuid; v_res jsonb;
BEGIN
  SELECT r.id INTO v_run FROM public.page365_inventory_runs r
   WHERE r.kind = 'full' AND r.status = 'ready' ORDER BY r.created_at DESC LIMIT 1;
  IF v_run IS NOT NULL THEN
    v_res := public.page365_follow_names(v_run, true);
    RAISE NOTICE 'page365 recode-name pass: %', v_res;
  ELSE
    RAISE NOTICE 'page365 recode-name pass: no complete full read yet — skipped';
  END IF;
END
$once$;

-- ---------------------------------------------------------------------------
-- 3. Self-check. RAISE = the whole file is refused.
-- ---------------------------------------------------------------------------
DO $check$
DECLARE
  v_after text;
  v_got   text;
BEGIN
  v_after :=
    (SELECT count(*)::text FROM public.website_products) || '|'
    || (SELECT md5(coalesce(string_agg(wp.id::text || ':' || wp.status::text || ':' || coalesce(wp.page365_product_id::text, '-'), ',' ORDER BY wp.id), '')) FROM public.website_products wp)
    || (SELECT md5(coalesce(string_agg(v.id::text || ':' || v.stock_qty || ':' || coalesce(v.price_jpy, -1), ',' ORDER BY v.id), '')) FROM public.website_product_variants v)
    || (SELECT md5(coalesce(string_agg(s.key || '=' || s.value::text, ',' ORDER BY s.key), '')) FROM public.system_settings s
         WHERE s.key LIKE 'page365%');
  IF v_after IS DISTINCT FROM current_setting('page365.recode_name_before', true) THEN
    RAISE EXCEPTION 'page365_follow_recode_name self-check: a product count, status, link, stock, price or setting moved';
  END IF;

  SELECT md5(p.prosrc) INTO v_got FROM pg_proc p WHERE p.oid = to_regprocedure('public.page365_follow_names(uuid,boolean)');
  IF v_got IS DISTINCT FROM 'df6874f35c21f527191d0d06153278c1' THEN
    RAISE EXCEPTION 'page365_follow_recode_name self-check: page365_follow_names has md5 % (expected df6874f35c21f527191d0d06153278c1)', v_got;
  END IF;
  SELECT md5(p.prosrc) INTO v_got FROM pg_proc p WHERE p.oid = to_regprocedure('public.page365_inventory_finish(uuid)');
  IF v_got IS DISTINCT FROM '5c5704eb68e50cf4cf2a94d95f78efcf' THEN
    RAISE EXCEPTION 'page365_follow_recode_name self-check: page365_inventory_finish moved (md5 %)', v_got;
  END IF;
  SELECT md5(p.prosrc) INTO v_got FROM pg_proc p WHERE p.oid = to_regprocedure('public.page365_inventory_follow_code(uuid)');
  IF v_got IS DISTINCT FROM 'ee37a40f30c9cc1fa394b2184486c5e1' THEN
    RAISE EXCEPTION 'page365_follow_recode_name self-check: page365_inventory_follow_code moved (md5 %)', v_got;
  END IF;

  IF has_function_privilege('anon', 'public.page365_follow_names(uuid,boolean)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.page365_follow_names(uuid,boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'page365_follow_recode_name self-check: page365_follow_names is callable by anon / authenticated';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.page365_follow_names(uuid,boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'page365_follow_recode_name self-check: service_role cannot call page365_follow_names';
  END IF;
END
$check$;

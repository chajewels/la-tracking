-- ═══════════════════════════════════════════════════════════════════════════
-- "Layaway only" is a manual switch (owner decision 2026-10-16 17:34 JST).
--
-- Every switch in Hub → Website → Content must save and stay as the user set it. "Layaway
-- only" on Posts and FAQ questions did not: the trigger function force_layaway_english_only()
-- forced layaway_only = true whenever the text mentioned layaway (live-only since before
-- 2026-09-28; narrowed to the Japanese text by 20261220100000 earlier the same day). The
-- owner now decides per row, so the forcing goes.
--
-- What is dropped:
--   * trigger trg_posts_layaway_en      ON public.website_posts
--   * trigger trg_faq_items_layaway_en  ON public.website_faq_items
--   * function public.force_layaway_english_only()  (no CASCADE: anything else still using
--     it makes the drop fail and the whole file roll back)
--
-- Untouched: the layaway_only column and every row's current value (no data is rewritten),
-- and the storefront, which still hides layaway_only = true rows on the Japanese site.
-- The Hub keeps a non-blocking hint when the Japanese text mentions layaway
-- (src/lib/layaway-only-rule.ts).
--
-- Guarded: the function must be exactly the body 20261220100000 put live (md5 below);
-- anything else stops before any change. Idempotent: if the function and both triggers are
-- already gone, the file does nothing.
-- ═══════════════════════════════════════════════════════════════════════════

DO $pre$
DECLARE v_got text; v_trg int;
BEGIN
  SELECT md5(p.prosrc) INTO v_got
    FROM pg_proc p WHERE p.oid = to_regprocedure('public.force_layaway_english_only()');
  SELECT count(*) INTO v_trg FROM pg_trigger
   WHERE tgname IN ('trg_posts_layaway_en', 'trg_faq_items_layaway_en') AND NOT tgisinternal;
  IF v_got IS NULL AND v_trg = 0 THEN
    RAISE NOTICE 'force_layaway_english_only() and both triggers already absent; nothing to do';
  ELSIF v_got IS DISTINCT FROM '89ba3b33263d88d37c1f3d6e91d4ea96' THEN
    RAISE EXCEPTION 'force_layaway_english_only() md5 % (triggers: %); expected 89ba3b33263d88d37c1f3d6e91d4ea96. Nothing changed', v_got, v_trg;
  END IF;
END $pre$;

DROP TRIGGER IF EXISTS trg_posts_layaway_en ON public.website_posts;
DROP TRIGGER IF EXISTS trg_faq_items_layaway_en ON public.website_faq_items;
DROP FUNCTION IF EXISTS public.force_layaway_english_only();

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger
              WHERE tgname IN ('trg_posts_layaway_en', 'trg_faq_items_layaway_en') AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'a layaway_only forcing trigger is still present';
  END IF;
  IF to_regprocedure('public.force_layaway_english_only()') IS NOT NULL THEN
    RAISE EXCEPTION 'force_layaway_english_only() is still present';
  END IF;
END $post$;

-- ═══════════════════════════════════════════════════════════════════════════
-- "Layaway only" is forced by the JAPANESE text only (owner decision 2026-10-16).
--
-- Why: public.force_layaway_english_only() (BEFORE INSERT OR UPDATE on website_posts and
-- website_faq_items) forced layaway_only = true whenever ANY text field mentioned layaway,
-- English included. A Post or FAQ question whose English text mentions layaway could never
-- be shown on the Japanese site: Hub → Website → Content switched "Layaway only" off, Save,
-- and the switch snapped back on. The storefront never renders English text on the JA site
-- (website CLAUDE.md, 2026-09-25), so an English mention cannot leak layaway to Japanese
-- readers. Only the Japanese text can.
--
-- What changed (nothing else):
--   * `t` is built ONLY from the Japanese fields: question_ja, answer_ja, title_ja,
--     excerpt_ja, body_ja. The English fields (question_en, answer_en, title_en, body_en,
--     excerpt_en) are dropped. excerpt_ja is new (the live body read excerpt_en only).
--   * 分割予約 is caught as well as 'layaway' (case-insensitive) and レイアウェイ.
--   * Still to_jsonb(NEW) ->> so the one function serves both tables.
--
-- Unchanged: name, signature, LANGUAGE plpgsql, the ACL (CREATE OR REPLACE keeps it:
-- PUBLIC, postgres, service_role, sandbox_exec_* as recorded in 20261009500000 section 8),
-- and the two triggers trg_posts_layaway_en / trg_faq_items_layaway_en, which are NOT
-- touched here. Existing rows are not rewritten: a row keeps its flag until it is next
-- saved. The Hub mirror of the three patterns is src/lib/layaway-only-rule.ts.
--
-- Started from LIVE (CLAUDE.md "FUNCTION CHANGES START FROM LIVE", Bug #280): the body
-- below is 20261009500000 section 8 (live prosrc md5 1f2da719fe9da1651dfa5c878c8e3458)
-- with only the lines above changed. The guard refuses to run if live has moved.
-- ═══════════════════════════════════════════════════════════════════════════

DO $pre$
DECLARE v_got text;
BEGIN
  SELECT md5(p.prosrc) INTO v_got
    FROM pg_proc p WHERE p.oid = to_regprocedure('public.force_layaway_english_only()');
  IF v_got IS NULL THEN
    RAISE EXCEPTION 'force_layaway_english_only() is absent; expected live md5 1f2da719fe9da1651dfa5c878c8e3458';
  END IF;
  IF v_got NOT IN ('1f2da719fe9da1651dfa5c878c8e3458',   -- live as recorded 2026-09-28
                   '89ba3b33263d88d37c1f3d6e91d4ea96') THEN  -- this migration (re-run)
    RAISE EXCEPTION 'force_layaway_english_only() has moved on live (md5 %); nothing changed', v_got;
  END IF;
END $pre$;

CREATE OR REPLACE FUNCTION public.force_layaway_english_only()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE t text;
BEGIN
  t := concat_ws(' ', to_jsonb(NEW) ->> 'question_ja', to_jsonb(NEW) ->> 'answer_ja',
                      to_jsonb(NEW) ->> 'title_ja',    to_jsonb(NEW) ->> 'excerpt_ja',
                      to_jsonb(NEW) ->> 'body_ja');
  IF t ILIKE '%layaway%' OR t LIKE '%レイアウェイ%' OR t LIKE '%分割予約%' THEN
    NEW.layaway_only := true;
  END IF;
  RETURN NEW;
END $function$;

DO $post$
DECLARE v_got text;
BEGIN
  SELECT md5(p.prosrc) INTO v_got
    FROM pg_proc p WHERE p.oid = to_regprocedure('public.force_layaway_english_only()');
  IF v_got IS DISTINCT FROM '89ba3b33263d88d37c1f3d6e91d4ea96' THEN
    RAISE EXCEPTION 'force_layaway_english_only() md5 % after replace; expected 89ba3b33263d88d37c1f3d6e91d4ea96', v_got;
  END IF;
END $post$;
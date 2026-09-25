-- ===========================================================================
-- page365_hide_follow — "hidden in Page365 -> hidden on the website" (PR 3b).
-- Owner rule, approved 2026-09-26.
--
-- OWNER RUNS THIS in the SQL Editor, as-is, after the release PR is on main.
-- No edge function is deployed for it: page365-inventory-fetch already calls
-- page365_inventory_finish and page365_inventory_auto_apply_run, and everything
-- below hangs off those two. One transaction. Nothing below changes website
-- stock or publishes/unpublishes anything when it runs — it only makes the
-- NEXT complete Page365 read able to propose (and, with the automatic switch
-- on, apply) a hide.
--
-- The rule:
--   Page365 hides sold pieces, so they vanish from its public catalogue. When a
--   synced Hub product is MISSING from 2 COMPLETE Page365 reads in a row, the
--   Hub sets its website stock to 0 AND unpublishes it (status 'draft').
--   * Only a product that was SEEN — matched on its code in an earlier complete
--     read — and then went missing. A Hub-only product (never matched) is never
--     hidden. A product whose code was changed in the Hub since it was seen is
--     treated as never seen under the new code.
--   * Never a product switched to "Don't sync with Page365" (read LIVE at apply).
--   * Never from a partial or failed read (finish's guards: a product read
--     error, or the catalogue count falling > 20 %). "In a row" counts complete
--     reads only; a partial read in between neither counts nor breaks the row.
--   * Compare-and-set: only if the product is still published ('active') and
--     every variant's stock is what the read saw; otherwise skipped, reported.
--   * Scheduled reads apply hides by themselves ONLY while
--     system_settings.page365_inventory_auto_apply is on — the same gate as the
--     decreases. A manual read shows them pre-ticked; "Apply selected" applies.
--   * NEVER re-published automatically. A hidden product that shows up in
--     Page365 again is flagged "Back in Page365 — re-publish?" for staff.
--   * Orders and reservations are never touched. Every hide is audited (per
--     product and per run); one staff bell per run that hid anything.
--
-- Why 'draft': website_products.status is the enum website_product_status
-- ('draft','active','archived'). 'active' is published. 'draft' is the Hub's
-- own unpublished state: it is what Catalog shows as not on the website, and
-- what the Catalog bulk Publish (website_publish_products) turns back into
-- 'active' — so "re-publish" is the existing path, with its existing checks.
-- 'archived' is NOT used: it means retired, and archived products are dropped
-- from Page365 matching altogether (finish's Hub-only list skips them), so a
-- piece coming back in Page365 could never be flagged.
--
-- What it does:
--   A. page365_product_presence — one row per Hub product ever matched in a
--      COMPLETE read: the code it was matched on, first/last seen, and the hide
--      mark (hidden_at …). Written only by the functions below. Backfilled here
--      from the complete runs still kept (retention keeps 14 days).
--   B. Items: category 'hide' (the proposal), hide_snapshot (every variant's
--      stock at the read, the compare-and-set basis), back_in_page365 (flag).
--      Runs: hidden_count, hide_notified_at.
--   C. page365_inventory_follow(run) — runs INSIDE page365_inventory_finish's
--      transaction, from trigger trg_page365_inventory_follow on the run's
--      fetching -> ready write: records who was seen, flags "back in Page365",
--      and turns the qualifying Hub-only rows into 'hide' proposals. It never
--      writes stock or status. If it ever fails, the read still completes with
--      no hide proposals (the safe direction) and an audit row says why.
--      finish's own body is NOT changed.
--   D. page365_inventory_hide_item — the one hide writer (service role only):
--      checks, compare-and-set, stock 0 + 'draft', presence mark, audit.
--      page365_inventory_hide(run, ids) — "Apply selected" (manage_website_catalog).
--   E. page365_inventory_auto_apply_run — PR 3 body + the hides after the
--      decreases, same gate. Still at most ONE bell per run.
--
-- FUNCTION CHANGES START FROM LIVE (CLAUDE.md, Bug #280). md5(pg_proc.prosrc):
--   replaced:  page365_inventory_auto_apply_run  f742ccfdaf94933de0479e3c2e6c673a  (PR 3, 20260930100000)
--   relied on, unchanged, proved unchanged after:
--              page365_inventory_finish          9d0be9494288800686e2d6a90edb3304  (PR 2)
--              page365_inventory_apply           e65757c2f32b597b2a55047d77783df3  (PR 2)
--              page365_inventory_retention       9dc2d413a9b146ebc09778c854dad187  (PR 3)
--              website_publish_products          72db495e4e9123f159b5b72ed629c0cd  (PR 4)
--
-- Guards: every dependency is checked first; the whole transaction aborts with
-- NOTHING changed if live is not what this was written against. Re-running
-- the file is a no-op (the replaced body is recognised as already new).
-- ===========================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Pre-flight. Nothing below runs unless every check passes.
-- ---------------------------------------------------------------------------
DO $pre$
DECLARE
  v_missing text[] := ARRAY[]::text[];
  v_cols    text[];
  v_bad     text := '';
  v_got     text;
  v_def     text;
  v_status  text;
  r         record;
BEGIN
  IF to_regclass('public.page365_inventory_runs')     IS NULL THEN v_missing := v_missing || 'page365_inventory_runs (PR 1)'::text; END IF;
  IF to_regclass('public.page365_inventory_items')    IS NULL THEN v_missing := v_missing || 'page365_inventory_items (PR 1)'::text; END IF;
  IF to_regclass('public.website_products')           IS NULL THEN v_missing := v_missing || 'website_products'::text; END IF;
  IF to_regclass('public.website_product_variants')   IS NULL THEN v_missing := v_missing || 'website_product_variants'::text; END IF;
  IF to_regclass('public.system_settings')            IS NULL THEN v_missing := v_missing || 'system_settings'::text; END IF;
  IF to_regclass('public.audit_logs')                 IS NULL THEN v_missing := v_missing || 'audit_logs'::text; END IF;
  IF to_regclass('public.staff_notifications')        IS NULL THEN v_missing := v_missing || 'staff_notifications'::text; END IF;
  IF to_regclass('public.page365_stock_lines')        IS NULL THEN v_missing := v_missing || 'page365_stock_lines (#195)'::text; END IF;
  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'page365_hide_follow: missing: %', array_to_string(v_missing, ', ');
  END IF;

  SELECT array_agg(c.table_name || '.' || c.column_name) INTO v_cols
    FROM (VALUES
      ('page365_inventory_runs','id'), ('page365_inventory_runs','source'), ('page365_inventory_runs','status'),
      ('page365_inventory_runs','created_at'), ('page365_inventory_runs','finished_at'), ('page365_inventory_runs','error'),
      ('page365_inventory_runs','auto_apply_state'), ('page365_inventory_runs','auto_applied'), ('page365_inventory_runs','auto_apply_at'),
      ('page365_inventory_runs','auto_apply_changed'), ('page365_inventory_runs','auto_apply_skipped'), ('page365_inventory_runs','notified_at'),
      ('page365_inventory_items','run_id'), ('page365_inventory_items','kind'), ('page365_inventory_items','category'),
      ('page365_inventory_items','match_result'), ('page365_inventory_items','status'), ('page365_inventory_items','variant_id'),
      ('page365_inventory_items','website_product_id'), ('page365_inventory_items','hub_sku'), ('page365_inventory_items','missing_runs'),
      ('page365_inventory_items','seen_stock'), ('page365_inventory_items','proposed_stock'), ('page365_inventory_items','code'),
      ('page365_inventory_items','page365_available'), ('page365_inventory_items','web_holds'), ('page365_inventory_items','invoice_holds'),
      ('page365_inventory_items','applied_at'), ('page365_inventory_items','applied_by'), ('page365_inventory_items','result_note'),
      ('website_products','id'), ('website_products','sku'), ('website_products','status'), ('website_products','page365_sync_disabled'),
      ('website_product_variants','id'), ('website_product_variants','stock_qty'), ('website_product_variants','product_id'),
      ('website_product_variants','updated_at')
    ) AS c(table_name, column_name)
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns ic
      WHERE ic.table_schema = 'public' AND ic.table_name = c.table_name AND ic.column_name = c.column_name);
  IF v_cols IS NOT NULL THEN
    RAISE EXCEPTION 'page365_hide_follow: missing column(s): %', array_to_string(v_cols, ', ');
  END IF;

  IF to_regprocedure('public.has_permission(uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'page365_hide_follow: public.has_permission(uuid,text) missing';
  END IF;
  IF to_regprocedure('public.page365_first_word(text)') IS NULL THEN
    RAISE EXCEPTION 'page365_hide_follow: public.page365_first_word(text) missing (#195)';
  END IF;

  -- website_products.status must know 'draft' and 'active' (live: the enum
  -- website_product_status; a text column is accepted for local tests).
  SELECT c.udt_name INTO v_status FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'website_products' AND c.column_name = 'status';
  IF v_status = 'website_product_status' THEN
    IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                    WHERE t.typname = 'website_product_status' AND e.enumlabel = 'draft')
       OR NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                       WHERE t.typname = 'website_product_status' AND e.enumlabel = 'active') THEN
      RAISE EXCEPTION 'page365_hide_follow: website_product_status has no draft/active';
    END IF;
  ELSIF v_status IS DISTINCT FROM 'text' THEN
    RAISE EXCEPTION 'page365_hide_follow: website_products.status is %, expected website_product_status', v_status;
  END IF;

  -- The live bodies. auto_apply_run is replaced below; if it is already the
  -- new body (a re-run) that is fine — the self-check pins the new md5.
  FOR r IN
    SELECT * FROM (VALUES
      ('page365_inventory_finish(uuid)',              '9d0be9494288800686e2d6a90edb3304', NULL),
      ('page365_inventory_apply(uuid,uuid[],uuid[])', 'e65757c2f32b597b2a55047d77783df3', NULL),
      ('page365_inventory_retention(integer)',        '9dc2d413a9b146ebc09778c854dad187', NULL),
      ('website_publish_products(uuid[])',            '72db495e4e9123f159b5b72ed629c0cd', NULL),
      ('page365_inventory_auto_apply_run(uuid)',      'f742ccfdaf94933de0479e3c2e6c673a', '21eb560506fc8727076d715dd9e1bc97')
    ) AS t(fn, want, or_new)
  LOOP
    SELECT md5(p.prosrc) INTO v_got FROM pg_proc p WHERE p.oid = to_regprocedure('public.' || r.fn);
    IF v_got IS DISTINCT FROM r.want AND v_got IS DISTINCT FROM r.or_new THEN
      v_bad := v_bad || format(E'\n  %s: live body md5 %s, expected %s', r.fn, coalesce(v_got, 'missing'), r.want);
    END IF;
  END LOOP;
  IF v_bad <> '' THEN
    RAISE EXCEPTION 'STOP — page365_hide_follow: live is not what this file was written against. Nothing was modified.%', v_bad;
  END IF;

  -- The item category CHECK must be PR 2's list (re-run: already with 'hide').
  SELECT pg_get_constraintdef(k.oid) INTO v_def FROM pg_constraint k
   WHERE k.conrelid = 'public.page365_inventory_items'::regclass AND k.conname = 'page365_inventory_items_category_check';
  IF v_def IS NULL
     OR NOT (v_def LIKE '%''pending''%' AND v_def LIKE '%''decrease''%' AND v_def LIKE '%''increase''%'
             AND v_def LIKE '%''no_change''%' AND v_def LIKE '%''excluded''%' AND v_def LIKE '%''flagged''%'
             AND v_def LIKE '%''new''%' AND v_def LIKE '%''hub_only''%' AND v_def LIKE '%''not_synced''%') THEN
    RAISE EXCEPTION 'page365_hide_follow: page365_inventory_items_category_check is not PR 2''s list: %', coalesce(v_def, 'missing');
  END IF;
  IF (SELECT count(*) FROM pg_constraint k
       WHERE k.conrelid = 'public.page365_inventory_items'::regclass AND k.contype = 'c'
         AND pg_get_constraintdef(k.oid) ILIKE '%category%') <> 1 THEN
    RAISE EXCEPTION 'page365_hide_follow: expected exactly one CHECK on page365_inventory_items.category';
  END IF;

  -- Name collisions: new functions must not exist with another signature.
  SELECT string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', ') INTO v_got
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND ((p.proname = 'page365_inventory_follow'      AND pg_get_function_identity_arguments(p.oid) <> 'p_run_id uuid')
       OR (p.proname = 'page365_inventory_follow_trg'  AND pg_get_function_identity_arguments(p.oid) <> '')
       OR (p.proname = 'page365_inventory_hide_item'   AND pg_get_function_identity_arguments(p.oid) <> 'p_item_id uuid, p_run_id uuid, p_actor uuid, p_source text')
       OR (p.proname = 'page365_inventory_hide'        AND pg_get_function_identity_arguments(p.oid) <> 'p_run_id uuid, p_item_ids uuid[]'));
  IF v_got IS NOT NULL THEN
    RAISE EXCEPTION 'page365_hide_follow: function(s) already exist with another signature: %', v_got;
  END IF;
  IF to_regclass('public.page365_product_presence') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema = 'public' AND table_name = 'page365_product_presence' AND column_name = 'hidden_at') THEN
    RAISE EXCEPTION 'page365_hide_follow: a different public.page365_product_presence already exists';
  END IF;

  -- Remember what must not move: the switch, and every product's status/stock.
  PERFORM set_config('page365.hide_switch_before',
                     coalesce((SELECT value #>> '{}' FROM public.system_settings WHERE key = 'page365_inventory_auto_apply'), 'absent'), true);
  PERFORM set_config('page365.hide_catalog_before',
                     (SELECT md5(coalesce(string_agg(wp.id::text || ':' || wp.status::text, ',' ORDER BY wp.id), ''))
                        FROM public.website_products wp)
                     || (SELECT md5(coalesce(string_agg(v.id::text || ':' || v.stock_qty, ',' ORDER BY v.id), ''))
                           FROM public.website_product_variants v), true);
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. Presence: who was seen on Page365, on which code, and the hide mark.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.page365_product_presence (
  website_product_id uuid PRIMARY KEY REFERENCES public.website_products(id) ON DELETE CASCADE,
  code               text NOT NULL,
  first_seen_at      timestamptz NOT NULL,
  first_seen_run_id  uuid,
  last_seen_at       timestamptz NOT NULL,
  last_seen_run_id   uuid,
  hidden_at          timestamptz,
  hidden_run_id      uuid,
  hidden_by          uuid,
  hidden_source      text CHECK (hidden_source IS NULL OR hidden_source IN ('manual','schedule')),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.page365_product_presence IS
  'Page365 hide-follow (PR 3b, 2026-10-01). One row per Hub product matched on its code in a COMPLETE (ready) Page365 read: code = the code it was matched on, first/last seen = the read''s start. hidden_* = the Hub hid it (stock 0 + draft) because it went missing from 2 complete reads in a row; cleared when a later complete read sees it again while it is no longer a draft. Run ids are not foreign keys (retention prunes runs). Written only by page365_inventory_follow / page365_inventory_hide_item.';
CREATE INDEX IF NOT EXISTS idx_page365_product_presence_hidden
  ON public.page365_product_presence (hidden_at) WHERE hidden_at IS NOT NULL;
ALTER TABLE public.page365_product_presence ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Catalog staff read Page365 presence" ON public.page365_product_presence;
CREATE POLICY "Catalog staff read Page365 presence" ON public.page365_product_presence
  FOR SELECT TO authenticated USING (public.has_permission(auth.uid(), 'manage_website_catalog'));
REVOKE ALL ON public.page365_product_presence FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.page365_product_presence TO authenticated;
GRANT ALL ON public.page365_product_presence TO service_role;

-- ---------------------------------------------------------------------------
-- 2. Item and run columns; 'hide' joins the category list.
-- ---------------------------------------------------------------------------
ALTER TABLE public.page365_inventory_items
  ADD COLUMN IF NOT EXISTS hide_snapshot   jsonb,
  ADD COLUMN IF NOT EXISTS back_in_page365 boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.page365_inventory_items.hide_snapshot IS
  'category hide only: {variant_id: stock_qty} of every variant of the product at the read. The hide is compare-and-set against it (and status still active).';
COMMENT ON COLUMN public.page365_inventory_items.back_in_page365 IS
  'A matched row whose product the Hub hid (page365_product_presence.hidden_at) and which is still a draft: shown as "Back in Page365 — re-publish?". Never re-published automatically.';
ALTER TABLE public.page365_inventory_items DROP CONSTRAINT page365_inventory_items_category_check;
ALTER TABLE public.page365_inventory_items ADD CONSTRAINT page365_inventory_items_category_check
  CHECK (category IN ('pending','decrease','increase','no_change','excluded','flagged','new','hub_only','not_synced','hide'));

ALTER TABLE public.page365_inventory_runs
  ADD COLUMN IF NOT EXISTS hidden_count     integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hide_notified_at timestamptz;
COMMENT ON COLUMN public.page365_inventory_runs.hidden_count IS
  'Products hidden on the website from this run (automatically by the schedule, or by staff with Apply selected).';

-- ---------------------------------------------------------------------------
-- 3. Backfill "seen" from the complete runs still kept. A product counts as
--    seen only on the code it was matched on.
-- ---------------------------------------------------------------------------
INSERT INTO public.page365_product_presence
  (website_product_id, code, first_seen_at, first_seen_run_id, last_seen_at, last_seen_run_id)
SELECT DISTINCT ON (s.website_product_id)
       s.website_product_id, s.code, s.first_at, s.first_run, s.created_at, s.run_id
  FROM (SELECT i.website_product_id, i.code, r.created_at, r.id AS run_id,
               min(r.created_at) OVER (PARTITION BY i.website_product_id) AS first_at,
               first_value(r.id) OVER (PARTITION BY i.website_product_id ORDER BY r.created_at) AS first_run
          FROM public.page365_inventory_items i
          JOIN public.page365_inventory_runs r ON r.id = i.run_id
          JOIN public.website_products wp ON wp.id = i.website_product_id
         WHERE r.status = 'ready' AND i.kind = 'page365' AND i.match_result = 'matched' AND i.code IS NOT NULL) s
 ORDER BY s.website_product_id, s.created_at DESC
ON CONFLICT (website_product_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. Follow a complete read. Called only from the trigger below, inside
--    page365_inventory_finish's transaction. Writes items and presence only.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_inventory_follow(p_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_run      public.page365_inventory_runs%ROWTYPE;
  v_back     integer := 0;
  v_cleared  integer := 0;
  v_seen     integer := 0;
  v_hide     integer := 0;
BEGIN
  SELECT * INTO v_run FROM public.page365_inventory_runs WHERE id = p_run_id;
  IF NOT FOUND OR v_run.status <> 'ready' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_ready');
  END IF;

  -- (a) Back in Page365: matched again, the Hub hid it, still a draft. Flag
  --     only — never re-published here.
  UPDATE public.page365_inventory_items i
     SET back_in_page365 = true
    FROM public.page365_product_presence pr, public.website_products wp
   WHERE i.run_id = p_run_id AND i.kind = 'page365' AND i.match_result = 'matched'
     AND i.category <> 'not_synced'
     AND pr.website_product_id = i.website_product_id AND pr.hidden_at IS NOT NULL
     AND wp.id = i.website_product_id AND wp.status::text = 'draft';
  GET DIAGNOSTICS v_back = ROW_COUNT;

  -- (b) Seen again and no longer a draft (staff re-published or archived it):
  --     the hide mark no longer describes it.
  UPDATE public.page365_product_presence pr
     SET hidden_at = NULL, hidden_run_id = NULL, hidden_by = NULL, hidden_source = NULL, updated_at = now()
    FROM public.page365_inventory_items i, public.website_products wp
   WHERE i.run_id = p_run_id AND i.kind = 'page365' AND i.match_result = 'matched'
     AND pr.website_product_id = i.website_product_id AND pr.hidden_at IS NOT NULL
     AND wp.id = i.website_product_id AND wp.status::text <> 'draft';
  GET DIAGNOSTICS v_cleared = ROW_COUNT;

  -- (c) Seen: every product matched on its code in this complete read.
  INSERT INTO public.page365_product_presence
    (website_product_id, code, first_seen_at, first_seen_run_id, last_seen_at, last_seen_run_id)
  SELECT DISTINCT ON (i.website_product_id) i.website_product_id, i.code, v_run.created_at, p_run_id, v_run.created_at, p_run_id
    FROM public.page365_inventory_items i
   WHERE i.run_id = p_run_id AND i.kind = 'page365' AND i.match_result = 'matched'
     AND i.website_product_id IS NOT NULL AND i.code IS NOT NULL
   ORDER BY i.website_product_id, i.id
  ON CONFLICT (website_product_id) DO UPDATE
     SET code = EXCLUDED.code, last_seen_at = EXCLUDED.last_seen_at, last_seen_run_id = EXCLUDED.last_seen_run_id,
         updated_at = now()
   WHERE page365_product_presence.last_seen_at <= EXCLUDED.last_seen_at;
  GET DIAGNOSTICS v_seen = ROW_COUNT;

  -- (d) The proposal. A Hub-only row (the code is absent from this complete
  --     read) becomes 'hide' only when ALL hold: missing from 2 complete reads
  --     in a row (finish's missing_runs, which chains over ready runs only);
  --     seen earlier on this very code; still published; not switched off.
  UPDATE public.page365_inventory_items i
     SET category = 'hide', proposed_stock = 0, seen_stock = s.total, hide_snapshot = s.snap
    FROM public.website_products wp
    JOIN public.page365_product_presence pr ON pr.website_product_id = wp.id
    CROSS JOIN LATERAL (
      SELECT coalesce(jsonb_object_agg(v.id::text, v.stock_qty), '{}'::jsonb) AS snap,
             coalesce(sum(v.stock_qty), 0)::integer AS total
        FROM public.website_product_variants v WHERE v.product_id = wp.id) s
   WHERE i.run_id = p_run_id AND i.kind = 'hub_only' AND i.category = 'hub_only'
     AND coalesce(i.missing_runs, 0) >= 2
     AND wp.id = i.website_product_id
     AND wp.status::text = 'active' AND NOT coalesce(wp.page365_sync_disabled, false)
     AND pr.last_seen_at < v_run.created_at
     AND pr.code = public.page365_first_word(wp.sku);
  GET DIAGNOSTICS v_hide = ROW_COUNT;

  RETURN jsonb_build_object('ok', true, 'seen', v_seen, 'hide_proposed', v_hide,
                            'back_in_page365', v_back, 'hide_marks_cleared', v_cleared);
END
$fn$;
REVOKE ALL ON FUNCTION public.page365_inventory_follow(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_inventory_follow(uuid) TO service_role;
COMMENT ON FUNCTION public.page365_inventory_follow(uuid) IS
  'Page365 hide-follow (PR 3b). For a READY run: records products seen (page365_product_presence), flags hidden products back in Page365 (back_in_page365), and turns Hub-only rows missing from 2 complete reads in a row — seen before on the same code, still published, not switched off — into category hide. Never writes stock or product status. Called by trg_page365_inventory_follow.';

CREATE OR REPLACE FUNCTION public.page365_inventory_follow_trg()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
BEGIN
  BEGIN
    PERFORM public.page365_inventory_follow(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    -- Fail safe: the read completes with no hide proposals; say why.
    INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id)
    VALUES ('page365_inventory_run', NEW.id, 'page365_inventory_follow_failed',
            jsonb_build_object('error', left(SQLERRM, 300), 'sqlstate', SQLSTATE), NULL);
  END;
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION public.page365_inventory_follow_trg() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_page365_inventory_follow ON public.page365_inventory_runs;
CREATE TRIGGER trg_page365_inventory_follow
AFTER UPDATE OF status ON public.page365_inventory_runs
FOR EACH ROW WHEN (OLD.status = 'fetching' AND NEW.status = 'ready')
EXECUTE FUNCTION public.page365_inventory_follow_trg();

-- ---------------------------------------------------------------------------
-- 5. The one hide writer. Service role only; called by page365_inventory_hide
--    (staff) and page365_inventory_auto_apply_run (schedule). The caller wraps
--    it in an exception block.
--    Returns {result: hidden | changed_since_fetch | <skip reason>}.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_inventory_hide_item(p_item_id uuid, p_run_id uuid, p_actor uuid, p_source text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_it   public.page365_inventory_items%ROWTYPE;
  v_p    public.website_products%ROWTYPE;
  v_pr   public.page365_product_presence%ROWTYPE;
  v_snap jsonb;
  v_note text;
BEGIN
  IF p_source NOT IN ('manual', 'schedule') THEN RAISE EXCEPTION 'page365_inventory_hide_item: bad source %', p_source; END IF;

  SELECT * INTO v_it FROM public.page365_inventory_items WHERE id = p_item_id AND run_id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'not_in_run'); END IF;
  IF v_it.kind <> 'hub_only' OR v_it.category <> 'hide' THEN RETURN jsonb_build_object('result', 'not_a_hide'); END IF;
  IF v_it.status <> 'review' THEN RETURN jsonb_build_object('result', 'already_' || v_it.status); END IF;

  SELECT * INTO v_p FROM public.website_products WHERE id = v_it.website_product_id FOR UPDATE;
  SELECT * INTO v_pr FROM public.page365_product_presence WHERE website_product_id = v_it.website_product_id;
  v_note := CASE
    WHEN v_p.id IS NULL                                           THEN 'product_gone'
    -- Read LIVE: switched to "Don't sync with Page365" since the read.
    WHEN coalesce(v_p.page365_sync_disabled, false)               THEN 'sync_disabled'
    -- Defence in depth: never a product not seen on this very code.
    WHEN v_pr.website_product_id IS NULL
      OR v_pr.code IS DISTINCT FROM public.page365_first_word(v_p.sku) THEN 'never_seen'
    ELSE NULL END;
  IF v_note IS NOT NULL THEN
    -- The row stays under review; only the note says why.
    UPDATE public.page365_inventory_items SET result_note = v_note WHERE id = v_it.id;
    RETURN jsonb_build_object('result', v_note);
  END IF;

  -- Compare-and-set: still published, and every variant exactly as read.
  PERFORM 1 FROM public.website_product_variants WHERE product_id = v_p.id FOR UPDATE;
  SELECT coalesce(jsonb_object_agg(v.id::text, v.stock_qty), '{}'::jsonb) INTO v_snap
    FROM public.website_product_variants v WHERE v.product_id = v_p.id;
  IF v_p.status::text <> 'active' OR v_snap IS DISTINCT FROM v_it.hide_snapshot THEN
    UPDATE public.page365_inventory_items
       SET status = 'changed_since_fetch',
           result_note = CASE WHEN v_p.status::text <> 'active'
                              THEN 'no longer published; nothing changed'
                              ELSE 'stock changed after the fetch; the next fetch re-checks it' END
     WHERE id = v_it.id;
    RETURN jsonb_build_object('result', 'changed_since_fetch', 'code', v_it.hub_sku);
  END IF;

  UPDATE public.website_product_variants SET stock_qty = 0, updated_at = now()
   WHERE product_id = v_p.id AND stock_qty <> 0;
  UPDATE public.website_products SET status = 'draft' WHERE id = v_p.id;
  UPDATE public.page365_product_presence
     SET hidden_at = now(), hidden_run_id = p_run_id, hidden_by = p_actor, hidden_source = p_source, updated_at = now()
   WHERE website_product_id = v_p.id;
  UPDATE public.page365_inventory_items
     SET status = 'applied', applied_at = now(), applied_by = p_actor,
         result_note = CASE WHEN p_source = 'schedule' THEN 'auto_hidden' ELSE 'hidden' END
   WHERE id = v_it.id;
  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id)
  VALUES ('website_product', v_p.id, 'page365_inventory_hidden',
          jsonb_build_object('status', 'active', 'variant_stock', v_it.hide_snapshot),
          jsonb_build_object('status', 'draft', 'stock_qty', 0, 'sku', v_p.sku, 'run_id', p_run_id, 'item_id', v_it.id,
                             'source', p_source, 'missing_runs', v_it.missing_runs,
                             'last_seen_at', v_pr.last_seen_at, 'last_seen_run_id', v_pr.last_seen_run_id,
                             'reason', 'missing from 2 complete Page365 reads in a row'),
          p_actor);
  RETURN jsonb_build_object('result', 'hidden', 'code', v_p.sku);
END
$fn$;
REVOKE ALL ON FUNCTION public.page365_inventory_hide_item(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_inventory_hide_item(uuid, uuid, uuid, text) TO service_role;
COMMENT ON FUNCTION public.page365_inventory_hide_item(uuid, uuid, uuid, text) IS
  'The ONLY Page365 hide writer (PR 3b). Service role. For a category-hide row still under review: refuses a product switched to "Don''t sync with Page365" (live) or never seen on its current code; compare-and-set (status active and every variant stock = hide_snapshot); then stock 0 on every variant + status draft, presence hidden_at, one audit_logs row (page365_inventory_hidden). Never touches orders, reservations or anything else.';

-- ---------------------------------------------------------------------------
-- 6. Staff: "Apply selected" on the review screen. manage_website_catalog.
--    Same run refusals as page365_inventory_apply. One bell per run.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_inventory_hide(p_run_id uuid, p_item_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid     uuid := auth.uid();
  v_run     public.page365_inventory_runs%ROWTYPE;
  v_id      uuid;
  v_res     jsonb;
  v_r       text;
  v_hidden  uuid[] := ARRAY[]::uuid[];
  v_changed uuid[] := ARRAY[]::uuid[];
  v_skipped jsonb  := '[]'::jsonb;
  v_failed  jsonb  := '[]'::jsonb;
  v_codes   text[] := ARRAY[]::text[];
BEGIN
  IF v_uid IS NULL OR NOT public.has_permission(v_uid, 'manage_website_catalog') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'forbidden');
  END IF;
  IF cardinality(coalesce(p_item_ids, '{}')) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'nothing_selected');
  END IF;

  SELECT * INTO v_run FROM public.page365_inventory_runs WHERE id = p_run_id FOR UPDATE;
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

  FOR v_id IN SELECT DISTINCT x FROM unnest(p_item_ids) x ORDER BY 1 LOOP
    BEGIN
      v_res := public.page365_inventory_hide_item(v_id, p_run_id, v_uid, 'manual');
      v_r := v_res->>'result';
      IF v_r = 'hidden' THEN
        v_hidden := v_hidden || v_id; v_codes := v_codes || coalesce(v_res->>'code', '?');
      ELSIF v_r = 'changed_since_fetch' THEN
        v_changed := v_changed || v_id;
      ELSE
        v_skipped := v_skipped || jsonb_build_object('id', v_id, 'reason', v_r);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.page365_inventory_items SET status = 'failed', result_note = left(SQLERRM, 300)
       WHERE id = v_id AND run_id = p_run_id AND status = 'review';
      v_failed := v_failed || jsonb_build_object('id', v_id, 'reason', left(SQLERRM, 300));
    END;
  END LOOP;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id)
  VALUES ('page365_inventory_run', p_run_id, 'page365_inventory_hide',
          jsonb_build_object('hidden', cardinality(v_hidden), 'changed_since_fetch', cardinality(v_changed),
                             'skipped', jsonb_array_length(v_skipped), 'failed', jsonb_array_length(v_failed),
                             'sent', cardinality(p_item_ids), 'codes', to_jsonb(v_codes[1:50]), 'source', 'manual'),
          v_uid);

  UPDATE public.page365_inventory_runs
     SET hidden_count = hidden_count + cardinality(v_hidden),
         hide_notified_at = CASE WHEN cardinality(v_hidden) > 0 AND hide_notified_at IS NULL THEN now() ELSE hide_notified_at END
   WHERE id = p_run_id;
  -- One bell per run that hid anything (the first Apply that hid something).
  IF cardinality(v_hidden) > 0 AND v_run.hide_notified_at IS NULL THEN
    INSERT INTO public.staff_notifications (type, title, body, metadata)
    VALUES ('page365_inventory_hidden', 'Page365: products hidden on the website',
            cardinality(v_hidden) || ' product(s) no longer on Page365 were hidden on the website (stock 0, unpublished): '
              || array_to_string(v_codes[1:10], ', ') || CASE WHEN cardinality(v_codes) > 10 THEN ' …' ELSE '' END || '.',
            jsonb_build_object('run_id', p_run_id, 'hidden', cardinality(v_hidden), 'codes', to_jsonb(v_codes[1:50]),
                               'source', 'manual'));
  END IF;

  RETURN jsonb_build_object('ok', true,
    'hidden', cardinality(v_hidden), 'changed_since_fetch', cardinality(v_changed),
    'skipped', jsonb_array_length(v_skipped), 'failed', jsonb_array_length(v_failed),
    'hidden_ids', to_jsonb(v_hidden), 'changed_ids', to_jsonb(v_changed),
    'skipped_items', v_skipped, 'failed_items', v_failed);
END
$fn$;
REVOKE ALL ON FUNCTION public.page365_inventory_hide(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.page365_inventory_hide(uuid, uuid[]) TO authenticated;
COMMENT ON FUNCTION public.page365_inventory_hide(uuid, uuid[]) IS
  'Page365 hide-follow, staff path (PR 3b): the ticked "Hide on website" rows of a ready, fresh (< 24 h), not superseded run. manage_website_catalog. Each row through page365_inventory_hide_item (compare-and-set). One audit row per run call; one staff bell per run that hid anything.';

-- ---------------------------------------------------------------------------
-- 7. page365_inventory_auto_apply_run — PR 3 body; PR 3b edits: after the
--    decreases, the 'hide' rows (same gate: switch on, ready, in window, not
--    superseded); hidden counts in the run audit and on the run; the one bell
--    per run says what was hidden when anything was.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_inventory_auto_apply_run(p_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_run     public.page365_inventory_runs%ROWTYPE;
  -- Fail-closed: only JSON true / "true" is on.
  v_on      boolean := coalesce((SELECT s.value #>> '{}' FROM public.system_settings s
                                  WHERE s.key = 'page365_inventory_auto_apply'), 'false') = 'true';
  v_mode    text := CASE WHEN (SELECT s.value #>> '{}' FROM public.system_settings s
                                WHERE s.key = 'page365_stock_mode') = 'invoice'
                         THEN 'invoice' ELSE 'inventory_sync' END;
  v_state   text;
  v_it      public.page365_inventory_items%ROWTYPE;
  v_note    text;
  v_applied integer := 0;
  v_changed integer := 0;
  v_skipped integer := 0;
  v_failed  integer := 0;
  v_codes   text[] := ARRAY[]::text[];
  v_type    text;
  -- PR 3b
  v_hid_id       uuid;
  v_res          jsonb;
  v_hidden       integer := 0;
  v_hide_changed integer := 0;
  v_hide_skipped integer := 0;
  v_hide_failed  integer := 0;
  v_hide_codes   text[] := ARRAY[]::text[];
BEGIN
  SELECT * INTO v_run FROM public.page365_inventory_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'run_not_found'); END IF;
  IF v_run.source <> 'schedule' THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_scheduled'); END IF;
  IF v_run.status = 'fetching' THEN RETURN jsonb_build_object('ok', false, 'reason', 'still_fetching'); END IF;
  IF v_run.auto_apply_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'already', true, 'state', v_run.auto_apply_state, 'applied', v_run.auto_applied,
                              'hidden', v_run.hidden_count);
  END IF;

  v_state := CASE
    WHEN v_run.status <> 'ready'                                THEN 'not_ready'
    WHEN NOT v_on                                               THEN 'off'
    WHEN now() > v_run.created_at + interval '30 minutes'       THEN 'window_passed'
    WHEN EXISTS (SELECT 1 FROM public.page365_inventory_runs r
                  WHERE r.id <> v_run.id AND r.status = 'ready' AND r.created_at > v_run.created_at) THEN 'superseded'
    ELSE 'applied' END;

  IF v_state = 'applied' THEN
    FOR v_it IN
      SELECT i.* FROM public.page365_inventory_items i
       WHERE i.run_id = p_run_id AND i.kind = 'page365' AND i.match_result = 'matched'
         AND i.category = 'decrease' AND i.status = 'review'
       ORDER BY i.id
       FOR UPDATE
    LOOP
      v_note := CASE
        WHEN v_it.variant_id IS NULL OR v_it.seen_stock IS NULL OR v_it.proposed_stock IS NULL THEN 'not_a_stock_change'
        WHEN EXISTS (SELECT 1 FROM public.website_product_variants wv
                       JOIN public.website_products wp ON wp.id = wv.product_id
                      WHERE wv.id = v_it.variant_id AND wp.page365_sync_disabled)             THEN 'sync_disabled'
        WHEN v_it.proposed_stock < 0 OR v_it.proposed_stock >= v_it.seen_stock                 THEN 'not_a_decrease'
        WHEN v_mode = 'invoice' AND EXISTS (SELECT 1 FROM public.page365_stock_lines l
                                             WHERE l.variant_id = v_it.variant_id AND l.stock_state = 'held') THEN 'invoice_hold'
        ELSE NULL END;
      IF v_note IS NOT NULL THEN
        -- The row stays under review for staff; only the note says why.
        UPDATE public.page365_inventory_items SET result_note = v_note WHERE id = v_it.id;
        v_skipped := v_skipped + 1;
        CONTINUE;
      END IF;

      BEGIN
        -- Compare-and-set, and a decrease only: a website sale since the fetch
        -- (stock moved) is skipped, never overwritten.
        UPDATE public.website_product_variants
           SET stock_qty = v_it.proposed_stock, updated_at = now()
         WHERE id = v_it.variant_id AND stock_qty = v_it.seen_stock AND stock_qty > v_it.proposed_stock;
        IF FOUND THEN
          UPDATE public.page365_inventory_items
             SET status = 'applied', applied_at = now(), applied_by = NULL, result_note = 'auto_applied'
           WHERE id = v_it.id;
          INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id)
          VALUES ('website_product_variant', v_it.variant_id, 'page365_inventory_auto_applied',
                  jsonb_build_object('stock_qty', v_it.seen_stock),
                  jsonb_build_object('stock_qty', v_it.proposed_stock, 'run_id', p_run_id, 'item_id', v_it.id,
                                     'code', v_it.code, 'direction', 'decrease', 'source', 'schedule',
                                     'page365_available', v_it.page365_available, 'web_holds', v_it.web_holds,
                                     'invoice_holds', v_it.invoice_holds, 'mode', v_mode),
                  NULL);
          v_applied := v_applied + 1;
          v_codes := v_codes || coalesce(v_it.code, '?');
        ELSE
          UPDATE public.page365_inventory_items
             SET status = 'changed_since_fetch', result_note = 'stock changed after the fetch; the next fetch re-checks it'
           WHERE id = v_it.id;
          v_changed := v_changed + 1;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        UPDATE public.page365_inventory_items SET status = 'failed', result_note = left(SQLERRM, 300) WHERE id = v_it.id;
        v_failed := v_failed + 1;
      END;
    END LOOP;

    -- PR 3b: products gone from 2 complete reads in a row — stock 0 and
    -- unpublished, each through the one hide writer (compare-and-set).
    FOR v_hid_id IN
      SELECT i.id FROM public.page365_inventory_items i
       WHERE i.run_id = p_run_id AND i.kind = 'hub_only' AND i.category = 'hide' AND i.status = 'review'
       ORDER BY i.id
    LOOP
      BEGIN
        v_res := public.page365_inventory_hide_item(v_hid_id, p_run_id, NULL, 'schedule');
        IF v_res->>'result' = 'hidden' THEN
          v_hidden := v_hidden + 1;
          v_hide_codes := v_hide_codes || coalesce(v_res->>'code', '?');
        ELSIF v_res->>'result' = 'changed_since_fetch' THEN
          v_hide_changed := v_hide_changed + 1;
        ELSE
          v_hide_skipped := v_hide_skipped + 1;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        UPDATE public.page365_inventory_items SET status = 'failed', result_note = left(SQLERRM, 300) WHERE id = v_hid_id;
        v_hide_failed := v_hide_failed + 1;
      END;
    END LOOP;
  END IF;

  -- One audit row per run whenever the switch was on (what was attempted and
  -- why not, if nothing was).
  IF v_on THEN
    INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id)
    VALUES ('page365_inventory_run', p_run_id, 'page365_inventory_auto_apply',
            jsonb_build_object('state', v_state, 'run_status', v_run.status, 'applied', v_applied,
                               'changed_since_fetch', v_changed, 'skipped', v_skipped, 'failed', v_failed,
                               'hidden', v_hidden, 'hide_changed_since_fetch', v_hide_changed,
                               'hide_skipped', v_hide_skipped, 'hide_failed', v_hide_failed,
                               'hidden_codes', to_jsonb(v_hide_codes[1:50]),
                               'mode', v_mode, 'source', 'schedule'),
            NULL);
  END IF;

  v_type := CASE WHEN v_run.status IN ('partial', 'failed') THEN 'page365_inventory_run_failed'
                 WHEN v_hidden > 0                          THEN 'page365_inventory_hidden'
                 WHEN v_applied > 0                         THEN 'page365_inventory_auto_applied' END;

  UPDATE public.page365_inventory_runs
     SET auto_apply_state = v_state, auto_applied = v_applied, auto_apply_changed = v_changed,
         auto_apply_skipped = v_skipped + v_failed, auto_apply_at = now(),
         hidden_count = hidden_count + v_hidden,
         hide_notified_at = CASE WHEN v_hidden > 0 THEN now() ELSE hide_notified_at END,
         notified_at = CASE WHEN v_type IS NOT NULL THEN now() ELSE notified_at END
   WHERE id = p_run_id;

  -- At most one bell per run (auto_apply_at makes this block run once).
  IF v_type = 'page365_inventory_run_failed' THEN
    INSERT INTO public.staff_notifications (type, title, body, metadata)
    VALUES (v_type, 'Scheduled Page365 fetch did not complete',
            'The ' || to_char(v_run.created_at AT TIME ZONE 'Asia/Manila', 'HH24:MI') || ' PHT scheduled read was '
              || v_run.status || coalesce(' (' || v_run.error || ')', '') || '. Nothing was applied; the next scheduled fetch tries again.',
            jsonb_build_object('run_id', p_run_id, 'status', v_run.status, 'error', v_run.error));
  ELSIF v_type = 'page365_inventory_hidden' THEN
    INSERT INTO public.staff_notifications (type, title, body, metadata)
    VALUES (v_type, 'Page365: products hidden on the website',
            v_hidden || ' product(s) no longer on Page365 were hidden on the website automatically (stock 0, unpublished) by the '
              || to_char(v_run.created_at AT TIME ZONE 'Asia/Manila', 'HH24:MI') || ' PHT scheduled fetch: '
              || array_to_string(v_hide_codes[1:10], ', ') || CASE WHEN cardinality(v_hide_codes) > 10 THEN ' …' ELSE '' END || '.'
              || CASE WHEN v_applied > 0 THEN ' ' || v_applied || ' stock decrease(s) were also applied.' ELSE '' END,
            jsonb_build_object('run_id', p_run_id, 'hidden', v_hidden, 'codes', to_jsonb(v_hide_codes[1:50]),
                               'applied', v_applied, 'applied_codes', to_jsonb(v_codes[1:50]), 'source', 'schedule'));
  ELSIF v_type = 'page365_inventory_auto_applied' THEN
    INSERT INTO public.staff_notifications (type, title, body, metadata)
    VALUES (v_type, 'Page365 decreases applied automatically',
            v_applied || ' website stock decrease(s) applied from the ' || to_char(v_run.created_at AT TIME ZONE 'Asia/Manila', 'HH24:MI')
              || ' PHT scheduled Page365 fetch: ' || array_to_string(v_codes[1:10], ', ')
              || CASE WHEN cardinality(v_codes) > 10 THEN ' …' ELSE '' END || '.',
            jsonb_build_object('run_id', p_run_id, 'applied', v_applied, 'codes', to_jsonb(v_codes[1:50])));
  END IF;

  RETURN jsonb_build_object('ok', true, 'state', v_state, 'applied', v_applied, 'changed_since_fetch', v_changed,
                            'skipped', v_skipped, 'failed', v_failed, 'hidden', v_hidden,
                            'hide_changed_since_fetch', v_hide_changed, 'hide_skipped', v_hide_skipped,
                            'hide_failed', v_hide_failed, 'notified', v_type);
END
$fn$;
REVOKE ALL ON FUNCTION public.page365_inventory_auto_apply_run(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_inventory_auto_apply_run(uuid) TO service_role;
COMMENT ON FUNCTION public.page365_inventory_auto_apply_run(uuid) IS
  'The ONLY automatic Page365 stock writer (PR 3; hides PR 3b). Service role. Closes a SCHEDULED run once: applies its decrease rows (compare-and-set, never an increase, never a switched-off product) and its hide rows (page365_inventory_hide_item: stock 0 + unpublish, compare-and-set) only when system_settings.page365_inventory_auto_apply is true, the read was ready, the run is inside its 30-minute window and not superseded. Never re-publishes. Audits per row and per run; at most one staff bell per run.';
COMMENT ON COLUMN public.page365_inventory_runs.auto_apply_state IS
  'Scheduled runs only (NULL on manual runs and before the run ends). applied = the switch was on and every eligible decrease AND hide was attempted (see auto_applied, hidden_count); off = the switch was off, nothing applied; not_ready = the read was partial or failed, nothing applied; window_passed = the run ended more than 30 minutes after it began, nothing applied; superseded = a newer ready run existed, nothing applied. Written once, by page365_inventory_auto_apply_run.';

-- ---------------------------------------------------------------------------
-- 8. Self-check, still inside the transaction. Pure reads; any failure aborts
--    the whole file with nothing changed.
-- ---------------------------------------------------------------------------
DO $self$
DECLARE
  v_fn  text;
  v_got text;
  r     record;
BEGIN
  -- Nothing on the website moved, and the switch did not move.
  IF (SELECT md5(coalesce(string_agg(wp.id::text || ':' || wp.status::text, ',' ORDER BY wp.id), '')) FROM public.website_products wp)
     || (SELECT md5(coalesce(string_agg(v.id::text || ':' || v.stock_qty, ',' ORDER BY v.id), '')) FROM public.website_product_variants v)
     IS DISTINCT FROM current_setting('page365.hide_catalog_before', true) THEN
    RAISE EXCEPTION 'page365_hide_follow self-check: a product status or stock changed during this file';
  END IF;
  IF coalesce((SELECT value #>> '{}' FROM public.system_settings WHERE key = 'page365_inventory_auto_apply'), 'absent')
     IS DISTINCT FROM current_setting('page365.hide_switch_before', true) THEN
    RAISE EXCEPTION 'page365_hide_follow self-check: the auto-apply switch changed during this file';
  END IF;

  -- Bodies: the relied-on ones unchanged, the replaced one exactly as written.
  FOR r IN
    SELECT * FROM (VALUES
      ('page365_inventory_finish(uuid)',              '9d0be9494288800686e2d6a90edb3304'),
      ('page365_inventory_apply(uuid,uuid[],uuid[])', 'e65757c2f32b597b2a55047d77783df3'),
      ('page365_inventory_retention(integer)',        '9dc2d413a9b146ebc09778c854dad187'),
      ('website_publish_products(uuid[])',            '72db495e4e9123f159b5b72ed629c0cd'),
      ('page365_inventory_auto_apply_run(uuid)',      '21eb560506fc8727076d715dd9e1bc97')
    ) AS t(fn, want)
  LOOP
    SELECT md5(p.prosrc) INTO v_got FROM pg_proc p WHERE p.oid = to_regprocedure('public.' || r.fn);
    IF v_got IS DISTINCT FROM r.want THEN
      RAISE EXCEPTION 'page365_hide_follow self-check: % body md5 %, expected %', r.fn, v_got, r.want;
    END IF;
  END LOOP;

  -- Browser roles reach only page365_inventory_hide.
  FOREACH v_fn IN ARRAY ARRAY[
    'public.page365_inventory_follow(uuid)', 'public.page365_inventory_follow_trg()',
    'public.page365_inventory_hide_item(uuid,uuid,uuid,text)', 'public.page365_inventory_auto_apply_run(uuid)'] LOOP
    IF has_function_privilege('authenticated', v_fn, 'EXECUTE') OR has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'page365_hide_follow self-check: % is callable by a browser role', v_fn;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'public.page365_inventory_hide(uuid,uuid[])', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.page365_inventory_hide(uuid,uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'page365_hide_follow self-check: page365_inventory_hide grants are wrong';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.page365_inventory_auto_apply_run(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'page365_hide_follow self-check: service_role cannot run page365_inventory_auto_apply_run';
  END IF;
  IF has_table_privilege('authenticated', 'public.page365_product_presence', 'INSERT')
     OR has_table_privilege('authenticated', 'public.page365_product_presence', 'UPDATE')
     OR has_table_privilege('anon', 'public.page365_product_presence', 'SELECT') THEN
    RAISE EXCEPTION 'page365_hide_follow self-check: a browser role can write page365_product_presence (or anon can read it)';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname = 'trg_page365_inventory_follow'
                    AND t.tgrelid = 'public.page365_inventory_runs'::regclass) THEN
    RAISE EXCEPTION 'page365_hide_follow self-check: trigger trg_page365_inventory_follow missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k
                  WHERE k.conrelid = 'public.page365_inventory_items'::regclass
                    AND k.conname = 'page365_inventory_items_category_check'
                    AND pg_get_constraintdef(k.oid) LIKE '%''hide''%') THEN
    RAISE EXCEPTION 'page365_hide_follow self-check: category CHECK does not allow hide';
  END IF;
  -- The backfill (rows written by this transaction) only recorded products
  -- matched in complete runs.
  IF EXISTS (SELECT 1 FROM public.page365_product_presence pr
              WHERE pr.updated_at = now() AND NOT EXISTS (SELECT 1 FROM public.page365_inventory_items i
                                  JOIN public.page365_inventory_runs ru ON ru.id = i.run_id AND ru.status = 'ready'
                                 WHERE i.website_product_id = pr.website_product_id AND i.match_result = 'matched')) THEN
    RAISE EXCEPTION 'page365_hide_follow self-check: a presence row has no complete-run match behind it';
  END IF;
END
$self$;

COMMIT;

-- ===========================================================================
-- Verification (read-only). Run after COMMIT.
--
-- (1) Objects and the switch; expect: <unchanged, false unless the owner turned it on> | t | t | t | t
-- SELECT (SELECT value #>> '{}' FROM public.system_settings WHERE key = 'page365_inventory_auto_apply') AS auto_apply,
--        to_regclass('public.page365_product_presence') IS NOT NULL                                     AS presence,
--        EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_page365_inventory_follow')               AS follow_trigger,
--        to_regprocedure('public.page365_inventory_hide(uuid,uuid[])') IS NOT NULL                       AS hide_rpc,
--        (SELECT pg_get_constraintdef(oid) LIKE '%''hide''%' FROM pg_constraint
--          WHERE conname = 'page365_inventory_items_category_check')                                     AS hide_category;
--
-- (2) Bodies; expect exactly:
--     page365_inventory_apply e65757c2f32b597b2a55047d77783df3 · page365_inventory_auto_apply_run 21eb560506fc8727076d715dd9e1bc97 ·
--     page365_inventory_finish 9d0be9494288800686e2d6a90edb3304 · page365_inventory_retention 9dc2d413a9b146ebc09778c854dad187 ·
--     website_publish_products 72db495e4e9123f159b5b72ed629c0cd
-- SELECT proname, md5(prosrc) FROM pg_proc
--  WHERE proname IN ('page365_inventory_apply','page365_inventory_auto_apply_run','page365_inventory_finish',
--                    'page365_inventory_retention','website_publish_products')
--  ORDER BY 1;
--
-- (3) Browser roles; expect: f | f | f | t
-- SELECT has_function_privilege('authenticated','public.page365_inventory_hide_item(uuid,uuid,uuid,text)','EXECUTE') AS auth_hide_item,
--        has_function_privilege('authenticated','public.page365_inventory_follow(uuid)','EXECUTE')                   AS auth_follow,
--        has_function_privilege('authenticated','public.page365_inventory_auto_apply_run(uuid)','EXECUTE')          AS auth_auto,
--        has_function_privilege('authenticated','public.page365_inventory_hide(uuid,uuid[])','EXECUTE')             AS auth_hide;
--
-- (4) The backfill; expect seen_products = the number of distinct Hub products matched in the kept
--     complete runs (the two numbers equal), hidden = 0.
-- SELECT (SELECT count(*) FROM public.page365_product_presence)                         AS seen_products,
--        (SELECT count(DISTINCT i.website_product_id) FROM public.page365_inventory_items i
--           JOIN public.page365_inventory_runs r ON r.id = i.run_id
--          WHERE r.status = 'ready' AND i.kind = 'page365' AND i.match_result = 'matched'
--            AND i.code IS NOT NULL)                                                      AS matched_in_kept_runs,
--        (SELECT count(*) FROM public.page365_product_presence WHERE hidden_at IS NOT NULL) AS hidden;
--
-- (5) PREVIEW — what the NEXT complete read would propose to hide, if Page365 still lacks them
--     (read-only; nothing is proposed until that read). Expect only pieces you know Page365
--     hid; a Hub-only product never appears here; N4020 must NOT appear.
-- SELECT wp.sku, wp.name, pr.last_seen_at, i.missing_runs AS missing_in_latest_ready_run
--   FROM public.page365_inventory_items i
--   JOIN public.page365_inventory_runs r ON r.id = i.run_id
--   JOIN public.website_products wp ON wp.id = i.website_product_id
--   JOIN public.page365_product_presence pr ON pr.website_product_id = wp.id
--  WHERE r.id = (SELECT id FROM public.page365_inventory_runs WHERE status = 'ready' ORDER BY created_at DESC LIMIT 1)
--    AND i.kind = 'hub_only' AND i.category = 'hub_only' AND coalesce(i.missing_runs, 0) >= 1
--    AND wp.status::text = 'active' AND NOT wp.page365_sync_disabled
--    AND pr.code = public.page365_first_word(wp.sku)
--  ORDER BY wp.sku;
--
-- (6) Nothing was hidden or unpublished by this file; expect 0 | 0
-- SELECT (SELECT count(*) FROM public.audit_logs WHERE action = 'page365_inventory_hidden') AS hide_audits,
--        (SELECT count(*) FROM public.page365_inventory_items WHERE category = 'hide')      AS hide_rows;
--
-- (7) After the next complete read (scheduled within 30 min): hide proposals, if any, and no
--     follow failure; expect follow_failed = 0.
-- SELECT r.created_at, r.source, r.status, r.hidden_count,
--        (SELECT count(*) FROM public.page365_inventory_items i WHERE i.run_id = r.id AND i.category = 'hide') AS hide_rows,
--        (SELECT count(*) FROM public.page365_inventory_items i WHERE i.run_id = r.id AND i.back_in_page365)   AS back_in_page365,
--        (SELECT count(*) FROM public.audit_logs a WHERE a.entity_id = r.id AND a.action = 'page365_inventory_follow_failed') AS follow_failed
--   FROM public.page365_inventory_runs r ORDER BY r.created_at DESC LIMIT 5;
-- ===========================================================================

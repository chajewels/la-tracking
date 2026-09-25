-- ===========================================================================
-- page365_inventory_pr2 — Page365 is the stock master (PR 2 of 4).
--
-- OWNER RUNS THIS in the SQL Editor, as-is, after the release PR is on main.
-- One transaction. Plan: ~/Code/reference/page365-inventory-fetch-investigation.md
-- §4 (owner-approved), plus the owner's 2026-09-25 "Don't sync with Page365"
-- switch. What it does:
--
--   A. SWITCH. website_products.page365_sync_disabled (default false). A product
--      switched on is ALWAYS skipped by the inventory fetch: its rows land in
--      the 'not_synced' category, are never proposed, never applied
--      (page365_inventory_apply refuses 'sync_disabled', reading the switch
--      LIVE, so flipping it after a fetch still protects the product), and its
--      photos are never copied (page365_inventory_record_photo refuses too).
--      An invoice import never moves its stock either (record the match only).
--      Only a user with manage_website_catalog may flip it; every flip is
--      audited. Nothing is switched on here (N4020 is the owner's to switch).
--
--   B. INVOICE IMPORT BECOMES RECORD-ONLY. system_settings.page365_stock_mode =
--      'inventory_sync' (seeded; 'invoice' = the #195 behaviour, the rollback).
--      page365_apply_stock still claims every line, matches it and raises the
--      same flags, but in 'inventory_sync' it NEVER changes website stock: a
--      matched line is recorded with stock_state 'page365_master'.
--      Cut-over, same transaction: every 'held' line becomes 'absorbed' (the
--      piece it took is now inside Page365's own number). page365_stock_follow_
--      order only ever acts on 'held' (give back) and 'released' (take again),
--      so cancelling, expiring, forfeiting or deleting an order whose lines are
--      'absorbed' or 'page365_master' returns NOTHING. Its body is unchanged;
--      section 0 proves the live body is still the #195 one this relies on.
--
--   C. THE FETCH NO LONGER EXCLUDES INVOICE HOLDS (in 'inventory_sync'). In
--      'invoice' mode the PR 1 exclusion comes back exactly as it was.
--
--   D. UNPAID PAGE365 INVOICES — SAFE EITHER WAY. It is not yet confirmed
--      whether an UNPAID Page365 invoice already lowers Page365's `available`.
--      Until the owner's test settles it, the fetch also subtracts pieces on
--      imported Page365 invoices whose Hub order is still live and unpaid
--      (page365_invoice_holds; setting page365_hold_unpaid_invoices, seeded
--      true). If Page365 does NOT count unpaid invoices, this keeps the piece off
--      the website. If it DOES, the piece is subtracted twice while unpaid: a
--      one-of-a-kind piece reads 0 either way, and a multi-piece listing shows
--      one too few until the order is paid. Never an oversell. The owner sets
--      the key to false once the test shows Page365 counts unpaid invoices.
--
-- FUNCTION CHANGES START FROM LIVE (CLAUDE.md, Bug #280). The four functions
-- redefined here are the #195 / PR 1 bodies with the edits marked "PR 2".
-- Section 0 refuses to run unless each live body (pg_proc.prosrc — the body is
-- stored verbatim, the comparator scripts/function-drift-audit uses) md5-matches
-- the body in 20260926120000 / 20260927100000, or already matches this file's
-- (a re-run). Section 9 proves each new body landed exactly as written.
--
--   function                          before (prosrc md5, chars)                after
--   page365_apply_stock               4e94908c535e2bdaccfcad0eaf509098  8563    see section 9
--   page365_inventory_finish          725c035cb7785957c6e72c5c4fcc8ece  6938    see section 9
--   page365_inventory_apply           57c3077bc1cdc43b9d8f13114be73b18  5342    see section 9
--   page365_inventory_record_photo    9ae3317140d44dae7f626996bb8c63c7  3326    see section 9
--   page365_stock_follow_order        dfd6d211808c5e6a7758b3d0fd7dafd9  4813    UNCHANGED (asserted)
--
-- Guards: every dependency is checked first; the whole transaction aborts with
-- NOTHING changed if live is not what this was written against. Re-running the
-- file is safe: IF NOT EXISTS / CREATE OR REPLACE, the settings are seeded only
-- when absent (a re-run never flips the owner's choice back), and the cut-over
-- only touches lines still 'held' while the mode is 'inventory_sync'.
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
  v_bad     text := '';
  r         record;
BEGIN
  IF to_regclass('public.website_products')         IS NULL THEN v_missing := v_missing || 'website_products'::text; END IF;
  IF to_regclass('public.website_product_variants') IS NULL THEN v_missing := v_missing || 'website_product_variants'::text; END IF;
  IF to_regclass('public.website_product_media')    IS NULL THEN v_missing := v_missing || 'website_product_media'::text; END IF;
  IF to_regclass('public.cash_orders')              IS NULL THEN v_missing := v_missing || 'cash_orders'::text; END IF;
  IF to_regclass('public.layaway_accounts')         IS NULL THEN v_missing := v_missing || 'layaway_accounts'::text; END IF;
  IF to_regclass('public.page365_drafts')           IS NULL THEN v_missing := v_missing || 'page365_drafts'::text; END IF;
  IF to_regclass('public.page365_stock_lines')      IS NULL THEN v_missing := v_missing || 'page365_stock_lines (#195: run 20260926120000 first)'::text; END IF;
  IF to_regclass('public.page365_inventory_runs')   IS NULL THEN v_missing := v_missing || 'page365_inventory_runs (PR 1: run 20260927100000 first)'::text; END IF;
  IF to_regclass('public.page365_inventory_items')  IS NULL THEN v_missing := v_missing || 'page365_inventory_items (PR 1: run 20260927100000 first)'::text; END IF;
  IF to_regclass('public.staff_notifications')      IS NULL THEN v_missing := v_missing || 'staff_notifications'::text; END IF;
  IF to_regclass('public.audit_logs')               IS NULL THEN v_missing := v_missing || 'audit_logs'::text; END IF;
  IF to_regclass('public.system_settings')          IS NULL THEN v_missing := v_missing || 'system_settings'::text; END IF;
  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'page365_inventory_pr2: missing table(s): %', array_to_string(v_missing, ', ');
  END IF;

  SELECT array_agg(c.table_name || '.' || c.column_name) INTO v_cols
    FROM (VALUES
      ('website_products','id'), ('website_products','sku'), ('website_products','status'),
      ('website_product_variants','id'), ('website_product_variants','product_id'), ('website_product_variants','stock_qty'),
      ('cash_orders','id'), ('cash_orders','status'),
      ('layaway_accounts','id'), ('layaway_accounts','status'), ('layaway_accounts','total_paid'),
      ('page365_stock_lines','id'), ('page365_stock_lines','stock_state'), ('page365_stock_lines','variant_id'),
      ('page365_stock_lines','quantity'), ('page365_stock_lines','cash_order_id'), ('page365_stock_lines','account_id'),
      ('page365_stock_lines','page365_no'), ('page365_stock_lines','line_no'), ('page365_stock_lines','updated_at'),
      ('page365_inventory_items','category'), ('page365_inventory_items','invoice_holds'),
      ('page365_inventory_items','website_product_id'), ('page365_inventory_items','variant_id'),
      ('audit_logs','entity_type'), ('audit_logs','entity_id'), ('audit_logs','action'),
      ('audit_logs','old_value_json'), ('audit_logs','new_value_json'), ('audit_logs','performed_by_user_id'),
      ('system_settings','key'), ('system_settings','value')
    ) AS c(table_name, column_name)
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns ic
      WHERE ic.table_schema = 'public' AND ic.table_name = c.table_name AND ic.column_name = c.column_name);
  IF v_cols IS NOT NULL THEN
    RAISE EXCEPTION 'page365_inventory_pr2: missing column(s): %', array_to_string(v_cols, ', ');
  END IF;

  IF to_regprocedure('public.has_permission(uuid,text)') IS NULL
     OR to_regprocedure('public.page365_match_line(text)') IS NULL
     OR to_regprocedure('public.page365_web_holds(uuid)') IS NULL THEN
    RAISE EXCEPTION 'page365_inventory_pr2: has_permission / page365_match_line / page365_web_holds missing';
  END IF;

  -- The live bodies this file starts from (Bug #280). Each must be the body
  -- written by #195 / PR 1, or this file's own body (a re-run).
  FOR r IN
    SELECT * FROM (VALUES
      ('page365_apply_stock',            'p_order_kind text, p_order_id uuid, p_draft_id uuid, p_service_line_nos integer[], p_actor uuid',
         '4e94908c535e2bdaccfcad0eaf509098', '065eb0bf19e3b86532efd4b5bf224955'),
      ('page365_inventory_finish',       'p_run_id uuid',
         '725c035cb7785957c6e72c5c4fcc8ece', '9d0be9494288800686e2d6a90edb3304'),
      ('page365_inventory_apply',        'p_run_id uuid, p_decrease_ids uuid[], p_increase_ids uuid[]',
         '57c3077bc1cdc43b9d8f13114be73b18', 'e65757c2f32b597b2a55047d77783df3'),
      ('page365_inventory_record_photo', 'p_item_id uuid, p_photo_id bigint, p_version text, p_url text, p_source_url text, p_index integer, p_actor uuid',
         '9ae3317140d44dae7f626996bb8c63c7', 'c8f94536cf40167fe43a24967a6eefe9'),
      ('page365_stock_follow_order',     '',
         'dfd6d211808c5e6a7758b3d0fd7dafd9', 'dfd6d211808c5e6a7758b3d0fd7dafd9')
    ) AS t(fn, args, before_md5, after_md5)
  LOOP
    SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = r.fn;
    IF v_n <> 1 THEN
      v_bad := v_bad || format(E'\n  %s: expected exactly 1 definition, found %s', r.fn, v_n);
      CONTINUE;
    END IF;
    SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = r.fn
       AND pg_get_function_identity_arguments(p.oid) = r.args
       AND p.prosecdef
       AND md5(p.prosrc) IN (r.before_md5, r.after_md5);
    IF v_n <> 1 THEN
      SELECT v_bad || format(E'\n  %s: live body md5 %s (%s chars), signature (%s), security definer %s — expected md5 %s (or %s after a re-run)',
                             r.fn, md5(p.prosrc), length(p.prosrc), pg_get_function_identity_arguments(p.oid), p.prosecdef,
                             r.before_md5, r.after_md5)
        INTO v_bad
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = r.fn;
    END IF;
  END LOOP;
  IF v_bad <> '' THEN
    RAISE EXCEPTION 'STOP — page365_inventory_pr2: live is not what this file was written against. Nothing was modified.%', v_bad;
  END IF;

  -- The #195 ledger CHECK this widens, and the PR 1 category CHECK.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k
                  WHERE k.conrelid = 'public.page365_stock_lines'::regclass AND k.contype = 'c'
                    AND pg_get_constraintdef(k.oid) ILIKE '%stock_state%'
                    AND pg_get_constraintdef(k.oid) ILIKE '%held%' AND pg_get_constraintdef(k.oid) ILIKE '%released%') THEN
    RAISE EXCEPTION 'page365_inventory_pr2: page365_stock_lines has no stock_state CHECK with held/released';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k
                  WHERE k.conrelid = 'public.page365_inventory_items'::regclass AND k.contype = 'c'
                    AND pg_get_constraintdef(k.oid) ILIKE '%category%' AND pg_get_constraintdef(k.oid) ILIKE '%excluded%') THEN
    RAISE EXCEPTION 'page365_inventory_pr2: page365_inventory_items has no category CHECK';
  END IF;

  -- Name collisions.
  SELECT count(*) INTO v_n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'website_products' AND column_name = 'page365_sync_disabled'
     AND data_type <> 'boolean';
  IF v_n > 0 THEN
    RAISE EXCEPTION 'page365_inventory_pr2: website_products.page365_sync_disabled exists with a different type';
  END IF;
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND ((p.proname = 'page365_invoice_holds'      AND pg_get_function_identity_arguments(p.oid) <> 'p_variant_id uuid')
       OR (p.proname = 'page365_sync_switch_guard'  AND pg_get_function_identity_arguments(p.oid) <> ''));
  IF v_n > 0 THEN
    RAISE EXCEPTION 'page365_inventory_pr2: page365_invoice_holds / page365_sync_switch_guard exists with a different signature';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger t
              WHERE NOT t.tgisinternal AND t.tgname = 'trg_page365_sync_switch'
                AND t.tgfoid IS DISTINCT FROM to_regprocedure('public.page365_sync_switch_guard()')) THEN
    RAISE EXCEPTION 'page365_inventory_pr2: a trg_page365_sync_switch trigger already points elsewhere';
  END IF;

  -- Settings, if already there, must hold values this file understands.
  IF EXISTS (SELECT 1 FROM public.system_settings WHERE key = 'page365_stock_mode'
                AND (value #>> '{}') NOT IN ('invoice', 'inventory_sync')) THEN
    RAISE EXCEPTION 'page365_inventory_pr2: system_settings.page365_stock_mode holds an unknown value';
  END IF;
  IF EXISTS (SELECT 1 FROM public.system_settings WHERE key = 'page365_hold_unpaid_invoices'
                AND (value #>> '{}') NOT IN ('true', 'false')) THEN
    RAISE EXCEPTION 'page365_inventory_pr2: system_settings.page365_hold_unpaid_invoices is not true/false';
  END IF;

  SELECT count(*) INTO v_n FROM public.page365_stock_lines WHERE stock_state = 'held';
  RAISE NOTICE 'page365_inventory_pr2: % held #195 line(s) found (absorbed below only while page365_stock_mode is inventory_sync)', v_n;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. The switch. Default OFF: every product keeps syncing until staff say no.
-- ---------------------------------------------------------------------------
ALTER TABLE public.website_products
  ADD COLUMN IF NOT EXISTS page365_sync_disabled boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.website_products.page365_sync_disabled IS
  'Don''t sync with Page365 (2026-09-28). true = the Page365 inventory fetch always skips this product (review category not_synced; never proposed, never applied, photos never copied) and a Page365 invoice import never moves its stock (the match is still recorded). Only manage_website_catalog may change it (trg_page365_sync_switch); every change is audited.';

-- Only catalogue staff may flip it (any staff can write website_products under
-- RLS), and every flip leaves an audit row. The service role (no auth.uid())
-- is not gated.
CREATE OR REPLACE FUNCTION public.page365_sync_switch_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.page365_sync_disabled IS NOT DISTINCT FROM OLD.page365_sync_disabled THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' AND NOT coalesce(NEW.page365_sync_disabled, false) THEN RETURN NEW; END IF;
  IF v_uid IS NOT NULL AND NOT public.has_permission(v_uid, 'manage_website_catalog') THEN
    RAISE EXCEPTION 'Only Website catalog staff can change "Don''t sync with Page365".' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id)
  VALUES ('website_product', NEW.id, 'page365_sync_switched',
          CASE WHEN TG_OP = 'UPDATE' THEN jsonb_build_object('page365_sync_disabled', OLD.page365_sync_disabled) END,
          jsonb_build_object('page365_sync_disabled', NEW.page365_sync_disabled, 'sku', NEW.sku),
          v_uid);
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.page365_sync_switch_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_page365_sync_switch ON public.website_products;
CREATE TRIGGER trg_page365_sync_switch
  BEFORE INSERT OR UPDATE OF page365_sync_disabled ON public.website_products
  FOR EACH ROW EXECUTE FUNCTION public.page365_sync_switch_guard();

-- ---------------------------------------------------------------------------
-- 2. Ledger states. page365_master = recorded while Page365 is the stock
--    master (no stock moved); absorbed = held under #195, now inside Page365's
--    number. The follow trigger returns nothing for either.
-- ---------------------------------------------------------------------------
DO $chk$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT k.conname FROM pg_constraint k
            WHERE k.conrelid = 'public.page365_stock_lines'::regclass AND k.contype = 'c'
              AND pg_get_constraintdef(k.oid) ILIKE '%stock_state%'
  LOOP
    EXECUTE format('ALTER TABLE public.page365_stock_lines DROP CONSTRAINT %I', r.conname);
  END LOOP;
  FOR r IN SELECT k.conname FROM pg_constraint k
            WHERE k.conrelid = 'public.page365_inventory_items'::regclass AND k.contype = 'c'
              AND pg_get_constraintdef(k.oid) ILIKE '%category%'
  LOOP
    EXECUTE format('ALTER TABLE public.page365_inventory_items DROP CONSTRAINT %I', r.conname);
  END LOOP;
END
$chk$;
ALTER TABLE public.page365_stock_lines ADD CONSTRAINT page365_stock_lines_stock_state_check
  CHECK (stock_state IN ('none','held','released','page365_master','absorbed'));
ALTER TABLE public.page365_inventory_items ADD CONSTRAINT page365_inventory_items_category_check
  CHECK (category IN ('pending','decrease','increase','no_change','excluded','flagged','new','hub_only','not_synced'));
COMMENT ON COLUMN public.page365_stock_lines.stock_state IS
  'none = no stock moved; held = the Hub took website stock (#195, mode invoice); released = given back; page365_master = matched and recorded while Page365 is the stock master (mode inventory_sync, 2026-09-28) — no stock moved; absorbed = was held, cut over 2026-09-28 — its piece is inside Page365''s own number, so the order''s cancel/expiry/forfeit/delete returns nothing.';
COMMENT ON COLUMN public.page365_inventory_items.invoice_holds IS
  'mode invoice: #195 held lines on the variant (the row is excluded). mode inventory_sync: pieces on imported Page365 invoices whose Hub order is live and unpaid (page365_invoice_holds), subtracted from the proposal while page365_hold_unpaid_invoices is true.';

-- ---------------------------------------------------------------------------
-- 3. Settings. Seeded only when absent: a re-run never undoes the owner's choice.
-- ---------------------------------------------------------------------------
INSERT INTO public.system_settings (key, value, description)
VALUES ('page365_stock_mode', to_jsonb('inventory_sync'::text),
        'inventory_sync = Page365 is the stock master: a Page365 invoice import records its lines and never moves website stock; stock follows the Page365 inventory fetch. invoice = the #195 behaviour (import takes stock) — the rollback.')
ON CONFLICT (key) DO NOTHING;
INSERT INTO public.system_settings (key, value, description)
VALUES ('page365_hold_unpaid_invoices', 'true'::jsonb,
        'true = the Page365 inventory fetch also subtracts pieces on imported Page365 invoices whose Hub order is live and unpaid (safe until the owner confirms whether Page365 already counts unpaid invoices). false once confirmed that it does.')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. Cut-over. Only while the mode is inventory_sync; only lines still held.
-- ---------------------------------------------------------------------------
DO $cut$
DECLARE
  v_n integer := 0;
  r   record;
BEGIN
  IF (SELECT value #>> '{}' FROM public.system_settings WHERE key = 'page365_stock_mode') IS DISTINCT FROM 'inventory_sync' THEN
    RAISE NOTICE 'page365_inventory_pr2: page365_stock_mode is invoice — no line absorbed';
    RETURN;
  END IF;
  FOR r IN
    UPDATE public.page365_stock_lines l
       SET stock_state = 'absorbed', updated_at = now()
     WHERE l.stock_state = 'held'
    RETURNING l.id, l.page365_no, l.line_no, l.variant_id, l.quantity, l.cash_order_id, l.account_id
  LOOP
    INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id)
    VALUES ('page365_stock_line', r.id, 'page365_stock_absorbed',
            jsonb_build_object('stock_state', 'held'),
            jsonb_build_object('stock_state', 'absorbed', 'page365_no', r.page365_no, 'line_no', r.line_no,
                               'variant_id', r.variant_id, 'quantity', r.quantity,
                               'cash_order_id', r.cash_order_id, 'account_id', r.account_id,
                               'why', 'page365_stock_mode inventory_sync (PR 2): the piece is inside Page365''s own number'),
            NULL);
    v_n := v_n + 1;
  END LOOP;
  RAISE NOTICE 'page365_inventory_pr2: % line(s) absorbed', v_n;
END
$cut$;

-- ---------------------------------------------------------------------------
-- 5. Pieces on imported Page365 invoices whose Hub order is live and has not
--    been paid (owner's open question D). Same "unpaid" rule as the website
--    holds: a cash order still pending; a layaway still active/overdue with no
--    money received. Service role only.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_invoice_holds(p_variant_id uuid)
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT coalesce(sum(l.quantity), 0)::integer
    FROM public.page365_stock_lines l
   WHERE l.variant_id = p_variant_id
     AND l.stock_state IN ('page365_master', 'absorbed')
     AND (EXISTS (SELECT 1 FROM public.cash_orders o
                   WHERE o.id = l.cash_order_id AND o.status = 'pending')
       OR EXISTS (SELECT 1 FROM public.layaway_accounts a
                   WHERE a.id = l.account_id AND a.status IN ('active','overdue') AND coalesce(a.total_paid, 0) = 0))
$fn$;
REVOKE ALL ON FUNCTION public.page365_invoice_holds(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_invoice_holds(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 6. page365_apply_stock — #195 body; PR 2 edits: the mode, the switch, the
--    record-only branch, the counts. Same signature and grants.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_apply_stock(
  p_order_kind       text,
  p_order_id         uuid,
  p_draft_id         uuid,
  p_service_line_nos integer[] DEFAULT '{}',
  p_actor            uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_page365_no bigint;
  v_invoice    text;
  v_customer   uuid;
  v_draft_no   bigint;
  v_items      jsonb;
  v_item       jsonb;
  v_line_no    integer;
  v_name       text;
  v_qty        integer;
  v_service    boolean;
  v_claim      uuid;
  v_m          record;
  v_seen       integer;
  v_taken      integer;
  v_held       integer := 0;
  v_flagged    integer := 0;
  v_skipped    integer := 0;
  v_services   integer := 0;
  v_now        timestamptz := now();
  -- PR 2: only an explicit 'invoice' brings back the #195 decrement.
  v_mode       text := CASE WHEN (SELECT s.value #>> '{}' FROM public.system_settings s
                                   WHERE s.key = 'page365_stock_mode') = 'invoice'
                            THEN 'invoice' ELSE 'inventory_sync' END;
  v_sync_off   boolean;
  v_recorded   integer := 0;
  v_off_lines  integer := 0;
BEGIN
  IF p_order_kind = 'cash' THEN
    SELECT c.page365_no, c.invoice_number, c.customer_id INTO v_page365_no, v_invoice, v_customer
      FROM public.cash_orders c WHERE c.id = p_order_id;
  ELSIF p_order_kind = 'layaway' THEN
    SELECT a.page365_no, a.invoice_number, a.customer_id INTO v_page365_no, v_invoice, v_customer
      FROM public.layaway_accounts a WHERE a.id = p_order_id;
  ELSE
    RAISE EXCEPTION 'page365_stock: bad order kind %', p_order_kind USING ERRCODE = 'P0001';
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'page365_stock: order % not found', p_order_id USING ERRCODE = 'P0001';
  END IF;
  IF v_page365_no IS NULL THEN
    RAISE EXCEPTION 'page365_stock: order % is not a Page365 import', p_order_id USING ERRCODE = 'P0001';
  END IF;

  SELECT d.page365_no, d.payload->'items' INTO v_draft_no, v_items
    FROM public.page365_drafts d WHERE d.id = p_draft_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'page365_stock: Page365 draft % not found — fetch the link again', p_draft_id USING ERRCODE = 'P0001';
  END IF;
  IF v_draft_no IS DISTINCT FROM v_page365_no THEN
    RAISE EXCEPTION 'page365_stock: draft is for Page365 invoice %, the order is %', v_draft_no, v_page365_no
      USING ERRCODE = 'P0001';
  END IF;
  IF v_items IS NULL OR jsonb_typeof(v_items) <> 'array' OR jsonb_array_length(v_items) = 0 THEN
    RAISE EXCEPTION 'page365_stock: draft % has no item lines', p_draft_id USING ERRCODE = 'P0001';
  END IF;

  FOR v_item, v_line_no IN
    SELECT e, o::integer FROM jsonb_array_elements(v_items) WITH ORDINALITY AS t(e, o)
  LOOP
    v_name    := btrim(coalesce(v_item->>'name', ''));
    v_qty     := CASE WHEN (v_item->>'quantity') ~ '^\d+$' THEN (v_item->>'quantity')::integer END;
    v_service := coalesce(v_item->>'kind', 'product') = 'service'
                 OR v_line_no = ANY (coalesce(p_service_line_nos, '{}'::integer[]));
    IF v_name = '' OR v_qty IS NULL OR v_qty < 1 THEN
      RAISE EXCEPTION 'page365_stock: draft line % is unusable (%)', v_line_no, v_item USING ERRCODE = 'P0001';
    END IF;

    -- CLAIM FIRST. Only the call that inserts the row may move stock, so a
    -- retry, a second tab or a concurrent call can never reduce twice.
    v_claim := NULL;
    INSERT INTO public.page365_stock_lines
      (page365_no, line_no, cash_order_id, account_id, line_name, quantity, match_result)
    VALUES
      (v_page365_no, v_line_no,
       CASE WHEN p_order_kind = 'cash'    THEN p_order_id END,
       CASE WHEN p_order_kind = 'layaway' THEN p_order_id END,
       v_name, v_qty, 'pending')
    ON CONFLICT ON CONSTRAINT uq_page365_stock_line DO NOTHING
    RETURNING id INTO v_claim;

    IF v_claim IS NULL THEN
      -- Already claimed. The one exception: its order was DELETED (unpaid
      -- orders only, and the delete trigger already gave its stock back), so
      -- this invoice is being imported afresh. Re-claim that row — the UPDATE's
      -- own WHERE is the lock, so still only one caller wins.
      UPDATE public.page365_stock_lines l
         SET cash_order_id = CASE WHEN p_order_kind = 'cash'    THEN p_order_id END,
             account_id    = CASE WHEN p_order_kind = 'layaway' THEN p_order_id END,
             line_name = v_name, quantity = v_qty, first_word = NULL, match_result = 'pending',
             website_product_id = NULL, variant_id = NULL, stock_state = 'none', flag = NULL,
             stock_seen = NULL, held_at = NULL, released_at = NULL,
             resolved_at = NULL, resolved_by = NULL, resolution_note = NULL, updated_at = v_now
       WHERE l.page365_no = v_page365_no AND l.line_no = v_line_no
         AND l.cash_order_id IS NULL AND l.account_id IS NULL
         AND l.stock_state <> 'held'
      RETURNING l.id INTO v_claim;
      IF v_claim IS NULL THEN
        v_skipped := v_skipped + 1;
        CONTINUE;
      END IF;
    END IF;

    IF v_service THEN
      -- A resize or other service: never a product, never flagged.
      UPDATE public.page365_stock_lines
         SET first_word = public.page365_first_word(v_name), match_result = 'not_a_product', updated_at = v_now
       WHERE id = v_claim;
      v_services := v_services + 1;
      CONTINUE;
    END IF;

    SELECT * INTO v_m FROM public.page365_match_line(v_name);
    IF v_m.o_match_result <> 'matched' THEN
      UPDATE public.page365_stock_lines
         SET first_word = v_m.o_first_word, match_result = v_m.o_match_result,
             website_product_id = v_m.o_product_id, flag = v_m.o_match_result, updated_at = v_now
       WHERE id = v_claim;
      v_flagged := v_flagged + 1;
      CONTINUE;
    END IF;

    -- PR 2: RECORD ONLY. Page365 is the stock master (mode inventory_sync), or
    -- staff switched this product to "Don't sync with Page365": the match is
    -- recorded and website stock is left exactly as it is. No flag — nothing
    -- is wrong with the line.
    SELECT coalesce(wp.page365_sync_disabled, false) INTO v_sync_off
      FROM public.website_products wp WHERE wp.id = v_m.o_product_id;
    IF v_mode = 'inventory_sync' OR coalesce(v_sync_off, false) THEN
      UPDATE public.page365_stock_lines
         SET first_word = v_m.o_first_word, match_result = 'matched',
             website_product_id = v_m.o_product_id, variant_id = v_m.o_variant_id,
             stock_state = CASE WHEN coalesce(v_sync_off, false) THEN 'none' ELSE 'page365_master' END,
             stock_seen = v_m.o_stock_qty, updated_at = v_now
       WHERE id = v_claim;
      IF coalesce(v_sync_off, false) THEN v_off_lines := v_off_lines + 1; ELSE v_recorded := v_recorded + 1; END IF;
      CONTINUE;
    END IF;

    -- The website's own pattern: lock the variant row, then take only if
    -- enough is left. Never below zero; never another order's piece.
    SELECT wv.stock_qty INTO v_seen FROM public.website_product_variants wv
     WHERE wv.id = v_m.o_variant_id FOR UPDATE;
    UPDATE public.website_product_variants wv
       SET stock_qty = wv.stock_qty - v_qty, updated_at = v_now
     WHERE wv.id = v_m.o_variant_id AND wv.stock_qty >= v_qty;
    GET DIAGNOSTICS v_taken = ROW_COUNT;

    IF v_taken = 1 THEN
      UPDATE public.page365_stock_lines
         SET first_word = v_m.o_first_word, match_result = 'matched',
             website_product_id = v_m.o_product_id, variant_id = v_m.o_variant_id,
             stock_state = 'held', stock_seen = v_seen, held_at = v_now, updated_at = v_now
       WHERE id = v_claim;
      v_held := v_held + 1;
    ELSE
      -- Already reserved or sold on the website (or short). The website
      -- reservation stands; staff adjust Page365's own stock.
      UPDATE public.page365_stock_lines
         SET first_word = v_m.o_first_word, match_result = 'matched',
             website_product_id = v_m.o_product_id, variant_id = v_m.o_variant_id,
             flag = 'insufficient_stock', stock_seen = v_seen, updated_at = v_now
       WHERE id = v_claim;
      v_flagged := v_flagged + 1;
    END IF;
  END LOOP;

  IF v_flagged > 0 THEN
    INSERT INTO public.staff_notifications (type, title, body, account_id, customer_id, invoice_number, metadata)
    VALUES ('page365_stock_flag',
            'Page365 stock needs a look',
            v_flagged || CASE WHEN v_mode = 'invoice'
                              THEN ' line(s) on Page365 invoice ' || v_page365_no || ' did not reduce website stock.'
                              ELSE ' line(s) on Page365 invoice ' || v_page365_no || ' did not match one website product.' END,
            CASE WHEN p_order_kind = 'layaway' THEN p_order_id END,
            v_customer, v_invoice,
            jsonb_build_object(
              'page365_no', v_page365_no, 'order_kind', p_order_kind, 'order_id', p_order_id,
              'cash_order_id', CASE WHEN p_order_kind = 'cash' THEN p_order_id END,
              'reason', 'import', 'mode', v_mode,
              'lines', (SELECT jsonb_agg(jsonb_build_object('line_no', l.line_no, 'name', l.line_name,
                                                            'flag', l.flag, 'stock_seen', l.stock_seen)
                                         ORDER BY l.line_no)
                          FROM public.page365_stock_lines l
                         WHERE l.page365_no = v_page365_no AND l.flag IS NOT NULL AND l.resolved_at IS NULL)));
  END IF;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id)
  VALUES (CASE WHEN p_order_kind = 'cash' THEN 'cash_order' ELSE 'layaway_account' END, p_order_id,
          'page365_stock_applied',
          jsonb_build_object('page365_no', v_page365_no, 'draft_id', p_draft_id, 'mode', v_mode, 'held', v_held,
                             'recorded', v_recorded, 'sync_off', v_off_lines,
                             'flagged', v_flagged, 'services', v_services, 'already_claimed', v_skipped),
          p_actor);

  RETURN jsonb_build_object('ok', true, 'page365_no', v_page365_no, 'mode', v_mode,
    'held', v_held, 'recorded', v_recorded, 'sync_off', v_off_lines,
    'flagged', v_flagged, 'services', v_services, 'already_claimed', v_skipped,
    'lines', (SELECT jsonb_agg(jsonb_build_object('line_no', l.line_no, 'name', l.line_name,
                'first_word', l.first_word, 'match_result', l.match_result,
                'stock_state', l.stock_state, 'flag', l.flag, 'stock_seen', l.stock_seen) ORDER BY l.line_no)
                FROM public.page365_stock_lines l WHERE l.page365_no = v_page365_no));
END
$fn$;
REVOKE ALL ON FUNCTION public.page365_apply_stock(text, uuid, uuid, integer[], uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_apply_stock(text, uuid, uuid, integer[], uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 7. page365_inventory_finish — PR 1 body; PR 2 edits: the mode (invoice-hold
--    exclusion only in 'invoice'), unpaid invoice holds (D), the switch
--    (category not_synced: never proposed, no photos).
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
  RETURN jsonb_build_object('ok', true, 'status', v_status, 'reason', v_reason, 'mode', v_mode);
END
$fn$;
REVOKE ALL ON FUNCTION public.page365_inventory_finish(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_inventory_finish(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 8a. page365_inventory_apply — PR 1 body; PR 2 edits: refuse a switched-off
--     product (read LIVE, not from the fetch), invoice-hold refusal only in
--     'invoice' mode.
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
  -- PR 2
  v_mode    text := CASE WHEN (SELECT s.value #>> '{}' FROM public.system_settings s
                                WHERE s.key = 'page365_stock_mode') = 'invoice'
                         THEN 'invoice' ELSE 'inventory_sync' END;
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
      WHEN v_it.category = 'not_synced'
        OR EXISTS (SELECT 1 FROM public.website_product_variants wv
                     JOIN public.website_products wp ON wp.id = wv.product_id
                    WHERE wv.id = v_it.variant_id AND wp.page365_sync_disabled) THEN 'sync_disabled'
      WHEN v_it.category = 'excluded'                  THEN 'invoice_hold'
      WHEN v_it.category NOT IN ('decrease','increase') THEN 'not_a_stock_change'
      WHEN (v_it.category = 'increase') <> v_as_inc    THEN 'direction_mismatch'
      WHEN v_mode = 'invoice' AND EXISTS (SELECT 1 FROM public.page365_stock_lines l
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
                                   'page365_available', v_it.page365_available, 'web_holds', v_it.web_holds,
                                   'invoice_holds', v_it.invoice_holds, 'mode', v_mode),
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
                             'increases_sent', cardinality(coalesce(p_increase_ids, '{}')), 'mode', v_mode),
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
-- 8b. page365_inventory_record_photo — PR 1 body; PR 2 edit: a switched-off
--     product never receives a Page365 photo ('sync_disabled').
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
  -- PR 2: "Don't sync with Page365" — read live from the variant's product.
  IF v_it.category = 'not_synced'
     OR EXISTS (SELECT 1 FROM public.website_product_variants wv
                  JOIN public.website_products wp ON wp.id = wv.product_id
                 WHERE wv.id = v_it.variant_id AND wp.page365_sync_disabled) THEN
    RETURN 'sync_disabled';
  END IF;
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

-- ---------------------------------------------------------------------------
-- 9. Proof and self-check, still inside the transaction. Pure reads; any
--    failure aborts the whole file with nothing changed.
-- ---------------------------------------------------------------------------
DO $proof$
DECLARE
  v_bad text := '';
  r     record;
  v_fn  text;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('page365_apply_stock',            '065eb0bf19e3b86532efd4b5bf224955'),
      ('page365_inventory_finish',       '9d0be9494288800686e2d6a90edb3304'),
      ('page365_inventory_apply',        'e65757c2f32b597b2a55047d77783df3'),
      ('page365_inventory_record_photo', 'c8f94536cf40167fe43a24967a6eefe9'),
      ('page365_stock_follow_order',     'dfd6d211808c5e6a7758b3d0fd7dafd9')
    ) AS t(fn, want)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = r.fn AND md5(p.prosrc) = r.want AND p.prosecdef) THEN
      SELECT v_bad || format(E'\n  %s: landed md5 %s, expected %s', r.fn, md5(p.prosrc), r.want) INTO v_bad
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = r.fn;
    END IF;
  END LOOP;
  IF v_bad <> '' THEN
    RAISE EXCEPTION 'STOP — page365_inventory_pr2 did not land as predicted; rolled back.%', v_bad;
  END IF;

  FOREACH v_fn IN ARRAY ARRAY[
    'public.page365_apply_stock(text,uuid,uuid,integer[],uuid)', 'public.page365_inventory_finish(uuid)',
    'public.page365_inventory_record_photo(uuid,bigint,text,text,text,integer,uuid)',
    'public.page365_invoice_holds(uuid)', 'public.page365_sync_switch_guard()'] LOOP
    IF has_function_privilege('authenticated', v_fn, 'EXECUTE') OR has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'page365_inventory_pr2 self-check: % is callable by a browser role', v_fn;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'public.page365_inventory_apply(uuid,uuid[],uuid[])', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.page365_inventory_apply(uuid,uuid[],uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'page365_inventory_pr2 self-check: page365_inventory_apply grants are wrong';
  END IF;

  IF (SELECT value #>> '{}' FROM public.system_settings WHERE key = 'page365_stock_mode') = 'inventory_sync'
     AND EXISTS (SELECT 1 FROM public.page365_stock_lines WHERE stock_state = 'held') THEN
    RAISE EXCEPTION 'page365_inventory_pr2 self-check: held lines remain in inventory_sync mode';
  END IF;
  IF (SELECT count(*) FROM pg_trigger t WHERE NOT t.tgisinternal
         AND t.tgfoid = 'public.page365_stock_follow_order()'::regprocedure) <> 4 THEN
    RAISE EXCEPTION 'page365_inventory_pr2 self-check: expected the 4 #195 follow triggers';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname = 'trg_page365_sync_switch'
                    AND t.tgrelid = 'public.website_products'::regclass) THEN
    RAISE EXCEPTION 'page365_inventory_pr2 self-check: trg_page365_sync_switch missing';
  END IF;
END
$proof$;

COMMIT;

-- ===========================================================================
-- Verification (read-only). Run after COMMIT.
--
-- (1) Objects and settings; expect: t | t | t | inventory_sync | true | 0
-- SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
--                  AND table_name='website_products' AND column_name='page365_sync_disabled')      AS switch_column,
--        to_regprocedure('public.page365_invoice_holds(uuid)') IS NOT NULL                         AS invoice_holds_fn,
--        EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_page365_sync_switch')                  AS switch_trigger,
--        (SELECT value #>> '{}' FROM public.system_settings WHERE key='page365_stock_mode')         AS stock_mode,
--        (SELECT value #>> '{}' FROM public.system_settings WHERE key='page365_hold_unpaid_invoices') AS hold_unpaid,
--        (SELECT count(*) FROM public.website_products WHERE page365_sync_disabled)                AS switched_off;
--
-- (2) The cut-over; expect held = 0, absorbed = the NOTICE count from the run
--     (and the same number of page365_stock_absorbed audit rows).
-- SELECT stock_state, count(*) FROM public.page365_stock_lines GROUP BY 1 ORDER BY 1;
-- SELECT count(*) FROM public.audit_logs WHERE action = 'page365_stock_absorbed';
--
-- (3) The bodies that landed; expect exactly these five md5s:
--     page365_apply_stock 065eb0bf19e3b86532efd4b5bf224955 · page365_inventory_apply e65757c2f32b597b2a55047d77783df3 ·
--     page365_inventory_finish 9d0be9494288800686e2d6a90edb3304 · page365_inventory_record_photo c8f94536cf40167fe43a24967a6eefe9 ·
--     page365_stock_follow_order dfd6d211808c5e6a7758b3d0fd7dafd9 (unchanged)
-- SELECT proname, md5(prosrc) FROM pg_proc
--  WHERE proname IN ('page365_apply_stock','page365_inventory_apply','page365_inventory_finish',
--                    'page365_inventory_record_photo','page365_stock_follow_order') ORDER BY 1;
--
-- (4) Browser roles; expect: f | f | f | t
-- SELECT has_function_privilege('authenticated','public.page365_apply_stock(text,uuid,uuid,integer[],uuid)','EXECUTE') AS auth_apply_stock,
--        has_function_privilege('authenticated','public.page365_invoice_holds(uuid)','EXECUTE')                          AS auth_invoice_holds,
--        has_function_privilege('anon','public.page365_inventory_apply(uuid,uuid[],uuid[])','EXECUTE')                    AS anon_apply,
--        has_function_privilege('authenticated','public.page365_inventory_apply(uuid,uuid[],uuid[])','EXECUTE')           AS auth_apply;
--
-- (5) Released #195 lines left as they were (informational — a revive of such an
--     order still takes its piece again, exactly as under #195); expect 0 or more.
-- SELECT count(*) AS released_lines FROM public.page365_stock_lines WHERE stock_state = 'released';
--
-- (6) Pieces the fetch will hold for unpaid imported invoices (informational).
-- SELECT wp.sku, public.page365_invoice_holds(v.id) AS unpaid_invoice_holds
--   FROM public.website_product_variants v JOIN public.website_products wp ON wp.id = v.product_id
--  WHERE public.page365_invoice_holds(v.id) > 0 ORDER BY wp.sku;
-- ===========================================================================

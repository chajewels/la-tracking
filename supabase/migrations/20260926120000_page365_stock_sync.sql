-- ===========================================================================
-- page365_stock_sync — a Page365 invoice imported as a Hub order reduces
-- storefront stock, ONCE, and gives it back when that order dies.
--
-- OWNER RUNS THIS in the SQL Editor, as-is. One transaction. It is INERT until
-- create-cash-order / create-layaway-account call page365_apply_stock: the
-- order triggers return immediately for every order without page365_no, and
-- for every Page365 order that has no ledger rows — which is all of them today.
--
-- Owner rules (plan ~/Code/reference/page365-stock-investigation.md, D1–D7):
--   * MATCH = the FIRST WORD of the Page365 line, upper-cased and trimmed,
--     equal to exactly ONE website_products.sku that has exactly ONE variant.
--     Anything else is a FLAG for staff; no stock moves, nothing is guessed.
--     Service (resize) lines are skipped, not flagged.
--   * D1 stock is taken when the invoice is IMPORTED as a Hub order, never at
--     fetch. The fetch only previews the match (page365_match_line).
--   * NEVER TWICE: each line is CLAIMED in page365_stock_lines before any stock
--     moves; only the call that claimed the line may move stock.
--   * Same conditional decrement as website checkout: only if enough is left,
--     never below zero. Short → the order is still created and the line is
--     flagged insufficient_stock; the website reservation is never overridden.
--   * Stock comes back when an order that TOOK stock is cancelled, expired
--     (D3), forfeited (D4) or deleted — by a trigger, so every writer is
--     covered. Revive / reactivation takes it again or flags rehold_failed (D5).
--   * D7 draft/archived products are still reduced.
--   * Orders that never took stock through the ledger never move stock.
--
-- Guards: every dependency is checked first and the whole transaction aborts
-- with NOTHING changed if the live schema is not what this was written against.
-- Re-running the file is safe (CREATE OR REPLACE / IF NOT EXISTS / DROP IF
-- EXISTS on objects this file owns), and the guards refuse a table or function
-- of the same name that this file did not create.
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
  -- Tables this relies on.
  IF to_regclass('public.website_products')         IS NULL THEN v_missing := v_missing || 'website_products'; END IF;
  IF to_regclass('public.website_product_variants') IS NULL THEN v_missing := v_missing || 'website_product_variants'; END IF;
  IF to_regclass('public.cash_orders')              IS NULL THEN v_missing := v_missing || 'cash_orders'; END IF;
  IF to_regclass('public.layaway_accounts')         IS NULL THEN v_missing := v_missing || 'layaway_accounts'; END IF;
  IF to_regclass('public.page365_drafts')           IS NULL THEN v_missing := v_missing || 'page365_drafts'; END IF;
  IF to_regclass('public.staff_notifications')      IS NULL THEN v_missing := v_missing || 'staff_notifications'; END IF;
  IF to_regclass('public.audit_logs')               IS NULL THEN v_missing := v_missing || 'audit_logs'; END IF;
  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'page365_stock_sync: missing table(s): %', array_to_string(v_missing, ', ');
  END IF;

  -- Columns this reads or writes, table by table.
  SELECT array_agg(c.table_name || '.' || c.column_name) INTO v_cols
    FROM (VALUES
      ('website_products','id'), ('website_products','sku'),
      ('website_product_variants','id'), ('website_product_variants','product_id'),
      ('website_product_variants','stock_qty'), ('website_product_variants','updated_at'),
      ('cash_orders','id'), ('cash_orders','page365_no'), ('cash_orders','status'),
      ('cash_orders','customer_id'), ('cash_orders','invoice_number'),
      ('layaway_accounts','id'), ('layaway_accounts','page365_no'), ('layaway_accounts','status'),
      ('layaway_accounts','customer_id'), ('layaway_accounts','invoice_number'),
      ('page365_drafts','id'), ('page365_drafts','page365_no'), ('page365_drafts','payload'),
      ('staff_notifications','type'), ('staff_notifications','title'), ('staff_notifications','body'),
      ('staff_notifications','account_id'), ('staff_notifications','customer_id'),
      ('staff_notifications','invoice_number'), ('staff_notifications','metadata'),
      ('audit_logs','entity_type'), ('audit_logs','entity_id'), ('audit_logs','action'),
      ('audit_logs','new_value_json'), ('audit_logs','performed_by_user_id')
    ) AS c(table_name, column_name)
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns ic
      WHERE ic.table_schema = 'public' AND ic.table_name = c.table_name AND ic.column_name = c.column_name);
  IF v_cols IS NOT NULL THEN
    RAISE EXCEPTION 'page365_stock_sync: missing column(s): %', array_to_string(v_cols, ', ');
  END IF;

  -- The storefront never shows negative stock: the CHECK is the backstop the
  -- conditional decrement relies on.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint k
     WHERE k.conrelid = 'public.website_product_variants'::regclass AND k.contype = 'c'
       AND pg_get_constraintdef(k.oid) ILIKE '%stock_qty >= 0%') THEN
    RAISE EXCEPTION 'page365_stock_sync: website_product_variants has no CHECK (stock_qty >= 0)';
  END IF;

  -- Status values the trigger treats as dead / alive must exist as written.
  IF NOT ('cancelled' = ANY (enum_range(NULL::public.cash_order_status)::text[])
      AND 'expired'   = ANY (enum_range(NULL::public.cash_order_status)::text[])) THEN
    RAISE EXCEPTION 'page365_stock_sync: cash_order_status lacks cancelled/expired';
  END IF;
  IF NOT ('cancelled'       = ANY (enum_range(NULL::public.account_status)::text[])
      AND 'forfeited'       = ANY (enum_range(NULL::public.account_status)::text[])
      AND 'final_forfeited' = ANY (enum_range(NULL::public.account_status)::text[])) THEN
    RAISE EXCEPTION 'page365_stock_sync: account_status lacks cancelled/forfeited/final_forfeited';
  END IF;

  -- Helpers the policies and the resolve RPC call.
  IF to_regprocedure('public.is_staff(uuid)') IS NULL THEN
    RAISE EXCEPTION 'page365_stock_sync: public.is_staff(uuid) is missing';
  END IF;
  IF to_regprocedure('public.has_permission(uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'page365_stock_sync: public.has_permission(uuid,text) is missing';
  END IF;

  -- The storefront revalidation chain (docs/WEBSITE-VERCEL.md): a stock UPDATE
  -- reaches chajewelsjp.com only through this trigger. Checked, never changed.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'public.website_product_variants'::regclass
                    AND NOT t.tgisinternal
                    AND t.tgfoid = to_regprocedure('public.notify_website_revalidate()')) THEN
    RAISE EXCEPTION 'page365_stock_sync: website_product_variants has no notify_website_revalidate trigger';
  END IF;

  -- A Page365 order is a Hub order. The website's own restore paths are gated
  -- source_channel = 'web'; if any Page365 order were a web order, two paths
  -- would give its stock back.
  SELECT count(*) INTO v_n FROM (
    SELECT 1 FROM public.cash_orders      WHERE page365_no IS NOT NULL AND source_channel = 'web'
    UNION ALL
    SELECT 1 FROM public.layaway_accounts WHERE page365_no IS NOT NULL AND source_channel = 'web') s;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'page365_stock_sync: % Page365 order(s) carry source_channel = web', v_n;
  END IF;

  -- Name collisions: refuse an object of the same name this file did not make.
  IF to_regclass('public.page365_stock_lines') IS NOT NULL THEN
    SELECT count(*) INTO v_n FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'page365_stock_lines'
       AND column_name IN ('page365_no','line_no','cash_order_id','account_id','line_name','first_word',
                           'quantity','website_product_id','variant_id','match_result','stock_state',
                           'flag','stock_seen','held_at','released_at','resolved_at','resolved_by',
                           'resolution_note','created_at','updated_at');
    IF v_n <> 20 THEN
      RAISE EXCEPTION 'page365_stock_sync: a different public.page365_stock_lines already exists';
    END IF;
  END IF;
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND ((p.proname = 'page365_first_word'         AND pg_get_function_identity_arguments(p.oid) <> 'p_name text')
       OR (p.proname = 'page365_match_line'         AND pg_get_function_identity_arguments(p.oid) <> 'p_name text')
       OR (p.proname = 'page365_apply_stock'        AND pg_get_function_identity_arguments(p.oid)
                                                        <> 'p_order_kind text, p_order_id uuid, p_draft_id uuid, p_service_line_nos integer[], p_actor uuid')
       OR (p.proname = 'page365_stock_follow_order' AND pg_get_function_identity_arguments(p.oid) <> '')
       OR (p.proname = 'resolve_page365_stock_flag' AND pg_get_function_identity_arguments(p.oid) <> 'p_line_id uuid, p_note text'));
  IF v_n > 0 THEN
    RAISE EXCEPTION 'page365_stock_sync: a page365 stock function already exists with a different signature';
  END IF;
  SELECT count(*) INTO v_n FROM pg_trigger t
   WHERE NOT t.tgisinternal
     AND t.tgname IN ('trg_page365_stock_follow_cash','trg_page365_stock_follow_cash_delete',
                      'trg_page365_stock_follow_layaway','trg_page365_stock_follow_layaway_delete')
     AND t.tgfoid IS DISTINCT FROM to_regprocedure('public.page365_stock_follow_order()');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'page365_stock_sync: a trg_page365_stock_follow_* trigger already points elsewhere';
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. The ledger. One row per Page365 invoice line, ever.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.page365_stock_lines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page365_no         bigint  NOT NULL,
  line_no            integer NOT NULL CHECK (line_no >= 1),
  cash_order_id      uuid REFERENCES public.cash_orders(id)      ON DELETE SET NULL,
  account_id         uuid REFERENCES public.layaway_accounts(id) ON DELETE SET NULL,
  line_name          text    NOT NULL,
  first_word         text,
  quantity           integer NOT NULL CHECK (quantity > 0),
  website_product_id uuid REFERENCES public.website_products(id)         ON DELETE SET NULL,
  variant_id         uuid REFERENCES public.website_product_variants(id) ON DELETE SET NULL,
  match_result       text NOT NULL CHECK (match_result IN
                       ('pending','matched','not_a_product','unmatched','ambiguous_sku','no_variant','ambiguous_variant')),
  stock_state        text NOT NULL DEFAULT 'none' CHECK (stock_state IN ('none','held','released')),
  flag               text CHECK (flag IN
                       ('unmatched','ambiguous_sku','no_variant','ambiguous_variant','insufficient_stock','rehold_failed')),
  stock_seen         integer,
  held_at            timestamptz,
  released_at        timestamptz,
  resolved_at        timestamptz,
  resolved_by        uuid,
  resolution_note    text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_page365_stock_line UNIQUE (page365_no, line_no),
  CONSTRAINT page365_stock_line_one_order CHECK (num_nonnulls(cash_order_id, account_id) <= 1)
);
COMMENT ON TABLE public.page365_stock_lines IS
  'Idempotency ledger for Page365 -> storefront stock (2026-09-26). UNIQUE(page365_no, line_no): a line is CLAIMED once and only the claiming call moves stock. stock_state held = the Hub took website stock for this line; released = given back (order cancelled/expired/forfeited/deleted). flag IS NOT NULL AND resolved_at IS NULL = open staff flag (Website -> Page365 stock). Written only by page365_apply_stock, page365_stock_follow_order and resolve_page365_stock_flag.';
COMMENT ON COLUMN public.page365_stock_lines.line_no IS
  '1-based position of the line in the Page365 draft (page365_drafts.payload->items). Page365 line ids are not read.';
COMMENT ON COLUMN public.page365_stock_lines.first_word IS
  'First whitespace-delimited word of line_name, upper-cased: the product code the line was matched on.';
COMMENT ON COLUMN public.page365_stock_lines.stock_seen IS
  'website_product_variants.stock_qty at the moment the line was applied, before any reduction.';

CREATE INDEX IF NOT EXISTS idx_page365_stock_lines_open_flags
  ON public.page365_stock_lines (created_at DESC) WHERE flag IS NOT NULL AND resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_page365_stock_lines_cash
  ON public.page365_stock_lines (cash_order_id) WHERE cash_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_page365_stock_lines_account
  ON public.page365_stock_lines (account_id) WHERE account_id IS NOT NULL;

-- Staff read (review chips, order pages, the flags tab). Nobody writes through
-- PostgREST: every write is one of the SECURITY DEFINER functions below.
ALTER TABLE public.page365_stock_lines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Staff can view page365 stock lines" ON public.page365_stock_lines;
CREATE POLICY "Staff can view page365 stock lines" ON public.page365_stock_lines
  FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
REVOKE ALL ON public.page365_stock_lines FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.page365_stock_lines TO authenticated;
GRANT ALL    ON public.page365_stock_lines TO service_role;

-- ---------------------------------------------------------------------------
-- 2. The first word. Leading/trailing blanks (incl. U+3000 ideographic space
--    and NBSP, which hand-typed Page365 names carry) are ignored; case is not
--    significant. Twin: firstWord() in supabase/functions/_shared/page365-stock.ts.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_first_word(p_name text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path TO 'public'
AS $fn$
  SELECT upper((regexp_match(coalesce(p_name, ''), '^[\s\u3000\u00a0]*([^\s\u3000\u00a0]+)'))[1])
$fn$;
REVOKE ALL ON FUNCTION public.page365_first_word(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.page365_first_word(text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. The matcher. Exact code, never fuzzy. Read-only.
--    SECURITY INVOKER: staff already read the catalogue under RLS, and the
--    service role (page365-fetch-order's preview) bypasses it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_match_line(p_name text)
RETURNS TABLE (o_first_word text, o_match_result text, o_product_id uuid, o_variant_id uuid, o_stock_qty integer)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path TO 'public'
AS $fn$
DECLARE
  v_word     text := public.page365_first_word(p_name);
  v_products integer;
  v_pid      uuid;
  v_variants integer;
  v_vid      uuid;
  v_stock    integer;
BEGIN
  IF v_word IS NULL THEN
    RETURN QUERY SELECT NULL::text, 'unmatched'::text, NULL::uuid, NULL::uuid, NULL::integer;
    RETURN;
  END IF;

  SELECT count(*)::integer, (array_agg(wp.id))[1] INTO v_products, v_pid
    FROM public.website_products wp
   WHERE public.page365_first_word(wp.sku) = v_word
     -- A code with a space inside ("R11 55") can never equal a first word;
     -- without this it would answer to "R11".
     AND wp.sku !~ '[^\s\u3000\u00a0][\s\u3000\u00a0]+[^\s\u3000\u00a0]';
  IF v_products = 0 THEN
    RETURN QUERY SELECT v_word, 'unmatched'::text, NULL::uuid, NULL::uuid, NULL::integer; RETURN;
  ELSIF v_products > 1 THEN
    RETURN QUERY SELECT v_word, 'ambiguous_sku'::text, NULL::uuid, NULL::uuid, NULL::integer; RETURN;
  END IF;

  SELECT count(*)::integer, (array_agg(wv.id))[1], (array_agg(wv.stock_qty))[1]
    INTO v_variants, v_vid, v_stock
    FROM public.website_product_variants wv
   WHERE wv.product_id = v_pid;
  IF v_variants = 0 THEN
    RETURN QUERY SELECT v_word, 'no_variant'::text, v_pid, NULL::uuid, NULL::integer; RETURN;
  ELSIF v_variants > 1 THEN
    -- D6: several sizes/stones. Never guess which one was sold.
    RETURN QUERY SELECT v_word, 'ambiguous_variant'::text, v_pid, NULL::uuid, NULL::integer; RETURN;
  END IF;

  RETURN QUERY SELECT v_word, 'matched'::text, v_pid, v_vid, v_stock;
END
$fn$;
REVOKE ALL ON FUNCTION public.page365_match_line(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.page365_match_line(text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Apply. Service role only — called by create-cash-order /
--    create-layaway-account right after the order and its lines are written.
--
--    The LINES COME FROM THE STORED DRAFT (Page365's own names and quantities),
--    read here by id. The browser only says which draft positions the CSR
--    marked as a service. It never decides a name, a quantity or a variant.
--
--    Business outcomes (no match, several products, several sizes, not enough
--    stock) never raise: the order stands and the line is flagged. Bad input
--    (no draft, a draft for another invoice) raises, and the caller rolls the
--    order back.
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
            v_flagged || ' line(s) on Page365 invoice ' || v_page365_no || ' did not reduce website stock.',
            CASE WHEN p_order_kind = 'layaway' THEN p_order_id END,
            v_customer, v_invoice,
            jsonb_build_object(
              'page365_no', v_page365_no, 'order_kind', p_order_kind, 'order_id', p_order_id,
              'cash_order_id', CASE WHEN p_order_kind = 'cash' THEN p_order_id END,
              'reason', 'import',
              'lines', (SELECT jsonb_agg(jsonb_build_object('line_no', l.line_no, 'name', l.line_name,
                                                            'flag', l.flag, 'stock_seen', l.stock_seen)
                                         ORDER BY l.line_no)
                          FROM public.page365_stock_lines l
                         WHERE l.page365_no = v_page365_no AND l.flag IS NOT NULL AND l.resolved_at IS NULL)));
  END IF;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id)
  VALUES (CASE WHEN p_order_kind = 'cash' THEN 'cash_order' ELSE 'layaway_account' END, p_order_id,
          'page365_stock_applied',
          jsonb_build_object('page365_no', v_page365_no, 'draft_id', p_draft_id, 'held', v_held,
                             'flagged', v_flagged, 'services', v_services, 'already_claimed', v_skipped),
          p_actor);

  RETURN jsonb_build_object('ok', true, 'page365_no', v_page365_no,
    'held', v_held, 'flagged', v_flagged, 'services', v_services, 'already_claimed', v_skipped,
    'lines', (SELECT jsonb_agg(jsonb_build_object('line_no', l.line_no, 'name', l.line_name,
                'first_word', l.first_word, 'match_result', l.match_result,
                'stock_state', l.stock_state, 'flag', l.flag, 'stock_seen', l.stock_seen) ORDER BY l.line_no)
                FROM public.page365_stock_lines l WHERE l.page365_no = v_page365_no));
END
$fn$;
REVOKE ALL ON FUNCTION public.page365_apply_stock(text, uuid, uuid, integer[], uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_apply_stock(text, uuid, uuid, integer[], uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 5. Follow the Hub order's life. Every writer — cancel-cash-order, the hourly
--    auto-expire-cash-orders, auto-forfeit-settlement, manual-forfeit, the
--    client-side cash revive, reactivate-account, extension, delete — changes
--    status (or deletes) on these two tables, so this trigger covers all of
--    them and none of them needs to know about Page365.
--
--    Only ledger rows move stock: an order with no page365_no, or a Page365
--    order imported before this shipped, has none, and nothing happens.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_stock_follow_order()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_is_cash  boolean := (TG_TABLE_NAME = 'cash_orders');
  v_no       bigint;
  v_old      text;
  v_new      text;
  v_dead     text[];
  v_row      record;
  v_taken    integer;
  v_moved    integer := 0;
  v_short    integer := 0;
  v_id       uuid;
  v_now      timestamptz := now();
BEGIN
  v_dead := CASE WHEN v_is_cash THEN ARRAY['cancelled','expired']
                 ELSE ARRAY['cancelled','forfeited','final_forfeited'] END;

  IF TG_OP = 'DELETE' THEN
    v_no := OLD.page365_no;
    IF v_no IS NULL THEN RETURN OLD; END IF;
    v_id := OLD.id; v_old := OLD.status::text; v_new := 'deleted';
  ELSE
    v_no := NEW.page365_no;
    IF v_no IS NULL OR NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
    v_id := NEW.id; v_old := OLD.status::text; v_new := NEW.status::text;
  END IF;

  IF v_new = 'deleted' OR (v_new = ANY (v_dead) AND NOT (v_old = ANY (v_dead))) THEN
    -- Give back every held line, once (stock_state is the guard), summed per
    -- variant so two lines on one piece both come back.
    WITH rel AS (
      UPDATE public.page365_stock_lines l
         SET stock_state = 'released', released_at = v_now, updated_at = v_now
       WHERE l.page365_no = v_no AND l.stock_state = 'held'
       RETURNING l.variant_id, l.quantity
    ), per_variant AS (
      SELECT r.variant_id, sum(r.quantity)::integer AS qty FROM rel r
       WHERE r.variant_id IS NOT NULL GROUP BY r.variant_id
    ), upd AS (
      UPDATE public.website_product_variants wv
         SET stock_qty = wv.stock_qty + pv.qty, updated_at = v_now
        FROM per_variant pv
       WHERE wv.id = pv.variant_id
      RETURNING pv.qty
    )
    SELECT coalesce(sum(u.qty), 0)::integer INTO v_moved FROM upd u;

    IF v_moved > 0 THEN
      INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id)
      VALUES (CASE WHEN v_is_cash THEN 'cash_order' ELSE 'layaway_account' END, v_id,
              'page365_stock_released',
              jsonb_build_object('page365_no', v_no, 'from_status', v_old, 'to_status', v_new, 'pieces', v_moved),
              auth.uid());
    END IF;

  ELSIF v_old = ANY (v_dead) AND NOT (v_new = ANY (v_dead)) THEN
    -- Revived / reactivated / extension granted: take back what was released,
    -- if it is still there. D5: never raise — flag, and the status change stands.
    FOR v_row IN
      SELECT l.id, l.variant_id, l.quantity FROM public.page365_stock_lines l
       WHERE l.page365_no = v_no AND l.stock_state = 'released'
       ORDER BY l.line_no FOR UPDATE
    LOOP
      v_taken := 0;
      IF v_row.variant_id IS NOT NULL THEN
        UPDATE public.website_product_variants wv
           SET stock_qty = wv.stock_qty - v_row.quantity, updated_at = v_now
         WHERE wv.id = v_row.variant_id AND wv.stock_qty >= v_row.quantity;
        GET DIAGNOSTICS v_taken = ROW_COUNT;
      END IF;
      IF v_taken = 1 THEN
        UPDATE public.page365_stock_lines
           SET stock_state = 'held', held_at = v_now, released_at = NULL,
               flag = CASE WHEN flag = 'rehold_failed' THEN NULL ELSE flag END, updated_at = v_now
         WHERE id = v_row.id;
        v_moved := v_moved + v_row.quantity;
      ELSE
        UPDATE public.page365_stock_lines
           SET flag = 'rehold_failed', resolved_at = NULL, resolved_by = NULL,
               resolution_note = NULL, updated_at = v_now
         WHERE id = v_row.id;
        v_short := v_short + 1;
      END IF;
    END LOOP;

    IF v_moved > 0 OR v_short > 0 THEN
      INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id)
      VALUES (CASE WHEN v_is_cash THEN 'cash_order' ELSE 'layaway_account' END, v_id,
              'page365_stock_reheld',
              jsonb_build_object('page365_no', v_no, 'from_status', v_old, 'to_status', v_new,
                                 'pieces', v_moved, 'rehold_failed_lines', v_short),
              auth.uid());
    END IF;

    IF v_short > 0 THEN
      INSERT INTO public.staff_notifications (type, title, body, account_id, customer_id, invoice_number, metadata)
      VALUES ('page365_stock_flag', 'Page365 stock needs a look',
              v_short || ' piece(s) on revived Page365 invoice ' || v_no || ' are no longer in website stock.',
              CASE WHEN v_is_cash THEN NULL ELSE NEW.id END, NEW.customer_id, NEW.invoice_number,
              jsonb_build_object('page365_no', v_no, 'reason', 'rehold_failed',
                                 'order_kind', CASE WHEN v_is_cash THEN 'cash' ELSE 'layaway' END,
                                 'order_id', NEW.id,
                                 'cash_order_id', CASE WHEN v_is_cash THEN NEW.id END));
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.page365_stock_follow_order() FROM PUBLIC, anon, authenticated;

-- AFTER triggers: every BEFORE guard (prevent_paid_order_delete,
-- prevent_web_*_delete, status guards) has already passed, so stock only
-- moves on a change that is actually happening.
DROP TRIGGER IF EXISTS trg_page365_stock_follow_cash ON public.cash_orders;
CREATE TRIGGER trg_page365_stock_follow_cash
  AFTER UPDATE OF status ON public.cash_orders
  FOR EACH ROW EXECUTE FUNCTION public.page365_stock_follow_order();
DROP TRIGGER IF EXISTS trg_page365_stock_follow_cash_delete ON public.cash_orders;
CREATE TRIGGER trg_page365_stock_follow_cash_delete
  AFTER DELETE ON public.cash_orders
  FOR EACH ROW EXECUTE FUNCTION public.page365_stock_follow_order();
DROP TRIGGER IF EXISTS trg_page365_stock_follow_layaway ON public.layaway_accounts;
CREATE TRIGGER trg_page365_stock_follow_layaway
  AFTER UPDATE OF status ON public.layaway_accounts
  FOR EACH ROW EXECUTE FUNCTION public.page365_stock_follow_order();
DROP TRIGGER IF EXISTS trg_page365_stock_follow_layaway_delete ON public.layaway_accounts;
CREATE TRIGGER trg_page365_stock_follow_layaway_delete
  AFTER DELETE ON public.layaway_accounts
  FOR EACH ROW EXECUTE FUNCTION public.page365_stock_follow_order();

-- ---------------------------------------------------------------------------
-- 6. Staff resolve a flag. A note is required and audited; stock NEVER moves
--    here — the fix happens on Page365 or in the catalogue editor.
--    Same key as the Website → Page365 stock tab: manage_website_catalog.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_page365_stock_flag(p_line_id uuid, p_note text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid  uuid := auth.uid();
  v_hit  public.page365_stock_lines%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR NOT public.has_permission(v_uid, 'manage_website_catalog') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'forbidden');
  END IF;
  IF coalesce(btrim(p_note), '') = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'note_required');
  END IF;
  UPDATE public.page365_stock_lines l
     SET resolved_at = now(), resolved_by = v_uid, resolution_note = btrim(p_note), updated_at = now()
   WHERE l.id = p_line_id AND l.flag IS NOT NULL AND l.resolved_at IS NULL
  RETURNING l.* INTO v_hit;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_open');
  END IF;
  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id)
  VALUES ('page365_stock_line', v_hit.id, 'page365_stock_flag_resolved',
          jsonb_build_object('page365_no', v_hit.page365_no, 'line_no', v_hit.line_no,
                             'flag', v_hit.flag, 'note', v_hit.resolution_note), v_uid);
  RETURN jsonb_build_object('ok', true);
END
$fn$;
REVOKE ALL ON FUNCTION public.resolve_page365_stock_flag(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_page365_stock_flag(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 7. Self-check, still inside the transaction. Pure reads; any failure aborts
--    the whole file with nothing changed.
-- ---------------------------------------------------------------------------
DO $self$
DECLARE
  v_n integer;
  r   record;
BEGIN
  IF public.page365_first_word('  r1155 Ring K18') IS DISTINCT FROM 'R1155'
     OR public.page365_first_word(E'\u3000EM378\u3000Earrings') IS DISTINCT FROM 'EM378'
     OR public.page365_first_word(E'\tn4575\nNecklace') IS DISTINCT FROM 'N4575'
     OR public.page365_first_word('') IS NOT NULL
     OR public.page365_first_word(NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'page365_stock_sync self-check: page365_first_word is wrong';
  END IF;

  SELECT * INTO r FROM public.page365_match_line('ZZQ-PAGE365-SELFCHECK-NO-SUCH-CODE test');
  IF r.o_match_result <> 'unmatched' OR r.o_first_word <> 'ZZQ-PAGE365-SELFCHECK-NO-SUCH-CODE' THEN
    RAISE EXCEPTION 'page365_stock_sync self-check: page365_match_line did not report unmatched';
  END IF;

  SELECT count(*) INTO v_n FROM pg_trigger t
   WHERE NOT t.tgisinternal AND t.tgfoid = 'public.page365_stock_follow_order()'::regprocedure;
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'page365_stock_sync self-check: expected 4 follow triggers, found %', v_n;
  END IF;

  IF has_function_privilege('authenticated', 'public.page365_apply_stock(text,uuid,uuid,integer[],uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.page365_apply_stock(text,uuid,uuid,integer[],uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'page365_stock_sync self-check: page365_apply_stock is callable by a browser role';
  END IF;
  IF has_table_privilege('authenticated', 'public.page365_stock_lines', 'INSERT')
     OR has_table_privilege('authenticated', 'public.page365_stock_lines', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.page365_stock_lines', 'DELETE') THEN
    RAISE EXCEPTION 'page365_stock_sync self-check: authenticated can write the ledger';
  END IF;

  -- Informational: codes that collide case/space-insensitively flag as
  -- ambiguous_sku; products with 0 or 2+ variants flag as no_variant /
  -- ambiguous_variant. Neither blocks the migration.
  SELECT count(*) INTO v_n FROM (
    SELECT public.page365_first_word(sku) FROM public.website_products GROUP BY 1 HAVING count(*) > 1) s;
  RAISE NOTICE 'page365_stock_sync: % product code(s) collide case-insensitively (would flag ambiguous_sku)', v_n;
  SELECT count(*) INTO v_n FROM (
    SELECT wp.id FROM public.website_products wp
      LEFT JOIN public.website_product_variants wv ON wv.product_id = wp.id
     GROUP BY wp.id HAVING count(wv.id) <> 1) s;
  RAISE NOTICE 'page365_stock_sync: % product(s) with 0 or 2+ variants (would flag no_variant / ambiguous_variant)', v_n;
END
$self$;

COMMIT;

-- ===========================================================================
-- Verification (read-only). Run after COMMIT.
--
-- (1) Objects exist; expect: t | t | t | t | t | 4
-- SELECT to_regclass('public.page365_stock_lines') IS NOT NULL                                AS ledger,
--        to_regprocedure('public.page365_first_word(text)') IS NOT NULL                       AS first_word,
--        to_regprocedure('public.page365_match_line(text)') IS NOT NULL                       AS matcher,
--        to_regprocedure('public.page365_apply_stock(text,uuid,uuid,integer[],uuid)') IS NOT NULL AS apply,
--        to_regprocedure('public.resolve_page365_stock_flag(uuid,text)') IS NOT NULL          AS resolve,
--        (SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'trg_page365_stock_follow_%')     AS triggers;
--
-- (2) Nothing moved yet; expect: 0
-- SELECT count(*) FROM public.page365_stock_lines;
--
-- (3) The matcher on a real code (pick one from the catalogue); expect one row,
--     o_match_result = 'matched' for a single-variant product, else the reason.
-- SELECT * FROM public.page365_match_line('R1155 Ring PT900');
--
-- (4) Browser roles cannot apply stock or write the ledger; expect: f | f | f
-- SELECT has_function_privilege('authenticated','public.page365_apply_stock(text,uuid,uuid,integer[],uuid)','EXECUTE') AS auth_apply,
--        has_function_privilege('anon','public.page365_apply_stock(text,uuid,uuid,integer[],uuid)','EXECUTE')          AS anon_apply,
--        has_table_privilege('authenticated','public.page365_stock_lines','INSERT')                                     AS auth_insert;
-- ===========================================================================

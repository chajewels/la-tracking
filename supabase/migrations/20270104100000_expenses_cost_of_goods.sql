-- ============================================================================
-- Finance -> Expenses, Phase 5: real cost of goods / inventory (owner 2026-10-26, D1–D6 as recommended).
-- Plan: project doc claude/expenses-phase5-cogs-plan-2026-10-26.md. Branch feat/expenses. NOT APPLIED ANYWHERE.
--
-- What this does
--   * sale_costs: one yen cost per sale (layaway plan or cash order), set by finance (manage_expenses) through
--     set_sale_cost / import_sale_costs. The ONLY path for the ~95 % of sales that have no product line.
--   * cost_jpy snapshot on layaway_account_items / cash_order_items, copied from the product variant's
--     cost basis when the line is inserted (derived, never written by a client), immutable afterwards.
--   * Effective sale cost = sale_costs row, else the sum of complete item snapshots, else MISSING (no COGS
--     posts, the sale is listed for the owner). Never an estimate — the 15 % goes.
--   * Ledger: gl_current_events = gl_base_events (the Phase 2b body, renamed once) UNION gl_cogs_events:
--       cogs_sale          Dr 5100 / Cr 1300 at the sale date (first non-void payment), per sale with a cost
--       cogs_return        Dr 1300 / Cr 5100 when a forfeited / cancelled plan (or cancelled / expired order)
--                          puts the piece back, dated like the close event
--       trade_in_received  Dr 1310 / Cr 4100 trade_amount on date_trade (the trade credit is non-cash
--                          consideration; the new plan's price is already net of it)
--       trade_in_resold    Dr 5500 / Cr 1310 trade_amount when the trade-in is marked Sold (resold_at)
--   * "Inventory purchases" expenses now post to 1300 (asset) and "Trade-in buybacks" to 1310 (D2); the
--     cost reaches 5100 / 5500 only when the piece sells.
--   * Accounts the accountant's 試算表 (Sep 2026) uses and the Hub lacked: 1104 Kameari Shinkin,
--     1195 Suspense payments (仮払金), 2700 Short-term loans, 2750 Long-term loans, 2800 Withholding and
--     deposits received (預り金), 2900 Suspense receipts (仮受金), 6950 Interest paid — seeded so the
--     opening balance (F6) can be posted when the owner says so.
--   * RPCs: get_sales_costs(month), set_sale_cost, import_sale_costs, get_inventory_valuation, fc_real_profit
--     (replaces the 15 % tiles on the Executive Dashboard; the old fc_* functions are left untouched).
--
-- Rules kept: re-runnable; RLS as scalar sub-selects; REVOKE from PUBLIC/anon on every RPC; no "--" comment
-- lines inside any function body (Lovable strips them); costs never reach staff screens or the website.
-- ============================================================================

SET lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 1. Accounts the accountant uses (opening balance, F6).
-- ---------------------------------------------------------------------------
INSERT INTO public.gl_accounts (code, name, kind, contra, currency_hint, sort_order, system_key) VALUES
  ('1104', 'Kameari Shinkin Bank',                      'asset',     false, 'JPY', 55,  NULL),
  ('1195', 'Suspense payments (仮払金)',                 'asset',     false, 'JPY', 155, NULL),
  ('2700', 'Short-term loans',                          'liability', false, 'JPY', 370, NULL),
  ('2750', 'Long-term loans',                           'liability', false, 'JPY', 375, NULL),
  ('2800', 'Withholding and deposits received (預り金)', 'liability', false, 'JPY', 380, NULL),
  ('2900', 'Suspense receipts (仮受金)',                 'liability', false, 'JPY', 390, NULL),
  ('6950', 'Interest paid',                             'expense',   false, 'JPY', 805, NULL)
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Inventory purchases -> asset; trade-in buybacks -> trade-in inventory (D2).
-- ---------------------------------------------------------------------------
UPDATE public.expense_categories SET gl_account_code = '1300'
 WHERE group_key = 'cost_of_goods' AND name = 'Inventory purchases (supplier, gold, preloved buys)' AND gl_account_code IS DISTINCT FROM '1300';
UPDATE public.expense_categories SET gl_account_code = '1310'
 WHERE system_key = 'trade_in' AND gl_account_code IS DISTINCT FROM '1310';

-- ---------------------------------------------------------------------------
-- 3. Sale-level cost set by finance.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sale_costs (
  sale_type   text NOT NULL CHECK (sale_type IN ('layaway', 'cash_order')),
  sale_id     uuid NOT NULL,
  cost_jpy    numeric(15,0) NOT NULL CHECK (cost_jpy >= 0),
  note        text NULL CHECK (note IS NULL OR length(note) <= 500),
  set_by      uuid NULL,
  set_at      timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sale_type, sale_id)
);
ALTER TABLE public.sale_costs ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.sale_costs IS
  'Phase 5: the cost of the pieces in one sale (layaway plan or cash order), in yen, set by finance (set_sale_cost / import_sale_costs). Wins over the item-line snapshot. No row = cost from the item lines, or missing.';
DROP POLICY IF EXISTS sale_costs_read ON public.sale_costs;
CREATE POLICY sale_costs_read ON public.sale_costs FOR SELECT TO authenticated
  USING ((SELECT public.has_permission((SELECT auth.uid()), 'view_ledger')));
REVOKE ALL ON public.sale_costs FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.sale_costs FROM authenticated;
GRANT SELECT ON public.sale_costs TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Item-line cost snapshot (derived from the variant's cost basis at insert; immutable).
-- ---------------------------------------------------------------------------
ALTER TABLE public.layaway_account_items ADD COLUMN IF NOT EXISTS cost_jpy numeric(15,0) NULL CHECK (cost_jpy IS NULL OR cost_jpy >= 0);
ALTER TABLE public.cash_order_items      ADD COLUMN IF NOT EXISTS cost_jpy numeric(15,0) NULL CHECK (cost_jpy IS NULL OR cost_jpy >= 0);
COMMENT ON COLUMN public.layaway_account_items.cost_jpy IS 'Phase 5: unit cost in yen copied from website_product_variants.cost_basis when the line was inserted (trigger); never set by a client, never changed.';
COMMENT ON COLUMN public.cash_order_items.cost_jpy      IS 'Phase 5: unit cost in yen copied from website_product_variants.cost_basis when the line was inserted (trigger); never set by a client, never changed.';

CREATE OR REPLACE FUNCTION public.sale_items_snapshot_cost()
RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public'
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.cost_jpy := (SELECT v.cost_basis FROM public.website_product_variants v WHERE v.id = NEW.variant_id AND v.cost_basis IS NOT NULL AND v.cost_basis >= 0);
  ELSE
    NEW.cost_jpy := OLD.cost_jpy;
  END IF;
  RETURN NEW;
END
$fn$;
DROP TRIGGER IF EXISTS layaway_account_items_cost_snapshot ON public.layaway_account_items;
CREATE TRIGGER layaway_account_items_cost_snapshot BEFORE INSERT OR UPDATE ON public.layaway_account_items
  FOR EACH ROW EXECUTE FUNCTION public.sale_items_snapshot_cost();
DROP TRIGGER IF EXISTS cash_order_items_cost_snapshot ON public.cash_order_items;
CREATE TRIGGER cash_order_items_cost_snapshot BEFORE INSERT OR UPDATE ON public.cash_order_items
  FOR EACH ROW EXECUTE FUNCTION public.sale_items_snapshot_cost();

UPDATE public.layaway_account_items i SET cost_jpy = v.cost_basis
  FROM public.website_product_variants v
 WHERE v.id = i.variant_id AND i.cost_jpy IS NULL AND v.cost_basis IS NOT NULL AND v.cost_basis >= 0;
UPDATE public.cash_order_items i SET cost_jpy = v.cost_basis
  FROM public.website_product_variants v
 WHERE v.id = i.variant_id AND i.cost_jpy IS NULL AND v.cost_basis IS NOT NULL AND v.cost_basis >= 0;

-- ---------------------------------------------------------------------------
-- 5. Trade-ins: when was the piece resold (drives trade_in_resold).
-- ---------------------------------------------------------------------------
ALTER TABLE public.trade_ins ADD COLUMN IF NOT EXISTS resold_at timestamptz NULL;
COMMENT ON COLUMN public.trade_ins.resold_at IS 'Phase 5: set by trigger when resale_status becomes Sold (cleared when it goes back to In stock). Ledger event trade_in_resold is dated here.';

CREATE OR REPLACE FUNCTION public.trade_ins_track_resold()
RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public'
AS $fn$
BEGIN
  IF NEW.resale_status::text = 'Sold' THEN
    IF TG_OP = 'INSERT' OR OLD.resale_status::text <> 'Sold' OR NEW.resold_at IS NULL THEN
      NEW.resold_at := coalesce(NEW.resold_at, now());
    END IF;
  ELSE
    NEW.resold_at := NULL;
  END IF;
  RETURN NEW;
END
$fn$;
DROP TRIGGER IF EXISTS trade_ins_track_resold ON public.trade_ins;
CREATE TRIGGER trade_ins_track_resold BEFORE INSERT OR UPDATE ON public.trade_ins
  FOR EACH ROW EXECUTE FUNCTION public.trade_ins_track_resold();
UPDATE public.trade_ins SET resold_at = (date_trade::timestamp AT TIME ZONE 'Asia/Tokyo')
 WHERE resale_status::text = 'Sold' AND resold_at IS NULL;

-- ---------------------------------------------------------------------------
-- 6. Effective cost per sale (internal helpers).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gl_sale_costs()
RETURNS TABLE (sale_type text, sale_id uuid, cost_jpy numeric, cost_source text)
LANGUAGE sql STABLE SET search_path TO 'public'
AS $fn$
  WITH li AS (
    SELECT i.account_id AS sale_id, sum(i.cost_jpy * i.quantity) AS cost, bool_and(i.cost_jpy IS NOT NULL) AS complete
      FROM public.layaway_account_items i GROUP BY i.account_id),
  ci AS (
    SELECT i.cash_order_id AS sale_id, sum(i.cost_jpy * i.quantity) AS cost, bool_and(i.cost_jpy IS NOT NULL) AS complete
      FROM public.cash_order_items i GROUP BY i.cash_order_id)
  SELECT 'layaway', la.id,
         coalesce(sc.cost_jpy, CASE WHEN li.complete THEN li.cost END),
         CASE WHEN sc.sale_id IS NOT NULL THEN 'manual' WHEN li.complete THEN 'items' END
    FROM public.layaway_accounts la
    LEFT JOIN public.sale_costs sc ON sc.sale_type = 'layaway' AND sc.sale_id = la.id
    LEFT JOIN li ON li.sale_id = la.id
  UNION ALL
  SELECT 'cash_order', co.id,
         coalesce(sc.cost_jpy, CASE WHEN ci.complete THEN ci.cost END),
         CASE WHEN sc.sale_id IS NOT NULL THEN 'manual' WHEN ci.complete THEN 'items' END
    FROM public.cash_orders co
    LEFT JOIN public.sale_costs sc ON sc.sale_type = 'cash_order' AND sc.sale_id = co.id
    LEFT JOIN ci ON ci.sale_id = co.id
$fn$;
REVOKE ALL ON FUNCTION public.gl_sale_costs() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.gl_sale_costs() IS 'Internal: effective yen cost per sale — finance-set sale_costs, else complete item snapshots, else NULL (missing).';

-- ---------------------------------------------------------------------------
-- 7. Ledger events. The Phase 2b body becomes gl_base_events (renamed once); gl_current_events is now the
--    union of the base events and the cost-of-goods events below.
-- ---------------------------------------------------------------------------
DO $do$
BEGIN
  IF to_regprocedure('public.gl_base_events(date)') IS NULL THEN
    ALTER FUNCTION public.gl_current_events(date) RENAME TO gl_base_events;
  END IF;
END
$do$;
REVOKE ALL ON FUNCTION public.gl_base_events(date) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.gl_base_events(date) IS
  'Internal: the Phase 2b–4 money events (sales, payments, closes, store credit, expenses, amortisation, refunds). gl_current_events = these UNION gl_cogs_events.';

CREATE OR REPLACE FUNCTION public.gl_cogs_events(p_until date)
RETURNS TABLE (source_type text, source_id uuid, source_date date, description text, lines jsonb,
               customer_id uuid, account_id uuid, cash_order_id uuid, expense_id uuid)
LANGUAGE sql STABLE SET search_path TO 'public'
AS $fn$
  WITH s AS (SELECT public.gl_ledger_start() AS start_date),
  first_pay AS (
    SELECT p.account_id, min(p.date_paid) AS first_date
      FROM public.payments p WHERE p.voided_at IS NULL GROUP BY p.account_id),
  first_cash_pay AS (
    SELECT cp.cash_order_id, min(cp.date_paid) AS first_date
      FROM public.cash_payments cp WHERE cp.voided_at IS NULL GROUP BY cp.cash_order_id),
  costs AS (SELECT * FROM public.gl_sale_costs() WHERE cost_jpy IS NOT NULL AND cost_jpy > 0)

  SELECT 'cogs_sale', md5('cogs:layaway:' || la.id::text)::uuid, fp.first_date,
         'Cost of pieces sold ' || la.invoice_number,
         jsonb_build_array(
           jsonb_build_object('a', '5100', 'side', 'dr', 'amt', c.cost_jpy, 'cur', 'JPY', 'memo', la.invoice_number || ' (' || c.cost_source || ')'),
           jsonb_build_object('a', '1300', 'side', 'cr', 'amt', c.cost_jpy, 'cur', 'JPY', 'memo', 'Piece out of stock')),
         la.customer_id, la.id, NULL::uuid, NULL::uuid
    FROM public.layaway_accounts la
    JOIN first_pay fp ON fp.account_id = la.id
    JOIN costs c ON c.sale_type = 'layaway' AND c.sale_id = la.id
    CROSS JOIN s
   WHERE la.is_test = false AND la.total_amount > 0
     AND fp.first_date >= s.start_date AND fp.first_date <= p_until

  UNION ALL
  SELECT 'cogs_sale', md5('cogs:cash_order:' || co.id::text)::uuid, fcp.first_date,
         'Cost of pieces sold ' || co.invoice_number,
         jsonb_build_array(
           jsonb_build_object('a', '5100', 'side', 'dr', 'amt', c.cost_jpy, 'cur', 'JPY', 'memo', co.invoice_number || ' (' || c.cost_source || ')'),
           jsonb_build_object('a', '1300', 'side', 'cr', 'amt', c.cost_jpy, 'cur', 'JPY', 'memo', 'Piece out of stock')),
         co.customer_id, NULL::uuid, co.id, NULL::uuid
    FROM public.cash_orders co
    JOIN first_cash_pay fcp ON fcp.cash_order_id = co.id
    JOIN costs c ON c.sale_type = 'cash_order' AND c.sale_id = co.id
    CROSS JOIN s
   WHERE co.is_test = false AND co.total_amount > 0
     AND fcp.first_date >= s.start_date AND fcp.first_date <= p_until

  UNION ALL
  SELECT 'cogs_return', md5('cogs_return:layaway:' || la.id::text)::uuid,
         coalesce((coalesce(la.forfeited_at, la.cancelled_at) AT TIME ZONE 'Asia/Tokyo')::date, (la.updated_at AT TIME ZONE 'Asia/Tokyo')::date),
         'Piece back in stock ' || la.invoice_number,
         jsonb_build_array(
           jsonb_build_object('a', '1300', 'side', 'dr', 'amt', c.cost_jpy, 'cur', 'JPY', 'memo', 'Piece back in stock'),
           jsonb_build_object('a', '5100', 'side', 'cr', 'amt', c.cost_jpy, 'cur', 'JPY', 'memo', la.invoice_number)),
         la.customer_id, la.id, NULL::uuid, NULL::uuid
    FROM public.layaway_accounts la
    JOIN first_pay fp ON fp.account_id = la.id
    JOIN costs c ON c.sale_type = 'layaway' AND c.sale_id = la.id
    CROSS JOIN s
   WHERE la.is_test = false AND la.total_amount > 0
     AND fp.first_date >= s.start_date
     AND la.status IN ('forfeited', 'final_forfeited', 'cancelled')
     AND coalesce((coalesce(la.forfeited_at, la.cancelled_at) AT TIME ZONE 'Asia/Tokyo')::date, (la.updated_at AT TIME ZONE 'Asia/Tokyo')::date) BETWEEN s.start_date AND p_until

  UNION ALL
  SELECT 'cogs_return', md5('cogs_return:cash_order:' || co.id::text)::uuid,
         coalesce((coalesce(co.cancelled_at, co.expired_at) AT TIME ZONE 'Asia/Tokyo')::date, (co.updated_at AT TIME ZONE 'Asia/Tokyo')::date),
         'Piece back in stock ' || co.invoice_number,
         jsonb_build_array(
           jsonb_build_object('a', '1300', 'side', 'dr', 'amt', c.cost_jpy, 'cur', 'JPY', 'memo', 'Piece back in stock'),
           jsonb_build_object('a', '5100', 'side', 'cr', 'amt', c.cost_jpy, 'cur', 'JPY', 'memo', co.invoice_number)),
         co.customer_id, NULL::uuid, co.id, NULL::uuid
    FROM public.cash_orders co
    JOIN first_cash_pay fcp ON fcp.cash_order_id = co.id
    JOIN costs c ON c.sale_type = 'cash_order' AND c.sale_id = co.id
    CROSS JOIN s
   WHERE co.is_test = false AND co.total_amount > 0
     AND fcp.first_date >= s.start_date
     AND co.status IN ('cancelled', 'expired')
     AND coalesce((coalesce(co.cancelled_at, co.expired_at) AT TIME ZONE 'Asia/Tokyo')::date, (co.updated_at AT TIME ZONE 'Asia/Tokyo')::date) BETWEEN s.start_date AND p_until

  UNION ALL
  SELECT 'trade_in_received', md5('trade_in:' || t.id::text)::uuid, t.date_trade,
         'Trade-in received ' || t.item_code || coalesce(' (new invoice ' || nullif(t.new_invoice_number, '') || ')', ''),
         jsonb_build_array(
           jsonb_build_object('a', '1310', 'side', 'dr', 'amt', t.trade_amount, 'cur', 'JPY', 'memo', t.item_description),
           jsonb_build_object('a', '4100', 'side', 'cr', 'amt', t.trade_amount, 'cur', 'JPY', 'memo', 'Trade credit on ' || coalesce(nullif(t.new_invoice_number, ''), 'new purchase'))),
         t.customer_id, NULL::uuid, NULL::uuid, NULL::uuid
    FROM public.trade_ins t
    CROSS JOIN s
   WHERE t.trade_amount > 0 AND t.date_trade >= s.start_date AND t.date_trade <= p_until

  UNION ALL
  SELECT 'trade_in_resold', md5('trade_in_sold:' || t.id::text)::uuid, (t.resold_at AT TIME ZONE 'Asia/Tokyo')::date,
         'Trade-in resold ' || t.item_code,
         jsonb_build_array(
           jsonb_build_object('a', '5500', 'side', 'dr', 'amt', t.trade_amount, 'cur', 'JPY', 'memo', t.item_description),
           jsonb_build_object('a', '1310', 'side', 'cr', 'amt', t.trade_amount, 'cur', 'JPY', 'memo', 'Trade-in out of stock')),
         t.customer_id, NULL::uuid, NULL::uuid, NULL::uuid
    FROM public.trade_ins t
    CROSS JOIN s
   WHERE t.trade_amount > 0 AND t.resale_status::text = 'Sold' AND t.resold_at IS NOT NULL
     AND (t.resold_at AT TIME ZONE 'Asia/Tokyo')::date >= s.start_date
     AND (t.resold_at AT TIME ZONE 'Asia/Tokyo')::date <= p_until
$fn$;
REVOKE ALL ON FUNCTION public.gl_cogs_events(date) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.gl_cogs_events(date) IS
  'Internal (Phase 5): cost-of-goods events — cogs_sale, cogs_return, trade_in_received, trade_in_resold. Sale cost from gl_sale_costs(); sales without a cost produce no event.';

CREATE OR REPLACE FUNCTION public.gl_current_events(p_until date)
RETURNS TABLE (source_type text, source_id uuid, source_date date, description text, lines jsonb,
               customer_id uuid, account_id uuid, cash_order_id uuid, expense_id uuid)
LANGUAGE sql STABLE SET search_path TO 'public'
AS $fn$
  SELECT * FROM public.gl_base_events(p_until)
  UNION ALL
  SELECT * FROM public.gl_cogs_events(p_until)
$fn$;
REVOKE ALL ON FUNCTION public.gl_current_events(date) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.gl_current_events(date) IS
  'Internal: every Hub money event the ledger should hold up to p_until — gl_base_events (Phases 2b–4) UNION gl_cogs_events (Phase 5). gl_post_pending diffs this against the live auto journals.';

-- ---------------------------------------------------------------------------
-- 8. RPCs for Finance -> Ledger -> Cost of goods.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_sales_costs(p_month date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_month date := date_trunc('month', coalesce(p_month, (now() AT TIME ZONE 'Asia/Tokyo')::date))::date;
  v_next date;
  v_start date := public.gl_ledger_start();
  v_rate numeric := public.gl_rate();
  v_sales jsonb;
  v_older integer := 0;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'view_ledger') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  v_next := (v_month + interval '1 month')::date;

  WITH first_pay AS (
    SELECT p.account_id, min(p.date_paid) AS first_date FROM public.payments p WHERE p.voided_at IS NULL GROUP BY p.account_id),
  first_cash_pay AS (
    SELECT cp.cash_order_id, min(cp.date_paid) AS first_date FROM public.cash_payments cp WHERE cp.voided_at IS NULL GROUP BY cp.cash_order_id),
  costs AS (SELECT * FROM public.gl_sale_costs()),
  li AS (
    SELECT i.account_id AS sale_id,
           jsonb_agg(jsonb_build_object('title', i.title, 'sku', i.sku, 'quantity', i.quantity, 'unit_price_jpy', i.unit_price_jpy, 'cost_jpy', i.cost_jpy) ORDER BY i.created_at) AS items
      FROM public.layaway_account_items i GROUP BY i.account_id),
  ci AS (
    SELECT i.cash_order_id AS sale_id,
           jsonb_agg(jsonb_build_object('title', i.title, 'sku', i.sku, 'quantity', i.quantity, 'unit_price_jpy', i.unit_price_jpy, 'cost_jpy', i.cost_jpy) ORDER BY i.created_at) AS items
      FROM public.cash_order_items i GROUP BY i.cash_order_id),
  sales AS (
    SELECT 'layaway' AS sale_type, la.id, la.invoice_number, fp.first_date AS sale_date, la.status::text AS status, la.currency::text AS currency,
           la.total_amount AS revenue, public.gl_to_jpy(la.total_amount, la.currency::text, v_rate) AS revenue_jpy,
           c.cost_jpy, c.cost_source, sc.note, li.items, la.customer_id, la.is_trade
      FROM public.layaway_accounts la
      JOIN first_pay fp ON fp.account_id = la.id
      LEFT JOIN costs c ON c.sale_type = 'layaway' AND c.sale_id = la.id
      LEFT JOIN public.sale_costs sc ON sc.sale_type = 'layaway' AND sc.sale_id = la.id
      LEFT JOIN li ON li.sale_id = la.id
     WHERE la.is_test = false AND la.total_amount > 0
    UNION ALL
    SELECT 'cash_order', co.id, co.invoice_number, fcp.first_date, co.status::text, co.currency::text,
           co.total_amount, public.gl_to_jpy(co.total_amount, co.currency::text, v_rate),
           c.cost_jpy, c.cost_source, sc.note, coalesce(ci.items, CASE WHEN nullif(co.item_description, '') IS NOT NULL THEN jsonb_build_array(jsonb_build_object('title', co.item_description)) END),
           co.customer_id, co.is_trade
      FROM public.cash_orders co
      JOIN first_cash_pay fcp ON fcp.cash_order_id = co.id
      LEFT JOIN costs c ON c.sale_type = 'cash_order' AND c.sale_id = co.id
      LEFT JOIN public.sale_costs sc ON sc.sale_type = 'cash_order' AND sc.sale_id = co.id
      LEFT JOIN ci ON ci.sale_id = co.id
     WHERE co.is_test = false AND co.total_amount > 0)
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'sale_type', s.sale_type, 'id', s.id, 'invoice_number', s.invoice_number, 'sale_date', s.sale_date, 'status', s.status,
           'currency', s.currency, 'revenue', s.revenue, 'revenue_jpy', s.revenue_jpy, 'cost_jpy', s.cost_jpy, 'cost_source', s.cost_source,
           'note', s.note, 'items', coalesce(s.items, '[]'::jsonb), 'customer_id', s.customer_id, 'is_trade', s.is_trade)
           ORDER BY s.sale_date, s.invoice_number), '[]'::jsonb),
         (SELECT count(*) FROM sales o WHERE o.cost_jpy IS NULL AND v_start IS NOT NULL AND o.sale_date >= v_start AND o.sale_date < v_month)
    INTO v_sales, v_older
    FROM sales s
   WHERE s.sale_date >= v_month AND s.sale_date < v_next;

  RETURN jsonb_build_object(
    'month', v_month,
    'ledger_start', v_start,
    'can_set', public.has_permission(v_uid, 'manage_expenses'),
    'sales', v_sales,
    'missing_count', (SELECT count(*) FROM jsonb_array_elements(v_sales) x WHERE x->>'cost_jpy' IS NULL),
    'older_missing_count', v_older,
    'revenue_jpy', (SELECT coalesce(sum((x->>'revenue_jpy')::numeric), 0) FROM jsonb_array_elements(v_sales) x),
    'cost_jpy', (SELECT coalesce(sum((x->>'cost_jpy')::numeric), 0) FROM jsonb_array_elements(v_sales) x));
END
$fn$;
REVOKE ALL ON FUNCTION public.get_sales_costs(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_sales_costs(date) TO authenticated;
COMMENT ON FUNCTION public.get_sales_costs(date) IS
  'Finance -> Ledger -> Cost of goods: every sale booked in the month (first non-void payment) with its revenue, effective cost and source (manual / items / missing), plus how many older sales since the ledger start still lack a cost. view_ledger.';

CREATE OR REPLACE FUNCTION public.set_sale_cost(p_sale_type text, p_sale_id uuid, p_cost_jpy numeric, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_old public.sale_costs;
  v_new public.sale_costs;
  v_invoice text;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'manage_expenses') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF p_sale_type NOT IN ('layaway', 'cash_order') OR p_sale_id IS NULL THEN RETURN jsonb_build_object('error', 'invalid_sale'); END IF;
  IF p_sale_type = 'layaway' THEN
    SELECT la.invoice_number INTO v_invoice FROM public.layaway_accounts la WHERE la.id = p_sale_id AND la.is_test = false;
  ELSE
    SELECT co.invoice_number INTO v_invoice FROM public.cash_orders co WHERE co.id = p_sale_id AND co.is_test = false;
  END IF;
  IF v_invoice IS NULL THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF p_cost_jpy IS NOT NULL AND (p_cost_jpy < 0 OR p_cost_jpy > 1000000000 OR p_cost_jpy <> round(p_cost_jpy)) THEN
    RETURN jsonb_build_object('error', 'invalid_amount');
  END IF;
  IF p_note IS NOT NULL AND length(p_note) > 500 THEN RETURN jsonb_build_object('error', 'invalid_note'); END IF;

  SELECT * INTO v_old FROM public.sale_costs sc WHERE sc.sale_type = p_sale_type AND sc.sale_id = p_sale_id FOR UPDATE;
  IF p_cost_jpy IS NULL THEN
    IF v_old.sale_id IS NULL THEN RETURN jsonb_build_object('ok', true, 'cleared', false); END IF;
    DELETE FROM public.sale_costs sc WHERE sc.sale_type = p_sale_type AND sc.sale_id = p_sale_id;
    INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
    VALUES ('sale_cost', p_sale_id, 'clear_sale_cost', to_jsonb(v_old), jsonb_build_object('invoice_number', v_invoice), v_uid, now());
    RETURN jsonb_build_object('ok', true, 'cleared', true);
  END IF;
  INSERT INTO public.sale_costs (sale_type, sale_id, cost_jpy, note, set_by, set_at)
  VALUES (p_sale_type, p_sale_id, p_cost_jpy, nullif(btrim(p_note), ''), v_uid, now())
  ON CONFLICT (sale_type, sale_id) DO UPDATE SET cost_jpy = EXCLUDED.cost_jpy, note = EXCLUDED.note, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at
  RETURNING * INTO v_new;
  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('sale_cost', p_sale_id, CASE WHEN v_old.sale_id IS NULL THEN 'set_sale_cost' ELSE 'change_sale_cost' END,
          CASE WHEN v_old.sale_id IS NULL THEN NULL ELSE to_jsonb(v_old) END, to_jsonb(v_new) || jsonb_build_object('invoice_number', v_invoice), v_uid, now());
  RETURN jsonb_build_object('ok', true, 'cost', to_jsonb(v_new));
END
$fn$;
REVOKE ALL ON FUNCTION public.set_sale_cost(text, uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_sale_cost(text, uuid, numeric, text) TO authenticated;
COMMENT ON FUNCTION public.set_sale_cost(text, uuid, numeric, text) IS
  'Phase 5: set (or clear with NULL) the yen cost of one sale. manage_expenses. Audited; the ledger re-posts cogs_sale on the next run.';

CREATE OR REPLACE FUNCTION public.import_sale_costs(p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  r jsonb;
  v_inv text;
  v_cost numeric;
  v_note text;
  v_la uuid;
  v_co uuid;
  v_type text;
  v_id uuid;
  v_r jsonb;
  v_set integer := 0;
  v_replaced integer := 0;
  v_not_found text[] := '{}';
  v_ambiguous text[] := '{}';
  v_invalid text[] := '{}';
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'manage_expenses') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 OR jsonb_array_length(p_rows) > 2000 THEN
    RETURN jsonb_build_object('error', 'invalid_rows');
  END IF;
  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    v_inv := nullif(btrim(coalesce(r->>'invoice_number', '')), '');
    v_note := nullif(left(btrim(coalesce(r->>'note', '')), 500), '');
    BEGIN
      v_cost := nullif(regexp_replace(coalesce(r->>'cost_jpy', ''), '[^0-9.]', '', 'g'), '')::numeric;
    EXCEPTION WHEN OTHERS THEN v_cost := NULL; END;
    IF v_inv IS NULL OR v_cost IS NULL OR v_cost < 0 OR v_cost > 1000000000 OR v_cost <> round(v_cost) THEN
      v_invalid := v_invalid || coalesce(v_inv, '(blank)');
      CONTINUE;
    END IF;
    SELECT la.id INTO v_la FROM public.layaway_accounts la WHERE la.invoice_number = v_inv AND la.is_test = false LIMIT 1;
    SELECT co.id INTO v_co FROM public.cash_orders co WHERE co.invoice_number = v_inv AND co.is_test = false LIMIT 1;
    IF v_la IS NOT NULL AND v_co IS NOT NULL THEN v_ambiguous := v_ambiguous || v_inv; CONTINUE; END IF;
    IF v_la IS NULL AND v_co IS NULL THEN v_not_found := v_not_found || v_inv; CONTINUE; END IF;
    v_type := CASE WHEN v_la IS NOT NULL THEN 'layaway' ELSE 'cash_order' END;
    v_id := coalesce(v_la, v_co);
    IF EXISTS (SELECT 1 FROM public.sale_costs sc WHERE sc.sale_type = v_type AND sc.sale_id = v_id) THEN v_replaced := v_replaced + 1; ELSE v_set := v_set + 1; END IF;
    v_r := public.set_sale_cost(v_type, v_id, v_cost, v_note);
    IF v_r->>'ok' IS DISTINCT FROM 'true' THEN v_invalid := v_invalid || (v_inv || ': ' || coalesce(v_r->>'error', 'failed')); END IF;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'set', v_set, 'replaced', v_replaced,
                            'not_found', to_jsonb(v_not_found), 'ambiguous', to_jsonb(v_ambiguous), 'invalid', to_jsonb(v_invalid));
END
$fn$;
REVOKE ALL ON FUNCTION public.import_sale_costs(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.import_sale_costs(jsonb) TO authenticated;
COMMENT ON FUNCTION public.import_sale_costs(jsonb) IS
  'Phase 5: bulk-set sale costs from rows [{invoice_number, cost_jpy, note}] (≤ 2000). Matches layaway then cash-order invoice numbers; reports set / replaced / not_found / ambiguous / invalid. manage_expenses.';

CREATE OR REPLACE FUNCTION public.get_inventory_valuation()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_bal_1300 numeric;
  v_bal_1310 numeric;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'view_ledger') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  SELECT coalesce(sum(l.debit_jpy) - sum(l.credit_jpy), 0) INTO v_bal_1300 FROM public.gl_journal_lines l WHERE l.account_code = '1300';
  SELECT coalesce(sum(l.debit_jpy) - sum(l.credit_jpy), 0) INTO v_bal_1310 FROM public.gl_journal_lines l WHERE l.account_code = '1310';
  RETURN jsonb_build_object(
    'ledger_start', public.gl_ledger_start(),
    'stock_units', (SELECT coalesce(sum(v.stock_qty), 0) FROM public.website_product_variants v),
    'stock_units_with_cost', (SELECT coalesce(sum(v.stock_qty), 0) FROM public.website_product_variants v WHERE v.cost_basis IS NOT NULL),
    'variants_in_stock_without_cost', (SELECT count(*) FROM public.website_product_variants v WHERE v.stock_qty > 0 AND v.cost_basis IS NULL),
    'stock_at_cost_jpy', (SELECT coalesce(sum(v.stock_qty * v.cost_basis), 0) FROM public.website_product_variants v WHERE v.cost_basis IS NOT NULL),
    'trade_ins_in_stock', (SELECT count(*) FROM public.trade_ins t WHERE t.resale_status::text = 'In stock'),
    'trade_ins_in_stock_jpy', (SELECT coalesce(sum(t.trade_amount), 0) FROM public.trade_ins t WHERE t.resale_status::text = 'In stock'),
    'ledger_inventory_jpy', v_bal_1300,
    'ledger_trade_in_jpy', v_bal_1310,
    'difference_jpy', (SELECT coalesce(sum(v.stock_qty * v.cost_basis), 0) FROM public.website_product_variants v WHERE v.cost_basis IS NOT NULL) - v_bal_1300);
END
$fn$;
REVOKE ALL ON FUNCTION public.get_inventory_valuation() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_inventory_valuation() TO authenticated;
COMMENT ON FUNCTION public.get_inventory_valuation() IS
  'Phase 5: stock on hand at cost (variants with a cost basis) vs the ledger''s 1300 / 1310 balances, with how much stock has no cost yet. view_ledger. The difference is for the owner / 税理士 to post as a stock-count adjustment (manual journal 5900).';

CREATE OR REPLACE FUNCTION public.fc_real_profit(p_from date DEFAULT NULL, p_to date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_start date := public.gl_ledger_start();
  v_from date;
  v_to date := coalesce(p_to, (now() AT TIME ZONE 'Asia/Tokyo')::date);
  v_rev numeric := 0;
  v_cogs numeric := 0;
  v_total integer := 0;
  v_with integer := 0;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'view_ledger') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF v_start IS NULL THEN RETURN jsonb_build_object('ledger_started', false); END IF;
  v_from := coalesce(p_from, v_start);
  SELECT coalesce(sum(l.credit_jpy) - sum(l.debit_jpy), 0) INTO v_rev
    FROM public.gl_journal_lines l JOIN public.gl_journals j ON j.id = l.journal_id JOIN public.gl_accounts a ON a.code = l.account_code
   WHERE a.kind = 'revenue' AND j.entry_date BETWEEN v_from AND v_to;
  SELECT coalesce(sum(l.debit_jpy) - sum(l.credit_jpy), 0) INTO v_cogs
    FROM public.gl_journal_lines l JOIN public.gl_journals j ON j.id = l.journal_id JOIN public.gl_accounts a ON a.code = l.account_code
   WHERE a.kind = 'cogs' AND j.entry_date BETWEEN v_from AND v_to;
  WITH first_pay AS (SELECT p.account_id, min(p.date_paid) AS d FROM public.payments p WHERE p.voided_at IS NULL GROUP BY 1),
  first_cash_pay AS (SELECT cp.cash_order_id, min(cp.date_paid) AS d FROM public.cash_payments cp WHERE cp.voided_at IS NULL GROUP BY 1),
  costs AS (SELECT * FROM public.gl_sale_costs()),
  sales AS (
    SELECT c.cost_jpy FROM public.layaway_accounts la JOIN first_pay fp ON fp.account_id = la.id LEFT JOIN costs c ON c.sale_type = 'layaway' AND c.sale_id = la.id
     WHERE la.is_test = false AND la.total_amount > 0 AND fp.d BETWEEN v_from AND v_to
    UNION ALL
    SELECT c.cost_jpy FROM public.cash_orders co JOIN first_cash_pay fcp ON fcp.cash_order_id = co.id LEFT JOIN costs c ON c.sale_type = 'cash_order' AND c.sale_id = co.id
     WHERE co.is_test = false AND co.total_amount > 0 AND fcp.d BETWEEN v_from AND v_to)
  SELECT count(*), count(*) FILTER (WHERE cost_jpy IS NOT NULL) INTO v_total, v_with FROM sales;
  RETURN jsonb_build_object(
    'ledger_started', true, 'from', v_from, 'to', v_to,
    'revenue_jpy', v_rev, 'cogs_jpy', v_cogs, 'gross_profit_jpy', v_rev - v_cogs,
    'sales_total', v_total, 'sales_with_cost', v_with,
    'inventory_jpy', (SELECT coalesce(sum(l.debit_jpy) - sum(l.credit_jpy), 0) FROM public.gl_journal_lines l WHERE l.account_code IN ('1300', '1310')));
END
$fn$;
REVOKE ALL ON FUNCTION public.fc_real_profit(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fc_real_profit(date, date) TO authenticated;
COMMENT ON FUNCTION public.fc_real_profit(date, date) IS
  'Phase 5: real gross profit from posted journals (revenue − cost of sales) for the Executive Dashboard, with how many sales in the window have a known cost and the inventory balance. Replaces the 15 % tiles. view_ledger.';

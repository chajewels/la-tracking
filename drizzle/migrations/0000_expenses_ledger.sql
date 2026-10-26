-- Finance -> Expenses, Phase 1: the expenses ledger (owner decisions 2026-10-25).
--
--   * One set of books: Cha Jewels Japan. Each expense keeps its own currency (JPY or PHP);
--     amount_jpy is what every total and report reads.
--   * PHP -> JPY uses the ONE PESO RATE, system_settings.php_jpy_rate (CLAUDE.md "CURRENCY
--     CONVERSION STANDARD": JPY = PHP / rate, rounded). fx_rates is retired and is not read.
--     The rate used is stored on the row (fx_php_per_jpy); it is re-read on every write while
--     the row is a draft, including the approve write, and is frozen from then on.
--   * Categories: the owner's locked list (8 groups, 28 subcategories). system_key is reserved
--     for later phases that book automatically (payroll, commission, bonus, provider fees).
--   * Every expense starts as a draft. Only approved rows count in totals. Approved rows are
--     locked; a wrong row is voided with a reason. Nothing is ever deleted.
--   * (source, source_ref) is unique among non-void rows, so a payroll month, a recurring bill
--     or an email can never be booked twice — but a VOIDED booking can be booked again.
--   * details (jsonb object) holds the breakdown behind an automatic booking (per-person
--     payroll lines, per-agent commission lines); NULL for hand entries.
--   * The tables have NO write policies. They are written only through upsert_expense,
--     attach_expense_receipt, approve_expense and void_expense (SECURITY DEFINER, permission
--     checked, one audit_logs row each). A guard trigger also refuses edits to approved/void
--     rows and every DELETE, whoever runs them.
--   * Permission keys: manage_expenses (enter / edit drafts / attach receipts) and
--     approve_expenses (approve / void). Admin = true; staff, finance, csr, live_agent = false.
--   * Receipts: private bucket expense-receipts, path <expense_id>/<file>. Read needs
--     manage_expenses or approve_expenses; upload needs manage_expenses AND the folder must be
--     an existing DRAFT expense; no update, no delete (a replaced receipt stays in the bucket).
--   * Staff payroll and Sales commission cannot be entered by hand (category_booked_automatically):
--     Phase 2 books them from Timesheet / Commissions, and a manual row would count twice.
--   * Table writes are revoked from PUBLIC/anon/authenticated and TRUNCATE is refused by a
--     statement trigger, so the never-delete rule holds even outside PostgREST.
--
--   New objects only; nothing existing is changed. Re-runnable (IF NOT EXISTS / ON CONFLICT /
--   catalog-checked policies). No comment lines inside any function body (Lovable strips them).

SET lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 1. Tables.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.expense_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_key   text NOT NULL CHECK (group_key IN ('people', 'cost_of_goods', 'marketing', 'payment_fees',
                                                 'shipping', 'tech', 'office', 'professional')),
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  sort_order  integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  system_key  text NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT expense_categories_group_name_uq UNIQUE (group_key, name)
);
CREATE UNIQUE INDEX IF NOT EXISTS expense_categories_system_key_uq
  ON public.expense_categories (system_key) WHERE system_key IS NOT NULL;
ALTER TABLE public.expense_categories ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.expense_categories IS
  'Expense categories (owner list 2026-10-25): 8 groups, 28 subcategories. system_key links a category to an automatic booking source in later phases. Read by expense managers/approvers; no write policies.';

CREATE TABLE IF NOT EXISTS public.expense_vendors (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  default_category_id  uuid NULL REFERENCES public.expense_categories(id),
  active               boolean NOT NULL DEFAULT true,
  created_by           uuid NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS expense_vendors_name_uq ON public.expense_vendors (lower(btrim(name)));
ALTER TABLE public.expense_vendors ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.expense_vendors IS
  'Who an expense was paid to (Vercel, BDO, the tax accountant...). Name unique case-insensitively. Created through upsert_expense; no write policies.';

CREATE TABLE IF NOT EXISTS public.expenses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_date    date NOT NULL,
  category_id     uuid NOT NULL REFERENCES public.expense_categories(id),
  vendor_id       uuid NULL REFERENCES public.expense_vendors(id),
  description     text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 500),
  currency        text NOT NULL CHECK (currency IN ('JPY', 'PHP')),
  amount          numeric(14,2) NOT NULL CHECK (amount > 0 AND amount <= 10000000000),
  fx_php_per_jpy  numeric(12,6) NULL CHECK (fx_php_per_jpy IS NULL OR fx_php_per_jpy > 0),
  amount_jpy      numeric(14,0) NOT NULL CHECK (amount_jpy >= 0),
  payment_method  text NOT NULL DEFAULT 'bank_transfer'
                  CHECK (payment_method IN ('bank_transfer', 'card', 'cash', 'auto_debit', 'other')),
  receipt_path    text NULL,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'void')),
  source          text NOT NULL DEFAULT 'manual'
                  CHECK (source IN ('manual', 'recurring', 'email', 'payroll', 'commission', 'system')),
  source_ref      text NULL,
  notes           text NULL CHECK (notes IS NULL OR length(notes) <= 2000),
  details         jsonb NULL CHECK (details IS NULL OR jsonb_typeof(details) = 'object'),
  created_by      uuid NULL,
  approved_by     uuid NULL,
  approved_at     timestamptz NULL,
  voided_by       uuid NULL,
  voided_at       timestamptz NULL,
  void_reason     text NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT expenses_currency_rate CHECK ((currency = 'JPY' AND fx_php_per_jpy IS NULL)
                                        OR (currency = 'PHP' AND fx_php_per_jpy IS NOT NULL)),
  CONSTRAINT expenses_receipt_path CHECK (receipt_path IS NULL OR receipt_path LIKE id::text || '/%'),
  CONSTRAINT expenses_approved_fields CHECK (status <> 'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  CONSTRAINT expenses_void_fields CHECK (status <> 'void'
                                      OR (voided_by IS NOT NULL AND voided_at IS NOT NULL
                                          AND length(btrim(coalesce(void_reason, ''))) >= 3))
);
CREATE UNIQUE INDEX IF NOT EXISTS expenses_source_ref_uq
  ON public.expenses (source, source_ref) WHERE source_ref IS NOT NULL AND status <> 'void';
CREATE INDEX IF NOT EXISTS expenses_date_idx ON public.expenses (expense_date DESC);
CREATE INDEX IF NOT EXISTS expenses_category_idx ON public.expenses (category_id);
CREATE INDEX IF NOT EXISTS expenses_vendor_idx ON public.expenses (vendor_id);
ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.expenses IS
  'Cha Jewels Japan expenses (Finance -> Expenses, owner 2026-10-25). draft -> approved (locked) or void (with reason); never deleted. amount_jpy = amount (JPY) or round(amount / php_jpy_rate) (PHP), set by expenses_before_write while draft. Written only through upsert_expense / attach_expense_receipt / approve_expense / void_expense (audited); no write policies.';

-- ---------------------------------------------------------------------------
-- 2. Read policies (manage_expenses OR approve_expenses). Scalar sub-selects per
--    docs/MIGRATIONS.md "RLS scalar sub-selects".
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS expense_categories_read ON public.expense_categories;
CREATE POLICY expense_categories_read ON public.expense_categories
  FOR SELECT TO authenticated
  USING ((SELECT public.has_permission((SELECT auth.uid()), 'manage_expenses'))
      OR (SELECT public.has_permission((SELECT auth.uid()), 'approve_expenses')));

DROP POLICY IF EXISTS expense_vendors_read ON public.expense_vendors;
CREATE POLICY expense_vendors_read ON public.expense_vendors
  FOR SELECT TO authenticated
  USING ((SELECT public.has_permission((SELECT auth.uid()), 'manage_expenses'))
      OR (SELECT public.has_permission((SELECT auth.uid()), 'approve_expenses')));

DROP POLICY IF EXISTS expenses_read ON public.expenses;
CREATE POLICY expenses_read ON public.expenses
  FOR SELECT TO authenticated
  USING ((SELECT public.has_permission((SELECT auth.uid()), 'manage_expenses'))
      OR (SELECT public.has_permission((SELECT auth.uid()), 'approve_expenses')));

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.expense_categories, public.expense_vendors, public.expenses
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.expense_categories, public.expense_vendors, public.expenses FROM anon;
GRANT SELECT ON public.expense_categories, public.expense_vendors, public.expenses TO authenticated;
GRANT ALL ON public.expense_categories, public.expense_vendors, public.expenses TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Guard + conversion trigger. While a row is a draft the JPY amount is
--    (re)computed from the one peso rate; approved and void rows are locked
--    except for the approved/draft -> void transition; DELETE is refused.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.expenses_before_write()
RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public'
AS $fn$
DECLARE
  v_rate numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'expenses are never deleted; void the expense instead' USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' AND NEW.status <> 'draft' THEN
    RAISE EXCEPTION 'an expense starts as a draft' USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'an expense''s id and creation record cannot be changed' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status = 'void' THEN
      RAISE EXCEPTION 'a void expense cannot be changed' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status = 'approved' THEN
      IF NEW.status <> 'void'
         OR NEW.expense_date IS DISTINCT FROM OLD.expense_date
         OR NEW.category_id IS DISTINCT FROM OLD.category_id
         OR NEW.vendor_id IS DISTINCT FROM OLD.vendor_id
         OR NEW.description IS DISTINCT FROM OLD.description
         OR NEW.currency IS DISTINCT FROM OLD.currency
         OR NEW.amount IS DISTINCT FROM OLD.amount
         OR NEW.fx_php_per_jpy IS DISTINCT FROM OLD.fx_php_per_jpy
         OR NEW.amount_jpy IS DISTINCT FROM OLD.amount_jpy
         OR NEW.payment_method IS DISTINCT FROM OLD.payment_method
         OR NEW.receipt_path IS DISTINCT FROM OLD.receipt_path
         OR NEW.source IS DISTINCT FROM OLD.source
         OR NEW.source_ref IS DISTINCT FROM OLD.source_ref
         OR NEW.notes IS DISTINCT FROM OLD.notes
         OR NEW.details IS DISTINCT FROM OLD.details
         OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
         OR NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
        RAISE EXCEPTION 'an approved expense is locked; it can only be voided' USING ERRCODE = 'check_violation';
      END IF;
      NEW.updated_at := now();
      RETURN NEW;
    END IF;
  END IF;

  IF TG_OP = 'INSERT' OR (OLD.status = 'draft' AND NEW.status IN ('draft', 'approved')) THEN
    IF NEW.currency = 'JPY' THEN
      NEW.fx_php_per_jpy := NULL;
      NEW.amount_jpy := round(NEW.amount);
    ELSE
      SELECT (value #>> '{}')::numeric INTO v_rate FROM public.system_settings WHERE key = 'php_jpy_rate';
      IF v_rate IS NULL OR v_rate <= 0 THEN
        RAISE EXCEPTION 'php_jpy_rate is not set' USING ERRCODE = 'check_violation';
      END IF;
      NEW.fx_php_per_jpy := v_rate;
      NEW.amount_jpy := round(NEW.amount / v_rate);
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END
$fn$;
COMMENT ON FUNCTION public.expenses_before_write() IS
  'BEFORE INSERT/UPDATE/DELETE on expenses. Insert must be a draft. Insert, and a draft row staying draft or being approved: amount_jpy = round(amount) for JPY, round(amount / php_jpy_rate) for PHP, rate stored in fx_php_per_jpy (draft -> void keeps the figures). Approved rows: locked except the transition to void. Void rows: locked. id / created_by / created_at never change. DELETE: always refused.';

DROP TRIGGER IF EXISTS expenses_before_write ON public.expenses;
CREATE TRIGGER expenses_before_write
  BEFORE INSERT OR UPDATE OR DELETE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.expenses_before_write();

CREATE OR REPLACE FUNCTION public.expenses_refuse_truncate()
RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public'
AS $fn$
BEGIN
  RAISE EXCEPTION 'expenses are never deleted (TRUNCATE refused)' USING ERRCODE = 'check_violation';
END
$fn$;
COMMENT ON FUNCTION public.expenses_refuse_truncate() IS
  'BEFORE TRUNCATE on expenses: always refused (the row trigger does not fire on TRUNCATE).';
DROP TRIGGER IF EXISTS expenses_refuse_truncate ON public.expenses;
CREATE TRIGGER expenses_refuse_truncate
  BEFORE TRUNCATE ON public.expenses
  FOR EACH STATEMENT EXECUTE FUNCTION public.expenses_refuse_truncate();
REVOKE ALL ON FUNCTION public.expenses_refuse_truncate() FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.expenses_before_write() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Seed: the owner's locked category list (2026-10-25). A re-run is a no-op.
-- ---------------------------------------------------------------------------
INSERT INTO public.expense_categories (group_key, name, sort_order, system_key) VALUES
  ('people',        'Staff payroll (CSR and Live Admin)',                     10, 'payroll'),
  ('people',        'Sales commission',                                       20, 'commission'),
  ('people',        'Bonuses',                                                30, 'bonus'),
  ('cost_of_goods', 'Inventory purchases (supplier, gold, preloved buys)',    10, NULL),
  ('cost_of_goods', 'Trade-in buybacks',                                      20, 'trade_in'),
  ('cost_of_goods', 'Goldsmith and repair vendors (service jobs)',            30, NULL),
  ('cost_of_goods', 'Appraisal and gem certification',                        40, NULL),
  ('cost_of_goods', 'Packaging, boxes and certificates',                      50, NULL),
  ('marketing',     'Meta and Google ads',                                    10, NULL),
  ('marketing',     'Live-selling equipment and props',                       20, NULL),
  ('marketing',     'Giveaways and influencers',                              30, NULL),
  ('payment_fees',  'Square fees',                                            10, 'square_fees'),
  ('payment_fees',  'Paidy fees',                                             20, 'paidy_fees'),
  ('payment_fees',  'Stripe konbini fees',                                    30, 'stripe_fees'),
  ('payment_fees',  'Bank transfer and Japan to Philippines remittance fees', 40, NULL),
  ('payment_fees',  'Refund fees',                                            50, NULL),
  ('payment_fees',  'Foreign-exchange loss',                                  60, NULL),
  ('shipping',      'Carrier cost (Japan Post, LBC, DHL)',                    10, NULL),
  ('shipping',      'Shipping insurance',                                     20, NULL),
  ('shipping',      'Customs and duties',                                     30, NULL),
  ('tech',          'Lovable, Firebase, Vercel, Claude and other dev tools',  10, NULL),
  ('tech',          'Page365, Pancake, Metricool, Google Workspace',          20, NULL),
  ('tech',          'Email sending and domains',                              30, NULL),
  ('tech',          'Photoroom',                                              40, 'photoroom'),
  ('office',        'Rent, utilities, internet and phone',                    10, NULL),
  ('professional',  'Tax accountant and legal fees',                          10, NULL),
  ('professional',  'Corporate tax and consumption tax payments',             20, NULL),
  ('professional',  'Bank charges',                                           30, NULL)
ON CONFLICT (group_key, name) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 5. Permission keys (CLAUDE.md "ADDING NEW MENU ITEMS": every role gets an
--    explicit row; admin also short-circuits in has_permission).
-- ---------------------------------------------------------------------------
INSERT INTO public.role_permissions (role, permission_key, is_allowed) VALUES
  ('admin'::app_role,      'manage_expenses',  true),
  ('staff'::app_role,      'manage_expenses',  false),
  ('finance'::app_role,    'manage_expenses',  false),
  ('csr'::app_role,        'manage_expenses',  false),
  ('live_agent'::app_role, 'manage_expenses',  false),
  ('admin'::app_role,      'approve_expenses', true),
  ('staff'::app_role,      'approve_expenses', false),
  ('finance'::app_role,    'approve_expenses', false),
  ('csr'::app_role,        'approve_expenses', false),
  ('live_agent'::app_role, 'approve_expenses', false)
ON CONFLICT (role, permission_key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 6. RPCs. Each returns jsonb; refusals are {error: <code>}. One audit_logs row
--    per change.
-- ---------------------------------------------------------------------------

-- get_expense_book(p_month): everything the Expenses tab needs for one month.
CREATE OR REPLACE FUNCTION public.get_expense_book(p_month date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid     uuid := auth.uid();
  v_manage  boolean;
  v_approve boolean;
  v_from    date;
  v_to      date;
  v_rate    numeric;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  v_manage  := public.has_permission(v_uid, 'manage_expenses');
  v_approve := public.has_permission(v_uid, 'approve_expenses');
  IF NOT (v_manage OR v_approve) THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF p_month IS NULL THEN RETURN jsonb_build_object('error', 'invalid_month'); END IF;
  v_from := date_trunc('month', p_month)::date;
  v_to   := (v_from + interval '1 month')::date;
  SELECT (value #>> '{}')::numeric INTO v_rate FROM public.system_settings WHERE key = 'php_jpy_rate';

  RETURN jsonb_build_object(
    'month', v_from,
    'can_manage', v_manage,
    'can_approve', v_approve,
    'php_jpy_rate', v_rate,
    'categories', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', c.id, 'group_key', c.group_key, 'name', c.name,
                                          'sort_order', c.sort_order, 'active', c.active, 'system_key', c.system_key)
                       ORDER BY c.group_key, c.sort_order, c.name)
        FROM public.expense_categories c), '[]'::jsonb),
    'vendors', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', v.id, 'name', v.name, 'default_category_id', v.default_category_id)
                       ORDER BY lower(v.name))
        FROM public.expense_vendors v WHERE v.active), '[]'::jsonb),
    'expenses', coalesce((
      SELECT jsonb_agg(to_jsonb(e) || jsonb_build_object(
               'category_name', c.name, 'group_key', c.group_key, 'vendor_name', v.name)
             ORDER BY e.expense_date DESC, e.created_at DESC)
        FROM public.expenses e
        JOIN public.expense_categories c ON c.id = e.category_id
        LEFT JOIN public.expense_vendors v ON v.id = e.vendor_id
       WHERE e.expense_date >= v_from AND e.expense_date < v_to), '[]'::jsonb));
END
$fn$;
REVOKE ALL ON FUNCTION public.get_expense_book(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_expense_book(date) TO authenticated;
COMMENT ON FUNCTION public.get_expense_book(date) IS
  'Finance -> Expenses: categories, active vendors, the one peso rate, the caller''s rights and every expense dated in the month of p_month (all statuses). Needs manage_expenses or approve_expenses.';

-- upsert_expense(p): create (no id) or edit a DRAFT. A vendor is either p.vendor_id or
-- p.new_vendor_name (created, or reused when the name already exists).
CREATE OR REPLACE FUNCTION public.upsert_expense(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid       uuid := auth.uid();
  v_id        uuid;
  v_date      date;
  v_cat       uuid;
  v_vendor    uuid;
  v_vname     text;
  v_desc      text;
  v_cur       text;
  v_amount    numeric;
  v_method    text;
  v_notes     text;
  v_old       public.expenses%ROWTYPE;
  v_new       public.expenses%ROWTYPE;
  v_vrow      public.expense_vendors%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'manage_expenses') THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;
  p := coalesce(p, '{}'::jsonb);
  BEGIN
    v_id     := nullif(btrim(coalesce(p ->> 'id', '')), '')::uuid;
    v_date   := nullif(btrim(coalesce(p ->> 'expense_date', '')), '')::date;
    v_cat    := nullif(btrim(coalesce(p ->> 'category_id', '')), '')::uuid;
    v_vendor := nullif(btrim(coalesce(p ->> 'vendor_id', '')), '')::uuid;
    v_amount := nullif(btrim(coalesce(p ->> 'amount', '')), '')::numeric;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR invalid_datetime_format
                 OR datetime_field_overflow THEN
    RETURN jsonb_build_object('error', 'invalid_input');
  END;
  v_vname  := nullif(btrim(coalesce(p ->> 'new_vendor_name', '')), '');
  v_desc   := btrim(coalesce(p ->> 'description', ''));
  v_cur    := upper(btrim(coalesce(p ->> 'currency', '')));
  v_method := btrim(coalesce(p ->> 'payment_method', 'bank_transfer'));
  v_notes  := nullif(btrim(coalesce(p ->> 'notes', '')), '');

  IF v_date IS NULL OR v_date < DATE '2020-01-01' OR v_date > (now() AT TIME ZONE 'Asia/Tokyo')::date + 366 THEN
    RETURN jsonb_build_object('error', 'invalid_date');
  END IF;
  IF v_cat IS NULL OR NOT EXISTS (SELECT 1 FROM public.expense_categories c WHERE c.id = v_cat AND c.active) THEN
    RETURN jsonb_build_object('error', 'invalid_category');
  END IF;
  IF EXISTS (SELECT 1 FROM public.expense_categories c
              WHERE c.id = v_cat AND c.system_key IN ('payroll', 'commission')) THEN
    RETURN jsonb_build_object('error', 'category_booked_automatically');
  END IF;
  IF length(v_desc) < 1 OR length(v_desc) > 500 THEN RETURN jsonb_build_object('error', 'invalid_description'); END IF;
  IF v_cur NOT IN ('JPY', 'PHP') THEN RETURN jsonb_build_object('error', 'invalid_currency'); END IF;
  IF v_amount IS NULL OR v_amount <= 0 OR v_amount > 10000000000 OR v_amount <> round(v_amount, 2) THEN
    RETURN jsonb_build_object('error', 'invalid_amount');
  END IF;
  IF v_cur = 'JPY' AND v_amount <> round(v_amount) THEN RETURN jsonb_build_object('error', 'invalid_amount'); END IF;
  IF v_method NOT IN ('bank_transfer', 'card', 'cash', 'auto_debit', 'other') THEN
    RETURN jsonb_build_object('error', 'invalid_payment_method');
  END IF;
  IF v_notes IS NOT NULL AND length(v_notes) > 2000 THEN RETURN jsonb_build_object('error', 'invalid_notes'); END IF;
  IF v_vendor IS NOT NULL AND v_vname IS NOT NULL THEN RETURN jsonb_build_object('error', 'invalid_vendor'); END IF;
  IF v_vendor IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.expense_vendors v WHERE v.id = v_vendor AND v.active) THEN
    RETURN jsonb_build_object('error', 'invalid_vendor');
  END IF;
  IF v_vname IS NOT NULL AND length(v_vname) > 120 THEN RETURN jsonb_build_object('error', 'invalid_vendor'); END IF;

  IF v_id IS NOT NULL THEN
    SELECT * INTO v_old FROM public.expenses WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
    IF v_old.status <> 'draft' THEN RETURN jsonb_build_object('error', 'not_draft', 'status', v_old.status); END IF;
  END IF;

  IF v_vname IS NOT NULL THEN
    SELECT * INTO v_vrow FROM public.expense_vendors v WHERE lower(btrim(v.name)) = lower(v_vname);
    IF FOUND THEN
      IF NOT v_vrow.active THEN RETURN jsonb_build_object('error', 'invalid_vendor'); END IF;
      v_vendor := v_vrow.id;
    ELSE
      BEGIN
        INSERT INTO public.expense_vendors (name, default_category_id, created_by)
        VALUES (v_vname, v_cat, v_uid)
        RETURNING * INTO v_vrow;
        INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id, created_at)
        VALUES ('expense_vendor', v_vrow.id, 'create_expense_vendor', to_jsonb(v_vrow), v_uid, now());
      EXCEPTION WHEN unique_violation THEN
        SELECT * INTO v_vrow FROM public.expense_vendors v WHERE lower(btrim(v.name)) = lower(v_vname);
        IF NOT FOUND OR NOT v_vrow.active THEN RETURN jsonb_build_object('error', 'invalid_vendor'); END IF;
      END;
      v_vendor := v_vrow.id;
    END IF;
  END IF;

  IF v_id IS NULL THEN
    INSERT INTO public.expenses (expense_date, category_id, vendor_id, description, currency, amount,
                                 amount_jpy, payment_method, notes, status, source, created_by)
    VALUES (v_date, v_cat, v_vendor, v_desc, v_cur, v_amount, 0, v_method, v_notes, 'draft', 'manual', v_uid)
    RETURNING * INTO v_new;
  ELSE
    UPDATE public.expenses
       SET expense_date = v_date, category_id = v_cat, vendor_id = v_vendor, description = v_desc,
           currency = v_cur, amount = v_amount, payment_method = v_method, notes = v_notes
      WHERE id = v_id
    RETURNING * INTO v_new;
  END IF;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('expense', v_new.id, 'upsert_expense',
          CASE WHEN v_old.id IS NULL THEN NULL ELSE to_jsonb(v_old) END,
          to_jsonb(v_new) || jsonb_build_object('change', CASE WHEN v_old.id IS NULL THEN 'created' ELSE 'edited' END),
          v_uid, now());

  RETURN jsonb_build_object('ok', true, 'expense', to_jsonb(v_new));
END
$fn$;
REVOKE ALL ON FUNCTION public.upsert_expense(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_expense(jsonb) TO authenticated;
COMMENT ON FUNCTION public.upsert_expense(jsonb) IS
  'Creates (no id) or edits a DRAFT expense (source manual). Validates every field; JPY amounts are whole yen; vendor by vendor_id or new_vendor_name (reused case-insensitively, else created and audited). Needs manage_expenses; one audit_logs row (expense / upsert_expense, old -> new).';

-- attach_expense_receipt(p_id, p_path): records the uploaded receipt on a draft.
CREATE OR REPLACE FUNCTION public.attach_expense_receipt(p_id uuid, p_path text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid  uuid := auth.uid();
  v_path text := btrim(coalesce(p_path, ''));
  v_old  public.expenses%ROWTYPE;
  v_new  public.expenses%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'manage_expenses') THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;
  IF p_id IS NULL THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF v_path NOT LIKE p_id::text || '/%' OR length(v_path) > 300 OR v_path LIKE '%..%' THEN
    RETURN jsonb_build_object('error', 'invalid_receipt_path');
  END IF;
  SELECT * INTO v_old FROM public.expenses WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF v_old.status <> 'draft' THEN RETURN jsonb_build_object('error', 'not_draft', 'status', v_old.status); END IF;

  UPDATE public.expenses SET receipt_path = v_path WHERE id = p_id RETURNING * INTO v_new;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('expense', p_id, 'attach_expense_receipt',
          jsonb_build_object('receipt_path', v_old.receipt_path),
          jsonb_build_object('receipt_path', v_new.receipt_path), v_uid, now());

  RETURN jsonb_build_object('ok', true, 'expense', to_jsonb(v_new));
END
$fn$;
REVOKE ALL ON FUNCTION public.attach_expense_receipt(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.attach_expense_receipt(uuid, text) TO authenticated;
COMMENT ON FUNCTION public.attach_expense_receipt(uuid, text) IS
  'Sets receipt_path (<expense_id>/<file> in the private expense-receipts bucket) on a DRAFT expense. Needs manage_expenses; one audit_logs row (expense / attach_expense_receipt).';

-- approve_expense(p_id): draft -> approved (locked).
CREATE OR REPLACE FUNCTION public.approve_expense(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_old public.expenses%ROWTYPE;
  v_new public.expenses%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'approve_expenses') THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;
  SELECT * INTO v_old FROM public.expenses WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF v_old.status <> 'draft' THEN RETURN jsonb_build_object('error', 'not_draft', 'status', v_old.status); END IF;
  IF v_old.currency = 'PHP' AND NOT EXISTS (
       SELECT 1 FROM public.system_settings s
        WHERE s.key = 'php_jpy_rate' AND (s.value #>> '{}') ~ '^[0-9]*\.?[0-9]+$'
          AND (s.value #>> '{}')::numeric > 0) THEN
    RETURN jsonb_build_object('error', 'rate_not_set');
  END IF;

  UPDATE public.expenses
     SET status = 'approved', approved_by = v_uid, approved_at = now()
   WHERE id = p_id
  RETURNING * INTO v_new;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('expense', p_id, 'approve_expense',
          jsonb_build_object('status', v_old.status),
          jsonb_build_object('status', v_new.status, 'amount_jpy', v_new.amount_jpy, 'currency', v_new.currency,
                             'amount', v_new.amount, 'fx_php_per_jpy', v_new.fx_php_per_jpy),
          v_uid, now());

  RETURN jsonb_build_object('ok', true, 'expense', to_jsonb(v_new));
END
$fn$;
REVOKE ALL ON FUNCTION public.approve_expense(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_expense(uuid) TO authenticated;
COMMENT ON FUNCTION public.approve_expense(uuid) IS
  'Approves a DRAFT expense; it is then locked and counts in totals. Needs approve_expenses; one audit_logs row (expense / approve_expense).';

-- void_expense(p_id, p_reason): draft or approved -> void, reason required.
CREATE OR REPLACE FUNCTION public.void_expense(p_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid    uuid := auth.uid();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_old    public.expenses%ROWTYPE;
  v_new    public.expenses%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'approve_expenses') THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;
  IF length(v_reason) < 3 OR length(v_reason) > 500 THEN RETURN jsonb_build_object('error', 'reason_required'); END IF;
  SELECT * INTO v_old FROM public.expenses WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF v_old.status = 'void' THEN RETURN jsonb_build_object('error', 'already_void'); END IF;

  UPDATE public.expenses
     SET status = 'void', voided_by = v_uid, voided_at = now(), void_reason = v_reason
   WHERE id = p_id
  RETURNING * INTO v_new;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('expense', p_id, 'void_expense',
          jsonb_build_object('status', v_old.status),
          jsonb_build_object('status', v_new.status, 'void_reason', v_reason, 'amount_jpy', v_new.amount_jpy),
          v_uid, now());

  RETURN jsonb_build_object('ok', true, 'expense', to_jsonb(v_new));
END
$fn$;
REVOKE ALL ON FUNCTION public.void_expense(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.void_expense(uuid, text) TO authenticated;
COMMENT ON FUNCTION public.void_expense(uuid, text) IS
  'Voids a draft or approved expense with a written reason (3-500 characters). Never deletes. Needs approve_expenses; one audit_logs row (expense / void_expense).';

-- ---------------------------------------------------------------------------
-- 7. Private receipt bucket + object policies (read + upload only).
-- ---------------------------------------------------------------------------

DO $p$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
                   AND policyname = 'Expense users can read expense receipts') THEN
    CREATE POLICY "Expense users can read expense receipts" ON storage.objects
      FOR SELECT TO authenticated
      USING (bucket_id = 'expense-receipts'
             AND ((SELECT public.has_permission((SELECT auth.uid()), 'manage_expenses'))
               OR (SELECT public.has_permission((SELECT auth.uid()), 'approve_expenses'))));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
                  AND policyname = 'Expense managers can upload expense receipts') THEN
    CREATE POLICY "Expense managers can upload expense receipts" ON storage.objects
      FOR INSERT TO authenticated
      WITH CHECK (bucket_id = 'expense-receipts'
                  AND (SELECT public.has_permission((SELECT auth.uid()), 'manage_expenses'))
                  AND EXISTS (SELECT 1 FROM public.expenses e
                               WHERE e.id::text = split_part(name, '/', 1)
                                 AND e.status = 'draft')
                  AND name NOT LIKE '%..%'
                  AND length(split_part(name, '/', 2)) > 0);
  END IF;
END
$p$;
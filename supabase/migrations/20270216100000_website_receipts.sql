-- ============================================================================
-- WEBSITE RECEIPTS (領収書) — owner decisions 2026-10-27. docs/RECEIPTS.md.
--
-- One final receipt per WEBSITE order (cash_orders / layaway_accounts with
-- source_channel = 'web') once it is fully paid (status 'completed').
-- Page365 / live / Hub orders are out of scope entirely.
--
-- NO EXISTING FUNCTION BODY IS CHANGED. Receipts are created and cancelled by
-- DEFERRED constraint triggers that run at COMMIT, so they see every payment the
-- completing transaction wrote, whatever path completed the order (reviewer
-- Confirm, store credit, points, layaway allocation, restore, Shopify, a
-- browser write). Every trigger calls ONE function, web_receipt_sync, which
-- reconciles the order's receipt with the order as it now is:
--   * an issued receipt whose figures, owner or "fully paid" state no longer
--     match is CANCELLED (never edited, never deleted) with the reason;
--   * an order that is fully paid, with no issued receipt, gets a NEW number —
--     only while web_receipts_mode allows it and only if the order completed at
--     or after web_receipts_live_at.
--
-- Contents:
--   1. settings web_receipts_mode / web_receipts_live_at + reader functions,
--      guard trigger, setter set_web_receipts_mode (admin, audited)
--   2. tables website_receipts, website_receipt_issues (+ guard trigger, RLS)
--   3. web_receipt_snapshot  — the receipt's figures, from data
--   4. web_receipt_sync      — cancel / issue
--   5. deferred triggers on cash_orders, layaway_accounts, penalty_fees,
--      square_refunds, square_disputes, paidy_refunds
--   6. service-role RPCs for the website edge function and the email sweep
--   7. private storage bucket receipt-assets (the font; no object policies)
--   8. cron 'website-receipt-emails' (Vault key)
--   9. self-checks
--
-- Comments are kept OUTSIDE function bodies (Lovable strips in-body comments;
-- docs/MIGRATIONS.md).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The switch.
--    web_receipts_mode   "off" | "test" | "on"; anything else reads as off.
--                        test = TEST- orders only; on = real orders only.
--    web_receipts_live_at  ISO timestamp, set by set_web_receipts_mode each time
--                        the switch is turned to test or on. An order that
--                        completed before it never gets a receipt.
-- ---------------------------------------------------------------------------
INSERT INTO public.system_settings (key, value, description)
VALUES ('web_receipts_mode', '"off"'::jsonb,
        'Website receipts (領収書): "off" | "test" | "on". test = TEST- orders only, on = real orders only. Anything else reads as off. Changed only through set_web_receipts_mode (admin; audited). docs/RECEIPTS.md.')
ON CONFLICT (key) DO NOTHING;
INSERT INTO public.system_settings (key, value, description)
VALUES ('web_receipts_live_at', 'null'::jsonb,
        'Website receipts: the moment the switch was last turned to test or on (set by set_web_receipts_mode). Only orders completed at or after it get a receipt. docs/RECEIPTS.md.')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.web_receipts_mode()
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT CASE WHEN v IN ('test', 'on') THEN v ELSE 'off' END
    FROM (SELECT (SELECT value #>> '{}' FROM public.system_settings WHERE key = 'web_receipts_mode') AS v) s
$fn$;
REVOKE ALL ON FUNCTION public.web_receipts_mode() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.web_receipts_mode() TO service_role;

CREATE OR REPLACE FUNCTION public.web_receipts_live_at()
RETURNS timestamptz
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v text;
BEGIN
  SELECT value #>> '{}' INTO v FROM public.system_settings WHERE key = 'web_receipts_live_at';
  IF v IS NULL OR btrim(v) = '' THEN RETURN NULL; END IF;
  RETURN v::timestamptz;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION public.web_receipts_live_at() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.web_receipts_live_at() TO service_role;

CREATE OR REPLACE FUNCTION public.guard_web_receipts_settings()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
BEGIN
  IF (OLD.key IN ('web_receipts_mode', 'web_receipts_live_at')
      AND (TG_OP = 'DELETE' OR NEW.key IS DISTINCT FROM OLD.key OR NEW.value IS DISTINCT FROM OLD.value))
     OR (TG_OP = 'UPDATE' AND NEW.key IN ('web_receipts_mode', 'web_receipts_live_at')
         AND OLD.key IS DISTINCT FROM NEW.key)
  THEN
    IF coalesce(current_setting('app.allow_web_receipts_settings_change', true), '') <> 'on' THEN
      RAISE EXCEPTION 'Website receipt settings are changed only through set_web_receipts_mode.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$fn$;
REVOKE ALL ON FUNCTION public.guard_web_receipts_settings() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_web_receipts_settings ON public.system_settings;
CREATE TRIGGER trg_guard_web_receipts_settings
BEFORE UPDATE OR DELETE ON public.system_settings
FOR EACH ROW EXECUTE FUNCTION public.guard_web_receipts_settings();

-- set_web_receipts_mode: the ONLY writer of both keys. Admin role, or the
-- database owner in the SQL Editor (auth.uid() is NULL there and session_user
-- is postgres; there is no Hub card yet). A service-role or PostgREST call with
-- no user (session_user = authenticator) is refused. One audit_logs row per change. Turning the switch to test or on
-- stamps web_receipts_live_at = now(); turning it off leaves live_at alone (it
-- no longer matters: nothing is issued while off).
CREATE OR REPLACE FUNCTION public.set_web_receipts_mode(p_mode text, p_expected_mode text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid      uuid := auth.uid();
  v_mode_row public.system_settings%ROWTYPE;
  v_live_row public.system_settings%ROWTYPE;
  v_old      text;
  v_new      text := btrim(coalesce(p_mode, ''));
  v_now      timestamptz := now();
  v_live     jsonb;
BEGIN
  IF v_uid IS NULL THEN
    IF session_user NOT IN ('postgres', 'supabase_admin') THEN
      RETURN jsonb_build_object('error', 'user_identity_required');
    END IF;
  ELSIF NOT public.has_role(v_uid, 'admin'::public.app_role) THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;
  IF v_new NOT IN ('off', 'test', 'on') THEN
    RETURN jsonb_build_object('error', 'invalid_mode');
  END IF;

  SELECT * INTO v_mode_row FROM public.system_settings WHERE key = 'web_receipts_mode' FOR UPDATE;
  SELECT * INTO v_live_row FROM public.system_settings WHERE key = 'web_receipts_live_at' FOR UPDATE;
  IF v_mode_row.id IS NULL OR v_live_row.id IS NULL THEN
    RETURN jsonb_build_object('error', 'setting_missing');
  END IF;
  v_old := public.web_receipts_mode();
  IF p_expected_mode IS NOT NULL AND p_expected_mode IS DISTINCT FROM v_old THEN
    RETURN jsonb_build_object('error', 'stale', 'mode', v_old);
  END IF;
  IF v_new = v_old AND v_mode_row.value = to_jsonb(v_new) THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'mode', v_old, 'live_at', public.web_receipts_live_at());
  END IF;

  PERFORM set_config('app.allow_web_receipts_settings_change', 'on', true);
  UPDATE public.system_settings SET value = to_jsonb(v_new), updated_by_user_id = v_uid, updated_at = v_now
   WHERE id = v_mode_row.id;
  v_live := v_live_row.value;
  IF v_new IN ('test', 'on') THEN
    v_live := to_jsonb(to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
    UPDATE public.system_settings SET value = v_live, updated_by_user_id = v_uid, updated_at = v_now
     WHERE id = v_live_row.id;
  END IF;
  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('system_setting', v_mode_row.id, 'set_web_receipts_mode',
          jsonb_build_object('mode', v_old, 'live_at', v_live_row.value),
          jsonb_build_object('mode', v_new, 'live_at', v_live,
                             'via', CASE WHEN v_uid IS NULL THEN 'sql_editor' ELSE 'hub' END),
          v_uid, v_now);
  PERFORM set_config('app.allow_web_receipts_settings_change', '', true);

  RETURN jsonb_build_object('ok', true, 'changed', true, 'mode', v_new, 'old_mode', v_old, 'live_at', v_live);
END
$fn$;
REVOKE ALL ON FUNCTION public.set_web_receipts_mode(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_web_receipts_mode(text, text) TO authenticated;
COMMENT ON FUNCTION public.set_web_receipts_mode(text, text) IS
  'The ONLY writer of system_settings.web_receipts_mode and web_receipts_live_at (trg_guard_web_receipts_settings refuses every other write). Admin role, or the database owner in the SQL Editor. Mode off|test|on; test/on stamps live_at = now(). One audit_logs row (system_setting / set_web_receipts_mode). docs/RECEIPTS.md.';

-- ---------------------------------------------------------------------------
-- 2. Tables.
-- ---------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS public.website_receipt_number_seq
  AS bigint START WITH 1 MINVALUE 1 INCREMENT BY 1 NO CYCLE;
REVOKE ALL ON SEQUENCE public.website_receipt_number_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SEQUENCE public.website_receipt_number_seq TO service_role;

CREATE TABLE IF NOT EXISTS public.website_receipts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_number     text NOT NULL UNIQUE,
  cash_order_id      uuid REFERENCES public.cash_orders(id) ON DELETE RESTRICT,
  layaway_account_id uuid REFERENCES public.layaway_accounts(id) ON DELETE RESTRICT,
  customer_id        uuid NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  currency           public.account_currency NOT NULL,
  order_number       text NOT NULL,
  lines              jsonb NOT NULL,
  total_paid         numeric(15,2) NOT NULL,
  penalty_total      numeric(15,2) NOT NULL DEFAULT 0,
  taxable_total      numeric(15,2) NOT NULL,
  subtotal           numeric(15,2) NOT NULL,
  tax_amount         numeric(15,2) NOT NULL,
  fx_rate_used       numeric(12,6),
  addressee          text,
  purpose            text NOT NULL DEFAULT 'お品代として',
  verify_code        text NOT NULL UNIQUE,
  status             text NOT NULL DEFAULT 'issued',
  cancelled_at       timestamptz,
  cancel_reason      text,
  issued_at          timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  email_sent_at      timestamptz,
  email_attempts     integer NOT NULL DEFAULT 0,
  email_last_error   text,
  CONSTRAINT website_receipts_one_order CHECK (num_nonnulls(cash_order_id, layaway_account_id) = 1),
  CONSTRAINT website_receipts_status CHECK (status IN ('issued', 'cancelled')),
  CONSTRAINT website_receipts_cancel_fields CHECK (
    (status = 'issued' AND cancelled_at IS NULL AND cancel_reason IS NULL)
    OR (status = 'cancelled' AND cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL)),
  CONSTRAINT website_receipts_number_format CHECK (receipt_number ~ '^CJR-[0-9]{4}-[0-9]{6,}$'),
  CONSTRAINT website_receipts_verify_code CHECK (verify_code ~ '^[0-9a-f]{40}$'),
  CONSTRAINT website_receipts_addressee_len CHECK (addressee IS NULL OR char_length(addressee) BETWEEN 1 AND 60),
  CONSTRAINT website_receipts_purpose_len CHECK (char_length(purpose) BETWEEN 1 AND 40),
  CONSTRAINT website_receipts_fx CHECK (currency = 'JPY' OR fx_rate_used IS NULL OR fx_rate_used > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS website_receipts_one_issued_cash
  ON public.website_receipts (cash_order_id) WHERE status = 'issued' AND cash_order_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS website_receipts_one_issued_layaway
  ON public.website_receipts (layaway_account_id) WHERE status = 'issued' AND layaway_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS website_receipts_customer ON public.website_receipts (customer_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS website_receipts_cash_order ON public.website_receipts (cash_order_id);
CREATE INDEX IF NOT EXISTS website_receipts_layaway ON public.website_receipts (layaway_account_id);
CREATE INDEX IF NOT EXISTS website_receipts_email_due ON public.website_receipts (issued_at)
  WHERE status = 'issued' AND email_sent_at IS NULL;

COMMENT ON TABLE public.website_receipts IS
  'Website order receipts (領収書), one ISSUED per order at most. Written only by web_receipt_sync (deferred triggers) and the website receipt RPCs. Figures are a snapshot and are never edited; a change cancels the receipt and a new number is issued. Never deleted. docs/RECEIPTS.md.';
COMMENT ON COLUMN public.website_receipts.total_paid IS
  'Money actually received, in the order''s currency: non-voided payments minus checkout/loyalty points (LOYALTY-) minus card/Paidy refunds. The receipt total.';
COMMENT ON COLUMN public.website_receipts.taxable_total IS
  'The products'' tax-included total: Σ unit_price × quantity of the item lines.';
COMMENT ON COLUMN public.website_receipts.subtotal IS
  '小計（税抜） as printed = Σ round(unit price × 10/11) × quantity (generate-invoice''s rule).';
COMMENT ON COLUMN public.website_receipts.tax_amount IS
  '消費税（10%） as printed = taxable_total − subtotal. Every amount is already tax-included. subtotal + tax − discount + shipping + COD fee + late fee = total_paid; a receipt whose stored data does not add up is never issued.';
COMMENT ON COLUMN public.website_receipts.lines IS
  'Snapshot built by web_receipt_snapshot: items (yen), goods_total, discount, coupon_code, points, shipping, cod_fee, penalties, payments[{method, amount}], store_credit, refunds, received, product_amount, subtotal, tax, discount_total, adds_up. Each item also carries unit_price_ex and line_ex (excl. tax).';

CREATE TABLE IF NOT EXISTS public.website_receipt_issues (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id  uuid NOT NULL REFERENCES public.website_receipts(id) ON DELETE RESTRICT,
  issue_no    integer NOT NULL CHECK (issue_no >= 1),
  is_reissue  boolean NOT NULL,
  language    text NOT NULL CHECK (language IN ('ja', 'en')),
  addressee   text,
  purpose     text NOT NULL,
  issued_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT website_receipt_issues_reissue CHECK (is_reissue = (issue_no > 1)),
  CONSTRAINT website_receipt_issues_unique UNIQUE (receipt_id, issue_no)
);
COMMENT ON TABLE public.website_receipt_issues IS
  'Every PDF download of a website receipt (history). issue_no 1 is the original; from 2 on the PDF is marked 再発行 / Reissued. Written only by record_website_receipt_issue. Never updated or deleted.';

ALTER TABLE public.website_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.website_receipt_issues ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.website_receipts FROM anon, authenticated;
REVOKE ALL ON public.website_receipt_issues FROM anon, authenticated;
GRANT SELECT ON public.website_receipts TO authenticated;
GRANT SELECT ON public.website_receipt_issues TO authenticated;
GRANT ALL ON public.website_receipts TO service_role;
GRANT ALL ON public.website_receipt_issues TO service_role;

DROP POLICY IF EXISTS "Staff can read website receipts" ON public.website_receipts;
CREATE POLICY "Staff can read website receipts" ON public.website_receipts
  FOR SELECT TO authenticated
  USING ((SELECT public.is_staff((SELECT auth.uid()))));
DROP POLICY IF EXISTS "Staff can read website receipt issues" ON public.website_receipt_issues;
CREATE POLICY "Staff can read website receipt issues" ON public.website_receipt_issues
  FOR SELECT TO authenticated
  USING ((SELECT public.is_staff((SELECT auth.uid()))));

-- Figures are frozen: only addressee / purpose (while issued), the issued ->
-- cancelled move, and the email bookkeeping columns may change. No DELETE.
CREATE OR REPLACE FUNCTION public.guard_website_receipts()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Website receipts are never deleted; cancel instead.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.receipt_number IS DISTINCT FROM OLD.receipt_number
     OR NEW.cash_order_id IS DISTINCT FROM OLD.cash_order_id
     OR NEW.layaway_account_id IS DISTINCT FROM OLD.layaway_account_id
     OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.order_number IS DISTINCT FROM OLD.order_number
     OR NEW.lines IS DISTINCT FROM OLD.lines
     OR NEW.total_paid IS DISTINCT FROM OLD.total_paid
     OR NEW.penalty_total IS DISTINCT FROM OLD.penalty_total
     OR NEW.taxable_total IS DISTINCT FROM OLD.taxable_total
     OR NEW.tax_amount IS DISTINCT FROM OLD.tax_amount
     OR NEW.subtotal IS DISTINCT FROM OLD.subtotal
     OR NEW.fx_rate_used IS DISTINCT FROM OLD.fx_rate_used
     OR NEW.verify_code IS DISTINCT FROM OLD.verify_code
     OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'A website receipt''s figures never change; cancel it and issue a new one.' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'cancelled' AND (NEW.status IS DISTINCT FROM OLD.status
       OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
       OR NEW.cancel_reason IS DISTINCT FROM OLD.cancel_reason
       OR NEW.addressee IS DISTINCT FROM OLD.addressee
       OR NEW.purpose IS DISTINCT FROM OLD.purpose) THEN
    RAISE EXCEPTION 'A cancelled website receipt cannot change.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.guard_website_receipts() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_website_receipts ON public.website_receipts;
CREATE TRIGGER trg_guard_website_receipts
BEFORE UPDATE OR DELETE ON public.website_receipts
FOR EACH ROW EXECUTE FUNCTION public.guard_website_receipts();

CREATE OR REPLACE FUNCTION public.guard_website_receipt_issues()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
BEGIN
  RAISE EXCEPTION 'Website receipt issue history is append-only.' USING ERRCODE = 'P0001';
END
$fn$;
REVOKE ALL ON FUNCTION public.guard_website_receipt_issues() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_website_receipt_issues ON public.website_receipt_issues;
CREATE TRIGGER trg_guard_website_receipt_issues
BEFORE UPDATE OR DELETE ON public.website_receipt_issues
FOR EACH ROW EXECUTE FUNCTION public.guard_website_receipt_issues();

-- ---------------------------------------------------------------------------
-- 3. web_receipt_snapshot(kind, id) — the receipt's figures, from data only.
--    kind 'cash' | 'layaway'. NULL when the row is missing or not a web order.
--
--    payments    non-voided rows of cash_payments / payments
--    points      the LOYALTY-% rows (checkout points, loyalty redemption) —
--                shown as a discount, never as money
--    store_credit  rows with payment_method 'store_credit' (a payment line)
--    refunds     cash only: Square refunds with status COMPLETED + Paidy refunds
--    penalties   layaway only: penalty_fees not waived
--    goods_total = total_amount − shipping − cod_fee + discount (pieces and
--                  service lines, before the discount)
--    order_total = total_amount (+ penalties on a layaway)
--    received    = payments − points − refunds        (the receipt total)
--    TOTALS BLOCK (owner 2026-10-27, generate-invoice's rule): every item
--    line shown EXCLUDING tax so the lines add up to the subtotal:
--      unit_price_ex = round(unit_price_jpy × 10 / 11)  (= Math.round(÷ 1.1);
--                      SQL round = half away from zero = Math.round here)
--      line_ex       = unit_price_ex × quantity
--      subtotal      = Σ line_ex
--      tax           = Σ (unit_price_jpy × quantity) − subtotal
--      discount_total = discount (coupon included) + points
--      subtotal + tax − discount_total + shipping + cod_fee + penalties must
--      equal received exactly (adds_up), and Σ unit × qty must equal Σ
--      line_total_jpy; otherwise a receipt is never issued (and an issued one
--      is cancelled). No balancing line, ever.
--    PESO ORDERS (owner 2026-10-27, option a): item lines are stored in yen
--      only and checkout converts only the total and shipping (the items are
--      the remainder). The receipt converts each line ONCE with the order's
--      fx_rate_used (pesos per ¥1): unit_php = round(unit_price_jpy × rate),
--      line_php = unit_php × quantity; the rounding remainder
--      (goods_total − Σ line_php) goes on the LARGEST quantity-1 line, so the
--      peso rows add up EXACTLY to the stored peso product amount. No rate →
--      peso_no_rate; a remainder with no quantity-1 line → peso_lines_mismatch.
--      Then the same block in PHP (unit_price_ex = round(unit_php × 10 / 11)).
--    problem   NULL | no_items | lines_mismatch | block_mismatch |
--              peso_no_rate | peso_lines_mismatch  (why adds_up is false)
--    fully_paid  = status 'completed' AND payments − refunds ≥ order_total
--                  AND no Square dispute other than WON
--    The TS mirror is supabase/functions/_shared/receipt-math.ts.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.web_receipt_snapshot(p_kind text, p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_o           record;
  v_is_test     boolean;
  v_items       jsonb;
  v_payments    jsonb;
  v_paid_all    numeric := 0;
  v_points      numeric := 0;
  v_credit      numeric := 0;
  v_refunds     numeric := 0;
  v_penalties   numeric := 0;
  v_disputed    boolean := false;
  v_shipping    numeric;
  v_cod         numeric;
  v_discount    numeric;
  v_goods       numeric;
  v_order_total numeric;
  v_received    numeric;
  v_items_sum   numeric := 0;
  v_items_incl  numeric := 0;
  v_items_ex    numeric := 0;
  v_product     numeric;
  v_subtotal    numeric;
  v_tax         numeric;
  v_disc_total  numeric;
  v_adds_up     boolean;
  v_items_incl_jpy numeric := 0;
  v_php_sum     numeric := 0;
  v_rem         numeric := 0;
  v_fix_ord     bigint;
  v_problem     text;
BEGIN
  IF p_kind = 'cash' THEN
    SELECT o.id, o.customer_id, o.status::text AS status, o.completed_at, o.currency::text AS currency,
           o.total_amount, coalesce(o.shipping_fee, 0) AS shipping_fee, coalesce(o.cod_fee, 0) AS cod_fee,
           coalesce(o.discount_amount, 0) AS discount_amount, o.coupon_code, o.fx_rate_used,
           o.invoice_number, o.web_reference, o.source_channel, coalesce(o.is_test, false) AS is_test
      INTO v_o
      FROM public.cash_orders o WHERE o.id = p_id;
  ELSIF p_kind = 'layaway' THEN
    SELECT a.id, a.customer_id, a.status::text AS status, a.completed_at, a.currency::text AS currency,
           a.total_amount, coalesce(a.shipping_fee, 0) AS shipping_fee, 0::numeric AS cod_fee,
           coalesce(a.discount_amount, 0) AS discount_amount, a.coupon_code, a.fx_rate_used,
           a.invoice_number, a.web_reference, a.source_channel, coalesce(a.is_test, false) AS is_test
      INTO v_o
      FROM public.layaway_accounts a WHERE a.id = p_id;
  ELSE
    RETURN NULL;
  END IF;
  IF v_o.id IS NULL OR v_o.source_channel IS DISTINCT FROM 'web' THEN
    RETURN NULL;
  END IF;

  SELECT v_o.is_test OR coalesce(c.is_test, false) OR coalesce(v_o.invoice_number, '') LIKE 'TEST-%'
    INTO v_is_test FROM public.customers c WHERE c.id = v_o.customer_id;
  v_is_test := coalesce(v_is_test, v_o.is_test OR coalesce(v_o.invoice_number, '') LIKE 'TEST-%');

  IF p_kind = 'cash' THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'title', i.title, 'sku', i.sku, 'quantity', i.quantity,
             'unit_price_jpy', i.unit_price_jpy, 'line_total_jpy', i.line_total_jpy,
             'unit_price_ex', round(i.unit_price_jpy * 10 / 11),
             'line_ex', round(i.unit_price_jpy * 10 / 11) * i.quantity)
             ORDER BY i.created_at, i.id), '[]'::jsonb)
      INTO v_items FROM public.cash_order_items i WHERE i.cash_order_id = p_id;

    SELECT coalesce(sum(p.amount_paid), 0),
           coalesce(sum(p.amount_paid) FILTER (WHERE coalesce(p.reference_number, '') LIKE 'LOYALTY-%'), 0),
           coalesce(sum(p.amount_paid) FILTER (WHERE coalesce(p.reference_number, '') NOT LIKE 'LOYALTY-%'
                                                 AND lower(coalesce(p.payment_method, '')) = 'store_credit'), 0)
      INTO v_paid_all, v_points, v_credit
      FROM public.cash_payments p WHERE p.cash_order_id = p_id AND p.voided_at IS NULL;

    SELECT coalesce(jsonb_agg(jsonb_build_object('method', m.method, 'amount', m.amount) ORDER BY m.first_at, m.method), '[]'::jsonb)
      INTO v_payments
      FROM (SELECT lower(coalesce(nullif(btrim(p.payment_method), ''), 'other')) AS method,
                   sum(p.amount_paid) AS amount, min(p.created_at) AS first_at
              FROM public.cash_payments p
             WHERE p.cash_order_id = p_id AND p.voided_at IS NULL
               AND coalesce(p.reference_number, '') NOT LIKE 'LOYALTY-%'
             GROUP BY 1) m;

    SELECT coalesce((SELECT sum(r.amount_jpy) FROM public.square_refunds r
                      WHERE r.cash_order_id = p_id AND r.status = 'COMPLETED'), 0)
         + coalesce((SELECT sum(r.amount_jpy) FROM public.paidy_refunds r WHERE r.cash_order_id = p_id), 0)
      INTO v_refunds;
    v_disputed := EXISTS (SELECT 1 FROM public.square_disputes d
                           WHERE d.cash_order_id = p_id AND coalesce(d.state, '') <> 'WON');
  ELSE
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'title', i.title, 'sku', i.sku, 'quantity', i.quantity,
             'unit_price_jpy', i.unit_price_jpy, 'line_total_jpy', i.line_total_jpy,
             'unit_price_ex', round(i.unit_price_jpy * 10 / 11),
             'line_ex', round(i.unit_price_jpy * 10 / 11) * i.quantity)
             ORDER BY i.created_at, i.id), '[]'::jsonb)
      INTO v_items FROM public.layaway_account_items i WHERE i.account_id = p_id;

    SELECT coalesce(sum(p.amount_paid), 0),
           coalesce(sum(p.amount_paid) FILTER (WHERE coalesce(p.reference_number, '') LIKE 'LOYALTY-%'), 0),
           coalesce(sum(p.amount_paid) FILTER (WHERE coalesce(p.reference_number, '') NOT LIKE 'LOYALTY-%'
                                                 AND lower(coalesce(p.payment_method, '')) = 'store_credit'), 0)
      INTO v_paid_all, v_points, v_credit
      FROM public.payments p WHERE p.account_id = p_id AND p.voided_at IS NULL;

    SELECT coalesce(jsonb_agg(jsonb_build_object('method', m.method, 'amount', m.amount) ORDER BY m.first_at, m.method), '[]'::jsonb)
      INTO v_payments
      FROM (SELECT lower(coalesce(nullif(btrim(p.payment_method), ''), 'other')) AS method,
                   sum(p.amount_paid) AS amount, min(p.created_at) AS first_at
              FROM public.payments p
             WHERE p.account_id = p_id AND p.voided_at IS NULL
               AND coalesce(p.reference_number, '') NOT LIKE 'LOYALTY-%'
             GROUP BY 1) m;

    SELECT coalesce(sum(f.penalty_amount), 0) INTO v_penalties
      FROM public.penalty_fees f WHERE f.account_id = p_id AND f.status <> 'waived';
  END IF;

  v_shipping    := v_o.shipping_fee;
  v_cod         := v_o.cod_fee;
  v_discount    := v_o.discount_amount;
  v_goods       := v_o.total_amount - v_shipping - v_cod + v_discount;
  v_order_total := v_o.total_amount + v_penalties;
  v_received    := v_paid_all - v_points - v_refunds;
  SELECT coalesce(sum((e ->> 'line_total_jpy')::numeric), 0),
         coalesce(sum((e ->> 'unit_price_jpy')::numeric * (e ->> 'quantity')::numeric), 0)
    INTO v_items_sum, v_items_incl_jpy
    FROM jsonb_array_elements(v_items) e;

  IF v_o.currency = 'PHP' THEN
    IF v_o.fx_rate_used IS NULL OR v_o.fx_rate_used <= 0 THEN
      v_problem := 'peso_no_rate';
    ELSE
      SELECT coalesce(sum(round((e ->> 'unit_price_jpy')::numeric * v_o.fx_rate_used) * (e ->> 'quantity')::numeric), 0)
        INTO v_php_sum FROM jsonb_array_elements(v_items) e;
      v_rem := v_goods - v_php_sum;
      SELECT t.o INTO v_fix_ord
        FROM jsonb_array_elements(v_items) WITH ORDINALITY t(e, o)
       WHERE (t.e ->> 'quantity')::numeric = 1
       ORDER BY round((t.e ->> 'unit_price_jpy')::numeric * v_o.fx_rate_used) DESC, t.o
       LIMIT 1;
      IF v_rem <> 0 AND v_fix_ord IS NULL THEN
        v_problem := 'peso_lines_mismatch';
      END IF;
      SELECT coalesce(jsonb_agg(s.e || jsonb_build_object(
               'unit_price', s.up, 'line_total', s.up * s.qty,
               'unit_price_ex', round(s.up * 10 / 11), 'line_ex', round(s.up * 10 / 11) * s.qty)
               ORDER BY s.o), '[]'::jsonb)
        INTO v_items
        FROM (SELECT t.e, t.o, (t.e ->> 'quantity')::numeric AS qty,
                     round((t.e ->> 'unit_price_jpy')::numeric * v_o.fx_rate_used)
                       + CASE WHEN t.o = v_fix_ord THEN v_rem ELSE 0 END AS up
                FROM jsonb_array_elements(v_items) WITH ORDINALITY t(e, o)) s;
    END IF;
  ELSE
    SELECT coalesce(jsonb_agg(t.e || jsonb_build_object(
             'unit_price', (t.e ->> 'unit_price_jpy')::numeric,
             'line_total', (t.e ->> 'unit_price_jpy')::numeric * (t.e ->> 'quantity')::numeric)
             ORDER BY t.o), '[]'::jsonb)
      INTO v_items
      FROM jsonb_array_elements(v_items) WITH ORDINALITY t(e, o);
  END IF;

  SELECT coalesce(sum((e ->> 'line_total')::numeric), 0),
         coalesce(sum((e ->> 'line_ex')::numeric), 0)
    INTO v_items_incl, v_items_ex
    FROM jsonb_array_elements(v_items) e;
  v_product     := v_items_incl;
  v_subtotal    := v_items_ex;
  v_tax         := v_items_incl - v_items_ex;
  v_disc_total  := v_discount + v_points;
  IF v_problem IS NULL THEN
    v_problem := CASE
      WHEN v_items_incl_jpy <= 0 OR v_items_incl <= 0 THEN 'no_items'
      WHEN v_items_incl_jpy <> v_items_sum THEN 'lines_mismatch'
      WHEN abs((v_subtotal + v_tax - v_disc_total + v_shipping + v_cod + v_penalties) - v_received) >= 0.005 THEN 'block_mismatch'
      ELSE NULL
    END;
  END IF;
  v_adds_up     := v_problem IS NULL;

  RETURN jsonb_build_object(
    'kind', p_kind,
    'order_id', v_o.id,
    'customer_id', v_o.customer_id,
    'is_test', v_is_test,
    'status', v_o.status,
    'completed_at', v_o.completed_at,
    'currency', v_o.currency,
    'fx_rate_used', v_o.fx_rate_used,
    'order_number', coalesce(v_o.web_reference, v_o.invoice_number),
    'invoice_number', v_o.invoice_number,
    'fully_paid', v_o.status = 'completed'
                  AND (v_paid_all - v_refunds) >= v_order_total - 0.005
                  AND NOT v_disputed,
    'disputed', v_disputed,
    'adds_up', v_adds_up,
    'problem', v_problem,
    'lines', jsonb_build_object(
      'items', v_items,
      'goods_total', v_goods,
      'discount', v_discount,
      'coupon_code', v_o.coupon_code,
      'points', v_points,
      'shipping', v_shipping,
      'cod_fee', v_cod,
      'penalties', v_penalties,
      'order_total', v_order_total,
      'payments', v_payments,
      'store_credit', v_credit,
      'refunds', v_refunds,
      'received', v_received,
      'product_amount', v_product,
      'subtotal', v_subtotal,
      'tax', v_tax,
      'discount_total', v_disc_total,
      'adds_up', v_adds_up
    )
  );
END
$fn$;
REVOKE ALL ON FUNCTION public.web_receipt_snapshot(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.web_receipt_snapshot(text, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. web_receipt_sync(kind, id) — make the order's receipt match the order.
--    1. Lock the order row (serialises concurrent syncs of one order).
--    2. An ISSUED receipt stays only while the order is still fully paid and
--       its snapshot (lines + owner + currency) is unchanged; otherwise it is
--       cancelled with the reason: not_completed | refunded | disputed |
--       not_fully_paid | does_not_add_up | owner_changed | figures_changed.
--    3. With no issued receipt left, a NEW one is issued when the order is
--       fully paid AND the switch allows it: mode test → TEST- orders only,
--       mode on → real orders only, off → never; and completed_at ≥ live_at.
--    Receipt number CJR-<JST year of issue>-<6+ digits, own sequence>.
--    Verify code: 20 random bytes, hex (160 bits).
--    Fully paid but the block does not add up (snapshot.problem): no receipt,
--    and ONE staff_notifications row 'website_receipt_not_issued' per order
--    per problem (owner 2026-10-27) — fixing the order issues it on the next
--    sync. Bell: layaway → account_id, cash → metadata.cash_order_id.
--    Returns {action: kept|cancelled|issued|cancelled_and_issued|none, ...}.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.web_receipt_sync(p_kind text, p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE
  v_snap     jsonb;
  v_lines    jsonb;
  v_rec      public.website_receipts%ROWTYPE;
  v_reason   text;
  v_mode     text;
  v_live     timestamptz;
  v_now      timestamptz := now();
  v_number   text;
  v_new_id   uuid;
  v_action   text := 'none';
  v_cancelled uuid;
BEGIN
  IF p_kind = 'cash' THEN
    PERFORM 1 FROM public.cash_orders WHERE id = p_id FOR UPDATE;
  ELSIF p_kind = 'layaway' THEN
    PERFORM 1 FROM public.layaway_accounts WHERE id = p_id FOR UPDATE;
  ELSE
    RETURN jsonb_build_object('action', 'none', 'reason', 'bad_kind');
  END IF;

  v_snap := public.web_receipt_snapshot(p_kind, p_id);
  IF v_snap IS NULL THEN
    RETURN jsonb_build_object('action', 'none', 'reason', 'not_web');
  END IF;
  v_lines := v_snap -> 'lines';

  SELECT * INTO v_rec FROM public.website_receipts
   WHERE status = 'issued'
     AND ((p_kind = 'cash' AND cash_order_id = p_id) OR (p_kind = 'layaway' AND layaway_account_id = p_id))
   FOR UPDATE;

  IF v_rec.id IS NOT NULL THEN
    v_reason := CASE
      WHEN (v_snap ->> 'status') <> 'completed' THEN 'not_completed'
      WHEN coalesce((v_lines ->> 'refunds')::numeric, 0) > 0 THEN 'refunded'
      WHEN (v_snap ->> 'disputed')::boolean THEN 'disputed'
      WHEN NOT (v_snap ->> 'fully_paid')::boolean THEN 'not_fully_paid'
      WHEN NOT (v_snap ->> 'adds_up')::boolean THEN 'does_not_add_up'
      WHEN v_rec.customer_id IS DISTINCT FROM (v_snap ->> 'customer_id')::uuid THEN 'owner_changed'
      WHEN v_rec.lines IS DISTINCT FROM v_lines OR v_rec.currency::text IS DISTINCT FROM (v_snap ->> 'currency') THEN 'figures_changed'
      ELSE NULL
    END;
    IF v_reason IS NULL THEN
      RETURN jsonb_build_object('action', 'kept', 'receipt_id', v_rec.id, 'receipt_number', v_rec.receipt_number);
    END IF;
    UPDATE public.website_receipts
       SET status = 'cancelled', cancelled_at = v_now, cancel_reason = v_reason
     WHERE id = v_rec.id;
    v_cancelled := v_rec.id;
    v_action := 'cancelled';
  END IF;

  IF NOT (v_snap ->> 'fully_paid')::boolean THEN
    RETURN jsonb_build_object('action', v_action, 'cancelled_id', v_cancelled, 'reason', v_reason);
  END IF;
  v_mode := public.web_receipts_mode();
  v_live := public.web_receipts_live_at();
  IF v_mode = 'off' OR v_live IS NULL
     OR (v_snap ->> 'completed_at') IS NULL
     OR (v_snap ->> 'completed_at')::timestamptz < v_live
     OR (v_mode = 'test') <> (v_snap ->> 'is_test')::boolean THEN
    RETURN jsonb_build_object('action', v_action, 'cancelled_id', v_cancelled, 'reason', v_reason, 'not_issued', 'switch');
  END IF;
  IF NOT (v_snap ->> 'adds_up')::boolean THEN
    RAISE WARNING 'website receipt not issued for % %: %', p_kind, p_id, v_snap ->> 'problem';
    INSERT INTO public.staff_notifications (type, title, body, account_id, customer_id, invoice_number, metadata)
    SELECT 'website_receipt_not_issued',
           'Receipt not issued — order ' || coalesce(v_snap ->> 'order_number', v_snap ->> 'invoice_number', p_id::text),
           'This website order is fully paid but no receipt was issued: '
             || CASE v_snap ->> 'problem'
                  WHEN 'no_items' THEN 'the order has no item lines.'
                  WHEN 'lines_mismatch' THEN 'the item lines do not add up (unit price × quantity ≠ line total).'
                  WHEN 'block_mismatch' THEN 'items, discount, shipping and fees do not add up to the money received.'
                  WHEN 'peso_no_rate' THEN 'the peso order has no exchange rate stored.'
                  WHEN 'peso_lines_mismatch' THEN 'the peso item amounts cannot be made to add up (no single-quantity line to carry the rounding).'
                  ELSE 'its figures do not add up.'
                END
             || ' Correct the order and the receipt is issued automatically.',
           CASE WHEN p_kind = 'layaway' THEN p_id END,
           (v_snap ->> 'customer_id')::uuid,
           v_snap ->> 'invoice_number',
           jsonb_build_object('order_id', p_id, 'kind', p_kind, 'reason', v_snap ->> 'problem',
                              'cash_order_id', CASE WHEN p_kind = 'cash' THEN p_id END)
     WHERE NOT EXISTS (
       SELECT 1 FROM public.staff_notifications n
        WHERE n.type = 'website_receipt_not_issued'
          AND n.metadata ->> 'order_id' = p_id::text
          AND n.metadata ->> 'reason' IS NOT DISTINCT FROM (v_snap ->> 'problem'));
    RETURN jsonb_build_object('action', v_action, 'cancelled_id', v_cancelled, 'reason', v_reason,
                              'not_issued', 'does_not_add_up', 'problem', v_snap ->> 'problem');
  END IF;

  v_number := 'CJR-' || to_char(v_now AT TIME ZONE 'Asia/Tokyo', 'YYYY') || '-'
              || lpad(nextval('public.website_receipt_number_seq')::text, 6, '0');
  INSERT INTO public.website_receipts (
    receipt_number, cash_order_id, layaway_account_id, customer_id, currency, order_number,
    lines, total_paid, penalty_total, taxable_total, subtotal, tax_amount, fx_rate_used,
    verify_code, status, issued_at, created_at
  ) VALUES (
    v_number,
    CASE WHEN p_kind = 'cash' THEN p_id END,
    CASE WHEN p_kind = 'layaway' THEN p_id END,
    (v_snap ->> 'customer_id')::uuid,
    (v_snap ->> 'currency')::public.account_currency,
    v_snap ->> 'order_number',
    v_lines,
    (v_lines ->> 'received')::numeric,
    (v_lines ->> 'penalties')::numeric,
    (v_lines ->> 'product_amount')::numeric,
    (v_lines ->> 'subtotal')::numeric,
    (v_lines ->> 'tax')::numeric,
    CASE WHEN (v_snap ->> 'currency') = 'PHP' THEN (v_snap ->> 'fx_rate_used')::numeric END,
    encode(extensions.gen_random_bytes(20), 'hex'),
    'issued', v_now, v_now
  ) RETURNING id INTO v_new_id;

  RETURN jsonb_build_object('action', CASE WHEN v_cancelled IS NULL THEN 'issued' ELSE 'cancelled_and_issued' END,
                            'receipt_id', v_new_id, 'receipt_number', v_number,
                            'cancelled_id', v_cancelled, 'reason', v_reason);
END
$fn$;
REVOKE ALL ON FUNCTION public.web_receipt_sync(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.web_receipt_sync(text, uuid) TO service_role;
COMMENT ON FUNCTION public.web_receipt_sync(text, uuid) IS
  'Reconciles a website order''s receipt with the order: cancels an issued receipt that no longer matches (reason kept), issues a NEW number when the order is fully paid and web_receipts_mode / live_at allow it. Called by the deferred triggers; idempotent. docs/RECEIPTS.md.';

-- ---------------------------------------------------------------------------
-- 5. Deferred triggers. CONSTRAINT triggers, DEFERRABLE INITIALLY DEFERRED:
--    they run at COMMIT, after every payment / status write of the transaction.
--    A failure inside the sync is caught and logged (WARNING) so it can never
--    roll back a payment, a cancel or a refund.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_web_receipt_sync()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_kind text;
  v_id   uuid;
  v_web  boolean;
BEGIN
  IF TG_TABLE_NAME = 'cash_orders' THEN
    v_kind := 'cash'; v_id := NEW.id;
  ELSIF TG_TABLE_NAME = 'layaway_accounts' THEN
    v_kind := 'layaway'; v_id := NEW.id;
  ELSIF TG_TABLE_NAME = 'penalty_fees' THEN
    v_kind := 'layaway';
    v_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.account_id ELSE NEW.account_id END;
  ELSE
    v_kind := 'cash';
    v_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.cash_order_id ELSE NEW.cash_order_id END;
  END IF;
  IF v_id IS NULL THEN RETURN NULL; END IF;

  IF v_kind = 'cash' THEN
    SELECT source_channel = 'web' INTO v_web FROM public.cash_orders WHERE id = v_id;
  ELSE
    SELECT source_channel = 'web' INTO v_web FROM public.layaway_accounts WHERE id = v_id;
  END IF;
  IF NOT coalesce(v_web, false) THEN RETURN NULL; END IF;

  BEGIN
    PERFORM public.web_receipt_sync(v_kind, v_id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'web_receipt_sync(%, %) failed: % (%)', v_kind, v_id, SQLERRM, SQLSTATE;
  END;
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION public.trg_web_receipt_sync() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_zz_web_receipt_sync ON public.cash_orders;
CREATE CONSTRAINT TRIGGER trg_zz_web_receipt_sync
AFTER UPDATE ON public.cash_orders
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW.source_channel = 'web' AND (
       OLD.status IS DISTINCT FROM NEW.status
    OR OLD.completed_at IS DISTINCT FROM NEW.completed_at
    OR OLD.customer_id IS DISTINCT FROM NEW.customer_id
    OR OLD.currency IS DISTINCT FROM NEW.currency
    OR OLD.total_amount IS DISTINCT FROM NEW.total_amount
    OR OLD.total_paid IS DISTINCT FROM NEW.total_paid
    OR OLD.remaining_balance IS DISTINCT FROM NEW.remaining_balance
    OR OLD.discount_amount IS DISTINCT FROM NEW.discount_amount
    OR OLD.shipping_fee IS DISTINCT FROM NEW.shipping_fee
    OR OLD.cod_fee IS DISTINCT FROM NEW.cod_fee
    OR OLD.refund_status IS DISTINCT FROM NEW.refund_status))
EXECUTE FUNCTION public.trg_web_receipt_sync();

DROP TRIGGER IF EXISTS trg_zz_web_receipt_sync ON public.layaway_accounts;
CREATE CONSTRAINT TRIGGER trg_zz_web_receipt_sync
AFTER UPDATE ON public.layaway_accounts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW.source_channel = 'web' AND (
       OLD.status IS DISTINCT FROM NEW.status
    OR OLD.completed_at IS DISTINCT FROM NEW.completed_at
    OR OLD.customer_id IS DISTINCT FROM NEW.customer_id
    OR OLD.currency IS DISTINCT FROM NEW.currency
    OR OLD.total_amount IS DISTINCT FROM NEW.total_amount
    OR OLD.total_paid IS DISTINCT FROM NEW.total_paid
    OR OLD.remaining_balance IS DISTINCT FROM NEW.remaining_balance
    OR OLD.discount_amount IS DISTINCT FROM NEW.discount_amount
    OR OLD.shipping_fee IS DISTINCT FROM NEW.shipping_fee))
EXECUTE FUNCTION public.trg_web_receipt_sync();

DROP TRIGGER IF EXISTS trg_zz_web_receipt_sync ON public.penalty_fees;
CREATE CONSTRAINT TRIGGER trg_zz_web_receipt_sync
AFTER INSERT OR UPDATE OR DELETE ON public.penalty_fees
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.trg_web_receipt_sync();

DROP TRIGGER IF EXISTS trg_zz_web_receipt_sync ON public.square_refunds;
CREATE CONSTRAINT TRIGGER trg_zz_web_receipt_sync
AFTER INSERT OR UPDATE ON public.square_refunds
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.trg_web_receipt_sync();

DROP TRIGGER IF EXISTS trg_zz_web_receipt_sync ON public.square_disputes;
CREATE CONSTRAINT TRIGGER trg_zz_web_receipt_sync
AFTER INSERT OR UPDATE ON public.square_disputes
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.trg_web_receipt_sync();

DROP TRIGGER IF EXISTS trg_zz_web_receipt_sync ON public.paidy_refunds;
CREATE CONSTRAINT TRIGGER trg_zz_web_receipt_sync
AFTER INSERT OR UPDATE ON public.paidy_refunds
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.trg_web_receipt_sync();

-- ---------------------------------------------------------------------------
-- 6. Service-role RPCs.
-- ---------------------------------------------------------------------------

-- The customer's receipts (website GET /me/receipts). kind cash | layaway.
CREATE OR REPLACE FUNCTION public.website_receipts_for_customer(p_customer_id uuid)
RETURNS TABLE (id uuid, receipt_number text, kind text, order_id uuid, order_number text, status text,
               currency text, total_paid numeric, issued_at timestamptz, cancelled_at timestamptz,
               addressee text, purpose text, issue_count integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT r.id, r.receipt_number,
         CASE WHEN r.cash_order_id IS NOT NULL THEN 'cash' ELSE 'layaway' END,
         coalesce(r.cash_order_id, r.layaway_account_id), r.order_number, r.status,
         r.currency::text, r.total_paid, r.issued_at, r.cancelled_at, r.addressee, r.purpose,
         (SELECT count(*)::integer FROM public.website_receipt_issues i WHERE i.receipt_id = r.id)
    FROM public.website_receipts r
   WHERE r.customer_id = p_customer_id
   ORDER BY r.issued_at DESC, r.receipt_number DESC
   LIMIT 200
$fn$;
REVOKE ALL ON FUNCTION public.website_receipts_for_customer(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.website_receipts_for_customer(uuid) TO service_role;

-- Edit addressee / purpose (website PATCH /me/receipts/:id). Own receipt,
-- issued only. Trimmed; addressee 0–60 chars (empty = none), purpose 1–40
-- (empty = the default お品代として). No control characters.
CREATE OR REPLACE FUNCTION public.update_website_receipt_details(
  p_receipt_id uuid, p_customer_id uuid, p_addressee text, p_purpose text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_rec public.website_receipts%ROWTYPE;
  v_addr text := btrim(coalesce(p_addressee, ''));
  v_purp text := btrim(coalesce(p_purpose, ''));
BEGIN
  SELECT * INTO v_rec FROM public.website_receipts WHERE id = p_receipt_id FOR UPDATE;
  IF v_rec.id IS NULL OR v_rec.customer_id IS DISTINCT FROM p_customer_id THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF v_rec.status <> 'issued' THEN
    RETURN jsonb_build_object('error', 'receipt_cancelled');
  END IF;
  IF v_addr ~ '[[:cntrl:]]' OR v_purp ~ '[[:cntrl:]]' THEN
    RETURN jsonb_build_object('error', 'invalid_characters');
  END IF;
  IF char_length(v_addr) > 60 THEN RETURN jsonb_build_object('error', 'addressee_too_long', 'max', 60); END IF;
  IF char_length(v_purp) > 40 THEN RETURN jsonb_build_object('error', 'purpose_too_long', 'max', 40); END IF;
  UPDATE public.website_receipts
     SET addressee = nullif(v_addr, ''),
         purpose = coalesce(nullif(v_purp, ''), 'お品代として')
   WHERE id = v_rec.id;
  RETURN jsonb_build_object('ok', true, 'addressee', nullif(v_addr, ''), 'purpose', coalesce(nullif(v_purp, ''), 'お品代として'));
END
$fn$;
REVOKE ALL ON FUNCTION public.update_website_receipt_details(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_website_receipt_details(uuid, uuid, text, text) TO service_role;

-- Record one download (website GET /me/receipts/:id/pdf) and hand back what
-- the PDF prints. Own, issued receipts only. issue_no = previous count + 1,
-- under the receipt's row lock; is_reissue from the 2nd download on.
CREATE OR REPLACE FUNCTION public.record_website_receipt_issue(
  p_receipt_id uuid, p_customer_id uuid, p_language text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_rec  public.website_receipts%ROWTYPE;
  v_no   integer;
  v_lang text := CASE WHEN p_language = 'en' THEN 'en' ELSE 'ja' END;
  v_at   timestamptz := now();
BEGIN
  SELECT * INTO v_rec FROM public.website_receipts WHERE id = p_receipt_id FOR UPDATE;
  IF v_rec.id IS NULL OR v_rec.customer_id IS DISTINCT FROM p_customer_id THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF v_rec.status <> 'issued' THEN
    RETURN jsonb_build_object('error', 'receipt_cancelled');
  END IF;
  SELECT coalesce(max(issue_no), 0) + 1 INTO v_no FROM public.website_receipt_issues WHERE receipt_id = v_rec.id;
  INSERT INTO public.website_receipt_issues (receipt_id, issue_no, is_reissue, language, addressee, purpose, issued_at)
  VALUES (v_rec.id, v_no, v_no > 1, v_lang, v_rec.addressee, v_rec.purpose, v_at);
  RETURN jsonb_build_object(
    'ok', true, 'issue_no', v_no, 'is_reissue', v_no > 1, 'language', v_lang, 'downloaded_at', v_at,
    'receipt', jsonb_build_object(
      'id', v_rec.id, 'receipt_number', v_rec.receipt_number,
      'kind', CASE WHEN v_rec.cash_order_id IS NOT NULL THEN 'cash' ELSE 'layaway' END,
      'order_number', v_rec.order_number, 'currency', v_rec.currency::text, 'lines', v_rec.lines,
      'total_paid', v_rec.total_paid, 'penalty_total', v_rec.penalty_total, 'taxable_total', v_rec.taxable_total,
      'subtotal', v_rec.subtotal, 'tax_amount', v_rec.tax_amount, 'fx_rate_used', v_rec.fx_rate_used,
      'addressee', v_rec.addressee, 'purpose', v_rec.purpose, 'verify_code', v_rec.verify_code,
      'issued_at', v_rec.issued_at));
END
$fn$;
REVOKE ALL ON FUNCTION public.record_website_receipt_issue(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_website_receipt_issue(uuid, uuid, text) TO service_role;

-- Public verification (website GET /receipts/verify). ONLY number, issue date,
-- total, currency and valid/cancelled. NULL when the code matches nothing.
CREATE OR REPLACE FUNCTION public.verify_website_receipt(p_code text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT jsonb_build_object('receipt_number', r.receipt_number, 'issued_at', r.issued_at,
                            'total', r.total_paid, 'currency', r.currency::text,
                            'status', CASE WHEN r.status = 'issued' THEN 'valid' ELSE 'cancelled' END)
    FROM public.website_receipts r
   WHERE r.verify_code = lower(btrim(coalesce(p_code, '')))
$fn$;
REVOKE ALL ON FUNCTION public.verify_website_receipt(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_website_receipt(text) TO service_role;

-- The email sweep: issued receipts not yet emailed, under 5 attempts, issued
-- in the last 7 days, oldest first.
CREATE OR REPLACE FUNCTION public.website_receipt_email_candidates(p_limit integer)
RETURNS TABLE (id uuid, receipt_number text, kind text, order_id uuid, customer_id uuid, attempts integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT r.id, r.receipt_number, CASE WHEN r.cash_order_id IS NOT NULL THEN 'cash' ELSE 'layaway' END,
         coalesce(r.cash_order_id, r.layaway_account_id), r.customer_id, r.email_attempts
    FROM public.website_receipts r
   WHERE r.status = 'issued' AND r.email_sent_at IS NULL AND r.email_attempts < 5
     AND r.issued_at > now() - interval '7 days'
   ORDER BY r.issued_at
   LIMIT greatest(coalesce(p_limit, 50), 0)
$fn$;
REVOKE ALL ON FUNCTION public.website_receipt_email_candidates(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.website_receipt_email_candidates(integer) TO service_role;

-- Record a send outcome. p_sent true → email_sent_at = now() (also used for a
-- final skip such as a test customer, so the receipt leaves the queue).
CREATE OR REPLACE FUNCTION public.finish_website_receipt_email(p_id uuid, p_sent boolean, p_error text)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  UPDATE public.website_receipts
     SET email_attempts = email_attempts + 1,
         email_sent_at = CASE WHEN p_sent THEN now() ELSE email_sent_at END,
         email_last_error = CASE WHEN p_sent THEN NULL ELSE left(p_error, 500) END
   WHERE id = p_id AND email_sent_at IS NULL
$fn$;
REVOKE ALL ON FUNCTION public.finish_website_receipt_email(uuid, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_website_receipt_email(uuid, boolean, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 7. Private bucket receipt-assets. The owner uploads (Dashboard):
--      fonts/NotoSansJP-Regular.ttf   Noto Sans JP Regular (OFL), whole file
--    No seal (owner 2026-10-27: the receipt carries no stamp).
--    Read ONLY by the website edge function with the service role. No object
--    policies: authenticated / anon can neither read nor list it.
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('receipt-assets', 'receipt-assets', false, 20971520,
        ARRAY['font/ttf', 'font/otf', 'font/sfnt', 'application/x-font-ttf', 'application/font-sfnt',
              'application/octet-stream'])
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 8. Schedule: the receipt-ready email sweep, every 10 minutes (Vault key, as
--    every other service-role cron job). Skipped where cron / vault is absent.
-- ---------------------------------------------------------------------------
DO $c$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') AND EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'vault') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'website-receipt-emails') THEN
      PERFORM cron.unschedule('website-receipt-emails');
    END IF;
    PERFORM cron.schedule('website-receipt-emails', '4,14,24,34,44,54 * * * *', $job$
      SELECT net.http_post(
        url := 'https://pfoicalpzdcmyxzvwyhz.supabase.co/functions/v1/website-receipt-emails',
        headers := jsonb_build_object('Content-Type', 'application/json',
                                      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key')),
        body := '{"trigger":"cron"}'::jsonb);
    $job$);
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'website-receipt-emails cron schedule skipped: %', SQLERRM;
END
$c$;

-- ---------------------------------------------------------------------------
-- 9. Self-checks: refuse to COMMIT a half-built state.
-- ---------------------------------------------------------------------------
DO $chk$
DECLARE
  v_bad text := '';
BEGIN
  IF public.web_receipts_mode() IS NULL THEN v_bad := v_bad || ' mode_reader'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_guard_web_receipts_settings') THEN v_bad := v_bad || ' settings_guard'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_guard_website_receipts') THEN v_bad := v_bad || ' receipts_guard'; END IF;
  IF (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE t.tgname = 'trg_zz_web_receipt_sync' AND t.tgdeferrable AND t.tginitdeferred
         AND c.relname IN ('cash_orders', 'layaway_accounts', 'penalty_fees', 'square_refunds', 'square_disputes', 'paidy_refunds')) <> 6 THEN
    v_bad := v_bad || ' sync_triggers';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'receipt-assets' AND public = false) THEN v_bad := v_bad || ' bucket'; END IF;
  IF has_function_privilege('authenticated', 'public.web_receipt_sync(text, uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.web_receipt_sync(text, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.record_website_receipt_issue(uuid, uuid, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.verify_website_receipt(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.web_receipt_snapshot(text, uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.set_web_receipts_mode(text, text)', 'EXECUTE') THEN
    v_bad := v_bad || ' grants';
  END IF;
  IF has_table_privilege('authenticated', 'public.website_receipts', 'INSERT')
     OR has_table_privilege('authenticated', 'public.website_receipts', 'UPDATE')
     OR has_table_privilege('anon', 'public.website_receipts', 'SELECT') THEN
    v_bad := v_bad || ' table_grants';
  END IF;
  IF v_bad <> '' THEN
    RAISE EXCEPTION 'STOP — website receipts self-check failed:%', v_bad;
  END IF;
END
$chk$;

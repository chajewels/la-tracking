-- Cancel for layaway + cash cancel wiring (owner, 2026-10-21; plan
-- claude/cancel-layaway-plan-2026-10-21.md, owner "confirmed").
--
-- Why: a layaway had no staff Cancel. INV 19848 (CJ-2026-03704) earned 3,600
-- points on its downpayment, the order was treated as cancelled outside the Hub,
-- and nothing reversed the points because no Hub action could set a paid layaway
-- to 'cancelled' (docs/LOYALTY-LIFECYCLE.md listed 'cancelled' as FUTURE).
--
-- Owner decisions (2026-10-21):
--   * Who may cancel a layaway: the Forfeit permission (forfeit_account),
--     enforced in the cancel-layaway edge function. No new key.
--   * A payment submission still waiting (status 'submitted', on the account or
--     through payment_submission_allocations) REFUSES the cancel.
--   * Sales: a paid-then-cancelled layaway COUNTS LIKE FORFEITED in Monthly Sales
--     and the trade KPIs. "Cancelled by staff" is marked by cancelled_at, which
--     only cancel_layaway_atomic sets; layaways the deposit-expiry job sets to
--     'cancelled' (unpaid web reservations) keep cancelled_at NULL and stay out.
--   * The customer gets an email (cancel-layaway edge function, not here).
-- Locked rules kept: earned points revoked (trigger 'cancel', spend from
-- loyalty_order_spend_basis via revoke_loyalty_points); redeemed points are NOT
-- returned; a layaway NEVER auto-issues store credit (STORE CREDIT rules); a paid
-- order is never deleted; last_purchase_at is untouched (a paid order later
-- cancelled still counts, 2026-09-29). Cancel is terminal: reactivate stays
-- forfeited-only, and cancel never sets expired_at, so web "Revive" stays off.
--
-- Sections
--   1. layaway_accounts: cancellation_reason, cancelled_at, cancelled_by_user_id
--      (same three columns cash_orders has).
--   2. cancel_layaway_atomic — NEW. Preview mode writes nothing. One
--      transaction: refuse closed accounts and waiting submissions; revoke earned
--      points; status 'cancelled' + reason; unpaid schedule rows cancelled; web
--      stock back on sale once (stock_released_at guard); sales_log row
--      Cancelled + eligible false (commission off); note; audit. Page365 held
--      stock is released by the existing trg_page365_stock_follow_layaway
--      ('cancelled' is already a dead status there). service_role only.
--   3. In-place patches from live (pg_temp.cj_patch, Bug #280):
--      a. allocate_payment_atomic   — refuses a cancelled layaway (only
--         'cancelled': final_forfeited must keep taking the one same-day
--         settlement payment, owner rule 2026-10-20).
--      b. cancel_cash_order_atomic  — sales_log row Cancelled + eligible false.
--      c. terminate_web_order_atomic — same, on the cancel outcome only.
--      d. get_monthly_sales, get_trade_kpis, get_trade_monthly_trends —
--         a staff-cancelled layaway (cancelled_at set) counts like forfeited.
--
-- Live md5(pg_get_functiondef) read 2026-10-21 and the patched md5 computed on
-- live with the same replace (read-only), every anchor found exactly once:
--   allocate_payment_atomic     77aca9392fecf08824b765c02025e014 → fab3b0eb1843cfa20e2e85b97ca54cc3
--   cancel_cash_order_atomic    25621d49d58e9cc9dc09c70e5f3928a8 → 06fb9394e5e4d8d3f3113aa3f5937261
--   terminate_web_order_atomic  13b97cb1a440ab10ff6dd9cd9af7f4fe → 2c72d6c1d488cf11e1cd61a8d23bc6f6
--   get_monthly_sales           9798341e4b75f262a173c2751cc60ef3 → 4ce37e63cbe6c037352d2a6b7e72341d
--   get_trade_kpis              c6f95e42eed4823b17d245409054a463 → 53039b01010c09f7c434c64bb7f2bca9
--   get_trade_monthly_trends    bc06913760c3f7ddd22d2c60b07ea91c → 713440f1ec4e052b233db31898195cb0
-- scripts/function-drift-audit on 2026-10-21: 432 functions, a_differs 0,
-- b_live_only 0, c_repo_only 0. Each patch STOPs on any other live body, is a
-- no-op once applied, and section 4 asserts every post-patch md5. The full
-- post-patch bodies are recorded by a record-only migration read from live right
-- after apply (as 20261218100000 / 20261218100100). GRANTS on patched functions
-- are not touched (CREATE OR REPLACE keeps the live ACL). No comment lines inside
-- function bodies or cj_patch 'new' blocks (Lovable drops them on apply).

-- ---------------------------------------------------------------------------
-- 0. The patch helper (session-only; same as 20261223100000).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pg_temp.cj_patch(p_sig text, p_before text, p_edits jsonb)
RETURNS void LANGUAGE plpgsql AS $p$
DECLARE
  v_fn   regprocedure;
  v_def  text;
  v_new  text;
  e      jsonb;
  v_n    integer;
  v_done boolean := true;
BEGIN
  v_fn := to_regprocedure(p_sig);
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'STOP — % is not on live; nothing changed', p_sig;
  END IF;
  v_def := pg_get_functiondef(v_fn);
  FOR e IN SELECT * FROM jsonb_array_elements(p_edits) LOOP
    IF position(e ->> 'new' IN v_def) = 0 THEN v_done := false; END IF;
  END LOOP;
  IF v_done THEN
    RAISE NOTICE '% already patched — no change', p_sig;
    RETURN;
  END IF;
  IF md5(v_def) <> p_before THEN
    RAISE EXCEPTION 'STOP — % has moved on live (md5 %); re-read it before patching. Nothing changed.', p_sig, md5(v_def);
  END IF;
  v_new := v_def;
  FOR e IN SELECT * FROM jsonb_array_elements(p_edits) LOOP
    v_n := (length(v_new) - length(replace(v_new, e ->> 'old', ''))) / length(e ->> 'old');
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'STOP — % anchor found % times, expected 1: %', p_sig, v_n, left(e ->> 'old', 120);
    END IF;
    v_new := replace(v_new, e ->> 'old', e ->> 'new');
  END LOOP;
  EXECUTE v_new;
  IF md5(pg_get_functiondef(v_fn)) <> md5(v_new) THEN
    RAISE EXCEPTION 'STOP — % did not store the patched body exactly; rolled back', p_sig;
  END IF;
END
$p$;

-- ---------------------------------------------------------------------------
-- 1. Cancellation columns on layaway_accounts (match cash_orders).
-- ---------------------------------------------------------------------------
ALTER TABLE public.layaway_accounts
  ADD COLUMN IF NOT EXISTS cancellation_reason text,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by_user_id uuid;

COMMENT ON COLUMN public.layaway_accounts.cancelled_at IS
  'Set ONLY by cancel_layaway_atomic (staff Cancel). NULL on layaways the deposit-expiry job set to cancelled. Sales reports count a cancelled layaway only when this is set.';

-- ---------------------------------------------------------------------------
-- 2. cancel_layaway_atomic — the staff Cancel for a layaway.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancel_layaway_atomic(
  p_account_id uuid,
  p_reason text,
  p_user_id uuid DEFAULT NULL::uuid,
  p_user_email text DEFAULT NULL::text,
  p_preview boolean DEFAULT false,
  p_source text DEFAULT 'staff'::text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_status         text;
  v_channel        text;
  v_invoice        text;
  v_web_ref        text;
  v_customer_id    uuid;
  v_currency       account_currency;
  v_stock_released timestamptz;
  v_is_web         boolean;
  v_reason         text;
  v_money          numeric(12,2) := 0;
  v_synthetic      numeric(12,2) := 0;
  v_pending        integer := 0;
  v_earned_points  numeric := 0;
  v_redeemed       numeric := 0;
  v_member_id      uuid;
  v_revoked_tx     uuid := NULL;
  v_flipped        integer := 0;
  v_sched          integer := 0;
  v_restored       integer := 0;
  v_sales          integer := 0;
  v_refusal        text;
  v_symbol         text;
  v_now            timestamptz := now();
BEGIN
  IF NOT p_preview AND p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_identity_required' USING ERRCODE = 'P0001';
  END IF;
  v_reason := NULLIF(btrim(COALESCE(p_reason, '')), '');
  IF NOT p_preview AND v_reason IS NULL THEN
    RAISE EXCEPTION 'cancellation_reason_required' USING ERRCODE = 'P0001';
  END IF;

  SELECT status::text, source_channel, invoice_number, web_reference, customer_id, currency, stock_released_at
    INTO v_status, v_channel, v_invoice, v_web_ref, v_customer_id, v_currency, v_stock_released
    FROM public.layaway_accounts
   WHERE id = p_account_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'layaway_not_found: %', p_account_id USING ERRCODE = 'P0001';
  END IF;
  v_is_web := (v_channel = 'web');
  v_symbol := CASE WHEN v_currency = 'PHP' THEN '₱' ELSE '¥' END;

  SELECT count(DISTINCT s.id) INTO v_pending
    FROM public.payment_submissions s
    LEFT JOIN public.payment_submission_allocations a ON a.submission_id = s.id
   WHERE s.status = 'submitted'
     AND (s.account_id = p_account_id OR a.account_id = p_account_id);

  SELECT COALESCE(SUM(amount_paid), 0) INTO v_money
    FROM public.payments
   WHERE account_id = p_account_id AND voided_at IS NULL
     AND COALESCE(reference_number, '') NOT LIKE 'LOYALTY-%';
  SELECT COALESCE(SUM(amount_paid), 0) INTO v_synthetic
    FROM public.payments
   WHERE account_id = p_account_id AND voided_at IS NULL
     AND COALESCE(reference_number, '') LIKE 'LOYALTY-%';
  SELECT COALESCE(SUM(points_amount), 0) INTO v_earned_points
    FROM public.loyalty_transactions
   WHERE account_id = p_account_id AND transaction_type::text = 'earned';
  SELECT COALESCE(SUM(points_redeemed), 0) INTO v_redeemed
    FROM public.loyalty_redemptions
   WHERE account_id = p_account_id AND status::text = 'confirmed';

  v_refusal := CASE
    WHEN v_status NOT IN ('active', 'overdue', 'extension_active', 'reactivated', 'final_settlement') THEN 'not_cancellable'
    WHEN v_pending > 0 THEN 'payment_submission_pending'
  END;

  IF p_preview THEN
    RETURN jsonb_build_object(
      'preview', true,
      'account_id', p_account_id,
      'invoice_number', v_invoice,
      'web_reference', v_web_ref,
      'status', v_status,
      'is_web', v_is_web,
      'currency', v_currency,
      'money_received', v_money,
      'loyalty_redemption_excluded', v_synthetic,
      'store_credit_to_issue', 0,
      'earned_points_on_order', v_earned_points,
      'earned_points_will_be_revoked', v_earned_points > 0,
      'redeemed_points_not_returned', v_redeemed,
      'pending_submissions', v_pending,
      'web_stock_will_be_released', v_is_web AND v_stock_released IS NULL,
      'refusal', v_refusal);
  END IF;

  IF v_refusal = 'not_cancellable' THEN
    RAISE EXCEPTION 'layaway_not_cancellable: status is %', v_status USING ERRCODE = 'P0001';
  END IF;
  IF v_refusal = 'payment_submission_pending' THEN
    RAISE EXCEPTION 'payment_submission_pending: % payment submission(s) on this layaway are waiting — confirm or reject them first', v_pending USING ERRCODE = 'P0001';
  END IF;

  SELECT id INTO v_member_id FROM public.loyalty_members WHERE customer_id = v_customer_id;
  IF v_member_id IS NOT NULL AND v_invoice IS NOT NULL THEN
    v_revoked_tx := public.revoke_loyalty_points(
      p_member_id => v_member_id, p_source_reference => v_invoice, p_spend_jpy => 0,
      p_account_id => p_account_id, p_cash_order_id => NULL, p_payment_id => NULL,
      p_invoice_number => v_invoice,
      p_notes => 'Revoked: layaway cancelled (' || v_reason || ')',
      p_created_by_user_id => p_user_id,
      p_trigger_event => 'cancel');
  END IF;

  UPDATE public.layaway_accounts
     SET status               = 'cancelled'::account_status,
         cancellation_reason  = v_reason,
         cancelled_at         = v_now,
         cancelled_by_user_id = p_user_id,
         stock_released_at    = CASE WHEN v_is_web AND stock_released_at IS NULL THEN v_now ELSE stock_released_at END,
         updated_at           = v_now
   WHERE id = p_account_id
     AND status::text IN ('active', 'overdue', 'extension_active', 'reactivated', 'final_settlement');
  GET DIAGNOSTICS v_flipped = ROW_COUNT;
  IF v_flipped = 0 THEN
    RAISE EXCEPTION 'cancel_layaway: status flip failed for %', p_account_id USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.layaway_schedule
     SET status = 'cancelled', updated_at = v_now
   WHERE account_id = p_account_id AND status <> 'paid';
  GET DIAGNOSTICS v_sched = ROW_COUNT;

  IF v_is_web AND v_stock_released IS NULL THEN
    UPDATE public.website_product_variants v
       SET stock_qty = v.stock_qty + i.quantity, updated_at = v_now
      FROM public.layaway_account_items i
     WHERE i.account_id = p_account_id AND i.variant_id = v.id;
    GET DIAGNOSTICS v_restored = ROW_COUNT;
  END IF;

  UPDATE public.sales_log
     SET status = 'Cancelled', eligible = false, updated_at = v_now
   WHERE invoice_number = v_invoice AND status IS DISTINCT FROM 'Cancelled';
  GET DIAGNOSTICS v_sales = ROW_COUNT;

  INSERT INTO public.account_notes (account_id, note_text, created_by_user_id, created_by_name)
  VALUES (p_account_id,
    'Layaway cancelled: ' || v_reason ||
    CASE WHEN v_money > 0
         THEN ' — money received ' || v_symbol || v_money || ' stays on the account; no store credit issued automatically'
         ELSE ' — no payments received' END ||
    CASE WHEN v_redeemed > 0 THEN ' — ' || v_redeemed || ' redeemed points not returned' ELSE '' END,
    p_user_id, COALESCE(p_user_email, 'System'));

  INSERT INTO public.audit_logs (entity_type, entity_id, action, performed_by_user_id, new_value_json)
  VALUES ('layaway_account', p_account_id, 'cancel', p_user_id, jsonb_build_object(
    'invoice_number', v_invoice,
    'web_reference', v_web_ref,
    'reason', v_reason,
    'prior_status', v_status,
    'source_channel', v_channel,
    'currency', v_currency,
    'money_received', v_money,
    'loyalty_redemption_excluded', v_synthetic,
    'earned_points_revoked_tx', v_revoked_tx,
    'redeemed_points_not_returned', v_redeemed,
    'schedule_rows_cancelled', v_sched,
    'stock_lines_restored', v_restored,
    'sales_log_rows_cancelled', v_sales,
    'source', p_source,
    'user_email', p_user_email));

  RETURN jsonb_build_object(
    'success', true,
    'account_id', p_account_id,
    'invoice_number', v_invoice,
    'web_reference', v_web_ref,
    'is_web', v_is_web,
    'prior_status', v_status,
    'cancelled_at', v_now,
    'money_received', v_money,
    'earned_points_revoked_tx', v_revoked_tx,
    'redeemed_points_not_returned', v_redeemed,
    'schedule_rows_cancelled', v_sched,
    'stock_lines_restored', v_restored,
    'sales_log_rows_cancelled', v_sales,
    'source', p_source);
END
$function$;

REVOKE ALL ON FUNCTION public.cancel_layaway_atomic(uuid, text, uuid, text, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_layaway_atomic(uuid, text, uuid, text, boolean, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 3a. allocate_payment_atomic: never record money on a cancelled layaway.
-- ---------------------------------------------------------------------------
SELECT pg_temp.cj_patch('public.allocate_payment_atomic(uuid,numeric,date,text,text,text,uuid,text,boolean,text,text,boolean)', '77aca9392fecf08824b765c02025e014', jsonb_build_array(
  jsonb_build_object('old', $o0$  IF v_total_amount IS NULL THEN
    RAISE EXCEPTION 'account_not_found: %', p_account_id;
  END IF;
$o0$, 'new', $n0$  IF v_total_amount IS NULL THEN
    RAISE EXCEPTION 'account_not_found: %', p_account_id;
  END IF;
  IF v_cur_status = 'cancelled' THEN
    RAISE EXCEPTION 'account_cancelled: layaway % is cancelled — no payment can be recorded on it', p_account_id USING ERRCODE = 'P0001';
  END IF;
$n0$)
));

-- ---------------------------------------------------------------------------
-- 3b. cancel_cash_order_atomic: the sales_log row leaves commission.
-- ---------------------------------------------------------------------------
SELECT pg_temp.cj_patch('public.cancel_cash_order_atomic(uuid,text,uuid,text,boolean,text)', '25621d49d58e9cc9dc09c70e5f3928a8', jsonb_build_array(
  jsonb_build_object('old', $o0$         cancelled_by_user_id = p_user_id, updated_at = now()
   WHERE id = p_cash_order_id;
$o0$, 'new', $n0$         cancelled_by_user_id = p_user_id, updated_at = now()
   WHERE id = p_cash_order_id;
  UPDATE public.sales_log
     SET status = 'Cancelled', eligible = false, updated_at = now()
   WHERE invoice_number = v_invoice AND status IS DISTINCT FROM 'Cancelled';
$n0$)
));

-- ---------------------------------------------------------------------------
-- 3c. terminate_web_order_atomic: same, on the cancel outcome only.
-- ---------------------------------------------------------------------------
SELECT pg_temp.cj_patch('public.terminate_web_order_atomic(uuid,text,text,uuid,text,text,text,text,boolean)', '13b97cb1a440ab10ff6dd9cd9af7f4fe', jsonb_build_array(
  jsonb_build_object('old', $o0$  IF v_flipped = 0 THEN
    RAISE EXCEPTION 'terminal_flip_failed for %', p_order_id USING ERRCODE='P0001';
  END IF;
$o0$, 'new', $n0$  IF v_flipped = 0 THEN
    RAISE EXCEPTION 'terminal_flip_failed for %', p_order_id USING ERRCODE='P0001';
  END IF;
  IF p_outcome <> 'expired' THEN
    UPDATE public.sales_log
       SET status = 'Cancelled', eligible = false, updated_at = v_now
     WHERE invoice_number = v_invoice AND status IS DISTINCT FROM 'Cancelled';
  END IF;
$n0$)
));

-- ---------------------------------------------------------------------------
-- 3d. Sales reports: a staff-cancelled layaway counts like forfeited.
-- ---------------------------------------------------------------------------
SELECT pg_temp.cj_patch('public.get_monthly_sales(text,integer)', '9798341e4b75f262a173c2751cc60ef3', jsonb_build_array(
  jsonb_build_object('old', $o0$        AND la.status <> 'cancelled'::account_status
$o0$, 'new', $n0$        AND (la.status <> 'cancelled'::account_status OR la.cancelled_at IS NOT NULL)
$n0$)
));

SELECT pg_temp.cj_patch('public.get_trade_kpis()', 'c6f95e42eed4823b17d245409054a463', jsonb_build_array(
  jsonb_build_object('old', $o0$    (SELECT COUNT(*) FROM public.layaway_accounts
     WHERE is_trade = true AND status::text != 'cancelled')
$o0$, 'new', $n0$    (SELECT COUNT(*) FROM public.layaway_accounts
     WHERE is_trade = true AND (status::text != 'cancelled' OR cancelled_at IS NOT NULL))
$n0$),
  jsonb_build_object('old', $o1$      FROM public.layaway_accounts
      WHERE is_trade = true AND status::text != 'cancelled'
$o1$, 'new', $n1$      FROM public.layaway_accounts
      WHERE is_trade = true AND (status::text != 'cancelled' OR cancelled_at IS NOT NULL)
$n1$),
  jsonb_build_object('old', $o2$    (SELECT COUNT(*) FROM public.layaway_accounts WHERE status::text != 'cancelled')
$o2$, 'new', $n2$    (SELECT COUNT(*) FROM public.layaway_accounts WHERE (status::text != 'cancelled' OR cancelled_at IS NOT NULL))
$n2$)
));

SELECT pg_temp.cj_patch('public.get_trade_monthly_trends(integer)', 'bc06913760c3f7ddd22d2c60b07ea91c', jsonb_build_array(
  jsonb_build_object('old', $o0$    FROM public.layaway_accounts
    WHERE is_trade = true
      AND is_test = false
      AND status::text != 'cancelled'
$o0$, 'new', $n0$    FROM public.layaway_accounts
    WHERE is_trade = true
      AND is_test = false
      AND (status::text != 'cancelled' OR cancelled_at IS NOT NULL)
$n0$)
));

-- ---------------------------------------------------------------------------
-- 4. Assert every patched body (a mismatch rolls the whole migration back).
-- ---------------------------------------------------------------------------
DO $guard$
DECLARE
  r record;
  v_md5 text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.allocate_payment_atomic(uuid,numeric,date,text,text,text,uuid,text,boolean,text,text,boolean)', 'fab3b0eb1843cfa20e2e85b97ca54cc3'),
    ('public.cancel_cash_order_atomic(uuid,text,uuid,text,boolean,text)', '06fb9394e5e4d8d3f3113aa3f5937261'),
    ('public.terminate_web_order_atomic(uuid,text,text,uuid,text,text,text,text,boolean)', '2c72d6c1d488cf11e1cd61a8d23bc6f6'),
    ('public.get_monthly_sales(text,integer)', '4ce37e63cbe6c037352d2a6b7e72341d'),
    ('public.get_trade_kpis()', '53039b01010c09f7c434c64bb7f2bca9'),
    ('public.get_trade_monthly_trends(integer)', '713440f1ec4e052b233db31898195cb0')
  ) AS t(sig, want) LOOP
    v_md5 := md5(pg_get_functiondef(to_regprocedure(r.sig)));
    IF v_md5 <> r.want THEN
      RAISE EXCEPTION 'STOP — % has md5 % after patching, expected %; rolled back', r.sig, v_md5, r.want;
    END IF;
  END LOOP;
  IF to_regprocedure('public.cancel_layaway_atomic(uuid,text,uuid,text,boolean,text)') IS NULL THEN
    RAISE EXCEPTION 'STOP — cancel_layaway_atomic was not created; rolled back';
  END IF;
END
$guard$;

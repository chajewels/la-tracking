-- Checkout: the customer chooses the payment method, and can use points
-- (owner-approved plan claude/checkout-payment-choice-and-points-plan-2026-10-04,
-- decisions C1–C7, plus the owner's answers of 2026-10-05 00:2x JST:
-- "Whole deposit allowed" and "Keep rule 9").
--
-- WHAT CHANGES
--   C1  The method chosen at checkout (transfer | paidy | square) travels
--       quote → draft → cash_orders.payment_method and is LOCKED for the
--       customer. Only staff change it (change_web_payment_method_atomic:
--       confirm_payment permission, reason required, audited, refused while a
--       payment is in progress). start_paidy_checkout_attempt and
--       reserve_square_attempt refuse a website order whose method is another.
--   C2  Paidy and card are full payment, yen only — never a layaway draft.
--   C3–C5 Points at checkout (1 pt = ¥1, never on shipping): the draft holds a
--       PENDING new_order_discount redemption (loyalty_redemptions.web_draft_id).
--       Staff Confirm approves it in the same transaction
--       (materialize_web_draft_atomic → approve_redemption_atomic). A declined
--       or expired draft cancels it, so the points are kept. On a layaway the
--       points pay the deposit (existing branch) and MAY cover all of it (owner
--       2026-10-05). On a confirmed order that later expires or is cancelled,
--       redeemed points are NOT returned (LOYALTY RULE 9, owner kept it).
--   Points are a discount, never money (STORE CREDIT rule: LOYALTY-% is
--   synthetic; web_mark_released already says so). The "nothing paid yet"
--   checks therefore ignore LOYALTY- payments: Paidy's start/file checks, the
--   web-order lapse, and on a web layaway the deposit checks (expiry,
--   reactivation, deadline moves, the payment reminder, the web stock hold) —
--   where a deposit wholly covered by points counts as paid.
--
-- FUNCTION RULES (CLAUDE.md, Bug #280): every changed body is an md5-guarded
-- IN-PLACE patch of the LIVE body (pg_get_functiondef read 2026-10-05 00:1x
-- JST). If live has moved, the migration stops and writes nothing. Replaying
-- is a no-op. CREATE OR REPLACE keeps each function's ACL. A record-only
-- migration with the post-patch bodies follows the apply (docs/MIGRATIONS.md).
-- No existing row changes: 0 open web cash orders, 0 open drafts and 0
-- pending redemptions on live when this was written.

SET lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 1. Columns.
-- ---------------------------------------------------------------------------
ALTER TABLE public.checkout_quotes
  ADD COLUMN IF NOT EXISTS payment_method text,
  ADD COLUMN IF NOT EXISTS points integer NOT NULL DEFAULT 0;
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'checkout_quotes_payment_method_check') THEN
    ALTER TABLE public.checkout_quotes ADD CONSTRAINT checkout_quotes_payment_method_check
      CHECK (payment_method IS NULL OR payment_method IN ('transfer', 'paidy', 'square'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'checkout_quotes_points_check') THEN
    ALTER TABLE public.checkout_quotes ADD CONSTRAINT checkout_quotes_points_check CHECK (points >= 0);
  END IF;
END $c$;

ALTER TABLE public.web_order_drafts
  ADD COLUMN IF NOT EXISTS payment_method text NOT NULL DEFAULT 'transfer',
  ADD COLUMN IF NOT EXISTS points integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS points_value numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS points_redemption_id uuid REFERENCES public.loyalty_redemptions(id);
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'web_order_drafts_payment_method_check') THEN
    ALTER TABLE public.web_order_drafts ADD CONSTRAINT web_order_drafts_payment_method_check
      CHECK (payment_method IN ('transfer', 'paidy', 'square'));
  END IF;
  -- C2: a layaway is paid by bank transfer.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'web_order_drafts_layaway_transfer') THEN
    ALTER TABLE public.web_order_drafts ADD CONSTRAINT web_order_drafts_layaway_transfer
      CHECK (mode = 'full' OR payment_method = 'transfer');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'web_order_drafts_points_check') THEN
    ALTER TABLE public.web_order_drafts ADD CONSTRAINT web_order_drafts_points_check
      CHECK (points >= 0 AND points_value >= 0 AND ((points = 0) = (points_redemption_id IS NULL)));
  END IF;
END $c$;

ALTER TABLE public.loyalty_redemptions
  ADD COLUMN IF NOT EXISTS web_draft_id uuid REFERENCES public.web_order_drafts(id);
CREATE INDEX IF NOT EXISTS loyalty_redemptions_web_draft_idx
  ON public.loyalty_redemptions (web_draft_id) WHERE web_draft_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS loyalty_redemptions_pending_member_idx
  ON public.loyalty_redemptions (member_id) WHERE status = 'pending';

-- C1: Paidy is now a recorded method on a cash order.
ALTER TABLE public.cash_orders DROP CONSTRAINT IF EXISTS cash_orders_payment_method_check;
ALTER TABLE public.cash_orders ADD CONSTRAINT cash_orders_payment_method_check
  CHECK (payment_method IS NULL OR payment_method IN ('square', 'transfer', 'paidy'));

COMMENT ON COLUMN public.web_order_drafts.payment_method IS
  'How the customer chose to pay at checkout (transfer | paidy | square), owner C1 2026-10-05. Copied to cash_orders.payment_method at Confirm. Changed only by change_web_payment_method_atomic.';
COMMENT ON COLUMN public.web_order_drafts.points_redemption_id IS
  'The PENDING new_order_discount redemption holding this checkout''s points. Approved inside materialize_web_draft_atomic; cancelled by decline_web_draft_atomic (points kept).';
COMMENT ON COLUMN public.loyalty_redemptions.web_draft_id IS
  'Set when the redemption was made at website checkout. Approved ONLY by staff Confirm of that draft (approve_redemption_atomic refuses it while it is linked to no order).';

-- ---------------------------------------------------------------------------
-- 2. Helpers: points are a discount, not money.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cash_order_points_paid(p_cash_order_id uuid)
RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT coalesce(sum(amount_paid), 0)
    FROM public.cash_payments
   WHERE cash_order_id = p_cash_order_id AND voided_at IS NULL
     AND coalesce(reference_number, '') LIKE 'LOYALTY-%'
$fn$;

CREATE OR REPLACE FUNCTION public.layaway_points_paid(p_account_id uuid)
RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT coalesce(sum(amount_paid), 0)
    FROM public.payments
   WHERE account_id = p_account_id AND voided_at IS NULL
     AND coalesce(reference_number, '') LIKE 'LOYALTY-%'
$fn$;

-- The deposit has started when MONEY has arrived (in the cached total or the
-- ledger, as the deposit checks always read it) or when points cover the whole
-- deposit (owner 2026-10-05: "Whole deposit allowed").
CREATE OR REPLACE FUNCTION public.layaway_deposit_started(p_account_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT coalesce((
    SELECT (coalesce(a.total_paid, 0) - public.layaway_points_paid(a.id)) > 0
        OR EXISTS (SELECT 1 FROM public.payments p
                    WHERE p.account_id = a.id AND p.voided_at IS NULL
                      AND coalesce(p.reference_number, '') NOT LIKE 'LOYALTY-%')
        OR (coalesce(a.downpayment_amount, 0) > 0
            AND public.layaway_points_paid(a.id) >= a.downpayment_amount)
      FROM public.layaway_accounts a
     WHERE a.id = p_account_id), false)
$fn$;

REVOKE ALL ON FUNCTION public.cash_order_points_paid(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.layaway_points_paid(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.layaway_deposit_started(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cash_order_points_paid(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.layaway_points_paid(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.layaway_deposit_started(uuid) TO service_role;
-- The hourly sweep (auto-expire-cash-orders) selects web layaways by
-- total_paid = 0. A deposit PARTLY paid by points has total_paid > 0 and no
-- money: it is found here instead, and expire_web_layaway_atomic re-checks it.
CREATE OR REPLACE FUNCTION public.web_layaway_points_expiry_candidates(p_now timestamptz, p_limit integer)
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT a.id
    FROM public.layaway_accounts a
   WHERE a.source_channel = 'web' AND a.status = 'active' AND a.expired_at IS NULL
     AND a.transfer_due_at IS NOT NULL AND a.transfer_due_at < p_now
     AND coalesce(a.total_paid, 0) > 0
     AND EXISTS (SELECT 1 FROM public.payments p
                  WHERE p.account_id = a.id AND p.voided_at IS NULL
                    AND coalesce(p.reference_number, '') LIKE 'LOYALTY-%')
     AND NOT public.layaway_deposit_started(a.id)
   ORDER BY a.transfer_due_at
   LIMIT greatest(coalesce(p_limit, 50), 0)
$fn$;
REVOKE ALL ON FUNCTION public.web_layaway_points_expiry_candidates(timestamptz, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.web_layaway_points_expiry_candidates(timestamptz, integer) TO service_role;

COMMENT ON FUNCTION public.layaway_deposit_started(uuid) IS
  'True once money has arrived on the plan (LOYALTY- discounts excluded) or points cover the whole deposit. The web-layaway deposit checks read this instead of total_paid > 0 (2026-10-05).';

-- ---------------------------------------------------------------------------
-- 3. Staff change the method (C1). One writer, audited.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.change_web_payment_method_atomic(
  p_entity_type text, p_entity_id uuid, p_method text, p_reason text, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_old    text;
  v_mode   text;
  v_cur    text;
  v_status text;
  v_pay    text;
  v_ready  timestamptz;
  v_chan   text;
  v_lock   text;
  v_ref    text;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'user_identity_required');
  END IF;
  IF NOT public.has_permission(p_user_id, 'confirm_payment') THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;
  IF v_reason IS NULL THEN
    RETURN jsonb_build_object('error', 'reason_required');
  END IF;
  IF p_method IS NULL OR p_method NOT IN ('transfer', 'paidy', 'square') THEN
    RETURN jsonb_build_object('error', 'bad_method');
  END IF;

  IF p_entity_type = 'draft' THEN
    SELECT payment_method, mode, settlement_currency, status, web_reference
      INTO v_old, v_mode, v_cur, v_status, v_ref
      FROM public.web_order_drafts WHERE id = p_entity_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
    IF v_status <> 'to_confirm' THEN
      RETURN jsonb_build_object('error', 'not_open', 'status', v_status);
    END IF;
  ELSIF p_entity_type = 'cash_order' THEN
    SELECT coalesce(payment_method, 'transfer'), 'full', currency::text, status::text, payment_status,
           ready_confirmed_at, source_channel, coalesce(web_reference, invoice_number)
      INTO v_old, v_mode, v_cur, v_status, v_pay, v_ready, v_chan, v_ref
      FROM public.cash_orders WHERE id = p_entity_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
    IF v_chan IS DISTINCT FROM 'web' THEN
      RETURN jsonb_build_object('error', 'not_web_order');
    END IF;
    IF v_status <> 'pending' OR coalesce(v_pay, '') <> 'pending_transfer' THEN
      RETURN jsonb_build_object('error', 'not_payable', 'status', v_status);
    END IF;
    -- Owner rule 2026-10-04: while Paidy, a card hold or any other payment is
    -- in progress, nothing about how the order is paid changes. Paidy declined
    -- = staff Reject first, then the method can change.
    v_lock := public.cash_order_payment_lock(p_entity_id);
    IF v_lock IS NOT NULL THEN
      RETURN jsonb_build_object('error', 'payment_in_progress', 'lock', v_lock);
    END IF;
  ELSE
    RETURN jsonb_build_object('error', 'bad_entity_type');
  END IF;

  IF v_old = p_method THEN
    RETURN jsonb_build_object('error', 'unchanged', 'payment_method', v_old);
  END IF;
  IF p_method <> 'transfer' AND v_mode = 'layaway' THEN
    RETURN jsonb_build_object('error', 'method_full_payment_only');
  END IF;
  IF p_method <> 'transfer' AND v_cur <> 'JPY' THEN
    RETURN jsonb_build_object('error', 'method_requires_yen');
  END IF;

  IF p_entity_type = 'draft' THEN
    UPDATE public.web_order_drafts SET payment_method = p_method, updated_at = now() WHERE id = p_entity_id;
  ELSE
    UPDATE public.cash_orders SET payment_method = p_method, updated_at = now() WHERE id = p_entity_id;
  END IF;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id)
  VALUES (CASE WHEN p_entity_type = 'draft' THEN 'web_order_draft' ELSE 'cash_order' END, p_entity_id,
          'payment_method_changed',
          jsonb_build_object('payment_method', v_old),
          jsonb_build_object('payment_method', p_method, 'reason', v_reason, 'reference', v_ref),
          p_user_id);

  RETURN jsonb_build_object('ok', true, 'entity_type', p_entity_type, 'entity_id', p_entity_id,
                            'old_method', v_old, 'payment_method', p_method, 'reference', v_ref);
END
$fn$;
REVOKE ALL ON FUNCTION public.change_web_payment_method_atomic(text, uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.change_web_payment_method_atomic(text, uuid, text, text, uuid) TO service_role;
COMMENT ON FUNCTION public.change_web_payment_method_atomic(text, uuid, text, text, uuid) IS
  'Owner C1 (2026-10-05): the customer''s checkout payment method is locked for her; staff with confirm_payment change it here (reason required, audited), never while a payment is in progress, never to Paidy/card on a layaway or a peso order.';

-- ---------------------------------------------------------------------------
-- 4. In-place patches of live bodies.
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

-- 4a. approve_redemption_atomic — a checkout redemption waits for Confirm.
SELECT pg_temp.cj_patch('public.approve_redemption_atomic(uuid,uuid,text)', '55576f51bd603e1cadedbab187b9e71c', jsonb_build_array(
  jsonb_build_object('old', $o$  v_pts := r.points_redeemed;
$o$, 'new', $n$  v_pts := r.points_redeemed;
  -- A WEBSITE CHECKOUT's points (2026-10-05, owner C5) are approved only by
  -- staff Confirm of that draft, which links the new order first. Approving
  -- one before that would take the points and apply them to nothing.
  IF r.web_draft_id IS NOT NULL AND r.account_id IS NULL AND r.cash_order_id IS NULL THEN
    RAISE EXCEPTION 'web_draft_redemption: approved automatically when staff confirm the website order';
  END IF;
$n$)));

-- 4b. create_web_draft_atomic — method + points from the quote, checked again.
SELECT pg_temp.cj_patch('public.create_web_draft_atomic(uuid,uuid,text,text,timestamp with time zone)', '31e02b2830dc0e409bf3208d677bcfd2', jsonb_build_array(
  jsonb_build_object('old', $o$  v_lines     integer := 0;
BEGIN
$o$, 'new', $n$  v_lines     integer := 0;
  v_method    text;
  v_points    integer := 0;
  v_pts_value numeric(12,2) := 0;
  v_member    public.loyalty_members%ROWTYPE;
  v_held      numeric := 0;
  v_red_id    uuid;
BEGIN
$n$),
  jsonb_build_object('old', $o$  -- The number: a layaway's was reserved at quote time (the agreement was
$o$, 'new', $n$  -- CHECKOUT PAYMENT CHOICE + POINTS (2026-10-05, owner C1–C7). The website
  -- stored the customer's choice on the quote; it is checked again here, in
  -- the transaction that holds the pieces, so a draft only ever carries a
  -- method the order can take and points the customer really has.
  v_method := coalesce(nullif(btrim(coalesce(v_quote.payment_method, '')), ''), 'transfer');
  IF v_method NOT IN ('transfer', 'paidy', 'square') THEN
    RETURN jsonb_build_object('error', 'bad_method');
  END IF;
  IF v_method <> 'transfer' AND v_quote.mode = 'layaway' THEN
    RETURN jsonb_build_object('error', 'method_full_payment_only', 'method', v_method);
  END IF;
  IF v_method <> 'transfer' AND v_cur <> 'JPY' THEN
    RETURN jsonb_build_object('error', 'method_requires_yen', 'method', v_method);
  END IF;
  IF (v_method = 'paidy' AND (public.paidy_mode() = 'off' OR coalesce(v_country, '') <> 'JP'))
     OR (v_method = 'square' AND public.square_mode() = 'off') THEN
    RETURN jsonb_build_object('error', 'method_unavailable', 'method', v_method);
  END IF;
  v_points := coalesce(v_quote.points, 0);
  IF v_points < 0 THEN
    RETURN jsonb_build_object('error', 'bad_points');
  END IF;
  IF v_points > 0 THEN
    IF coalesce((SELECT value #>> '{}' FROM public.system_settings WHERE key = 'loyalty_enabled'), '') <> 'true' THEN
      RETURN jsonb_build_object('error', 'points_unavailable');
    END IF;
    -- The member row lock serialises two checkouts spending the same points.
    SELECT * INTO v_member FROM public.loyalty_members WHERE customer_id = p_customer_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('error', 'points_not_enrolled');
    END IF;
    SELECT coalesce(sum(points_redeemed), 0) INTO v_held
      FROM public.loyalty_redemptions WHERE member_id = v_member.id AND status = 'pending';
    IF v_points > coalesce(v_member.remaining_points, 0) - v_held THEN
      RETURN jsonb_build_object('error', 'points_insufficient',
                                'points_available', greatest(coalesce(v_member.remaining_points, 0) - v_held, 0));
    END IF;
    -- C4: points never pay shipping — at most the pieces subtotal, in yen.
    IF v_points > coalesce(v_quote.subtotal_jpy, 0) THEN
      RETURN jsonb_build_object('error', 'points_exceed_subtotal', 'max_points', coalesce(v_quote.subtotal_jpy, 0));
    END IF;
    -- 1 pt = ¥1; a peso order converts once at the quote's rate, half-up, as
    -- every other figure on it.
    v_pts_value := CASE WHEN v_cur = 'PHP' THEN round(v_points * v_rate) ELSE v_points END;
    IF v_quote.mode = 'layaway' AND v_pts_value > coalesce(v_deposit, 0) THEN
      RETURN jsonb_build_object('error', 'points_exceed_deposit', 'deposit', v_deposit);
    END IF;
    IF v_quote.mode = 'full' AND v_pts_value > v_subtotal THEN
      RETURN jsonb_build_object('error', 'points_exceed_subtotal', 'max_points', coalesce(v_quote.subtotal_jpy, 0));
    END IF;
  END IF;

  -- The number: a layaway's was reserved at quote time (the agreement was
$n$),
  jsonb_build_object('old', $o$  ) RETURNING id INTO v_draft_id;
$o$, 'new', $n$  ) RETURNING id INTO v_draft_id;

  -- The points are HELD by a pending redemption; staff Confirm approves it.
  IF v_points > 0 THEN
    INSERT INTO public.loyalty_redemptions (
      member_id, redemption_type, points_redeemed, value_applied_jpy, value_applied_php,
      rate_snapshot, invoice_number, status, notes, web_draft_id
    ) VALUES (
      v_member.id, 'new_order_discount', v_points, v_points,
      CASE WHEN v_cur = 'PHP' THEN v_pts_value END,
      coalesce(v_rate, (SELECT (value #>> '{}')::numeric FROM public.system_settings WHERE key = 'php_jpy_rate')),
      v_seq::text, 'pending',
      'Website checkout ' || v_reference || ' — approved automatically when staff confirm the order',
      v_draft_id
    ) RETURNING id INTO v_red_id;
  END IF;
  UPDATE public.web_order_drafts
     SET payment_method = v_method, points = v_points, points_value = v_pts_value,
         points_redemption_id = v_red_id
   WHERE id = v_draft_id;
$n$),
  jsonb_build_object('old', $o$    'fx_rate', v_rate, 'awaiting_confirmation', true);
$o$, 'new', $n$    'fx_rate', v_rate, 'awaiting_confirmation', true,
    'payment_method', v_method, 'points', v_points, 'points_value', v_pts_value);
$n$)));

-- 4c. materialize_web_draft_atomic — the method onto the order; points approved.
SELECT pg_temp.cj_patch('public.materialize_web_draft_atomic(uuid,uuid,jsonb,jsonb,jsonb)', '8fe55313e58689b492bccf657cc1d996', jsonb_build_array(
  jsonb_build_object('old', $o$  v_rate_date date;
BEGIN
$o$, 'new', $n$  v_rate_date date;
  v_red       public.loyalty_redemptions%ROWTYPE;
  v_pts_value numeric(12,2) := 0;
  v_invoice   text;
  v_approve   jsonb;
BEGIN
$n$),
  jsonb_build_object('old', $o$  IF v_draft.mode = 'layaway' THEN
    v_dp   := $o$, 'new', $n$  -- POINTS chosen at checkout (2026-10-05, owner C3–C5): the draft's pending
  -- redemption is approved below, in this transaction. Checked first against
  -- the figures staff are confirming, so nothing is written if it cannot apply.
  IF v_draft.points_redemption_id IS NOT NULL THEN
    SELECT * INTO v_red FROM public.loyalty_redemptions WHERE id = v_draft.points_redemption_id FOR UPDATE;
    IF NOT FOUND OR v_red.status::text <> 'pending' THEN
      RETURN jsonb_build_object('error', 'points_hold_lost');
    END IF;
    v_pts_value := CASE WHEN v_draft.settlement_currency = 'PHP' THEN coalesce(v_red.value_applied_php, 0)
                        ELSE coalesce(v_red.value_applied_jpy, 0) END;
    IF v_draft.mode = 'layaway' THEN
      -- On a layaway the points pay the deposit, and may cover all of it.
      IF v_pts_value > coalesce((p_order ->> 'downpayment_amount')::numeric, 0) THEN
        RETURN jsonb_build_object('error', 'points_exceed_deposit', 'points_value', v_pts_value);
      END IF;
    ELSIF v_pts_value > v_total - v_shipping THEN
      -- C4: never on shipping.
      RETURN jsonb_build_object('error', 'points_exceed_total', 'points_value', v_pts_value);
    END IF;
  END IF;

  IF v_draft.mode = 'layaway' THEN
    v_dp   := $n$),
  jsonb_build_object('old', $o$      v_total, 'pending'::cash_order_status, 'web', v_draft.order_type, 'transfer',
$o$, 'new', $n$      v_total, 'pending'::cash_order_status, 'web', v_draft.order_type, coalesce(v_draft.payment_method, 'transfer'),
$n$),
  jsonb_build_object('old', $o$  -- The hold becomes the order's: NO second stock movement (risk 3). From here
$o$, 'new', $n$  -- The checkout's points, approved now (owner C5): the redemption is linked
  -- to the new order and approve_redemption_atomic writes the LOYALTY-
  -- discount, nets the loyalty basis and consumes the lots, all in this
  -- transaction. Any refusal (e.g. insufficient_points) rolls back the Confirm.
  IF v_draft.points_redemption_id IS NOT NULL THEN
    IF v_draft.mode = 'full' THEN
      SELECT invoice_number INTO v_invoice FROM public.cash_orders WHERE id = v_order_id;
    ELSE
      SELECT invoice_number INTO v_invoice FROM public.layaway_accounts WHERE id = v_order_id;
    END IF;
    UPDATE public.loyalty_redemptions
       SET cash_order_id  = CASE WHEN v_draft.mode = 'full' THEN v_order_id END,
           account_id     = CASE WHEN v_draft.mode = 'layaway' THEN v_order_id END,
           invoice_number = v_invoice
     WHERE id = v_red.id;
    v_approve := public.approve_redemption_atomic(v_red.id, p_user_id, 'Website checkout points');
  END IF;

  -- The hold becomes the order's: NO second stock movement (risk 3). From here
$n$),
  jsonb_build_object('old', $o$                             'transfer_due_at', v_due, 'planned_shipping_method_id', v_courier),
$o$, 'new', $n$                             'transfer_due_at', v_due, 'planned_shipping_method_id', v_courier,
                             'payment_method', v_draft.payment_method, 'points', v_draft.points,
                             'points_value', v_pts_value),
$n$),
  jsonb_build_object('old', $o$                            'service_lines', v_services, 'service_requests_moved', v_requests);
$o$, 'new', $n$                            'service_lines', v_services, 'service_requests_moved', v_requests,
                            'payment_method', v_draft.payment_method, 'points', v_draft.points,
                            'points_value', v_pts_value, 'points_approval', v_approve);
$n$)));

-- 4d. decline_web_draft_atomic — a draft never confirmed spent no points.
SELECT pg_temp.cj_patch('public.decline_web_draft_atomic(uuid,text,uuid,text)', 'f962be3de6f21bf43de24738eceb9537', jsonb_build_array(
  jsonb_build_object('old', $o$  v_now       timestamptz := now();
BEGIN
$o$, 'new', $n$  v_now       timestamptz := now();
  v_points_released integer := 0;
BEGIN
$n$),
  jsonb_build_object('old', $o$  UPDATE public.web_order_drafts
     SET status = CASE WHEN v_is_system THEN 'expired' ELSE 'declined' END,
$o$, 'new', $n$  -- Points held by this draft go back to the customer (2026-10-05, owner):
  -- the pending redemption is cancelled, nothing was debited.
  UPDATE public.loyalty_redemptions
     SET status = 'cancelled', cancelled_at = v_now, cancelled_by_user_id = p_user_id,
         cancellation_reason = 'Website order ' || coalesce(v_draft.web_reference, '')
                               || ' was not confirmed (' || coalesce(v_reason, 'no reason given') || ') — points kept'
   WHERE web_draft_id = p_draft_id AND status = 'pending';
  GET DIAGNOSTICS v_points_released = ROW_COUNT;

  UPDATE public.web_order_drafts
     SET status = CASE WHEN v_is_system THEN 'expired' ELSE 'declined' END,
$n$),
  jsonb_build_object('old', $o$'stock_variants_restored', v_restored,
$o$, 'new', $n$'stock_variants_restored', v_restored,
                             'points_redemptions_released', v_points_released,
$n$),
  jsonb_build_object('old', $o$'customer_lang', v_draft.customer_lang, 'stock_variants_restored', v_restored);
$o$, 'new', $n$'customer_lang', v_draft.customer_lang, 'stock_variants_restored', v_restored,
                            'points_redemptions_released', v_points_released);
$n$)));

-- 4e. terminate_web_order_atomic — points alone never stop a lapse.
SELECT pg_temp.cj_patch('public.terminate_web_order_atomic(uuid,text,text,uuid,text,text,text,text,boolean)', 'b0aec1dba0b597db2acf399e34f56fe2', jsonb_build_array(
  jsonb_build_object('old', $o$    IF v_status <> 'pending' OR v_money_received > 0 OR COALESCE(v_total_paid, 0) > 0 THEN
$o$, 'new', $n$    -- Points are a discount, not money (2026-10-05): an order carrying only a
    -- checkout points redemption still lapses. Rule 9: the points stay spent.
    IF v_status <> 'pending' OR v_money_received > 0 OR COALESCE(v_total_paid, 0) - v_loyalty_synthetic > 0 THEN
$n$)));

-- 4f. Paidy start / file — the chosen method, and points are not "paid".
SELECT pg_temp.cj_patch('public.start_paidy_checkout_attempt(uuid,uuid,integer)', '3056757491efc319a372045062cb9b83', jsonb_build_array(
  jsonb_build_object('old', $o$  IF v_order.currency::text <> 'JPY' OR v_order.total_paid <> 0
$o$, 'new', $n$  -- The customer chose how to pay at checkout (2026-10-05, owner C1): a
  -- website order takes Paidy only when Paidy is its method; staff change it.
  IF v_order.source_channel = 'web' AND coalesce(v_order.payment_method, 'transfer') <> 'paidy' THEN
    RETURN jsonb_build_object('error', 'method_not_chosen', 'payment_method', coalesce(v_order.payment_method, 'transfer'));
  END IF;
  IF v_order.currency::text <> 'JPY' OR v_order.total_paid - public.cash_order_points_paid(v_order.id) <> 0
$n$)));

SELECT pg_temp.cj_patch('public.file_paidy_submission_atomic(uuid,uuid,text,numeric,boolean,timestamp with time zone,timestamp with time zone,jsonb,date,text,text,text)', '7d77fc1293959c1b90c0ba7b4afa7377', jsonb_build_array(
  jsonb_build_object('old', $o$  IF v_order.total_paid <> 0 THEN
$o$, 'new', $n$  IF v_order.total_paid - public.cash_order_points_paid(v_order.id) <> 0 THEN
$n$)));

-- 4g. reserve_square_attempt — card only when card is the order's method.
SELECT pg_temp.cj_patch('public.reserve_square_attempt(uuid,uuid,bigint,text,text,text,boolean,text,text,text,jsonb)', '0b04a4147d4b72b465272fec059dd887', jsonb_build_array(
  jsonb_build_object('old', $o$  IF v_order.currency::text <> 'JPY' THEN RETURN jsonb_build_object('error', 'not_jpy'); END IF;
$o$, 'new', $n$  -- The customer chose how to pay at checkout (2026-10-05, owner C1).
  IF v_order.source_channel = 'web' AND coalesce(v_order.payment_method, 'transfer') <> 'square' THEN
    RETURN jsonb_build_object('error', 'method_not_chosen', 'payment_method', coalesce(v_order.payment_method, 'transfer'));
  END IF;
  IF v_order.currency::text <> 'JPY' THEN RETURN jsonb_build_object('error', 'not_jpy'); END IF;
$n$)));

-- 4h. Web layaway deposit checks — points are not money; a deposit wholly
--     covered by points counts as paid.
SELECT pg_temp.cj_patch('public.expire_web_layaway_atomic(uuid,text)', '76f7d7493f272d7b3aecad47a9955e64', jsonb_build_array(
  jsonb_build_object('old', $o$  IF coalesce(v_paid, 0) > 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_paid');
$o$, 'new', $n$  -- Points (a LOYALTY- discount) are not money; a deposit wholly covered by
  -- points counts as paid (2026-10-05, owner).
  IF coalesce(v_paid, 0) > 0 AND public.layaway_deposit_started(p_account_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_paid');
$n$),
  jsonb_build_object('old', $o$              WHERE account_id = p_account_id AND voided_at IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'payment_exists');
$o$, 'new', $n$              WHERE account_id = p_account_id AND voided_at IS NULL
                AND coalesce(reference_number, '') NOT LIKE 'LOYALTY-%') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'payment_exists');
$n$)));

SELECT pg_temp.cj_patch('public.reactivate_web_layaway_atomic(uuid,timestamp with time zone,text,uuid,text)', 'ff6447f90e6fd38ebed7176a36abb9db', jsonb_build_array(
  jsonb_build_object('old', $o$  IF coalesce(v_paid, 0) > 0 THEN
    RETURN jsonb_build_object('error', 'already_paid');
$o$, 'new', $n$  -- Points are not money; a deposit wholly covered by points counts as paid.
  IF coalesce(v_paid, 0) > 0 AND public.layaway_deposit_started(p_account_id) THEN
    RETURN jsonb_build_object('error', 'already_paid');
$n$),
  jsonb_build_object('old', $o$              WHERE account_id = p_account_id AND voided_at IS NULL) THEN
    RETURN jsonb_build_object('error', 'payment_exists');
$o$, 'new', $n$              WHERE account_id = p_account_id AND voided_at IS NULL
                AND coalesce(reference_number, '') NOT LIKE 'LOYALTY-%') THEN
    RETURN jsonb_build_object('error', 'payment_exists');
$n$)));

SELECT pg_temp.cj_patch('public.set_account_deadlines(text,uuid,timestamp with time zone,text,uuid)', '298d6b2f09f818221775e268292c36c2', jsonb_build_array(
  jsonb_build_object('old', $o$    IF coalesce(v_paid, 0) > 0 THEN
      RETURN jsonb_build_object('error', 'already_paid', 'total_paid', v_paid);
$o$, 'new', $n$    -- Points are not money; a deposit wholly covered by points counts as paid.
    IF coalesce(v_paid, 0) > 0 AND public.layaway_deposit_started(p_entity_id) THEN
      RETURN jsonb_build_object('error', 'already_paid', 'total_paid', v_paid);
$n$),
  jsonb_build_object('old', $o$                WHERE account_id = p_entity_id AND voided_at IS NULL) THEN
      RETURN jsonb_build_object('error', 'payment_exists');
$o$, 'new', $n$                WHERE account_id = p_entity_id AND voided_at IS NULL
                  AND coalesce(reference_number, '') NOT LIKE 'LOYALTY-%') THEN
      RETURN jsonb_build_object('error', 'payment_exists');
$n$)));

SELECT pg_temp.cj_patch('public.web_payment_reminder_eligible(text,uuid)', 'c32919df99c2f481c645b5c093367dea', jsonb_build_array(
  jsonb_build_object('old', $o$           a.currency::text, a.downpayment_amount
$o$, 'new', $n$           a.currency::text, a.downpayment_amount - public.layaway_points_paid(a.id)
$n$),
  jsonb_build_object('old', $o$       AND coalesce(a.total_paid, 0) = 0
$o$, 'new', $n$       AND NOT public.layaway_deposit_started(a.id)   -- points are not money (2026-10-05)
$n$)));

SELECT pg_temp.cj_patch('public.page365_web_holds(uuid)', '41fa4260dc29b32ef90046451a85abd8', jsonb_build_array(
  jsonb_build_object('old', $o$AND a.status IN ('active','overdue') AND coalesce(a.total_paid, 0) = 0), 0)$o$,
                     'new', $n$AND a.status IN ('active','overdue') AND NOT public.layaway_deposit_started(a.id)), 0)$n$)));

-- ---------------------------------------------------------------------------
-- 5. Self-checks: everything above is in place, or the whole migration rolls back.
-- ---------------------------------------------------------------------------
DO $check$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('public.approve_redemption_atomic(uuid,uuid,text)', 'web_draft_redemption'),
      ('public.create_web_draft_atomic(uuid,uuid,text,text,timestamp with time zone)', 'points_exceed_deposit'),
      ('public.materialize_web_draft_atomic(uuid,uuid,jsonb,jsonb,jsonb)', 'approve_redemption_atomic(v_red.id'),
      ('public.decline_web_draft_atomic(uuid,text,uuid,text)', 'points_redemptions_released'),
      ('public.terminate_web_order_atomic(uuid,text,text,uuid,text,text,text,text,boolean)', 'COALESCE(v_total_paid, 0) - v_loyalty_synthetic'),
      ('public.start_paidy_checkout_attempt(uuid,uuid,integer)', 'method_not_chosen'),
      ('public.file_paidy_submission_atomic(uuid,uuid,text,numeric,boolean,timestamp with time zone,timestamp with time zone,jsonb,date,text,text,text)', 'cash_order_points_paid'),
      ('public.reserve_square_attempt(uuid,uuid,bigint,text,text,text,boolean,text,text,text,jsonb)', 'method_not_chosen'),
      ('public.expire_web_layaway_atomic(uuid,text)', 'layaway_deposit_started'),
      ('public.reactivate_web_layaway_atomic(uuid,timestamp with time zone,text,uuid,text)', 'layaway_deposit_started'),
      ('public.set_account_deadlines(text,uuid,timestamp with time zone,text,uuid)', 'layaway_deposit_started'),
      ('public.web_payment_reminder_eligible(text,uuid)', 'layaway_points_paid'),
      ('public.page365_web_holds(uuid)', 'layaway_deposit_started')
    ) AS t(sig, marker)
  LOOP
    IF position(r.marker IN pg_get_functiondef(to_regprocedure(r.sig))) = 0 THEN
      RAISE EXCEPTION 'STOP — % is missing its patch (%); rolled back', r.sig, r.marker;
    END IF;
  END LOOP;
  IF has_function_privilege('authenticated', 'public.change_web_payment_method_atomic(text,uuid,text,text,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.layaway_deposit_started(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.web_layaway_points_expiry_candidates(timestamptz,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'STOP — a new function is executable by a signed-in or anonymous caller; rolled back';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cash_orders_payment_method_check'
                  AND pg_get_constraintdef(oid) LIKE '%paidy%') THEN
    RAISE EXCEPTION 'STOP — cash_orders_payment_method_check does not allow paidy; rolled back';
  END IF;
END
$check$;

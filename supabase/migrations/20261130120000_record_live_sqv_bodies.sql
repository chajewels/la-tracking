-- Record-only (2026-10-09). Already applied on live — replaying is a no-op.
--
-- Why: 20261130110000 (SQV01–SQV06 + D-G04) changed these nine functions with md5-guarded
-- IN-PLACE patches (pg_temp.cj_patch / cj_patch_all, and an EXECUTE of the patched live text for
-- set_square_settings). The drift audit reads only CREATE FUNCTION statements, so the repo's newest
-- copy of each was the PRE-patch body (set_square_settings was missing). This file records the
-- bodies exactly as live runs them after the Lovable apply of 2026-10-08 ~17:49Z
-- (pg_get_functiondef read from live; md5(prosrc) below).
--
--   change_web_payment_method_atomic              b0e9ea613880297a89d4c38464d89b6b
--   create_web_draft_atomic                       7e292b282595199810db44bc364999fe
--   get_square_settings                           d61be84bc4e77bf5a8fc0c990e77385d
--   guard_square_settings                         71743cb1577abe31b54243285a9c2125
--   mark_web_order_refund_issued_atomic           9ff35c504e75c0299f181883b1157730
--   record_square_refund                          574c5459bd3855c0e860d90250a4b02f
--   reserve_square_attempt                        4990b59d72d4ef84f3299a424092523d
--   set_square_settings                           e0041544172e34b047c1c8d4a9fef673
--   switch_web_payment_method_by_customer_atomic  cbae799142e4eab8fbe7fca478514a6e
--
-- GRANTS ARE NOT TOUCHED. CREATE OR REPLACE keeps each function's live ACL
-- (mark_web_order_refund_issued_atomic: service_role only, SQV01; set_square_settings: authenticated + service_role).

-- ---------------------------------------------------------------------------
-- change_web_payment_method_atomic
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.change_web_payment_method_atomic(p_entity_type text, p_entity_id uuid, p_method text, p_reason text, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_country text;
  v_cust   uuid;
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
    SELECT payment_method, mode, settlement_currency, status, web_reference, upper(nullif(btrim(coalesce(country, '')), '')), customer_id
      INTO v_old, v_mode, v_cur, v_status, v_ref, v_country, v_cust
      FROM public.web_order_drafts WHERE id = p_entity_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
    IF v_status <> 'to_confirm' THEN
      RETURN jsonb_build_object('error', 'not_open', 'status', v_status);
    END IF;
  ELSIF p_entity_type = 'cash_order' THEN
    SELECT coalesce(payment_method, 'transfer'), 'full', currency::text, status::text, payment_status,
           ready_confirmed_at, source_channel, coalesce(web_reference, invoice_number),
           upper(nullif(btrim(coalesce(ship_to_snapshot ->> 'country', '')), '')), customer_id
      INTO v_old, v_mode, v_cur, v_status, v_pay, v_ready, v_chan, v_ref, v_country, v_cust
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
  -- QC 2026-10-06: the same availability check as checkout
  -- (create_web_draft_atomic), so a customer is never told to pay by a method
  -- the order cannot take.
  IF (p_method = 'paidy' AND (public.paidy_mode() = 'off' OR coalesce(v_country, '') <> 'JP'))
     OR (p_method = 'square' AND NOT public.square_card_allowed(v_cust)) THEN
    RETURN jsonb_build_object('error', 'method_unavailable', 'method', p_method);
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
$function$
;

-- ---------------------------------------------------------------------------
-- create_web_draft_atomic
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_web_draft_atomic(p_customer_id uuid, p_quote_id uuid, p_lang text DEFAULT NULL::text, p_agreement_version text DEFAULT NULL::text, p_agreement_signed_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_quote     public.checkout_quotes%ROWTYPE;
  v_item      jsonb;
  v_variant   public.website_product_variants%ROWTYPE;
  v_qty       integer;
  v_updated   integer;
  v_seq       bigint;
  v_reference text;
  v_draft_id  uuid;
  v_lang      text := CASE WHEN p_lang IN ('ja', 'en') THEN p_lang ELSE NULL END;
  v_agr_ver   text := nullif(btrim(coalesce(p_agreement_version, '')), '');
  v_cur       text;
  v_rate      numeric(12,6);
  v_total     numeric(12,2);
  v_shipping  numeric(12,2);
  v_subtotal  numeric(12,2);
  v_snapshot  jsonb;
  v_country   text;
  v_q         jsonb;
  v_deposit   numeric(12,2);
  v_schedule  jsonb;
  v_title     text;
  v_lines     integer := 0;
  v_method    text;
  v_points    integer := 0;
  v_pts_value numeric(12,2) := 0;
  v_member    public.loyalty_members%ROWTYPE;
  v_held      numeric := 0;
  v_red_id    uuid;
BEGIN
  -- Dormant until the owner flips the switch (PR 8): the edge function only
  -- calls this in 'draft' mode, and this refuses otherwise.
  IF public.web_checkout_mode() <> 'draft' THEN
    RETURN jsonb_build_object('error', 'checkout_mode_not_draft');
  END IF;

  SELECT * INTO v_quote FROM public.checkout_quotes WHERE id = p_quote_id FOR UPDATE;
  IF NOT FOUND OR v_quote.customer_id <> p_customer_id THEN
    RETURN jsonb_build_object('error', 'quote_not_found');
  END IF;
  IF v_quote.consumed_at IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'quote_already_used');
  END IF;
  IF v_quote.expires_at <= now() THEN
    RETURN jsonb_build_object('error', 'quote_expired');
  END IF;
  IF v_quote.mode NOT IN ('full', 'layaway') THEN
    RETURN jsonb_build_object('error', 'unsupported_mode');
  END IF;
  IF coalesce(v_quote.total_jpy, 0) <= 0 THEN
    RETURN jsonb_build_object('error', 'empty_quote');
  END IF;
  IF v_quote.mode = 'layaway' AND (v_agr_ver IS NULL OR p_agreement_signed_at IS NULL) THEN
    RETURN jsonb_build_object('error', 'agreement_missing');
  END IF;

  v_snapshot := public.address_snapshot(v_quote.ship_to_address_id);
  v_country  := upper(nullif(btrim(coalesce(v_snapshot ->> 'country', '')), ''));

  -- Shipping may be added at confirmation (R4) — but never for a destination
  -- that HAS a rate card: there the quote must carry the fee.
  IF v_quote.shipping_jpy IS NULL AND v_country IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.shipping_rates r WHERE r.country = v_country AND r.is_active) THEN
    RETURN jsonb_build_object('error', 'shipping_quote_required');
  END IF;

  -- The customer's currency, converted ONCE at the quote's rate: the same
  -- arithmetic as create_web_order_atomic / create_web_layaway_atomic (whole
  -- pesos half-up; shipping on its own, items the remainder).
  v_cur := coalesce(v_quote.settlement_currency, 'JPY');
  IF v_cur = 'PHP' THEN
    v_rate := v_quote.fx_rate;
    IF v_rate IS NULL OR v_rate <= 0 THEN
      RETURN jsonb_build_object('error', 'fx_rate_missing');
    END IF;
    v_total    := round(v_quote.total_jpy * v_rate);
    v_shipping := CASE WHEN v_quote.shipping_jpy IS NULL THEN NULL ELSE round(v_quote.shipping_jpy * v_rate) END;
  ELSE
    v_cur      := 'JPY';
    v_rate     := NULL;
    v_total    := v_quote.total_jpy;
    v_shipping := v_quote.shipping_jpy;
  END IF;
  v_subtotal := v_total - coalesce(v_shipping, 0);

  -- A layaway is checked against the plan minimum now (as today), so a draft
  -- that could never be confirmed is never written. Figures are provisional.
  IF v_quote.mode = 'layaway' THEN
    v_q := public.layaway_quote(v_subtotal::integer, v_quote.term_months, v_cur,
                                (now() AT TIME ZONE 'Asia/Manila')::date, coalesce(v_shipping, 0)::integer, 0);
    IF NOT coalesce((v_q ->> 'eligible')::boolean, false)
       OR coalesce((v_q ->> 'term_downgraded')::boolean, false) THEN
      RETURN jsonb_build_object('error', 'below_plan_minimum', 'total', v_total, 'currency', v_cur,
                                'requested_term_months', v_quote.term_months,
                                'max_term_months', v_q -> 'max_term_months');
    END IF;
    v_deposit  := (v_q ->> 'deposit')::numeric;
    v_schedule := v_q -> 'schedule';
  END IF;

  -- CHECKOUT PAYMENT CHOICE + POINTS (2026-10-05, owner C1–C7). The website
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
     OR (v_method = 'square' AND NOT public.square_card_allowed(p_customer_id)) THEN
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
  -- signed against it); a cash order's is drawn now.
  v_seq       := CASE WHEN v_quote.mode = 'layaway'
                      THEN coalesce(v_quote.reserved_invoice_seq, public.next_web_invoice_seq())
                      ELSE public.next_web_invoice_seq() END;
  v_reference := 'CJ-W-' || lpad(v_seq::text, 6, '0');

  INSERT INTO public.web_order_drafts (
    quote_id, customer_id, mode, term_months,
    settlement_currency, fx_rate, fx_rate_date,
    subtotal_jpy, shipping_jpy, total_jpy, subtotal, shipping, total, deposit, schedule,
    ship_to_address_id, ship_to_snapshot, country, order_type, recipient_name, recipient_phone, gift_note,
    customer_lang, agreement_version, agreement_signed_at, invoice_seq, web_reference
  ) VALUES (
    v_quote.id, p_customer_id, v_quote.mode, CASE WHEN v_quote.mode = 'layaway' THEN v_quote.term_months END,
    v_cur, v_rate, CASE WHEN v_rate IS NULL THEN NULL ELSE v_quote.fx_rate_date END,
    v_quote.subtotal_jpy, v_quote.shipping_jpy, v_quote.total_jpy, v_subtotal, v_shipping, v_total, v_deposit, v_schedule,
    v_quote.ship_to_address_id, v_snapshot, v_country, coalesce(v_quote.order_type, 'SELF'),
    v_quote.recipient_name, v_quote.recipient_phone, v_quote.gift_note,
    v_lang,
    CASE WHEN v_quote.mode = 'layaway' THEN v_agr_ver END,
    CASE WHEN v_quote.mode = 'layaway' THEN p_agreement_signed_at END,
    v_seq, v_reference
  ) RETURNING id INTO v_draft_id;

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

  -- Hold the pieces: the same guarded decrement as the order writers.
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_quote.items) LOOP
    v_qty := GREATEST(coalesce((v_item ->> 'qty')::int, 1), 1);
    SELECT * INTO v_variant FROM public.website_product_variants WHERE id = (v_item ->> 'variant_id')::uuid;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'variant_missing:%', v_item ->> 'variant_id';
    END IF;
    -- QC 2026-10-06: a product unpublished after the quote is not drafted.
    IF NOT EXISTS (SELECT 1 FROM public.website_products p
                    WHERE p.id = v_variant.product_id AND p.status = 'active') THEN
      RAISE EXCEPTION 'product_unavailable:%', v_variant.id;
    END IF;
    UPDATE public.website_product_variants
       SET stock_qty = stock_qty - v_qty, updated_at = now()
     WHERE id = v_variant.id AND stock_qty >= v_qty;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated = 0 THEN
      RAISE EXCEPTION 'out_of_stock:%', v_variant.id;
    END IF;
    SELECT trim(both ' ' FROM p.name
                 || coalesce(' / ' || nullif(v_variant.size, ''), '')
                 || coalesce(' / ' || nullif(v_variant.stone, ''), ''))
      INTO v_title FROM public.website_products p WHERE p.id = v_variant.product_id;
    INSERT INTO public.web_order_draft_lines (
      draft_id, variant_id, website_product_id, title, sku, qty, unit_price_jpy, line_total_jpy
    ) VALUES (
      v_draft_id, v_variant.id, v_variant.product_id, coalesce(v_title, 'Item'),
      (SELECT p.sku FROM public.website_products p WHERE p.id = v_variant.product_id),
      -- QC 2026-10-06: the quote's unit price (what the customer saw and
      -- the draft total is made of), the variant's price only as a fallback.
      v_qty, coalesce((v_item ->> 'unit_price_jpy')::numeric, v_variant.price_jpy),
      coalesce((v_item ->> 'unit_price_jpy')::numeric, v_variant.price_jpy) * v_qty
    );
    v_lines := v_lines + 1;
  END LOOP;

  IF v_lines = 0 THEN
    RAISE EXCEPTION 'empty_quote:';
  END IF;

  UPDATE public.checkout_quotes SET consumed_at = now() WHERE id = v_quote.id;

  RETURN jsonb_build_object(
    'ok', true, 'draft_id', v_draft_id, 'web_reference', v_reference, 'invoice_number', v_seq::text,
    'mode', v_quote.mode, 'currency', v_cur, 'total', v_total, 'total_jpy', v_quote.total_jpy,
    'shipping_pending', v_shipping IS NULL, 'deposit', v_deposit, 'schedule', v_schedule,
    'term_months', CASE WHEN v_quote.mode = 'layaway' THEN v_quote.term_months END,
    'fx_rate', v_rate, 'awaiting_confirmation', true,
    'payment_method', v_method, 'points', v_points, 'points_value', v_pts_value);
EXCEPTION
  WHEN raise_exception THEN
    IF SQLERRM LIKE 'out_of_stock:%' THEN
      RETURN jsonb_build_object('error', 'out_of_stock', 'variant_id', split_part(SQLERRM, ':', 2));
    ELSIF SQLERRM LIKE 'product_unavailable:%' THEN
      RETURN jsonb_build_object('error', 'product_unavailable', 'variant_id', split_part(SQLERRM, ':', 2));
    ELSIF SQLERRM LIKE 'variant_missing:%' THEN
      RETURN jsonb_build_object('error', 'variant_missing', 'variant_id', split_part(SQLERRM, ':', 2));
    ELSIF SQLERRM LIKE 'empty_quote:%' THEN
      RETURN jsonb_build_object('error', 'empty_quote');
    END IF;
    RAISE;
END
$function$
;

-- ---------------------------------------------------------------------------
-- get_square_settings
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_square_settings()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid  uuid := auth.uid();
  v_name text;
  v_by   uuid;
  v_at   timestamptz;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT (public.has_role(v_uid, 'admin'::public.app_role) OR public.has_permission(v_uid, 'admin_settings')) THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;
  -- The most recent change among the four rows names the last editor.
  SELECT updated_by_user_id, updated_at INTO v_by, v_at
    FROM public.system_settings
   WHERE key IN ('square_mode','square_app_id','square_location_id','card_agreement_min_jpy')
     AND updated_by_user_id IS NOT NULL
   ORDER BY updated_at DESC NULLS LAST LIMIT 1;
  IF v_by IS NOT NULL THEN
    SELECT full_name INTO v_name FROM public.profiles WHERE user_id = v_by LIMIT 1;
  END IF;
  RETURN jsonb_build_object(
    'found', (SELECT count(*) FROM public.system_settings
               WHERE key IN ('square_mode','square_app_id','square_location_id','card_agreement_min_jpy')) = 4,
    'mode',                  public.square_mode(),
    'raw_mode',              (SELECT value FROM public.system_settings WHERE key = 'square_mode'),
    'app_id',                coalesce((SELECT value #>> '{}' FROM public.system_settings WHERE key = 'square_app_id'), ''),
    'location_id',           coalesce((SELECT value #>> '{}' FROM public.system_settings WHERE key = 'square_location_id'), ''),
    'agreement_min_jpy',     coalesce(((SELECT value #>> '{}' FROM public.system_settings WHERE key = 'card_agreement_min_jpy'))::numeric, 0),
    'updated_at',            v_at,
    'updated_by_user_id',    v_by,
    'updated_by_name',       v_name,
    'audience',              public.square_audience(),
    'card_customers',        coalesce((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'code', c.customer_code, 'name', c.full_name) ORDER BY c.customer_code)
                                         FROM public.customers c
                                        WHERE c.id::text IN (SELECT jsonb_array_elements_text(public.square_card_customer_ids_json()))), '[]'::jsonb),
    'preflight',             (SELECT value || jsonb_build_object('updated_at', updated_at) FROM public.square_sync_state WHERE key = 'preflight:production'),
    'can_change',            public.has_role(v_uid, 'admin'::public.app_role),
    'authorized_now',        (SELECT count(*) FROM public.square_payments WHERE status = 'authorized'),
    'captured_30d',          (SELECT count(*) FROM public.square_payments
                               WHERE status = 'captured' AND captured_at >= now() - interval '30 days'),
    'disputes_open',         (SELECT count(*) FROM public.square_payments WHERE disputed_at IS NOT NULL AND status = 'captured'));
END
$function$
;

-- ---------------------------------------------------------------------------
-- guard_square_settings
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_square_settings()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF (OLD.key IN ('square_mode','square_app_id','square_location_id','card_agreement_min_jpy','square_audience','square_card_customer_ids')
      AND (TG_OP = 'DELETE' OR NEW.key IS DISTINCT FROM OLD.key OR NEW.value IS DISTINCT FROM OLD.value))
     OR (TG_OP = 'UPDATE' AND NEW.key IN ('square_mode','square_app_id','square_location_id','card_agreement_min_jpy','square_audience','square_card_customer_ids')
         AND OLD.key IS DISTINCT FROM NEW.key)
  THEN
    IF coalesce(current_setting('app.allow_square_settings_change', true), '') <> 'on' THEN
      RAISE EXCEPTION 'Card payment (Square) settings are changed only from the Hub: Website → Settings → Card payments (set_square_settings).'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$
;

-- ---------------------------------------------------------------------------
-- mark_web_order_refund_issued_atomic
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mark_web_order_refund_issued_atomic(p_order_id uuid, p_user_id uuid, p_method text, p_refunded_on date, p_note text DEFAULT NULL::text, p_exception jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order   public.cash_orders%ROWTYPE;
  v_amount  numeric(12,2);
  v_note    text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_method  text := lower(btrim(COALESCE(p_method, '')));
  v_prev    jsonb;
  v_card_paid boolean;
  v_noncard numeric(12,2);
  v_card_refunded numeric(12,2);
  v_paidy_paid numeric(12,2) := 0;
  v_paidy_refunded numeric(12,2) := 0;
  v_paidy_remaining numeric(12,2) := 0;
  v_exc jsonb := NULL;
  v_exc_trigger text := NULL;
  v_exc_amount numeric(12,2) := 0;
  v_card_captured numeric(12,2) := 0;
  v_credit_issued numeric(12,2) := 0;
  v_cap numeric(12,2) := 0;
  v_lot public.store_credit_lots%ROWTYPE;
  v_cre public.card_refund_exceptions%ROWTYPE;
  v_payout text;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'user_identity_required');
  END IF;

  SELECT * INTO v_order FROM public.cash_orders WHERE id = p_order_id FOR UPDATE;
  IF v_order.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  IF v_order.source_channel IS DISTINCT FROM 'web' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_web_order');
  END IF;
  IF v_order.status::text <> 'cancelled' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_cancelled', 'status', v_order.status::text);
  END IF;
  -- B01 (2026-10-08): the same request again after it succeeded (a retry
  -- after a lost answer) gets the same answer and writes nothing.
  IF v_order.refund_status = 'refund_issued' THEN
    SELECT a.new_value_json INTO v_prev FROM public.audit_logs a
     WHERE a.entity_type = 'cash_order' AND a.entity_id = p_order_id AND a.action = 'refund_marked_issued'
     ORDER BY a.created_at DESC LIMIT 1;
    IF v_prev IS NOT NULL AND v_prev ->> 'method' = v_method THEN
      RETURN jsonb_build_object('ok', true, 'already_recorded', true,
                                'amount', (v_prev ->> 'amount')::numeric, 'currency', v_prev ->> 'currency',
                                'method', v_method, 'refunded_on', v_prev ->> 'refunded_on',
                                'reference', COALESCE(v_order.web_reference, v_order.invoice_number));
    END IF;
  END IF;
  IF v_order.refund_status IS DISTINCT FROM 'refund_pending' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_refund_pending', 'refund_status', v_order.refund_status);
  END IF;
  IF v_method NOT IN ('bank_transfer', 'paidy', 'card', 'cash', 'other', 'bank_transfer_exception', 'store_credit_exception') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_method');
  END IF;
  IF p_refunded_on IS NULL OR p_refunded_on > (now() AT TIME ZONE 'Asia/Manila')::date THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_date');
  END IF;

  SELECT COALESCE(SUM(amount_paid), 0) INTO v_amount
    FROM public.cash_payments
   WHERE cash_order_id = p_order_id AND voided_at IS NULL
     AND COALESCE(reference_number, '') NOT LIKE 'LOYALTY-%';

  -- B01 (2026-10-08): card money goes back only through Square. A card-paid
  -- order is marked with method 'card', only once Square shows a COMPLETED
  -- refund, and the amount recorded is what Square completed (owner E7) —
  -- never the gross received. Other methods only for money that did not come
  -- by card.
  v_card_paid := EXISTS (SELECT 1 FROM public.cash_payments
                          WHERE cash_order_id = p_order_id AND voided_at IS NULL AND payment_method = 'square');
  SELECT COALESCE(SUM(amount_paid), 0) INTO v_noncard
    FROM public.cash_payments
   WHERE cash_order_id = p_order_id AND voided_at IS NULL
     AND COALESCE(payment_method, '') <> 'square'
     AND COALESCE(reference_number, '') NOT LIKE 'LOYALTY-%';
  IF v_method = 'card' AND NOT v_card_paid THEN
    RETURN jsonb_build_object('ok', false, 'error', 'method_mismatch', 'detail', 'not_paid_by_card');
  END IF;
  IF v_method IN ('bank_transfer_exception', 'store_credit_exception') THEN
    IF NOT v_card_paid THEN
      RETURN jsonb_build_object('ok', false, 'error', 'method_mismatch', 'detail', 'not_paid_by_card');
    END IF;
    IF NOT public.has_role(p_user_id, 'admin') THEN
      RETURN jsonb_build_object('ok', false, 'error', 'admin_only');
    END IF;
    v_payout := CASE v_method WHEN 'bank_transfer_exception' THEN 'bank_transfer' ELSE 'store_credit' END;
    SELECT * INTO v_cre FROM public.card_refund_exceptions
     WHERE cash_order_id = p_order_id AND status = 'approved' FOR UPDATE;
    IF v_cre.id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'exception_not_approved');
    END IF;
    IF v_cre.payout <> v_payout THEN
      RETURN jsonb_build_object('ok', false, 'error', 'exception_payout_mismatch', 'approved_payout', v_cre.payout);
    END IF;
    IF EXISTS (SELECT 1 FROM public.square_refunds r
                WHERE r.cash_order_id = p_order_id AND r.status NOT IN ('COMPLETED', 'FAILED', 'REJECTED')) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'exception_refund_in_progress');
    END IF;
    SELECT coalesce(sum(round(sp.amount_jpy)), 0) INTO v_card_captured
      FROM public.square_payments sp WHERE sp.cash_order_id = p_order_id AND sp.status = 'captured';
    SELECT coalesce(sum(r.amount_jpy), 0) INTO v_card_refunded
      FROM public.square_refunds r WHERE r.cash_order_id = p_order_id AND r.status = 'COMPLETED';
    SELECT coalesce(sum(round(l.original_amount)), 0) INTO v_credit_issued
      FROM public.store_credit_lots l WHERE l.source_cash_order_id = p_order_id AND l.status::text <> 'voided';
    v_cap := v_card_captured - v_card_refunded - v_credit_issued;
    IF v_cre.amount_jpy > v_cap THEN
      RETURN jsonb_build_object('ok', false, 'error', 'exception_superseded', 'cap_jpy', v_cap, 'approved_jpy', v_cre.amount_jpy,
                                'card_captured_jpy', v_card_captured, 'card_refunded_jpy', v_card_refunded, 'credit_issued_jpy', v_credit_issued);
    END IF;
    v_exc := COALESCE(p_exception, '{}'::jsonb);
    IF v_payout = 'bank_transfer' THEN
      IF COALESCE(v_exc ->> 'transfer_date', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'exception_evidence_required', 'missing', 'transfer_date');
      END IF;
      IF (v_exc ->> 'transfer_date')::date > (now() AT TIME ZONE 'Asia/Manila')::date
         OR (v_exc ->> 'transfer_date')::date < (v_cre.approved_at AT TIME ZONE 'Asia/Manila')::date THEN
        RETURN jsonb_build_object('ok', false, 'error', 'bad_date', 'detail', 'transfer_date');
      END IF;
      IF NULLIF(btrim(COALESCE(v_exc ->> 'transfer_reference', '')), '') IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'exception_evidence_required', 'missing', 'transfer_reference');
      END IF;
      UPDATE public.card_refund_exceptions
         SET status = 'recorded', recorded_by = p_user_id, recorded_at = now(),
             transfer_date = (v_exc ->> 'transfer_date')::date,
             transfer_reference = left(btrim(v_exc ->> 'transfer_reference'), 200), updated_at = now()
       WHERE id = v_cre.id
      RETURNING * INTO v_cre;
    ELSE
      IF NULLIF(btrim(COALESCE(v_exc ->> 'customer_request', '')), '') IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'exception_evidence_required', 'missing', 'customer_request');
      END IF;
      IF COALESCE(v_exc ->> 'store_credit_lot_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'exception_evidence_required', 'missing', 'store_credit_lot_id');
      END IF;
      SELECT * INTO v_lot FROM public.store_credit_lots WHERE id = (v_exc ->> 'store_credit_lot_id')::uuid FOR UPDATE;
      IF v_lot.id IS NULL OR v_lot.customer_id IS DISTINCT FROM v_order.customer_id OR v_lot.currency::text <> 'JPY'
         OR v_lot.status::text <> 'active' OR v_lot.expires_at <= now() OR v_lot.remaining_amount <> v_lot.original_amount
         OR v_lot.original_amount <> v_cre.amount_jpy OR v_lot.source_cash_order_id IS NOT NULL
         OR v_lot.issued_at < v_cre.approved_at
         OR EXISTS (SELECT 1 FROM public.card_refund_exceptions x WHERE x.store_credit_lot_id = v_lot.id) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'exception_lot_mismatch', 'detail',
          CASE WHEN v_lot.id IS NULL THEN 'lot_not_found'
               WHEN v_lot.customer_id IS DISTINCT FROM v_order.customer_id THEN 'lot_not_this_customer'
               WHEN v_lot.currency::text <> 'JPY' THEN 'lot_not_jpy'
               WHEN v_lot.status::text <> 'active' THEN 'lot_not_active'
               WHEN v_lot.expires_at <= now() THEN 'lot_expired'
               WHEN v_lot.remaining_amount <> v_lot.original_amount THEN 'lot_already_spent'
               WHEN v_lot.source_cash_order_id IS NOT NULL THEN 'lot_tied_to_an_order'
               WHEN v_lot.issued_at < v_cre.approved_at THEN 'lot_issued_before_approval'
               WHEN v_lot.original_amount <> v_cre.amount_jpy THEN 'lot_amount_differs'
               ELSE 'lot_already_allocated' END,
          'lot_amount', v_lot.original_amount, 'approved_jpy', v_cre.amount_jpy);
      END IF;
      UPDATE public.card_refund_exceptions
         SET status = 'recorded', recorded_by = p_user_id, recorded_at = now(), store_credit_lot_id = v_lot.id,
             customer_request = left(btrim(v_exc ->> 'customer_request'), 500), updated_at = now()
       WHERE id = v_cre.id
      RETURNING * INTO v_cre;
    END IF;
    v_amount := v_cre.amount_jpy;
    v_exc := jsonb_build_object('exception_id', v_cre.id, 'trigger', v_cre.trigger_kind, 'payout', v_cre.payout,
                                'square_refund_id', v_cre.square_refund_id, 'square_support_ticket', v_cre.square_support_ticket,
                                'transfer_date', v_cre.transfer_date, 'transfer_reference', v_cre.transfer_reference,
                                'store_credit_lot_id', v_cre.store_credit_lot_id, 'customer_request', v_cre.customer_request,
                                'approved_by', v_cre.approved_by, 'approved_at', v_cre.approved_at,
                                'cap_jpy', v_cap, 'card_captured_jpy', v_card_captured, 'card_refunded_jpy', v_card_refunded,
                                'credit_issued_jpy', v_credit_issued);
  END IF;
  IF v_method NOT IN ('card', 'bank_transfer_exception', 'store_credit_exception') AND v_card_paid AND v_noncard <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'method_mismatch', 'detail', 'paid_by_card');
  END IF;
  -- Mixed payment (card + something else): a non-card method records only the
  -- non-card money; the card part comes back through Square and is recorded by
  -- Square's own refund email / the card row. Never the gross.
  IF v_method NOT IN ('card', 'bank_transfer_exception', 'store_credit_exception') AND v_card_paid THEN
    v_amount := v_noncard;
  END IF;
  IF v_method = 'card' THEN
    SELECT COALESCE(SUM(amount_jpy), 0) INTO v_card_refunded
      FROM public.square_refunds WHERE cash_order_id = p_order_id AND status = 'COMPLETED';
    IF v_card_refunded <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'no_completed_card_refund');
    END IF;
    v_amount := LEAST(v_amount, v_card_refunded);
  END IF;
  -- PA03 (owner 2026-10-08): Paidy money goes back only through the Paidy
  -- dashboard and counts only once the Hub has read the refund back from
  -- Paidy (paidy_refunds, written by record_paidy_refund). Method 'paidy'
  -- needs Paidy money on the order and at least one verified refund; the
  -- amount recorded is the verified total, capped at the Paidy money, and the
  -- audit carries cumulative refunded + remaining — never the gross. A
  -- non-Paidy method on a mixed order records only the non-Paidy money.
  SELECT COALESCE(SUM(amount_paid), 0) INTO v_paidy_paid
    FROM public.cash_payments
   WHERE cash_order_id = p_order_id AND voided_at IS NULL AND payment_method = 'paidy';
  SELECT COALESCE(SUM(r.amount_jpy), 0) INTO v_paidy_refunded
    FROM public.paidy_refunds r WHERE r.cash_order_id = p_order_id;
  IF v_method = 'paidy' AND v_paidy_paid <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'method_mismatch', 'detail', 'not_paid_by_paidy');
  END IF;
  IF v_method = 'paidy' THEN
    IF v_paidy_refunded <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'no_verified_paidy_refund', 'paidy_paid_jpy', v_paidy_paid);
    END IF;
    v_amount := LEAST(v_paidy_paid, v_paidy_refunded);
    v_paidy_remaining := GREATEST(0, v_paidy_paid - v_paidy_refunded);
  ELSIF v_paidy_paid > 0 AND v_method NOT IN ('bank_transfer_exception', 'store_credit_exception') THEN
    IF v_amount - v_paidy_paid <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'method_mismatch', 'detail', 'paid_by_paidy');
    END IF;
    v_amount := v_amount - v_paidy_paid;
  END IF;

  UPDATE public.cash_orders
     SET refund_status = 'refund_issued',
         refund_note = CASE
           WHEN v_note IS NULL THEN refund_note
           WHEN refund_note IS NULL OR btrim(refund_note) = '' THEN v_note
           ELSE refund_note || E'\n' || v_note END
   WHERE id = p_order_id;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id)
  VALUES ('cash_order', p_order_id, 'refund_marked_issued',
          jsonb_build_object('refund_status', 'refund_pending'),
          jsonb_build_object('refund_status', 'refund_issued', 'method', v_method, 'refunded_on', p_refunded_on,
                             'amount', v_amount, 'currency', v_order.currency::text, 'note', v_note,
                             'paidy_paid_jpy', v_paidy_paid, 'paidy_refunded_total_jpy', v_paidy_refunded,
                             'paidy_remaining_jpy', v_paidy_remaining, 'exception', v_exc,
                             'invoice_number', v_order.invoice_number, 'web_reference', v_order.web_reference),
          p_user_id);

  RETURN jsonb_build_object('ok', true, 'amount', v_amount, 'currency', v_order.currency::text,
                            'method', v_method, 'refunded_on', p_refunded_on,
                            'paidy_refunded_total_jpy', v_paidy_refunded, 'paidy_remaining_jpy', v_paidy_remaining, 'exception', v_exc,
                            'reference', COALESCE(v_order.web_reference, v_order.invoice_number));
END
$function$
;

-- ---------------------------------------------------------------------------
-- record_square_refund
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_square_refund(p_refund_id text, p_square_payment_id text, p_status text, p_amount_jpy bigint, p_reason text, p_provider_created_at timestamp with time zone, p_provider_updated_at timestamp with time zone, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_sq    public.square_payments%ROWTYPE;
  v_order public.cash_orders%ROWTYPE;
  v_old   public.square_refunds%ROWTYPE;
  v_new   public.square_refunds%ROWTYPE;
  v_st    text := upper(coalesce(p_status, 'PENDING'));
  v_other bigint := 0;
  v_refuse text := NULL;
BEGIN
  -- Locked: a recording (finalize) and this refund serialise on the payment (review #4).
  -- R05 race (2026-10-08): the ORDER is locked first (order → payment, as in
  -- finalize), so a cancel-with-store-credit in flight and this refund never
  -- overlap: whichever commits second sees the other's row.
  SELECT * INTO v_sq FROM public.square_payments WHERE square_payment_id = p_square_payment_id;
  IF v_sq.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'unknown_payment'); END IF;
  SELECT * INTO v_order FROM public.cash_orders WHERE id = v_sq.cash_order_id FOR UPDATE;
  SELECT * INTO v_sq FROM public.square_payments WHERE square_payment_id = p_square_payment_id FOR UPDATE;
  -- QC10 (2026-10-05): one writer per provider case at a time, including the
  -- very first insert (two first observations used to both pass the check).
  PERFORM pg_advisory_xact_lock(hashtextextended('square_refund:' || p_refund_id, 0));
  SELECT * INTO v_old FROM public.square_refunds WHERE square_refund_id = p_refund_id FOR UPDATE;
  IF coalesce(p_amount_jpy, 0) <= 0 THEN v_refuse := 'bad_amount';
  ELSIF upper(coalesce(p_payload -> 'amount_money' ->> 'currency', '')) <> 'JPY' THEN v_refuse := 'bad_currency';
  ELSIF v_old.id IS NOT NULL AND v_old.square_payment_id <> p_square_payment_id THEN v_refuse := 'parent_mismatch';
  ELSIF v_st NOT IN ('FAILED','REJECTED') THEN
    SELECT coalesce(sum(r.amount_jpy), 0) INTO v_other FROM public.square_refunds r
     WHERE r.square_payment_row = v_sq.id AND r.square_refund_id <> p_refund_id AND r.status NOT IN ('FAILED','REJECTED');
    IF v_other + p_amount_jpy > round(v_sq.amount_jpy)::bigint THEN v_refuse := 'over_ceiling'; END IF;
  END IF;
  IF v_refuse IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.staff_notifications n
                    WHERE n.type = 'card_refund_unrecorded' AND n.metadata ->> 'refund_id' = p_refund_id AND n.metadata ->> 'error' = v_refuse) THEN
      INSERT INTO public.staff_notifications (type, title, body, customer_id, invoice_number, metadata)
      VALUES ('card_refund_unrecorded', 'Square refund NOT recorded — needs a look',
              coalesce(v_order.web_reference, v_order.invoice_number, '') || ' · Square refund ' || p_refund_id || ' (' || lower(v_st) || ', '
                || coalesce(p_payload -> 'amount_money' ->> 'amount', coalesce(p_amount_jpy, 0)::text) || ' ' || coalesce(p_payload -> 'amount_money' ->> 'currency', '?')
                || ') was refused: ' || v_refuse
                || CASE v_refuse
                     WHEN 'over_ceiling' THEN ' — with the other refunds on this payment (¥' || to_char(v_other, 'FM999,999,999') || ') it exceeds the ¥' || to_char(round(v_sq.amount_jpy), 'FM999,999,999') || ' captured.'
                     WHEN 'parent_mismatch' THEN ' — this refund id is already recorded on payment ' || v_old.square_payment_id || '.'
                     WHEN 'bad_currency' THEN ' — not a yen refund.'
                     ELSE ' — no positive amount.' END
                || ' The Hub ledger was not changed; check the refund in the Square Dashboard.',
              v_order.customer_id, v_order.invoice_number,
              jsonb_build_object('cash_order_id', v_sq.cash_order_id, 'square_payment_id', p_square_payment_id, 'refund_id', p_refund_id,
                                 'status', v_st, 'error', v_refuse, 'amount_jpy', p_amount_jpy, 'captured_jpy', v_sq.amount_jpy,
                                 'other_refunds_jpy', v_other, 'test', v_sq.test));
    END IF;
    RETURN jsonb_build_object('ok', false, 'error', v_refuse, 'captured_jpy', v_sq.amount_jpy, 'other_refunds_jpy', v_other);
  END IF;
  IF v_old.id IS NOT NULL AND p_provider_updated_at IS NOT NULL AND v_old.provider_updated_at IS NOT NULL
     AND p_provider_updated_at < v_old.provider_updated_at THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'stale', true);
  END IF;
  -- A terminal provider state never goes back to an open one (QC10).
  IF v_old.id IS NOT NULL AND v_old.status IN ('COMPLETED','FAILED','REJECTED') AND v_st NOT IN ('COMPLETED','FAILED','REJECTED') THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'stale', true, 'terminal', v_old.status);
  END IF;
  INSERT INTO public.square_refunds (square_refund_id, square_payment_row, square_payment_id, cash_order_id,
         amount_jpy, status, reason, provider_created_at, provider_updated_at, last_payload)
  VALUES (p_refund_id, v_sq.id, p_square_payment_id, v_sq.cash_order_id, greatest(coalesce(p_amount_jpy, 0), 0),
          v_st, left(p_reason, 500), p_provider_created_at, p_provider_updated_at, p_payload)
  ON CONFLICT (square_refund_id) DO UPDATE
     SET status = EXCLUDED.status, amount_jpy = EXCLUDED.amount_jpy, reason = coalesce(EXCLUDED.reason, square_refunds.reason),
         provider_updated_at = coalesce(EXCLUDED.provider_updated_at, square_refunds.provider_updated_at),
         last_payload = EXCLUDED.last_payload, updated_at = now()
   WHERE square_refunds.provider_updated_at IS NULL OR EXCLUDED.provider_updated_at IS NULL
      OR EXCLUDED.provider_updated_at >= square_refunds.provider_updated_at
  RETURNING * INTO v_new;
  IF v_new.id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'stale', true);
  END IF;
  -- QC01: a refund (not failed) on captured card money the Hub has not
  -- recorded is flagged, so it is never recorded in full by mistake.
  IF v_st NOT IN ('FAILED','REJECTED') AND v_sq.status = 'captured' AND v_sq.cash_payment_id IS NULL THEN
    UPDATE public.square_payments
       SET exception = 'refunded_before_record', exception_at = now(),
           exception_note = 'Square refund ' || p_refund_id || ' (' || v_st || ') on a capture the Hub has not recorded',
           updated_at = now()
     WHERE id = v_sq.id AND status = 'captured' AND cash_payment_id IS NULL
       AND exception_resolved_at IS NULL AND exception IS DISTINCT FROM 'refunded_before_record';
  END IF;
  IF v_old.id IS NULL OR v_old.status IS DISTINCT FROM v_new.status THEN
    INSERT INTO public.staff_notifications (type, title, body, customer_id, invoice_number, metadata)
    VALUES ('card_refunded',
            CASE v_st WHEN 'COMPLETED' THEN 'Card refund completed' WHEN 'FAILED' THEN 'Card refund FAILED'
                      WHEN 'REJECTED' THEN 'Card refund REJECTED' ELSE 'Card refund started' END,
            coalesce(v_order.web_reference, v_order.invoice_number, '') || ' · ¥' || to_char(v_new.amount_jpy, 'FM999,999,999')
              || ' refund ' || lower(v_st)
              || CASE WHEN v_st IN ('FAILED','REJECTED') THEN ' — the customer has NOT been paid back.'
                      ELSE '. Record the decision on the order (Website → Card payments → Refunds).' END,
            v_order.customer_id, v_order.invoice_number,
            jsonb_build_object('cash_order_id', v_sq.cash_order_id, 'square_payment_id', p_square_payment_id,
                               'refund_id', p_refund_id, 'status', v_st, 'test', v_sq.test));
    INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json)
    VALUES ('square_refund', v_new.id, 'square_refund_state', jsonb_build_object('status', v_old.status),
            jsonb_build_object('status', v_st, 'amount_jpy', v_new.amount_jpy, 'refund_id', p_refund_id));
    -- R05 (2026-10-08): the order already holds a cancellation store-credit
    -- lot — the same money is now going back twice. One bell per refund.
    IF v_st NOT IN ('FAILED','REJECTED') AND EXISTS (
         SELECT 1 FROM public.store_credit_lots l
          WHERE l.source_cash_order_id = v_sq.cash_order_id AND l.source_type = 'cancelled_cash' AND l.status <> 'voided')
       AND NOT EXISTS (SELECT 1 FROM public.staff_notifications n
                        WHERE n.type = 'card_refund_after_credit' AND n.metadata ->> 'refund_id' = p_refund_id) THEN
      INSERT INTO public.staff_notifications (type, title, body, customer_id, invoice_number, metadata)
      VALUES ('card_refund_after_credit', 'Card refund on an order that already has store credit',
              coalesce(v_order.web_reference, v_order.invoice_number, '') || ' · ¥' || to_char(v_new.amount_jpy, 'FM999,999,999')
                || ' refunded in Square (' || lower(v_st) || ') but this order was cancelled with STORE CREDIT. The customer is being paid back twice: void the UNSPENT store-credit lot the same day (Settings → Store Credit); a part already spent is a receivable — follow the card refund exception procedure (docs/SQUARE.md).',
              v_order.customer_id, v_order.invoice_number,
              jsonb_build_object('cash_order_id', v_sq.cash_order_id, 'square_payment_id', p_square_payment_id,
                                 'refund_id', p_refund_id, 'status', v_st, 'test', v_sq.test));
    END IF;
  END IF;
  IF v_st NOT IN ('FAILED', 'REJECTED') AND (v_old.id IS NULL OR v_old.status IS DISTINCT FROM v_new.status)
     AND (EXISTS (SELECT 1 FROM public.card_refund_exceptions x
                   WHERE x.cash_order_id = v_sq.cash_order_id AND x.status IN ('approved', 'recorded')
                     AND x.square_refund_id IS DISTINCT FROM p_refund_id)
          OR EXISTS (SELECT 1 FROM public.audit_logs a
                      WHERE a.entity_type = 'cash_order' AND a.entity_id = v_sq.cash_order_id AND a.action = 'refund_marked_issued'
                        AND a.new_value_json ->> 'method' IN ('bank_transfer_exception', 'store_credit_exception')))
     AND NOT EXISTS (SELECT 1 FROM public.staff_notifications n
                      WHERE n.type = 'card_refund_after_exception' AND n.metadata ->> 'refund_id' = p_refund_id) THEN
    INSERT INTO public.staff_notifications (type, title, body, customer_id, invoice_number, metadata)
    VALUES ('card_refund_after_exception', 'Square refund AFTER a refund-outside-Square approval',
            coalesce(v_order.web_reference, v_order.invoice_number, '') || ' · ¥' || to_char(v_new.amount_jpy, 'FM999,999,999')
              || ' refund ' || p_refund_id || ' is ' || lower(v_st) || ' in Square, but a refund outside Square (bank transfer / store credit) is approved or already paid for this order. If it is not paid yet, do NOT pay it: cancel the approval. If it is paid, the customer may be paid back twice: a staff case — never settle both.',
            v_order.customer_id, v_order.invoice_number,
            jsonb_build_object('cash_order_id', v_sq.cash_order_id, 'square_payment_id', p_square_payment_id,
                               'refund_id', p_refund_id, 'status', v_st, 'test', v_sq.test));
  END IF;
  RETURN jsonb_build_object('ok', true, 'changed', v_old.id IS NULL OR v_old.status IS DISTINCT FROM v_new.status,
                            'refund', to_jsonb(v_new));
END
$function$
;

-- ---------------------------------------------------------------------------
-- reserve_square_attempt
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reserve_square_attempt(p_cash_order_id uuid, p_customer_id uuid, p_amount_jpy bigint, p_environment text, p_location_id text, p_app_id text, p_test boolean, p_idempotency_key text, p_reference text, p_verification text, p_evidence jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order  public.cash_orders%ROWTYPE;
  v_att    public.square_card_attempts%ROWTYPE;
  v_counts jsonb;
BEGIN
  IF p_amount_jpy IS NULL OR p_amount_jpy <= 0 THEN RETURN jsonb_build_object('error', 'bad_amount'); END IF;
  IF p_environment IS NULL OR p_environment NOT IN ('sandbox','production') THEN
    RETURN jsonb_build_object('error', 'bad_environment');
  END IF;
  IF coalesce(p_location_id, '') = '' THEN RETURN jsonb_build_object('error', 'bad_location'); END IF;
  IF p_idempotency_key IS NULL OR char_length(p_idempotency_key) NOT BETWEEN 8 AND 45
     OR p_reference IS NULL OR char_length(p_reference) NOT BETWEEN 8 AND 40 THEN
    RETURN jsonb_build_object('error', 'bad_key');
  END IF;

  SELECT * INTO v_order FROM public.cash_orders WHERE id = p_cash_order_id FOR UPDATE;
  IF v_order.id IS NULL THEN RETURN jsonb_build_object('error', 'order_not_found'); END IF;

  -- Same request again (same order + same card token → same key): hand back
  -- the attempt; the caller replays the SAME immutable request or reports its
  -- recorded outcome. Never a second commitment.
  SELECT * INTO v_att FROM public.square_card_attempts WHERE idempotency_key = p_idempotency_key;
  IF v_att.id IS NOT NULL THEN
    IF v_att.cash_order_id <> p_cash_order_id THEN RETURN jsonb_build_object('error', 'bad_key'); END IF;
    RETURN jsonb_build_object('ok', true, 'outcome', 'existing', 'attempt', to_jsonb(v_att));
  END IF;

  IF v_order.customer_id IS DISTINCT FROM p_customer_id THEN RETURN jsonb_build_object('error', 'wrong_customer'); END IF;
  IF NOT public.square_card_allowed(p_customer_id) THEN RETURN jsonb_build_object('error', 'card_not_offered'); END IF;
  IF v_order.status::text <> 'pending' THEN
    RETURN jsonb_build_object('error', 'order_not_payable', 'status', v_order.status::text);
  END IF;
  -- The customer chose how to pay at checkout (2026-10-05, owner C1).
  IF v_order.source_channel = 'web' AND coalesce(v_order.payment_method, 'transfer') <> 'square' THEN
    RETURN jsonb_build_object('error', 'method_not_chosen', 'payment_method', coalesce(v_order.payment_method, 'transfer'));
  END IF;
  IF v_order.currency::text <> 'JPY' THEN RETURN jsonb_build_object('error', 'not_jpy'); END IF;
  -- Integer yen only (SQ12): a fractional balance is never rounded into a card amount.
  IF v_order.remaining_balance <> trunc(v_order.remaining_balance) THEN
    RETURN jsonb_build_object('error', 'fractional_balance', 'remaining_balance', v_order.remaining_balance);
  END IF;
  IF v_order.remaining_balance <> p_amount_jpy::numeric THEN
    RETURN jsonb_build_object('error', 'amount_changed', 'remaining_balance', v_order.remaining_balance);
  END IF;

  -- Nothing while Paidy holds the order (Paidy follow-up owner rule): a Paidy
  -- window open, an authorisation waiting, a capture not yet recorded.
  IF coalesce(public.cash_order_payment_lock(p_cash_order_id), '') LIKE 'paidy%' THEN
    RETURN jsonb_build_object('error', 'paidy_in_progress', 'lock', public.cash_order_payment_lock(p_cash_order_id));
  END IF;

  SELECT * INTO v_att FROM public.square_card_attempts
   WHERE cash_order_id = p_cash_order_id AND status IN ('reserved','unknown','cancelling')
   ORDER BY created_at DESC LIMIT 1;
  IF v_att.id IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'attempt_in_progress', 'attempt', to_jsonb(v_att));
  END IF;
  IF EXISTS (SELECT 1 FROM public.square_payments
              WHERE cash_order_id = p_cash_order_id
                AND (status = 'authorized' OR (status = 'captured' AND cash_payment_id IS NULL AND exception_resolved_at IS NULL))) THEN
    RETURN jsonb_build_object('error', 'card_hold_active');
  END IF;
  IF EXISTS (SELECT 1 FROM public.payment_submissions
              WHERE cash_order_id = p_cash_order_id
                AND (status::text IN ('submitted','under_review')
                     OR (status::text = 'confirmed' AND confirmed_payment_id IS NULL))) THEN
    RETURN jsonb_build_object('error', 'submission_pending');
  END IF;

  v_counts := public.square_refusal_counts(p_cash_order_id, p_customer_id);
  IF (v_counts->>'order_failures')::int >= 5 THEN
    RETURN jsonb_build_object('error', 'too_many_attempts', 'scope', 'order', 'counts', v_counts);
  END IF;
  IF (v_counts->>'customer_refusals')::int >= 10 THEN
    RETURN jsonb_build_object('error', 'too_many_attempts', 'scope', 'customer', 'counts', v_counts);
  END IF;

  INSERT INTO public.square_card_attempts (cash_order_id, customer_id, reference, idempotency_key, amount_jpy,
         environment, location_id, app_id, test, status, verification, evidence)
  VALUES (p_cash_order_id, p_customer_id, p_reference, p_idempotency_key, p_amount_jpy,
          p_environment, p_location_id, p_app_id, coalesce(p_test, false), 'reserved', p_verification,
          coalesce(p_evidence, '{}'::jsonb))
  RETURNING * INTO v_att;

  RETURN jsonb_build_object('ok', true, 'outcome', 'reserved', 'attempt', to_jsonb(v_att));
END
$function$
;

-- ---------------------------------------------------------------------------
-- set_square_settings
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_square_settings(p_mode text, p_app_id text DEFAULT NULL::text, p_location_id text DEFAULT NULL::text, p_agreement_min_jpy numeric DEFAULT NULL::numeric, p_expected_mode text DEFAULT NULL::text, p_audience text DEFAULT NULL::text, p_card_customer_codes text[] DEFAULT NULL::text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid       uuid := auth.uid();
  v_mode_row  public.system_settings%ROWTYPE;
  v_app_row   public.system_settings%ROWTYPE;
  v_loc_row   public.system_settings%ROWTYPE;
  v_min_row   public.system_settings%ROWTYPE;
  v_old_mode  text;
  v_new_mode  text;
  v_new_app   text;
  v_new_loc   text;
  v_new_min   numeric;
  v_changed   boolean := false;
  v_now       timestamptz := now();
  v_aud_row   public.system_settings%ROWTYPE;
  v_ids_row   public.system_settings%ROWTYPE;
  v_new_aud   text;
  v_new_ids   jsonb;
  v_old_ids   jsonb;
  v_bad       text[];
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_role(v_uid, 'admin'::public.app_role) THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;

  SELECT * INTO v_mode_row FROM public.system_settings WHERE key = 'square_mode' FOR UPDATE;
  SELECT * INTO v_app_row  FROM public.system_settings WHERE key = 'square_app_id' FOR UPDATE;
  SELECT * INTO v_loc_row  FROM public.system_settings WHERE key = 'square_location_id' FOR UPDATE;
  SELECT * INTO v_min_row  FROM public.system_settings WHERE key = 'card_agreement_min_jpy' FOR UPDATE;
  SELECT * INTO v_aud_row  FROM public.system_settings WHERE key = 'square_audience' FOR UPDATE;
  SELECT * INTO v_ids_row  FROM public.system_settings WHERE key = 'square_card_customer_ids' FOR UPDATE;
  IF v_mode_row.id IS NULL OR v_app_row.id IS NULL OR v_loc_row.id IS NULL OR v_min_row.id IS NULL
     OR v_aud_row.id IS NULL OR v_ids_row.id IS NULL THEN
    RETURN jsonb_build_object('error', 'setting_missing');
  END IF;

  v_old_mode := public.square_mode();
  v_new_mode := coalesce(btrim(p_mode), v_old_mode);
  IF v_new_mode NOT IN ('off','test','on') THEN RETURN jsonb_build_object('error', 'invalid_mode'); END IF;
  IF p_expected_mode IS NOT NULL AND p_expected_mode IS DISTINCT FROM v_old_mode THEN
    RETURN jsonb_build_object('error', 'stale', 'mode', v_old_mode);
  END IF;

  v_new_app := CASE WHEN p_app_id IS NULL THEN coalesce(v_app_row.value #>> '{}', '') ELSE btrim(p_app_id) END;
  v_new_loc := CASE WHEN p_location_id IS NULL THEN coalesce(v_loc_row.value #>> '{}', '') ELSE btrim(p_location_id) END;
  v_new_min := coalesce(p_agreement_min_jpy, coalesce((v_min_row.value #>> '{}')::numeric, 0));

  -- Only PUBLIC ids are ever stored. An access token (EAAA…) or anything that
  -- is not an Application ID is refused, not saved.
  IF v_new_app <> '' AND v_new_app !~ '^(sandbox-sq0idb-|sq0idp-)[A-Za-z0-9_-]{6,}$' THEN
    RETURN jsonb_build_object('error', 'invalid_app_id');
  END IF;
  IF v_new_loc <> '' AND v_new_loc !~ '^[A-Z0-9]{8,}$' THEN
    RETURN jsonb_build_object('error', 'invalid_location_id');
  END IF;
  IF v_new_min < 0 OR v_new_min <> trunc(v_new_min) THEN
    RETURN jsonb_build_object('error', 'invalid_agreement_min');
  END IF;
  v_new_aud := CASE WHEN p_audience IS NULL THEN public.square_audience() ELSE btrim(p_audience) END;
  IF v_new_aud NOT IN ('everyone', 'listed') THEN
    RETURN jsonb_build_object('error', 'invalid_audience');
  END IF;
  v_old_ids := CASE WHEN jsonb_typeof(v_ids_row.value) = 'array' THEN v_ids_row.value ELSE '[]'::jsonb END;
  IF p_card_customer_codes IS NULL THEN
    v_new_ids := v_old_ids;
  ELSE
    SELECT array_agg(s.c ORDER BY s.c) INTO v_bad
      FROM (SELECT DISTINCT upper(btrim(x)) AS c FROM unnest(p_card_customer_codes) x WHERE btrim(coalesce(x, '')) <> '') s
     WHERE NOT EXISTS (SELECT 1 FROM public.customers cu WHERE upper(cu.customer_code) = s.c);
    IF v_bad IS NOT NULL THEN
      RETURN jsonb_build_object('error', 'unknown_customer_code', 'codes', to_jsonb(v_bad));
    END IF;
    SELECT coalesce(jsonb_agg(DISTINCT cu.id::text ORDER BY cu.id::text), '[]'::jsonb) INTO v_new_ids
      FROM public.customers cu
     WHERE upper(cu.customer_code) IN (SELECT upper(btrim(x)) FROM unnest(p_card_customer_codes) x WHERE btrim(coalesce(x, '')) <> '');
  END IF;
  -- The id family must match the mode: test with a production id would take
  -- real money on a "test"; on with a sandbox id would charge nobody.
  IF v_new_mode = 'test' AND v_new_app !~ '^sandbox-sq0idb-' THEN RETURN jsonb_build_object('error', 'sandbox_app_id_required'); END IF;
  IF v_new_mode = 'on'   AND v_new_app !~ '^sq0idp-'         THEN RETURN jsonb_build_object('error', 'production_app_id_required'); END IF;
  IF v_new_mode <> 'off' AND v_new_loc = ''                   THEN RETURN jsonb_build_object('error', 'location_id_required'); END IF;

  PERFORM set_config('app.allow_square_settings_change', 'on', true);
  IF v_mode_row.value IS DISTINCT FROM to_jsonb(v_new_mode) THEN
    UPDATE public.system_settings SET value = to_jsonb(v_new_mode), updated_by_user_id = v_uid, updated_at = v_now WHERE id = v_mode_row.id;
    v_changed := true;
  END IF;
  IF coalesce(v_app_row.value #>> '{}', '') IS DISTINCT FROM v_new_app THEN
    UPDATE public.system_settings SET value = to_jsonb(v_new_app), updated_by_user_id = v_uid, updated_at = v_now WHERE id = v_app_row.id;
    v_changed := true;
  END IF;
  IF coalesce(v_loc_row.value #>> '{}', '') IS DISTINCT FROM v_new_loc THEN
    UPDATE public.system_settings SET value = to_jsonb(v_new_loc), updated_by_user_id = v_uid, updated_at = v_now WHERE id = v_loc_row.id;
    v_changed := true;
  END IF;
  IF coalesce((v_min_row.value #>> '{}')::numeric, 0) IS DISTINCT FROM v_new_min THEN
    UPDATE public.system_settings SET value = to_jsonb(v_new_min), updated_by_user_id = v_uid, updated_at = v_now WHERE id = v_min_row.id;
    v_changed := true;
  END IF;
  IF coalesce(v_aud_row.value #>> '{}', '') IS DISTINCT FROM v_new_aud THEN
    UPDATE public.system_settings SET value = to_jsonb(v_new_aud), updated_by_user_id = v_uid, updated_at = v_now WHERE id = v_aud_row.id;
    v_changed := true;
  END IF;
  IF v_old_ids IS DISTINCT FROM v_new_ids THEN
    UPDATE public.system_settings SET value = v_new_ids, updated_by_user_id = v_uid, updated_at = v_now WHERE id = v_ids_row.id;
    v_changed := true;
  END IF;
  PERFORM set_config('app.allow_square_settings_change', '', true);

  IF NOT v_changed THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'mode', v_old_mode, 'app_id', v_new_app,
                              'location_id', v_new_loc, 'agreement_min_jpy', v_new_min,
                              'audience', v_new_aud, 'card_customer_ids', v_new_ids);
  END IF;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('system_setting', v_mode_row.id, 'set_square_settings',
          jsonb_build_object('mode', v_old_mode, 'raw_mode', v_mode_row.value, 'app_id', v_app_row.value,
                             'location_id', v_loc_row.value, 'agreement_min_jpy', v_min_row.value,
                             'updated_at', v_mode_row.updated_at, 'updated_by_user_id', v_mode_row.updated_by_user_id,
                             'audience', v_aud_row.value, 'card_customer_ids', v_old_ids),
          jsonb_build_object('mode', v_new_mode, 'app_id', v_new_app, 'location_id', v_new_loc,
                             'agreement_min_jpy', v_new_min, 'audience', v_new_aud, 'card_customer_ids', v_new_ids),
          v_uid, v_now);

  RETURN jsonb_build_object('ok', true, 'changed', true, 'mode', v_new_mode, 'old_mode', v_old_mode,
                            'app_id', v_new_app, 'location_id', v_new_loc, 'agreement_min_jpy', v_new_min,
                            'audience', v_new_aud, 'card_customer_ids', v_new_ids, 'updated_at', v_now);
END
$function$
;

-- ---------------------------------------------------------------------------
-- switch_web_payment_method_by_customer_atomic
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.switch_web_payment_method_by_customer_atomic(p_order_id uuid, p_customer_id uuid, p_method text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_owner    uuid;
  v_old      text;
  v_cur      text;
  v_status   text;
  v_pay      text;
  v_chan     text;
  v_lock     text;
  v_ref      text;
  v_decision text;
  v_decision_id uuid;
  v_decided_at timestamptz;
BEGIN
  IF p_order_id IS NULL OR p_customer_id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  SELECT customer_id, coalesce(payment_method, 'transfer'), currency::text, status::text, payment_status,
         source_channel, coalesce(web_reference, invoice_number)
    INTO v_owner, v_old, v_cur, v_status, v_pay, v_chan, v_ref
    FROM public.cash_orders WHERE id = p_order_id FOR UPDATE;
  -- Another customer's order answers exactly like a missing one.
  IF NOT FOUND OR v_owner IS DISTINCT FROM p_customer_id THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  IF v_chan IS DISTINCT FROM 'web' THEN
    RETURN jsonb_build_object('error', 'not_web_order');
  END IF;
  IF v_status <> 'pending' OR coalesce(v_pay, '') <> 'pending_transfer' THEN
    RETURN jsonb_build_object('error', 'not_payable');
  END IF;
  -- Owner rule 2026-10-04: while Paidy, a card hold or any other payment is in
  -- progress, nothing about how the order is paid changes.
  v_lock := public.cash_order_payment_lock(p_order_id);
  IF v_lock IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'payment_in_progress');
  END IF;
  -- C1: only after her latest DECIDED payment was rejected. Latest decision =
  -- newest by updated_at (decision time) among rejected / needs_clarification /
  -- confirmed.
  SELECT s.status::text, s.id, coalesce(s.updated_at, s.created_at)
    INTO v_decision, v_decision_id, v_decided_at
    FROM public.payment_submissions s
   WHERE s.cash_order_id = p_order_id
     AND s.status IN ('rejected', 'needs_clarification', 'confirmed')
   ORDER BY s.updated_at DESC NULLS LAST, s.created_at DESC, s.id DESC
   LIMIT 1;
  IF v_decision IS DISTINCT FROM 'rejected' THEN
    RETURN jsonb_build_object('error', 'not_rejected');
  END IF;
  -- One customer switch per rejection: a customer switch audited AFTER the
  -- deciding rejection (its updated_at, else created_at) spends it. Staff
  -- switches never count against her.
  IF EXISTS (
    SELECT 1 FROM public.audit_logs a
     WHERE a.entity_type = 'cash_order' AND a.entity_id = p_order_id
       AND a.action = 'payment_method_changed'
       AND a.new_value_json->>'actor' = 'customer'
       AND a.created_at > v_decided_at
  ) THEN
    RETURN jsonb_build_object('error', 'already_switched');
  END IF;
  IF p_method IS NULL OR p_method NOT IN ('transfer', 'paidy', 'square') THEN
    RETURN jsonb_build_object('error', 'bad_method');
  END IF;
  IF v_old = p_method THEN
    RETURN jsonb_build_object('error', 'unchanged', 'payment_method', v_old);
  END IF;
  IF p_method <> 'transfer' AND v_cur <> 'JPY' THEN
    RETURN jsonb_build_object('error', 'method_requires_yen');
  END IF;
  IF p_method = 'square' AND NOT public.square_card_allowed(p_customer_id) THEN
    RETURN jsonb_build_object('error', 'method_unavailable', 'method', p_method);
  END IF;

  UPDATE public.cash_orders SET payment_method = p_method, updated_at = now() WHERE id = p_order_id;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id)
  VALUES ('cash_order', p_order_id, 'payment_method_changed',
          jsonb_build_object('payment_method', v_old),
          jsonb_build_object('payment_method', p_method, 'actor', 'customer',
                             'customer_id', p_customer_id, 'reference', v_ref),
          NULL);

  RETURN jsonb_build_object('ok', true, 'old_method', v_old, 'payment_method', p_method, 'reference', v_ref,
                            'decision_id', v_decision_id);
END
$function$
;

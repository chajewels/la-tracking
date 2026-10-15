-- Record-only (2026-10-15). Already applied on live — replaying is a no-op.
--
-- Why: 20261217100000 (website coupons) changed these three functions with md5-guarded IN-PLACE
-- patches (pg_temp.cj_patch). The drift audit reads only CREATE FUNCTION statements, so the repo's
-- newest copy of each was the PRE-patch body. This file records the bodies exactly as live runs
-- them after the Lovable apply of 2026-10-15 (md5(pg_get_functiondef) verified on live, below).
--
--   create_web_draft_atomic                       5ef4d83b83e2e5a3d14a8349e27ee798
--   decline_web_draft_atomic                      ef58ffb0fa685bbe52875c73d7501cac
--   materialize_web_draft_atomic                  50eef318ae673f20381b00b4257d8bcb
--
-- GRANTS ARE NOT TOUCHED. CREATE OR REPLACE keeps each function's live ACL.

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
  v_cod_fee   integer := 0;
  v_coupon     jsonb;
  v_coupon_jpy integer := 0;
  v_coupon_val numeric(12,2) := 0;
  v_coupon_code text;
  v_use_id     uuid;
  v_full_sub   integer;
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
  IF nullif(btrim(coalesce(v_quote.coupon_code, '')), '') IS NOT NULL THEN
    PERFORM 1 FROM public.website_coupons c WHERE upper(c.code) = upper(btrim(v_quote.coupon_code)) FOR UPDATE;
    SELECT coalesce(sum((i ->> 'line_total_jpy')::numeric), 0)::integer INTO v_full_sub
      FROM jsonb_array_elements(v_quote.items) i
      JOIN public.website_product_variants pv ON pv.id = (i ->> 'variant_id')::uuid
     WHERE (i ->> 'unit_price_jpy')::numeric = pv.price_jpy;
    v_coupon := public.website_coupon_quote(v_quote.coupon_code, p_customer_id, v_quote.subtotal_jpy, v_full_sub, v_quote.mode);
    IF v_coupon ? 'error' THEN
      RETURN v_coupon;
    END IF;
    v_coupon_jpy  := (v_coupon ->> 'discount_jpy')::integer;
    v_coupon_code := v_coupon ->> 'code';
    IF v_coupon_jpy <> coalesce(v_quote.coupon_discount_jpy, 0) THEN
      RETURN jsonb_build_object('error', 'coupon_changed', 'code', v_coupon_code, 'discount_jpy', v_coupon_jpy);
    END IF;
    IF v_quote.total_jpy - v_coupon_jpy <= 0 THEN
      RETURN jsonb_build_object('error', 'coupon_total_zero', 'code', v_coupon_code);
    END IF;
    v_coupon_val := CASE WHEN v_cur = 'PHP' THEN round(v_coupon_jpy * v_rate) ELSE v_coupon_jpy END;
    v_total    := v_total - v_coupon_val;
    v_subtotal := v_subtotal - v_coupon_val;
  END IF;

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
  IF v_method NOT IN ('transfer', 'paidy', 'square', 'cod') THEN
    RETURN jsonb_build_object('error', 'bad_method');
  END IF;
  IF v_method <> 'transfer' AND v_quote.mode = 'layaway' THEN
    RETURN jsonb_build_object('error', 'method_full_payment_only', 'method', v_method);
  END IF;
  IF v_method <> 'transfer' AND v_cur <> 'JPY' THEN
    RETURN jsonb_build_object('error', 'method_requires_yen', 'method', v_method);
  END IF;
  IF (v_method = 'paidy' AND (public.paidy_mode() = 'off' OR coalesce(v_country, '') <> 'JP'))
     OR (v_method = 'square' AND NOT public.square_card_allowed(p_customer_id))
     OR (v_method = 'cod' AND (public.cod_mode() <> 'on' OR coalesce(v_country, '') <> 'JP')) THEN
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
    IF v_points > coalesce(v_quote.subtotal_jpy, 0) - v_coupon_jpy THEN
      RETURN jsonb_build_object('error', 'points_exceed_subtotal', 'max_points', coalesce(v_quote.subtotal_jpy, 0) - v_coupon_jpy);
    END IF;
    -- 1 pt = ¥1; a peso order converts once at the quote's rate, half-up, as
    -- every other figure on it.
    v_pts_value := CASE WHEN v_cur = 'PHP' THEN round(v_points * v_rate) ELSE v_points END;
    IF v_quote.mode = 'layaway' AND v_pts_value > coalesce(v_deposit, 0) THEN
      RETURN jsonb_build_object('error', 'points_exceed_deposit', 'deposit', v_deposit);
    END IF;
    IF v_quote.mode = 'full' AND v_pts_value > v_subtotal THEN
      RETURN jsonb_build_object('error', 'points_exceed_subtotal', 'max_points', coalesce(v_quote.subtotal_jpy, 0) - v_coupon_jpy);
    END IF;
  END IF;

  -- The number: a layaway's was reserved at quote time (the agreement was
  -- signed against it); a cash order's is drawn now.
  IF v_method = 'cod' THEN
    v_cod_fee := public.cod_fee_jpy(v_total - v_pts_value);
    IF v_cod_fee IS NULL THEN
      RETURN jsonb_build_object('error', CASE WHEN v_total - v_pts_value <= 0 THEN 'cod_nothing_to_collect' ELSE 'over_cod_limit' END,
                                'method', v_method, 'collected', v_total - v_pts_value, 'limit', public.cod_limit_jpy());
    END IF;
  END IF;
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
    v_quote.subtotal_jpy - v_coupon_jpy, v_quote.shipping_jpy, v_quote.total_jpy - v_coupon_jpy, v_subtotal, v_shipping, v_total, v_deposit, v_schedule,
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
  IF v_coupon_jpy > 0 THEN
    INSERT INTO public.website_coupon_uses (coupon_id, customer_id, web_draft_id, status, discount_jpy)
    VALUES ((v_coupon ->> 'coupon_id')::uuid, p_customer_id, v_draft_id, 'held', v_coupon_jpy)
    RETURNING id INTO v_use_id;
  END IF;
  UPDATE public.web_order_drafts
     SET payment_method = v_method, points = v_points, points_value = v_pts_value,
         points_redemption_id = v_red_id,
         cod_fee_jpy = v_cod_fee, cod_fee = v_cod_fee,
         coupon_code = CASE WHEN v_coupon_jpy > 0 THEN v_coupon_code END, coupon_discount_jpy = v_coupon_jpy,
         coupon_discount = v_coupon_val, coupon_use_id = v_use_id,
         total = total + v_cod_fee, total_jpy = total_jpy + v_cod_fee
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
      v_qty, coalesce((v_item ->> 'unit_price_jpy')::numeric, public.website_variant_price_jpy(v_variant)),
      coalesce((v_item ->> 'unit_price_jpy')::numeric, public.website_variant_price_jpy(v_variant)) * v_qty
    );
    v_lines := v_lines + 1;
  END LOOP;

  IF v_lines = 0 THEN
    RAISE EXCEPTION 'empty_quote:';
  END IF;

  UPDATE public.checkout_quotes SET consumed_at = now(), cod_fee_jpy = v_cod_fee WHERE id = v_quote.id;

  RETURN jsonb_build_object(
    'ok', true, 'draft_id', v_draft_id, 'web_reference', v_reference, 'invoice_number', v_seq::text,
    'mode', v_quote.mode, 'currency', v_cur, 'total', v_total + v_cod_fee, 'total_jpy', v_quote.total_jpy - v_coupon_jpy + v_cod_fee,
    'cod_fee', v_cod_fee,
    'shipping_pending', v_shipping IS NULL, 'deposit', v_deposit, 'schedule', v_schedule,
    'term_months', CASE WHEN v_quote.mode = 'layaway' THEN v_quote.term_months END,
    'fx_rate', v_rate, 'awaiting_confirmation', true,
    'payment_method', v_method, 'points', v_points, 'points_value', v_pts_value,
    'coupon_code', CASE WHEN v_coupon_jpy > 0 THEN v_coupon_code END, 'coupon_discount', v_coupon_val,
    'coupon_discount_jpy', v_coupon_jpy);
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
$function$;

-- ---------------------------------------------------------------------------
-- decline_web_draft_atomic
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.decline_web_draft_atomic(p_draft_id uuid, p_reason text, p_user_id uuid DEFAULT NULL::uuid, p_source text DEFAULT 'staff'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_reason    text := nullif(btrim(coalesce(p_reason, '')), '');
  v_is_system boolean := (p_source = 'system');
  v_draft     public.web_order_drafts%ROWTYPE;
  v_restored  integer := 0;
  v_now       timestamptz := now();
  v_points_released integer := 0;
  v_coupon_released integer := 0;
BEGIN
  IF v_reason IS NULL THEN
    RETURN jsonb_build_object('error', 'reason_required');
  END IF;
  IF NOT v_is_system THEN
    IF p_user_id IS NULL THEN
      RETURN jsonb_build_object('error', 'user_identity_required');
    END IF;
    IF NOT public.has_permission(p_user_id, 'confirm_web_order_ready') THEN
      RETURN jsonb_build_object('error', 'permission_denied');
    END IF;
  END IF;

  SELECT * INTO v_draft FROM public.web_order_drafts WHERE id = p_draft_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF v_draft.status <> 'to_confirm' THEN
    RETURN jsonb_build_object('error', 'not_open', 'status', v_draft.status);
  END IF;

  WITH released AS (
    UPDATE public.web_order_draft_lines l
       SET hold_state = 'released', released_at = v_now
     WHERE l.draft_id = p_draft_id AND l.hold_state = 'held'
     RETURNING l.variant_id, l.qty
  ), per_variant AS (
    SELECT variant_id, sum(qty)::integer AS qty FROM released WHERE variant_id IS NOT NULL GROUP BY variant_id
  ), restored AS (
    UPDATE public.website_product_variants v
       SET stock_qty = v.stock_qty + pv.qty, updated_at = v_now
      FROM per_variant pv
     WHERE v.id = pv.variant_id
     RETURNING v.id
  )
  SELECT count(*) INTO v_restored FROM restored;

  -- Points held by this draft go back to the customer (2026-10-05, owner):
  -- the pending redemption is cancelled, nothing was debited.
  UPDATE public.loyalty_redemptions
     SET status = 'cancelled', cancelled_at = v_now, cancelled_by_user_id = p_user_id,
         cancellation_reason = 'Website order ' || coalesce(v_draft.web_reference, '')
                               || ' was not confirmed (' || coalesce(v_reason, 'no reason given') || ') — points kept'
   WHERE web_draft_id = p_draft_id AND status = 'pending';
  GET DIAGNOSTICS v_points_released = ROW_COUNT;
  UPDATE public.website_coupon_uses SET status = 'released', decided_at = v_now
   WHERE web_draft_id = p_draft_id AND status = 'held';
  GET DIAGNOSTICS v_coupon_released = ROW_COUNT;

  UPDATE public.web_order_drafts
     SET status = CASE WHEN v_is_system THEN 'expired' ELSE 'declined' END,
         decided_at = v_now, decided_by = p_user_id, decline_reason = v_reason, updated_at = v_now
   WHERE id = p_draft_id;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id)
  VALUES ('web_order_draft', p_draft_id,
          CASE WHEN v_is_system THEN 'web_draft_expired' ELSE 'web_draft_declined' END,
          jsonb_build_object('web_reference', v_draft.web_reference, 'invoice_number', v_draft.invoice_seq::text,
                             'mode', v_draft.mode, 'reason', v_reason, 'stock_variants_restored', v_restored,
                              'points_redemptions_released', v_points_released,
                             'coupon_uses_released', v_coupon_released,
                             'source', p_source),
          p_user_id);

  RETURN jsonb_build_object('ok', true, 'draft_id', p_draft_id, 'status',
                            CASE WHEN v_is_system THEN 'expired' ELSE 'declined' END,
                            'web_reference', v_draft.web_reference, 'invoice_number', v_draft.invoice_seq::text,
                            'mode', v_draft.mode, 'customer_id', v_draft.customer_id,
                            'customer_lang', v_draft.customer_lang, 'stock_variants_restored', v_restored,
                            'points_redemptions_released', v_points_released);
END
$function$;

-- ---------------------------------------------------------------------------
-- materialize_web_draft_atomic
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.materialize_web_draft_atomic(p_draft_id uuid, p_user_id uuid, p_order jsonb, p_schedule jsonb DEFAULT NULL::jsonb, p_service_lines jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_draft     public.web_order_drafts%ROWTYPE;
  v_now       timestamptz := now();
  v_total     numeric(12,2);
  v_shipping  numeric(12,2);
  v_discount  numeric(12,2);
  v_due       timestamptz;
  v_date      date;
  v_loyalty   numeric;
  v_courier   uuid;
  v_notes     text;
  v_trade     boolean;
  v_dp        numeric(12,2);
  v_term      integer;
  v_end       date;
  v_sum       numeric(12,2);
  v_rows      integer;
  v_order_id  uuid;
  v_row       jsonb;
  v_n         integer;
  v_lines     integer;
  v_services  integer := 0;
  v_requests  integer := 0;
  v_rate      numeric;
  v_rate_date date;
  v_red       public.loyalty_redemptions%ROWTYPE;
  v_pts_value numeric(12,2) := 0;
  v_invoice   text;
  v_approve   jsonb;
  v_cod       numeric(12,2) := 0;
  v_collect   numeric(12,2);
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'user_identity_required');
  END IF;
  IF NOT public.has_permission(p_user_id, 'confirm_web_order_ready') THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;

  SELECT * INTO v_draft FROM public.web_order_drafts WHERE id = p_draft_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF v_draft.status <> 'to_confirm' THEN
    RETURN jsonb_build_object('error', 'not_open', 'status', v_draft.status);
  END IF;
  IF NOT public.has_permission(p_user_id, CASE WHEN v_draft.mode = 'full' THEN 'create_cash_order' ELSE 'create_account' END) THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;

  SELECT count(*) FILTER (WHERE hold_state = 'held'), count(*) INTO v_lines, v_n
    FROM public.web_order_draft_lines WHERE draft_id = p_draft_id;
  IF v_lines = 0 OR v_lines <> v_n THEN
    RETURN jsonb_build_object('error', 'hold_lost');
  END IF;

  p_order := coalesce(p_order, '{}'::jsonb);
  v_total    := (p_order ->> 'total_amount')::numeric;
  v_shipping := coalesce((p_order ->> 'shipping_fee')::numeric, 0);
  v_discount := coalesce((p_order ->> 'discount_amount')::numeric, 0);
  IF v_discount < coalesce(v_draft.coupon_discount, 0) THEN
    RETURN jsonb_build_object('error', 'discount_below_coupon', 'coupon_discount', v_draft.coupon_discount,
                              'coupon_code', v_draft.coupon_code);
  END IF;
  v_due      := (p_order ->> 'transfer_due_at')::timestamptz;
  v_date     := coalesce((p_order ->> 'order_date')::date, (v_now AT TIME ZONE 'Asia/Manila')::date);
  v_loyalty  := coalesce((p_order ->> 'loyalty_jpy_amount')::numeric, v_draft.subtotal_jpy);
  v_courier  := nullif(p_order ->> 'planned_shipping_method_id', '')::uuid;
  v_notes    := nullif(btrim(coalesce(p_order ->> 'notes', '')), '');
  v_trade    := coalesce((p_order ->> 'is_trade')::boolean, false);
  v_rate      := CASE WHEN v_draft.settlement_currency = 'PHP' THEN v_draft.fx_rate END;
  v_rate_date := CASE WHEN v_draft.settlement_currency = 'PHP' THEN v_draft.fx_rate_date END;

  IF v_total IS NULL OR v_total <= 0 THEN
    RETURN jsonb_build_object('error', 'total_required');
  END IF;
  IF v_shipping < 0 OR v_discount < 0 OR v_loyalty < 0 THEN
    RETURN jsonb_build_object('error', 'negative_amount');
  END IF;
  -- A deadline is moved, never removed (WEB LAYAWAY rule): Confirm starts it.
  IF coalesce(v_draft.payment_method, 'transfer') = 'cod' THEN
    v_due := NULL;
  ELSIF v_due IS NULL THEN
    RETURN jsonb_build_object('error', 'deadline_required');
  END IF;
  IF jsonb_typeof(coalesce(p_service_lines, '[]'::jsonb)) <> 'array' THEN
    RETURN jsonb_build_object('error', 'service_lines_invalid');
  END IF;
  FOR v_row IN SELECT * FROM jsonb_array_elements(coalesce(p_service_lines, '[]'::jsonb)) LOOP
    IF nullif(btrim(coalesce(v_row ->> 'title', '')), '') IS NULL
       OR coalesce((v_row ->> 'quantity')::numeric, 0) <= 0
       OR (v_row ->> 'quantity')::numeric <> trunc((v_row ->> 'quantity')::numeric)
       OR coalesce((v_row ->> 'unit_price_jpy')::numeric, -1) < 0
       OR coalesce((v_row ->> 'line_total_jpy')::numeric, -1) < 0 THEN
      RETURN jsonb_build_object('error', 'service_lines_invalid');
    END IF;
  END LOOP;

  -- POINTS chosen at checkout (2026-10-05, owner C3–C5): the draft's pending
  -- redemption is approved below, in this transaction. Checked first against
  -- the figures staff are confirming, so nothing is written if it cannot apply.
  v_cod := coalesce((p_order ->> 'cod_fee')::numeric, 0);
  IF coalesce(v_draft.payment_method, 'transfer') = 'cod' THEN
    IF v_draft.mode <> 'full' OR v_draft.settlement_currency <> 'JPY' THEN
      RETURN jsonb_build_object('error', 'method_full_payment_only');
    END IF;
    v_collect := v_total - v_cod - coalesce(v_draft.points_value, 0);
    IF public.cod_fee_jpy(v_collect) IS NULL THEN
      RETURN jsonb_build_object('error', CASE WHEN v_collect <= 0 THEN 'cod_nothing_to_collect' ELSE 'over_cod_limit' END,
                                'collected', v_collect, 'limit', public.cod_limit_jpy());
    END IF;
    IF v_cod <> public.cod_fee_jpy(v_collect) THEN
      RETURN jsonb_build_object('error', 'cod_fee_mismatch', 'cod_fee', public.cod_fee_jpy(v_collect), 'sent', v_cod);
    END IF;
  ELSIF v_cod <> 0 THEN
    RETURN jsonb_build_object('error', 'cod_fee_not_cod');
  END IF;
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
    ELSIF v_pts_value > v_total - v_shipping - v_cod THEN
      -- C4: never on shipping.
      RETURN jsonb_build_object('error', 'points_exceed_total', 'points_value', v_pts_value);
    END IF;
  END IF;

  IF v_draft.mode = 'layaway' THEN
    v_dp   := (p_order ->> 'downpayment_amount')::numeric;
    v_term := coalesce((p_order ->> 'payment_plan_months')::integer, v_draft.term_months);
    IF v_term IS DISTINCT FROM v_draft.term_months THEN
      RETURN jsonb_build_object('error', 'term_locked', 'term_months', v_draft.term_months);
    END IF;
    IF v_draft.agreement_version IS NULL OR v_draft.agreement_signed_at IS NULL THEN
      RETURN jsonb_build_object('error', 'agreement_missing');
    END IF;
    IF v_dp IS NULL OR v_dp <= 0 THEN
      RETURN jsonb_build_object('error', 'downpayment_required');
    END IF;
    IF jsonb_typeof(coalesce(p_schedule, 'null'::jsonb)) <> 'array' THEN
      RETURN jsonb_build_object('error', 'schedule_required');
    END IF;
    SELECT count(*), coalesce(sum((s ->> 'amount')::numeric), 0), max((s ->> 'due_date')::date)
      INTO v_rows, v_sum, v_end
      FROM jsonb_array_elements(p_schedule) s;
    IF v_rows <> v_term
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_schedule) s
                   WHERE coalesce((s ->> 'amount')::numeric, 0) <= 0 OR (s ->> 'due_date') IS NULL)
       OR (SELECT count(DISTINCT (s ->> 'installment_number')::integer) FROM jsonb_array_elements(p_schedule) s
            WHERE (s ->> 'installment_number')::integer BETWEEN 1 AND v_term) <> v_term THEN
      RETURN jsonb_build_object('error', 'schedule_invalid');
    END IF;
    IF v_dp + v_sum <> v_total THEN
      RETURN jsonb_build_object('error', 'schedule_mismatch', 'total_amount', v_total,
                                'downpayment', v_dp, 'installments', v_sum);
    END IF;
    v_end := coalesce((p_order ->> 'end_date')::date, v_end);

    INSERT INTO public.layaway_accounts (
      invoice_number, customer_id, currency, total_amount, payment_plan_months,
      order_date, end_date, status, total_paid, remaining_balance,
      downpayment_amount, loyalty_jpy_amount, shipping_fee,
      discount_amount, discount_type, discount_value,
      source_channel, web_reference, quote_id, transfer_due_at, ship_to_snapshot,
      customer_lang, fx_rate_used, fx_rate_date, notes, is_trade,
      agreement_version, agreement_acceptance_date,
      ready_confirmed_at, ready_confirmed_by, created_by_user_id, planned_shipping_method_id, coupon_code
    ) VALUES (
      v_draft.invoice_seq::text, v_draft.customer_id, v_draft.settlement_currency::account_currency, v_total, v_term,
      v_date, v_end, 'active', 0, v_total,
      v_dp, v_loyalty, v_shipping,
      v_discount, nullif(p_order ->> 'discount_type', ''), (p_order ->> 'discount_value')::numeric,
      'web', v_draft.web_reference, v_draft.quote_id, v_due, v_draft.ship_to_snapshot,
      v_draft.customer_lang, v_rate, v_rate_date,
      'Website layaway ' || v_draft.web_reference || coalesce(E'\n' || v_notes, ''), v_trade,
      v_draft.agreement_version, v_draft.agreement_signed_at,
      v_now, p_user_id, p_user_id, v_courier, v_draft.coupon_code
    ) RETURNING id INTO v_order_id;

    FOR v_row IN SELECT * FROM jsonb_array_elements(p_schedule) ORDER BY (value ->> 'installment_number')::integer LOOP
      INSERT INTO public.layaway_schedule (
        account_id, installment_number, due_date, base_installment_amount,
        penalty_amount, total_due_amount, paid_amount, currency, status
      ) VALUES (
        v_order_id, (v_row ->> 'installment_number')::integer, (v_row ->> 'due_date')::date,
        (v_row ->> 'amount')::numeric, 0, (v_row ->> 'amount')::numeric, 0,
        v_draft.settlement_currency::account_currency, 'pending'
      );
    END LOOP;

    INSERT INTO public.layaway_account_items (account_id, website_product_id, variant_id, title, sku, quantity,
                                              unit_price_jpy, line_total_jpy, image_url)
    SELECT v_order_id, l.website_product_id, l.variant_id, l.title, l.sku, l.qty, l.unit_price_jpy, l.line_total_jpy, l.image_url
      FROM public.web_order_draft_lines l WHERE l.draft_id = p_draft_id AND l.hold_state = 'held'
     ORDER BY l.created_at, l.id;

    INSERT INTO public.layaway_account_items (account_id, title, quantity, unit_price_jpy, line_total_jpy)
    SELECT v_order_id, btrim(s ->> 'title'), (s ->> 'quantity')::integer,
           (s ->> 'unit_price_jpy')::numeric, (s ->> 'line_total_jpy')::numeric
      FROM jsonb_array_elements(coalesce(p_service_lines, '[]'::jsonb)) s;
    GET DIAGNOSTICS v_services = ROW_COUNT;
  ELSE
    INSERT INTO public.cash_orders (
      invoice_number, customer_id, currency, total_amount, total_paid,
      remaining_balance, status, source_channel, order_type, payment_method,
      payment_status, ship_to_address_id, ship_to_snapshot, recipient_name, recipient_phone,
      gift_note, quote_id, web_reference, transfer_due_at, expires_at, shipping_fee,
      discount_amount, discount_type, discount_value,
      loyalty_jpy_amount, item_description, order_date, customer_lang, notes, is_trade,
      ready_confirmed_at, ready_confirmed_by, created_by_user_id, fx_rate_used, fx_rate_date,
      planned_shipping_method_id, cod_fee, coupon_code
    ) VALUES (
      v_draft.invoice_seq::text, v_draft.customer_id, v_draft.settlement_currency::account_currency, v_total, 0,
      v_total, 'pending'::cash_order_status, 'web', v_draft.order_type, coalesce(v_draft.payment_method, 'transfer'),
      'pending_transfer', v_draft.ship_to_address_id, v_draft.ship_to_snapshot, v_draft.recipient_name, v_draft.recipient_phone,
      -- expires_at = transfer_due_at: the deadline the expiry cron reads.
      v_draft.gift_note, v_draft.quote_id, v_draft.web_reference, v_due, v_due, v_shipping,
      v_discount, nullif(p_order ->> 'discount_type', ''), (p_order ->> 'discount_value')::numeric,
      v_loyalty, 'Website order ' || v_draft.web_reference, v_date, v_draft.customer_lang, v_notes, v_trade,
      v_now, p_user_id, p_user_id, v_rate, v_rate_date,
      v_courier, v_cod, v_draft.coupon_code
    ) RETURNING id INTO v_order_id;

    INSERT INTO public.cash_order_items (cash_order_id, website_product_id, variant_id, title, sku, quantity,
                                         unit_price_jpy, line_total_jpy, image_url)
    SELECT v_order_id, l.website_product_id, l.variant_id, l.title, l.sku, l.qty, l.unit_price_jpy, l.line_total_jpy, l.image_url
      FROM public.web_order_draft_lines l WHERE l.draft_id = p_draft_id AND l.hold_state = 'held'
     ORDER BY l.created_at, l.id;

    INSERT INTO public.cash_order_items (cash_order_id, title, quantity, unit_price_jpy, line_total_jpy)
    SELECT v_order_id, btrim(s ->> 'title'), (s ->> 'quantity')::integer,
           (s ->> 'unit_price_jpy')::numeric, (s ->> 'line_total_jpy')::numeric
      FROM jsonb_array_elements(coalesce(p_service_lines, '[]'::jsonb)) s;
    GET DIAGNOSTICS v_services = ROW_COUNT;
  END IF;

  -- The checkout's points, approved now (owner C5): the redemption is linked
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
  -- page365_web_holds counts the order line instead of the draft line.
  UPDATE public.web_order_draft_lines
     SET hold_state = 'transferred', transferred_at = v_now
   WHERE draft_id = p_draft_id AND hold_state = 'held';

  UPDATE public.web_order_drafts
     SET status = 'confirmed', decided_at = v_now, decided_by = p_user_id, updated_at = v_now,
         cash_order_id      = CASE WHEN v_draft.mode = 'full'    THEN v_order_id END,
         layaway_account_id = CASE WHEN v_draft.mode = 'layaway' THEN v_order_id END
   WHERE id = p_draft_id;
  IF v_draft.coupon_use_id IS NOT NULL THEN
    UPDATE public.website_coupon_uses SET status = 'used', decided_at = v_now
     WHERE id = v_draft.coupon_use_id AND status = 'held';
  END IF;

  -- A service request filed on the draft now belongs to the order (W2-5).
  UPDATE public.service_requests
     SET cash_order_id      = CASE WHEN v_draft.mode = 'full'    THEN v_order_id ELSE cash_order_id END,
         layaway_account_id = CASE WHEN v_draft.mode = 'layaway' THEN v_order_id ELSE layaway_account_id END,
         updated_at = v_now
   WHERE web_draft_id = p_draft_id;
  GET DIAGNOSTICS v_requests = ROW_COUNT;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id)
  VALUES ('web_order_draft', p_draft_id, 'web_draft_confirmed',
          jsonb_build_object('web_reference', v_draft.web_reference, 'invoice_number', v_draft.invoice_seq::text,
                             'mode', v_draft.mode,
                             'entity_type', CASE WHEN v_draft.mode = 'full' THEN 'cash_order' ELSE 'layaway_account' END,
                             'entity_id', v_order_id, 'currency', v_draft.settlement_currency,
                             'quoted_total', v_draft.total, 'total_amount', v_total,
                             'shipping_fee', v_shipping, 'discount_amount', v_discount,
                             'service_lines', v_services, 'service_requests_moved', v_requests,
                             'transfer_due_at', v_due, 'planned_shipping_method_id', v_courier,
                             'payment_method', v_draft.payment_method, 'points', v_draft.points,
                             'points_value', v_pts_value, 'cod_fee', v_cod,
                             'coupon_code', v_draft.coupon_code, 'coupon_discount', v_draft.coupon_discount),
          p_user_id);

  RETURN jsonb_build_object('ok', true, 'draft_id', p_draft_id,
                            'entity_type', CASE WHEN v_draft.mode = 'full' THEN 'cash_order' ELSE 'layaway_account' END,
                            'entity_id', v_order_id,
                            'order_id',   CASE WHEN v_draft.mode = 'full'    THEN v_order_id END,
                            'account_id', CASE WHEN v_draft.mode = 'layaway' THEN v_order_id END,
                            'invoice_number', v_draft.invoice_seq::text, 'web_reference', v_draft.web_reference,
                            'service_lines', v_services, 'service_requests_moved', v_requests,
                            'payment_method', v_draft.payment_method, 'points', v_draft.points,
                            'points_value', v_pts_value, 'points_approval', v_approve,
                            'cod_fee', v_cod);
END
$function$;

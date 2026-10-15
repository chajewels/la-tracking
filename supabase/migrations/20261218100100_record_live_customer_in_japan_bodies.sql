-- Record-only (2026-10-15). Already applied on live — replaying is a no-op.
--
-- Why: 20261218100000 (customer_in_japan + certificate kind) changed these three functions with
-- md5-guarded IN-PLACE patches (pg_temp.cj_patch). The drift audit reads only CREATE FUNCTION
-- statements, so the repo's newest copy of each was the PRE-patch body. This file records the
-- bodies exactly as live runs them after the owner's apply of 2026-10-15 ~22:40 JST
-- (md5(pg_get_functiondef) read on live, below). Each body is the last recorded one
-- (20261217100100 / 20261203100000, md5 = the pre-patch md5 in 20261218100000) plus that
-- migration's edits, and was checked to hash to the live md5 before this file was written.
--
--   create_web_draft_atomic                       940c56fef07b7737335d6e26b36a3d0b
--   change_web_payment_method_atomic              4e51902593c6aa27dc5fb668fa155644
--   switch_web_payment_method_by_customer_atomic  dd8d9acca15f254d4220f0db9df7bedc
--   customer_in_japan (created in full by 20261218100000; checked only)
--                                                 ddb0273bccf58b759a825b89ec17aa38
--
-- GUARDS: before each replace, a DO block reads md5(pg_get_functiondef) on the database. Equal
-- to the live md5 → it says so and the replace writes the identical body (a no-op). Anything
-- else → STOP, nothing changed. After each replace the md5 is checked again, so a body that
-- does not reproduce live exactly rolls the migration back.
--
-- GRANTS ARE NOT TOUCHED. The replace keeps each function's live ACL (service role only).

-- ---------------------------------------------------------------------------
-- create_web_draft_atomic
-- ---------------------------------------------------------------------------
DO $guard$
DECLARE
  v_fn regprocedure := to_regprocedure('public.create_web_draft_atomic(uuid,uuid,text,text,timestamp with time zone)');
  v_md5 text;
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'STOP — public.create_web_draft_atomic(uuid,uuid,text,text,timestamp with time zone) is not on live; apply 20261218100000 first. Nothing changed.';
  END IF;
  v_md5 := md5(pg_get_functiondef(v_fn));
  IF v_md5 <> '940c56fef07b7737335d6e26b36a3d0b' THEN
    RAISE EXCEPTION 'STOP — public.create_web_draft_atomic(uuid,uuid,text,text,timestamp with time zone) has md5 %, expected 940c56fef07b7737335d6e26b36a3d0b; re-read live before recording. Nothing changed.', v_md5;
  END IF;
  RAISE NOTICE 'public.create_web_draft_atomic(uuid,uuid,text,text,timestamp with time zone) matches live — the replace below rewrites the identical body';
END
$guard$;

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
  IF (v_method = 'paidy' AND (public.paidy_mode() = 'off' OR coalesce(v_country, '') <> 'JP' OR NOT public.customer_in_japan(p_customer_id)))
     OR (v_method = 'square' AND NOT public.square_card_allowed(p_customer_id))
     OR (v_method = 'cod' AND (public.cod_mode() <> 'on' OR coalesce(v_country, '') <> 'JP' OR NOT public.customer_in_japan(p_customer_id))) THEN
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

DO $guard$
DECLARE
  v_fn regprocedure := to_regprocedure('public.create_web_draft_atomic(uuid,uuid,text,text,timestamp with time zone)');
  v_md5 text;
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'STOP — public.create_web_draft_atomic(uuid,uuid,text,text,timestamp with time zone) is not on live; apply 20261218100000 first. Nothing changed.';
  END IF;
  v_md5 := md5(pg_get_functiondef(v_fn));
  IF v_md5 <> '940c56fef07b7737335d6e26b36a3d0b' THEN
    RAISE EXCEPTION 'STOP — public.create_web_draft_atomic(uuid,uuid,text,text,timestamp with time zone) has md5 % after the replace, expected 940c56fef07b7737335d6e26b36a3d0b; the recorded body does not reproduce live — rolled back.', v_md5;
  END IF;
  RAISE NOTICE 'public.create_web_draft_atomic(uuid,uuid,text,text,timestamp with time zone) recorded body verified';
END
$guard$;

-- ---------------------------------------------------------------------------
-- change_web_payment_method_atomic
-- ---------------------------------------------------------------------------
DO $guard$
DECLARE
  v_fn regprocedure := to_regprocedure('public.change_web_payment_method_atomic(text,uuid,text,text,uuid)');
  v_md5 text;
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'STOP — public.change_web_payment_method_atomic(text,uuid,text,text,uuid) is not on live; apply 20261218100000 first. Nothing changed.';
  END IF;
  v_md5 := md5(pg_get_functiondef(v_fn));
  IF v_md5 <> '4e51902593c6aa27dc5fb668fa155644' THEN
    RAISE EXCEPTION 'STOP — public.change_web_payment_method_atomic(text,uuid,text,text,uuid) has md5 %, expected 4e51902593c6aa27dc5fb668fa155644; re-read live before recording. Nothing changed.', v_md5;
  END IF;
  RAISE NOTICE 'public.change_web_payment_method_atomic(text,uuid,text,text,uuid) matches live — the replace below rewrites the identical body';
END
$guard$;

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
  v_base   numeric(12,2);
  v_old_fee numeric(12,2) := 0;
  v_new_fee integer := 0;
  v_dl     jsonb;
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
  IF p_method IS NULL OR p_method NOT IN ('transfer', 'paidy', 'square', 'cod') THEN
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
  IF (p_method = 'paidy' AND (public.paidy_mode() = 'off' OR coalesce(v_country, '') <> 'JP' OR NOT public.customer_in_japan(v_cust)))
     OR (p_method = 'square' AND NOT public.square_card_allowed(v_cust))
     OR (p_method = 'cod' AND (public.cod_mode() <> 'on' OR coalesce(v_country, '') <> 'JP' OR NOT public.customer_in_japan(v_cust))) THEN
    RETURN jsonb_build_object('error', 'method_unavailable', 'method', p_method);
  END IF;

  IF p_entity_type = 'draft' THEN
    SELECT total - coalesce(cod_fee, 0) - coalesce(points_value, 0), coalesce(cod_fee, 0)
      INTO v_base, v_old_fee FROM public.web_order_drafts WHERE id = p_entity_id;
  ELSE
    SELECT remaining_balance - coalesce(cod_fee, 0), coalesce(cod_fee, 0)
      INTO v_base, v_old_fee FROM public.cash_orders WHERE id = p_entity_id;
  END IF;
  IF p_method = 'cod' THEN
    v_new_fee := public.cod_fee_jpy(v_base);
    IF v_new_fee IS NULL THEN
      RETURN jsonb_build_object('error', CASE WHEN v_base <= 0 THEN 'cod_nothing_to_collect' ELSE 'over_cod_limit' END,
                                'method', p_method, 'collected', v_base, 'limit', public.cod_limit_jpy());
    END IF;
  END IF;
  IF p_entity_type = 'draft' THEN
    UPDATE public.web_order_drafts
       SET payment_method = p_method, cod_fee_jpy = v_new_fee, cod_fee = v_new_fee,
           total = total - v_old_fee + v_new_fee, total_jpy = total_jpy - v_old_fee::integer + v_new_fee,
           updated_at = now()
     WHERE id = p_entity_id;
  ELSE
    UPDATE public.cash_orders
       SET payment_method = p_method, cod_fee = v_new_fee,
           total_amount = total_amount - v_old_fee + v_new_fee,
           remaining_balance = remaining_balance - v_old_fee + v_new_fee,
           transfer_due_at = CASE WHEN p_method = 'cod' THEN NULL ELSE transfer_due_at END,
           expires_at = CASE WHEN p_method = 'cod' THEN NULL ELSE expires_at END,
           updated_at = now()
     WHERE id = p_entity_id;
    IF v_old = 'cod' AND p_method <> 'cod' AND v_ready IS NOT NULL THEN
      v_dl := public.set_account_deadlines('cash_order', p_entity_id,
                now() + make_interval(hours => public.web_deposit_deadline_hours(v_cust, p_entity_id)),
                'Payment method changed from cash on delivery: ' || v_reason, p_user_id);
      IF v_dl ? 'error' THEN
        RAISE EXCEPTION 'deadline_not_set: %', v_dl ->> 'error';
      END IF;
    END IF;
  END IF;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id)
  VALUES (CASE WHEN p_entity_type = 'draft' THEN 'web_order_draft' ELSE 'cash_order' END, p_entity_id,
          'payment_method_changed',
          jsonb_build_object('payment_method', v_old),
          jsonb_build_object('payment_method', p_method, 'reason', v_reason, 'reference', v_ref,
                             'cod_fee', v_new_fee, 'old_cod_fee', v_old_fee::integer),
          p_user_id);

  RETURN jsonb_build_object('ok', true, 'entity_type', p_entity_type, 'entity_id', p_entity_id,
                            'old_method', v_old, 'payment_method', p_method, 'reference', v_ref,
                            'cod_fee', v_new_fee, 'old_cod_fee', v_old_fee::integer, 'fee_delta', v_new_fee - v_old_fee::integer,
                            'transfer_due_at', v_dl -> 'new' ->> 'transfer_due_at');
END
$function$;

DO $guard$
DECLARE
  v_fn regprocedure := to_regprocedure('public.change_web_payment_method_atomic(text,uuid,text,text,uuid)');
  v_md5 text;
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'STOP — public.change_web_payment_method_atomic(text,uuid,text,text,uuid) is not on live; apply 20261218100000 first. Nothing changed.';
  END IF;
  v_md5 := md5(pg_get_functiondef(v_fn));
  IF v_md5 <> '4e51902593c6aa27dc5fb668fa155644' THEN
    RAISE EXCEPTION 'STOP — public.change_web_payment_method_atomic(text,uuid,text,text,uuid) has md5 % after the replace, expected 4e51902593c6aa27dc5fb668fa155644; the recorded body does not reproduce live — rolled back.', v_md5;
  END IF;
  RAISE NOTICE 'public.change_web_payment_method_atomic(text,uuid,text,text,uuid) recorded body verified';
END
$guard$;

-- ---------------------------------------------------------------------------
-- switch_web_payment_method_by_customer_atomic
-- ---------------------------------------------------------------------------
DO $guard$
DECLARE
  v_fn regprocedure := to_regprocedure('public.switch_web_payment_method_by_customer_atomic(uuid,uuid,text)');
  v_md5 text;
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'STOP — public.switch_web_payment_method_by_customer_atomic(uuid,uuid,text) is not on live; apply 20261218100000 first. Nothing changed.';
  END IF;
  v_md5 := md5(pg_get_functiondef(v_fn));
  IF v_md5 <> 'dd8d9acca15f254d4220f0db9df7bedc' THEN
    RAISE EXCEPTION 'STOP — public.switch_web_payment_method_by_customer_atomic(uuid,uuid,text) has md5 %, expected dd8d9acca15f254d4220f0db9df7bedc; re-read live before recording. Nothing changed.', v_md5;
  END IF;
  RAISE NOTICE 'public.switch_web_payment_method_by_customer_atomic(uuid,uuid,text) matches live — the replace below rewrites the identical body';
END
$guard$;

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
  v_base     numeric(12,2);
  v_old_fee  numeric(12,2) := 0;
  v_new_fee  integer := 0;
  v_country  text;
  v_dl       jsonb;
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
  IF p_method IS NULL OR p_method NOT IN ('transfer', 'paidy', 'square', 'cod') THEN
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

  SELECT remaining_balance - coalesce(cod_fee, 0), coalesce(cod_fee, 0),
         upper(nullif(btrim(coalesce(ship_to_snapshot ->> 'country', '')), ''))
    INTO v_base, v_old_fee, v_country FROM public.cash_orders WHERE id = p_order_id;
  IF p_method = 'paidy' AND NOT public.customer_in_japan(p_customer_id) THEN
    RETURN jsonb_build_object('error', 'method_unavailable', 'method', p_method);
  END IF;
  IF p_method = 'cod' THEN
    IF public.cod_mode() <> 'on' OR coalesce(v_country, '') <> 'JP' OR NOT public.customer_in_japan(p_customer_id) THEN
      RETURN jsonb_build_object('error', 'method_unavailable', 'method', p_method);
    END IF;
    v_new_fee := public.cod_fee_jpy(v_base);
    IF v_new_fee IS NULL THEN
      RETURN jsonb_build_object('error', CASE WHEN v_base <= 0 THEN 'cod_nothing_to_collect' ELSE 'over_cod_limit' END,
                                'method', p_method);
    END IF;
  END IF;
  UPDATE public.cash_orders
     SET payment_method = p_method, cod_fee = v_new_fee,
         total_amount = total_amount - v_old_fee + v_new_fee,
         remaining_balance = remaining_balance - v_old_fee + v_new_fee,
         transfer_due_at = CASE WHEN p_method = 'cod' THEN NULL ELSE transfer_due_at END,
         expires_at = CASE WHEN p_method = 'cod' THEN NULL ELSE expires_at END,
         updated_at = now()
   WHERE id = p_order_id;
  IF v_old = 'cod' AND p_method <> 'cod' THEN
    v_dl := public.set_account_deadlines('cash_order', p_order_id,
              now() + make_interval(hours => public.web_deposit_deadline_hours(p_customer_id, p_order_id)),
              'Customer switched from cash on delivery after a rejected payment', NULL);
    IF v_dl ? 'error' THEN
      RAISE EXCEPTION 'deadline_not_set: %', v_dl ->> 'error';
    END IF;
  END IF;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id)
  VALUES ('cash_order', p_order_id, 'payment_method_changed',
          jsonb_build_object('payment_method', v_old),
          jsonb_build_object('payment_method', p_method, 'actor', 'customer',
                             'customer_id', p_customer_id, 'reference', v_ref,
                             'cod_fee', v_new_fee, 'old_cod_fee', v_old_fee::integer),
          NULL);

  RETURN jsonb_build_object('ok', true, 'old_method', v_old, 'payment_method', p_method, 'reference', v_ref,
                            'decision_id', v_decision_id, 'cod_fee', v_new_fee, 'old_cod_fee', v_old_fee::integer);
END
$function$;

DO $guard$
DECLARE
  v_fn regprocedure := to_regprocedure('public.switch_web_payment_method_by_customer_atomic(uuid,uuid,text)');
  v_md5 text;
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'STOP — public.switch_web_payment_method_by_customer_atomic(uuid,uuid,text) is not on live; apply 20261218100000 first. Nothing changed.';
  END IF;
  v_md5 := md5(pg_get_functiondef(v_fn));
  IF v_md5 <> 'dd8d9acca15f254d4220f0db9df7bedc' THEN
    RAISE EXCEPTION 'STOP — public.switch_web_payment_method_by_customer_atomic(uuid,uuid,text) has md5 % after the replace, expected dd8d9acca15f254d4220f0db9df7bedc; the recorded body does not reproduce live — rolled back.', v_md5;
  END IF;
  RAISE NOTICE 'public.switch_web_payment_method_by_customer_atomic(uuid,uuid,text) recorded body verified';
END
$guard$;

-- ---------------------------------------------------------------------------
-- customer_in_japan: created whole by 20261218100000, so it is already on record. Checked only.
-- ---------------------------------------------------------------------------
DO $guard$
DECLARE
  v_fn regprocedure := to_regprocedure('public.customer_in_japan(uuid)');
  v_md5 text;
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'STOP — public.customer_in_japan(uuid) is not on live; apply 20261218100000 first. Nothing changed.';
  END IF;
  v_md5 := md5(pg_get_functiondef(v_fn));
  IF v_md5 <> 'ddb0273bccf58b759a825b89ec17aa38' THEN
    RAISE EXCEPTION 'STOP — public.customer_in_japan(uuid) has md5 %, expected ddb0273bccf58b759a825b89ec17aa38; re-read live before recording. Nothing changed.', v_md5;
  END IF;
  RAISE NOTICE 'public.customer_in_japan(uuid) recorded body verified';
END
$guard$;

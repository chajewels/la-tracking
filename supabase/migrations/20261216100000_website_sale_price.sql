-- Website sale price (owner decisions 2026-10-15).
--
-- Staff set an optional per-variant sale price in Hub -> Website -> Edit product.
-- price_jpy stays the FULL price of record (Page365's hub_price_jpy, the
-- publish guard and every import still read it). The price the CUSTOMER pays is
-- decided in exactly one place, website_variant_price_jpy(), mirrored in TS by
-- effectivePriceJpy() (supabase/functions/_shared/website-down-payments.ts).
-- The website function sends that effective price AS price_jpy, plus
-- full_price_jpy and on_sale; down payments, pesos, checkout, points, cart
-- reminders and the newsletter all follow it. No sale end date in v1.
--
-- FUNCTION CHANGES START FROM LIVE: the two bodies below are the latest repo
-- copies (create_web_draft_atomic: 20261203100000_record_live_l2l8_cod_bodies.sql;
-- cart_reminder_candidates: 20261021100000_cart_reminders.sql), which were
-- checked against live on 2026-10-15 and matched. ONLY the price fallback lines
-- change; CREATE OR REPLACE keeps their existing grants (service role only).
-- Not touched: materialize_web_draft_atomic (copies the draft's unit price),
-- the Page365 functions, the publish guard. trg_website_variants_revalidate
-- already fires on any UPDATE of a variant, so a sale change revalidates.

-- 1. The column and its rule: a sale is always below the full price ----------
ALTER TABLE public.website_product_variants
  ADD COLUMN IF NOT EXISTS sale_price_jpy integer NULL;

ALTER TABLE public.website_product_variants
  ADD CONSTRAINT website_variants_sale_below_price
  CHECK (sale_price_jpy IS NULL OR (sale_price_jpy > 0 AND sale_price_jpy < price_jpy));

COMMENT ON COLUMN public.website_product_variants.sale_price_jpy IS
  'Optional sale price in whole yen, always below price_jpy (the full price). NULL = not on sale. The customer price is website_variant_price_jpy().';

-- 2. The single place the effective customer price is decided ---------------
CREATE OR REPLACE FUNCTION public.website_variant_price_jpy(v public.website_product_variants)
RETURNS integer
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT CASE WHEN v.sale_price_jpy IS NOT NULL AND v.sale_price_jpy < v.price_jpy
              THEN v.sale_price_jpy ELSE v.price_jpy END
$$;

COMMENT ON FUNCTION public.website_variant_price_jpy(public.website_product_variants) IS
  'The single place the effective customer price is decided: the sale price while set and below the full price, else price_jpy. TS mirror: effectivePriceJpy() in _shared/website-down-payments.ts.';

-- The default ACL grants PUBLIC (CLAUDE.md 2026-09-24); this pure function is
-- read by the service-role RPCs below and needs no anon access.
REVOKE ALL ON FUNCTION public.website_variant_price_jpy(public.website_product_variants) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.website_variant_price_jpy(public.website_product_variants) TO authenticated, service_role;

-- 3. cart_reminder_candidates: the email shows the effective price ------------
--    Body copied from 20261021100000_cart_reminders.sql; only change:
--    'price_jpy', v.price_jpy  ->  'price_jpy', public.website_variant_price_jpy(v)
CREATE OR REPLACE FUNCTION public.cart_reminder_candidates(p_limit integer DEFAULT 50)
RETURNS TABLE (customer_id uuid, email text, lang text, cycle_id uuid, unsubscribe_token uuid, items jsonb,
               quote_mode text, quote_currency text, quote_term integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_mode text := coalesce((SELECT value #>> '{}' FROM system_settings WHERE key = 'cart_reminders_mode'), 'off');
  v_raw  text := (SELECT value #>> '{}' FROM system_settings WHERE key = 'cart_reminder_idle_minutes');
  v_idle interval := make_interval(mins => greatest(5, CASE WHEN v_raw ~ '^[0-9]{1,6}$' THEN v_raw::int ELSE 1440 END));
BEGIN
  IF v_mode NOT IN ('owner_only','on') THEN RETURN; END IF;
  RETURN QUERY
  WITH base AS (
    SELECT k.customer_id, btrim(cu.email) AS email, k.lang, k.cycle_id, k.cycle_started_at, k.updated_at, c.unsubscribe_token,
           CASE WHEN cu.location ILIKE '%philippines%' THEN 'Asia/Manila' ELSE 'Asia/Tokyo' END AS tz,
           (lower(btrim(cu.email)) = 'chajewelsjapan@gmail.com' OR lower(btrim(cu.email)) LIKE '%@chajewelsjp.com') AS owner_addr,
           cu.is_test
      FROM customer_carts k
      JOIN customers cu ON cu.id = k.customer_id
      JOIN customer_email_consents c ON c.customer_id = k.customer_id AND c.kind = 'cart_reminder' AND c.opted_in
     WHERE cu.email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
       AND k.updated_at <= now() - v_idle
       AND k.updated_at >= now() - interval '7 days'
       AND NOT EXISTS (SELECT 1 FROM suppressed_emails s WHERE lower(s.email) = lower(btrim(cu.email)))
       AND NOT EXISTS (SELECT 1 FROM cart_reminder_sends s WHERE s.cycle_id = k.cycle_id)
       AND NOT EXISTS (SELECT 1 FROM cart_reminder_sends s WHERE s.customer_id = k.customer_id AND s.claimed_at > now() - interval '7 days')
       AND NOT EXISTS (SELECT 1 FROM cash_orders o WHERE o.customer_id = k.customer_id AND o.created_at >= k.updated_at)
       AND NOT EXISTS (SELECT 1 FROM layaway_accounts a WHERE a.customer_id = k.customer_id AND a.created_at >= k.updated_at)
  ), eligible AS (
    SELECT * FROM base b
     WHERE (CASE WHEN v_mode = 'owner_only' THEN b.owner_addr ELSE (NOT b.is_test OR b.owner_addr) END)
       AND extract(hour FROM now() AT TIME ZONE b.tz) BETWEEN 9 AND 19
  )
  SELECT e.customer_id, e.email, e.lang, e.cycle_id, e.unsubscribe_token, it.items,
         q.mode, q.settlement_currency, q.term_months
    FROM eligible e
    CROSS JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
               'variant_id', v.id, 'product_id', p.id, 'slug', p.slug,
               'name', p.name, 'name_ja', nullif(btrim(p.name_ja), ''),
               'size', v.size, 'stone', v.stone,
               'qty', least(l.qty, v.stock_qty), 'price_jpy', public.website_variant_price_jpy(v),
               'image_url', (SELECT m.url FROM website_product_media m WHERE m.variant_id = v.id ORDER BY m.sort LIMIT 1)
             ) ORDER BY l.added_at) AS items
        FROM customer_cart_lines l
        JOIN website_product_variants v ON v.id = l.variant_id
        JOIN website_products p ON p.id = v.product_id
       WHERE l.customer_id = e.customer_id AND p.status = 'active' AND v.stock_qty >= 1
    ) it
    -- Stage B: her latest checkout for THIS cart cycle, even if the quote has
    -- expired (her choices stand). NULLs = stage A. A consumed quote means an
    -- order exists, which the base filter has already excluded.
    LEFT JOIN LATERAL (
      SELECT cq.mode, cq.settlement_currency, cq.term_months
        FROM checkout_quotes cq
       WHERE cq.customer_id = e.customer_id
         AND cq.created_at >= e.cycle_started_at
         AND cq.consumed_at IS NULL
       ORDER BY cq.created_at DESC
       LIMIT 1
    ) q ON true
   WHERE it.items IS NOT NULL
   ORDER BY e.updated_at
   LIMIT greatest(1, least(coalesce(p_limit, 50), 200));
END $$;

-- 4. create_web_draft_atomic: the fallback price is the effective price -------
--    Body copied from 20261203100000_record_live_l2l8_cod_bodies.sql; only
--    change: the two coalesce(... v_variant.price_jpy) fallbacks. The quote's
--    unit_price_jpy (already the effective price) still wins.
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
         points_redemption_id = v_red_id,
         cod_fee_jpy = v_cod_fee, cod_fee = v_cod_fee,
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
    'mode', v_quote.mode, 'currency', v_cur, 'total', v_total + v_cod_fee, 'total_jpy', v_quote.total_jpy + v_cod_fee,
    'cod_fee', v_cod_fee,
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
$function$;

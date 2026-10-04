-- Record-only (2026-10-05). Already applied on live — replaying is a no-op.
--
-- Why: 20261104110000_paidy_owner_answers and 20261105100000_web_invoice_numbers_
-- respect_registry changed these six functions with md5-guarded IN-PLACE patches
-- (DO blocks). scripts/function-drift-audit only reads CREATE FUNCTION statements,
-- so the repo's newest copy of each was the PRE-patch body and the audit reported
-- them as a_differs. This file records the post-patch bodies so a rebuild from
-- supabase/migrations/ produces what live runs, and the audit is back to 0.
--
-- How each body was built: the newest repo CREATE of the function, with exactly the
-- in-place patch applied (the nextval() -> next_web_invoice_seq() swap, or the
-- inserted block taken verbatim from the patch migration's c_insert). Each was then
-- checked against live with the audit's own comparator (whitespace-collapsed prosrc,
-- md5 first 12) on 2026-10-05 — all six equal:
--
--   checkout_quotes_reserve_invoice    16d8a525cd33   (base: 20260918120000_reserve_web_layaway_invoice_at_quote.sql)
--   create_web_draft_atomic            2b049052d9e9   (base: 20261018100000_web_order_drafts.sql)
--   create_web_layaway_atomic          9d85c3e791e2   (base: 20260923140000_reserve_first_a1.sql)
--   create_web_order_atomic            a6d6fad027e7   (base: 20260925120000_peso_full_payment.sql)
--   register_invoice_number            2eaf67db5d87   (base: 20260919100000_page365_import.sql)
--   reassign_order_owner_atomic        b01a5d2aa375   (base: 20260924150000_reassign_identity_match.sql)
--
-- GRANTS ARE NOT TOUCHED. CREATE OR REPLACE keeps each function's live ACL.

-- ---------------------------------------------------------------------------
-- checkout_quotes_reserve_invoice (live audit md5 16d8a525cd33)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.checkout_quotes_reserve_invoice()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.mode = 'layaway' AND NEW.reserved_invoice_seq IS NULL THEN
    NEW.reserved_invoice_seq := public.next_web_invoice_seq();
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------
-- create_web_draft_atomic (live audit md5 2b049052d9e9)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_web_draft_atomic(
  p_customer_id         uuid,
  p_quote_id            uuid,
  p_lang                text DEFAULT NULL,
  p_agreement_version   text DEFAULT NULL,
  p_agreement_signed_at timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
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

  -- Hold the pieces: the same guarded decrement as the order writers.
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_quote.items) LOOP
    v_qty := GREATEST(coalesce((v_item ->> 'qty')::int, 1), 1);
    SELECT * INTO v_variant FROM public.website_product_variants WHERE id = (v_item ->> 'variant_id')::uuid;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'variant_missing:%', v_item ->> 'variant_id';
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
      v_qty, v_variant.price_jpy, v_variant.price_jpy * v_qty
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
    'fx_rate', v_rate, 'awaiting_confirmation', true);
EXCEPTION
  WHEN raise_exception THEN
    IF SQLERRM LIKE 'out_of_stock:%' THEN
      RETURN jsonb_build_object('error', 'out_of_stock', 'variant_id', split_part(SQLERRM, ':', 2));
    ELSIF SQLERRM LIKE 'variant_missing:%' THEN
      RETURN jsonb_build_object('error', 'variant_missing', 'variant_id', split_part(SQLERRM, ':', 2));
    ELSIF SQLERRM LIKE 'empty_quote:%' THEN
      RETURN jsonb_build_object('error', 'empty_quote');
    END IF;
    RAISE;
END
$fn$;

-- ---------------------------------------------------------------------------
-- create_web_layaway_atomic (live audit md5 9d85c3e791e2)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_web_layaway_atomic(
  p_customer_id uuid,
  p_quote_id uuid,
  p_lang text DEFAULT NULL::text,
  p_transfer_due_at timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_order_date date DEFAULT NULL::date,
  p_agreement_version text DEFAULT NULL::text,
  p_agreement_signed_at timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_reserve boolean DEFAULT false
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_quote      public.checkout_quotes%ROWTYPE;
  v_item       jsonb;
  v_variant    public.website_product_variants%ROWTYPE;
  v_qty        integer;
  v_updated    integer;
  v_seq        bigint;
  v_invoice    text;
  v_reference  text;
  v_account_id uuid;
  v_lang       text := CASE WHEN p_lang IN ('ja','en') THEN p_lang ELSE NULL END;
  v_cur        text;
  v_rate       numeric;
  v_total      integer;
  v_shipping   integer;
  v_subtotal   integer;
  v_quote_out  jsonb;
  v_term       integer;
  v_deposit    integer;
  v_due        timestamptz;
  v_end_date   date;
  v_title      text;
  v_row        jsonb;
  v_order_date date := COALESCE(p_order_date, CURRENT_DATE);
  -- Blank is the same as absent: an empty string must not become a stored
  -- version nobody can match against the agreement file.
  v_agr_ver    text := nullif(btrim(coalesce(p_agreement_version, '')), '');
BEGIN
  SELECT * INTO v_quote FROM public.checkout_quotes WHERE id = p_quote_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'quote_not_found');
  END IF;
  IF v_quote.customer_id <> p_customer_id THEN
    RETURN jsonb_build_object('error', 'quote_not_found');
  END IF;
  IF v_quote.consumed_at IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'quote_already_used');
  END IF;
  IF v_quote.expires_at <= now() THEN
    RETURN jsonb_build_object('error', 'quote_expired');
  END IF;
  IF v_quote.mode <> 'layaway' THEN
    RETURN jsonb_build_object('error', 'not_a_layaway_quote');
  END IF;
  IF v_quote.shipping_jpy IS NULL THEN
    RETURN jsonb_build_object('error', 'shipping_quote_required');
  END IF;
  IF coalesce(v_quote.total_jpy, 0) <= 0 THEN
    RETURN jsonb_build_object('error', 'empty_quote');
  END IF;

  v_cur := coalesce(v_quote.settlement_currency, 'JPY');
  IF v_cur = 'PHP' THEN
    v_rate := v_quote.fx_rate;
    IF v_rate IS NULL OR v_rate <= 0 THEN
      RETURN jsonb_build_object('error', 'fx_rate_missing');
    END IF;
    v_total    := round(v_quote.total_jpy * v_rate);
    v_shipping := round(coalesce(v_quote.shipping_jpy, 0) * v_rate);
    v_subtotal := v_total - v_shipping;
  ELSE
    v_rate     := NULL;
    v_total    := v_quote.total_jpy;
    v_shipping := coalesce(v_quote.shipping_jpy, 0);
    v_subtotal := v_total - v_shipping;
  END IF;

  v_quote_out := public.layaway_quote(
    v_subtotal, v_quote.term_months, v_cur, v_order_date, v_shipping, 0
  );
  IF NOT coalesce((v_quote_out->>'eligible')::boolean, false)
     OR coalesce((v_quote_out->>'term_downgraded')::boolean, false) THEN
    RETURN jsonb_build_object(
      'error', 'below_plan_minimum',
      'total', v_total,
      'currency', v_cur,
      'requested_term_months', v_quote.term_months,
      'max_term_months', v_quote_out->'max_term_months'
    );
  END IF;
  v_term    := (v_quote_out->>'term_months')::integer;
  v_deposit := (v_quote_out->>'deposit')::integer;

  -- RESERVE-FIRST (A1): a reservation has NO deposit deadline until staff
  -- confirm it ready for dispatch; confirm_web_order_ready_atomic starts the
  -- deadline and re-anchors this schedule to the confirmation date.
  IF p_reserve THEN
    v_due := NULL;
  ELSE
    v_due := coalesce(p_transfer_due_at, now() + make_interval(hours => public.web_deposit_deadline_hours(p_customer_id)));
  END IF;
  SELECT max((s->>'due_date')::date) INTO v_end_date
    FROM jsonb_array_elements(v_quote_out->'schedule') s;

  -- THE NUMBER WAS RESERVED WHEN THE QUOTE WAS CREATED (reserved_invoice_seq,
  -- drawn by trg_checkout_quotes_reserve_invoice) so the agreement could be
  -- signed against the final invoice number before this plan existed. The
  -- coalesce covers quotes created before migration 20260918120000, which
  -- carry NULL and draw here exactly as they always did.
  v_seq       := coalesce(v_quote.reserved_invoice_seq, public.next_web_invoice_seq());
  v_invoice   := v_seq::text;
  v_reference := 'CJ-W-' || lpad(v_seq::text, 6, '0');

  INSERT INTO public.layaway_accounts (
    invoice_number, customer_id, currency, total_amount, payment_plan_months,
    order_date, end_date, status, total_paid, remaining_balance,
    downpayment_amount, loyalty_jpy_amount, shipping_fee,
    source_channel, web_reference, quote_id, transfer_due_at, ship_to_snapshot,
    customer_lang, fx_rate_used, fx_rate_date, notes,
    -- THE AGREEMENT THE CUSTOMER SIGNED. Verified by the storefront against the
    -- signing record before this call; stored as given, never invented here.
    agreement_version, agreement_acceptance_date,
    ready_confirmed_at
  ) VALUES (
    v_invoice, p_customer_id, v_cur::account_currency, v_total, v_term,
    v_order_date, v_end_date, 'active', 0, v_total,
    v_deposit,
    -- LOYALTY BASE: the PRODUCT amount, in YEN, always.
    v_quote.subtotal_jpy,
    v_shipping,
    'web', v_reference, v_quote.id, v_due,
    -- layaway_accounts has no ship_to_address_id: this snapshot, resolved
    -- through the quote, is the only delivery address the plan carries.
    public.address_snapshot(v_quote.ship_to_address_id),
    v_lang, v_rate, v_quote.fx_rate_date,
    'Website layaway ' || v_reference,
    v_agr_ver, p_agreement_signed_at,
    -- NULL = awaiting staff confirmation (reservation); otherwise ready now.
    CASE WHEN p_reserve THEN NULL ELSE now() END
  ) RETURNING id INTO v_account_id;

  FOR v_row IN SELECT * FROM jsonb_array_elements(v_quote_out->'schedule') LOOP
    INSERT INTO public.layaway_schedule (
      account_id, installment_number, due_date, base_installment_amount,
      penalty_amount, total_due_amount, paid_amount, currency, status
    ) VALUES (
      v_account_id,
      (v_row->>'installment_number')::integer,
      (v_row->>'due_date')::date,
      (v_row->>'amount')::numeric,
      0,
      (v_row->>'amount')::numeric,
      0,
      v_cur::account_currency,
      'pending'
    );
  END LOOP;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_quote.items) LOOP
    v_qty := GREATEST(COALESCE((v_item->>'qty')::int, 1), 1);

    SELECT * INTO v_variant FROM public.website_product_variants
      WHERE id = (v_item->>'variant_id')::uuid;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'variant_missing:%', v_item->>'variant_id';
    END IF;

    UPDATE public.website_product_variants
       SET stock_qty = stock_qty - v_qty, updated_at = now()
     WHERE id = v_variant.id AND stock_qty >= v_qty;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated = 0 THEN
      RAISE EXCEPTION 'out_of_stock:%', v_variant.id;
    END IF;

    SELECT trim(both ' ' FROM
             p.name ||
             COALESCE(' / ' || NULLIF(v_variant.size, ''), '') ||
             COALESCE(' / ' || NULLIF(v_variant.stone, ''), ''))
      INTO v_title
      FROM public.website_products p WHERE p.id = v_variant.product_id;

    INSERT INTO public.layaway_account_items (
      account_id, website_product_id, variant_id, title, sku, quantity,
      unit_price_jpy, line_total_jpy
    ) VALUES (
      v_account_id, v_variant.product_id, v_variant.id,
      COALESCE(v_title, 'Item'),
      (SELECT p.sku FROM public.website_products p WHERE p.id = v_variant.product_id),
      v_qty,
      v_variant.price_jpy, v_variant.price_jpy * v_qty
    );
  END LOOP;

  UPDATE public.checkout_quotes SET consumed_at = now() WHERE id = v_quote.id;

  RETURN jsonb_build_object(
    'ok', true,
    'account_id', v_account_id,
    'web_reference', v_reference,
    'invoice_number', v_invoice,
    'currency', v_cur,
    'total', v_total,
    'deposit', v_deposit,
    'term_months', v_term,
    'schedule', v_quote_out->'schedule',
    'transfer_due_at', v_due,
    'loyalty_jpy_amount', v_quote.subtotal_jpy,
    'fx_rate', v_rate,
    -- Echoed so the caller can see what was actually stored rather than
    -- assuming its own input survived.
    'agreement_version', v_agr_ver,
    'agreement_acceptance_date', p_agreement_signed_at
  ) || CASE WHEN p_reserve THEN jsonb_build_object('reserved', true) ELSE '{}'::jsonb END;
EXCEPTION
  WHEN raise_exception THEN
    IF SQLERRM LIKE 'out_of_stock:%' THEN
      RETURN jsonb_build_object('error', 'out_of_stock', 'variant_id', split_part(SQLERRM, ':', 2));
    ELSIF SQLERRM LIKE 'variant_missing:%' THEN
      RETURN jsonb_build_object('error', 'variant_missing', 'variant_id', split_part(SQLERRM, ':', 2));
    END IF;
    RAISE;
END $function$;

-- ---------------------------------------------------------------------------
-- create_web_order_atomic (live audit md5 a6d6fad027e7)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_web_order_atomic(p_customer_id uuid, p_quote_id uuid, p_method text, p_lang text DEFAULT NULL::text, p_reserve boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_quote        public.checkout_quotes%ROWTYPE;
  v_item         jsonb;
  v_variant      public.website_product_variants%ROWTYPE;
  v_qty          integer;
  v_updated      integer;
  v_seq          bigint;
  v_invoice      text;
  v_reference    text;
  v_order_id     uuid;
  -- PESO FULL PAYMENT (2026-09-25): the quote's settlement currency, set below.
  v_currency     text;
  v_rate         numeric(12,6);
  v_total        numeric(12,2);
  v_shipping     numeric(12,2);
  -- RESERVE-FIRST (A1): a reservation has NO payment deadline until staff
  -- confirm it ready for dispatch (confirm_web_order_ready_atomic starts it).
  v_due          timestamptz := CASE WHEN p_reserve THEN NULL
                                     ELSE now() + make_interval(hours => public.web_deposit_deadline_hours(p_customer_id)) END;
  v_title        text;
  v_lang         text := CASE WHEN p_lang IN ('ja','en') THEN p_lang ELSE NULL END;
BEGIN
  IF p_method IS DISTINCT FROM 'transfer' THEN
    RETURN jsonb_build_object('error', 'unsupported_method');
  END IF;

  -- Lock the quote so a double-submit cannot produce two orders from it.
  SELECT * INTO v_quote FROM public.checkout_quotes
    WHERE id = p_quote_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'quote_not_found');
  END IF;
  IF v_quote.customer_id <> p_customer_id THEN
    RETURN jsonb_build_object('error', 'quote_not_found');
  END IF;
  IF v_quote.consumed_at IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'quote_already_used');
  END IF;
  IF v_quote.expires_at <= now() THEN
    RETURN jsonb_build_object('error', 'quote_expired');
  END IF;
  IF v_quote.mode <> 'full' THEN
    RETURN jsonb_build_object('error', 'layaway_not_yet');
  END IF;
  IF v_quote.shipping_jpy IS NULL THEN
    RETURN jsonb_build_object('error', 'shipping_quote_required');
  END IF;
  IF v_quote.total_jpy <= 0 THEN
    RETURN jsonb_build_object('error', 'empty_quote');
  END IF;

  -- PESO FULL PAYMENT (2026-09-25). The customer's currency, at the rate
  -- captured on the quote (never today's). integer * numeric is exact and
  -- round(numeric) is half-up for positive amounts: whole pesos. Shipping is
  -- converted on its own and the items are the remainder, so the parts always
  -- sum to the total. The same arithmetic as create_web_layaway_atomic. Yen
  -- writes exactly what it always wrote.
  v_currency := coalesce(v_quote.settlement_currency, 'JPY');
  IF v_currency = 'PHP' THEN
    v_rate := v_quote.fx_rate;
    IF v_rate IS NULL OR v_rate <= 0 THEN
      RETURN jsonb_build_object('error', 'fx_rate_missing');
    END IF;
    v_total    := round(v_quote.total_jpy * v_rate);
    v_shipping := round(coalesce(v_quote.shipping_jpy, 0) * v_rate);
  ELSE
    v_currency := 'JPY';
    v_rate     := NULL;
    v_total    := v_quote.total_jpy;
    v_shipping := coalesce(v_quote.shipping_jpy, 0);
  END IF;

  v_seq       := public.next_web_invoice_seq();
  v_invoice   := v_seq::text;
  v_reference := 'CJ-W-' || lpad(v_seq::text, 6, '0');

  INSERT INTO public.cash_orders (
    invoice_number, customer_id, currency, total_amount, total_paid,
    remaining_balance, status, source_channel, order_type, payment_method,
    payment_status, ship_to_address_id, ship_to_snapshot, recipient_name, recipient_phone,
    gift_note, quote_id, web_reference, transfer_due_at, expires_at, shipping_fee,
    loyalty_jpy_amount, item_description, order_date, customer_lang,
    ready_confirmed_at, fx_rate_used, fx_rate_date
  ) VALUES (
    v_invoice, p_customer_id, v_currency::account_currency, v_total, 0,
    v_total, 'pending'::cash_order_status, 'web', v_quote.order_type, 'transfer',
    CASE WHEN p_reserve THEN 'awaiting_confirmation' ELSE 'pending_transfer' END, v_quote.ship_to_address_id,
    -- The address AS IT WAS, so editing the address book later cannot move
    -- where this order was sent. The FK beside it stays a convenience link.
    public.address_snapshot(v_quote.ship_to_address_id),
    v_quote.recipient_name, v_quote.recipient_phone,
    -- expires_at = transfer_due_at: the 72-hour deadline is what the expiry cron reads.
    v_quote.gift_note, v_quote.id, v_reference, v_due, v_due, v_shipping,
    -- Loyalty basis is the PRODUCT amount only: shipping never earns points.
    -- Always YEN, whatever the settlement currency: FX never moves points.
    v_quote.subtotal_jpy, 'Website order ' || v_reference, CURRENT_DATE, v_lang,
    -- A non-reserved order is ready from the moment it exists; a reservation
    -- waits for staff (NULL = awaiting confirmation).
    CASE WHEN p_reserve THEN NULL ELSE now() END,
    -- The rate this order was charged at; NULL on a yen order.
    v_rate, CASE WHEN v_rate IS NULL THEN NULL ELSE v_quote.fx_rate_date END
  ) RETURNING id INTO v_order_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_quote.items) LOOP
    v_qty := GREATEST(COALESCE((v_item->>'qty')::int, 1), 1);

    SELECT * INTO v_variant FROM public.website_product_variants
      WHERE id = (v_item->>'variant_id')::uuid;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'variant_missing:%', v_item->>'variant_id';
    END IF;

    UPDATE public.website_product_variants
       SET stock_qty = stock_qty - v_qty, updated_at = now()
     WHERE id = v_variant.id AND stock_qty >= v_qty;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated = 0 THEN
      RAISE EXCEPTION 'out_of_stock:%', v_variant.id;
    END IF;

    SELECT trim(both ' ' FROM
             p.name ||
             COALESCE(' / ' || NULLIF(v_variant.size, ''), '') ||
             COALESCE(' / ' || NULLIF(v_variant.stone, ''), ''))
      INTO v_title
      FROM public.website_products p WHERE p.id = v_variant.product_id;

    -- website_product_id, NOT product_id: product_id is the Shopify FK
    -- (public.products) and a website_products id violates it (Bug #266).
    -- Lines stay in YEN on every order: the price of record.
    INSERT INTO public.cash_order_items (
      cash_order_id, website_product_id, variant_id, title, sku, quantity,
      unit_price_jpy, line_total_jpy
    ) VALUES (
      v_order_id, v_variant.product_id, v_variant.id,
      COALESCE(v_title, 'Item'),
      (SELECT p.sku FROM public.website_products p WHERE p.id = v_variant.product_id),
      v_qty, v_variant.price_jpy, v_variant.price_jpy * v_qty
    );
  END LOOP;

  UPDATE public.checkout_quotes SET consumed_at = now() WHERE id = v_quote.id;

  RETURN jsonb_build_object(
    'ok', true,
    'order_id', v_order_id,
    'web_reference', v_reference,
    'invoice_number', v_invoice,
    'total_jpy', v_quote.total_jpy,
    'currency', v_currency,
    'total', v_total,
    'fx_rate', v_rate,
    'transfer_due_at', v_due
  ) || CASE WHEN p_reserve THEN jsonb_build_object('reserved', true) ELSE '{}'::jsonb END;
EXCEPTION
  WHEN raise_exception THEN
    IF SQLERRM LIKE 'out_of_stock:%' THEN
      RETURN jsonb_build_object('error', 'out_of_stock', 'variant_id', split_part(SQLERRM, ':', 2));
    ELSIF SQLERRM LIKE 'variant_missing:%' THEN
      RETURN jsonb_build_object('error', 'variant_missing', 'variant_id', split_part(SQLERRM, ':', 2));
    END IF;
    RAISE;
END $function$;

-- ---------------------------------------------------------------------------
-- register_invoice_number (live audit md5 2eaf67db5d87)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.register_invoice_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_source text;
  v_holder text;
BEGIN
  -- Which table are we defending? Derived from TG_TABLE_NAME so one function
  -- serves both and the two can never drift apart.
  v_source := CASE TG_TABLE_NAME
                WHEN 'cash_orders'      THEN 'cash_order'
                WHEN 'layaway_accounts' THEN 'layaway_account'
              END;
  IF v_source IS NULL THEN
    RAISE EXCEPTION 'register_invoice_number() attached to unexpected table %', TG_TABLE_NAME;
  END IF;

  IF TG_OP = 'DELETE' THEN
    -- Release the number so a deleted typo does not burn it forever. Scoped by
    -- order_id as well as the number, so a row whose registry entry has already
    -- been claimed by something else is left alone.
    DELETE FROM public.invoice_numbers
     WHERE invoice_number = OLD.invoice_number
       AND source = v_source
       AND order_id = OLD.id;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.invoice_number IS NOT DISTINCT FROM OLD.invoice_number THEN
    RETURN NEW;  -- nothing to do; the number did not move
  END IF;

  IF TG_OP = 'UPDATE' THEN
    DELETE FROM public.invoice_numbers
     WHERE invoice_number = OLD.invoice_number
       AND source = v_source
       AND order_id = OLD.id;
  END IF;

  -- A number a website order is already holding is taken too (2026-10-05):
  -- a draft awaiting Confirm, or a signed layaway quote not yet used. The
  -- draft's own order (same web_reference) and the quote's own account (same
  -- quote_id) pass, so Confirm always gets its number. TEST- is ignored: a
  -- test customer's website order is stored TEST-<number>.
  IF EXISTS (SELECT 1 FROM public.web_order_drafts d
              WHERE d.status = 'to_confirm'
                AND d.invoice_seq = CASE WHEN regexp_replace(NEW.invoice_number, '^TEST-', '') ~ '^[0-9]{1,18}$'
                                         THEN regexp_replace(NEW.invoice_number, '^TEST-', '')::bigint END
                AND d.web_reference IS DISTINCT FROM (to_jsonb(NEW) ->> 'web_reference'))
     OR EXISTS (SELECT 1 FROM public.checkout_quotes q
              WHERE q.consumed_at IS NULL AND q.expires_at > now()
                AND q.reserved_invoice_seq = CASE WHEN regexp_replace(NEW.invoice_number, '^TEST-', '') ~ '^[0-9]{1,18}$'
                                                  THEN regexp_replace(NEW.invoice_number, '^TEST-', '')::bigint END
                AND q.id::text IS DISTINCT FROM (to_jsonb(NEW) ->> 'quote_id')) THEN
    RAISE EXCEPTION 'invoice_number % is held by a website order awaiting confirmation — use another number', NEW.invoice_number
      USING ERRCODE = 'unique_violation';
  END IF;

  -- Claim the new number. A collision names WHERE the number already lives,
  -- because "already exists" without that is the message a CSR cannot act on.
  SELECT source INTO v_holder
    FROM public.invoice_numbers WHERE invoice_number = NEW.invoice_number;

  IF v_holder IS NOT NULL THEN
    RAISE EXCEPTION 'invoice_number % already exists on %', NEW.invoice_number, v_holder
      USING ERRCODE = 'unique_violation';
  END IF;

  INSERT INTO public.invoice_numbers (invoice_number, source, order_id)
  VALUES (NEW.invoice_number, v_source, NEW.id);

  RETURN NEW;
END
$function$;

-- ---------------------------------------------------------------------------
-- reassign_order_owner_atomic (live audit md5 b01a5d2aa375)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reassign_order_owner_atomic(
  p_kind text,
  p_order_id uuid,
  p_new_customer_id uuid,
  p_loyalty_jpy_amount numeric,
  p_reason text,
  p_user_id uuid,
  p_apply boolean,
  p_allow_unmatched boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  -- order
  v_invoice        text;
  v_old_cust       uuid;
  v_status         text;
  v_order_date     date;
  v_loyalty_stored numeric;
  v_quote_id       uuid;
  v_completed_at   timestamptz;
  v_total          numeric;
  v_source_channel text;
  v_shopify_id     text;
  v_ship_addr      uuid;
  v_ship_snap      jsonb;
  -- customers / members
  v_old            public.customers%ROWTYPE;
  v_new            public.customers%ROWTYPE;
  v_old_m          public.loyalty_members%ROWTYPE;
  v_new_m          public.loyalty_members%ROWTYPE;
  v_old_has        boolean := false;
  v_new_has        boolean := false;
  v_old_tier       text;
  v_new_tier       text;
  -- decisions
  v_refusals       jsonb := '[]'::jsonb;
  v_markers        text[] := ARRAY[]::text[];
  v_split          text;
  v_split_n        integer := 0;
  v_loyalty_eff    numeric;
  v_loyalty_change boolean := false;
  v_award_at       timestamptz;
  v_award_source   text;
  v_grace_days     integer := 3;
  v_catch_up       boolean := false;
  v_catch_reason   text;
  v_expired        boolean := false;
  v_lot_expires_on date;
  v_expected_pts   integer := 0;
  v_mult           numeric;
  v_cur_min        numeric;
  v_new_cum        numeric;
  v_new_tier_min   numeric;
  v_new_tier_mult  numeric;
  v_requalified    boolean := true;
  v_requalify_tgt  numeric;
  v_upgraded       boolean := false;
  v_loyalty_on     boolean := false;
  v_flag           text;
  -- identity match (R11)
  v_matched_on     text[] := ARRAY[]::text[];
  v_unmatched      boolean := false;
  v_override_ok    boolean := false;
  v_override_used  boolean := false;
  -- counts
  n_submissions    integer := 0;
  n_extensions     integer := 0;
  n_service_jobs   integer := 0;
  n_service_reqs   integer := 0;
  n_quotes         integer := 0;
  n_csr            integer := 0;
  n_address        integer := 0;
  v_counts         jsonb;
  v_result         jsonb;
  v_account_type   text;
BEGIN
  -- ---- input ---------------------------------------------------------------
  IF p_kind IS NULL OR p_kind NOT IN ('layaway', 'cash') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_kind',
      'message', 'kind must be layaway or cash.');
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'reason_required',
      'message', 'A written reason is required to reassign an order.');
  END IF;
  -- Service-role-only function, so the edge function's permission gate is the
  -- real one; this repeats it so a direct caller cannot skip it.
  IF p_user_id IS NULL OR NOT public.has_permission(p_user_id, 'reassign_owner') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden',
      'message', 'You do not have the Reassign Owner permission.');
  END IF;

  -- ---- the order, locked ---------------------------------------------------
  IF p_kind = 'layaway' THEN
    SELECT la.invoice_number, la.customer_id, la.status::text, la.order_date,
           la.loyalty_jpy_amount, la.quote_id, la.completed_at, la.total_amount,
           la.source_channel, NULL::text, NULL::uuid, NULL::jsonb
      INTO v_invoice, v_old_cust, v_status, v_order_date,
           v_loyalty_stored, v_quote_id, v_completed_at, v_total,
           v_source_channel, v_shopify_id, v_ship_addr, v_ship_snap
      FROM public.layaway_accounts la
     WHERE la.id = p_order_id
     FOR UPDATE;
  ELSE
    SELECT co.invoice_number, co.customer_id, co.status::text, co.order_date,
           co.loyalty_jpy_amount, co.quote_id, co.completed_at, co.total_amount,
           co.source_channel, co.shopify_order_id::text, co.ship_to_address_id, co.ship_to_snapshot
      INTO v_invoice, v_old_cust, v_status, v_order_date,
           v_loyalty_stored, v_quote_id, v_completed_at, v_total,
           v_source_channel, v_shopify_id, v_ship_addr, v_ship_snap
      FROM public.cash_orders co
     WHERE co.id = p_order_id
     FOR UPDATE;
  END IF;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'Order not found.');
  END IF;

  SELECT * INTO v_new FROM public.customers WHERE id = p_new_customer_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'The customer to move this order to was not found.');
  END IF;
  SELECT * INTO v_old FROM public.customers WHERE id = v_old_cust;

  IF v_old_cust = p_new_customer_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'same_owner',
      'message', 'This order already belongs to ' || v_new.full_name || '.');
  END IF;

  -- ---- loyalty accounts of both sides (R1) ---------------------------------
  SELECT * INTO v_old_m FROM public.loyalty_members WHERE customer_id = v_old_cust;
  IF FOUND THEN
    v_old_has := COALESCE(v_old_m.total_points_earned, 0) > 0
              OR COALESCE(v_old_m.cumulative_spend_jpy, 0) > 0
              OR COALESCE(v_old_m.spend_baseline_jpy, 0) > 0;
    SELECT name INTO v_old_tier FROM public.loyalty_tiers WHERE id = v_old_m.current_tier_id;
  END IF;
  SELECT * INTO v_new_m FROM public.loyalty_members WHERE customer_id = p_new_customer_id;
  IF FOUND THEN
    v_new_has := COALESCE(v_new_m.total_points_earned, 0) > 0
              OR COALESCE(v_new_m.cumulative_spend_jpy, 0) > 0
              OR COALESCE(v_new_m.spend_baseline_jpy, 0) > 0;
    SELECT name, min_spend_jpy, points_multiplier
      INTO v_new_tier, v_cur_min, v_mult
      FROM public.loyalty_tiers WHERE id = v_new_m.current_tier_id;
  END IF;

  -- ---- refusals, in check order --------------------------------------------
  IF (p_kind = 'layaway' AND v_status IN ('cancelled', 'forfeited', 'final_forfeited'))
     OR (p_kind = 'cash' AND v_status IN ('cancelled', 'expired')) THEN
    v_refusals := v_refusals || jsonb_build_object('code', 'status_closed',
      'message', 'This order is ' || replace(v_status, '_', ' ') || '. A closed order cannot change owner.');
  END IF;

  IF COALESCE(v_old.is_test, false) <> COALESCE(v_new.is_test, false) THEN
    v_refusals := v_refusals || jsonb_build_object('code', 'test_boundary',
      'message', 'One of these customers is a test customer and the other is not. An order cannot move between test and real customers.');
  END IF;

  -- R1 — FIRST loyalty check. The order never leaves a points account.
  IF v_old_has AND v_new_has THEN
    v_refusals := v_refusals || jsonb_build_object('code', 'both_have_points',
      'message', 'Both accounts have loyalty history — contact the owner.');
  ELSIF v_old_has THEN
    v_refusals := v_refusals || jsonb_build_object('code', 'points_account_is_current_owner',
      'message', 'This order stays with ' || v_old.full_name || ': ' || v_old.full_name || '''s account has loyalty history.');
  END IF;

  -- R5 — already earned by ANY member. Every marker counts, including an
  -- in-flight award (a claim whose transaction_id is still NULL).
  IF EXISTS (SELECT 1 FROM public.loyalty_award_claims c
              WHERE c.source_kind = p_kind AND c.source_id = p_order_id AND c.transaction_id IS NULL) THEN
    v_markers := array_append(v_markers, 'an award in progress');
  END IF;
  IF EXISTS (SELECT 1 FROM public.loyalty_award_claims c
              WHERE c.source_kind = p_kind AND c.source_id = p_order_id AND c.transaction_id IS NOT NULL) THEN
    v_markers := array_append(v_markers, 'an award claim');
  END IF;
  IF EXISTS (SELECT 1 FROM public.loyalty_transactions t
              WHERE t.transaction_type = 'earned'
                AND ((p_kind = 'layaway' AND t.account_id = p_order_id)
                  OR (p_kind = 'cash' AND t.cash_order_id = p_order_id)
                  OR t.invoice_number = v_invoice)) THEN
    v_markers := array_append(v_markers, 'an earned ledger row');
  END IF;
  IF EXISTS (SELECT 1 FROM public.loyalty_transactions t
              WHERE t.transaction_type = 'bonus' AND t.invoice_number = v_invoice) THEN
    v_markers := array_append(v_markers, 'a bonus ledger row');
  END IF;
  IF EXISTS (SELECT 1 FROM public.loyalty_point_lots l
              WHERE l.source_type IN ('order_earn', 'promo_bonus')
                AND l.source_reference = v_invoice) THEN
    v_markers := array_append(v_markers, 'a points lot');
  END IF;
  IF array_length(v_markers, 1) > 0 THEN
    v_refusals := v_refusals || jsonb_build_object('code', 'already_earned',
      'message', 'This order has already earned loyalty points (' || array_to_string(v_markers, ', ') || '). Points cannot follow the order to another customer.');
  END IF;

  IF v_invoice ILIKE 'SH-%' OR COALESCE(v_source_channel, '') ILIKE 'shopify%' OR v_shopify_id IS NOT NULL THEN
    v_refusals := v_refusals || jsonb_build_object('code', 'shopify_order',
      'message', 'This is a Shopify order. Its owner comes from Shopify and cannot be changed here.');
  END IF;

  -- A split payment submission covering more than one order cannot be moved:
  -- one half would follow the order and the other would stay behind.
  WITH subs AS (
    SELECT ps.id, ps.account_id, ps.cash_order_id
      FROM public.payment_submissions ps
     WHERE (p_kind = 'layaway' AND (ps.account_id = p_order_id
              OR ps.id IN (SELECT a.submission_id FROM public.payment_submission_allocations a WHERE a.account_id = p_order_id)))
        OR (p_kind = 'cash' AND ps.cash_order_id = p_order_id)
  ), orders AS (
    -- UNION (not UNION ALL) — one row per (submission, order) pair.
    SELECT s.id AS sid, s.account_id AS la_id, NULL::uuid AS co_id FROM subs s WHERE s.account_id IS NOT NULL
    UNION SELECT s.id, NULL::uuid, s.cash_order_id FROM subs s WHERE s.cash_order_id IS NOT NULL
    UNION SELECT a.submission_id, a.account_id, NULL::uuid
            FROM public.payment_submission_allocations a JOIN subs s ON s.id = a.submission_id
  ), wide AS (
    SELECT sid FROM orders GROUP BY sid HAVING count(*) > 1
  )
  SELECT count(*), string_agg(DISTINCT COALESCE(la.invoice_number, co.invoice_number), ', ')
    INTO v_split_n, v_split
    FROM orders o
    JOIN wide w ON w.sid = o.sid
    LEFT JOIN public.layaway_accounts la ON la.id = o.la_id
    LEFT JOIN public.cash_orders co ON co.id = o.co_id
   WHERE NOT ((p_kind = 'layaway' AND o.la_id IS NOT DISTINCT FROM p_order_id)
           OR (p_kind = 'cash' AND o.co_id IS NOT DISTINCT FROM p_order_id));
  IF v_split_n > 0 THEN
    v_refusals := v_refusals || jsonb_build_object('code', 'split_submission',
      'message', 'A payment submission for this order also pays ' || COALESCE('invoice ' || v_split, 'another order')
        || '. A split payment cannot be divided between two customers.');
  END IF;

  IF EXISTS (SELECT 1 FROM public.loyalty_redemptions r
              WHERE r.status <> 'cancelled'
                AND ((p_kind = 'layaway' AND r.account_id = p_order_id)
                  OR (p_kind = 'cash' AND r.cash_order_id = p_order_id)
                  OR r.invoice_number = v_invoice)) THEN
    v_refusals := v_refusals || jsonb_build_object('code', 'loyalty_redemption',
      'message', 'A loyalty redemption is attached to this order. It belongs to the account that redeemed the points.');
  END IF;

  IF EXISTS (SELECT 1 FROM public.store_credit_transactions x
              WHERE (p_kind = 'layaway' AND x.account_id = p_order_id)
                 OR (p_kind = 'cash' AND x.cash_order_id = p_order_id))
     OR EXISTS (SELECT 1 FROM public.store_credit_lots l
              WHERE (p_kind = 'layaway' AND l.source_account_id = p_order_id)
                 OR (p_kind = 'cash' AND l.source_cash_order_id = p_order_id)) THEN
    v_refusals := v_refusals || jsonb_build_object('code', 'store_credit',
      'message', 'Store credit was applied to or issued from this order. Store credit belongs to one customer and cannot move with the order.');
  END IF;

  -- Paidy (owner 2026-10-04): a Paidy order is a website order paid from the
  -- customer's own signed-in account, so it never changes owner. Any Paidy
  -- history counts (a payment record, a checkout window, a Paidy submission).
  IF p_kind = 'cash' AND (
       EXISTS (SELECT 1 FROM public.paidy_payments pp WHERE pp.cash_order_id = p_order_id)
    OR EXISTS (SELECT 1 FROM public.paidy_checkout_attempts pa WHERE pa.cash_order_id = p_order_id)
    OR EXISTS (SELECT 1 FROM public.payment_submissions ps
                WHERE ps.cash_order_id = p_order_id
                  AND (ps.payment_method = 'paidy' OR ps.paidy_payment_id IS NOT NULL))) THEN
    v_refusals := v_refusals || jsonb_build_object('code', 'paidy_order',
      'message', 'This order was paid, or started to be paid, with Paidy. A Paidy order belongs to the customer who signed in and paid, and cannot change owner.');
  END IF;

  -- R11 — IDENTITY MATCH. The target must be another account of the SAME
  -- customer: at least one of full name, Facebook name, mobile or email
  -- matches the CURRENT owner, normalised exactly as find_customer_matches
  -- does (names: lower-case, trim, collapse spaces; mobile: last 10 digits,
  -- only when both sides have >= 10; email: trimmed, case-insensitive). An
  -- empty field never matches — the left side is NULLed when empty.
  v_matched_on := array_remove(ARRAY[
    CASE WHEN nullif(lower(regexp_replace(btrim(coalesce(v_old.full_name, '')), '\s+', ' ', 'g')), '')
            = lower(regexp_replace(btrim(coalesce(v_new.full_name, '')), '\s+', ' ', 'g'))
         THEN 'full_name' END,
    CASE WHEN nullif(lower(regexp_replace(btrim(coalesce(v_old.facebook_name, '')), '\s+', ' ', 'g')), '')
            = lower(regexp_replace(btrim(coalesce(v_new.facebook_name, '')), '\s+', ' ', 'g'))
         THEN 'facebook_name' END,
    CASE WHEN length(regexp_replace(coalesce(v_old.mobile_number, ''), '\D', '', 'g')) >= 10
          AND length(regexp_replace(coalesce(v_new.mobile_number, ''), '\D', '', 'g')) >= 10
          AND right(regexp_replace(v_old.mobile_number, '\D', '', 'g'), 10)
            = right(regexp_replace(v_new.mobile_number, '\D', '', 'g'), 10)
         THEN 'mobile' END,
    CASE WHEN nullif(lower(btrim(coalesce(v_old.email, ''))), '')
            = lower(btrim(coalesce(v_new.email, '')))
         THEN 'email' END
  ], NULL);
  v_unmatched := cardinality(v_matched_on) = 0;
  -- The override is honoured only for a holder of reassign_owner_unmatched;
  -- the edge function checks it too, this repeats it so a direct caller
  -- cannot skip it. It bypasses R11 ONLY — every other refusal still stands.
  v_override_ok := COALESCE(p_allow_unmatched, false)
               AND public.has_permission(p_user_id, 'reassign_owner_unmatched');
  IF v_unmatched THEN
    IF v_override_ok THEN
      v_override_used := true;
    ELSE
      v_refusals := v_refusals || jsonb_build_object('code', 'different_customer_details',
        'message', 'Different customer details — this order can only move to another account of the same customer. Contact the owner.');
    END IF;
  END IF;

  -- R4 — the loyalty amount must be set (> 0) for every reassign.
  v_loyalty_eff := COALESCE(p_loyalty_jpy_amount, v_loyalty_stored);
  v_loyalty_change := p_loyalty_jpy_amount IS NOT NULL
                  AND p_loyalty_jpy_amount IS DISTINCT FROM v_loyalty_stored;
  IF v_loyalty_eff IS NULL OR v_loyalty_eff <= 0 THEN
    v_refusals := v_refusals || jsonb_build_object('code', 'loyalty_amount_required',
      'message', 'Set the loyalty product amount (product only — no shipping or service fees) before reassigning.');
  ELSIF v_loyalty_change AND NOT public.has_permission(p_user_id, 'edit_loyalty_amount') THEN
    -- R3. trg_guard_loyalty_jpy_amount does not fire for a service-role
    -- caller, so the permission is checked here.
    v_refusals := v_refusals || jsonb_build_object('code', 'loyalty_permission_required',
      'message', 'Changing the loyalty amount needs the Edit Loyalty Amount permission.');
  END IF;

  -- ---- award point (R6) ----------------------------------------------------
  IF p_kind = 'layaway' THEN
    SELECT min(p.created_at) INTO v_award_at
      FROM public.payments p
     WHERE p.account_id = p_order_id
       AND p.voided_at IS NULL
       AND (p.reference_number LIKE 'DP-%' OR p.remarks ILIKE '%down%')
       AND COALESCE(p.reference_number, '') NOT LIKE 'LOYALTY-%';
    IF v_award_at IS NOT NULL THEN
      v_award_source := 'downpayment_payment';
    ELSE
      SELECT min(ps.updated_at) INTO v_award_at
        FROM public.payment_submissions ps
       WHERE ps.account_id = p_order_id
         AND ps.status = 'confirmed'
         AND ps.submission_type = 'downpayment';
      IF v_award_at IS NOT NULL THEN v_award_source := 'downpayment_submission'; END IF;
    END IF;
  ELSIF v_status = 'completed' THEN
    v_award_at := v_completed_at;
    IF v_award_at IS NOT NULL THEN
      v_award_source := 'completed_at';
    ELSE
      SELECT x.created_at INTO v_award_at FROM (
        SELECT cp.created_at,
               sum(cp.amount_paid) OVER (ORDER BY cp.created_at, cp.id) AS running
          FROM public.cash_payments cp
         WHERE cp.cash_order_id = p_order_id AND cp.voided_at IS NULL
      ) x WHERE x.running >= v_total ORDER BY x.created_at LIMIT 1;
      IF v_award_at IS NOT NULL THEN v_award_source := 'fully_paid_payment'; END IF;
    END IF;
  END IF;

  SELECT (value #>> '{}') INTO v_flag FROM public.system_settings WHERE key = 'loyalty_enrollment_grace_days';
  IF v_flag ~ '^[0-9]+$' THEN v_grace_days := v_flag::integer; END IF;
  SELECT (value #>> '{}') INTO v_flag FROM public.system_settings WHERE key = 'loyalty_enabled';
  v_loyalty_on := lower(COALESCE(v_flag, '')) = 'true';

  -- ---- catch-up decision (R6/R7) -------------------------------------------
  v_lot_expires_on := v_order_date + 180;
  IF v_new_m.id IS NULL THEN
    v_catch_reason := 'not_enrolled';
  ELSIF v_award_at IS NULL THEN
    v_catch_reason := 'not_at_award_point';
  ELSIF v_award_at < v_new_m.enrolled_at - make_interval(days => v_grace_days) THEN
    v_catch_reason := 'paid_before_enrollment';
  ELSE
    v_catch_up := true;
    v_catch_reason := 'eligible';
    v_expired := v_lot_expires_on <= (now() AT TIME ZONE 'Asia/Manila')::date;
  END IF;

  -- Expected points — the award function's own arithmetic: current tier, with
  -- the ratchet to the post-purchase tier (and the requalify gate), no promo.
  IF v_catch_up AND COALESCE(v_loyalty_eff, 0) >= 10000 THEN
    v_new_cum := COALESCE(v_new_m.cumulative_spend_jpy, 0) + v_loyalty_eff;
    SELECT min_spend_jpy, points_multiplier INTO v_new_tier_min, v_new_tier_mult
      FROM public.loyalty_tiers WHERE min_spend_jpy <= v_new_cum
     ORDER BY min_spend_jpy DESC LIMIT 1;
    IF v_new_m.is_downgraded AND v_new_m.downgrade_spend_baseline IS NOT NULL AND v_new_m.earned_tier_id IS NOT NULL THEN
      SELECT requalify_spend_jpy INTO v_requalify_tgt FROM public.loyalty_tiers WHERE id = v_new_m.earned_tier_id;
      IF v_requalify_tgt IS NOT NULL THEN
        v_requalified := (v_new_cum - v_new_m.downgrade_spend_baseline) >= v_requalify_tgt;
      END IF;
    END IF;
    v_upgraded := v_requalified AND v_new_tier_min IS NOT NULL AND v_new_tier_min > COALESCE(v_cur_min, 0);
    v_expected_pts := (floor(v_loyalty_eff / 10000) * 100
                       * CASE WHEN v_upgraded THEN COALESCE(v_new_tier_mult, 1) ELSE COALESCE(v_mult, 1) END)::integer;
  END IF;

  -- ---- child rows that move with the order ---------------------------------
  v_account_type := CASE WHEN p_kind = 'layaway' THEN 'layaway' ELSE 'cash_order' END;
  SELECT count(*) INTO n_submissions FROM public.payment_submissions ps
   WHERE (p_kind = 'layaway' AND (ps.account_id = p_order_id
            OR ps.id IN (SELECT a.submission_id FROM public.payment_submission_allocations a WHERE a.account_id = p_order_id)))
      OR (p_kind = 'cash' AND ps.cash_order_id = p_order_id);
  IF p_kind = 'layaway' THEN
    SELECT count(*) INTO n_extensions FROM public.extension_requests WHERE account_id = p_order_id;
    SELECT count(*) INTO n_csr FROM public.csr_notifications WHERE account_id = p_order_id;
  END IF;
  SELECT count(*) INTO n_service_jobs FROM public.service_jobs
   WHERE invoice_number = v_invoice AND account_type = v_account_type;
  SELECT count(*) INTO n_service_reqs FROM public.service_requests
   WHERE (p_kind = 'layaway' AND layaway_account_id = p_order_id)
      OR (p_kind = 'cash' AND cash_order_id = p_order_id);
  IF v_quote_id IS NOT NULL THEN
    SELECT count(*) INTO n_quotes FROM public.checkout_quotes WHERE id = v_quote_id;
  END IF;
  IF v_ship_addr IS NOT NULL THEN n_address := 1; END IF;

  v_counts := jsonb_build_object(
    'payment_submissions', n_submissions, 'extension_requests', n_extensions,
    'service_jobs', n_service_jobs, 'service_requests', n_service_reqs,
    'checkout_quotes', n_quotes, 'csr_notifications', n_csr,
    'ship_to_address_detached', n_address);

  v_result := jsonb_build_object(
    'ok', true,
    'applied', false,
    'kind', p_kind,
    'order_id', p_order_id,
    'invoice_number', v_invoice,
    'status', v_status,
    'order_date', v_order_date,
    'current', jsonb_build_object(
      'customer_id', v_old_cust, 'full_name', v_old.full_name, 'is_test', COALESCE(v_old.is_test, false),
      'enrolled', v_old_m.id IS NOT NULL, 'tier', v_old_tier,
      'points', COALESCE(v_old_m.remaining_points, 0), 'points_earned', COALESCE(v_old_m.total_points_earned, 0),
      'spend_jpy', COALESCE(v_old_m.cumulative_spend_jpy, 0), 'has_points', v_old_has),
    'target', jsonb_build_object(
      'customer_id', p_new_customer_id, 'full_name', v_new.full_name, 'is_test', COALESCE(v_new.is_test, false),
      'enrolled', v_new_m.id IS NOT NULL, 'enrolled_at', v_new_m.enrolled_at, 'tier', v_new_tier,
      'points', COALESCE(v_new_m.remaining_points, 0), 'points_earned', COALESCE(v_new_m.total_points_earned, 0),
      'spend_jpy', COALESCE(v_new_m.cumulative_spend_jpy, 0), 'has_points', v_new_has),
    'refusals', v_refusals,
    'can_apply', jsonb_array_length(v_refusals) = 0,
    'matched_on', to_jsonb(v_matched_on),
    'unmatched', v_unmatched,
    'loyalty_jpy_amount', jsonb_build_object(
      'stored', v_loyalty_stored, 'proposed', p_loyalty_jpy_amount, 'effective', v_loyalty_eff,
      'changes', v_loyalty_change),
    'award_point', jsonb_build_object('at', v_award_at, 'source', v_award_source),
    'catch_up', jsonb_build_object(
      'eligible', v_catch_up, 'reason', v_catch_reason, 'grace_days', v_grace_days,
      'expected_points', v_expected_pts, 'below_minimum', v_catch_up AND COALESCE(v_loyalty_eff, 0) < 10000,
      'expired_on_award', v_expired, 'lot_expires_on', v_lot_expires_on,
      'loyalty_enabled', v_loyalty_on),
    'child_rows', v_counts);

  IF NOT COALESCE(p_apply, false) THEN
    RETURN v_result;
  END IF;

  IF jsonb_array_length(v_refusals) > 0 THEN
    RETURN v_result || jsonb_build_object('ok', false,
      'error', v_refusals -> 0 ->> 'code', 'message', v_refusals -> 0 ->> 'message');
  END IF;

  -- ---- apply ---------------------------------------------------------------
  IF v_loyalty_change THEN
    IF p_kind = 'layaway' THEN
      UPDATE public.layaway_accounts SET loyalty_jpy_amount = p_loyalty_jpy_amount WHERE id = p_order_id;
    ELSE
      UPDATE public.cash_orders SET loyalty_jpy_amount = p_loyalty_jpy_amount WHERE id = p_order_id;
    END IF;
  END IF;

  IF p_kind = 'layaway' THEN
    UPDATE public.layaway_accounts SET customer_id = p_new_customer_id WHERE id = p_order_id;
  ELSE
    -- The saved address belongs to the old owner's address book. Keep what
    -- the order shipped to as its snapshot, then drop the link.
    UPDATE public.cash_orders
       SET customer_id = p_new_customer_id,
           ship_to_snapshot = CASE WHEN ship_to_address_id IS NOT NULL AND ship_to_snapshot IS NULL
                                   THEN public.address_snapshot(ship_to_address_id)
                                   ELSE ship_to_snapshot END,
           ship_to_address_id = NULL
     WHERE id = p_order_id;
  END IF;

  UPDATE public.payment_submissions ps
     SET customer_id = p_new_customer_id, portal_token = NULL
   WHERE (p_kind = 'layaway' AND (ps.account_id = p_order_id
            OR ps.id IN (SELECT a.submission_id FROM public.payment_submission_allocations a WHERE a.account_id = p_order_id)))
      OR (p_kind = 'cash' AND ps.cash_order_id = p_order_id);
  GET DIAGNOSTICS n_submissions = ROW_COUNT;

  IF p_kind = 'layaway' THEN
    UPDATE public.extension_requests
       SET customer_id = p_new_customer_id, portal_token = NULL
     WHERE account_id = p_order_id;
    GET DIAGNOSTICS n_extensions = ROW_COUNT;
    UPDATE public.csr_notifications SET customer_id = p_new_customer_id WHERE account_id = p_order_id;
    GET DIAGNOSTICS n_csr = ROW_COUNT;
  END IF;

  UPDATE public.service_jobs SET customer_id = p_new_customer_id
   WHERE invoice_number = v_invoice AND account_type = v_account_type;
  GET DIAGNOSTICS n_service_jobs = ROW_COUNT;

  UPDATE public.service_requests SET customer_id = p_new_customer_id
   WHERE (p_kind = 'layaway' AND layaway_account_id = p_order_id)
      OR (p_kind = 'cash' AND cash_order_id = p_order_id);
  GET DIAGNOSTICS n_service_reqs = ROW_COUNT;

  IF v_quote_id IS NOT NULL THEN
    UPDATE public.checkout_quotes SET customer_id = p_new_customer_id WHERE id = v_quote_id;
    GET DIAGNOSTICS n_quotes = ROW_COUNT;
  END IF;

  v_counts := jsonb_build_object(
    'payment_submissions', n_submissions, 'extension_requests', n_extensions,
    'service_jobs', n_service_jobs, 'service_requests', n_service_reqs,
    'checkout_quotes', n_quotes, 'csr_notifications', n_csr,
    'ship_to_address_detached', n_address);

  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id)
  VALUES (
    CASE WHEN p_kind = 'layaway' THEN 'layaway_account' ELSE 'cash_order' END,
    p_order_id,
    'reassign_owner',
    jsonb_build_object(
      'customer_id', v_old_cust, 'customer_name', v_old.full_name,
      'loyalty_jpy_amount', v_loyalty_stored),
    jsonb_build_object(
      'customer_id', p_new_customer_id, 'customer_name', v_new.full_name,
      'loyalty_jpy_amount', v_loyalty_eff,
      'reason', btrim(p_reason),
      'invoice_number', v_invoice,
      'moved', v_counts,
      'award_point', v_award_at, 'award_point_source', v_award_source,
      'catch_up', v_catch_up, 'catch_up_reason', v_catch_reason,
      'catch_up_expected_points', v_expected_pts, 'catch_up_expired_on_award', v_expired,
      'matched_on', to_jsonb(v_matched_on), 'unmatched', v_unmatched,
      'override_used', v_override_used),
    p_user_id);

  RETURN v_result || jsonb_build_object('applied', true, 'child_rows', v_counts,
    'loyalty_jpy_amount', (v_result -> 'loyalty_jpy_amount') || jsonb_build_object('stored', v_loyalty_eff));
END;
$function$;

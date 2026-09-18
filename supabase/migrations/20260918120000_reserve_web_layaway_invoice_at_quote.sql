-- ============================================================================
-- RESERVE THE WEB LAYAWAY INVOICE NUMBER AT QUOTE TIME
--
-- Owner decision (2026-09-18, option A). The layaway agreement is signed on a
-- separate site BEFORE the plan exists, and the signing page should carry the
-- plan's real invoice number. Until now that number was drawn by nextval inside
-- create_web_layaway_atomic, one statement before the account row was inserted,
-- so there was nothing to prefill: the only key a quote had was its uuid.
--
-- WHAT CHANGES. A layaway quote now draws its number from web_order_number_seq
-- the moment it is created (a BEFORE INSERT trigger on checkout_quotes writes
-- reserved_invoice_seq), and create_web_layaway_atomic USES that number instead
-- of drawing a fresh one. The invoice the customer signs against is the invoice
-- the plan gets. Full-payment quotes reserve nothing.
--
-- GAPS ARE BY DESIGN. A layaway quote that expires or is abandoned keeps its
-- number and never becomes a plan, so the sequence gains holes. That is the
-- price of a number that exists before the plan does, and it is cheaper than
-- any scheme that hands numbers back. Nothing reads the sequence for
-- contiguity; cash web orders draw from the same sequence and have always been
-- interleaved with layaway numbers anyway.
--
-- create_web_layaway_atomic: SAME 7-argument signature, SAME body as
-- 20260918090000_web_layaway_records_the_signed_agreement.sql, with exactly one
-- line changed (the v_seq assignment, marked below). CREATE OR REPLACE on the
-- identical signature replaces in place — there is no second overload and
-- nothing to DROP. Started from live per CLAUDE.md "FUNCTION CHANGES START FROM
-- LIVE": live prosrc is the comment-stripped equivalent of the 20260918090000
-- body (Lovable retyped it; see the drift note in that session), verified at
-- commit time:
--   live md5(pg_get_functiondef)  7579e7c1e08e9a414c01034af4c484ed
--   live length                   7325 bytes
--   comment-stripped, whitespace-collapsed body: identical to ours
-- ============================================================================

-- ------------------------------------------------------------- 1. the column
ALTER TABLE public.checkout_quotes
  ADD COLUMN IF NOT EXISTS reserved_invoice_seq bigint;

COMMENT ON COLUMN public.checkout_quotes.reserved_invoice_seq IS
  'Drawn from web_order_number_seq when a LAYAWAY quote is created, so the layaway agreement can be signed against the final invoice number before the plan exists; create_web_layaway_atomic uses it as the invoice_number and web_reference (CJ-W-<6 digits>). NULL for full-payment quotes. Abandoned or expired quotes keep their number, so the sequence has gaps by design.';

-- A reserved number belongs to exactly one quote. Partial so the NULLs of
-- full-payment quotes do not collide.
CREATE UNIQUE INDEX IF NOT EXISTS uq_checkout_quotes_reserved_invoice_seq
  ON public.checkout_quotes (reserved_invoice_seq)
  WHERE reserved_invoice_seq IS NOT NULL;

-- ------------------------------------------------------------ 2. the trigger
-- SECURITY DEFINER, owned by the migration role, so the draw does not depend on
-- the inserting role's grants on the sequence. service_role (the only inserter,
-- through the website edge function) already holds USAGE from 20260911120000;
-- this keeps the trigger correct even if that grant is ever tightened, and it
-- means no new grant is added here. A caller that supplies its own
-- reserved_invoice_seq keeps it — the trigger only fills a NULL.
CREATE OR REPLACE FUNCTION public.checkout_quotes_reserve_invoice()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.mode = 'layaway' AND NEW.reserved_invoice_seq IS NULL THEN
    NEW.reserved_invoice_seq := nextval('public.web_order_number_seq');
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.checkout_quotes_reserve_invoice() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_checkout_quotes_reserve_invoice ON public.checkout_quotes;
CREATE TRIGGER trg_checkout_quotes_reserve_invoice
  BEFORE INSERT ON public.checkout_quotes
  FOR EACH ROW EXECUTE FUNCTION public.checkout_quotes_reserve_invoice();

-- ------------------------------------------- 3. the writer uses the reserved number
CREATE OR REPLACE FUNCTION public.create_web_layaway_atomic(
  p_customer_id uuid,
  p_quote_id uuid,
  p_lang text DEFAULT NULL::text,
  p_transfer_due_at timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_order_date date DEFAULT NULL::date,
  p_agreement_version text DEFAULT NULL::text,
  p_agreement_signed_at timestamp with time zone DEFAULT NULL::timestamp with time zone
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

  v_due := coalesce(p_transfer_due_at, now() + make_interval(hours => public.web_deposit_deadline_hours(p_customer_id)));
  SELECT max((s->>'due_date')::date) INTO v_end_date
    FROM jsonb_array_elements(v_quote_out->'schedule') s;

  -- THE NUMBER WAS RESERVED WHEN THE QUOTE WAS CREATED (reserved_invoice_seq,
  -- drawn by trg_checkout_quotes_reserve_invoice) so the agreement could be
  -- signed against the final invoice number before this plan existed. The
  -- coalesce covers quotes created before migration 20260918120000, which
  -- carry NULL and draw here exactly as they always did.
  v_seq       := coalesce(v_quote.reserved_invoice_seq, nextval('public.web_order_number_seq'));
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
    agreement_version, agreement_acceptance_date
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
    v_agr_ver, p_agreement_signed_at
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
  );
EXCEPTION
  WHEN raise_exception THEN
    IF SQLERRM LIKE 'out_of_stock:%' THEN
      RETURN jsonb_build_object('error', 'out_of_stock', 'variant_id', split_part(SQLERRM, ':', 2));
    ELSIF SQLERRM LIKE 'variant_missing:%' THEN
      RETURN jsonb_build_object('error', 'variant_missing', 'variant_id', split_part(SQLERRM, ':', 2));
    END IF;
    RAISE;
END $function$;

COMMENT ON FUNCTION public.create_web_layaway_atomic(uuid, uuid, text, timestamp with time zone, date, text, timestamp with time zone) IS
  'Sole writer of a web layaway plan. Consumes a checkout quote, recomputes the plan from layaway_quote, inserts account + schedule + item lines, decrements stock, and records the agreement version and signing timestamp the storefront verified. Uses the invoice number reserved on the quote (reserved_invoice_seq) when present. One transaction.';

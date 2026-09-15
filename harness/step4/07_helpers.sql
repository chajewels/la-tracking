-- mk_quote() mirrors the `website` edge function's POST /checkout/quote insert
-- (supabase/functions/website/index.ts:1012-1042) — same columns, same values,
-- same "shipping converted, subtotal is the remainder" rule.
CREATE OR REPLACE FUNCTION public.mk_quote(
  p_customer uuid, p_variant uuid, p_qty int, p_term int,
  p_settlement text DEFAULT 'JPY', p_shipping_jpy int DEFAULT 2000,
  p_fx numeric DEFAULT NULL, p_order_date date DEFAULT CURRENT_DATE
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_price int; v_sub int; v_total int; v_id uuid;
  v_total_s int; v_ship_s int; v_sub_s int; v_lq jsonb;
BEGIN
  SELECT price_jpy INTO v_price FROM website_product_variants WHERE id = p_variant;
  v_sub   := v_price * p_qty;
  v_total := v_sub + p_shipping_jpy;
  IF p_settlement = 'PHP' THEN
    v_total_s := round(v_total * p_fx); v_ship_s := round(p_shipping_jpy * p_fx);
  ELSE
    v_total_s := v_total; v_ship_s := p_shipping_jpy;
  END IF;
  v_sub_s := v_total_s - v_ship_s;
  v_lq := public.layaway_quote(v_sub_s, p_term, p_settlement, p_order_date, v_ship_s, 0);

  INSERT INTO checkout_quotes (customer_id, items, mode, term_months, deposit_jpy, schedule,
    settlement_currency, fx_rate, fx_rate_date, order_type, subtotal_jpy, shipping_jpy, total_jpy)
  VALUES (p_customer,
    jsonb_build_array(jsonb_build_object('variant_id', p_variant, 'qty', p_qty)),
    'layaway', coalesce((v_lq->>'term_months')::int, p_term),
    CASE WHEN p_fx IS NULL THEN (v_lq->>'deposit')::int ELSE round((v_lq->>'deposit')::numeric / p_fx) END,
    v_lq->'schedule', p_settlement, p_fx,
    CASE WHEN p_fx IS NULL THEN NULL ELSE p_order_date END,
    'SELF', v_sub, p_shipping_jpy, v_total)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- sweep() mirrors the web-layaway half of auto-expire-cash-orders
-- (supabase/functions/auto-expire-cash-orders/index.ts step 3): the SAME outer
-- filter, then expire_web_layaway_atomic per row, skipping any row whose reply
-- is not ok. Emails are the edge function's business and are not modelled.
DROP FUNCTION IF EXISTS public.sweep();
CREATE FUNCTION public.sweep() RETURNS TABLE(ref text, result jsonb)
LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT la.id, la.web_reference AS wr FROM layaway_accounts la
     WHERE la.source_channel = 'web' AND la.status = 'active' AND la.total_paid = 0
       AND la.expired_at IS NULL AND la.transfer_due_at IS NOT NULL AND la.transfer_due_at < now()
     ORDER BY la.transfer_due_at LIMIT 100
  LOOP
    ref := r.wr;
    result := public.expire_web_layaway_atomic(r.id, 'system');
    RETURN NEXT;
  END LOOP;
END $$;

-- (website POST /layaway/quote, index.ts:518) keep working unchanged. Grants are
-- restored exactly as they were (PUBLIC included) — this is a pure calculator
-- with no customer data, and changing who may call it is not part of step 4.

DROP FUNCTION IF EXISTS public.layaway_quote(integer, integer, text);

CREATE FUNCTION public.layaway_quote(
  p_price        integer,
  p_term_months  integer,
  p_currency     text,
  p_order_date   date    DEFAULT CURRENT_DATE,
  p_shipping     integer DEFAULT 0,
  p_services     integer DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $$
DECLARE
  v_currency text := upper(coalesce(p_currency, 'JPY'));
  v_price    integer := coalesce(p_price, 0);
  v_shipping integer := greatest(coalesce(p_shipping, 0), 0);
  v_services integer := greatest(coalesce(p_services, 0), 0);
  v_total    integer;
  v_terms    jsonb;
  v_term     integer;
  v_label    text;
  v_dp_pct   numeric;
  v_deposit  integer;
  v_base     integer;
  v_rem      integer;
  v_schedule jsonb := '[]'::jsonb;
  v_max      integer;
  n          integer;
BEGIN
  IF p_price IS NULL OR p_price < 0 THEN
    RAISE EXCEPTION 'invalid price';
  END IF;
  IF v_currency NOT IN ('JPY', 'PHP') THEN
    RAISE EXCEPTION 'invalid currency';
  END IF;

  v_total := v_price + v_shipping + v_services;

  -- Every configured term, with the minimum that applies to THIS currency and
  -- whether this order clears it. The storefront renders exactly this list, so
  -- it can no longer offer a term the DB trigger would refuse.
  SELECT jsonb_agg(
           jsonb_build_object(
             'months',        pc.plan_months,
             'label',         pc.display_label,
             'min_amount',    CASE WHEN v_currency = 'JPY' THEN pc.min_amount_jpy ELSE pc.min_amount_php END,
             'dp_percentage', pc.dp_percentage,
             'eligible',      v_total >= CASE WHEN v_currency = 'JPY' THEN pc.min_amount_jpy ELSE pc.min_amount_php END
           ) ORDER BY pc.plan_months
         )
    INTO v_terms
    FROM plan_configurations pc
   WHERE pc.is_active;
  v_terms := coalesce(v_terms, '[]'::jsonb);

  -- The requested term if it is configured AND this order clears its minimum;
  -- otherwise the longest term the order does clear (3M has no minimum, so in
  -- practice there is always one).
  SELECT pc.plan_months, pc.display_label, pc.dp_percentage
    INTO v_term, v_label, v_dp_pct
    FROM plan_configurations pc
   WHERE pc.is_active
     AND pc.plan_months = p_term_months
     AND v_total >= CASE WHEN v_currency = 'JPY' THEN pc.min_amount_jpy ELSE pc.min_amount_php END;

  IF v_term IS NULL THEN
    SELECT pc.plan_months, pc.display_label, pc.dp_percentage
      INTO v_term, v_label, v_dp_pct
      FROM plan_configurations pc
     WHERE pc.is_active
       AND v_total >= CASE WHEN v_currency = 'JPY' THEN pc.min_amount_jpy ELSE pc.min_amount_php END
     ORDER BY pc.plan_months DESC
     LIMIT 1;
  END IF;

  SELECT max((t->>'months')::integer) INTO v_max
    FROM jsonb_array_elements(v_terms) t
   WHERE (t->>'eligible')::boolean;

  IF v_term IS NULL THEN
    -- Nothing is sellable at this amount. Say so plainly instead of quoting.
    RETURN jsonb_build_object(
      'currency', v_currency, 'price', v_price, 'shipping', v_shipping, 'services', v_services,
      'total', v_total, 'deposit', 0, 'down_payment', 0, 'term_months', NULL, 'monthly', 0,
      'max_term_months', v_max, 'allowed_terms', v_terms, 'schedule', '[]'::jsonb,
      'requested_term_months', p_term_months, 'term_downgraded', true,
      'order_date', p_order_date, 'eligible', false
    );
  END IF;

  -- DEPOSIT = dp_percentage of the TOTAL (product + shipping + services).
  -- Owner decision 2026-09-13. The loyalty base is a DIFFERENT figure — the
  -- product amount only, in yen — and is set by the caller, never here.
  v_deposit := round(v_total * v_dp_pct);

  -- Hub rounding: floor, remainder on the LAST row
  -- (create-layaway-account/index.ts:190-191). Never round() per row.
  v_base := floor((v_total - v_deposit)::numeric / v_term);
  v_rem  := (v_total - v_deposit) - (v_base * v_term);

  FOR n IN 1..v_term LOOP
    v_schedule := v_schedule || jsonb_build_object(
      'installment_number', n,
      -- n months from the ORIGINAL order date; Postgres clamps month-end.
      'due_date', (p_order_date + make_interval(months => n))::date,
      'amount', v_base + CASE WHEN n = v_term THEN v_rem ELSE 0 END
    );
  END LOOP;

  RETURN jsonb_build_object(
    'currency',        v_currency,
    'price',           v_price,
    'shipping',        v_shipping,
    'services',        v_services,
    'total',           v_total,
    'deposit',         v_deposit,
    'down_payment',    v_deposit,   -- legacy key: the live calculator reads this
    'term_months',     v_term,
    'term_label',      v_label,
    -- What the caller ASKED for, and whether this quote is that term. A
    -- browsing calculator may happily show the shorter plan the basket can
    -- actually have; a WRITE path must refuse rather than create a plan the
    -- customer never agreed to. create_web_layaway_atomic checks this.
    'requested_term_months', p_term_months,
    'term_downgraded',       (v_term IS DISTINCT FROM p_term_months),
    'monthly',         v_base,      -- legacy key: base instalment, not the last row
    'last_month',      v_base + v_rem,
    'max_term_months', v_max,
    'allowed_terms',   v_terms,
    'schedule',        v_schedule,
    'order_date',      p_order_date,
    'eligible',        true
  );
END $$;


-- ============================================================================
-- Shipping fees card + couriers — LOCAL tests for
-- 20261008100000_shipping_fees_couriers.sql. Run after the stub and the
-- migration (see the stub's header), once as a rebuild and once with
-- shipfees.as_live=yes. NEVER ON LIVE. Every block raises on failure; the last
-- line prints ALL PASSED.
-- ============================================================================
DO $g$ BEGIN
  IF coalesce(current_setting('shipfees.local_stub', true), '') <> 'yes' THEN
    RAISE EXCEPTION 'Refusing: local throwaway Postgres only (PGOPTIONS=-c shipfees.local_stub=yes)';
  END IF;
END $g$;

INSERT INTO public.user_roles VALUES ('00000000-0000-0000-0000-00000000000a', 'admin'),
                                     ('00000000-0000-0000-0000-00000000000b', 'staff');

-- ------------------------------------------------ 1. the card converged
DO $t$
DECLARE v text;
BEGIN
  SELECT string_agg(country || ':' || min_subtotal_jpy || '>' || fee_jpy || ':' || is_active, ' ' ORDER BY country, min_subtotal_jpy)
    INTO v FROM public.shipping_rates;
  IF v <> 'JP:0>800:true JP:8000>0:true PH:0>3500:true PH:100000>0:true' THEN
    RAISE EXCEPTION 'T1 card is %', v;
  END IF;
  IF (SELECT count(*) FROM public.audit_logs) <> 0 THEN RAISE EXCEPTION 'T1 the migration wrote an audit row'; END IF;
  RAISE NOTICE 'T1 ok: JP 0→800, JP 8000→0, PH untouched, no JP 50000 row';
END $t$;

-- ------------------------------------------------ 2. the guard
DO $t$
DECLARE ok boolean;
BEGIN
  ok := false; BEGIN INSERT INTO public.shipping_rates (country, min_subtotal_jpy, fee_jpy) VALUES ('US', 0, 5000);
  EXCEPTION WHEN raise_exception THEN ok := true; END;
  IF NOT ok THEN RAISE EXCEPTION 'T2 a direct INSERT got through'; END IF;
  ok := false; BEGIN UPDATE public.shipping_rates SET fee_jpy = 1 WHERE country = 'JP' AND min_subtotal_jpy = 0;
  EXCEPTION WHEN raise_exception THEN ok := true; END;
  IF NOT ok THEN RAISE EXCEPTION 'T2 a direct UPDATE got through'; END IF;
  ok := false; BEGIN DELETE FROM public.shipping_rates WHERE country = 'PH';
  EXCEPTION WHEN raise_exception THEN ok := true; END;
  IF NOT ok THEN RAISE EXCEPTION 'T2 a direct DELETE got through'; END IF;
  -- Even with the flag, a delete is refused.
  PERFORM set_config('app.allow_shipping_rates_change', 'on', true);
  ok := false; BEGIN DELETE FROM public.shipping_rates WHERE country = 'PH';
  EXCEPTION WHEN raise_exception THEN ok := true; END;
  PERFORM set_config('app.allow_shipping_rates_change', '', true);
  IF NOT ok THEN RAISE EXCEPTION 'T2 a flagged DELETE got through'; END IF;
  ok := false; BEGIN TRUNCATE public.shipping_rates;
  EXCEPTION WHEN raise_exception THEN ok := true; END;
  IF NOT ok THEN RAISE EXCEPTION 'T2 TRUNCATE got through'; END IF;
  IF (SELECT count(*) FROM public.shipping_rates) <> 4 THEN RAISE EXCEPTION 'T2 rows changed'; END IF;
  RAISE NOTICE 'T2 ok: direct insert/update refused; delete and truncate refused even with the flag';
END $t$;

-- ------------------------------------------------ 3. who may change it
DO $t$
DECLARE r jsonb;
BEGIN
  PERFORM set_config('test.uid', '', false);
  r := public.set_shipping_rate('JP', 0, 900);
  IF r ->> 'error' <> 'user_identity_required' THEN RAISE EXCEPTION 'T3 no session: %', r; END IF;
  PERFORM set_config('test.uid', '00000000-0000-0000-0000-00000000000b', false);
  r := public.set_shipping_rate('JP', 0, 900);
  IF r ->> 'error' <> 'permission_denied' THEN RAISE EXCEPTION 'T3 staff set: %', r; END IF;
  r := public.deactivate_shipping_rate((SELECT id FROM public.shipping_rates WHERE country = 'JP' AND min_subtotal_jpy = 0));
  IF r ->> 'error' <> 'permission_denied' THEN RAISE EXCEPTION 'T3 staff deactivate: %', r; END IF;
  r := public.get_shipping_rates();
  IF (r ->> 'can_change')::boolean OR jsonb_array_length(r -> 'rates') <> 4 THEN RAISE EXCEPTION 'T3 staff read: %', r; END IF;
  IF (SELECT fee_jpy FROM public.shipping_rates WHERE country = 'JP' AND min_subtotal_jpy = 0) <> 800 THEN
    RAISE EXCEPTION 'T3 a refused call changed the card';
  END IF;
  RAISE NOTICE 'T3 ok: no session / staff refused, staff can read';
END $t$;

-- ------------------------------------------------ 4. admin: validate, add, change, unchanged
DO $t$
DECLARE r jsonb;
BEGIN
  PERFORM set_config('test.uid', '00000000-0000-0000-0000-00000000000a', false);
  IF public.set_shipping_rate('Japan', 0, 1) ->> 'error' <> 'invalid_country' THEN RAISE EXCEPTION 'T4 country'; END IF;
  IF public.set_shipping_rate('JP', -1, 1) ->> 'error' <> 'invalid_threshold' THEN RAISE EXCEPTION 'T4 threshold'; END IF;
  IF public.set_shipping_rate('JP', 0, -5) ->> 'error' <> 'invalid_fee' THEN RAISE EXCEPTION 'T4 fee'; END IF;
  IF public.set_shipping_rate('JP', NULL, 5) ->> 'error' <> 'invalid_threshold' THEN RAISE EXCEPTION 'T4 null threshold'; END IF;

  r := public.set_shipping_rate(' us ', 0, 5000);
  IF r ->> 'action' <> 'created' OR r -> 'rate' ->> 'country' <> 'US' THEN RAISE EXCEPTION 'T4 create: %', r; END IF;
  r := public.set_shipping_rate('JP', 0, 900);
  IF r ->> 'action' <> 'fee_changed' OR (r -> 'rate' ->> 'fee_jpy')::int <> 900 THEN RAISE EXCEPTION 'T4 change: %', r; END IF;
  r := public.set_shipping_rate('JP', 0, 900);
  IF (r ->> 'changed')::boolean OR r ->> 'action' <> 'unchanged' THEN RAISE EXCEPTION 'T4 unchanged: %', r; END IF;
  IF (SELECT count(*) FROM public.audit_logs WHERE entity_type = 'shipping_rate' AND action = 'set_shipping_rate'
        AND performed_by_user_id = '00000000-0000-0000-0000-00000000000a') <> 2 THEN
    RAISE EXCEPTION 'T4 expected 2 audit rows';
  END IF;
  IF (SELECT (old_value_json ->> 'fee_jpy')::int FROM public.audit_logs WHERE new_value_json ->> 'change' = 'fee_changed') <> 800 THEN
    RAISE EXCEPTION 'T4 the audit row lost the old fee';
  END IF;
  RAISE NOTICE 'T4 ok: bad input refused; create, fee change audited; a no-op writes nothing';
END $t$;

-- ------------------------------------------------ 5. deactivate, then reactivate
DO $t$
DECLARE r jsonb; v_id uuid;
BEGIN
  PERFORM set_config('test.uid', '00000000-0000-0000-0000-00000000000a', false);
  SELECT id INTO v_id FROM public.shipping_rates WHERE country = 'US';
  r := public.deactivate_shipping_rate(v_id);
  IF r ->> 'action' <> 'deactivated' OR (SELECT is_active FROM public.shipping_rates WHERE id = v_id) THEN
    RAISE EXCEPTION 'T5 deactivate: %', r;
  END IF;
  r := public.deactivate_shipping_rate(v_id);
  IF (r ->> 'changed')::boolean THEN RAISE EXCEPTION 'T5 second deactivate changed: %', r; END IF;
  IF public.deactivate_shipping_rate(gen_random_uuid()) ->> 'error' <> 'not_found' THEN RAISE EXCEPTION 'T5 not_found'; END IF;
  r := public.set_shipping_rate('US', 0, 5500);
  IF r ->> 'action' <> 'reactivated' OR NOT (SELECT is_active FROM public.shipping_rates WHERE id = v_id) THEN
    RAISE EXCEPTION 'T5 reactivate: %', r;
  END IF;
  IF (SELECT count(*) FROM public.shipping_rates WHERE country = 'US') <> 1 THEN RAISE EXCEPTION 'T5 duplicate US row'; END IF;
  IF (SELECT count(*) FROM public.audit_logs WHERE action = 'deactivate_shipping_rate') <> 1 THEN
    RAISE EXCEPTION 'T5 expected 1 deactivate audit row';
  END IF;
  RAISE NOTICE 'T5 ok: deactivate once, audited; reactivate reuses the row';
END $t$;

-- ------------------------------------------------ 6. couriers + column
DO $t$
BEGIN
  IF (SELECT count(*) FROM public.shipping_methods) <> 6 THEN RAISE EXCEPTION 'T6 expected 6 couriers'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.shipping_methods p
                  WHERE p.provider_name = 'Pabitbit'
                    AND p.title = 'Pabitbit Service (Japan → Philippines, LBC local delivery)'
                    AND p.tracking_url_template = 'https://www.lbcexpress.com/ph/track/{tracking_code}'
                    AND p.supports_deeplink AND p.is_active AND p.sort_order = 6) THEN
    RAISE EXCEPTION 'T6 Pabitbit row is not as written';
  END IF;
  IF (SELECT count(*) FROM public.cash_orders WHERE planned_shipping_method_id IS NOT NULL)
   + (SELECT count(*) FROM public.layaway_accounts WHERE planned_shipping_method_id IS NOT NULL) <> 0 THEN
    RAISE EXCEPTION 'T6 an existing order got a planned courier';
  END IF;
  INSERT INTO public.cash_orders (invoice_number) VALUES ('900002');
  IF (SELECT planned_shipping_method_id FROM public.cash_orders WHERE invoice_number = '900002') IS NOT NULL THEN
    RAISE EXCEPTION 'T6 a new order got a default courier';
  END IF;
  UPDATE public.layaway_accounts SET planned_shipping_method_id = (SELECT id FROM public.shipping_methods WHERE provider_name = 'Pabitbit');
  BEGIN
    UPDATE public.cash_orders SET planned_shipping_method_id = gen_random_uuid();
    RAISE EXCEPTION 'T6 FK did not fire';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  RAISE NOTICE 'T6 ok: Pabitbit on the LBC template, last; planned courier nullable, no default, FK enforced';
END $t$;

-- ------------------------------------------------ 7. browser roles
DO $t$
BEGIN
  IF has_function_privilege('anon', 'public.set_shipping_rate(text,integer,integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.deactivate_shipping_rate(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_shipping_rates()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.guard_shipping_rates()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.set_shipping_rate(text,integer,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'T7 grants are wrong';
  END IF;
  RAISE NOTICE 'T7 ok: anon reaches nothing; authenticated reaches get/set/deactivate only';
END $t$;

DO $done$ BEGIN RAISE NOTICE 'ALL PASSED'; END $done$;

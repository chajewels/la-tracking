-- Cash on delivery (代金引換) acceptance (2026-10-10, migration 20261202100000_cod_checkout.sql).
-- NOT a migration — never applied to live. Runs on the local Postgres copy of the live schema
-- (live function bodies as of 2026-10-10, md5-verified) as an admin (auth.uid() from
-- request.jwt.claim.sub). One transaction, rolled back.
-- Expected after the migration: 39 passed, 0 failed. Before it (replay_l4_before): 1 passed, 38 failed/errored. Before it: the COD
-- columns, functions and patches do not exist, so the checks fail or error.
-- The customer-cannot-file-'cod' rule lives in the edge functions (the database records no
-- submitter identity); it is proven in development/cod-checkout.test.ts.
\set QUIET on
\set ON_ERROR_STOP off
\set ON_ERROR_ROLLBACK on
BEGIN;
CREATE TEMP TABLE t_results (n serial, name text, pass boolean, detail text);
CREATE FUNCTION pg_temp.ok(p_cond boolean, p_name text, p_detail text DEFAULT NULL) RETURNS void LANGUAGE sql AS
$$ INSERT INTO t_results (name, pass, detail) VALUES (p_name, coalesce(p_cond, false), p_detail) $$;
CREATE FUNCTION pg_temp.try(p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb; BEGIN EXECUTE p_sql INTO r; RETURN r; EXCEPTION WHEN others THEN RETURN jsonb_build_object('raised', SQLERRM); END $$;

-- ================================================================ fixtures
INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-0000-0000-00000000c0a1', 'cod-admin@example.com'),
  ('00000000-0000-0000-0000-00000000c0a2', 'cod-staff@example.com');
INSERT INTO public.user_roles (user_id, role) VALUES ('00000000-0000-0000-0000-00000000c0a1', 'admin');
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c0a1', false);
INSERT INTO public.system_settings (key, value) VALUES ('loyalty_enabled', 'true'::jsonb) ON CONFLICT (key) DO NOTHING;
INSERT INTO public.customers (id, full_name, email, mobile_number) VALUES
  ('00000000-0000-0000-0000-00000000c0c1', 'COD Customer', 'cod@example.com', '09011112222');
INSERT INTO public.customer_addresses (id, customer_id, line1, city, country) VALUES
  ('00000000-0000-0000-0000-00000000c0d1', '00000000-0000-0000-0000-00000000c0c1', '1-1 Tateishi', 'Katsushika', 'JP'),
  ('00000000-0000-0000-0000-00000000c0d2', '00000000-0000-0000-0000-00000000c0c1', '1 Ayala Ave', 'Makati', 'PH');

-- One active product + variant per quote, so each quote holds its own piece.
CREATE FUNCTION pg_temp.quote(p_tag text, p_price integer, p_method text, p_points integer DEFAULT 0,
                              p_mode text DEFAULT 'full', p_cur text DEFAULT 'JPY', p_addr text DEFAULT '00000000-0000-0000-0000-00000000c0d1')
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_p uuid := gen_random_uuid(); v_v uuid := gen_random_uuid(); v_q uuid := gen_random_uuid(); v_ship integer;
BEGIN
  INSERT INTO public.website_products (id, sku, slug, name, status, item_kind) VALUES (v_p, 'COD-' || p_tag, 'cod-' || lower(p_tag), 'COD piece ' || p_tag, 'active', 'accessory');
  INSERT INTO public.website_product_variants (id, product_id, price_jpy, stock_qty) VALUES (v_v, v_p, p_price, 1);
  v_ship := CASE WHEN p_addr = '00000000-0000-0000-0000-00000000c0d2' THEN 3500 WHEN p_price >= 8000 THEN 0 ELSE 800 END;
  INSERT INTO public.checkout_quotes (id, customer_id, items, mode, term_months, ship_to_address_id, subtotal_jpy, shipping_jpy, total_jpy,
                                      expires_at, settlement_currency, fx_rate, fx_rate_date, payment_method, points)
  VALUES (v_q, '00000000-0000-0000-0000-00000000c0c1', jsonb_build_array(jsonb_build_object('variant_id', v_v, 'qty', 1, 'unit_price_jpy', p_price)),
          p_mode, CASE WHEN p_mode = 'layaway' THEN 3 END, p_addr::uuid, p_price, v_ship, p_price + v_ship,
          now() + interval '30 minutes', p_cur, CASE WHEN p_cur = 'PHP' THEN 0.38 END, CASE WHEN p_cur = 'PHP' THEN current_date END,
          p_method, p_points);
  RETURN v_q;
END $$;
CREATE FUNCTION pg_temp.draft(p_quote uuid, p_layaway boolean DEFAULT false) RETURNS jsonb LANGUAGE sql AS $$
  SELECT pg_temp.try(format('SELECT public.create_web_draft_atomic(%L, %L, %L, %L, %L)', '00000000-0000-0000-0000-00000000c0c1', p_quote, 'ja',
                            CASE WHEN p_layaway THEN 'v1' END, CASE WHEN p_layaway THEN now() END)) $$;
CREATE FUNCTION pg_temp.confirm(p_draft uuid, p_order jsonb) RETURNS jsonb LANGUAGE sql AS $$
  SELECT pg_temp.try(format('SELECT public.materialize_web_draft_atomic(%L, %L, %L::jsonb, NULL, %L::jsonb)',
                            p_draft, '00000000-0000-0000-0000-00000000c0a1', p_order, '[]')) $$;

-- ================================================================ 1. the fee rule (inclusive brackets, limit)
SELECT pg_temp.ok(public.cod_fee_jpy(1) = 1040 AND public.cod_fee_jpy(10000) = 1040, 'fee: ≤¥10,000 → ¥1,040 (¥1 and ¥10,000)');
SELECT pg_temp.ok(public.cod_fee_jpy(10001) = 1150 AND public.cod_fee_jpy(30000) = 1150, 'fee: ¥10,001–¥30,000 → ¥1,150');
SELECT pg_temp.ok(public.cod_fee_jpy(30001) = 1370 AND public.cod_fee_jpy(100000) = 1370, 'fee: ¥30,001–¥100,000 → ¥1,370');
SELECT pg_temp.ok(public.cod_fee_jpy(100001) = 1810 AND public.cod_fee_jpy(300000) = 1810, 'fee: ¥100,001–¥300,000 → ¥1,810');
SELECT pg_temp.ok(public.cod_fee_jpy(300001) IS NULL AND public.cod_limit_jpy() = 300000, 'limit: ¥300,001 → no COD; limit ¥300,000');
SELECT pg_temp.ok(public.cod_fee_jpy(0) IS NULL AND public.cod_fee_jpy(-5) IS NULL AND public.cod_fee_jpy(NULL) IS NULL, 'nothing to collect → no COD');

-- ================================================================ 2. the switch (fail-closed, admin-only, audited, guarded)
SELECT pg_temp.ok(public.cod_mode() = 'off', 'cod_mode is seeded off');
SELECT pg_temp.ok((pg_temp.try($q$WITH x AS (UPDATE public.system_settings SET value = '"on"' WHERE key = 'cod_mode' RETURNING 1) SELECT to_jsonb(count(*)) FROM x$q$) ->> 'raised') LIKE '%set_cod_settings%',
                  'a direct UPDATE of cod_mode is refused by the guard');
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c0a2', false);
SELECT pg_temp.ok(public.set_cod_settings('on') ->> 'error' = 'permission_denied', 'a non-admin cannot switch COD on');
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c0a1', false);
SELECT pg_temp.ok(public.set_cod_settings('on', '[{"max_jpy":30000,"fee_jpy":1},{"max_jpy":10000,"fee_jpy":2}]'::jsonb) ->> 'error' = 'invalid_fee_table',
                  'a fee table out of order is refused');
SELECT pg_temp.ok(public.set_cod_settings('on', NULL, 'on') ->> 'error' = 'stale', 'a stale expected mode is refused');
-- cod_mode "nonsense" can only be reached past the guard; fail-closed reader proven by the CASE.
CREATE TEMP TABLE t_on AS SELECT public.set_cod_settings('on', NULL, 'off') AS r;
SELECT pg_temp.ok((SELECT (r ->> 'ok')::boolean FROM t_on) AND public.cod_mode() = 'on'
                  AND EXISTS (SELECT 1 FROM public.audit_logs WHERE action = 'set_cod_settings' AND new_value_json ->> 'mode' = 'on'),
                  'the admin switches COD on through set_cod_settings, audited');

-- ================================================================ 3. eligibility at checkout (create_web_draft_atomic)
SELECT pg_temp.ok(pg_temp.draft(pg_temp.quote('LAY', 20000, 'cod', 0, 'layaway'), true) ->> 'error' = 'method_full_payment_only', 'refused: layaway');
SELECT pg_temp.ok(pg_temp.draft(pg_temp.quote('PHP', 20000, 'cod', 0, 'full', 'PHP')) ->> 'error' = 'method_requires_yen', 'refused: pesos');
SELECT pg_temp.ok(pg_temp.draft(pg_temp.quote('ABR', 20000, 'cod', 0, 'full', 'JPY', '00000000-0000-0000-0000-00000000c0d2')) ->> 'error' = 'method_unavailable', 'refused: delivery outside Japan');
SELECT pg_temp.ok(pg_temp.draft(pg_temp.quote('OVR', 300001, 'cod')) ->> 'error' = 'over_cod_limit', 'refused: ¥300,001 collected is over the limit');
CREATE TEMP TABLE t_top AS SELECT pg_temp.draft(pg_temp.quote('TOP', 300000, 'cod')) AS r;
SELECT pg_temp.ok((SELECT (r ->> 'cod_fee')::int = 1810 AND (r ->> 'total')::numeric = 301810 FROM t_top),
                  'allowed: ¥300,000 collected; the ¥1,810 fee is not counted in the limit (courier collects ¥301,810)', (SELECT left(r::text, 300) FROM t_top));
SELECT set_config('app.allow_cod_settings_change', 'on', false);
UPDATE public.system_settings SET value = '"off"' WHERE key = 'cod_mode';
SELECT set_config('app.allow_cod_settings_change', '', false);
SELECT pg_temp.ok(pg_temp.draft(pg_temp.quote('OFF', 20000, 'cod')) ->> 'error' = 'method_unavailable', 'refused: COD switched off');
SELECT set_config('app.allow_cod_settings_change', 'on', false);
UPDATE public.system_settings SET value = '"ON"' WHERE key = 'cod_mode';
SELECT pg_temp.ok(public.cod_mode() = 'off', 'fail-closed: any value but "on" reads as off');
UPDATE public.system_settings SET value = '"on"' WHERE key = 'cod_mode';
SELECT set_config('app.allow_cod_settings_change', '', false);

-- ================================================================ 4. a COD draft: fee on its own line, in the total, on the quote
CREATE TEMP TABLE t_q AS SELECT pg_temp.quote('A', 20000, 'cod') AS q;
CREATE TEMP TABLE t_d AS SELECT pg_temp.draft((SELECT q FROM t_q)) AS r;
SELECT pg_temp.ok((SELECT (r ->> 'cod_fee')::int = 1150 AND (r ->> 'total')::numeric = 21150 AND r ->> 'payment_method' = 'cod' FROM t_d)
                  AND (SELECT cod_fee_jpy = 1150 AND cod_fee = 1150 AND total = 21150 AND total_jpy = 21150 AND subtotal = 20000
                         FROM public.web_order_drafts WHERE id = (SELECT (r ->> 'draft_id')::uuid FROM t_d))
                  AND (SELECT cod_fee_jpy = 1150 FROM public.checkout_quotes WHERE id = (SELECT q FROM t_q)),
                  'draft: ¥20,000 pieces + free shipping → ¥1,150 fee, total ¥21,150; quote stamped', (SELECT left(r::text, 300) FROM t_d));

-- ================================================================ 5. Confirm: no deadline, fee re-checked, loyalty excludes the fee
SELECT pg_temp.ok(pg_temp.confirm((SELECT (r ->> 'draft_id')::uuid FROM t_d),
                  '{"total_amount":21150,"shipping_fee":0,"cod_fee":1040}'::jsonb) ->> 'error' = 'cod_fee_mismatch',
                  'Confirm refuses a fee that is not the bracket for the amount collected');
SELECT pg_temp.ok(pg_temp.confirm((SELECT (r ->> 'draft_id')::uuid FROM t_d),
                  '{"total_amount":20000,"shipping_fee":0}'::jsonb) ->> 'error' = 'cod_fee_mismatch',
                  'Confirm refuses a COD order without its fee');
CREATE TEMP TABLE t_c AS SELECT pg_temp.confirm((SELECT (r ->> 'draft_id')::uuid FROM t_d),
                  '{"total_amount":21150,"shipping_fee":0,"cod_fee":1150}'::jsonb) AS r;
CREATE TEMP TABLE t_o AS SELECT * FROM public.cash_orders WHERE id = (SELECT (r ->> 'order_id')::uuid FROM t_c);
SELECT pg_temp.ok((SELECT payment_method = 'cod' AND cod_fee = 1150 AND total_amount = 21150 AND remaining_balance = 21150
                          AND transfer_due_at IS NULL AND expires_at IS NULL FROM t_o),
                  'Confirm with NO deadline: cash order cod, fee ¥1,150 in total and remaining, no deadline', (SELECT left(r::text, 300) FROM t_c));
SELECT pg_temp.ok((SELECT loyalty_jpy_amount = 20000 FROM t_o), 'loyalty basis = pieces (¥20,000) — the COD fee is never in it');
-- regression: a transfer draft still needs a deadline, and may not carry a COD fee
CREATE TEMP TABLE t_dt AS SELECT pg_temp.draft(pg_temp.quote('T', 20000, 'transfer')) AS r;
SELECT pg_temp.ok(pg_temp.confirm((SELECT (r ->> 'draft_id')::uuid FROM t_dt), '{"total_amount":20000,"shipping_fee":0}'::jsonb) ->> 'error' = 'deadline_required',
                  'regression: a transfer Confirm without a deadline is still refused');
SELECT pg_temp.ok(pg_temp.confirm((SELECT (r ->> 'draft_id')::uuid FROM t_dt),
                  jsonb_build_object('total_amount', 21150, 'shipping_fee', 0, 'cod_fee', 1150, 'transfer_due_at', now() + interval '1 day')) ->> 'error' = 'cod_fee_not_cod',
                  'a transfer order never carries a COD fee');

-- ================================================================ 6. no lapse, no automated cancel; staff cancel returns stock
UPDATE public.cash_orders SET transfer_due_at = now() - interval '1 hour', expires_at = now() - interval '1 hour'
 WHERE id = (SELECT id FROM t_o);
SELECT pg_temp.ok(pg_temp.try(format('SELECT public.expire_web_order_atomic(%L)', (SELECT id FROM t_o))) ->> 'reason' = 'cod_no_deadline',
                  'expiry sweep (expire_web_order_atomic) never lapses a COD order, even with a past date on it');
SELECT pg_temp.ok(pg_temp.try(format('SELECT public.terminate_web_order_atomic(%L, %L, NULL, NULL, NULL, NULL, NULL, %L, false)', (SELECT id FROM t_o), 'cancelled', 'system')) ->> 'reason' = 'cod_no_deadline',
                  'no automated (system) cancel of a COD order');

-- ================================================================ 7. no transfer reminder for COD
UPDATE public.cash_orders SET transfer_due_at = now() + interval '3 hours', ready_confirmed_at = now() - interval '21 hours'
 WHERE id = (SELECT id FROM t_o);
SELECT pg_temp.ok(NOT EXISTS (SELECT 1 FROM public.web_payment_reminder_eligible('cash_order', (SELECT id FROM t_o))),
                  'web_payment_reminder_eligible skips a COD order inside the reminder window');

-- ================================================================ 8. switching re-brackets; total and remaining move by the fee delta
CREATE TEMP TABLE t_s1 AS SELECT pg_temp.try(format('SELECT public.change_web_payment_method_atomic(%L, %L, %L, %L, %L)',
  'cash_order', (SELECT id FROM t_o), 'transfer', 'customer asked', '00000000-0000-0000-0000-00000000c0a1')) AS r;
SELECT pg_temp.ok((SELECT payment_method = 'transfer' AND cod_fee = 0 AND total_amount = 20000 AND remaining_balance = 20000
                     FROM public.cash_orders WHERE id = (SELECT id FROM t_o))
                  AND (SELECT (r ->> 'fee_delta')::int = -1150 FROM t_s1),
                  'staff COD → transfer removes the ¥1,150 fee from total and remaining', (SELECT left(r::text, 300) FROM t_s1));
SELECT pg_temp.ok(EXISTS (SELECT 1 FROM public.web_payment_reminder_eligible('cash_order', (SELECT id FROM t_o))),
                  'control: the same order on transfer IS reminded');
CREATE TEMP TABLE t_s2 AS SELECT pg_temp.try(format('SELECT public.change_web_payment_method_atomic(%L, %L, %L, %L, %L)',
  'cash_order', (SELECT id FROM t_o), 'cod', 'customer asked', '00000000-0000-0000-0000-00000000c0a1')) AS r;
SELECT pg_temp.ok((SELECT payment_method = 'cod' AND cod_fee = 1150 AND total_amount = 21150 AND remaining_balance = 21150
                     FROM public.cash_orders WHERE id = (SELECT id FROM t_o))
                  AND (SELECT (r ->> 'fee_delta')::int = 1150 FROM t_s2),
                  'staff transfer → COD adds the bracketed fee to total and remaining', (SELECT left(r::text, 300) FROM t_s2));
-- a draft: transfer → COD adds the fee to the provisional total
SELECT pg_temp.try(format('SELECT public.change_web_payment_method_atomic(%L, %L, %L, %L, %L)',
  'draft', (SELECT (r ->> 'draft_id')::uuid FROM t_dt), 'cod', 'phone call', '00000000-0000-0000-0000-00000000c0a1'));
SELECT pg_temp.ok((SELECT payment_method = 'cod' AND cod_fee_jpy = 1150 AND total = 21150 AND total_jpy = 21150
                     FROM public.web_order_drafts WHERE id = (SELECT (r ->> 'draft_id')::uuid FROM t_dt)),
                  'staff switches a draft to COD: fee ¥1,150 added to the draft total');
-- a switch that would go over the limit is refused
CREATE TEMP TABLE t_big AS SELECT pg_temp.draft(pg_temp.quote('BIG', 300001, 'transfer')) AS r;
SELECT pg_temp.ok(pg_temp.try(format('SELECT public.change_web_payment_method_atomic(%L, %L, %L, %L, %L)',
  'draft', (SELECT (r ->> 'draft_id')::uuid FROM t_big), 'cod', 'x', '00000000-0000-0000-0000-00000000c0a1')) ->> 'error' = 'over_cod_limit',
                  'switching to COD over the limit is refused');
-- the customer's own switch after a rejected payment (C1 exception)
INSERT INTO public.payment_submissions (customer_id, cash_order_id, submitted_amount, payment_date, payment_method, sender_name, status, submission_type, proof_url, updated_at)
VALUES ('00000000-0000-0000-0000-00000000c0c1', (SELECT id FROM t_o), 21150, current_date, 'cod', 'Courier', 'rejected', 'cash_payment', 'https://pfoicalpzdcmyxzvwyhz.supabase.co/storage/v1/object/public/payment-proofs/cod-test.jpg', now() - interval '1 minute');
CREATE TEMP TABLE t_cs AS SELECT pg_temp.try(format('SELECT public.switch_web_payment_method_by_customer_atomic(%L, %L, %L)',
  (SELECT id FROM t_o), '00000000-0000-0000-0000-00000000c0c1', 'transfer')) AS r;
SELECT pg_temp.ok((SELECT payment_method = 'transfer' AND cod_fee = 0 AND total_amount = 20000 AND remaining_balance = 20000
                     FROM public.cash_orders WHERE id = (SELECT id FROM t_o)),
                  'customer switch COD → transfer removes the fee', (SELECT left(r::text, 300) FROM t_cs));
INSERT INTO public.payment_submissions (customer_id, cash_order_id, submitted_amount, payment_date, payment_method, sender_name, status, submission_type, proof_url, updated_at)
VALUES ('00000000-0000-0000-0000-00000000c0c1', (SELECT id FROM t_o), 20000, current_date, 'bank_transfer', 'Her', 'rejected', 'cash_payment', 'https://pfoicalpzdcmyxzvwyhz.supabase.co/storage/v1/object/public/payment-proofs/cod-test.jpg', now() + interval '1 minute');
CREATE TEMP TABLE t_cs2 AS SELECT pg_temp.try(format('SELECT public.switch_web_payment_method_by_customer_atomic(%L, %L, %L)',
  (SELECT id FROM t_o), '00000000-0000-0000-0000-00000000c0c1', 'cod')) AS r;
SELECT pg_temp.ok((SELECT payment_method = 'cod' AND cod_fee = 1150 AND total_amount = 21150 AND remaining_balance = 21150
                     FROM public.cash_orders WHERE id = (SELECT id FROM t_o)),
                  'customer switch transfer → COD adds the fee', (SELECT left(r::text, 300) FROM t_cs2));

-- staff cancel (refused parcel): allowed, stock back on sale
CREATE TEMP TABLE t_x AS SELECT pg_temp.try(format('SELECT public.terminate_web_order_atomic(%L, %L, %L, %L, %L, NULL, NULL, %L, false)',
  (SELECT id FROM t_o), 'cancelled', 'Parcel refused', '00000000-0000-0000-0000-00000000c0a1', 'cod-admin@example.com', 'staff')) AS r;
SELECT pg_temp.ok((SELECT (r ->> 'ok')::boolean FROM t_x)
                  AND (SELECT status = 'cancelled' FROM public.cash_orders WHERE id = (SELECT id FROM t_o))
                  AND (SELECT v.stock_qty = 1 FROM public.website_product_variants v JOIN public.website_products p ON p.id = v.product_id WHERE p.sku = 'COD-A'),
                  'staff cancel of a COD order (refused parcel) works and returns the stock', (SELECT left(r::text, 300) FROM t_x));

-- ================================================================ 9. points never pay the fee (or shipping)
INSERT INTO public.loyalty_members (customer_id, earned_tier_id, current_tier_id, remaining_points)
SELECT '00000000-0000-0000-0000-00000000c0c1'::uuid, id, id, 50000 FROM public.loyalty_tiers ORDER BY 1 LIMIT 1;
CREATE TEMP TABLE t_p AS SELECT pg_temp.draft(pg_temp.quote('P', 5000, 'cod', 5000)) AS r;
SELECT pg_temp.ok((SELECT (r ->> 'points_value')::numeric = 5000 AND (r ->> 'cod_fee')::int = 1040 AND (r ->> 'total')::numeric = 6840 FROM t_p),
                  'points pay the ¥5,000 pieces only: ¥800 shipping + ¥1,040 fee (on ¥800 collected) stay to pay', (SELECT left(r::text, 300) FROM t_p));
SELECT pg_temp.ok(pg_temp.draft(pg_temp.quote('P0', 9000, 'cod', 9000)) ->> 'error' = 'cod_nothing_to_collect',
                  'points covering everything (free shipping) leave nothing for the courier: COD refused, never "points pay the fee"');

SELECT n, CASE WHEN pass THEN 'PASS' ELSE 'FAIL' END AS result, name, CASE WHEN pass THEN NULL ELSE detail END AS detail FROM t_results ORDER BY n;
SELECT count(*) FILTER (WHERE pass) AS passed, 39 - count(*) FILTER (WHERE pass) AS failed_or_errored, 39 AS expected_checks FROM t_results;
ROLLBACK;

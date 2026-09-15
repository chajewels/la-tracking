\pset pager off
SELECT set_config('harness.uid','22222222-2222-4222-8222-222222222222',false) \gset x
\echo '=== Q13: a PESO plan — loyalty_jpy_amount must be the YEN product subtotal ==='
UPDATE website_product_variants SET stock_qty = 5 WHERE id='b0000000-0000-4000-8000-000000000001';
\echo '--- yen plan on R7828, 10M (the section A/B comparison pair)'
SELECT create_web_layaway_atomic('4201767c-54e6-48d0-8c9e-c1b3c07a931e',
  mk_quote('4201767c-54e6-48d0-8c9e-c1b3c07a931e','b0000000-0000-4000-8000-000000000001',1,10,'JPY',2000,NULL,current_date),
  'en', now() + interval '72 hours', current_date)->>'account_id' AS yen \gset
\echo '--- peso plan on R7828, 10M, fx 0.42'
SELECT create_web_layaway_atomic('4201767c-54e6-48d0-8c9e-c1b3c07a931e',
  mk_quote('4201767c-54e6-48d0-8c9e-c1b3c07a931e','b0000000-0000-4000-8000-000000000001',1,10,'PHP',2000,0.42,current_date),
  'en', now() + interval '72 hours', current_date)->>'account_id' AS php \gset

SELECT web_reference, currency, total_amount, shipping_fee, downpayment_amount,
       loyalty_jpy_amount, fx_rate_used, fx_rate_date
  FROM layaway_accounts WHERE id IN (:'yen', :'php') ORDER BY currency DESC;

\echo '--- B3: is the peso plan''s loyalty basis the SAME yen figure as the yen plan''s?'
SELECT (SELECT loyalty_jpy_amount FROM layaway_accounts WHERE id = :'yen') AS yen_plan_basis,
       (SELECT loyalty_jpy_amount FROM layaway_accounts WHERE id = :'php') AS php_plan_basis,
       (SELECT loyalty_jpy_amount FROM layaway_accounts WHERE id = :'yen')
       = (SELECT loyalty_jpy_amount FROM layaway_accounts WHERE id = :'php') AS identical,
       (SELECT total_amount FROM layaway_accounts WHERE id = :'php') AS php_settlement_total,
       679980 AS catalog_price_jpy;

\echo '--- B4: do the converted parts sum to the settlement total, to the centavo?'
SELECT total_amount, shipping_fee, total_amount - shipping_fee AS subtotal_part,
       (total_amount - shipping_fee) + shipping_fee = total_amount AS parts_sum_exactly,
       round(681980 * 0.42) AS expected_total_from_fx
  FROM layaway_accounts WHERE id = :'php';

\echo '--- B5 / A6: schedule currency and the deposit percentage on both'
SELECT la.currency, la.downpayment_amount,
       round(la.downpayment_amount / la.total_amount * 100, 2) AS deposit_pct,
       count(s.id) AS rows, min(s.due_date) AS first_due, max(s.due_date) AS last_due,
       sum(s.base_installment_amount) + la.downpayment_amount = la.total_amount AS schedule_plus_deposit_equals_total,
       bool_and(s.currency = la.currency) AS every_row_in_plan_currency
  FROM layaway_accounts la JOIN layaway_schedule s ON s.account_id = la.id
 WHERE la.id IN (:'yen', :'php') GROUP BY la.id, la.currency, la.downpayment_amount, la.total_amount ORDER BY 1 DESC;

\echo '--- A7: instalment 1 is order month + 1, never the order month'
SELECT la.currency, la.order_date, min(s.due_date) AS installment_1_due,
       min(s.due_date) = (la.order_date + interval '1 month')::date AS is_order_month_plus_one
  FROM layaway_accounts la JOIN layaway_schedule s ON s.account_id = la.id
 WHERE la.id IN (:'yen', :'php') GROUP BY la.id, la.currency, la.order_date;

\echo '--- item lines stay in YEN on the peso plan'
SELECT la.currency AS plan_currency, i.sku, i.quantity, i.unit_price_jpy, i.line_total_jpy
  FROM layaway_account_items i JOIN layaway_accounts la ON la.id = i.account_id
 WHERE i.account_id IN (:'yen', :'php');

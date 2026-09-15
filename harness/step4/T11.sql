\pset pager off
SELECT set_config('harness.uid','22222222-2222-4222-8222-222222222222',false) \gset x
\echo '=== Q11: deposit PAID, instalments now OVERDUE — what does the sweep do? ==='
SELECT create_web_layaway_atomic('4201767c-54e6-48d0-8c9e-c1b3c07a931e',
  mk_quote('4201767c-54e6-48d0-8c9e-c1b3c07a931e','b0000000-0000-4000-8000-000000000002',1,6,'JPY',2000,NULL,current_date - 120),
  'en', now() - interval '110 days', (current_date - 120))->>'account_id' AS a11 \gset
INSERT INTO payments (account_id, amount_paid, currency, date_paid, payment_method, reference_number, remarks)
  VALUES (:'a11', 22494, 'JPY', current_date - 118, 'bank_transfer', 'DP-Q11', 'downpayment received');
UPDATE layaway_accounts SET total_paid=22494, remaining_balance=total_amount-22494, status='overdue' WHERE id = :'a11';
UPDATE layaway_schedule SET status='overdue' WHERE account_id = :'a11' AND due_date < current_date;
SELECT stock_qty AS s11 FROM website_product_variants WHERE id='b0000000-0000-4000-8000-000000000002' \gset
SELECT invoice_number, status, total_paid, transfer_due_at < now() AS deadline_passed,
       (SELECT count(*) FROM layaway_schedule s WHERE s.account_id = la.id AND s.status='overdue') AS overdue_rows
  FROM layaway_accounts la WHERE id = :'a11';

\echo '--- run the sweep. This plan MUST NOT be touched.'
SELECT * FROM sweep();
SELECT status, expired_at, total_paid FROM layaway_accounts WHERE id = :'a11';
SELECT status::text, count(*) FROM layaway_schedule WHERE account_id = :'a11' GROUP BY 1 ORDER BY 1;
SELECT stock_qty AS stock_unchanged, :s11 AS expected FROM website_product_variants WHERE id='b0000000-0000-4000-8000-000000000002';

\echo '--- which of the sweep filters excluded it? (both, independently)'
SELECT status::text <> 'active' AS excluded_by_status, total_paid <> 0 AS excluded_by_total_paid
  FROM layaway_accounts WHERE id = :'a11';
\echo '--- and if something called the RPC on it directly anyway:'
SELECT expire_web_layaway_atomic(:'a11','system') AS direct_call;

\echo ''
\echo '=== Q11b: the same plan back in status active but still holding a deposit ==='
UPDATE layaway_accounts SET status='active' WHERE id = :'a11';
SELECT * FROM sweep();
SELECT status FROM layaway_accounts WHERE id = :'a11';

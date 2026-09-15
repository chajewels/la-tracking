\pset pager off
SELECT set_config('harness.uid','22222222-2222-4222-8222-222222222222',false) \gset x
SELECT stock_qty AS s0 FROM website_product_variants WHERE id='b0000000-0000-4000-8000-000000000002' \gset

\echo '=== Q9: a plan with a CONFIRMED payment, past its deadline ==='
SELECT create_web_layaway_atomic('4201767c-54e6-48d0-8c9e-c1b3c07a931e',
  mk_quote('4201767c-54e6-48d0-8c9e-c1b3c07a931e','b0000000-0000-4000-8000-000000000002',1,6,'JPY',2000,NULL,current_date),
  'en', now() - interval '3 hours', current_date)->>'account_id' AS a9 \gset
INSERT INTO payments (account_id, amount_paid, currency, date_paid, payment_method, reference_number, remarks)
  VALUES (:'a9', 22494, 'JPY', current_date, 'bank_transfer', 'DP-Q9', 'downpayment received');
UPDATE layaway_accounts SET total_paid=22494, remaining_balance=total_amount-22494 WHERE id = :'a9';
\echo '--- direct call (what the sweep would do if it reached it):'
SELECT expire_web_layaway_atomic(:'a9','system') AS result;
\echo '--- and does the sweep even select it?'
SELECT count(*) AS sweep_selects FROM layaway_accounts la WHERE la.id = :'a9'
  AND la.source_channel='web' AND la.status='active' AND la.total_paid=0 AND la.expired_at IS NULL AND la.transfer_due_at < now();
\echo '--- the OTHER guard: total_paid cache zeroed but the ledger row still live'
UPDATE layaway_accounts SET total_paid=0 WHERE id = :'a9';
SELECT expire_web_layaway_atomic(:'a9','system') AS result_with_stale_cache;
SELECT status, expired_at FROM layaway_accounts WHERE id = :'a9';

\echo ''
\echo '=== Q10: INVARIANT 12 — an UNREVIEWED submission, past the deadline ==='
SELECT create_web_layaway_atomic('4201767c-54e6-48d0-8c9e-c1b3c07a931e',
  mk_quote('4201767c-54e6-48d0-8c9e-c1b3c07a931e','b0000000-0000-4000-8000-000000000002',1,6,'JPY',2000,NULL,current_date),
  'en', now() - interval '4 hours', current_date)->>'account_id' AS a10 \gset
SELECT stock_qty AS s10 FROM website_product_variants WHERE id='b0000000-0000-4000-8000-000000000002' \gset
INSERT INTO payment_submissions (customer_id, account_id, submitted_amount, payment_date, payment_method, proof_url, status, submission_type)
  VALUES ('4201767c-54e6-48d0-8c9e-c1b3c07a931e', :'a10', 22494, current_date, 'bank_transfer', 'https://example/proof.jpg', 'submitted', 'downpayment');
\echo '--- sweep:'
SELECT * FROM sweep();
\echo '--- plan state: must be untouched'
SELECT status, expired_at, total_paid FROM layaway_accounts WHERE id = :'a10';
SELECT status::text, count(*) FROM layaway_schedule WHERE account_id = :'a10' GROUP BY 1;
SELECT stock_qty AS stock_still_held, :s10 AS expected FROM website_product_variants WHERE id='b0000000-0000-4000-8000-000000000002';
SELECT count(*) AS audit_rows FROM audit_logs WHERE entity_id = :'a10' AND action='web_layaway_expired';
\echo '--- and under_review, the other frozen status:'
UPDATE payment_submissions SET status='under_review' WHERE account_id = :'a10';
SELECT expire_web_layaway_atomic(:'a10','system') AS under_review_result;
\echo '--- now REJECT it and sweep again (F4: the freeze is on automation, not on people)'
UPDATE payment_submissions SET status='rejected' WHERE account_id = :'a10';
SELECT * FROM sweep();
SELECT status, expired_at IS NOT NULL AS stamped FROM layaway_accounts WHERE id = :'a10';
SELECT stock_qty AS stock_returned FROM website_product_variants WHERE id='b0000000-0000-4000-8000-000000000002';

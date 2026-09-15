\pset pager off
SELECT set_config('harness.uid','22222222-2222-4222-8222-222222222222',false) \gset x
\echo '=== SETUP: a yen plan, then CONFIRM its deposit (payment row + totals), as review-payment-submission does ==='
SELECT create_web_layaway_atomic('4201767c-54e6-48d0-8c9e-c1b3c07a931e',
  mk_quote('4201767c-54e6-48d0-8c9e-c1b3c07a931e','b0000000-0000-4000-8000-000000000002',1,6,'JPY',2000,NULL,current_date),
  'en', now() + interval '72 hours', current_date)->>'account_id' AS acct \gset
INSERT INTO payments (account_id, amount_paid, currency, date_paid, payment_method, reference_number, remarks)
  VALUES (:'acct', 22494, 'JPY', current_date, 'bank_transfer', 'DP-HARNESS-1', 'downpayment received');
UPDATE layaway_accounts SET total_paid = 22494, remaining_balance = total_amount - 22494 WHERE id = :'acct';
SELECT status, total_paid, transfer_due_at FROM layaway_accounts WHERE id = :'acct';

\echo ''
\echo '=== Q2: move the deadline on a plan whose DEPOSIT IS ALREADY CONFIRMED ==='
SELECT set_account_deadlines('layaway', :'acct', now() + interval '30 days', 'testing a paid plan', '22222222-2222-4222-8222-222222222222') AS rpc_result;
\echo '--- did the column actually move?'
SELECT status, total_paid, transfer_due_at FROM layaway_accounts WHERE id = :'acct';
\echo '--- and did an audit row get written for it?'
SELECT count(*) AS deadlines_updated_rows FROM audit_logs WHERE entity_id = :'acct' AND action='deadlines_updated';
\echo '--- would the expiry sweep ever read this date again? (sweep predicate)'
SELECT (status::text='active' AND total_paid=0 AND expired_at IS NULL AND transfer_due_at IS NOT NULL) AS sweep_would_consider
  FROM layaway_accounts WHERE id = :'acct';

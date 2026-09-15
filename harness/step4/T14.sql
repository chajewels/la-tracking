\pset pager off
SELECT set_config('harness.uid','22222222-2222-4222-8222-222222222222',false) \gset x
\echo '=== Q14 (not asked, found while checking Q2): a HUB-CREATED layaway with a deposit deadline ==='
\echo '    NewAccount.tsx:590 sends transfer_due_at; create-layaway-account:164 persists it.'
INSERT INTO layaway_accounts (customer_id, invoice_number, currency, total_amount, payment_plan_months,
  order_date, status, total_paid, remaining_balance, downpayment_amount, source_channel, transfer_due_at)
VALUES ('4201767c-54e6-48d0-8c9e-c1b3c07a931e','900600','JPY',74980,6,current_date,'active',0,74980,22494,
        'hub_manual', now() - interval '5 days') RETURNING id AS hub \gset
SELECT invoice_number, source_channel, status, total_paid, transfer_due_at < now() AS deadline_passed
  FROM layaway_accounts WHERE id = :'hub';
\echo '--- the Hub card would show the red line "The hourly job releases the hold unless a deposit is confirmed first."'
\echo '    (DeadlinesCard.tsx: rendered when overdue && isLive, with no source_channel test)'
\echo '--- does the hourly job in fact do anything?'
SELECT * FROM sweep();
SELECT status, expired_at, total_paid FROM layaway_accounts WHERE id = :'hub';
\echo '--- and if something called the RPC on it directly?'
SELECT expire_web_layaway_atomic(:'hub','system') AS direct_call;
\echo '--- and can staff move that deadline, with the same "hourly job" promise attached?'
SELECT set_account_deadlines('layaway', :'hub', now() + interval '7 days', 'giving them a week', NULL)->>'ok' AS deadline_moved;

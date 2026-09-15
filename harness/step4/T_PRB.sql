-- Finding 1. Run against a fresh ./build.sh with the migration loaded on top:
--   ./build.sh
--   psql -d chaharness -f ../../supabase/migrations/20260915150000_deadline_refused_once_deposit_confirmed.sql
--   psql -d chaharness -f T_PRB.sql
-- (The harness itself ships with the finding-2/3 PR; this file is its companion.)
\pset pager off
SELECT set_config('harness.uid','22222222-2222-4222-8222-222222222222',false) \gset x
UPDATE website_product_variants SET stock_qty=20 WHERE id='b0000000-0000-4000-8000-000000000002';

\echo '=== A layaway with its deposit CONFIRMED. Before the fix: ok:true, date moved, audit row. ==='
SELECT (create_web_layaway_atomic('4201767c-54e6-48d0-8c9e-c1b3c07a931e',
  mk_quote('4201767c-54e6-48d0-8c9e-c1b3c07a931e','b0000000-0000-4000-8000-000000000002',1,6,'JPY',2000,NULL,current_date),
  'en', now()+interval '72 hours', current_date)->>'account_id') AS paid \gset
INSERT INTO payments (account_id, amount_paid, currency, date_paid, payment_method, reference_number, remarks)
  VALUES (:'paid', 22494, 'JPY', current_date, 'bank_transfer', 'DP-PRB', 'downpayment received');
UPDATE layaway_accounts SET total_paid=22494, remaining_balance=total_amount-22494 WHERE id = :'paid';
SELECT status, total_paid, transfer_due_at FROM layaway_accounts WHERE id = :'paid';
SELECT set_account_deadlines('layaway', :'paid', now()+interval '30 days', 'moving a spent deadline', '22222222-2222-4222-8222-222222222222') AS result;
\echo '--- the date must be untouched, and NO audit row written'
SELECT transfer_due_at FROM layaway_accounts WHERE id = :'paid';
SELECT count(*) AS deadlines_updated_rows FROM audit_logs WHERE entity_id = :'paid' AND action='deadlines_updated';

\echo ''
\echo '=== the other half: cache says zero, the ledger says otherwise (INVARIANT 1) ==='
UPDATE layaway_accounts SET total_paid=0 WHERE id = :'paid';
SELECT set_account_deadlines('layaway', :'paid', now()+interval '30 days', 'stale cache', NULL) AS result;
SELECT count(*) AS deadlines_updated_rows FROM audit_logs WHERE entity_id = :'paid' AND action='deadlines_updated';
\echo '--- and once that payment is VOIDED, the deadline is live again'
UPDATE payments SET voided_at = now(), void_reason='test' WHERE account_id = :'paid';
SELECT set_account_deadlines('layaway', :'paid', now()+interval '30 days', 'deposit was voided', NULL)->>'ok' AS moves_again;

\echo ''
\echo '=== an UNPAID plan is unaffected ==='
SELECT (create_web_layaway_atomic('4201767c-54e6-48d0-8c9e-c1b3c07a931e',
  mk_quote('4201767c-54e6-48d0-8c9e-c1b3c07a931e','b0000000-0000-4000-8000-000000000002',1,6,'JPY',2000,NULL,current_date),
  'en', now()+interval '72 hours', current_date)->>'account_id') AS unpaid \gset
SELECT set_account_deadlines('layaway', :'unpaid', now()+interval '10 days', 'customer asked for more time', NULL) AS result;

\echo ''
\echo '=== CASH ORDERS ARE DELIBERATELY NOT GATED: a partially-paid pending order still expires ==='
INSERT INTO cash_orders (invoice_number, customer_id, currency, total_amount, total_paid, remaining_balance,
                         status, source_channel, web_reference, transfer_due_at, expires_at)
VALUES ('900800','4201767c-54e6-48d0-8c9e-c1b3c07a931e','JPY',74980, 20000, 54980,
        'pending','web','CJ-W-900800', now()+interval '72 hours', now()+interval '72 hours') RETURNING id AS co \gset
SELECT set_account_deadlines('cash_order', :'co', now()+interval '14 days', 'partial paid, still extending', NULL) AS result;
SELECT total_paid, transfer_due_at = expires_at AS still_in_step FROM cash_orders WHERE id = :'co';

\echo ''
\echo '=== the 20260915140000 guards survive this whole-body replacement ==='
SELECT set_account_deadlines('layaway', :'unpaid', NULL, 'clear it', NULL) AS null_still_refused;
SELECT set_account_deadlines('layaway', :'unpaid', now()-interval '1 day', 'backdating', NULL)->>'deadline_in_past' AS past_flag_still_there;
SELECT set_account_deadlines('layaway', gen_random_uuid(), now()+interval '1 day', 'x', NULL) AS not_found_still_there;

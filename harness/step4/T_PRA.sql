\pset pager off
SELECT set_config('harness.uid','22222222-2222-4222-8222-222222222222',false) \gset x
UPDATE website_product_variants SET stock_qty=20 WHERE id='b0000000-0000-4000-8000-000000000002';
SELECT (create_web_layaway_atomic('4201767c-54e6-48d0-8c9e-c1b3c07a931e',
  mk_quote('4201767c-54e6-48d0-8c9e-c1b3c07a931e','b0000000-0000-4000-8000-000000000002',1,6,'JPY',2000,NULL,current_date),
  'en', now()+interval '72 hours', current_date)->>'account_id') AS a \gset
\echo '=== FINDING 3, before: a null deadline cleared the column and stranded the plan. Now: ==='
SELECT set_account_deadlines('layaway', :'a', NULL, 'trying to clear it', '22222222-2222-4222-8222-222222222222') AS explicit_null;
SELECT set_account_deadlines('layaway', :'a', NULL) AS null_with_no_reason;
\echo '--- the column is untouched and the plan is still sweepable when its time comes'
SELECT transfer_due_at IS NOT NULL AS deadline_intact FROM layaway_accounts WHERE id = :'a';
\echo '--- and NO audit row was written for the refusals'
SELECT count(*) AS audit_rows FROM audit_logs WHERE entity_id = :'a' AND action='deadlines_updated';
\echo '--- cash order side too'
INSERT INTO cash_orders (invoice_number, customer_id, currency, total_amount, remaining_balance, status,
                         source_channel, web_reference, transfer_due_at, expires_at)
VALUES ('900700','4201767c-54e6-48d0-8c9e-c1b3c07a931e','JPY',74980,74980,'pending','web','CJ-W-900700',
        now()+interval '72 hours', now()+interval '72 hours') RETURNING id AS co \gset
SELECT set_account_deadlines('cash_order', :'co', NULL, 'clear it', NULL) AS cash_null;
SELECT transfer_due_at IS NOT NULL AND expires_at IS NOT NULL AS both_intact FROM cash_orders WHERE id = :'co';

\echo ''
\echo '=== OBSERVATION A: a backdated deadline is still accepted, and now says so ==='
SELECT set_account_deadlines('layaway', :'a', now() - interval '1 day', 'releasing the hold on purpose', NULL) AS backdated;
\echo '--- a forward date does not raise the flag'
SELECT set_account_deadlines('layaway', :'a', now() + interval '5 days', 'normal extension', NULL) AS forward;
\echo '--- everything else still behaves: not_live, not_found, bad_entity_type'
SELECT set_account_deadlines('layaway', gen_random_uuid(), now()+interval '1 day', 'x', NULL) AS missing;
SELECT set_account_deadlines('nonsense', :'a', now()+interval '1 day', 'x', NULL) AS bad_type;

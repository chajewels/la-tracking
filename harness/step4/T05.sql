\pset pager off
SELECT set_config('harness.uid','22222222-2222-4222-8222-222222222222',false) \gset x
\echo '=== Q5: a WEB CASH ORDER — do the customer-facing deadline and the cron date move together? ==='
INSERT INTO cash_orders (invoice_number, customer_id, currency, total_amount, remaining_balance,
                         status, source_channel, web_reference, transfer_due_at, expires_at, customer_lang)
VALUES ('900100','4201767c-54e6-48d0-8c9e-c1b3c07a931e','JPY', 74980, 74980,
        'pending','web','CJ-W-900100', now() + interval '72 hours', now() + interval '72 hours','en')
RETURNING id AS co \gset
SELECT invoice_number, status, transfer_due_at, expires_at, transfer_due_at = expires_at AS in_step FROM cash_orders WHERE id = :'co';
\echo '--- move the deadline'
SELECT set_account_deadlines('cash_order', :'co', now() + interval '14 days', 'customer requested an extension', '22222222-2222-4222-8222-222222222222') AS rpc_result;
SELECT transfer_due_at, expires_at, transfer_due_at = expires_at AS still_in_step FROM cash_orders WHERE id = :'co';
\echo '--- audit row'
SELECT entity_type, action, old_value_json, new_value_json FROM audit_logs WHERE entity_id = :'co' AND action='deadlines_updated';
\echo '--- and a NON-pending cash order?'
UPDATE cash_orders SET status='cancelled' WHERE id = :'co';
SELECT set_account_deadlines('cash_order', :'co', now() + interval '20 days', 'too late', '22222222-2222-4222-8222-222222222222') AS rpc_result;

\echo ''
\echo '=== Q6: NO REASON — where does the guard actually live? ==='
SELECT create_web_layaway_atomic('4201767c-54e6-48d0-8c9e-c1b3c07a931e',
  mk_quote('4201767c-54e6-48d0-8c9e-c1b3c07a931e','b0000000-0000-4000-8000-000000000002',1,6,'JPY',2000,NULL,current_date),
  'en', now() + interval '72 hours', current_date)->>'account_id' AS a6 \gset
\echo '--- p_reason => NULL (the RPC called directly, i.e. anything that is not the edge function)'
SELECT set_account_deadlines('layaway', :'a6', now() + interval '5 days', NULL, '22222222-2222-4222-8222-222222222222') AS rpc_result;
\echo '--- p_reason => empty string'
SELECT set_account_deadlines('layaway', :'a6', now() + interval '6 days', '', '22222222-2222-4222-8222-222222222222') AS rpc_result;
\echo '--- p_reason omitted entirely (it has a DEFAULT NULL)'
SELECT set_account_deadlines('layaway', :'a6', now() + interval '7 days') AS rpc_result;
\echo '--- what the audit trail now records'
SELECT new_value_json->>'reason' AS reason_recorded, new_value_json->>'transfer_due_at' AS new_deadline,
       performed_by_user_id
  FROM audit_logs WHERE entity_id = :'a6' AND action='deadlines_updated' ORDER BY created_at;

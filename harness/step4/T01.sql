\set QUIET on
\pset pager off
\echo '=== SETUP: a yen web layaway on N4020, deposit unpaid ==='
SELECT set_config('harness.uid','22222222-2222-4222-8222-222222222222',false);
SELECT create_web_layaway_atomic(
  '4201767c-54e6-48d0-8c9e-c1b3c07a931e',
  mk_quote('4201767c-54e6-48d0-8c9e-c1b3c07a931e','b0000000-0000-4000-8000-000000000002',1,6,'JPY',2000,NULL,current_date),
  'en', now() + interval '72 hours', current_date) AS created \gset
\echo :created
SELECT id AS acct FROM layaway_accounts WHERE source_channel='web' ORDER BY created_at DESC LIMIT 1 \gset
\echo '--- account as created'
SELECT invoice_number, web_reference, source_channel, status, currency, total_amount,
       downpayment_amount, round(downpayment_amount/total_amount*100,2) AS dep_pct,
       total_paid, loyalty_jpy_amount, transfer_due_at, expired_at
  FROM layaway_accounts WHERE id = :'acct';

\echo ''
\echo '=== Q1: set_account_deadlines on a LIVE, UNPAID plan, valid date + reason ==='
SELECT set_account_deadlines('layaway', :'acct', now() + interval '10 days', 'Customer asked for more time to arrange the transfer', '22222222-2222-4222-8222-222222222222') AS rpc_result;
\echo '--- column after'
SELECT transfer_due_at, updated_at > created_at AS updated_at_moved FROM layaway_accounts WHERE id = :'acct';
\echo '--- audit row(s) written by the RPC itself (action = deadlines_updated)'
SELECT entity_type, action, old_value_json, new_value_json, performed_by_user_id
  FROM audit_logs WHERE entity_id = :'acct' AND action='deadlines_updated';
\echo '--- OTHER audit rows the same call produced (trg_audit_layaway_accounts)'
SELECT entity_type, action, count(*) FROM audit_logs WHERE entity_id = :'acct' GROUP BY 1,2 ORDER BY 2;

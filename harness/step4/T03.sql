\pset pager off
SELECT set_config('harness.uid','22222222-2222-4222-8222-222222222222',false) \gset x
\echo '=== Q3: a CANCELLED / expired plan ==='
SELECT create_web_layaway_atomic('4201767c-54e6-48d0-8c9e-c1b3c07a931e',
  mk_quote('4201767c-54e6-48d0-8c9e-c1b3c07a931e','b0000000-0000-4000-8000-000000000002',1,6,'JPY',2000,NULL,current_date),
  'en', now() - interval '1 hour', current_date)->>'account_id' AS a3 \gset
SELECT expire_web_layaway_atomic(:'a3','system') AS expired_it;
SELECT status, expired_at IS NOT NULL AS stamped FROM layaway_accounts WHERE id = :'a3';
\echo '--- now try to move its deadline'
SELECT set_account_deadlines('layaway', :'a3', now() + interval '10 days', 'customer came back', '22222222-2222-4222-8222-222222222222') AS rpc_result;
SELECT count(*) AS audit_rows_written FROM audit_logs WHERE entity_id = :'a3' AND action='deadlines_updated';

\echo ''
\echo '=== Q4: a date IN THE PAST on a live, unpaid plan ==='
SELECT create_web_layaway_atomic('4201767c-54e6-48d0-8c9e-c1b3c07a931e',
  mk_quote('4201767c-54e6-48d0-8c9e-c1b3c07a931e','b0000000-0000-4000-8000-000000000002',1,6,'JPY',2000,NULL,current_date),
  'en', now() + interval '72 hours', current_date)->>'account_id' AS a4 \gset
SELECT set_account_deadlines('layaway', :'a4', now() - interval '30 days', 'backdated on purpose', '22222222-2222-4222-8222-222222222222') AS rpc_result;
SELECT transfer_due_at, transfer_due_at < now() AS is_in_the_past FROM layaway_accounts WHERE id = :'a4';
\echo '--- consequence: is this plan now visible to the expiry sweep?'
SELECT count(*) AS sweep_would_expire_now FROM layaway_accounts
 WHERE id = :'a4' AND source_channel='web' AND status='active' AND total_paid=0
   AND expired_at IS NULL AND transfer_due_at < now();
\echo '--- Q4b: NULL deadline (the edge function permits null; does the RPC clear it?)'
SELECT set_account_deadlines('layaway', :'a4', NULL, 'clearing it', '22222222-2222-4222-8222-222222222222') AS rpc_result;
SELECT transfer_due_at IS NULL AS deadline_now_null FROM layaway_accounts WHERE id = :'a4';

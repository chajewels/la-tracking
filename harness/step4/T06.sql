\pset pager off
SELECT set_config('harness.uid','22222222-2222-4222-8222-222222222222',false) \gset x
\echo '=== Q6: NO REASON — where does the guard actually live? ==='
SELECT create_web_layaway_atomic('4201767c-54e6-48d0-8c9e-c1b3c07a931e',
  mk_quote('4201767c-54e6-48d0-8c9e-c1b3c07a931e','b0000000-0000-4000-8000-000000000002',1,6,'JPY',2000,NULL,current_date),
  'en', now() + interval '72 hours', current_date)->>'account_id' AS a6 \gset
\echo '--- p_reason => NULL'
SELECT set_account_deadlines('layaway', :'a6', now() + interval '5 days', NULL, '22222222-2222-4222-8222-222222222222') AS rpc_result;
\echo '--- p_reason => empty string'
SELECT set_account_deadlines('layaway', :'a6', now() + interval '6 days', '', '22222222-2222-4222-8222-222222222222') AS rpc_result;
\echo '--- p_reason omitted entirely (DEFAULT NULL)'
SELECT set_account_deadlines('layaway', :'a6', now() + interval '7 days') AS rpc_result;
\echo '--- what the audit trail now records for those three calls'
SELECT coalesce(new_value_json->>'reason','<NULL>') AS reason_recorded,
       new_value_json->>'transfer_due_at' AS new_deadline,
       coalesce(performed_by_user_id::text,'<NULL>') AS actor
  FROM audit_logs WHERE entity_id = :'a6' AND action='deadlines_updated' ORDER BY created_at;

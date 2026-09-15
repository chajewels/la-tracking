\pset pager off
SELECT set_config('harness.uid','22222222-2222-4222-8222-222222222222',false) \gset x
\echo '=== Q7: unpaid plan past its deadline — every column that moves ==='
SELECT stock_qty AS stock_before FROM website_product_variants WHERE id='b0000000-0000-4000-8000-000000000002' \gset
\echo 'stock before:' :stock_before
SELECT create_web_layaway_atomic('4201767c-54e6-48d0-8c9e-c1b3c07a931e',
  mk_quote('4201767c-54e6-48d0-8c9e-c1b3c07a931e','b0000000-0000-4000-8000-000000000002',2,6,'JPY',2000,NULL,current_date),
  'en', now() - interval '2 hours', current_date)->>'account_id' AS a7 \gset
CREATE TEMP TABLE before_acct AS SELECT * FROM layaway_accounts WHERE id = :'a7';
CREATE TEMP TABLE before_sched AS SELECT * FROM layaway_schedule WHERE account_id = :'a7';
SELECT stock_qty AS stock_held FROM website_product_variants WHERE id='b0000000-0000-4000-8000-000000000002' \gset
\echo 'stock after the hold (qty 2 ordered):' :stock_held

\echo '--- run the sweep (same predicate as auto-expire-cash-orders step 3)'
SELECT * FROM sweep();

\echo '--- ACCOUNT: every column whose value changed'
SELECT key, b.value AS before, a.value AS after
FROM jsonb_each_text(to_jsonb((SELECT r FROM before_acct r))) b
JOIN jsonb_each_text(to_jsonb((SELECT r FROM layaway_accounts r WHERE id = :'a7'))) a USING (key)
WHERE b.value IS DISTINCT FROM a.value;

\echo '--- SCHEDULE: status counts before and after'
SELECT (SELECT jsonb_object_agg(status, n) FROM (SELECT status::text, count(*) n FROM before_sched GROUP BY 1) x) AS before,
       (SELECT jsonb_object_agg(status, n) FROM (SELECT status::text, count(*) n FROM layaway_schedule WHERE account_id = :'a7' GROUP BY 1) y) AS after;
\echo '--- SCHEDULE: did anything other than status/updated_at move? (amounts must be untouched)'
SELECT count(*) AS rows_with_changed_amounts FROM before_sched b JOIN layaway_schedule s USING (id)
 WHERE (b.base_installment_amount, b.total_due_amount, b.paid_amount, b.penalty_amount, b.due_date)
    IS DISTINCT FROM (s.base_installment_amount, s.total_due_amount, s.paid_amount, s.penalty_amount, s.due_date);

\echo '--- STOCK'
SELECT stock_qty AS stock_after_expiry FROM website_product_variants WHERE id='b0000000-0000-4000-8000-000000000002';

\echo '--- AUDIT row written by the RPC'
SELECT action, new_value_json, coalesce(performed_by_user_id::text,'<NULL>') AS actor
  FROM audit_logs WHERE entity_id = :'a7' AND action='web_layaway_expired';
\echo '--- NOTES appended to the account'
SELECT notes FROM layaway_accounts WHERE id = :'a7';
\echo '--- account_notes row from trg_note_account_status_change'
SELECT note_text, created_by_name FROM account_notes WHERE account_id = :'a7';
\echo '--- layaway_account_items: left in place? (they are the stock record)'
SELECT count(*) AS item_rows, sum(quantity) AS total_qty FROM layaway_account_items WHERE account_id = :'a7';

\echo ''
\echo '=== Q8: run it a SECOND time — stock must not rise twice ==='
SELECT expire_web_layaway_atomic(:'a7','system') AS second_direct_call;
SELECT stock_qty AS stock_after_second_call FROM website_product_variants WHERE id='b0000000-0000-4000-8000-000000000002';
\echo '--- and via the sweep again (the sweep filter should not even select it)'
SELECT count(*) AS rows_sweep_selects FROM layaway_accounts
 WHERE id = :'a7' AND source_channel='web' AND status='active' AND total_paid=0 AND expired_at IS NULL AND transfer_due_at < now();
SELECT count(*) AS expired_audit_rows FROM audit_logs WHERE entity_id = :'a7' AND action='web_layaway_expired';

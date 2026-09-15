\pset pager off
\set QUIET on
SELECT set_config('harness.uid','22222222-2222-4222-8222-222222222222',false) \gset x
UPDATE website_product_variants SET stock_qty = 30 WHERE id IN ('b0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000002');
CREATE TEMP TABLE v(n int, name text, expected text, actual text);

-- helper: a fresh unpaid yen plan with a deadline offset
CREATE OR REPLACE FUNCTION pg_temp.plan(off interval DEFAULT interval '72 hours', term int DEFAULT 6) RETURNS uuid
LANGUAGE sql AS $$ SELECT (create_web_layaway_atomic('4201767c-54e6-48d0-8c9e-c1b3c07a931e',
  mk_quote('4201767c-54e6-48d0-8c9e-c1b3c07a931e','b0000000-0000-4000-8000-000000000002',1,term,'JPY',2000,NULL,current_date),
  'en', now() + off, current_date)->>'account_id')::uuid $$;

DO $$
DECLARE a uuid; b uuid; r jsonb; s0 int; s1 int; n int; co uuid;
BEGIN
  -- 1
  a := pg_temp.plan();
  r := set_account_deadlines('layaway', a, now() + interval '10 days', 'more time to transfer', '22222222-2222-4222-8222-222222222222');
  SELECT count(*) INTO n FROM audit_logs WHERE entity_id=a AND action='deadlines_updated'
    AND old_value_json ? 'transfer_due_at' AND new_value_json->>'reason'='more time to transfer';
  INSERT INTO v VALUES (1,'live unpaid plan, valid date + reason','ok + 1 audit row (old, new, reason)',
    format('%s + %s audit row(s)', coalesce(r->>'ok','err:'||(r->>'error')), n));
  -- 2
  b := pg_temp.plan();
  INSERT INTO payments(account_id,amount_paid,currency,date_paid,reference_number,remarks)
    VALUES (b,22494,'JPY',current_date,'DP-A','downpayment');
  UPDATE layaway_accounts SET total_paid=22494 WHERE id=b;
  r := set_account_deadlines('layaway', b, now() + interval '30 days', 'moving a spent deadline', '22222222-2222-4222-8222-222222222222');
  SELECT count(*) INTO n FROM audit_logs WHERE entity_id=b AND action='deadlines_updated';
  INSERT INTO v VALUES (2,'plan whose DEPOSIT IS CONFIRMED','refuse (dialog says it no longer applies)',
    format('%s — date written, %s audit row(s)', coalesce(r->>'ok','err:'||(r->>'error')), n));
  -- 3
  a := pg_temp.plan(interval '-1 hour');
  PERFORM expire_web_layaway_atomic(a,'system');
  r := set_account_deadlines('layaway', a, now() + interval '10 days', 'customer came back', NULL);
  SELECT count(*) INTO n FROM audit_logs WHERE entity_id=a AND action='deadlines_updated';
  INSERT INTO v VALUES (3,'cancelled / expired plan','not_live', format('%s, %s audit row(s)', r->>'error', n));
  -- 4
  a := pg_temp.plan();
  r := set_account_deadlines('layaway', a, now() - interval '30 days', 'backdated', NULL);
  SELECT count(*) INTO n FROM layaway_accounts la WHERE la.id=a AND la.status='active'
    AND la.total_paid=0 AND la.expired_at IS NULL AND la.transfer_due_at < now();
  INSERT INTO v VALUES (4,'a date in the PAST','(nothing validates it)',
    format('accepted (%s); plan immediately sweepable=%s', r->>'ok', n=1));
  r := set_account_deadlines('layaway', a, NULL, 'clear it', NULL);
  SELECT count(*) INTO n FROM layaway_accounts la WHERE la.id=a AND la.transfer_due_at IS NULL;
  INSERT INTO v VALUES (4,'a NULL deadline','(undocumented)',
    format('accepted (%s); deadline cleared=%s -> never sweepable again', r->>'ok', n=1));
  -- 5
  INSERT INTO cash_orders(invoice_number,customer_id,currency,total_amount,remaining_balance,status,
                          source_channel,web_reference,transfer_due_at,expires_at)
    VALUES ('900500','4201767c-54e6-48d0-8c9e-c1b3c07a931e','JPY',74980,74980,'pending','web','CJ-W-900500',
            now()+interval '72 hours', now()+interval '72 hours') RETURNING id INTO co;
  r := set_account_deadlines('cash_order', co, now() + interval '14 days', 'extension', NULL);
  SELECT count(*) INTO n FROM cash_orders WHERE id=co AND transfer_due_at=expires_at
    AND transfer_due_at = (r->'new'->>'transfer_due_at')::timestamptz;
  INSERT INTO v VALUES (5,'web cash order','transfer_due_at AND expires_at move together',
    format('%s; both columns equal the new value=%s', r->>'ok', n=1));
  -- 6
  a := pg_temp.plan();
  r := set_account_deadlines('layaway', a, now() + interval '5 days', NULL, NULL);
  SELECT count(*) INTO n FROM audit_logs WHERE entity_id=a AND action='deadlines_updated'
    AND new_value_json->>'reason' IS NULL;
  INSERT INTO v VALUES (6,'NO REASON, RPC called directly','RPC has no guard; edge function returns 400',
    format('RPC: %s, %s audit row(s) with reason=NULL', r->>'ok', n));
  -- 7/8
  SELECT stock_qty INTO s0 FROM website_product_variants WHERE id='b0000000-0000-4000-8000-000000000002';
  a := pg_temp.plan(interval '-2 hours');
  r := expire_web_layaway_atomic(a,'system');
  SELECT stock_qty INTO s1 FROM website_product_variants WHERE id='b0000000-0000-4000-8000-000000000002';
  SELECT count(*) INTO n FROM layaway_schedule WHERE account_id=a AND status='cancelled';
  INSERT INTO v VALUES (7,'unpaid plan past its deadline','cancelled + expired_at + rows cancelled + stock back',
    format('%s; status=%s expired_at set=%s; %s rows cancelled; stock %s->%s',
      r->>'ok', (SELECT status FROM layaway_accounts WHERE id=a),
      (SELECT expired_at IS NOT NULL FROM layaway_accounts WHERE id=a), n, s0, s1));
  r := expire_web_layaway_atomic(a,'system');
  SELECT stock_qty INTO s1 FROM website_product_variants WHERE id='b0000000-0000-4000-8000-000000000002';
  INSERT INTO v VALUES (8,'run it twice','stock must not rise twice',
    format('2nd call: %s; stock still %s', r->>'reason', s1));
  -- 9
  a := pg_temp.plan(interval '-2 hours');
  INSERT INTO payments(account_id,amount_paid,currency,date_paid,reference_number,remarks)
    VALUES (a,22494,'JPY',current_date,'DP-B','downpayment');
  UPDATE layaway_accounts SET total_paid=22494 WHERE id=a;
  r := expire_web_layaway_atomic(a,'system');
  UPDATE layaway_accounts SET total_paid=0 WHERE id=a;
  INSERT INTO v VALUES (9,'plan with a CONFIRMED payment','refuses',
    format('%s (cache); %s (ledger, with the cache zeroed)', r->>'reason',
      (expire_web_layaway_atomic(a,'system'))->>'reason'));
  UPDATE layaway_accounts SET total_paid=22494 WHERE id=a;
  -- 10
  a := pg_temp.plan(interval '-2 hours');
  SELECT stock_qty INTO s0 FROM website_product_variants WHERE id='b0000000-0000-4000-8000-000000000002';
  INSERT INTO payment_submissions(customer_id,account_id,submitted_amount,payment_date,payment_method,proof_url,status)
    VALUES ('4201767c-54e6-48d0-8c9e-c1b3c07a931e',a,22494,current_date,'bank_transfer','https://x/p.jpg','submitted');
  SELECT count(*) INTO n FROM sweep() WHERE result->>'reason'='submission_pending';
  SELECT stock_qty INTO s1 FROM website_product_variants WHERE id='b0000000-0000-4000-8000-000000000002';
  INSERT INTO v VALUES (10,'INVARIANT 12: unreviewed submission','submission_pending, nothing moves',
    format('%s; status=%s expired_at=%s stock %s->%s', 
      (SELECT string_agg(DISTINCT result->>'reason',',') FROM (SELECT expire_web_layaway_atomic(a,'system') AS result) z),
      (SELECT status FROM layaway_accounts WHERE id=a),
      coalesce((SELECT expired_at::text FROM layaway_accounts WHERE id=a),'NULL'), s0, s1));
  UPDATE payment_submissions SET status='under_review' WHERE account_id=a;
  r := expire_web_layaway_atomic(a,'system');
  UPDATE payment_submissions SET status='rejected' WHERE account_id=a;
  INSERT INTO v VALUES (10,'  under_review, then rejected','frozen, then released',
    format('under_review: %s; after reject: %s', r->>'reason', (expire_web_layaway_atomic(a,'system'))->>'ok'));
  -- 11
  a := pg_temp.plan(interval '-2 hours');
  INSERT INTO payments(account_id,amount_paid,currency,date_paid,reference_number,remarks)
    VALUES (a,22494,'JPY',current_date,'DP-C','downpayment');
  UPDATE layaway_accounts SET total_paid=22494, status='overdue' WHERE id=a;
  UPDATE layaway_schedule SET status='overdue' WHERE account_id=a AND due_date<current_date;
  SELECT count(*) INTO n FROM sweep() s WHERE s.ref=(SELECT web_reference FROM layaway_accounts WHERE id=a);
  INSERT INTO v VALUES (11,'deposit paid, instalments overdue','sweep must not touch it',
    format('sweep selected it %s time(s); direct call: %s; status still %s', n,
      (expire_web_layaway_atomic(a,'system'))->>'reason', (SELECT status FROM layaway_accounts WHERE id=a)));
  -- 12
  SELECT mk_quote('4201767c-54e6-48d0-8c9e-c1b3c07a931e','b0000000-0000-4000-8000-000000000001',1,12,'JPY',2000,NULL,current_date) INTO a;
  UPDATE checkout_quotes SET term_months=12 WHERE id=a;
  r := create_web_layaway_atomic('4201767c-54e6-48d0-8c9e-c1b3c07a931e', a, 'en', now()+interval '72 hours', current_date);
  SELECT count(*) INTO n FROM layaway_accounts WHERE quote_id=a;
  INSERT INTO v VALUES (12,'downgraded term reaches the WRITER','below_plan_minimum, nothing written',
    format('%s (max_term=%s); accounts written=%s; quote unconsumed=%s', r->>'error', r->>'max_term_months', n,
      (SELECT consumed_at IS NULL FROM checkout_quotes WHERE id=a)));
  -- 13
  SELECT (create_web_layaway_atomic('4201767c-54e6-48d0-8c9e-c1b3c07a931e',
    mk_quote('4201767c-54e6-48d0-8c9e-c1b3c07a931e','b0000000-0000-4000-8000-000000000001',1,10,'PHP',2000,0.42,current_date),
    'en', now()+interval '72 hours', current_date)->>'account_id')::uuid INTO a;
  INSERT INTO v VALUES (13,'peso plan: loyalty_jpy_amount','679980 (the YEN product subtotal)',
    format('currency=%s total=%s loyalty_jpy_amount=%s parts_sum_exactly=%s',
      (SELECT currency FROM layaway_accounts WHERE id=a),
      (SELECT total_amount FROM layaway_accounts WHERE id=a),
      (SELECT loyalty_jpy_amount FROM layaway_accounts WHERE id=a),
      (SELECT (total_amount-shipping_fee)+shipping_fee = total_amount FROM layaway_accounts WHERE id=a)));
END $$;
\pset format aligned
\echo ''
SELECT n AS q, name, expected, actual FROM v ORDER BY n, name;

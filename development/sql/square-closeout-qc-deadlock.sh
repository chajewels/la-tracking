#!/bin/bash
# Review #5: a Finish recording (locks submission → order → card row) racing a
# staff decision on the same capture must not deadlock.
DB=$1; P="psql -h /home/pgtest/pg -p 55432 -U postgres -d $DB -qAt"
TA=$(mktemp); TB=$(mktemp)
$P -c "INSERT INTO user_roles (user_id, role) VALUES ('a0000000-0000-0000-0000-0000000000dd','admin') ON CONFLICT DO NOTHING" >/dev/null 2>&1
read S SUB <<<$($P -F' ' -c "WITH c AS (INSERT INTO customers (id) VALUES (gen_random_uuid()) RETURNING id),
 o AS (INSERT INTO cash_orders (id, invoice_number, customer_id, currency, total_amount, total_paid, remaining_balance, status)
       SELECT gen_random_uuid(), 'D'||floor(random()*1e9)::text, c.id, 'JPY', 10000, 0, 10000, 'pending' FROM c RETURNING id, customer_id),
 s AS (INSERT INTO square_payments (cash_order_id, customer_id, square_payment_id, status, test, amount_jpy, captured_amount_jpy, captured_at, environment, exception, exception_at)
       SELECT o.id, o.customer_id, 'dl_'||floor(random()*1e9)::text, 'captured', true, 10000, 10000, now(), 'sandbox', 'captured_unallocated', now() FROM o RETURNING id, cash_order_id, customer_id),
 b AS (INSERT INTO payment_submissions (customer_id, cash_order_id, submitted_amount, payment_date, payment_method, status, square_payment_id, submission_type)
       SELECT customer_id, cash_order_id, 10000, current_date, 'square', 'confirmed', id, 'cash_payment' FROM s RETURNING id)
 SELECT (SELECT id FROM s), (SELECT id FROM b)")
( $P -c "BEGIN; SELECT 1 FROM payment_submissions WHERE id='$SUB' FOR UPDATE; SELECT pg_sleep(1.5); SELECT 1 FROM cash_orders WHERE id=(SELECT cash_order_id FROM square_payments WHERE id='$S') FOR UPDATE; SELECT 1 FROM square_payments WHERE id='$S' FOR UPDATE; COMMIT;" >/dev/null 2>"$TA"; echo "A exit $?" ) &
sleep 0.4
$P -c "BEGIN; SELECT set_config('test.uid','a0000000-0000-0000-0000-0000000000dd',true); SELECT decide_square_case('exception','$S','other','race test')->>'ok'; COMMIT;" 2>"$TB" | tail -1 | sed 's/^/B decide ok=/'
wait
cat "$TA" "$TB" | grep -i deadlock && echo "DEADLOCK on $DB" || echo "no deadlock on $DB"
rm -f "$TA" "$TB"

# Review A: a webhook / reconcile state change (apply_square_payment_state)
# racing a Finish or decision that holds the submission first must not deadlock.
TA=$(mktemp); TB=$(mktemp)
read S SUB SQID <<<$($P -F' ' -c "WITH c AS (INSERT INTO customers (id) VALUES (gen_random_uuid()) RETURNING id),
 o AS (INSERT INTO cash_orders (id, invoice_number, customer_id, currency, total_amount, total_paid, remaining_balance, status)
       SELECT gen_random_uuid(), 'E'||floor(random()*1e9)::text, c.id, 'JPY', 10000, 0, 10000, 'pending' FROM c RETURNING id, customer_id),
 s AS (INSERT INTO square_payments (cash_order_id, customer_id, square_payment_id, status, test, amount_jpy, environment)
       SELECT o.id, o.customer_id, 'ap_'||floor(random()*1e9)::text, 'authorized', true, 10000, 'sandbox' FROM o RETURNING id, cash_order_id, customer_id, square_payment_id),
 b AS (INSERT INTO payment_submissions (customer_id, cash_order_id, submitted_amount, payment_date, payment_method, status, square_payment_id, submission_type)
       SELECT customer_id, cash_order_id, 10000, current_date, 'square', 'submitted', id, 'cash_payment' FROM s RETURNING id)
 SELECT (SELECT id FROM s), (SELECT id FROM b), (SELECT square_payment_id FROM s)")
( $P -c "BEGIN; SELECT 1 FROM payment_submissions WHERE id='$SUB' FOR UPDATE; SELECT pg_sleep(1.5); SELECT 1 FROM square_payments WHERE id='$S' FOR UPDATE; COMMIT;" >/dev/null 2>"$TA"; echo "A exit $?" ) &
sleep 0.4
$P -c "SELECT apply_square_payment_state('$SQID','APPROVED',10000,0,'JPY','v2',now(),NULL,now() + interval '6 days','VISA','1111',NULL,'NORMAL','{}'::jsonb,'{}'::jsonb,'reconcile',NULL)->>'ok';" 2>"$TB" | tail -1 | sed 's/^/B apply ok=/'
wait
cat "$TA" "$TB" | grep -i deadlock && echo "DEADLOCK (apply) on $DB" || echo "no deadlock (apply) on $DB"
rm -f "$TA" "$TB"

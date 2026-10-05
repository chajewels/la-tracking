#!/bin/bash
# QC10 race: session A records COMPLETED (newer) and holds its transaction;
# session B records PENDING (older) for the same new refund id meanwhile.
DB=$1; P="psql -h /home/pgtest/pg -p 55432 -U postgres -d $DB -qAt"
SQ=$($P -c "WITH c AS (INSERT INTO customers (id) VALUES (gen_random_uuid()) RETURNING id),
 o AS (INSERT INTO cash_orders (id, invoice_number, customer_id, currency, total_amount, total_paid, remaining_balance, status)
       SELECT gen_random_uuid(), 'R'||floor(random()*1e9)::text, c.id, 'JPY', 10000, 0, 10000, 'pending' FROM c RETURNING id, customer_id)
 INSERT INTO square_payments (cash_order_id, customer_id, square_payment_id, status, test, amount_jpy, captured_amount_jpy, captured_at, environment)
 SELECT o.id, o.customer_id, 'race_'||floor(random()*1e9)::text, 'captured', true, 10000, 10000, now(), 'sandbox' FROM o RETURNING square_payment_id")
RID="rf_race_$RANDOM$RANDOM"
( $P -c "BEGIN; SELECT record_square_refund('$RID', '$SQ', 'COMPLETED', 10000, NULL, now() - interval '1 hour', now(), '{}'::jsonb) IS NOT NULL; SELECT pg_sleep(2); COMMIT;" >/dev/null ) &
sleep 0.5
$P -c "SELECT record_square_refund('$RID', '$SQ', 'PENDING', 10000, NULL, now() - interval '1 hour', now() - interval '30 minutes', '{}'::jsonb)->>'stale';" | sed 's/^/B answered stale=/'
wait
echo "$DB final status: $($P -c "SELECT status FROM square_refunds WHERE square_refund_id = '$RID'")"

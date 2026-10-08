#!/bin/bash
# R05 two-session race (V05, 2026-10-08). Local Postgres copy only — NEVER live.
# Session A cancels a card-paid web order with store credit and holds its transaction open;
# session B records a COMPLETED Square refund on the same order at the same time.
# Expected, both orders: never credit AND refund without a human being told.
#   A first → A mints credit, B waits on the order lock, then records the refund AND rings card_refund_after_credit.
#   B first → B records the refund, A waits, then is REFUSED (card_already_refunded), no lot.
set -u
DB=${DB:-cjtest}
P="sudo -u postgres psql -d $DB -Atq -v ON_ERROR_STOP=1"
UID1=00000000-0000-0000-0000-00000000aaaa
seed() { # $1 order id suffix
$P <<SQL
SELECT set_config('test.uid', '$UID1', false);
INSERT INTO public.customers (id, full_name, email, mobile_number) VALUES ('00000000-0000-0000-0000-0000000000c1','Test Customer','a@example.com','09011112222') ON CONFLICT DO NOTHING;
INSERT INTO public.cash_orders (id, invoice_number, customer_id, status, web_reference, source_channel, currency, order_date, total_amount, total_paid)
VALUES ('00000000-0000-0000-0000-00000000ee$1', 'TRACE$1', '00000000-0000-0000-0000-0000000000c1', 'completed', 'CJ-W-TRACE$1', 'web', 'JPY', (now() AT TIME ZONE 'Asia/Manila')::date - 3, 10000, 10000);
INSERT INTO public.cash_payments (cash_order_id, amount_paid, currency, payment_method, provider_capture_id)
VALUES ('00000000-0000-0000-0000-00000000ee$1', 10000, 'JPY', 'square', 'sq_race_$1');
INSERT INTO public.square_payments (cash_order_id, square_payment_id, status, test, amount_jpy, captured_at, environment, cash_payment_id)
VALUES ('00000000-0000-0000-0000-00000000ee$1', 'sq_race_$1', 'captured', true, 10000, now() - interval '3 days', 'sandbox',
        (SELECT id FROM public.cash_payments WHERE provider_capture_id = 'sq_race_$1'));
SQL
}
cleanup() {
$P <<SQL
DELETE FROM public.staff_notifications WHERE metadata ->> 'cash_order_id' LIKE '00000000-0000-0000-0000-00000000ee%';
DELETE FROM public.store_credit_lots WHERE source_cash_order_id::text LIKE '00000000-0000-0000-0000-00000000ee%';
DELETE FROM public.square_refunds WHERE cash_order_id::text LIKE '00000000-0000-0000-0000-00000000ee%';
DELETE FROM public.square_payments WHERE cash_order_id::text LIKE '00000000-0000-0000-0000-00000000ee%';
DELETE FROM public.cash_payments WHERE cash_order_id::text LIKE '00000000-0000-0000-0000-00000000ee%';
DELETE FROM public.account_notes WHERE cash_order_id::text LIKE '00000000-0000-0000-0000-00000000ee%';
DELETE FROM public.audit_logs WHERE entity_id::text LIKE '00000000-0000-0000-0000-00000000ee%';
DELETE FROM public.cash_orders WHERE id::text LIKE '00000000-0000-0000-0000-00000000ee%';
SQL
}
term() { echo "SELECT set_config('test.uid','$UID1',false); SELECT public.terminate_web_order_atomic('00000000-0000-0000-0000-00000000ee$1','cancelled','race','$UID1','staff@example.com','store_credit_issued',NULL,'staff',false);"; }
refund() { echo "SELECT public.record_square_refund('rf_race_$1','sq_race_$1','COMPLETED',10000,'race',now(),now(),'{}'::jsonb);"; }

cleanup >/dev/null 2>&1
echo "== Case 1: cancel first, refund arrives while the cancel is still open"
seed 01 >/dev/null
( printf "BEGIN;\n%s\nSELECT pg_sleep(3);\nCOMMIT;\n" "$(term 01)" | $P > /tmp/raceA.out 2>&1 ) &
sleep 1
t0=$(date +%s%N); ( printf "BEGIN;\n%s\nCOMMIT;\n" "$(refund 01)" | $P > /tmp/raceB.out 2>&1 ); t1=$(date +%s%N); wait
echo "B waited $(( (t1-t0)/1000000 )) ms (should be ~2000: blocked on the order lock)"
$P -c "SELECT 'lot ¥'||coalesce((SELECT original_amount::text FROM public.store_credit_lots WHERE source_cash_order_id='00000000-0000-0000-0000-00000000ee01'),'none') || ' | refund '||coalesce((SELECT status FROM public.square_refunds WHERE square_refund_id='rf_race_01'),'none') || ' | bell card_refund_after_credit: '||(SELECT count(*) FROM public.staff_notifications WHERE type='card_refund_after_credit' AND metadata->>'refund_id'='rf_race_01')"

echo "== Case 2: refund first, cancel arrives while the refund is still open"
seed 02 >/dev/null
( printf "BEGIN;\n%s\nSELECT pg_sleep(3);\nCOMMIT;\n" "$(refund 02)" | $P > /tmp/raceB2.out 2>&1 ) &
sleep 1
t0=$(date +%s%N); ( printf "BEGIN;\n%s\nCOMMIT;\n" "$(term 02)" | $P > /tmp/raceA2.out 2>&1 ); t1=$(date +%s%N); wait
echo "A waited $(( (t1-t0)/1000000 )) ms (should be ~2000: blocked on the order lock)"
grep -o '"reason": "[a-z_]*"' /tmp/raceA2.out | head -1
$P -c "SELECT 'lot: '||coalesce((SELECT original_amount::text FROM public.store_credit_lots WHERE source_cash_order_id='00000000-0000-0000-0000-00000000ee02'),'none') || ' | order status '||(SELECT status FROM public.cash_orders WHERE id='00000000-0000-0000-0000-00000000ee02')"
cleanup >/dev/null 2>&1

#!/usr/bin/env bash
# SQV02/SQV03 races (migration 20261130110000). NOT a migration — never run against live.
# Two REAL sessions against the local Postgres copy (default database cjtest). Fixtures are
# committed under unique ids and removed at the end. Expected: 3 passed, 0 failed.
#   1. two orders race for ONE store-credit lot  → exactly one records it
#   2. two admins approve the same order at once → exactly one approval
#   3. a lot is voided while it is being allocated → the allocation sees the void and refuses
set -u
DB=${1:-cjtest}
PSQL=(sudo -n -u postgres psql -d "$DB" -At -v ON_ERROR_STOP=1 -q)
ADMIN=84a8b62c-ec75-4eeb-8ec0-e43ad8ed3457
C=00000000-0000-0000-0000-0000000c0c01
pass=0; fail=0
ok() { if [ "$1" = "true" ]; then pass=$((pass+1)); echo "PASS $2"; else fail=$((fail+1)); echo "FAIL $2 :: $3"; fi; }

"${PSQL[@]}" <<SQL
INSERT INTO public.user_roles (user_id, role) SELECT '$ADMIN', 'admin' WHERE NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = '$ADMIN' AND role = 'admin');
INSERT INTO public.customers (id, full_name, email, mobile_number, customer_code) VALUES ('$C', 'Race Customer', 'race@example.com', '09099990000', 'CJ-2026-99990');
INSERT INTO public.cash_orders (id, invoice_number, customer_id, status, refund_status, web_reference, source_channel, currency, order_date, total_amount, total_paid, cancelled_at)
SELECT ('00000000-0000-0000-0000-0000000c0e0' || i)::uuid, 'RACE' || i, '$C', 'cancelled', 'refund_pending', 'CJ-W-RACE' || i, 'web', 'JPY', current_date - 10, 10000, 10000, now() - interval '1 day'
  FROM generate_series(1, 4) i;
INSERT INTO public.cash_payments (cash_order_id, amount_paid, currency, payment_method) SELECT ('00000000-0000-0000-0000-0000000c0e0' || i)::uuid, 10000, 'JPY', 'square' FROM generate_series(1, 4) i;
INSERT INTO public.square_payments (cash_order_id, square_payment_id, status, test, amount_jpy, environment)
SELECT ('00000000-0000-0000-0000-0000000c0e0' || i)::uuid, 'sq_race' || i, 'captured', true, 10000, 'sandbox' FROM generate_series(1, 4) i;
INSERT INTO public.square_refunds (square_refund_id, square_payment_row, square_payment_id, cash_order_id, amount_jpy, status)
SELECT 'rf_race' || substr(sp.square_payment_id, 8), sp.id, sp.square_payment_id, sp.cash_order_id, 10000, 'FAILED' FROM public.square_payments sp WHERE sp.square_payment_id LIKE 'sq_race%';
SELECT public.approve_card_refund_exception_atomic('00000000-0000-0000-0000-0000000c0e01', '$ADMIN', 'store_credit', 'rf_race1', 'T1', 10000, NULL) ->> 'ok';
SELECT public.approve_card_refund_exception_atomic('00000000-0000-0000-0000-0000000c0e02', '$ADMIN', 'store_credit', 'rf_race2', 'T2', 10000, NULL) ->> 'ok';
SELECT public.approve_card_refund_exception_atomic('00000000-0000-0000-0000-0000000c0e04', '$ADMIN', 'store_credit', 'rf_race4', 'T4', 10000, NULL) ->> 'ok';
INSERT INTO public.store_credit_lots (id, customer_id, currency, original_amount, remaining_amount, status, source_type, issued_at, expires_at) VALUES
  ('00000000-0000-0000-0000-0000000c0101', '$C', 'JPY', 10000, 10000, 'active', 'manual_admin', now() + interval '1 second', now() + interval '1 year'),
  ('00000000-0000-0000-0000-0000000c0102', '$C', 'JPY', 10000, 10000, 'active', 'manual_admin', now() + interval '1 second', now() + interval '1 year');
SQL
sleep 1.2
REC() { echo "SELECT public.mark_web_order_refund_issued_atomic('00000000-0000-0000-0000-0000000c0e0$1', '$ADMIN', 'store_credit_exception', current_date, NULL, '{\"customer_request\":\"race\",\"store_credit_lot_id\":\"$2\"}'::jsonb)"; }

# 1. two orders, one lot: A holds its transaction open 2 s after recording
( "${PSQL[@]}" -c "BEGIN" -c "$(REC 1 00000000-0000-0000-0000-0000000c0101)" -c "SELECT pg_sleep(2)" -c "COMMIT" > /tmp/race_a.out 2>&1 ) &
sleep 0.5
B=$("${PSQL[@]}" -c "$(REC 2 00000000-0000-0000-0000-0000000c0101)" 2>&1)
wait
A=$(head -1 /tmp/race_a.out)
N=$("${PSQL[@]}" -c "SELECT count(*) FROM public.card_refund_exceptions WHERE store_credit_lot_id = '00000000-0000-0000-0000-0000000c0101'")
ok "$([ "$N" = "1" ] && echo "$A" | grep -q '"ok": true' && echo "$B" | grep -q 'lot_already_allocated' && echo true || echo false)" \
   "two orders racing for one lot: exactly one allocation, the other refused (lot_already_allocated)" "A=$A B=$B N=$N"

# 2. two approvers on the same order at once
( "${PSQL[@]}" -c "BEGIN" -c "SELECT public.approve_card_refund_exception_atomic('00000000-0000-0000-0000-0000000c0e03', '$ADMIN', 'bank_transfer', 'rf_race3', 'X', 10000, NULL)" -c "SELECT pg_sleep(2)" -c "COMMIT" > /tmp/race_c.out 2>&1 ) &
sleep 0.5
D=$("${PSQL[@]}" -c "SELECT public.approve_card_refund_exception_atomic('00000000-0000-0000-0000-0000000c0e03', '$ADMIN', 'bank_transfer', 'rf_race3', 'Y', 10000, NULL)" 2>&1)
wait
N=$("${PSQL[@]}" -c "SELECT count(*) FROM public.card_refund_exceptions WHERE cash_order_id = '00000000-0000-0000-0000-0000000c0e03' AND status <> 'cancelled'")
ok "$([ "$N" = "1" ] && echo "$D" | grep -q 'exception_exists' && echo true || echo false)" \
   "two approvers at once: exactly one approval, the other refused (exception_exists)" "D=$D N=$N"

# 3. the lot is voided (row locked) while the allocation runs
( "${PSQL[@]}" -c "BEGIN" -c "UPDATE public.store_credit_lots SET status = 'voided', remaining_amount = 0 WHERE id = '00000000-0000-0000-0000-0000000c0102'" -c "SELECT pg_sleep(2)" -c "COMMIT" > /tmp/race_v.out 2>&1 ) &
sleep 0.5
E=$("${PSQL[@]}" -c "$(REC 4 00000000-0000-0000-0000-0000000c0102)" 2>&1)
wait
ok "$(echo "$E" | grep -q 'lot_not_active' && echo true || echo false)" \
   "void racing allocation: the allocation waits for the void, then refuses (lot_not_active)" "E=$E"

"${PSQL[@]}" <<SQL
DELETE FROM public.card_refund_exceptions WHERE cash_order_id IN (SELECT id FROM public.cash_orders WHERE customer_id = '$C');
DELETE FROM public.store_credit_lots WHERE customer_id = '$C';
DELETE FROM public.square_refunds WHERE square_payment_id LIKE 'sq_race%';
DELETE FROM public.square_payments WHERE square_payment_id LIKE 'sq_race%';
DELETE FROM public.cash_payments WHERE cash_order_id IN (SELECT id FROM public.cash_orders WHERE customer_id = '$C');
DELETE FROM public.staff_notifications WHERE metadata ->> 'cash_order_id' IN (SELECT id::text FROM public.cash_orders WHERE customer_id = '$C');
DELETE FROM public.audit_logs WHERE entity_id IN (SELECT id FROM public.cash_orders WHERE customer_id = '$C');
DELETE FROM public.cash_orders WHERE customer_id = '$C';
DELETE FROM public.customers WHERE id = '$C';
SQL
echo "$pass passed, $fail failed"
[ "$fail" = "0" ]

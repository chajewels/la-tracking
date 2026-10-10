#!/usr/bin/env bash
# QA reopen of Paidy F2 (2026-10-10): the two reproduced gaps, on a REAL
# Postgres with migration 20261208150000 applied. LOCAL SCRATCH DATABASE ONLY —
# it refuses anything but a local socket / localhost, and a db named replay*.
#
#   Usage: development/sql/paidy-recorded-bell-once.sh <socket-dir|localhost> <port> <replay_db>
#   (build the db with: scripts/structure-drift-audit replay --host … --db replay_x)
#
#   T1  237 Paidy recordings in the window; bells on all but #4, #52, #100,
#       #101, #151, #237 → paidy_recorded_bell_missing (keyset-paged by 100)
#       returns exactly those six; after ringing them it returns none.
#   T2  two sessions ring the SAME payment, the first holding its transaction
#       open → the second waits on the unique index and gets false; one row.
#   T3  four parallel workers each ring the same 300 payments in a different
#       order, one transaction per ring (as each rpc call is) → exactly 300 rows and exactly 300 "true" answers in total.
set -euo pipefail
HOST=$1; PORT=$2; DB=$3
case "$HOST" in /*|localhost|127.0.0.1|::1) ;; *) echo "refusing: local only" >&2; exit 2;; esac
case "$DB" in replay*) ;; *) echo "refusing: db must start with replay" >&2; exit 2;; esac
P=(psql -h "$HOST" -p "$PORT" -d "$DB" -v ON_ERROR_STOP=1 -tAq)
fail() { echo "FAIL: $*" >&2; exit 1; }

"${P[@]}" <<'SQL'
SET session_replication_role = replica;  -- fixtures only: no triggers / FK checks
DELETE FROM public.staff_notifications WHERE metadata->>'qa_f2' = 't';
DELETE FROM public.payment_submissions WHERE notes = 'qa_f2';
DELETE FROM public.cash_payments WHERE remarks = 'qa_f2';
CREATE TEMP TABLE f AS
  SELECT i, gen_random_uuid() AS pay_id, gen_random_uuid() AS sub_id, gen_random_uuid() AS order_id,
         now() - interval '2 days' + make_interval(secs => i) AS at
    FROM generate_series(1, 237) i;
INSERT INTO public.cash_payments (id, cash_order_id, amount_paid, currency, date_paid, created_at, remarks)
  SELECT pay_id, order_id, 1000 + i, 'JPY', current_date, at, 'qa_f2' FROM f;
INSERT INTO public.payment_submissions (id, customer_id, submitted_amount, payment_date, payment_method, status,
                                        paidy_payment_id, confirmed_payment_id, cash_order_id, notes)
  SELECT sub_id, gen_random_uuid(), 1000 + i, current_date, 'paidy', 'confirmed', gen_random_uuid(), pay_id, order_id, 'qa_f2' FROM f;
INSERT INTO public.staff_notifications (type, title, body, metadata)
  SELECT 'paidy_payment_recorded', 't', 'b', jsonb_build_object('cash_payment_id', pay_id::text, 'qa_f2', 't')
    FROM f WHERE i NOT IN (4, 52, 100, 101, 151, 237);
CREATE TABLE IF NOT EXISTS public.qa_f2_ids AS SELECT i, pay_id FROM f WITH NO DATA;
TRUNCATE public.qa_f2_ids; INSERT INTO public.qa_f2_ids SELECT i, pay_id FROM f;
SQL

# T1 — page through the lister exactly as the sweep does
got=$("${P[@]}" <<'SQL'
DROP TABLE IF EXISTS public.qa_f2_found;
CREATE TABLE public.qa_f2_found (id uuid);
DO $t1$
DECLARE a_at timestamptz; a_id uuid; n int; pages int := 0;
BEGIN
  LOOP
    pages := pages + 1;
    INSERT INTO public.qa_f2_found
      SELECT m.cash_payment_id FROM public.paidy_recorded_bell_missing(now() - interval '7 days', now(), a_at, a_id, 100) m;
    GET DIAGNOSTICS n = ROW_COUNT;
    EXIT WHEN n < 100 OR pages > 10;
    SELECT m.payment_created_at, m.cash_payment_id INTO a_at, a_id
      FROM public.paidy_recorded_bell_missing(now() - interval '7 days', now(), a_at, a_id, 100) m
     ORDER BY m.payment_created_at DESC, m.cash_payment_id DESC LIMIT 1;
  END LOOP;
END
$t1$;
SELECT string_agg(q.i::text, ',' ORDER BY q.i) FROM public.qa_f2_ids q JOIN public.qa_f2_found f ON f.id = q.pay_id;
SQL
)
[ "$got" = "4,52,100,101,151,237" ] || fail "T1 missing list = '$got'"
"${P[@]}" -c "SELECT public.ring_paidy_payment_recorded_bell('t','b', jsonb_build_object('cash_payment_id', pay_id::text, 'qa_f2', 't')) FROM public.qa_f2_ids WHERE i IN (4,52,100,101,151,237)" >/dev/null
left=$("${P[@]}" -c "SELECT count(*) FROM public.paidy_recorded_bell_missing(now() - interval '7 days', now(), NULL, NULL, 500) m JOIN public.qa_f2_ids q ON q.pay_id = m.cash_payment_id")
[ "$left" = "0" ] || fail "T1 after ringing, $left still missing"
echo "T1 PASS: the six missing bells beyond the first 50 were all found (pages of 100) and rung; none left"

# T2 — two sessions, same payment, first holds its transaction
X=$("${P[@]}" -c "SELECT gen_random_uuid()")
( "${P[@]}" -c "BEGIN; SELECT public.ring_paidy_payment_recorded_bell('t','b', jsonb_build_object('cash_payment_id','$X','qa_f2','t')); SELECT pg_sleep(3); COMMIT;" > /tmp/qa_f2_a ) &
sleep 1
b=$("${P[@]}" -c "SELECT public.ring_paidy_payment_recorded_bell('t','b', jsonb_build_object('cash_payment_id','$X','qa_f2','t'))")
wait
a=$(head -1 /tmp/qa_f2_a)
rows=$("${P[@]}" -c "SELECT count(*) FROM public.staff_notifications WHERE type='paidy_payment_recorded' AND metadata->>'cash_payment_id'='$X'")
[ "$a" = "t" ] && [ "$b" = "f" ] && [ "$rows" = "1" ] || fail "T2 a=$a b=$b rows=$rows"
echo "T2 PASS: overlapping ring waited on the unique index and returned false; exactly one bell"

# T3 — four parallel workers, same 300 payments, different orders
"${P[@]}" -c "DROP TABLE IF EXISTS public.qa_f2_t3; CREATE TABLE public.qa_f2_t3 AS SELECT gen_random_uuid() AS id FROM generate_series(1,300)"
for w in 1 2 3 4; do
  # One ring = one transaction, as each PostgREST rpc call is (\gexec runs each in autocommit).
  ( printf '%s\n' "SELECT format('SELECT public.ring_paidy_payment_recorded_bell(''t'',''b'', jsonb_build_object(''cash_payment_id'', %L, ''qa_f2'', ''t''))', id) FROM public.qa_f2_t3 ORDER BY md5(id::text || '$w')" '\gexec' \
      | "${P[@]}" | grep -c '^t$' > /tmp/qa_f2_w$w || true ) &
done
wait
total=$(( $(cat /tmp/qa_f2_w1) + $(cat /tmp/qa_f2_w2) + $(cat /tmp/qa_f2_w3) + $(cat /tmp/qa_f2_w4) ))
rows=$("${P[@]}" -c "SELECT count(*) FROM public.staff_notifications n JOIN public.qa_f2_t3 t ON n.metadata->>'cash_payment_id' = t.id::text WHERE n.type='paidy_payment_recorded'")
[ "$total" = "300" ] && [ "$rows" = "300" ] || fail "T3 true-answers=$total rows=$rows"
echo "T3 PASS: 4 parallel workers × 300 payments → 300 bells, 300 winners, no duplicates"

"${P[@]}" -c "DROP TABLE public.qa_f2_t3; DROP TABLE public.qa_f2_ids; DROP TABLE public.qa_f2_found" >/dev/null
echo "ALL PASS"

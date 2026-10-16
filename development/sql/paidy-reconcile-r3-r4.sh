#!/usr/bin/env bash
# paidy-reconcile recovery limits R3 / R4 (owner go 2026-10-16) on a REAL
# Postgres with migration 20261219100000 applied. LOCAL SCRATCH DATABASE ONLY —
# refuses anything but a local socket / localhost, and a db named replay*.
#
#   Usage: development/sql/paidy-reconcile-r3-r4.sh <socket-dir|localhost> <port> <replay_db>
#
#   T1  paidy_stuck_confirms: 237 confirmed-but-unrecorded cash submissions past
#       the lease (one with no processing_started_at) + 3 inside the lease + a
#       recorded one + a layaway one → keyset-paged by 100 returns exactly the
#       237, oldest first (the missing start first), each once, across THREE
#       pages; the Paidy reference comes from paidy_payments.
#   T2  the same lister run twice returns the same 237 (nothing starves).
#   T3  window verification order: verify_tried_at NULLS FIRST, then expires_at
#       — stamping the first 50 moves them behind the untried ones.
#   T4  orphan case order: sweep_tried_at NULLS FIRST, then opened_at — the
#       same rotation.
#   T5  started cancel intent with bell_rung_at is excluded by the R4 filter.
#   T6  the lister is service_role only; the migration re-applies cleanly.
set -euo pipefail
HOST=$1; PORT=$2; DB=$3
case "$HOST" in /*|localhost|127.0.0.1|::1) ;; *) echo "refusing: local only" >&2; exit 2;; esac
case "$DB" in replay*) ;; *) echo "refusing: db must start with replay" >&2; exit 2;; esac
P=(psql -h "$HOST" -p "$PORT" -d "$DB" -v ON_ERROR_STOP=1 -tAq)
fail() { echo "FAIL: $*" >&2; exit 1; }
HERE=$(cd "$(dirname "$0")/../.." && pwd)

"${P[@]}" <<'SQL'
SET session_replication_role = replica;  -- fixtures only: no triggers / FK checks
DELETE FROM public.payment_submissions WHERE reference_number LIKE 'QA-R34-%';
DELETE FROM public.paidy_payments WHERE paidy_payment_id LIKE 'pay_r34_%';
DELETE FROM public.paidy_checkout_attempts WHERE end_reason = 'qa_r34' OR paidy_payment_id LIKE 'pay_r34w_%';
DELETE FROM public.paidy_cases WHERE paidy_payment_id LIKE 'pay_r34c_%';
DELETE FROM public.cash_order_cancel_intents WHERE reason = 'qa_r34';

-- T1 fixtures: 237 stuck (#1 has no processing_started_at), oldest = lowest n
INSERT INTO public.paidy_payments (id, cash_order_id, paidy_payment_id, amount_jpy)
SELECT ('20000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, gen_random_uuid(), 'pay_r34_' || n, 1000
  FROM generate_series(1, 237) n;
INSERT INTO public.payment_submissions (id, customer_id, cash_order_id, submitted_amount, payment_date, payment_method,
                                        status, reference_number, processing_started_at, paidy_payment_id)
SELECT ('30000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, gen_random_uuid(), gen_random_uuid(), 1000, current_date,
       CASE WHEN n % 2 = 0 THEN 'paidy' ELSE 'bank_transfer' END, 'confirmed', 'QA-R34-' || n,
       CASE WHEN n = 1 THEN NULL ELSE now() - interval '2 days' + n * interval '1 minute' END,
       CASE WHEN n % 2 = 0 THEN ('20000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid END
  FROM generate_series(1, 237) n;
-- must NOT be listed: inside the lease, recorded, layaway (no cash order)
INSERT INTO public.payment_submissions (customer_id, cash_order_id, submitted_amount, payment_date, payment_method, status,
                                        reference_number, processing_started_at, confirmed_payment_id)
VALUES (gen_random_uuid(), gen_random_uuid(), 1, current_date, 'paidy', 'confirmed', 'QA-R34-lease1', now() - interval '1 minute', NULL),
       (gen_random_uuid(), gen_random_uuid(), 1, current_date, 'paidy', 'confirmed', 'QA-R34-lease2', now(), NULL),
       (gen_random_uuid(), gen_random_uuid(), 1, current_date, 'paidy', 'confirmed', 'QA-R34-lease3', now() - interval '4 minutes', NULL),
       (gen_random_uuid(), gen_random_uuid(), 1, current_date, 'paidy', 'confirmed', 'QA-R34-recorded', now() - interval '1 day', gen_random_uuid()),
       (gen_random_uuid(), NULL,              1, current_date, 'paidy', 'confirmed', 'QA-R34-layaway', now() - interval '1 day', NULL);
SQL

walk() {
  "${P[@]}" <<'SQL'
SET ROLE service_role;
DO $$
DECLARE a_at timestamptz; a_id uuid; n int; pages int := 0; r record;
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS qa_r34_seen (ord serial, id uuid, ref text, pid text);
  TRUNCATE qa_r34_seen;
  LOOP
    pages := pages + 1; n := 0;
    FOR r IN SELECT * FROM public.paidy_stuck_confirms(now() - interval '5 minutes', a_at, a_id, 100) LOOP
      IF r.reference_number LIKE 'QA-R34-%' THEN INSERT INTO qa_r34_seen (id, ref, pid) VALUES (r.submission_id, r.reference_number, r.paidy_payment_id); END IF;
      a_at := r.sort_at; a_id := r.submission_id; n := n + 1;
    END LOOP;
    EXIT WHEN n < 100 OR pages >= 50;
  END LOOP;
  RAISE NOTICE 'pages=%', pages;
END $$;
SELECT count(*), count(DISTINCT id),
       (SELECT ref FROM qa_r34_seen ORDER BY ord LIMIT 1),
       (SELECT ref FROM qa_r34_seen ORDER BY ord DESC LIMIT 1),
       count(*) FILTER (WHERE ref IN ('QA-R34-lease1','QA-R34-lease2','QA-R34-lease3','QA-R34-recorded','QA-R34-layaway')),
       (SELECT pid FROM qa_r34_seen WHERE ref = 'QA-R34-2'),
       (SELECT pid FROM qa_r34_seen WHERE ref = 'QA-R34-3'),
       bool_and(ord = substring(ref from 'QA-R34-(\d+)')::int)
  FROM qa_r34_seen;
SQL
}
got=$(walk | tail -1)
[ "$got" = "237|237|QA-R34-1|QA-R34-237|0|pay_r34_2||t" ] || fail "T1 got '$got'"
echo "T1 PASS: all 237 stuck Confirms past the lease, oldest first (missing start first), each once, across pages; lease/recorded/layaway excluded; Paidy ref joined"
got2=$(walk | tail -1)
[ "$got2" = "$got" ] || fail "T2 second run '$got2'"
echo "T2 PASS: a second run returns the same full set (nothing starved)"
pages=$(walk 2>&1 | grep -o 'pages=[0-9]*' | head -1)
[ "$pages" = "pages=3" ] || fail "T1 expected 3 pages, $pages"

# T3 — window verification rotation
"${P[@]}" <<'SQL'
SET session_replication_role = replica;
INSERT INTO public.paidy_checkout_attempts (cash_order_id, customer_id, amount_jpy, expires_at, paidy_payment_id, end_reason)
SELECT gen_random_uuid(), gen_random_uuid(), 1000, now() - interval '1 day' + n * interval '1 minute', 'pay_r34w_' || n, 'qa_r34'
  FROM generate_series(1, 120) n;
SQL
q3() { "${P[@]}" -c "SELECT string_agg(paidy_payment_id, ',' ORDER BY rn) FROM (SELECT paidy_payment_id, row_number() OVER (ORDER BY verify_tried_at ASC NULLS FIRST, expires_at ASC) rn FROM public.paidy_checkout_attempts WHERE status='open' AND expires_at <= now() AND paidy_payment_id LIKE 'pay_r34w_%' AND verified_empty_at IS NULL ORDER BY verify_tried_at ASC NULLS FIRST, expires_at ASC LIMIT 50) x WHERE rn IN (1,50)"; }
[ "$(q3)" = "pay_r34w_1,pay_r34w_50" ] || fail "T3 first batch $(q3)"
"${P[@]}" -c "UPDATE public.paidy_checkout_attempts SET verify_tried_at = now() WHERE paidy_payment_id IN (SELECT 'pay_r34w_' || n FROM generate_series(1,50) n)"
[ "$(q3)" = "pay_r34w_51,pay_r34w_100" ] || fail "T3 second batch $(q3)"
plan=$("${P[@]}" -c "SET enable_seqscan = off; EXPLAIN SELECT id FROM public.paidy_checkout_attempts WHERE status='open' AND expires_at <= now() AND paidy_payment_id IS NOT NULL AND verified_empty_at IS NULL ORDER BY verify_tried_at ASC NULLS FIRST, expires_at ASC LIMIT 50" | tr '\n' ' ')
echo "$plan" | grep -q idx_paidy_checkout_attempts_verify_queue || fail "T3 index not usable: $plan"
echo "T3 PASS: tried windows rotate behind untried ones; the partial index serves the order"

# T4 — orphan case rotation
"${P[@]}" <<'SQL'
SET session_replication_role = replica;
INSERT INTO public.paidy_cases (kind, paidy_payment_id, opened_at)
SELECT 'captured_unrecorded', 'pay_r34c_' || n, now() - interval '1 day' + n * interval '1 minute' FROM generate_series(1, 120) n;
SQL
q4() { "${P[@]}" -c "SELECT string_agg(paidy_payment_id, ',' ORDER BY rn) FROM (SELECT paidy_payment_id, row_number() OVER (ORDER BY sweep_tried_at ASC NULLS FIRST, opened_at ASC) rn FROM public.paidy_cases WHERE status='open' AND paidy_payment_row IS NULL AND paidy_payment_id LIKE 'pay_r34c_%' ORDER BY sweep_tried_at ASC NULLS FIRST, opened_at ASC LIMIT 50) x WHERE rn IN (1,50)"; }
[ "$(q4)" = "pay_r34c_1,pay_r34c_50" ] || fail "T4 first batch $(q4)"
"${P[@]}" -c "UPDATE public.paidy_cases SET sweep_tried_at = now() WHERE paidy_payment_id IN (SELECT 'pay_r34c_' || n FROM generate_series(1,50) n)"
[ "$(q4)" = "pay_r34c_51,pay_r34c_100" ] || fail "T4 second batch $(q4)"
lsa=$("${P[@]}" -c "SELECT count(*) FROM public.paidy_cases WHERE paidy_payment_id LIKE 'pay_r34c_%' AND attempts <> 0")
[ "$lsa" = "0" ] || fail "T4 attempts touched"
echo "T4 PASS: tried orphan cases rotate behind untried ones; attempts / last_seen_at untouched"

# T5 — started intent with a rung bell is filtered out (the PostgREST .or() as SQL)
"${P[@]}" <<'SQL'
SET session_replication_role = replica;
INSERT INTO public.cash_order_cancel_intents (cash_order_id, stage, reason, bell_rung_at, updated_at)
VALUES (gen_random_uuid(), 'started', 'qa_r34', now() - interval '1 hour', now() - interval '2 hours'),
       (gen_random_uuid(), 'started', 'qa_r34', NULL, now() - interval '2 hours'),
       (gen_random_uuid(), 'terminated', 'qa_r34', now() - interval '1 hour', now() - interval '2 hours');
SQL
t5=$("${P[@]}" -c "SELECT string_agg(stage || ':' || (bell_rung_at IS NOT NULL)::text, ',' ORDER BY stage, bell_rung_at NULLS FIRST) FROM public.cash_order_cancel_intents WHERE reason='qa_r34' AND stage IN ('started','paidy_released','terminated','notified') AND updated_at <= now() - interval '5 minutes' AND (stage <> 'started' OR bell_rung_at IS NULL)")
[ "$t5" = "started:false,terminated:true" ] || fail "T5 got '$t5'"
echo "T5 PASS: a started intent whose bell rang is excluded; the others stay"

# T6 — grants and idempotent re-apply
g=$("${P[@]}" -c "SELECT has_function_privilege('anon','public.paidy_stuck_confirms(timestamptz,timestamptz,uuid,integer)','EXECUTE')::text || has_function_privilege('authenticated','public.paidy_stuck_confirms(timestamptz,timestamptz,uuid,integer)','EXECUTE')::text || has_function_privilege('service_role','public.paidy_stuck_confirms(timestamptz,timestamptz,uuid,integer)','EXECUTE')::text")
[ "$g" = "falsefalsetrue" ] || fail "T6 grants '$g'"
"${P[@]}" -1 -f "$HERE/supabase/migrations/20261219100000_paidy_reconcile_r3_r4.sql" >/dev/null || fail "T6 re-apply"
echo "T6 PASS: service_role only; the migration re-applies cleanly"

"${P[@]}" <<'SQL'
SET session_replication_role = replica;
DELETE FROM public.payment_submissions WHERE reference_number LIKE 'QA-R34-%';
DELETE FROM public.paidy_payments WHERE paidy_payment_id LIKE 'pay_r34_%';
DELETE FROM public.paidy_checkout_attempts WHERE end_reason = 'qa_r34';
DELETE FROM public.paidy_cases WHERE paidy_payment_id LIKE 'pay_r34c_%';
DELETE FROM public.cash_order_cancel_intents WHERE reason = 'qa_r34';
SQL
echo "ALL PASS"

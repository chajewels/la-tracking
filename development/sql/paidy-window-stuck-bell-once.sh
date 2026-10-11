#!/usr/bin/env bash
# QA residual of 2026-10-11 (owner go 11:43 JST): one "Paidy approval still
# waiting" bell per checkout window and a full sweep, on a REAL Postgres with
# migration 20261209130000 applied. LOCAL SCRATCH DATABASE ONLY — refuses
# anything but a local socket / localhost, and a db named replay*.
#
#   Usage: development/sql/paidy-window-stuck-bell-once.sh <socket-dir|localhost> <port> <replay_db>
#
#   T1  237 open, noted windows past the cutoff, all stamped except #4, #52,
#       #100, #101, #151, #237; plus windows that must NOT be listed (not
#       noted, not open, expiry inside the cutoff) → paidy_window_stuck_missing
#       (keyset-paged by 100) returns exactly the six; after ringing, none.
#   T2  two sessions ring the SAME window, the first holding its transaction
#       → the second waits and gets 'exists'; one row; stamped.
#   T3  four parallel workers × the same 300 windows → 300 rows, 300 'rung'.
#   T4  a filed window / a window with no noted approval → 'closed', no bell;
#       unknown id → attempt_not_found.
#   T5  an old bell on an unstamped window → 'exists', stamped, one row; a
#       direct second insert is refused by the unique index.
set -euo pipefail
HOST=$1; PORT=$2; DB=$3
case "$HOST" in /*|localhost|127.0.0.1|::1) ;; *) echo "refusing: local only" >&2; exit 2;; esac
case "$DB" in replay*) ;; *) echo "refusing: db must start with replay" >&2; exit 2;; esac
P=(psql -h "$HOST" -p "$PORT" -d "$DB" -v ON_ERROR_STOP=1 -tAq)
fail() { echo "FAIL: $*" >&2; exit 1; }
CUT="now() - interval '3 hours'"

"${P[@]}" <<'SQL'
SET session_replication_role = replica;  -- fixtures only: no triggers / FK checks
DELETE FROM public.staff_notifications WHERE type = 'paidy_window_stuck' AND metadata ? 'attempt_id'
  AND (metadata->>'attempt_id')::uuid IN (SELECT id FROM public.paidy_checkout_attempts WHERE end_reason = 'qa_ws');
DELETE FROM public.paidy_checkout_attempts WHERE end_reason = 'qa_ws';
CREATE TEMP TABLE f AS
  SELECT i, gen_random_uuid() AS id, now() - interval '2 days' + make_interval(secs => i) AS exp FROM generate_series(1, 237) i;
INSERT INTO public.paidy_checkout_attempts (id, cash_order_id, customer_id, status, amount_jpy, paidy_payment_id,
                                            started_at, expires_at, authorization_noted_at, stuck_bell_at, end_reason)
  SELECT id, gen_random_uuid(), gen_random_uuid(), 'open', 1000, 'pay_qaws_' || i, exp - interval '30 minutes', exp, exp,
         CASE WHEN i IN (4, 52, 100, 101, 151, 237) THEN NULL ELSE exp END, 'qa_ws' FROM f;
-- must NOT be listed: not noted / filed / expiry inside the 3-hour cutoff
INSERT INTO public.paidy_checkout_attempts (cash_order_id, customer_id, status, amount_jpy, started_at, expires_at, authorization_noted_at, end_reason)
VALUES (gen_random_uuid(), gen_random_uuid(), 'open',  1000, now() - interval '2 days', now() - interval '1 day', NULL,  'qa_ws'),
       (gen_random_uuid(), gen_random_uuid(), 'filed', 1000, now() - interval '2 days', now() - interval '1 day', now(), 'qa_ws'),
       (gen_random_uuid(), gen_random_uuid(), 'open',  1000, now() - interval '2 hours', now() - interval '1 hour', now(), 'qa_ws');
DROP TABLE IF EXISTS public.qa_ws_ids;
CREATE TABLE public.qa_ws_ids AS SELECT i, id FROM f;
SQL

# T1 — page through the lister exactly as the sweep does
got=$("${P[@]}" <<'SQL'
DROP TABLE IF EXISTS public.qa_ws_found;
CREATE TABLE public.qa_ws_found (id uuid);
DO $t1$
DECLARE a_at timestamptz; a_id uuid; n int; pages int := 0; cut timestamptz := now() - interval '3 hours';
BEGIN
  LOOP
    pages := pages + 1;
    INSERT INTO public.qa_ws_found SELECT m.attempt_id FROM public.paidy_window_stuck_missing(cut, a_at, a_id, 100) m;
    GET DIAGNOSTICS n = ROW_COUNT;
    EXIT WHEN n < 100 OR pages > 10;
    SELECT m.expires_at, m.attempt_id INTO a_at, a_id FROM public.paidy_window_stuck_missing(cut, a_at, a_id, 100) m
     ORDER BY m.expires_at DESC, m.attempt_id DESC LIMIT 1;
  END LOOP;
END
$t1$;
SELECT coalesce(string_agg(q.i::text, ',' ORDER BY q.i), '') || '|' ||
       (SELECT count(*) FROM public.qa_ws_found x JOIN public.paidy_checkout_attempts a ON a.id = x.id
         WHERE a.end_reason = 'qa_ws' AND a.id NOT IN (SELECT id FROM public.qa_ws_ids))
  FROM public.qa_ws_ids q JOIN public.qa_ws_found f ON f.id = q.id;
SQL
)
[ "$got" = "4,52,100,101,151,237|0" ] || fail "T1 missing list = '$got'"
rung=$("${P[@]}" -c "SELECT string_agg(public.ring_paidy_window_stuck_bell(id, 't', 'b', '{}'), ',') FROM public.qa_ws_ids WHERE i IN (4,52,100,101,151,237)")
[ "$rung" = "rung,rung,rung,rung,rung,rung" ] || fail "T1 ring answers = '$rung'"
left=$("${P[@]}" -c "SELECT count(*) FROM public.paidy_window_stuck_missing($CUT, NULL, NULL, 500) m JOIN public.qa_ws_ids q ON q.id = m.attempt_id")
[ "$left" = "0" ] || fail "T1 after ringing, $left still listed"
bad=$("${P[@]}" -c "SELECT count(*) FROM public.qa_ws_ids q JOIN public.staff_notifications n ON n.type='paidy_window_stuck' AND n.metadata->>'attempt_id' = q.id::text WHERE q.i IN (4,52,100,101,151,237) AND (n.metadata->>'paidy_payment_id' IS DISTINCT FROM 'pay_qaws_' || q.i OR n.metadata->>'cash_order_id' IS NULL)")
[ "$bad" = "0" ] || fail "T1 $bad bells with wrong metadata"
echo "T1 PASS: the six waiting windows beyond the first page were found (pages of 100), the three ineligible ones skipped, rung; none left"

# T2 — two sessions, same window
X=$("${P[@]}" -c "SET session_replication_role = replica; INSERT INTO public.paidy_checkout_attempts (cash_order_id, customer_id, status, amount_jpy, started_at, expires_at, authorization_noted_at, end_reason) VALUES (gen_random_uuid(), gen_random_uuid(), 'open', 1000, now() - interval '1 day', now() - interval '5 hours', now(), 'qa_ws') RETURNING id")
( "${P[@]}" -c "BEGIN; SELECT public.ring_paidy_window_stuck_bell('$X','t','b','{}'); SELECT pg_sleep(3); COMMIT;" > /tmp/qa_ws_a ) &
sleep 1
b=$("${P[@]}" -c "SELECT public.ring_paidy_window_stuck_bell('$X','t','b','{}')")
wait
a=$(head -1 /tmp/qa_ws_a)
rows=$("${P[@]}" -c "SELECT count(*) FROM public.staff_notifications WHERE type='paidy_window_stuck' AND metadata->>'attempt_id'='$X'")
stamped=$("${P[@]}" -c "SELECT stuck_bell_at IS NOT NULL FROM public.paidy_checkout_attempts WHERE id='$X'")
[ "$a" = "rung" ] && [ "$b" = "exists" ] && [ "$rows" = "1" ] && [ "$stamped" = "t" ] || fail "T2 a=$a b=$b rows=$rows stamped=$stamped"
echo "T2 PASS: overlapping ring waited and returned 'exists'; one bell; window stamped"

# T3 — four parallel workers
"${P[@]}" <<'SQL'
DROP TABLE IF EXISTS public.qa_ws_t3;
CREATE TABLE public.qa_ws_t3 AS SELECT gen_random_uuid() AS id, i FROM generate_series(1,300) i;
SET session_replication_role = replica;
INSERT INTO public.paidy_checkout_attempts (id, cash_order_id, customer_id, status, amount_jpy, started_at, expires_at, authorization_noted_at, end_reason)
  SELECT id, gen_random_uuid(), gen_random_uuid(), 'open', 1000, now() - interval '1 day', now() - interval '5 hours', now(), 'qa_ws' FROM public.qa_ws_t3;
SQL
for w in 1 2 3 4; do
  ( printf '%s\n' "SELECT format('SELECT public.ring_paidy_window_stuck_bell(%L, ''t'', ''b'', ''{}'')', id) FROM public.qa_ws_t3 ORDER BY md5(id::text || '$w')" '\gexec' \
      | "${P[@]}" | grep -c '^rung$' > /tmp/qa_ws_w$w || true ) &
done
wait
total=$(( $(cat /tmp/qa_ws_w1) + $(cat /tmp/qa_ws_w2) + $(cat /tmp/qa_ws_w3) + $(cat /tmp/qa_ws_w4) ))
rows=$("${P[@]}" -c "SELECT count(*) FROM public.staff_notifications n JOIN public.qa_ws_t3 t ON n.metadata->>'attempt_id' = t.id::text WHERE n.type='paidy_window_stuck'")
unstamped=$("${P[@]}" -c "SELECT count(*) FROM public.paidy_checkout_attempts a JOIN public.qa_ws_t3 t ON t.id = a.id WHERE a.stuck_bell_at IS NULL")
[ "$total" = "300" ] && [ "$rows" = "300" ] && [ "$unstamped" = "0" ] || fail "T3 rung=$total rows=$rows unstamped=$unstamped"
echo "T3 PASS: 4 parallel workers × 300 windows → 300 bells, 300 winners, all stamped"

# T4 — closed / not noted / unknown
F=$("${P[@]}" -c "SELECT id FROM public.paidy_checkout_attempts WHERE end_reason='qa_ws' AND status='filed' LIMIT 1")
N=$("${P[@]}" -c "SELECT id FROM public.paidy_checkout_attempts WHERE end_reason='qa_ws' AND status='open' AND authorization_noted_at IS NULL LIMIT 1")
rf=$("${P[@]}" -c "SELECT public.ring_paidy_window_stuck_bell('$F','t','b','{}')")
rn=$("${P[@]}" -c "SELECT public.ring_paidy_window_stuck_bell('$N','t','b','{}')")
rows=$("${P[@]}" -c "SELECT count(*) FROM public.staff_notifications WHERE metadata->>'attempt_id' IN ('$F','$N')")
err=$("${P[@]}" -c "SELECT public.ring_paidy_window_stuck_bell(gen_random_uuid(),'t','b','{}')" 2>&1 || true)
[ "$rf" = "closed" ] && [ "$rn" = "closed" ] && [ "$rows" = "0" ] && echo "$err" | grep -q "attempt_not_found" || fail "T4 rf=$rf rn=$rn rows=$rows err=$err"
echo "T4 PASS: filed and not-noted windows → 'closed', no bell; unknown → attempt_not_found"

# T5 — old bell, unstamped window
Y=$("${P[@]}" -c "SET session_replication_role = replica; INSERT INTO public.paidy_checkout_attempts (cash_order_id, customer_id, status, amount_jpy, started_at, expires_at, authorization_noted_at, end_reason) VALUES (gen_random_uuid(), gen_random_uuid(), 'open', 1000, now() - interval '1 day', now() - interval '5 hours', now(), 'qa_ws') RETURNING id")
"${P[@]}" -c "INSERT INTO public.staff_notifications (type, title, body, metadata) VALUES ('paidy_window_stuck','old','old', jsonb_build_object('attempt_id','$Y'))" >/dev/null
r=$("${P[@]}" -c "SELECT public.ring_paidy_window_stuck_bell('$Y','t','b','{}')")
rows=$("${P[@]}" -c "SELECT count(*) FROM public.staff_notifications WHERE metadata->>'attempt_id'='$Y'")
stamped=$("${P[@]}" -c "SELECT stuck_bell_at IS NOT NULL FROM public.paidy_checkout_attempts WHERE id='$Y'")
dup=$("${P[@]}" -c "INSERT INTO public.staff_notifications (type, title, body, metadata) VALUES ('paidy_window_stuck','x','x', jsonb_build_object('attempt_id','$Y'))" 2>&1 || true)
[ "$r" = "exists" ] && [ "$rows" = "1" ] && [ "$stamped" = "t" ] && echo "$dup" | grep -q "uq_staff_notifications_paidy_window_stuck" || fail "T5 r=$r rows=$rows stamped=$stamped dup=$dup"
echo "T5 PASS: existing bell → 'exists', stamped, one row; a direct second insert is refused by the unique index"

"${P[@]}" <<'SQL' >/dev/null
SET session_replication_role = replica;
DELETE FROM public.staff_notifications WHERE type = 'paidy_window_stuck' AND metadata ? 'attempt_id'
  AND (metadata->>'attempt_id')::uuid IN (SELECT id FROM public.paidy_checkout_attempts WHERE end_reason = 'qa_ws');
DELETE FROM public.paidy_checkout_attempts WHERE end_reason = 'qa_ws';
DROP TABLE public.qa_ws_t3; DROP TABLE public.qa_ws_ids; DROP TABLE public.qa_ws_found;
SQL
echo "ALL PASS"

#!/usr/bin/env bash
# "fix 6c" (owner 2026-10-11): one bell per Paidy case and a full sweep, on a
# REAL Postgres with migration 20261209100000 applied. LOCAL SCRATCH DATABASE
# ONLY — it refuses anything but a local socket / localhost, and a db named
# replay*.
#
#   Usage: development/sql/paidy-case-bell-once.sh <socket-dir|localhost> <port> <replay_db>
#   (build the db with: scripts/structure-drift-audit replay --host … --db replay_x)
#
#   T1  237 open cases, all stamped except #4, #52, #100, #101, #151, #237,
#       plus 5 resolved unrung cases → paidy_case_bell_missing (keyset-paged
#       by 100) returns exactly those six; after ringing them it returns none,
#       and each bell's type is paidy_case_<its kind>.
#   T2  two sessions ring the SAME case, the first holding its transaction
#       open → the second waits on the case lock and gets 'exists'; one row.
#   T3  four parallel workers each ring the same 300 cases in a different
#       order, one transaction per ring → exactly 300 rows, 300 'rung'.
#   T4  a resolved case → 'closed', no bell; an unknown case → case_not_found.
#   T5  a bell already present but the case unstamped (old code) → 'exists',
#       the case is stamped, still one row.
set -euo pipefail
HOST=$1; PORT=$2; DB=$3
case "$HOST" in /*|localhost|127.0.0.1|::1) ;; *) echo "refusing: local only" >&2; exit 2;; esac
case "$DB" in replay*) ;; *) echo "refusing: db must start with replay" >&2; exit 2;; esac
P=(psql -h "$HOST" -p "$PORT" -d "$DB" -v ON_ERROR_STOP=1 -tAq)
fail() { echo "FAIL: $*" >&2; exit 1; }

"${P[@]}" <<'SQL'
SET session_replication_role = replica;  -- fixtures only: no triggers / FK checks
DELETE FROM public.staff_notifications WHERE type LIKE 'paidy\_case\_%' AND metadata ? 'case_id'
  AND (metadata->>'case_id')::uuid IN (SELECT id FROM public.paidy_cases WHERE detail->>'qa_6c' = 't');
DELETE FROM public.paidy_cases WHERE detail->>'qa_6c' = 't';
CREATE TEMP TABLE f AS
  SELECT i, gen_random_uuid() AS case_id,
         (ARRAY['close_failed','record_failed','captured_unrecorded','stale_authorization'])[1 + i % 4] AS kind,
         now() - interval '2 days' + make_interval(secs => i) AS at
    FROM generate_series(1, 237) i;
INSERT INTO public.paidy_cases (id, kind, status, paidy_payment_id, detail, opened_at, bell_rung_at)
  SELECT case_id, kind, 'open', 'pay_qa6c_' || i, '{"qa_6c":"t"}', at,
         CASE WHEN i IN (4, 52, 100, 101, 151, 237) THEN NULL ELSE at END FROM f;
INSERT INTO public.paidy_cases (kind, status, paidy_payment_id, detail, opened_at, resolved_at, resolution)
  SELECT 'record_failed', 'resolved', 'pay_qa6c_r' || i, '{"qa_6c":"t"}', now() - interval '3 days', now(), 'qa'
    FROM generate_series(1, 5) i;
DROP TABLE IF EXISTS public.qa_6c_ids;
CREATE TABLE public.qa_6c_ids AS SELECT i, case_id, kind FROM f;
SQL

# T1 — page through the lister exactly as the sweep does
got=$("${P[@]}" <<'SQL'
DROP TABLE IF EXISTS public.qa_6c_found;
CREATE TABLE public.qa_6c_found (id uuid);
DO $t1$
DECLARE a_at timestamptz; a_id uuid; n int; pages int := 0;
BEGIN
  LOOP
    pages := pages + 1;
    INSERT INTO public.qa_6c_found SELECT m.case_id FROM public.paidy_case_bell_missing(a_at, a_id, 100) m;
    GET DIAGNOSTICS n = ROW_COUNT;
    EXIT WHEN n < 100 OR pages > 10;
    SELECT m.opened_at, m.case_id INTO a_at, a_id FROM public.paidy_case_bell_missing(a_at, a_id, 100) m
     ORDER BY m.opened_at DESC, m.case_id DESC LIMIT 1;
  END LOOP;
END
$t1$;
SELECT coalesce(string_agg(q.i::text, ',' ORDER BY q.i), '') || '|' ||
       (SELECT count(*) FROM public.qa_6c_found x JOIN public.paidy_cases c ON c.id = x.id WHERE c.status <> 'open')
  FROM public.qa_6c_ids q JOIN public.qa_6c_found f ON f.id = q.case_id;
SQL
)
[ "$got" = "4,52,100,101,151,237|0" ] || fail "T1 missing list = '$got'"
rung=$("${P[@]}" -c "SELECT string_agg(public.ring_paidy_case_bell(case_id, 't', 'b', '{\"late\":true}'), ',') FROM public.qa_6c_ids WHERE i IN (4,52,100,101,151,237)")
[ "$rung" = "rung,rung,rung,rung,rung,rung" ] || fail "T1 ring answers = '$rung'"
left=$("${P[@]}" -c "SELECT count(*) FROM public.paidy_case_bell_missing(NULL, NULL, 500) m JOIN public.qa_6c_ids q ON q.case_id = m.case_id")
[ "$left" = "0" ] || fail "T1 after ringing, $left still missing"
badtype=$("${P[@]}" -c "SELECT count(*) FROM public.qa_6c_ids q JOIN public.staff_notifications n ON n.metadata->>'case_id' = q.case_id::text WHERE q.i IN (4,52,100,101,151,237) AND (n.type <> 'paidy_case_' || q.kind OR n.metadata->>'kind' <> q.kind OR n.metadata->>'late' <> 'true')")
[ "$badtype" = "0" ] || fail "T1 $badtype bells with a wrong type/metadata"
echo "T1 PASS: the six unrung cases beyond the first page were all found (pages of 100), resolved ones skipped, rung with their own type; none left"

# T2 — two sessions, same case, first holds its transaction
X=$("${P[@]}" -c "INSERT INTO public.paidy_cases (kind, status, paidy_payment_id, detail) VALUES ('record_failed','open','pay_qa6c_t2','{\"qa_6c\":\"t\"}') RETURNING id")
( "${P[@]}" -c "BEGIN; SELECT public.ring_paidy_case_bell('$X','t','b','{}'); SELECT pg_sleep(3); COMMIT;" > /tmp/qa_6c_a ) &
sleep 1
b=$("${P[@]}" -c "SELECT public.ring_paidy_case_bell('$X','t','b','{}')")
wait
a=$(head -1 /tmp/qa_6c_a)
rows=$("${P[@]}" -c "SELECT count(*) FROM public.staff_notifications WHERE type LIKE 'paidy\_case\_%' AND metadata->>'case_id'='$X'")
stamped=$("${P[@]}" -c "SELECT bell_rung_at IS NOT NULL FROM public.paidy_cases WHERE id='$X'")
[ "$a" = "rung" ] && [ "$b" = "exists" ] && [ "$rows" = "1" ] && [ "$stamped" = "t" ] || fail "T2 a=$a b=$b rows=$rows stamped=$stamped"
echo "T2 PASS: overlapping ring waited and returned 'exists'; exactly one bell; case stamped"

# T3 — four parallel workers, same 300 cases, different orders
"${P[@]}" <<'SQL'
DROP TABLE IF EXISTS public.qa_6c_t3;
CREATE TABLE public.qa_6c_t3 AS SELECT gen_random_uuid() AS id, i FROM generate_series(1,300) i;
INSERT INTO public.paidy_cases (id, kind, status, paidy_payment_id, detail)
  SELECT id, 'close_failed', 'open', 'pay_qa6c_t3_' || i, '{"qa_6c":"t"}' FROM public.qa_6c_t3;
SQL
for w in 1 2 3 4; do
  ( printf '%s\n' "SELECT format('SELECT public.ring_paidy_case_bell(%L, ''t'', ''b'', ''{}'')', id) FROM public.qa_6c_t3 ORDER BY md5(id::text || '$w')" '\gexec' \
      | "${P[@]}" | grep -c '^rung$' > /tmp/qa_6c_w$w || true ) &
done
wait
total=$(( $(cat /tmp/qa_6c_w1) + $(cat /tmp/qa_6c_w2) + $(cat /tmp/qa_6c_w3) + $(cat /tmp/qa_6c_w4) ))
rows=$("${P[@]}" -c "SELECT count(*) FROM public.staff_notifications n JOIN public.qa_6c_t3 t ON n.metadata->>'case_id' = t.id::text WHERE n.type LIKE 'paidy\_case\_%'")
unstamped=$("${P[@]}" -c "SELECT count(*) FROM public.paidy_cases c JOIN public.qa_6c_t3 t ON t.id = c.id WHERE c.bell_rung_at IS NULL")
[ "$total" = "300" ] && [ "$rows" = "300" ] && [ "$unstamped" = "0" ] || fail "T3 rung=$total rows=$rows unstamped=$unstamped"
echo "T3 PASS: 4 parallel workers × 300 cases → 300 bells, 300 winners, all stamped, no duplicates"

# T4 — a resolved case is not rung; an unknown case is refused
R=$("${P[@]}" -c "SELECT id FROM public.paidy_cases WHERE paidy_payment_id = 'pay_qa6c_r1'")
r=$("${P[@]}" -c "SELECT public.ring_paidy_case_bell('$R','t','b','{}')")
rows=$("${P[@]}" -c "SELECT count(*) FROM public.staff_notifications WHERE metadata->>'case_id'='$R'")
err=$("${P[@]}" -c "SELECT public.ring_paidy_case_bell(gen_random_uuid(),'t','b','{}')" 2>&1 || true)
[ "$r" = "closed" ] && [ "$rows" = "0" ] && echo "$err" | grep -q "case_not_found" || fail "T4 r=$r rows=$rows err=$err"
echo "T4 PASS: resolved case → 'closed', no bell; unknown case → case_not_found"

# T5 — a bell already there (old code) but the case unstamped
Y=$("${P[@]}" -c "INSERT INTO public.paidy_cases (kind, status, paidy_payment_id, detail) VALUES ('close_failed','open','pay_qa6c_t5','{\"qa_6c\":\"t\"}') RETURNING id")
"${P[@]}" -c "INSERT INTO public.staff_notifications (type, title, body, metadata) VALUES ('paidy_case_close_failed','old','old', jsonb_build_object('case_id','$Y'))" >/dev/null
r=$("${P[@]}" -c "SELECT public.ring_paidy_case_bell('$Y','t','b','{}')")
rows=$("${P[@]}" -c "SELECT count(*) FROM public.staff_notifications WHERE metadata->>'case_id'='$Y'")
stamped=$("${P[@]}" -c "SELECT bell_rung_at IS NOT NULL FROM public.paidy_cases WHERE id='$Y'")
dup=$("${P[@]}" -c "INSERT INTO public.staff_notifications (type, title, body, metadata) VALUES ('paidy_case_close_failed','x','x', jsonb_build_object('case_id','$Y'))" 2>&1 || true)
[ "$r" = "exists" ] && [ "$rows" = "1" ] && [ "$stamped" = "t" ] && echo "$dup" | grep -q "uq_staff_notifications_paidy_case" || fail "T5 r=$r rows=$rows stamped=$stamped dup=$dup"
echo "T5 PASS: existing bell → 'exists', case stamped, one row; a direct second insert is refused by the unique index"

"${P[@]}" <<'SQL' >/dev/null
SET session_replication_role = replica;
DELETE FROM public.staff_notifications WHERE type LIKE 'paidy\_case\_%' AND metadata ? 'case_id'
  AND (metadata->>'case_id')::uuid IN (SELECT id FROM public.paidy_cases WHERE detail->>'qa_6c' = 't');
DELETE FROM public.paidy_cases WHERE detail->>'qa_6c' = 't';
DROP TABLE public.qa_6c_t3; DROP TABLE public.qa_6c_ids; DROP TABLE public.qa_6c_found;
SQL
echo "ALL PASS"

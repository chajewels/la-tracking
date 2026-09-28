#!/usr/bin/env bash
# Local tests for supabase/migrations/20261009500000_record_live_drift_2026_09_28.sql.
# Throwaway Postgres only — never point this at the live project.
#
#   PGHOST=<socket dir> PGPORT=<port> docs/sql/20260928_record_live_drift_local_tests.sh <live-dir>
#
# <live-dir> holds the owner's 2026-09-28 capture as one file per function
# (pg_get_functiondef output), e.g. ~/Code/reference/drift-2026-09-28/live.
#
# Scenarios, each on a fresh database:
#   A  live-shaped (bodies, ACLs, triggers exactly as captured): the migration must change
#      NOTHING — every pg_proc / pg_trigger row keeps its xmin — on the first run and a re-run,
#      both as one transaction (like the CLI) and statement by statement (like the SQL Editor).
#   B  fresh rebuild (older repo bodies, the repo's INSERT OR UPDATE trigger, no
#      force_layaway_english_only, Supabase default grants, no sandbox_exec role): brought up
#      to live, self-check passes; re-run is a no-op; then behaviour checks.
#   C  live moved (set_updated_at has some other body): STOP before any change.
set -euo pipefail
LIVE=${1:?usage: $0 <live-dir>}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
MIG=$ROOT/supabase/migrations/20261009500000_record_live_drift_2026_09_28.sql
SB=sandbox_exec_pfoicalpzdcmyxzvwyhz
FNS="'force_layaway_english_only','get_daily_cash_orders','get_daily_cash_orders_last_month','get_daily_new_layaway_sales','get_daily_new_layaway_sales_last_month','set_updated_at','sync_service_request_from_job'"
pass=0; fail=0
ok()  { echo "  PASS  $*"; pass=$((pass+1)); }
bad() { echo "  FAIL  $*"; fail=$((fail+1)); }
q()   { psql -X -q -At -v ON_ERROR_STOP=1 -d "$DB" -c "$1"; }

fresh() {
  DB=drift_$1
  psql -X -q -d postgres -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB"
  psql -X -q -v ON_ERROR_STOP=1 -d "$DB" <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;
CREATE TABLE public.service_jobs (id uuid PRIMARY KEY, service_status text);
CREATE TABLE public.service_requests (id int PRIMARY KEY, service_job_id uuid, status text, updated_at timestamptz);
CREATE TABLE public.website_faq_items (id int PRIMARY KEY, question_en text, answer_en text,
  question_ja text, answer_ja text, layaway_only boolean NOT NULL DEFAULT false, updated_at timestamptz);
CREATE TABLE public.website_posts (id int PRIMARY KEY, title_en text, body_en text, excerpt_en text,
  title_ja text, body_ja text, layaway_only boolean NOT NULL DEFAULT false, updated_at timestamptz);
SQL
}

# the live ACL, in live's order, on top of a clean slate
live_acl() { # sig roles...
  local sig=$1; shift
  q "REVOKE ALL ON FUNCTION $sig FROM PUBLIC, anon, authenticated, service_role"
  for r in "$@"; do q "GRANT EXECUTE ON FUNCTION $sig TO $r"; done
}

live_shaped() {
  fresh "$1"
  q "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='$SB') THEN CREATE ROLE $SB NOLOGIN; END IF; END \$\$"
  for f in "$LIVE"/*.sql; do
    [ "$(basename "$f")" = page365_metals_from_text.sql ] && continue
    psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -c "SET check_function_bodies = off" -f "$f" >/dev/null
  done
  live_acl 'public.force_layaway_english_only()'         PUBLIC service_role $SB
  live_acl 'public.set_updated_at()'                     PUBLIC service_role $SB
  live_acl 'public.sync_service_request_from_job()'      PUBLIC service_role $SB
  for s in 'get_daily_cash_orders()' 'get_daily_cash_orders_last_month()' \
           'get_daily_new_layaway_sales(text)' 'get_daily_new_layaway_sales_last_month(text)'; do
    live_acl "public.$s" service_role $SB authenticated
  done
  q "CREATE TRIGGER trg_faq_items_layaway_en BEFORE INSERT OR UPDATE ON public.website_faq_items FOR EACH ROW EXECUTE FUNCTION force_layaway_english_only()"
  q "CREATE TRIGGER trg_posts_layaway_en BEFORE INSERT OR UPDATE ON public.website_posts FOR EACH ROW EXECUTE FUNCTION force_layaway_english_only()"
  q "CREATE TRIGGER trg_sync_service_request_from_job AFTER UPDATE OF service_status ON public.service_jobs FOR EACH ROW EXECUTE FUNCTION sync_service_request_from_job()"
  q "CREATE TRIGGER trg_faq_items_updated_at BEFORE UPDATE ON public.website_faq_items FOR EACH ROW EXECUTE FUNCTION set_updated_at()"
}

snapshot() {
  q "SELECT string_agg(format('%s|%s|%s|%s', p.oid::regprocedure, p.xmin, md5(p.prosrc), p.proacl), E'\n' ORDER BY 1)
       FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ($FNS)"
  q "SELECT string_agg(format('%s|%s|%s', t.tgname, t.xmin, pg_get_triggerdef(t.oid)), E'\n' ORDER BY 1)
       FROM pg_trigger t WHERE NOT t.tgisinternal"
}

run_mig() { psql -X -q -v ON_ERROR_STOP=1 -d "$DB" "$@" -f "$MIG" 2>&1; }

echo "A. live-shaped: must be a pure no-op"
for mode in single editor; do
  live_shaped "a_$mode"
  before=$(snapshot)
  flag=(); [ $mode = single ] && flag=(-1)
  out=$(run_mig ${flag[@]+"${flag[@]}"})
  n=$(grep -c "NOTICE: .*skipped" <<<"$out" || true)
  [ "$(snapshot)" = "$before" ] && ok "A/$mode run 1: catalog byte-identical, xmin unchanged ($n skip notices)" || bad "A/$mode run 1 changed the catalog"
  grep -q 'brought up\|ACL set to' <<<"$out" && bad "A/$mode run 1 wrote something: $(grep 'brought up\|ACL set' <<<"$out")" || ok "A/$mode run 1: no 'brought up' / 'ACL set' notice"
  grep -q 'all 7 functions' <<<"$out" && ok "A/$mode self-check passed" || bad "A/$mode self-check missing: $out"
  run_mig ${flag[@]+"${flag[@]}"} >/dev/null
  [ "$(snapshot)" = "$before" ] && ok "A/$mode re-run: still byte-identical" || bad "A/$mode re-run changed the catalog"
  [ "$(q "SELECT count(*) FROM pg_proc WHERE pronamespace = pg_my_temp_schema()")" = 0 ] && ok "A/$mode helpers dropped" || bad "A/$mode helpers left behind"
done

echo "B. fresh rebuild from the repo"
fresh b
q "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role"
for d in a_single a_editor c; do psql -X -q -d postgres -c "DROP DATABASE IF EXISTS drift_$d"; done  # the role is cluster-wide
q "DROP ROLE IF EXISTS $SB"
for f in get_daily_cash_orders get_daily_cash_orders_last_month get_daily_new_layaway_sales get_daily_new_layaway_sales_last_month; do
  psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -c "SET check_function_bodies = off" -f "$LIVE/$f.sql" >/dev/null  # 20260924140200 leaves these at live
done
q "CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS \$function\$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END; \$function\$"
sed -n '/^CREATE OR REPLACE FUNCTION public.sync_service_request_from_job/,/^EXECUTE FUNCTION/p' \
  "$ROOT/supabase/migrations/20260921000000_record_request_to_job_link.sql" | psql -X -q -v ON_ERROR_STOP=1 -d "$DB" >/dev/null
q "CREATE TRIGGER trg_faq_items_updated_at BEFORE UPDATE ON public.website_faq_items FOR EACH ROW EXECUTE FUNCTION set_updated_at()"
out=$(run_mig -1) && ok "B run 1 succeeded" || bad "B run 1 failed: $out"
grep -q 'all 7 functions' <<<"$out" && ok "B self-check passed" || bad "B self-check: $out"
grep -q "role $SB does not exist" <<<"$out" && ok "B missing sandbox role reported, not fatal" || bad "B sandbox notice missing"
[ "$(q "SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgname='trg_sync_service_request_from_job'")" = \
  "CREATE TRIGGER trg_sync_service_request_from_job AFTER UPDATE OF service_status ON public.service_jobs FOR EACH ROW EXECUTE FUNCTION sync_service_request_from_job()" ] \
  && ok "B sync trigger is AFTER UPDATE OF service_status (INSERT dropped, as live)" || bad "B sync trigger wrong"
[ "$(q "SELECT proacl::text FROM pg_proc WHERE oid='public.set_updated_at()'::regprocedure")" = "{=X/postgres,postgres=X/postgres,service_role=X/postgres}" ] \
  && ok "B set_updated_at ACL = live minus the absent sandbox role (anon/authenticated removed)" || bad "B acl: $(q "SELECT proacl FROM pg_proc WHERE oid='public.set_updated_at()'::regprocedure")"
before=$(snapshot); run_mig -1 >/dev/null
[ "$(snapshot)" = "$before" ] && ok "B re-run is a no-op" || bad "B re-run changed the catalog"
# behaviour: the live trigger semantics
q "INSERT INTO service_jobs VALUES ('00000000-0000-0000-0000-000000000001','Pending'),('00000000-0000-0000-0000-000000000002','Pending')"
q "INSERT INTO service_requests VALUES (1,'00000000-0000-0000-0000-000000000001','declined',NULL),(2,'00000000-0000-0000-0000-000000000002','completed',NULL)"
q "UPDATE service_jobs SET service_status='Completed' WHERE id='00000000-0000-0000-0000-000000000001'"
q "UPDATE service_jobs SET service_status='Process'   WHERE id='00000000-0000-0000-0000-000000000002'"
[ "$(q "SELECT string_agg(status, ',' ORDER BY id) FROM service_requests")" = "declined,completed" ] \
  && ok "B declined stays declined on Completed; completed never goes back to in_progress" || bad "B sync semantics: $(q "SELECT string_agg(status, ',' ORDER BY id) FROM service_requests")"
q "INSERT INTO website_faq_items (id, question_en) VALUES (1, 'How does Layaway work?'), (2, 'Shipping?')"
q "INSERT INTO website_posts (id, title_ja) VALUES (1, 'レイアウェイのご案内')"
[ "$(q "SELECT string_agg(layaway_only::text, ',' ORDER BY id) FROM website_faq_items") $(q "SELECT layaway_only FROM website_posts")" = "true,false t" ] \
  && ok "B force_layaway_english_only marks layaway rows (EN and JA) and only those" || bad "B layaway flag wrong"

echo "C. live moved: must STOP before changing anything"
live_shaped c
q "CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS trigger LANGUAGE plpgsql AS \$x\$BEGIN NEW.updated_at = clock_timestamp(); RETURN NEW; END\$x\$"
before=$(snapshot)
if out=$(run_mig -1); then bad "C should have failed"; else
  grep -q 'STOP — live has moved' <<<"$out" && ok "C refused: $(grep -o 'public.set_updated_at(): body md5 [0-9a-f]*' <<<"$out")" || bad "C wrong error: $out"
fi
[ "$(snapshot)" = "$before" ] && ok "C nothing changed" || bad "C catalog changed"
if out=$(run_mig); then bad "C (editor mode) should have failed"; else ok "C (editor mode) refused too"; fi
[ "$(snapshot)" = "$before" ] && ok "C (editor mode) nothing changed" || bad "C (editor mode) catalog changed"

for d in a_single a_editor b c; do psql -X -q -d postgres -c "DROP DATABASE IF EXISTS drift_$d"; done
echo "passed $pass, failed $fail"; [ $fail -eq 0 ]

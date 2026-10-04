#!/usr/bin/env bash
# Local Postgres harness for 20261104100000_paidy_owner_answers.sql.
# Usage: PSQL="psql -h /tmp -p 5499 -U postgres" ./run.sh   (needs a running Postgres 16+)
set -euo pipefail
cd "$(dirname "$0")"
PSQL=${PSQL:-psql}
DB=paidy_owner_answers_$$
$PSQL -q -c "CREATE DATABASE $DB"
trap '$PSQL -q -c "DROP DATABASE IF EXISTS $DB"' EXIT
P="$PSQL -v ON_ERROR_STOP=1 -q -d $DB"
$P -c "DO \$\$BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; END IF; END\$\$"
sed '2d' 01_stubs.sql | $P -f -
$P -f 02_live_reassign.sql
LIVE=$($P -At -c "select md5(pg_get_functiondef('public.reassign_order_owner_atomic(text,uuid,uuid,numeric,text,uuid,boolean,boolean)'::regprocedure))")
[ "$LIVE" = "31956f1eea17e17c742d367bb8ef04f0" ] || { echo "DRIFT: reassign copy md5 $LIVE"; exit 1; }
# cash_order_payment_lock exactly as 20261103100000 ships it (live md5 82dcd756… = repo, 2026-10-04)
awk '/^-- 5. cash_order_payment_lock/{f=1} /^-- 6. Guards./{f=0} f' ../../supabase/migrations/20261103100000_paidy_followup.sql | $P -f -
$P -f ../../supabase/migrations/20261104100000_paidy_owner_answers.sql
$P -f ../../supabase/migrations/20261104100000_paidy_owner_answers.sql   # replay = no-op
$P -f 04_tests.sql

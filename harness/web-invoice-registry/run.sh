#!/usr/bin/env bash
# Local Postgres harness for 20261105100000_web_invoice_numbers_respect_registry.sql.
# Usage: PSQL="psql -h /tmp -p 5499 -U postgres" ./run.sh   (needs a running Postgres 16+)
# The three website writers (create_web_draft/layaway/order_atomic) need the whole
# checkout schema, so their VALUES rows are filtered out here; their patch was
# proven read-only on the live bytes instead (md5, site count, replay) — README.
set -euo pipefail
cd "$(dirname "$0")"
PSQL=${PSQL:-psql}
DB=web_invoice_registry_$$
$PSQL -q -c "CREATE DATABASE $DB"
trap '$PSQL -q -c "DROP DATABASE IF EXISTS $DB"' EXIT
P="$PSQL -v ON_ERROR_STOP=1 -q -d $DB"
$P -c "DO \$\$BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; END IF; END\$\$"
$P -f 01_stubs.sql
$P -f 02_live_reserve_trigger.sql
$P -f 03_live_register.sql
for f in "checkout_quotes_reserve_invoice()" "register_invoice_number()"; do
  echo "live copy $f md5 $($P -At -c "select md5(pg_get_functiondef('public.$f'::regprocedure))")"
done
$P -f 04_triggers.sql
MIG=../../supabase/migrations/20261105100000_web_invoice_numbers_respect_registry.sql
grep -v "'public.create_web_\(draft\|layaway\|order\)_atomic(" $MIG > /tmp/mig_$$.sql
# The VALUES list must still be valid SQL: the trigger row is the last one left.
sed -i "s/('public.checkout_quotes_reserve_invoice()', '99144148ce2175f437bb6c095855fc62', 1),/('public.checkout_quotes_reserve_invoice()', '99144148ce2175f437bb6c095855fc62', 1)/" /tmp/mig_$$.sql
$P -f /tmp/mig_$$.sql
$P -f /tmp/mig_$$.sql   # replay = no-op
rm -f /tmp/mig_$$.sql
$P -f 05_tests.sql 2>&1 | sed "s/^.*NOTICE:  //"

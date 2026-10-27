#!/usr/bin/env bash
# Local harness for the Payslips migrations. Needs a scratch PostgreSQL 16 you can create databases on;
# nothing here touches Supabase. Usage: PGURL=postgres://... supabase/tests/payslips/run.sh
#   Phase 1: 20270201100000 alone (applied twice) -> test_payslips.sql.
#   Phase 2: 20270201100000 + 20270202100000, the old-way seed, then 20270204100000 applied twice
#            -> test_bond_payhistory.sql (cash advances, employee ID, cash bond, pay history, April-May).
#   Phase 3: on the Phase 2 database, snapshots, then 20270205100000 applied twice -> test_second_proof.sql
#            (a 2nd proof file on the payment and on each cash advance).
set -euo pipefail
cd "$(dirname "$0")/../../.."
PGURL="${PGURL:-postgres:///postgres}"
DB="payslips_harness_$$"
DB2="payslips_bond_harness_$$"
T=supabase/tests/payslips
M=supabase/migrations/20270201100000_staff_payslips.sql
M2=supabase/migrations/20270202100000_timesheet_corrections.sql
M4=supabase/migrations/20270204100000_payslip_bond_payhistory.sql
M5=supabase/migrations/20270205100000_payslip_second_proof.sql
URL="$(printf '%s' "$PGURL" | sed -E "s#/[^/?]*(\?|\$)#/$DB\1#")"
URL2="$(printf '%s' "$PGURL" | sed -E "s#/[^/?]*(\?|\$)#/$DB2\1#")"
trap 'psql "$PGURL" -qc "DROP DATABASE IF EXISTS $DB" -qc "DROP DATABASE IF EXISTS $DB2"' EXIT
QUIET="set_config|^ 0000|NOTICE:.*(skipping|already exists|already replaced)|cj_guard|^-+$|^\(1 row\)$|^ *$"

psql "$PGURL" -qc "DROP DATABASE IF EXISTS $DB" -qc "CREATE DATABASE $DB"
# The migration is applied twice (it must be re-runnable).
psql "$URL" -v ON_ERROR_STOP=1 -q -f $T/stubs.sql -f $M -f $M 2>&1 | grep -vE "$QUIET" || true
psql "$URL" -v ON_ERROR_STOP=1 -q -f $T/test_payslips.sql 2>&1 | grep -E "NOTICE:  P|PASSED|ERROR"

psql "$PGURL" -qc "DROP DATABASE IF EXISTS $DB2" -qc "CREATE DATABASE $DB2"
psql "$URL2" -v ON_ERROR_STOP=1 -q -f $T/stubs.sql -f $T/stubs_timesheet.sql -f $M -f $M2 -f $T/seed_before.sql \
  -f $M4 -f $M4 2>&1 | grep -vE "$QUIET" || true
psql "$URL2" -v ON_ERROR_STOP=1 -q -f $T/test_bond_payhistory.sql 2>&1 | grep -E "NOTICE:  Q|PASSED|ERROR|CONTEXT"

psql "$URL2" -v ON_ERROR_STOP=1 -q \
  -c "CREATE TABLE public.pre5_payslips AS SELECT id, to_jsonb(p) AS row FROM public.payslips p" \
  -c "CREATE TABLE public.pre5_advances AS SELECT id, to_jsonb(a) AS row FROM public.payslip_cash_advances a" \
  -c "CREATE TABLE public.pre5_audit AS SELECT count(*) AS n FROM public.audit_logs"
psql "$URL2" -v ON_ERROR_STOP=1 -q -f $M5 -f $M5 2>&1 | grep -vE "$QUIET" || true
psql "$URL2" -v ON_ERROR_STOP=1 -q -f $T/test_second_proof.sql 2>&1 | grep -E "NOTICE:  S|PASSED|ERROR|CONTEXT"

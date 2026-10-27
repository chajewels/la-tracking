#!/usr/bin/env bash
# Local harness for the timesheet-corrections migration. Needs a scratch PostgreSQL 16 you can create databases on;
# nothing here touches Supabase. Usage: PGURL=postgres://... supabase/tests/timesheet-corrections/run.sh
#   Phase 1: 20270202100000 alone (applied twice) -> test_corrections.sql.
#   Phase 2: 20270201100000 + 20270202100000 + 20270204100000 (applied twice) -> test_corrections_april.sql.
set -euo pipefail
cd "$(dirname "$0")/../../.."
PGURL="${PGURL:-postgres:///postgres}"
DB="tscorr_harness_$$"
DB2="tscorr_april_harness_$$"
T=supabase/tests/timesheet-corrections
M=supabase/migrations/20270202100000_timesheet_corrections.sql
M1=supabase/migrations/20270201100000_staff_payslips.sql
M4=supabase/migrations/20270204100000_payslip_bond_payhistory.sql
URL="$(printf '%s' "$PGURL" | sed -E "s#/[^/?]*(\?|\$)#/$DB\1#")"
URL2="$(printf '%s' "$PGURL" | sed -E "s#/[^/?]*(\?|\$)#/$DB2\1#")"
trap 'psql "$PGURL" -qc "DROP DATABASE IF EXISTS $DB" -qc "DROP DATABASE IF EXISTS $DB2"' EXIT
QUIET="NOTICE:.*(skipping|already exists|already replaced)|cj_guard|^-+$|^\(1 row\)$|^ *$"

psql "$PGURL" -qc "DROP DATABASE IF EXISTS $DB"
psql "$PGURL" -qc "CREATE DATABASE $DB"
# The migration is applied twice (it must be re-runnable).
psql "$URL" -v ON_ERROR_STOP=1 -q -f $T/stubs.sql -f $M -f $M 2>&1 | grep -vE "$QUIET" || true
psql "$URL" -v ON_ERROR_STOP=1 -q -f $T/test_corrections.sql 2>&1 | grep -E "NOTICE:  T|PASSED|ERROR"

psql "$PGURL" -qc "DROP DATABASE IF EXISTS $DB2" -qc "CREATE DATABASE $DB2"
psql "$URL2" -v ON_ERROR_STOP=1 -q -f $T/stubs.sql -f $T/stubs_payslips.sql -f $M1 -f $M -f $M4 -f $M4 2>&1 | grep -vE "$QUIET" || true
psql "$URL2" -v ON_ERROR_STOP=1 -q -f $T/test_corrections_april.sql 2>&1 | grep -E "NOTICE:  T|PASSED|ERROR|CONTEXT"

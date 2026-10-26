#!/usr/bin/env bash
# Local harness for the Payslips migration. Needs a scratch PostgreSQL 16 you can create databases on;
# nothing here touches Supabase. Usage: PGURL=postgres://... supabase/tests/payslips/run.sh
set -euo pipefail
cd "$(dirname "$0")/../../.."
PGURL="${PGURL:-postgres:///postgres}"
DB="payslips_harness_$$"
T=supabase/tests/payslips
M=supabase/migrations/20270201100000_staff_payslips.sql
URL="$(printf '%s' "$PGURL" | sed -E "s#/[^/?]*(\?|\$)#/$DB\1#")"
trap 'psql "$PGURL" -qc "DROP DATABASE IF EXISTS $DB"' EXIT

psql "$PGURL" -qc "DROP DATABASE IF EXISTS $DB"
psql "$PGURL" -qc "CREATE DATABASE $DB"
# The migration is applied twice (it must be re-runnable).
psql "$URL" -v ON_ERROR_STOP=1 -q -f $T/stubs.sql -f $M -f $M 2>&1 | grep -vE "NOTICE:.*(skipping|already exists)" || true
psql "$URL" -v ON_ERROR_STOP=1 -q -f $T/test_payslips.sql 2>&1 | grep -E "NOTICE:  P|PASSED|ERROR"

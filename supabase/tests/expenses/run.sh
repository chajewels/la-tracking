#!/usr/bin/env bash
# Local harness for the Expenses migrations (Phases 1, 2, 2b). Needs a scratch PostgreSQL 16 you can
# create databases on; nothing here touches Supabase. Usage: PGURL=postgres://... supabase/tests/expenses/run.sh
set -euo pipefail
cd "$(dirname "$0")/../../.."
PGURL="${PGURL:-postgres:///postgres}"
DB="expenses_harness_$$"
T=supabase/tests/expenses
M=supabase/migrations
psql "$PGURL" -qc "CREATE DATABASE $DB"
trap 'psql "$PGURL" -qc "DROP DATABASE IF EXISTS $DB"' EXIT
URL="${PGURL%/*}/$DB"
# every migration applied twice (re-runnable), then the three suites
psql "$URL" -v ON_ERROR_STOP=1 -q -f $T/stubs.sql -f $T/stubs_ledger.sql \
  -f $M/20261230100000_expenses_ledger.sql -f $M/20261230100000_expenses_ledger.sql \
  -f $M/20270101100000_general_ledger_core.sql -f $M/20270101100000_general_ledger_core.sql \
  -f $M/20270102100000_expenses_recurring_prepaid.sql -f $M/20270102100000_expenses_recurring_prepaid.sql
psql "$URL" -v ON_ERROR_STOP=1 -q -f $T/test_expenses.sql | grep -E "PASSED|ERROR"
psql "$URL" -v ON_ERROR_STOP=1 -q -v migration2=$M/20261231100000_expenses_payroll_commission.sql -f $T/test_phase2.sql | grep -E "PASSED|ERROR"
psql "$URL" -v ON_ERROR_STOP=1 -q -f $T/test_ledger.sql 2>&1 | grep -E "PASSED|ERROR|NOTICE:  L"
# the recurring suite sets its own ledger start, so it runs on a fresh copy
psql "$PGURL" -qc "DROP DATABASE $DB" && psql "$PGURL" -qc "CREATE DATABASE $DB"
psql "$URL" -v ON_ERROR_STOP=1 -q -f $T/stubs.sql -f $T/stubs_ledger.sql -f $M/20261230100000_expenses_ledger.sql \
  -f $M/20261231100000_expenses_payroll_commission.sql -f $M/20270101100000_general_ledger_core.sql -f $M/20270102100000_expenses_recurring_prepaid.sql
psql "$URL" -v ON_ERROR_STOP=1 -q -f $T/test_recurring.sql 2>&1 | grep -E "PASSED|ERROR|NOTICE:  R"

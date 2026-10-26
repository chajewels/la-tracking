#!/usr/bin/env bash
# Local harness for the Expenses migrations (Phases 1, 2, 2b, 3, 4, 5). Needs a scratch PostgreSQL 16 you can
# create databases on; nothing here touches Supabase. Usage: PGURL=postgres://... supabase/tests/expenses/run.sh
set -euo pipefail
cd "$(dirname "$0")/../../.."
PGURL="${PGURL:-postgres:///postgres}"
DB="expenses_harness_$$"
T=supabase/tests/expenses
M=supabase/migrations
MIGRATIONS=(
  $M/20261230100000_expenses_ledger.sql
  $M/20261231100000_expenses_payroll_commission.sql
  $M/20270101100000_general_ledger_core.sql
  $M/20270102100000_expenses_recurring_prepaid.sql
  $M/20270103100000_expenses_email_bills.sql
  $M/20270104100000_expenses_cost_of_goods.sql
)
# the URL of the scratch database: same server, different database name (query string kept)
URL="$(printf '%s' "$PGURL" | sed -E "s#/[^/?]*(\?|\$)#/$DB\1#")"
trap 'psql "$PGURL" -qc "DROP DATABASE IF EXISTS $DB"' EXIT

# fresh <migration files...>: a new database with the stubs and the given migrations applied
fresh() {
  psql "$PGURL" -qc "DROP DATABASE IF EXISTS $DB"
  psql "$PGURL" -qc "CREATE DATABASE $DB"
  local args=(-f $T/stubs.sql -f $T/stubs_ledger.sql)
  for f in "$@"; do args+=(-f "$f"); done
  psql "$URL" -v ON_ERROR_STOP=1 -q "${args[@]}" 2>&1 | grep -vE "NOTICE:.*(skipping|already exists)" || true
}

# 1. Every migration applied twice (re-runnable), then the Phase 1 suite and the Phase 2 suite (which applies
#    the payroll/commission migration itself).
fresh $M/20261230100000_expenses_ledger.sql $M/20261230100000_expenses_ledger.sql \
  $M/20270101100000_general_ledger_core.sql $M/20270101100000_general_ledger_core.sql \
  $M/20270102100000_expenses_recurring_prepaid.sql $M/20270102100000_expenses_recurring_prepaid.sql \
  $M/20270103100000_expenses_email_bills.sql $M/20270103100000_expenses_email_bills.sql \
  $M/20270104100000_expenses_cost_of_goods.sql $M/20270104100000_expenses_cost_of_goods.sql
psql "$URL" -v ON_ERROR_STOP=1 -q -f $T/test_expenses.sql | grep -E "PASSED|ERROR"
psql "$URL" -v ON_ERROR_STOP=1 -q -v migration2=$M/20261231100000_expenses_payroll_commission.sql -f $T/test_phase2.sql | grep -E "PASSED|ERROR"

# 2. The ledger suite counts the events it creates, so it runs on a clean book.
fresh "${MIGRATIONS[@]}"
psql "$URL" -v ON_ERROR_STOP=1 -q -f $T/test_ledger.sql 2>&1 | grep -E "PASSED|ERROR|NOTICE:  L"

# 3. The recurring suite sets its own ledger start; the email suite runs after it on the same copy.
fresh "${MIGRATIONS[@]}"
psql "$URL" -v ON_ERROR_STOP=1 -q -f $T/test_recurring.sql 2>&1 | grep -E "PASSED|ERROR|NOTICE:  R"
psql "$URL" -v ON_ERROR_STOP=1 -q -f $T/test_email_bills.sql 2>&1 | grep -E "PASSED|ERROR|NOTICE:  E"

# 4. The cost-of-goods suite sets its own ledger start too.
fresh "${MIGRATIONS[@]}"
psql "$URL" -v ON_ERROR_STOP=1 -q -f $T/test_cogs.sql 2>&1 | grep -E "PASSED|ERROR|NOTICE:  C"

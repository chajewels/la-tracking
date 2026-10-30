#!/usr/bin/env bash
# Local harness for migration 20270225100000 (commission cut-off + Sales Log archive guard). Needs a scratch
# PostgreSQL 16 you can create databases on; nothing here touches Supabase.
# Usage: PGURL=postgres://... supabase/tests/commission_archive/run.sh
#   payslips stubs + the payslips migration (for the real can_manage_payslips) + stubs_sales.sql, then the migration
#   applied twice, then test_commission_archive.sql (C1-C7). The clock is injected by pointing the two period
#   functions at fake.now() AFTER the migration is applied; the function bodies are the migration's own.
set -euo pipefail
cd "$(dirname "$0")/../../.."
PGURL="${PGURL:-postgres:///postgres}"
DB="commission_archive_harness_$$"
T=supabase/tests/commission_archive
P=supabase/tests/payslips
M=supabase/migrations/20270225100000_commission_cutoff_archive.sql
URL="$(printf '%s' "$PGURL" | sed -E "s#/[^/?]*(\?|\$)#/$DB\1#")"
trap 'psql "$PGURL" -qc "DROP DATABASE IF EXISTS $DB"' EXIT
QUIET="set_config|^ 0000|NOTICE:.*(skipping|already exists|already replaced)|cj_guard|^-+$|^\(1 row\)$|^ *$|^ t_"

psql "$PGURL" -qc "DROP DATABASE IF EXISTS $DB" -qc "CREATE DATABASE $DB"
psql "$URL" -v ON_ERROR_STOP=1 -q -f $P/stubs.sql -f supabase/migrations/20270201100000_staff_payslips.sql -f $T/stubs_sales.sql 2>&1 | grep -vE "$QUIET" || true
AUTOCHECK_MD5="$(psql "$URL" -Atqc "SELECT md5(prosrc) FROM pg_proc WHERE proname = 'autocheck_sales_log_eligible'")"
# The migration is applied twice (it must be re-runnable).
psql "$URL" -v ON_ERROR_STOP=1 -q -f $M -f $M 2>&1 | grep -vE "$QUIET" || true
psql "$URL" -v ON_ERROR_STOP=1 -q \
  -c "ALTER FUNCTION public.commission_period_is_closed(date) SET search_path = fake, public, pg_catalog"
OUT="$(psql "$URL" -v ON_ERROR_STOP=1 -q -v autocheck_md5="$AUTOCHECK_MD5" -f $T/test_commission_archive.sql 2>&1 || true)"
printf '%s\n' "$OUT" | grep -E "NOTICE:  C|ERROR|CONTEXT|FAILED" | sed -E 's#^psql:[^ ]+ ##' || true
if printf '%s\n' "$OUT" | grep -qE "ERROR|FAILED"; then echo "FAILED"; exit 1; fi
echo "PASSED (all groups): $(printf '%s\n' "$OUT" | grep -c 'NOTICE:  C') checks"

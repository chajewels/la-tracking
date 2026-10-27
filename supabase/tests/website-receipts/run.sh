#!/usr/bin/env bash
# Local harness for 20270216100000_website_receipts.sql. Needs a scratch
# PostgreSQL (16+) you can create databases on; nothing here touches Supabase.
# Usage: PGURL=postgres://... supabase/tests/website-receipts/run.sh
set -euo pipefail
cd "$(dirname "$0")/../../.."
PGURL="${PGURL:-postgres:///postgres}"
DB="receipts_harness_$$"
T=supabase/tests/website-receipts
MIG=supabase/migrations/20270216100000_website_receipts.sql
URL="$(printf '%s' "$PGURL" | sed -E "s#/[^/?]*(\?|\$)#/$DB\1#")"
trap 'psql "$PGURL" -qc "DROP DATABASE IF EXISTS $DB"' EXIT

psql "$PGURL" -qc "DROP DATABASE IF EXISTS $DB"
psql "$PGURL" -qc "CREATE DATABASE $DB"
# The migration is applied TWICE: it must be re-runnable.
psql "$URL" -v ON_ERROR_STOP=1 -q -f $T/stubs.sql -f $MIG -f $MIG 2>&1 | grep -vE "NOTICE:.*(skipping|already exists|does not exist)" || true
psql "$URL" -v ON_ERROR_STOP=1 -q -f $T/test_receipts.sql 2>&1 | grep -E "PASSED|ERROR|FAIL|WARNING"

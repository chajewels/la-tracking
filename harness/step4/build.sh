#!/bin/sh
# Rebuild the step-4 harness database from scratch, then check its fidelity.
#
#   PGHOST/PGPORT/PGUSER default to a local cluster on 127.0.0.1:55432 as user
#   `harness`. Override them if yours lives elsewhere. See README.md for how to
#   stand one up.
#
# To exercise the FIXES rather than the pre-fix bodies, load the migration(s) on
# top of a fresh build:
#   ./build.sh
#   psql -f ../../supabase/migrations/20260915140000_deadline_never_silently_cleared.sql
#   psql -f T_PRA.sql
set -e
H=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
: "${PGHOST:=127.0.0.1}" "${PGPORT:=55432}" "${PGUSER:=harness}"
export PGHOST PGPORT PGUSER
psql -d postgres -q -c "DROP DATABASE IF EXISTS chaharness;" -c "CREATE DATABASE chaharness;"
for f in 01_schema 02_trigger_functions 03_triggers 04_cash_order_triggers \
         05a_layaway_quote 05b_expire 05c_create 05d_deadlines 06_fixtures 07_helpers \
         08_addresses; do
  psql -d chaharness -v ON_ERROR_STOP=1 -q -f "$H/$f.sql"
done
echo "harness rebuilt"
psql -d chaharness -q -f "$H/00_verify_fidelity.sql"

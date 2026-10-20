#!/usr/bin/env bash
# R7 acceptance on a throwaway local Postgres: stub (live triggers copied
# verbatim) → migration → acceptance. Never touches live. Exits 1 on any FAIL.
set -euo pipefail
BIN=${PG_BIN:-/usr/lib/postgresql/16/bin}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
DIR=$(mktemp -d)
trap '"$BIN/pg_ctl" -D "$DIR/data" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$DIR"' EXIT
"$BIN/initdb" -D "$DIR/data" -U postgres -A trust >/dev/null
"$BIN/pg_ctl" -D "$DIR/data" -o "-k $DIR -p 55432 -c listen_addresses=''" -w start >/dev/null
P=(psql -X -q -v ON_ERROR_STOP=1 -h "$DIR" -p 55432 -U postgres -d postgres)
"${P[@]}" -f "$HERE/final-forfeit-settlement-stub.sql" >/dev/null
"${P[@]}" -f "$ROOT/supabase/migrations/20261226100000_final_forfeit_same_day_settlement.sql" >/dev/null
OUT=$("${P[@]}" -t -A -f "$HERE/final-forfeit-settlement-acceptance.sql")
echo "$OUT"
if echo "$OUT" | grep -q '^FAIL'; then exit 1; fi
echo "ALL PASS ($(echo "$OUT" | grep -c '^PASS'))"

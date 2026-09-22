#!/usr/bin/env bash
#
# scripts/f01-local-auth-test.sh — LOCAL ONLY. Never points at a remote project.
#
# Proves the F01 fix (PR #141, docs/FIXED-BUGS.md #290): a token that merely
# CLAIMS role:"service_role" must not be accepted by an edge function that runs
# at verify_jwt = false. Runs an auth matrix against the local stack and prints
# the status code and body for every row.
#
# Usage:
#   scripts/f01-local-auth-test.sh [label]
#
# `label` is cosmetic and only tags the output (e.g. "before" / "after"), so the
# same script can be run against origin/main's functions and the fix branch's.
#
# Requires: a running local stack (`supabase start`) and a running function
# server (`supabase functions serve`). It reads the local API URL and keys from
# `supabase status -o env` — no key is ever hardcoded here.
#
# Safety rails:
#   - Hard refusal if the resolved API URL is not loopback.
#   - Hard refusal if SUPABASE_ACCESS_TOKEN is set (that is a remote credential).
#   - Creates only *.example.test users in the LOCAL auth schema.
#
set -uo pipefail

LABEL="${1:-local}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUPA="$REPO_ROOT/node_modules/.bin/supabase"

ADMIN_EMAIL="f01-admin@example.test"
CSR_EMAIL="f01-csr@example.test"
TEST_PASSWORD="f01-local-preview-2026"

# ── 0. Resolve the local stack ───────────────────────────────────────────────
if [ ! -x "$SUPA" ]; then
  echo "FATAL: $SUPA not found. Run npm install." >&2; exit 1
fi

STATUS_ENV="$("$SUPA" status -o env 2>/dev/null)" || {
  echo "FATAL: 'supabase status' failed — is the local stack running?" >&2; exit 1
}
eval "$(printf '%s\n' "$STATUS_ENV" | sed 's/^/export /')"

API_URL="${API_URL:-}"
ANON="${ANON_KEY:-}"
SRK="${SERVICE_ROLE_KEY:-}"

case "$API_URL" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *) echo "FATAL: refusing to run — API_URL '$API_URL' is not loopback." >&2; exit 1 ;;
esac
if [ -n "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  echo "FATAL: SUPABASE_ACCESS_TOKEN is set. Unset it; this script is local-only." >&2; exit 1
fi
[ -n "$ANON" ] && [ -n "$SRK" ] || { echo "FATAL: could not read local keys." >&2; exit 1; }

FN="$API_URL/functions/v1"

echo "════════════════════════════════════════════════════════════════════════"
echo " F01 local auth matrix — label: $LABEL"
echo " API:       $API_URL"
echo " functions: $FN"
echo " keys:      read from 'supabase status -o env' (not printed)"
echo "════════════════════════════════════════════════════════════════════════"

# ── 1. Synthetic users (local auth schema only) ──────────────────────────────
rest() { # rest <METHOD> <path> [body]
  local m="$1" p="$2" b="${3:-}"
  if [ -n "$b" ]; then
    curl -s -X "$m" "$API_URL/rest/v1/$p" \
      -H "apikey: $SRK" -H "Authorization: Bearer $SRK" \
      -H "Content-Type: application/json" -H "Prefer: return=representation" -d "$b"
  else
    curl -s -X "$m" "$API_URL/rest/v1/$p" \
      -H "apikey: $SRK" -H "Authorization: Bearer $SRK" -H "Prefer: return=representation"
  fi
}

ensure_user() { # ensure_user <email>  -> echoes user id
  local email="$1" id
  id="$(curl -s "$API_URL/auth/v1/admin/users?per_page=200" \
        -H "apikey: $SRK" -H "Authorization: Bearer $SRK" \
        | jq -r --arg e "$email" '.users[]? | select(.email==$e) | .id' | head -1)"
  if [ -z "$id" ] || [ "$id" = "null" ]; then
    id="$(curl -s -X POST "$API_URL/auth/v1/admin/users" \
          -H "apikey: $SRK" -H "Authorization: Bearer $SRK" \
          -H "Content-Type: application/json" \
          -d "{\"email\":\"$email\",\"password\":\"$TEST_PASSWORD\",\"email_confirm\":true}" \
          | jq -r '.id')"
  fi
  [ -n "$id" ] && [ "$id" != "null" ] || { echo "FATAL: could not create $email" >&2; exit 1; }
  printf '%s' "$id"
}

set_role() { # set_role <user_id> <app_role>   (enum public.app_role)
  rest DELETE "user_roles?user_id=eq.$1" >/dev/null
  rest POST "user_roles" "{\"user_id\":\"$1\",\"role\":\"$2\"}" >/dev/null
}

signin() { # signin <email> -> echoes access_token
  curl -s -X POST "$API_URL/auth/v1/token?grant_type=password" \
    -H "apikey: $ANON" -H "Content-Type: application/json" \
    -d "{\"email\":\"$1\",\"password\":\"$TEST_PASSWORD\"}" | jq -r '.access_token'
}

echo
echo "── seeding synthetic users ──────────────────────────────────────────────"
ADMIN_ID="$(ensure_user "$ADMIN_EMAIL")"; set_role "$ADMIN_ID" "admin"
CSR_ID="$(ensure_user "$CSR_EMAIL")";     set_role "$CSR_ID"   "csr"

# The CSR must hold NO system_health grant by either resolution path.
rest DELETE "user_permission_overrides?user_id=eq.$CSR_ID&permission_key=eq.system_health" >/dev/null
rest DELETE "role_permissions?role=eq.csr&permission_key=eq.system_health"                 >/dev/null

echo "  admin  $ADMIN_EMAIL  id=$ADMIN_ID  role=admin"
echo "  csr    $CSR_EMAIL  id=$CSR_ID  role=csr"
echo "  csr system_health grants (role_permissions / overrides), expect [] []:"
echo -n "    role_permissions:      "; rest GET "role_permissions?role=eq.csr&permission_key=eq.system_health&select=is_allowed"
echo
echo -n "    permission_overrides:  "; rest GET "user_permission_overrides?user_id=eq.$CSR_ID&permission_key=eq.system_health&select=granted"
echo

ADMIN_JWT="$(signin "$ADMIN_EMAIL")"
CSR_JWT="$(signin "$CSR_EMAIL")"
[ "$ADMIN_JWT" != "null" ] && [ -n "$ADMIN_JWT" ] || { echo "FATAL: admin sign-in failed" >&2; exit 1; }
[ "$CSR_JWT"   != "null" ] && [ -n "$CSR_JWT"   ] || { echo "FATAL: csr sign-in failed" >&2; exit 1; }
echo "  admin + csr user JWTs obtained."

# ── 2. Attacker tokens ───────────────────────────────────────────────────────
# FORGED  : well-formed HS256 JWT, payload {"role":"service_role"}, signed with
#           a secret that is NOT the stack's JWT secret.
# ALG_NONE: same payload, "alg":"none", empty signature.
read -r FORGED ALG_NONE <<EOF
$(node -e '
const c = require("crypto");
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const now = Math.floor(Date.now()/1000);
const payload = { role: "service_role", iss: "supabase", iat: now, exp: now + 3600 };
const h1 = b64({ alg: "HS256", typ: "JWT" });
const p  = b64(payload);
const sig = c.createHmac("sha256", "f01-wrong-secret-not-the-stack-jwt-secret").update(h1+"."+p).digest("base64url");
const h2 = b64({ alg: "none", typ: "JWT" });
console.log(h1+"."+p+"."+sig, h2+"."+p+".");
')
EOF
echo "  forged HS256 (wrong secret) and alg:none tokens built."

# ── 3. Matrix ────────────────────────────────────────────────────────────────
PASS=0; FAIL=0

hit() { # hit <fn> <case label> <expectation> <curl auth args...> ; body via $BODY
  local fn="$1" case_label="$2" expect="$3"; shift 3
  local out code body
  out="$(curl -s -o /tmp/f01_body.$$ -w '%{http_code}' -X POST "$FN/$fn" \
          -H "Content-Type: application/json" "$@" -d "${BODY:-{\}}" 2>/dev/null)"
  code="$out"; body="$(head -c 300 /tmp/f01_body.$$ 2>/dev/null)"; rm -f /tmp/f01_body.$$
  printf '  %-30s %-26s -> %-4s %s\n' "$case_label" "[expect $expect]" "$code" "$(printf '%s' "$body" | tr '\n' ' ')"
}

echo
echo "── system-health-v2 ─────────────────────────────────────────────────────"
BODY='{}'
hit system-health-v2 "no Authorization header" "401"
hit system-health-v2 "garbage token"           "401" -H "Authorization: Bearer not-a-jwt-at-all"
hit system-health-v2 "FORGED service_role"     "401" -H "Authorization: Bearer $FORGED"
hit system-health-v2 "alg:none service_role"   "401" -H "Authorization: Bearer $ALG_NONE"
hit system-health-v2 "csr user JWT"            "403" -H "Authorization: Bearer $CSR_JWT"
hit system-health-v2 "admin user JWT"          "200" -H "Authorization: Bearer $ADMIN_JWT"

echo
echo "── reconcile-store-credit ───────────────────────────────────────────────"
echo "  NOTE: no SHOPIFY_* secrets are set, so an ACCEPTED caller reaches"
echo "        mintAccessToken() and gets 500 'Shopify token mint failed'."
echo "        500 here = the auth gate PASSED. 401/403 = rejected."
BODY='{}'
hit reconcile-store-credit "garbage token"          "401"          -H "Authorization: Bearer not-a-jwt-at-all"
hit reconcile-store-credit "FORGED service_role"    "401"          -H "Authorization: Bearer $FORGED"
hit reconcile-store-credit "local service_role key" "accepted/500" -H "Authorization: Bearer $SRK"
hit reconcile-store-credit "csr user JWT"           "403"          -H "Authorization: Bearer $CSR_JWT"
hit reconcile-store-credit "admin user JWT"         "accepted/500" -H "Authorization: Bearer $ADMIN_JWT"

echo
echo "── sync-store-credit-to-shopify ─────────────────────────────────────────"
echo "  400 'customer_id is required' = auth gate PASSED, body validation"
echo "  rejected the empty payload BEFORE any Shopify call."
BODY='{}'
hit sync-store-credit-to-shopify "FORGED service_role"    "401" -H "Authorization: Bearer $FORGED"
hit sync-store-credit-to-shopify "alg:none service_role"  "401" -H "Authorization: Bearer $ALG_NONE"
hit sync-store-credit-to-shopify "csr user JWT"           "403" -H "Authorization: Bearer $CSR_JWT"
hit sync-store-credit-to-shopify "local service_role key" "400" -H "Authorization: Bearer $SRK"
hit sync-store-credit-to-shopify "admin user JWT"         "400" -H "Authorization: Bearer $ADMIN_JWT"

echo
echo "════════════════════════════════════════════════════════════════════════"
echo " done — label: $LABEL"
echo "════════════════════════════════════════════════════════════════════════"

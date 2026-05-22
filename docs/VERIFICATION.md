## Verification Rule (updated 2026-04-12)

  Frontend verify panel and SystemAudit.tsx have been REMOVED.
  All account health checks are now server-side via SQL RPCs:

  audit_account(p_invoice_number text) — per-account real-time audit
    Called by "Check Health" button in AccountDetail (admin + finance)
    Returns JSONB with checks array, each with label/expected/stored/pass

  audit_all_accounts() — system-wide audit
    Called by "Run System Audit" button in Dashboard (admin only)
    Returns table of invoice_number, all_pass, failed_checks

  Both RPCs live in Supabase SQL Editor — NOT in edge functions.
  They use the canonical formula directly in PostgreSQL — no JavaScript
  rounding issues, no stale cached values, no view data dependencies.

  After ANY change to calculation or payment logic:
    1. Run "Check Health" on TEST-001, TEST-002, TEST-003 → all checks pass
    2. Run "System Audit" from Dashboard → check for new failures
    3. If any check fails, the change broke something


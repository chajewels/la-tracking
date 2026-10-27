# Display Rules

Moved verbatim from CLAUDE.md on 2026-10-28 (Option A split); CLAUDE.md keeps a one-line pointer and every money rule.

## Display Rules (NEVER break these)
### Dates

  Schedule list → always show due_date (when payment is due)
  Payment History → always show created_at (when payment was made)
  NEVER mix these two

### Customer Message Templates

  Opening and closing words are picked at random per open from public.message_lines (owner decision 2026-10-01). The templates below are line 1 of each pool and the fallback. Figures, links, PIN line, headers, notices and policy sentences are fixed. Pools and placeholders: src/lib/message-lines.ts and docs/SCHEMA-FACTS.md. Lines are edited ONLY in Hub → Settings → Message lines (admin, audited; line 1 of every pool is locked = the code fallback; lines are switched off, never deleted).

  The SINGLE PAYMENT, SPLIT PAYMENT, FULLY PAID and BATCH PAYMENT template
  texts (line 1 of each pool = the code fallback) are in docs/SCHEMA-FACTS.md
  "Rules moved from CLAUDE.md" and src/lib/message-lines.ts; the PIN line is
  shown only when [portalLink] is a token link (PORTAL LINK RULE below).

### PORTAL LINK RULE (both builders: src/lib/portal-link.ts, _shared/portal-link.ts)

  1. customers.portal_password_at set    → bare URL (sign-in), intent honoured
  2. else a live (active, unexpired) token → token URL, intent honoured
  3. else auth_user_id set                → bare URL, intent honoured
  4. else                                 → https://portal.chajewelsjp.com/portal
  auth_user_id alone is no password (magic-link sign-ins set it). Column set by
  setup-customer-account + portal-auth Path 0 on a password sign-in.
  PIN line: shown iff the built URL is a token link (isTokenLink) and a PIN
  exists; never keyed on auth_user_id. History: docs/FIXED-BUGS.md
  "Portal password customers got token links" (2026-09-28).

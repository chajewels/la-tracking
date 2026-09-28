## PORTAL PIN AUTHENTICATION (added 2026-04-21)

  PIN hash storage: customers.portal_pin_hash (64-char SHA-256 hex digest)
  Related columns:  customers.portal_pin_attempts
                    customers.portal_pin_locked_until

  Hashing standard: SHA-256 only (crypto.subtle.digest)
    TextEncoder → SHA-256 → hex map → 64-char string
    NEVER use bcrypt — removed in commit 7080d5a

  Auto-seed logic (verify-portal-pin):
    If no PIN set → hash last 4 digits of mobile_number, fallback '0000'
    Store as 64-char hex digest

  Verify logic:
    Pure SHA-256 hex equality compare
    No bcrypt fallback — dropped in commit 7080d5a

  Set PIN (set-portal-pin):
    Same TextEncoder + crypto.subtle.digest pipeline
    Every newly set PIN stores as 64-char hex

  Migration note (2026-04-21):
    Confirmed 0 bcrypt hashes ($2a$…) in customers table
    All accounts are SHA-256 clean — no PIN resets required

  Edge functions:
    verify-portal-pin — deployed 2026-04-21
    set-portal-pin    — deployed 2026-04-21

## PIN LINE IN STAFF MESSAGES (verified 2026-09-28)

  Every token link (/portal?token=… or /loyalty?token=…) opens the PIN gate
  (src/pages/CustomerPortal.tsx). So a message shows the "🔐 Your portal PIN
  is the last 4 digits…" line iff the link it carries is a token link
  (isTokenLink in src/lib/portal-link.ts) and the customer has a PIN
  (>= 4 mobile digits). It is NEVER keyed on auth_user_id — a customer can
  have auth_user_id and no portal password (storefront magic-link sign-in,
  live since 2026-09-10) and then gets a token link. Which link a customer
  gets: CLAUDE.md "PORTAL LINK RULE".
  (The SHA-256 sections above are NOT re-verified here; CLAUDE.md says PINs
  moved to customer_pins with PBKDF2 — treat those sections as stale.)

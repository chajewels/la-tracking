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


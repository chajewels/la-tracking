## LOYALTY LIFECYCLE INTEGRATION (Bug #99 — finalized 2026-05-13)

Loyalty revoke/award is wired into all payment lifecycle events EXCEPT
where explicitly decided otherwise.

### Wired (fires revoke or award):
  - void-payment (layaway):           revoke
  - restore-payment (layaway):        restore (via restore_loyalty_points RPC)
  - void-cash-payment:                revoke
  - restore-cash-payment:             restore
  - award-loyalty-points:             award (fires on DP confirmation for
                                      layaway, isFullyPaid for cash)
  - manual-forfeit:                   revoke
  - auto-forfeit-settlement:          revoke (4 hook points — PATH 1, PATH 2,
                                      extension expiry, extension cap;
                                      PATH 3 final_settlement does NOT revoke
                                      per Bug #101, 2026-05-14)
  - reactivate-account:               restore (via restore-loyalty-points
                                      edge function — Bug #101, 2026-05-14)
  - delete-account:                   revoke BEFORE delete_account_atomic RPC

### Explicitly NOT wired:

  Decision 5 — UPDATED via Bug #101 (2026-05-14) — reactivate-account
  now AUTO-RESTORES loyalty:
    reactivate-account auto-restores loyalty by calling restore-loyalty-points
    on the most recent revoke transaction tied to the account. Reverses
    the original Bug #99 decision (was "no auto re-award"). Documented
    inline in the edge function.

  Decision 7 — edit-payment-amount (no-op):
    Editing payment.amount_paid does not change loyalty state under the
    current award model (award is based on account.total_amount, not
    payment amount). No revoke or award fires. Documented inline in the
    edge function with a Phase 0 comment block.

  Decision 9 — delete-account (path-a: explicit calls):
    Implemented via explicit fetch to revoke-loyalty-points BEFORE the
    delete_account_atomic RPC. NOT via DB cascade trigger.

### Lot schema (Bug #99 final shape):
  - lot.original_amount       = base_points × tier_multiplier
                                (full multiplied points stored in lot)
  - lot.spend_basis_jpy       = loyaltyJpy (single source of truth for
                                spend reversal)
  - lot.tier_at_time          = tier name at award time (cosmetic; may
                                drift if tier crossed after DP)
  - lot.multiplier_at_time    = multiplier applied (1x/2x/3x)
  - lot.revoked_at            = TIMESTAMPTZ when revoked
  - lot.revoked_by_transaction_id = UUID of revoke transaction

### Trigger event → reason mapping (in revoke-loyalty-points):
  - void_layaway, void_cash      → 'payment_voided'
  - manual_forfeit, auto_forfeit,
    final_forfeit                → 'account_forfeited'
  - edit_amount                  → 'payment_edited' (currently unused — see
                                   Decision 7)
  - delete_account               → 'account_deleted'

### Restore trigger event → reason mapping (in restore-loyalty-points, Bug #103 — 2026-05-15):
  - account_reactivated  → 'account_reactivated' (default; via reactivate-account)
  - payment_restored     → 'payment_restored'    (future; via restore-payment)
  - manual_restore       → 'manual_restore'      (future; admin direct restore)

### Email policy:
  - Silent on routine revoke or restore (no tier change)
  - Email + in-portal notification on tier transition (any direction)
  - Tier-revoked email template handles 4 revoke reasons in REASON_COPY map
  - Tier-restored email template handles 3 restore reasons in REASON_COPY map
    (added Bug #103, 2026-05-15)
  - In-portal notifications use shared emitNotification helper for BOTH revoke
    and restore paths (writes both loyalty_notifications master row +
    loyalty_notification_recipients row; required for customer portal INNER
    JOIN visibility — Bug #100 fixed revoke side 2026-05-14, Bug #103 fixed
    restore side 2026-05-15)

### Status transition revoke matrix (Bug #101 — 2026-05-14):
  Loyalty revoke fires ONLY when account.status transitions into these
  terminal states:
    - forfeited       (via manual-forfeit OR auto-forfeit PATH 1/2)
    - final_forfeited (via auto-forfeit extension expiry/cap)
    - cancelled       (FUTURE — no current write path exists; documented
                       business rule for if/when cancel-account is built)

  Loyalty is NOT revoked on these statuses:
    - final_settlement (PATH 3) — loyalty preserved; if customer later
                                  recovers, lots stay intact
    - extension_active            — intermediate state, no terminal effect
    - completed                   — successful payoff, loyalty preserved
    - reactivated                 — restoration path; auto-restores via
                                    reactivate-account

  Loyalty is RESTORED on reactivate-account when a prior revoke transaction
  exists for the account.


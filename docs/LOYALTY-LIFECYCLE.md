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

### Tier downgrade + re-qualification (added 2026-06-05)

Distinct from the lot-revoke flow above. This subsection covers tier
movement only — point lots are not affected by these rules.

  1. **Downgrade snapshots `downgrade_spend_baseline`.** Both inactivity
     downgrade paths write `loyalty_members.downgrade_spend_baseline =
     cumulative_spend_jpy` at the moment of downgrade — capturing
     lifetime spend as the floor for "new awarded spend since
     downgrade":
     - **Expiry path** (180-day total-inactivity): writes baseline
       only when the points-expiry also moves tiers
       (`tierChanged === true`). Pure points-expiry with no tier
       movement leaves the field untouched.
     - **Gap path** (180-day gap between two consecutive successful
       orders): always writes baseline — this branch only runs when
       a tier downgrade is happening.
     The column is nullable; NULL means "not currently downgraded for
     re-qualification purposes."

  2. **Restore requires NEW awarded spend ≥ the earned tier's
     `requalify_spend_jpy`.** `award-loyalty-points` Step 5b reads
     `loyalty_members.is_downgraded` + `downgrade_spend_baseline` +
     `earned_tier_id`, then reads
     `loyalty_tiers.requalify_spend_jpy` for the earned tier
     (Radiant 500000, Elite 2000000, Crown VIP 4000000, Glimmer NULL).
     Re-qualified when
     `(newCumulative − downgrade_spend_baseline) >= requalify_spend_jpy`.
     - Once re-qualified, tier recomputes from `newCumulative` against
       `loyalty_tiers.min_spend_jpy` (same lookup as a normal upgrade),
       the **ratcheted multiplier applies on the completing purchase**
       (the award that crosses the threshold uses the restored tier's
       multiplier, not the downgraded one), the member update sets
       `earned_tier_id` / `current_tier_id` / `is_downgraded = false` /
       `downgrade_spend_baseline = null` in one write, and the
       loyalty-tier-upgrade email path fires.
     - **While downgraded and NOT yet re-qualified:** the gate yields
       `tierUpgraded = false`. Points earn at the current (downgraded)
       tier's multiplier. `tier_at_time` on the `earned` transaction
       records the downgraded tier. No tier fields written.
       `is_downgraded` stays true. The member silently accumulates
       toward the re-qualification target with every awarded purchase.

  3. **Gap-clock activity definition.** The 180-day gap downgrade now
     counts ANY successful order of any amount as activity — matching
     the expiry gate. `loyalty-inactivity-check` aggregates the two
     most recent successful order dates per customer (DESCENDING) from
     `layaway_accounts` (status IN active/overdue/completed/extension_active/
     reactivated) + `cash_orders` (status IN completed/pending) — no
     amount filter. When ≥2 dates exist, `gapBetweenLastTwo` is the
     daysBetween of those two; when fewer than 2, falls back to the
     legacy `prev_purchase_at` scalar computation. Small orders
     (< ¥10,000) keep the account active even though they earn no
     points (see `award-loyalty-points` `below_minimum` skip).

  4. **Missing config falls back to instant restore.** If
     `downgrade_spend_baseline` is NULL, or `earned_tier_id` is NULL,
     or `loyalty_tiers.requalify_spend_jpy` is NULL for the earned
     tier, the re-qualification gate sets `requalified = true` and
     behavior is identical to pre-2026-06-05 (tier movement runs
     purely on lifetime spend, restore is instant). This is the safe
     default for Glimmer (no requalify target by design) and for any
     legacy member whose downgrade predates the baseline column.

  5. **One absence, one tier charge (Bug #258, 2026-08-19).** A gap
     downgrade is skipped when an `expired` transaction falls inside the
     gap window `[topTwo[1], topTwo[0]]`. Points expiry and gap downgrade
     are two charges for the same inactivity period, and an absence
     settled by expiry must not be re-charged as a tier drop on return.
     This matters most at the floor tier: a Glimmer member's expiry drops
     no tier (`tierChanged = false`), so `is_downgraded` is never set and
     the gap path's `!is_downgraded` guard stays open — a returning order
     that lifts them above `display_order 1` would otherwise be
     immediately penalised for the absence it just ended. Note that the
     gap clock measures the interval between the two most recent past
     orders, so it can only ever evaluate retroactively, on return.

### Loyalty trail in account notes (added 2026-06-06)

Every linked loyalty event now writes an `account_notes` row so the
trail is visible inside `AccountDetail` (layaway) and
`CashOrderDetail` (cash order) alongside the existing payment +
schedule history. Three writers, one convention:

  1. **Award** — `supabase/functions/award-loyalty-points/index.ts`
     writes the note immediately before the final `awarded: true`
     return, after the member update has fully succeeded. Body
     format: `Loyalty: +{points} pts awarded{ (+{bonus} bonus)?} —
     balance {newRemaining}{ — tier upgraded {old} → {new}?}`.
  2. **Approve** — written **inside** the
     `approve_redemption_atomic(uuid, uuid, text)` RPC (SQL Editor;
     no edge-side copy). Body format:
     `Loyalty: redemption approved — {points} pts redeemed
     ({redemption_type})`. Runs in the same transaction as the
     debit, so the note is either fully present or fully absent
     along with the approve writes — never half-committed.
  3. **Void** — `supabase/functions/process-loyalty-redemption/
     index.ts` void handler writes the note after all void writes
     have succeeded and immediately before the success response.
     Body format: `Loyalty: redemption voided — {points} pts
     refunded ({redemption_type})`.

Conventions for all three writers:

  - `created_by_name` is set to `"System (Loyalty)"`. Award uses
    `created_by_user_id: null` (system-driven); approve and void
    use the acting user id, since the RPC and the void handler are
    invoked by an admin/finance reviewer.
  - The insert is skipped entirely when neither `account_id` nor
    `cash_order_id` is present (rare in practice but guards against
    stand-alone loyalty events that have no linked order).
  - Award and void wrap the insert in a non-blocking try/catch that
    logs `console.warn` on failure — a note-insert error must NEVER
    fail or roll back the underlying loyalty operation. Approve's
    note lives inside the same RPC transaction, so a note failure
    raises and rolls back the whole approve (acceptable because the
    RPC already provides full atomic rollback semantics — see Bug
    #164 in docs/FIXED-BUGS.md).
  - Sheet sync, lot writes, transaction-row inserts, and member /
    redemption / payment updates are untouched.


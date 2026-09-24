<!-- Moved VERBATIM from CLAUDE.md on 2026-09-24 to bring it under the
     Claude Code load limit. CLAUDE.md keeps every rule from these sections
     as a rules block with a pointer here; this file keeps the full text.
     Read it when a task touches this area. -->

## LOYALTY SYSTEM RULES (locked 2026-05-16) — NON-NEGOTIABLE

  1. Portal signup creates a customers row + auto-enrolls.
     setup-customer-account: when the verified email matches no
     existing customer, it creates the customers row (full_name
     required; email + auth_user_id from the JWT; optional
     mobile_number / facebook_name / messenger_link / location /
     country; customer_code via existing trigger) AND inserts a
     loyalty_members row at the Glimmer tier with all counters 0.
     Existing-customer emails continue the link-only path
     unchanged. DUPLICATE BLOCK (owner rules 2026-09-23): before
     that create, find_customer_matches runs on full name, Facebook
     name, mobile and email; any match returns 409 already_registered
     ("You are already registered. Please contact Cha Jewels for your
     account details."), creates nothing and raises staff bell
     duplicate_signup_blocked. The email-link branch is her own record
     and is never checked. Same rule on website POST /auth/customer and
     on every Hub create path — no "create anyway". Full rules:
     docs/SCHEMA-FACTS.md "Duplicate-customer prevention".
     Profile fields are collected on PortalSetup.tsx
     and stashed in localStorage (key 'portal-setup-profile') so
     they survive the email-verification page reload.

     EVERY ENROLLMENT PATH (setup-customer-account, join-loyalty-program)
     MUST: set loyalty_members.enrollment_source; write one 'enrolled'
     loyalty_transactions row whose note names the source; send the
     'enrolled' sheet event and, on success, set that row's
     synced_to_sheet_at (otherwise loyalty-sheet-reconcile appends a
     duplicate Members-tab row). Sources: portal_signup (setup-customer-
     account), portal_join (LoyaltyJoinPrompt), shopify_checkout
     (shopify-webhook, internal branch), storefront_checkout /
     storefront_join (cha-jewels-web), legacy_import (pre-2026-05-16),
     unknown (caller sent no valid hint — investigate). Customer-authed
     callers may only send portal_join / storefront_checkout /
     storefront_join. website POST /loyalty/join NEVER enrolls; it records a
     FAILED storefront enrollment and raises staff bell 'loyalty_join_failed'.

  2. review-payment-submission is the SOLE award path.
     Layaway → award only on downpayment confirm. Cash → award
     only on full completion (isFullyPaid). NEVER on monthly
     installment payments. No DB-trigger award path exists
     (Layer-2 removed — see LOYALTY AWARD SYSTEM).

  3. Currency-agnostic awards, server-enforced via amount gate
     (per Bug #113, 2026-05-17). award-loyalty-points reads
     loyalty_jpy_amount from the source row (populated at account
     creation from the "Product Amount (JPY) — Loyalty Only" form
     input; excludes shipping, service fees, insurance) and skips
     with reason='no_loyalty_amount' when loyalty_jpy_amount <= 0
     or null. Both PHP and JPY accounts can earn — loyalty_jpy_amount
     is the canonical loyalty spend basis regardless of account
     currency. The pre-Bug #113 currency gate (currency !== 'JPY')
     was removed.

  4. loyalty_enabled is the go-live gate, enforced server-side.
     award-loyalty-points: flag false/null →
     { skipped: true, reason: 'loyalty_disabled' } (no tx, no
     lot, no counter change). join-loyalty-program: flag
     false/null → 403 { error: 'Loyalty program is not
     currently available' }. Flag read from
     system_settings.loyalty_enabled (jsonb scalar), fail-closed
     (anything other than strict true = disabled). Frontend
     useLoyaltyAccess gate is retained but is now defence-in-depth
     only — the server is authoritative.

  5. Flipping system_settings.loyalty_enabled = true is THE
     go-live event. Cynthia flips it manually via SQL when
     ready. No code change required to launch.

  6. Lot expiry is surfaced in the portal. customer-portal
     returns loyalty_lots (non-revoked, non-consumed, expires_at
     ASC NULLS LAST). MemberCard shows the next-expiring lot and
     a red "expiring soon" badge when within 30 days.

  7. Redemption role gates (locked 2026-06-06):
     APPROVE is reachable by admin / finance / staff — frontend
     `RedemptionApprovalModal.canApprove` includes the staff role,
     and `process-loyalty-redemption` approve gate uses the existing
     `isInternal` constant (`isAdmin || isFinance || isStaff`).
     CANCEL and VOID stay admin-only on both the frontend
     affordance and the server gate. Extending APPROVE to staff
     was an explicit policy decision so reviewers handling
     redemption traffic during business hours don't have to escalate
     to admin/finance for every approval; reversal paths (cancel,
     void) keep the higher trust requirement because they affect
     accounts post-debit.

  8. 2026-06-06: Staff bell (staff_notifications) now covers the full
     redemption lifecycle — redemption_requested / redemption_approved /
     redemption_cancelled / redemption_voided — emitted non-blocking from
     process-loyalty-redemption, covering both layaway-linked and
     cash-order-linked redemptions (cash_order_id in metadata, account_id
     NULL, per existing convention).

  9. REDEEMED POINTS ARE NOT RETURNED ON ORDER CANCELLATION/FORFEITURE
     (verified 2026-07-10). Cancelling a cash order or forfeiting a layaway
     account does NOT charge redeemed points back to the loyalty account —
     the cancel path only sets status/reason/timestamp; no trigger or code
     returns points on cancellation. Redeemed points are returned ONLY when
     an admin explicitly voids the REDEMPTION itself via
     process-loyalty-redemption (action 'cancel'/'void' →
     void_redemption_atomic). This applies system-wide and must apply to
     Shopify orders too. Do not add automatic point-return on order
     cancellation.

  10. Partial Shopify refunds auto-adjust earned points proportionally
     (revoke_loyalty_points_partial, revoke-and-replace, expiry preserved,
     redeemed never returned). promo_bonus lots are NOT touched on partials.

  11. TIER RULE (decided 2026-09-13): the tier is LIFETIME cumulative spend
     (loyalty_members.cumulative_spend_jpy vs loyalty_tiers.min_spend_jpy),
     never a 12-month window. The only time-based rule is the 180-day
     inactivity step-down (one tier down, downgrade_spend_baseline stamped),
     after which loyalty_tiers.requalify_spend_jpy is the NEW spend needed to
     regain the earned tier. Customer-facing copy (storefront /loyalty, FAQ,
     loyalty portal) must say "lifetime purchases" and explain the step-down.
     NO GRACE PERIOD after a step-down and NO retroactive tier changes (owner
     decision 2026-09-13). Communication only: warning email at 150 days
     (loyalty_email_stepdown_warning, dedup loyalty_members.stepdown_warned_at),
     notice email on the step-down day (loyalty_email_tier_downgrade), restored
     email on requalification (loyalty_email_tier_restored) — all JA + EN, Cha
     Jewels brand, Reply-To sales@, templates in _shared/email-templates/
     loyalty-level.tsx. The reduced state (earned level + spend to regain =
     requalify_spend − spend since baseline) is shown in the loyalty portal
     (MemberCard, Tiers) and on the storefront /account via `website` GET /me
     (reduced, earned_tier, regain_jpy).

  12. POINTS INTEGRITY (2026-09-13, Bug #269): loyalty_transactions is the
     ledger and is append-only (trigger allows only synced_to_sheet_at to
     change). Awards are idempotent per order through loyalty_award_claims
     (claim_loyalty_award / confirm / release RPCs) — the read-then-check in
     award-loyalty-points is no longer the guard. Every reversal is a ledger
     row (revoked = -remaining actually taken back), never a delete. Run
     SELECT * FROM loyalty_integrity_report(); at any time. A HEALTHY REPORT IS
     EXACTLY ONE ROW, not zero: the live test fixture Test Customer
     (CJ-2026-05088) is a documented, deliberately-kept baseline — see
     docs/TEST-ACCOUNTS.md "loyalty_integrity_report baseline (2026-09-17)" for
     its exact values. Any OTHER row is a real finding, and any change to HER
     values means a test run moved them.

  13. POINTS AND SPEND ARE REVERSED FROM DIFFERENT SOURCES (2026-09-14, Bug #271).
     POINTS come from the surviving loyalty_point_lots — you can only take back
     points that still exist, and redeemed points are never clawed back (rule 9).
     SPEND comes from the ORDER'S OWN LEDGER BASIS
     (loyalty_order_spend_basis = SUM(earned) − SUM(revoked) over that order's
     loyalty_transactions rows), independent of lots: spend happened, and
     redeeming or expiring the points later does not un-happen it. Deriving both
     from the lots is what let cancelled orders keep counting towards the tier.
     NEVER use cash_orders/layaway_accounts.loyalty_jpy_amount as the reversal
     basis — the net-spend rule mutates it after the award — and NEVER honour
     revoke_loyalty_points' p_spend_jpy: every caller passes total_paid in JPY,
     which is money received, not the loyalty basis. The parameter survives for
     signature compatibility only and is ignored. Idempotency is the basis
     reaching 0, not a GREATEST(0, …) floor.
     There is exactly ONE revoke_loyalty_points — the 10-argument one. The
     baseline's 9-argument twin (still carrying the old lot-derived body) is
     DROPPED by the same migration; never re-create a second overload by adding
     a defaulted parameter without dropping the old signature, or every call
     that omits it fails with "is not unique".
     A REVERSAL THAT CANNOT BE SOURCED IS NEVER SILENT. When the basis is 0, no
     lots survive, the order has NO earned and NO revoked ledger row, and money
     WAS received on it (total_paid, or a non-voided payment row), the function
     writes audit_logs + staff_notifications type 'loyalty_reversal_unsourced'
     naming the invoice, then RETURNS — it does not refuse. Blocking a terminal
     action because the loyalty history predates the Hub is worse than the gap.
     An order that earned and was already reversed HAS ledger rows that net to
     zero; that stays silent. The discriminator is the row COUNT, not the net.
     An order that received NO money has nothing to reverse and stays silent
     too — a loyalty_jpy_amount alone proves nothing (every web order carries
     one from checkout; 2026-09-24).
     A post-award CORRECTION that adds points follows the same shape in reverse:
     an 'earned' ledger row tagged with the invoice (never 'adjusted', which the
     integrity report counts as a deduction), and a revoke-and-replace of the
     single active order_earn lot with expiry preserved
     (uq_lots_active_order_earn_source allows only one) — see #279.

  14. CUSTOMERS NEVER SEE LEDGER NOTES (2026-09-17, Bug #283).
     loyalty_transactions.notes is internal text (UUIDs, enum names, bug
     references) and the ledger is immutable, so a bad note can never be
     edited away. Customer screens build every activity line through
     toCustomerActivity (src/components/loyalty/loyaltyActivity.ts): fixed
     per-type labels or "Invoice #N"; 'enrolled' and 'tier_changed' are
     neutral milestones; any other 0-point row is hidden. customer-portal
     does not select notes at all. Staff screens use toStaffActivity and
     keep the note. A new transaction type needs a label key in
     i18n/portal.ts (loyalty.activityType*) or it shows "Points update".

  - A CLOSED ORDER CAN NEVER BACK A REDEMPTION (2026-09-12). Layaway closed =
     cancelled/forfeited/completed/final_settlement; cash open = pending.
     Enforced in RedemptionForm, process-loyalty-redemption create, and
     approve_redemption_atomic. catalog_reward invoice_number, if given, must
     be the customer's own open order.


  - 2026-05-20 backfill: corrected 30 migrated members' clocks to
    their real successful-order dates; reverted 4 forfeited-sourced
    clocks (Judy Haitch, Shiela Trevilian, Maria Milliones Jensen,
    Test Customer). Snapshot:
    `loyalty_last_purchase_backfill_audit_20260520`.

  - Honey Faye (CJ-2026-01672) was the sole wrongful expiry from
    the prior gating logic: 2,700 restored + 1,600 awarded for
    INV 19015 = 4,300 remaining_points; Google Sheet synced via 3
    manual POSTs to sync-loyalty-to-sheet (Transactions rows 419/
    420 + Members row 485) — Supabase and sheet match.


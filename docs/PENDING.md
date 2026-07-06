## PENDING ITEMS (as of 2026-05-25)

### LOYALTY PORTAL — Cha Jewels Circle Port
✅ COMPLETE — Phases 1–8 shipped. Verified against main 2026-05-25 by repo audit.

  Verified file evidence (2026-05-25):
  - Phase 1 store extensions — src/components/loyalty/loyaltyData.ts:
      last_purchase_date (:83), tier_multiplier (:101), invoice_number (:99),
      TIER_STATIC map (:13). staticFallback.ts present + imported by
      MilestoneBanner, ReferralSection, VipRewardsVault, ProfileScreen, RewardsScreen.
  - Phase 2 BottomNav + scaffolding — LoyaltyBottomNav.tsx + all 6 screens
      in src/components/loyalty/screens/.
  - Phase 3 Home composition — screens/HomeScreen.tsx + all 9 home/ sub-components
      (HomeHeader, MilestoneBanner, QuickActions, BirthdayRewardCard, FeaturedBanner,
       PromoBanners, ReferralSection, ExclusiveOffers, MilestoneCard).
  - Phase 4 Tiers — screens/TiersScreen.tsx.
  - Phase 5 Points — screens/PointsScreen.tsx (consumes tx.tier_multiplier +
      tx.spend_amount_jpy at :183–212).
  - Phase 6 Rewards — screens/RewardsScreen.tsx + rewards/VipRewardsVault.tsx.
  - Phase 7 Notifications — screens/NotificationsScreen.tsx.
  - Phase 8 Profile — screens/ProfileScreen.tsx + ProfileMemberCard.tsx.
  - All 6 screens imported + routed in src/pages/LoyaltyPortal.tsx (:24–29, tab-switched).

### LOYALTY TIER BENEFITS — Schema Expansion (OPEN — added 2026-05-25)
  ⏳ The customer portal renders HARDCODED tier benefits from TIER_STATIC
     (src/components/loyalty/loyaltyData.ts). Admin edits in TierEditDialog save
     to the DB but do NOT propagate to the portal — admin and customer views drift.
     See the in-code warning at src/components/loyalty-admin/TierEditDialog.tsx:248.
  Goal: portal reads tier benefits from the DB instead of hardcoded TIER_STATIC.
  Until shipped: do not edit tier-benefit fields in TierEditDialog.

### LOYALTY DATA & MIGRATION
  Pre-go-live items all completed 2026-05-15 → 2026-05-16:
    - 464-member base migration done (6-customer catch-up applied
      2026-05-16 — see SYSTEM STATUS)
    - sync-loyalty-to-sheet rewritten from stub to live real-time append
    - Google Sheets GAS email notifications shut off — Sheets is backup
      only; Supabase send-transactional-email is the sole sender

  Migration scope (locked 2026-05-15, reaffirmed 2026-05-18) — NON-NEGOTIABLE:
    SUMMARY-ONLY BY DESIGN. Migrated fields per member:
      - cumulative_spend_jpy
      - total_points_earned
      - remaining_points
      - total_points_redeemed
      - enrollment_date (= first purchase date from Google Sheets)
    Each migrated member received ONE consolidated lot with
    spend_basis_jpy = cumulative_spend_jpy representing the
    member's ENTIRE pre-migration lifetime.

    NOT migrated by design:
      - Per-order purchase history (individual order earnings)
      - Per-account redemption history (which account a redemption was applied to)

    These details remain in Google Sheets if ever needed but are
    NOT required for operational use. Cynthia approved this scope
    explicitly 2026-05-15 (LOYALTY BUILD 3 chat).

  Lot reconciliation rule — NON-NEGOTIABLE:
    When auditing lot integrity, ONLY investigate lots with
    earned_at > '2026-05-16'. Pre-migration consolidated lots
    represent aggregate lifetime spend and have no source event
    to reconcile against — they exist by design.

    A member without lots is not a bug — it's an edge case in the
    deliberately-scoped migration. DO NOT flag missing per-order
    lots or "orphan" members as gaps. Their loyalty state is fully
    encoded in loyalty_members.{cumulative_spend_jpy,
    total_points_earned, remaining_points, total_points_redeemed}.

  (No pending items for migration — Adjust Points shipped & validated
   2026-05-17, see SYSTEM STATUS.)

### LOYALTY REDEMPTION TYPE RULES (locked 2026-05-19) — NON-NEGOTIABLE

  | Type | FK | Invoice # input | invoice_number column | Notes | Synthetic payment | Allocation chain | Member balance |
  |------|------|-----------|------|-------|-------------------|------------------|----------------|
  | new_order_discount | account_id OR cash_order_id (brand-new only) | required (free-text, must match) | user-submitted value | optional | YES | YES (layaway only) | debit |
  | shipping_fee | NONE | NOT accepted | NULL (column nullable as of 2026-05-19) | **required** (max 500 chars) | NO | NO | debit ONLY |
  | service_fee | NONE | NOT accepted | NULL (column nullable as of 2026-05-19) | **required** (max 500 chars) | NO | NO | debit ONLY |
  | catalog_reward | NONE | NOT accepted | NULL (column nullable as of 2026-05-19) | optional | NO | NO | debit + catalog stock decrement |

  STRICT RULE (locked 2026-05-19): shipping_fee and service_fee redemptions are
  points-only operations. They MUST NOT touch layaway_accounts, cash_orders,
  payments, cash_payments, payment_allocations, or layaway_schedule under any
  circumstance. The only DB writes on approve are: loyalty_members balance
  UPDATE + loyalty_transactions INSERT. (Supersedes the 2026-05-18 locked rules
  that incorrectly tied shipping/service to existing accounts.)

  invoice_number COLUMN (locked 2026-05-19): loyalty_redemptions.invoice_number
  is nullable (ALTER DROP NOT NULL applied 2026-05-19). new_order_discount
  stores the user-submitted invoice. shipping_fee / service_fee /
  catalog_reward store NULL — the old "REDEEM-{id}" placeholder pattern is
  REMOVED, never reintroduce it. (3 historical 2026-05-18 cancelled rows with
  "TEST-004"/"REDEEM-..." invoice values are preserved audit artifacts — do
  not rewrite them.)

  BELL NOTIFICATION (locked 2026-05-19): the in-app "Reward approved 🎁" bell
  fires for ALL redemption types on approve — emitNotification is
  unconditional, NO FK gating exists or should be added. Body is type-aware:
  new_order_discount uses the shared buildRedemptionApprovedNotification
  output unchanged; shipping_fee / service_fee / catalog_reward use an inline
  body that includes the customer's notes inline ("…Note: \"{notes}\"…").
  Built inline in process-loyalty-redemption (NOT in
  _shared/loyalty-notification-templates.ts) to confine the deploy surface.

  EMAIL "loyalty-redeem" line (locked 2026-05-19): renders
  "Applied to: INV #{invoiceNumber}" for new_order_discount;
  "Purpose: {notes}" for shipping_fee / service_fee / catalog_reward.
  The send call passes notes in templateData; gated on redemptionType in
  loyalty-redeem.tsx. Requires send-transactional-email redeploy on template

### LOYALTY ACCOUNT NOTES TRAIL (added 2026-06-04)
✅ RESOLVED 2026-06-06 — three writers now emit account_notes rows
  for every linked loyalty event: awards (award-loyalty-points),
  redemption approvals (inside approve_redemption_atomic RPC),
  redemption voids (process-loyalty-redemption void path). All three
  set created_by_name = 'System (Loyalty)', skip when neither
  account_id nor cash_order_id is present, and are wrapped in
  non-blocking try/catch so a note-insert failure never affects the
  underlying loyalty operation. See docs/LOYALTY-LIFECYCLE.md
  "Loyalty trail in account notes (added 2026-06-06)".

  Original flag (kept for context): Persistent loyalty trail in
  account_notes — log point awards AND all redemptions (services
  and others) per account. Scoped separately; not started.

### IS_STAFF() ROLE-SCOPE TIGHTENING (added 2026-06-05)
✅ RESOLVED 2026-06-05 — `is_staff(uuid)` restricted via SQL Editor to
  `EXISTS (SELECT 1 FROM user_roles WHERE user_id = $1 AND role IN
  ('admin','staff','finance','csr'))`. The any-row latent widening
  vector is closed; any future role added to `user_roles` must be
  explicitly added to that IN-list before it gains staff scope.

  Original flag (kept for context): is_staff() was loose — returned true
  for ANY user_roles row, not specific roles. Correct in practice (roles
  in use: admin / staff / finance / csr) but every is_staff() RLS policy
  would silently widen if a restricted/customer-facing role were ever
  added to user_roles.

### PORTAL_TOKEN COLUMN REVOKE IS A NO-OP (OPEN — found 2026-06-06)
  Security Batch 4's migration `20260605093651_…` ran
  `REVOKE SELECT (portal_token) ON public.extension_requests FROM
  authenticated, anon;` and the same for `payment_submissions`.
  Postgres ACL rule: a column-level REVOKE cannot subtract from a
  table-level grant. Both roles still hold table-level SELECT on
  both tables, so `portal_token` remains fully client-readable via
  `select('*')` or `select('portal_token')`. The Batch 4 entry in
  SYSTEM-STATUS.md (fix #7) records the action but the action did
  nothing.

  Proper fix is a careful standalone pass:
  1. Audit every `select('*')` consumer of both tables — both edge
     functions and frontend components — and convert them to
     explicit column lists.
  2. REVOKE the table-level SELECT from authenticated / anon.
  3. GRANT explicit column-list SELECT (omitting `portal_token`)
     back to authenticated / anon.
  4. Verify via `information_schema.column_privileges` that
     `portal_token` no longer appears for either role.

  Scope is non-trivial because PostgREST `select=*` is the
  default in many places; an incomplete audit will break list
  views silently. Park until a focused session.

### REALTIME INVALIDATION DOES NOT COVER loyalty_members (RESOLVED 2026-07-05)
  ✅ RESOLVED 2026-07-05 — loyalty_members + loyalty_transactions + staff_notifications published and added to SYNC_TABLES; LOYALTY_KEYS + NOTIFICATION_KEYS unioned into REALTIME_INVALIDATE_KEYS; the bell's 30s/60s polls retained as fallback only. Bonus: service_jobs/trade_ins publication gap repaired (their SYNC_TABLES subscriptions had been dead).

  Tier / remaining points / lifetime spend render stale on
  AccountDetail and CashOrderDetail until manual Refresh, while
  the account_notes trail updates live alongside via the existing
  REALTIME_INVALIDATE_KEYS sweep (account_notes inherits the
  realtime sync via its parent account/cash_order detail key).

  Two-line fix:
  1. Add `loyalty_members` (and probably `loyalty_transactions`) to
     `SYNC_TABLES` in `src/hooks/useRealtimeSync.ts`.
  2. Confirm `REALTIME_INVALIDATE_KEYS` includes the loyalty query
     keys actually consumed by `MemberCard` / `PointsSnapshot` /
     the bell badges — if not, add a new `LOYALTY_KEYS` group and
     union it in (per the CLAUDE.md REALTIME SYNC convention).

  Also review the staff_notifications bell refresh mechanism — it
  polls every 60s currently, which is fine for the bell badge but
  means the in-panel list doesn't refresh between polls. Either
  add `staff_notifications` to the realtime sweep or document the
  60s cap explicitly.

  Pure polish — no data correctness issue. Low priority.

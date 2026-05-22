## PENDING ITEMS (as of 2026-05-16)

### LOYALTY PORTAL — Cha Jewels Circle Port
Multi-phase port of Circle UI into
loyalty portal. In progress.

  ✅ Phase 1 partially done — propless
     components (MemberCard, VipProgress,
     PointsSnapshot, RecentActivity,
     TierCelebrationModal) ported with
     setLoyaltyData store
  ✅ LoyaltySplashScreen with onboarding
     carousel (4 slides) deployed
  ✅ MemberCard gold gradient + original
     7-second shine effect restored
  ✅ Tier badges row darkened for gold
     background readability
  ⏳ Phase 1 remaining — store extensions:
     - LoyaltyMemberData: email, join_date,
       last_purchase_date
     - LoyaltyTransactionData: invoice_number,
       spend_amount_jpy, tier_multiplier
     - TIER_STATIC: tagline per tier
     - staticFallback.ts (REWARDS, NOTIFICATIONS,
       MILESTONES, REFERRAL, FAQS)
  ⏳ Phase 2 — BottomNav + screen scaffolding
     (Home, Rewards, Points, Alerts, Profile +
     hidden Tiers screen via QuickActions)
  ⏳ Phase 3 — Home screen full composition
     (HomeHeader, MilestoneBanner, QuickActions,
     BirthdayRewardCard, FeaturedBanner,
     PromoBanners, ReferralSection,
     ExclusiveOffers, MilestoneCard)
  ⏳ Phase 4 — Tiers screen
  ⏳ Phase 5 — Points screen (with extended
     transaction fields)
  ⏳ Phase 6 — Rewards screen + VipRewardsVault
     (wired to existing RedemptionForm flow)
  ⏳ Phase 7 — Notifications screen
  ⏳ Phase 8 — Profile screen

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
  change (registry coupling, Bug #103).

### KNOWN OPEN ITEMS — Redemption wiring gap (filed 2026-05-18, Phase 11)

  The redemption flow was half-built when filed. Discovered during
  2026-05-18 process-loyalty-redemption investigation. Member points
  got debited on approve, but the discount never landed on the order,
  and lot consumption was never tracked.

  STATUS 2026-05-18 evening: Issues 1, 2, 3 RESOLVED & VERIFIED by
  Phase B Patch 2 (commit 8130ace) — inline waterfall allocation +
  per-row schedule sync + account totals UPDATE on the approve path.
  Root cause of all three was shared (the no-op reconcile-account
  call never applied the discount). End-to-end empirical verification:
    - Cash: Leslie redemption on cash order 19034 → synthetic
      cash_payment 37484ba6 inserted, cash_orders totals recomputed.
    - Layaway: redemption 08d1d0e0 on TEST-004 → synthetic payment
      2e9b3bf2 + payment_allocations row e022cfa1 + schedule/account
      totals updated.
  Issue 4 already FIXED 2026-05-18 (Phase 12, commit 722784c).
  Remaining open: void-path allocation cleanup (see KNOWN
  LIMITATIONS D1), atomic rollback (D2), GAS DELETE sync (D3).

  Issue 1 — Create-time: redemption can detach from real order
    ✅ RESOLVED & VERIFIED 2026-05-18 (Phase B Patch 2, 8130ace).
    The approve path now inlines the discount as a synthetic payment
    + waterfall allocation, so the redemption is bound to a real
    order at approval. Verified on TEST-004 (08d1d0e0 → payment
    2e9b3bf2, allocation e022cfa1).
    process-loyalty-redemption create branch allows account_id = NULL
    AND cash_order_id = NULL as long as invoice_number string is
    provided. Stored redemption row carries only free-text invoice
    with no FK to a real order record. Discount has no place to land.
    Reference: process-loyalty-redemption/index.ts lines 261-277.

  Issue 2 — Approve-time: no discount application anywhere
    ✅ RESOLVED & VERIFIED 2026-05-18 (Phase B Patch 2, 8130ace).
    process-loyalty-redemption approve branch now applies the
    discount: synthetic payment INSERT (payments / cash_payments) +
    inline waterfall allocation + schedule + account totals. Verified
    end-to-end on cash (19034 / 37484ba6) and layaway (TEST-004
    08d1d0e0 / 2e9b3bf2 / e022cfa1). [Original finding below.]
    NO edge function reads loyalty_redemptions or value_applied_jpy/php.
    Confirmed by grep across create-cash-order, create-layaway-account,
    record-payment, record-multi-payment, review-payment-submission
    → ZERO matches. The discount value_applied_jpy stored on the
    redemption row is never applied to cash_orders.total_amount,
    layaway_accounts.total_amount, or any payments row.

  Issue 3 — Lot consumption: loyalty_lot_consumption table unused
    ✅ RESOLVED & VERIFIED 2026-05-18 (shared root cause with
    Issues 1+2; closed by Phase B Patch 2, 8130ace). The waterfall
    now decrements the canonical schedule/account state on approve;
    the redemption→payment→allocation chain provides the consumption
    audit trail. (loyalty_lot_consumption table remains unused by
    design — lot-based math is the deferred summary-only Phase 6.1
    scope per LOYALTY DATA & MIGRATION; not required for the
    discount-application flow that Issues 1-3 concerned.)
    Design rationale (locked 2026-05-19): the operational gap Issue 3
    was tracking is closed by the synthetic-payment route. The
    reference_number = 'LOYALTY-{redemption_id}' link on the synthetic
    payment row provides the redemption ↔ payment audit trail.
    loyalty_lot_consumption table-level FIFO/lot tracking is NOT
    required given (a) the summary-only migration scope already
    established lot-level history isn't preserved, and (b) the loyalty
    business rules revoke at account level (forfeited / final_forfeited
    / cancelled), not at lot level. The loyalty_lot_consumption table
    remains in the schema but is deliberately unused — not a gap.
    Further clarification (2026-05-19 evening): the synthetic-payment route
    applies ONLY to new_order_discount redemptions. shipping_fee and
    service_fee are strictly points-only — they bypass the synthetic payment
    chain entirely. loyalty_lot_consumption table remains deliberately unused
    across all four redemption types.
    [Original finding below.]
    Schema designed with full lifecycle support:
      - id uuid PK
      - redemption_id uuid NOT NULL (FK to loyalty_redemptions)
      - lot_id uuid NOT NULL (FK to loyalty_point_lots)
      - amount integer NOT NULL
      - consumed_at timestamptz NOT NULL DEFAULT now()
      - restored_at timestamptz (for void path)
      - restored_amount integer (for void path)
    But process-loyalty-redemption approve branch never INSERTs
    into this table. Points are decremented only from the aggregate
    loyalty_members.remaining_points. Future revoke/refund flows
    cannot determine which specific lot's points were consumed.

  Issue 4 — Layaway portal redemption broken: ✅ FIXED 2026-05-18 (Phase 12)
    Symptom (resolved): customer attempting to redeem points from
    the loyalty portal received HTTP 401 from
    process-loyalty-redemption. Empirically confirmed via
    2026-05-18 10:51:04 UTC log (POST returned 401 in 254ms after
    CORS preflight succeeded).
    Root cause: src/components/loyalty/RedemptionForm.tsx defined
    `portalToken: string` in its RedemptionFormProps interface
    (line 64) but the function destructure (lines 68-72) omitted
    it. portalToken was therefore undefined in the function body,
    so the request to process-loyalty-redemption contained no
    portal_token, and resolvePortalAuth threw → 401.
    The 3 other loyalty portal components (RewardsScreen,
    NotificationsScreen, LoyaltyJoinPrompt) already followed the
    correct pattern.
    Fix: 2-line addition to RedemptionForm.tsx — added portalToken
    to function destructure + added portal_token: portalToken to
    request body. Frontend-only change.
    As of Phase B Patch 2 (2026-05-18, commit 8130ace) the redemption
    flow is end-to-end functional for both cash and layaway. See
    ### Recent Updates footer for the full evening's work.

  Empirical state (2026-05-18)
    Only 1 confirmed redemption in production:
      Brendalyn Tuliao (member)
      redemption_id: 34714ffc-d322-4d5f-bb3f-2d0be1a3d918
      type: new_order_discount
      points: 500, value: ¥500
      account_id: NULL, cash_order_id: NULL
      invoice: "#INV Test"
      processed: 2026-05-18 08:35:52 UTC
    The redemption flow has barely been exercised in production —
    customer impact of this wiring gap is currently zero, but
    becomes material the moment real customers start redeeming.

  Suggested fix scope (fresh-session work, est. 15-25 hrs)
    1. Design decision: where to apply discount
       - At order creation (modify create-cash-order, create-layaway-account)
       - At first payment (modify record-payment / record-multi-payment)
       - As virtual payment (insert into payments table on approve)
       - Manual workflow (staff applies discount, document SOP)
    2. Wire loyalty_lot_consumption with FIFO logic
       (ORDER BY expires_at NULLS LAST, earned_at ASC)
    3. Wire restore-on-void for both consumption and discount
    4. Add reconciliation invariant:
       SUM(loyalty_lot_consumption.amount WHERE restored_at IS NULL)
       per member ≤ member.total_points_redeemed
    5. Tighten create validation: require account_id OR cash_order_id
       OR explicit catalog_reward (no detached free-text invoice)
    6. Fix layaway portal redemption UI (Issue 4)
    7. Test thoroughly with TEST-001 / TEST-002 / TEST-003

  Status update 2026-05-18 evening: Issues 1+2+3 RESOLVED & VERIFIED
  (see STATUS block at the top of this section). The redemption flow
  approve path now applies the discount end-to-end on both cash and
  layaway. Remaining caveats are the KNOWN LIMITATIONS below — the
  flow is usable for approvals; voids of confirmed LAYAWAY redemptions
  are not yet safe (D1).

  KNOWN LIMITATIONS / DEFERRED (filed 2026-05-18):

  D1 — VOID branch inline reversal.
    MARK COMPLETED 2026-05-19 via commit f6e411e — Phase B Patch 3
    (VOID branch) ships inline reversal mirroring Patch 2's allocation
    chain on the cancel/void path. Voiding confirmed layaway loyalty
    redemptions is now safe in production. The chain: find synthetic
    payment by reference_number=LOYALTY-{redemption_id}, UPDATE
    voided_at, recompute schedule.paid_amount + account.total_paid via
    inline writes.

  D2 — No atomic rollback on synthetic payment INSERT failure.
    Phase B Patch 1's hard-fail 500 surfaces the error but leaves the
    redemption status='confirmed' and the member already debited (no
    payment row / no allocation). Full atomicity requires a Postgres
    RPC wrapping the four writes (loyalty_transactions INSERT,
    loyalty_members balance UPDATE, redemption status UPDATE, payments
    INSERT) in one transaction. Deferred as a future phase.

  D3 — GAS sync impact of loyalty_transactions DELETE unverified.
    Tonight's orphan cleanup DELETEd two 'redeemed' transaction rows.
    The Google Sheet backup sync (loyalty rules locked 2026-04-25) may
    not handle row deletes. Future cleanups should INSERT compensating
    'adjusted' rows instead of DELETE, for full audit trail and
    reliable sheet sync.

  Legacy note: the 1 original test redemption (Brendalyn) can be
  voided via the existing void action to restore its 500 pts whenever
  cleanup is needed — harmless test data otherwise (cash-side void is
  safe per D1).

### BUG INVESTIGATIONS — DEFERRED
  6. Schedule rows disappearing bug — 3
     accounts affected today (17636, 18454,
     18088). Months deleted without audit
     log entries. Possible causes:
     - delete-installment edge function
       called incorrectly
     - reconcile-account auto-deleting rows
     - UI bug allowing deletion bypass
     - schedule_audit_log trigger not
       firing on DELETE
     - Direct SQL bypass
     STATUS — Bug #6 — Silent schedule deletion via FK cascade:
     RESOLVED 2026-05-17
       Stage 1 (Bug #112, AFTER DELETE forensic logger): shipped
         Function: log_schedule_deletion + log_schedule_deletion_trigger
         Captures every layaway_schedule delete to schedule_audit_log
         with action='forensic_delete' and full row JSON for forensic
         recovery.
       Stage 2 (BEFORE DELETE hard blocker): shipped
         Function: prevent_schedule_deletion +
         prevent_schedule_deletion_trigger
         Blocks any DELETE FROM layaway_schedule unless txn-scoped GUC
         app.allow_schedule_delete='on' is set.
         Legitimate bypass sites: delete_account_atomic RPC,
         delete_schedule_row_atomic RPC.
       Bug #39 mitigation: shipped
         Empirical smoke test on TEST-004 (2026-05-17 15:35 UTC) proved
         the supabase-js set_config(is_local: true) + .delete()
         2-HTTP-call pattern fails — GUC does not persist across
         separate HTTP requests. Evidence: 2 delete_installment audit
         entries created, 0 forensic_delete entries fired, row not
         deleted, UI silently reported success.
         Replaced with delete_schedule_row_atomic SECURITY DEFINER RPC
         (single transaction: GUC + audit + DELETE atomic).
         Validation: TEST-004 smoke test 15:50 UTC — both
         delete_installment AND forensic_delete rows present with
         identical timestamps and matching schedule_id, confirming
         DELETE executed and Stage 1 logger fired inside the same
         transaction.
  7. RESOLVED 2026-05-17 — Empirical investigation found the
     original hypothesis was incorrect. reconcile-account has
     been report-only since Bug #34 fix (2026-04-20) and never
     wrote to penalty_fees.

     Diagnostic SQL across all accounts found 46 candidate rows
     (penalty.status='paid' exceeding penalty-type allocations)
     but ZERO real corruption:
     - 38 rows: pure allocation_type categorization noise —
       customer paid penalty bundled with base, allocation
       recorded as 'installment' type instead of split into
       'penalty' + 'installment'. Cash totals and customer-
       facing math correct.
     - 8 rows: partial-payment context (live + closed accounts)
       where penalty-first waterfall fully covered penalties,
       with remaining cash partial against base. Same
       categorization signature; math correct.

     Verified accounts: 17062, 17241, 17374, 17451, 17832
     (all completed, total_paid >= total_amount); 18531
     (overdue, partial payment in progress, math correct).

     Current penalty writers all have correct paid_amount-vs-
     penalty guards: record-payment, record-multi-payment,
     review-payment-submission, edit-payment-amount,
     restore-payment.

     No code fix required. No data repair required.

     FOLLOW-UP TRACKING (low priority): allocation_type
     categorization sometimes records penalty cash as
     'installment' type when penalty is added shortly
     before/during a payment cycle. Internal accounting noise
     only — does not affect customer-facing math or balance.
     Worth investigating if revenue split reports between base
     and penalty become important.
  8. review-payment-submission returned 500
     error on cash order #10000 confirmation.
     Cause unknown — error log not captured.
     Order status flipped to completed despite
     crash, but award call never fired.
     MOOT — Layer-2 award triggers were DROPPED via migration
     20260516000000 (per SYSTEM STATUS / LOYALTY AWARD SYSTEM).
     Safety net no longer exists. Phase 9 (2026-05-18) concluded
     P6/Bug #8 is no longer applicable.

### BUG #99 EMPIRICAL VERIFICATION — CLOSED 2026-05-18
  Status: All 4 auto-forfeit-settlement hook points + manual-forfeit
  verified via Phase 5 closure on 3-layer evidence stack.

  Evidence layers:
    1. Source code review (auto-forfeit-settlement/index.ts on main
       commit 6c1f665): fireLoyaltyRevoke wired at line 359 (PATH 1),
       line 463 (PATH 2), line 224 (extension expiry), line 284
       (extension cap).
    2. Audit_log empirical: trigger logic fires correctly across all
       4 hooks (PATH 1: 3 unique accounts including CJ-2026-FORFEIT-P1
       and CJ-2026-PATH1-TEST; PATH 2: ~55 entries across real
       production accounts 15xxx, 16xxx, 17xxx, both PHP and JPY;
       extension expiry: 4 test fixtures; extension cap: 1 test
       fixture, CJ-2026-FORFEIT-P2).
    3. Revoke function proven via manual-forfeit (TEST-008_ELITE
       2026-05-14 01:53:12 — audit + revoke transaction 3-second
       pairing intact, points_amount=60000, spend_amount_jpy=3000000,
       tier_at_time='Elite') and void-payment paths.

  Observation gap acknowledged: end-to-end production observation
  (audit_log + paired revoke transaction within 5 minutes) is
  unavailable for all 4 auto-forfeit hooks due to:
    (a) Pre-2026-05-13 forfeitures predate Bug #99 revoke wiring (no
        revoke calls existed in code at that time)
    (b) Post-2026-05-13 JPY auto-forfeits are exclusively test
        fixtures whose loyalty-side data was subsequently wiped (same
        pattern documented in Phase 4 close-out forensic note for
        CJ-2026-FORFEIT-PATH3-NEW)
    (c) No non-fixture JPY auto-forfeits occurred after Bug #99
        wiring shipped, so no preserved production cases exist for
        an empirical 4th evidence layer

  PATH 3 (6th penalty → final_settlement) is excluded from revoke by
  Bug #101 fix (2026-05-14, Phase 4 close-out 2026-05-18). PATH 3
  preserves loyalty intentionally per business rule.

  Manual-forfeit verification: COMPLETE end-to-end empirically on
  TEST-008_ELITE (audit + revoke transaction 3-second pairing intact).

  See FORFEITURE STANDARD section for live spec; see LOYALTY LIFECYCLE
  INTEGRATION section for full revoke wiring map (4 auto-forfeit hooks
  + manual-forfeit + void paths).

  Bug #99: COMPLETE. No remaining items. Historical loyalty data
  carried into the lot-based system via the 2026-05-15→16
  summary-only migration (cumulative_spend_jpy + consolidated lot
  per member). Per-order purchase/redemption history NOT migrated
  — by design. See LOYALTY DATA & MIGRATION for migration scope
  and lot reconciliation rule.

### TODAY'S DATA FIXES (completed)
  - 17636: Month 4 penalties reset from
    'paid' to 'unpaid' (data corruption
    from reconcile-account)
  - 18454: Month 5 restored (₱4,086
    PHP, due 2026-07-11)
  - 18088: Month 6 restored manually +
    total_amount corrected from ₱52,118
    to ₱67,980

### TODAY'S DATA FIXES (2026-04-27)
  - Manually awarded 100 points to Test
    Customer for cash order #10000 (failed
    auto-award due to review-payment-submission
    500 error)
  - Built a DB-trigger safety net for loyalty
    award on completion (SUPERSEDED — the
    Layer-2 trigger path was DROPPED 2026-05-16
    via migration
    20260516000000_drop_layer2_loyalty_triggers.sql;
    review-payment-submission is now the sole
    award path. See LOYALTY SYSTEM RULES.)
  - Cash order #10001 created and completed
    successfully

### TODAY'S DATA FIXES (2026-04-29)
  - Seeded view_loyalty_redemptions in
    role_permissions via SQL Editor
    (admin/finance/staff = true, csr = false).
    Closes the page-access gap surfaced as
    Known Fixed Bug #63.
  - Seeded 11 system_settings keys for
    Phase 2: 8 email toggles
    (loyalty_email_*) defaulted true to
    preserve current send behavior; 3 sheet
    sync keys (loyalty_sheet_id,
    loyalty_sheet_service_account,
    loyalty_sheet_sync_frequency) defaulted
    to empty / "manual".
  - Sentinel UUID
    00000000-0000-0000-0000-0000000000a1
    used as audit_logs.entity_id for every
    entity_type='loyalty_settings' row,
    since audit_logs.entity_id is UUID NOT
    NULL and system_settings has no per-row
    UUID. Documented in
    src/hooks/loyalty-admin/useLoyaltySettings.ts
    as LOYALTY_SETTINGS_AUDIT_ID.
  - Phase 2.5 email gate plumbing — wired
    8 system_settings toggles to actual
    send sites across 4 edge functions.
    Email toggles in admin portal Settings
    tab now functional (no longer UI-only).
    Defaults still true so production
    behavior is unchanged until an admin
    flips a toggle off.
  - Phase 3 schema: extended loyalty_promos
    with image_url and display_priority
    columns; created loyalty_rewards (17
    rows seeded matching the prior
    staticFallback.REWARDS catalog) and
    loyalty_banners (4 rows seeded — 1
    featured matching the old hardcoded
    "Spring 2026 Gold Collection" hero, 3
    promo matching the old PromoBanners
    array: birthday / layaway / tier-up).
  - RLS policies seeded for both new
    tables: admin/finance full CRUD,
    staff read, authenticated customer
    read where is_active = true.

### TODAY'S DATA FIXES (2026-04-30)

  Manual SQL UPDATEs applied via SQL Editor (no edge function
  involvement, no commit traces in repo):

  - TEST-004 audit drift healing
    Layaway schedule row 3 status flipped from 'overdue' to
    'partially_paid'. total_due_amount preserved at 4,000
    (full-owed = base 3,500 + penalty 500).
    layaway_accounts.remaining_balance updated to canonical
    2,500. All 12 audit checks now pass.
    Investigation took 5+ wrong attempts before reading
    penalty_fees revealed the 500 PHP week-1 cycle 1 unpaid
    penalty as the canonical truth driver. Logged as bug #70.

  - INV #18852 plan flip
    payment_plan_months changed 6 → 8 via single targeted SQL
    UPDATE. Schedule rebuild handled separately by Cynthia.
    Plan distribution: 3M=16, 6M=657, 8M=2, 10M=0, 12M=0 = 675.

### TODAY'S DATA FIXES (2026-05-01)

  Schema changes and RLS policies applied via SQL Editor in
  support of Phase 3.2 (Catalog Redemption Wiring):

  - loyalty_redemptions schema additions
    Added reward_id uuid column with FK to
    loyalty_rewards(id) ON DELETE SET NULL, plus
    idx_loyalty_redemptions_reward_id index. Extended the
    loyalty_redemption_type enum with 'catalog_reward' as a
    4th value (used when a redemption is tied to a specific
    loyalty_rewards row rather than one of the 3 legacy
    self-describing types).

  - Anon SELECT policies on loyalty_rewards and loyalty_banners
    Customer portal uses token-based auth (anonymous role to
    Supabase). Phase 3 RLS shipped TO authenticated only,
    which blocked customers from reading the catalog and
    banners once the portal was switched to DB-driven content.
    Added: "Anon can read active rewards" ON loyalty_rewards
    FOR SELECT TO anon USING (is_active = true) and the
    parallel "Anon can read active banners" policy on
    loyalty_banners. No code change — RLS only.

  - Phase 3.1 schema: ALTER TABLE loyalty_promos ADD COLUMN
    bonus_multiplier numeric(5,2) NOT NULL DEFAULT 1.00
    CHECK (bonus_multiplier >= 1.00). Existing rows backfilled
    to 1.00 (neutral, no behavior change for promos already
    running). COMMENT ON COLUMN documents the stack semantics:
    total_mult = tier_mult × bonus_multiplier; flat
    bonus_points still adds on top.

### TODAY'S DATA FIXES (2026-05-03)

  Storage bucket and RLS policies applied via SQL Editor in
  support of Phase 3.5 (Image Upload to Storage):

  - Created loyalty-images storage bucket
    INSERT INTO storage.buckets with public=true,
    file_size_limit=5242880 (5 MB), and allowed_mime_types
    ARRAY['image/jpeg','image/png','image/webp']. Public flag
    matches the promotions bucket precedent so the customer
    loyalty portal can read directly via anon role; mime
    whitelist + size limit enforce the upload contract at
    storage layer (defense-in-depth alongside client-side
    validation in ImageUploadField).

  - 4 RLS policies on storage.objects scoped to bucket_id =
    'loyalty-images':
      "Public read loyalty images" — SELECT to anon +
        authenticated. Required for customer portal
        rendering (token-based, anonymous to Supabase).
      "Admin and finance upload loyalty images" — INSERT
        WITH CHECK (admin OR finance). Tighter than the
        promotions bucket (admin+staff) by design.
      "Admin and finance update loyalty images" — UPDATE
        with the same role check. Needed because Supabase
        upsert mode hits the UPDATE path on overwrite.
      "Admin and finance delete loyalty images" — DELETE
        with the same role check. Required by the
        ImageUploadField fire-and-forget cleanup on
        Replace / Remove.

### TODAY'S DATA FIXES (2026-05-04)

  Schema, indexes, RLS, system_settings, and pg_cron job applied
  via SQL Editor in support of Phase 4 (Communications/Notifications):

  - Phase 4 schema: created two tables.
      loyalty_notifications — master, 17 columns, with CHECK
        constraints on title (1-100), body (1-500), category
        (6-value whitelist), audience_type (3-value whitelist),
        and status (initially 4-value, widened to 6 — see
        next bullet). updated_at trigger via the canonical
        public.update_updated_at_column().
      loyalty_notification_recipients — per-member delivery +
        read state, 6 columns, UNIQUE (notification_id,
        member_id), CASCADE on both FKs (master + member).
      4 indexes: 2 on recipients (member_id+created_at DESC,
        partial member_id WHERE is_read=false), 2 on master
        (partial status='scheduled', status+created_at DESC).
      3 RLS policies: admin/finance read on both tables;
        admin/finance manage on master. No client write
        policies on recipients — service_role only via the
        edge functions.

  - Phase 4 status CHECK widened from 4 to 6 values:
    DROP + ADD CHECK (status IN ('draft', 'scheduled',
    'sending', 'sent', 'cancelled', 'failed')). The new
    'sending' state is set by the queue processor's atomic
    lock to prevent overlapping ticks from double-sending;
    'failed' is the terminal state when fan-out errors out.
    Existing rows in draft / scheduled / sent / cancelled
    remain valid, no backfill needed.

  - system_settings.loyalty_email_broadcast seeded as
    to_jsonb(true) with a description column documenting it
    as the global gate for the per-notification email
    side-fire from send-loyalty-notification. Admin can flip
    via the Settings tab to globally suppress notification
    emails (e.g., during email provider incident).

  - pg_cron job 'loyalty-notification-queue' scheduled at
    '0 * * * *' (top of every hour UTC, jobid=19). Calls
    process-loyalty-notification-queue with the service_role
    JWT in the Authorization header. The JWT is fetched from
    Supabase Vault inside the cron command body rather than
    hardcoded in the schedule, so rotating the service_role
    key does not require a cron re-schedule.

  - Phase 4 polish: Modal opacity + click-trapping bug fixed.
    NotificationComposeDialog originally rendered an AlertDialog
    inside the open Dialog for the send/schedule confirmation
    step. Two shadcn portal overlays stacked at z-50 caused
    a near-opaque backdrop (bg-black/80 layered twice) AND
    trapped the Confirm button click at the upper portal so
    the handler never fired. Refactored to a single Dialog
    with a two-view pattern: showConfirm boolean state
    toggles between form view and confirmation summary
    panel inside the same DialogContent. Footer buttons
    swap with the view. Error path stays on confirm view
    so admin can retry without re-filling the form. Both
    issues resolved by removing the second portal entirely.

  - Phase 4 polish: Duplicate action button for sent /
    cancelled / failed notifications.
    NotificationComposeDialog now accepts a `mode` prop
    ('create' | 'edit' | 'duplicate'), backwards-compatible
    (defaults to 'edit' when notification is set,
    'create' otherwise). Duplicate mode pre-fills title /
    body / category / audience_type / audience_tiers /
    send_email; clears scheduled_for / expires_at /
    audience_member_ids; toasts a re-pick warning when
    source had specific-audience. editLocked skipped in
    duplicate mode. Creates new loyalty_notifications row
    on send; original history preserved (terminal-state
    notifications remain immutable). Per-status action
    matrix on the cards: draft → Edit; scheduled → Edit
    + Cancel; sending → View only; sent / cancelled /
    failed → View + Duplicate (gold primary).

  - Bug #81 — Dashboard.tsx:365 TypeScript error from
    PR #80 fixed. PR #80 (47a3e3e, "paginate + lighten
    accounts query") swapped Dashboard's useAccounts()
    for useAccountsLight() to drop the customers embed
    for the mobile Chrome OOM fix on /customers. The
    lightened 12-column shape no longer satisfied
    GeoBreakdown's prop type of AccountWithCustomer[],
    even though GeoBreakdown only reads 4 scalar fields
    (status, customer_id, currency, remaining_balance)
    and never accesses account.customers.* at runtime.
    Vite/esbuild stripped types and shipped JS anyway —
    Dashboard's Regional Overview rendered correctly in
    production; the error was compile-time noise about
    an over-specified prop type. Fix: introduced a fresh
    local GeoAccount interface in GeoBreakdown.tsx (4
    fields, primitive types, no Pick<> coupling) and
    dropped the AccountWithCustomer import. Both
    useAccounts() and useAccountsLight() satisfy the
    contract because both are supersets. PR #80's mobile
    perf optimization is preserved. GeoBreakdown is
    imported by exactly one file (Dashboard.tsx, verified
    by grep) so no other call sites are affected.

  - Bug #82 — HomeHeader staticFallback leak fixed.
    HomeHeader.tsx still imported NOTIFICATIONS from
    staticFallback even after Phase 4 C8 wired
    NotificationsScreen.tsx to real DB data. The fixture
    array contained 4 unread items, hard-pegging the
    home-tab bell badge to "4" and surfacing a fake
    "Happy Birthday Month, Cynthia! 🎂💛" preview card
    visible to every member. Surfaced during end-to-end
    Phase 4 verification: bell showed "4", bottom-nav
    showed no badge, NotificationsScreen filter showed
    "Unread (0)" — three counters disagreeing because
    only HomeHeader was on stale fixtures. Fix: drop
    the staticFallback import from HomeHeader.tsx; add
    unreadCount + latestUnread props; pass-through via
    LoyaltyPortal → HomeScreen → HomeHeader. latestUnread
    computed inline in LoyaltyPortal as the first
    !is_read item from data.notifications, projected to
    { title, body }. Preview card hidden when
    unreadCount === 0 (no fake birthday banner for
    caught-up members). Removed the
    "TODO: wire to live notifications source — Phase 7"
    comment that flagged the issue but never got
    addressed. Bell badge now matches bottom-nav (both
    read from data.unread_count) and screen filter
    (reads same data via prop), single source of truth.

  - Bug #83 — mark-loyalty-notification-read stale
    auto-deploy. Function code (CORS handler at top
    of Deno.serve, per-response corsHeaders) and
    workflow flag (--no-verify-jwt deploy step,
    correct path filter) were both correct from C3
    (commit a1dcca6). Browser nevertheless saw
    "Failed to send a request to the Edge Function"
    on click-to-read AND mark-all-read. Same class
    as the send-loyalty-notification CORS bug from
    earlier today: GitHub Actions reported green but
    Supabase served stale function code with
    verify_jwt: true, blocking OPTIONS preflight at
    the gateway before the function's own handler
    ran. Fix was operational: manual Cloud Shell
    redeploy with --no-verify-jwt:
      npx supabase functions deploy mark-loyalty-notification-read \
        --no-verify-jwt --project-ref pfoicalpzdcmyxzvwyhz
    Reinforces the AUTO-DEPLOY RULES "STALE EDGE
    FUNCTION DEPLOYS" section: for any browser-callable
    edge function reporting CORS or invocation failure,
    manual Cloud Shell redeploy is the fastest fix —
    don't trust the green CI badge alone.

### TODAY'S DATA FIXES (2026-05-07)

  - Phase 4.2 schema: CHECK constraint on
    loyalty_notifications.category widened from 6 → 11 values:
      DROP CONSTRAINT loyalty_notifications_category_check;
      ADD CHECK (category IN (
        'info','promo','tier','system','reward','birthday',  -- Phase 4 admin-pickable
        'points','redemption','order','expiry','milestone'   -- Phase 4.2 auto-trigger
      ));
    Existing Phase 4 rows untouched (all in the original 6).
    Smoke-tested via DO blocks: all 5 new categories accepted,
    invalid value 'unknown_category' still rejected with
    check_violation. 'milestone' included in the CHECK now even
    though emit logic is deferred to Phase 4.2.1 — avoids a second
    migration round-trip when the milestone path lands.

### TODAY'S DATA FIXES (2026-05-08)

  - Phase 3.1.1 schema follow-up: widened loyalty_promos CHECK
    constraint so multiplier-only promos can be created. The
    legacy CHECK only permitted bonus_points > 0 — admins
    creating a "3x Bonus Weekend" with bonus_points=0 and
    bonus_multiplier=3 hit a check_violation at INSERT time:
      ALTER TABLE public.loyalty_promos
        DROP CONSTRAINT loyalty_promos_bonus_points_check;
      ALTER TABLE public.loyalty_promos
        ADD CONSTRAINT loyalty_promos_bonus_value_check
          CHECK (bonus_points > 0 OR bonus_multiplier > 1.00);
      ALTER TABLE public.loyalty_promos
        ALTER COLUMN bonus_points SET DEFAULT 0;
    The new constraint accepts:
      * Flat-bonus promos      (bonus_points > 0, multiplier=1)
      * Multiplier-only promos (bonus_points=0, multiplier>1)  ← NEW
      * Combo promos           (bonus_points>0 AND multiplier>1)
    Rejects:
      * No-op promos           (bonus_points=0 AND multiplier=1)
    Existing rows are unaffected — Phase 3.1 backfilled
    bonus_multiplier=1.00 on every row, and every legacy promo
    still has bonus_points > 0, so they all satisfy the new OR
    check.
    bonus_points DEFAULT changed from required to 0 so admin can
    omit the field when creating a multiplier-only promo (the
    PromoEditDialog already passes 0 by default; the DEFAULT
    aligns the DB-level contract with the UI).

  - Phase 3.5.1 schema: seeded
    system_settings.cleanup_loyalty_images_dry_run = true via
      INSERT INTO public.system_settings (key, value, description)
      VALUES (
        'cleanup_loyalty_images_dry_run',
        to_jsonb(true),
        'Phase 3.5.1 — when true, cleanup-loyalty-images logs orphans but does not delete.'
      );
    Default dry-run prevents accidental mass-delete on the first
    weekly tick. Manual flip to false after the first 1-2 runs
    are reviewed via the audit_logs entries.

  - Phase 3.5.1 cron: scheduled jobid 20 cleanup-loyalty-images
    at '0 3 * * 0' (Sunday 03:00 UTC = Sunday 11:00 AM PHT)
    using email_queue_service_role_key from vault. Schedule
    statement followed the loyalty-notification-queue precedent
    (jobid 19) — vault.decrypted_secrets lookup in the command
    body so rotating the service_role JWT does not require a
    cron re-schedule.

  - Bug fix (LATENT) — 3 broken crons repointed. jobids 16/17/19
    (loyalty-inactivity-check, auto-expire-cash-orders,
    loyalty-notification-queue) referenced 'service_role_key' in
    vault, but only 'email_queue_service_role_key' exists. They
    were sending empty Bearer tokens and only succeeding because
    target functions deploy with --no-verify-jwt. All 3 crons
    repointed via cron.alter_job + regexp_replace surgical swap
    — minimal diff, idempotent (re-running matches nothing). Now
    sending real service_role JWT, removing the silent auth
    bypass risk if any of those target functions are ever
    redeployed without the --no-verify-jwt flag.

  - Clarification — GitHub Actions Supabase auto-deploy
    workflow is non-functional (missing repo secrets
    SUPABASE_PROJECT_REF + SUPABASE_ACCESS_TOKEN).
    Discovered via workflow_dispatch test of commit
    44e62a3 (path-filter fix). Edge function deploys are
    handled by Lovable inside their environment via direct
    Supabase tooling access. Cloud Shell manual deploys
    are Cynthia-side interventions when needed. Path-filter
    fix remains valid preventive infrastructure for if/when
    GitHub Actions auto-deploy gets enabled.

  - Phase 3.2.1 schema: added 'refunded' value to
    loyalty_transaction_type enum via
      ALTER TYPE public.loyalty_transaction_type
        ADD VALUE 'refunded';
    Used by process-loyalty-redemption void branch when
    inserting the refund loyalty_transactions row
    (positive points_amount; mirrors the approve-branch
    -N debit row). Existing enum values
    ('earned', 'bonus', 'redeemed', 'expired',
    'tier_downgrade') unaffected.

  - Phase 3.2.1 cleanup: orphan test redemption
    REDEEM-ce0a4c5a-9a22-4d7a-95cd-9c6a6593b324 voided
    via the new admin "Void Redemption" button as part
    of the smoke test sequence. Status flipped to
    cancelled, points refunded, audit row written.
    No production fixture remains.

### TODAY'S DATA FIXES (2026-05-20 / 2026-05-21)

  Account schedule/allocation repairs. All four accounts pass
  audit_account all_pass post-repair.

  - INV #18113: legacy overpayment-waterfall artifact. The old
    lumping waterfall (replaced by the row-by-row atomic waterfall
    in commit 9069ffd, 2026-04-23) had left surplus mis-stored.
    Surplus re-split into durable payment_allocations. Census
    confirmed no remaining affected population.

  - INV #18336: payment cd26d53c was over-allocated to installment 1
    (11,230 vs 10,000 base). Allocation capped to the base.

  - INV #18445: total_amount / carry tangle — installment 4 base
    corrupt, installment 2 overpaid, installment 3 carried a
    waived-penalty allocation, plus a bogus 931 carry. Reconstructed
    via allocation re-homing + base restore. Remaining unchanged at
    29,207.

  - INV #18693: carry-drop victim of Bug #117. total_due_amount
    restored to 10,513.58 (base 9,208 + penalty 500 + carried
    805.58) after the redeploy that made the carry-preservation fix
    live. Durable.

### OPERATIONAL ENHANCEMENTS
  P6: Admin audit log for manual DB changes

### CI/DEPLOYMENT INFRASTRUCTURE
  ⏳ GitHub Actions Supabase auto-deploy
     enablement (BLOCKED on Lovable)

     Currently Lovable handles all edge
     function deploys directly. If GitHub
     Actions auto-deploy is desired as a
     backup mechanism or for Cynthia-side
     commits, two GitHub repo secrets need
     to be added:
       - SUPABASE_PROJECT_REF
         (value: pfoicalpzdcmyxzvwyhz)
       - SUPABASE_ACCESS_TOKEN
         (Personal access token from
         Supabase Dashboard → Account →
         Access Tokens; requires Lovable
         to generate)

     Once added, the workflow file and
     path-filter fix (commit 44e62a3)
     become active infrastructure.

     No urgency — current Lovable
     deployment model works.

### CLEANUP TODOS

  Tracked cleanup items, distinct from
  "TODAY'S DATA FIXES" (which logs
  completed corrective work) and from
  proper PENDING phases. Items here are
  reference-only — usually the work was
  done as a side effect of something
  else and is tracked here so the
  history doesn't get lost.

  - Orphan test redemption REDEEM-ce0a4c5a-9a22-4d7a-95cd-9c6a6593b324
    voided 2026-05-08 as part of Phase
    3.2.1 smoke test sequence. Status
    flipped to cancelled, points
    refunded, audit row written. No
    production fixture remains.
    (Tracking entry only — already
    cleaned up.)

### LOYALTY ADMIN PORTAL — phased build
  ✅ Phase 1 — Foundation (LIVE 2026-04-29)
  ✅ Phase 2 — Configuration (LIVE 2026-04-29)
  ✅ Phase 2.5 — Email gate plumbing
     (LIVE 2026-04-29)
  ✅ Phase 3 — Content Management
     (LIVE 2026-04-29)
  ✅ Phase 3.1 — Bonus Multiplier Wiring
     (LIVE 2026-05-01)
     bonus_multiplier numeric(5,2) on
     loyalty_promos. Strategy B —
     multiplicative stack with tier
     multiplier; flat bonus_points still
     adds on top. Edge function awards
     bonus tx with delta + flat;
     PromoEditDialog gains side-by-side
     inputs; PromotionsTab shows "{N}x
     Bonus" badge. See SYSTEM STATUS
     entry above.
  ✅ Phase 3.2 — Catalog Redemption Wiring
     (LIVE 2026-05-01)
     reward_id FK + 'catalog_reward' enum
     value + atomic stock decrement on
     approve + RewardsScreen real flow +
     anon RLS policies. See SYSTEM STATUS
     entry above.
  ✅ Phase 3.2.1 — Cancel/Void Approved Redemption
     (LIVE 2026-05-08).
     See SYSTEM STATUS entry above.
  ✅ Phase 3.5 — Image Upload to Storage
     (LIVE 2026-05-03)
     loyalty-images public bucket (5 MB
     cap, jpeg/png/webp whitelist) with
     4 RLS policies. New shared
     ImageUploadField component (click +
     drag/drop, 80×80 thumbnail, replace/
     remove, fire-and-forget delete on
     replace) wired into PromoEditDialog,
     RewardEditDialog, BannerEditDialog.
     See SYSTEM STATUS entry above.
  ✅ Phase 3.5.1 — Orphan Image Cleanup
     (LIVE 2026-05-07).
     See SYSTEM STATUS entry above.

  Phase 3 series complete — full content
  management end-to-end.
  ✅ Phase 4 — Communications/Notifications
     (LIVE 2026-05-04)
     Manual admin broadcast notifications to
     loyalty members — 6 categories, 3
     audience modes, schedule for future
     send via hourly cron, optional per-row
     email side-fire gated by global toggle,
     per-recipient read state, mark-as-read
     and mark-all-read endpoints.
     2 new tables (loyalty_notifications +
     loyalty_notification_recipients), 4
     edge functions (send / mark-read /
     queue-processor + customer-portal
     extension), 1 email template
     (loyalty-broadcast), 1 cron job
     (jobid=19, hourly), 1 admin tab
     (NotificationsTab as 11th tab in
     LoyaltyAdmin), full customer-portal
     integration (NotificationsScreen
     replaces staticFallback). See SYSTEM
     STATUS entry above.
  ⏳ Phase 4.1 — Notification templates
     Saved reusable templates for common
     broadcasts (e.g. "Tier Upgrade Welcome",
     "Promo Reminder"). Adds a
     loyalty_notification_templates table +
     CRUD UI + a Templates picker on the
     compose dialog ("Load template" button
     above the title field). Roughly half-day
     of work; deferred until admin demand
     justifies it (admins can copy/paste from
     a Notes app for now).
  ✅ Phase 4.2 — Auto-trigger Notifications
     (LIVE 2026-05-07)
     Instrumented 3 existing loyalty edge
     functions (award-loyalty-points,
     process-loyalty-redemption,
     loyalty-inactivity-check) to emit
     in-portal notifications on key member
     events. Direct DB INSERT pattern via
     two new shared helpers
     (loyalty-notification-templates +
     emit-notification). send_email=false
     on all auto-triggers — existing
     transactional emails cover the email
     channel; doubling up would
     double-email customers. CHECK
     constraint widened from 6 to 11
     categories. Scope reduced from spec's
     4 functions to 3
     (review-payment-submission delegates
     to award-loyalty-points; single
     source of truth). See SYSTEM STATUS
     entry above.
  ⏳ Phase 4.2.1 — Milestone notification
     emission
     CHECK constraint already accepts the
     'milestone' category; Phase 4.2
     widened it schema-only. Need emission
     logic on lifetime spend thresholds
     (e.g., the existing tier boundaries
     ¥1M / ¥4M / ¥8M, plus anniversary
     milestones like ¥10M / ¥20M
     cumulative_spend_jpy). Likely
     instrument award-loyalty-points to
     detect threshold crossings —
     newCumulative > threshold AND
     prev cumulative_spend_jpy <
     threshold = first crossing. Emit
     once per crossing, not per award
     above the threshold. Template
     builder needs adding to
     loyalty-notification-templates.ts
     (e.g., buildMilestoneNotification({
     thresholdJpy, totalSpentJpy })).
  ⏳ Phase 4.3 — Notification preferences
     Per-member opt-out for admin broadcasts
     by category. Adds
     loyalty_notification_preferences table
     (member_id, category, enabled) + a
     Preferences screen on the customer
     portal + a check at fan-out time in
     send-loyalty-notification and
     process-loyalty-notification-queue.
     Defer unless regulatory pressure
     emerges (e.g., GDPR-style explicit
     opt-out requirement) or admin-spam
     pressure shows up in customer
     complaints.
  ⏳ Phase 5 — Tier Benefits Schema
     Expansion (FUTURE ROADMAP)
     Currently the loyalty_tiers schema
     models only 3 benefit columns:
     points_multiplier,
     free_shipping_min_items,
     mystery_gift. Customer portal
     TIER_STATIC in
     src/components/loyalty/loyaltyData.ts
     references richer benefits not in
     schema:
       - "min ¥8,000/item" (purchase
         value floor)
       - "2% discount per ¥50,000 order"
         (Radiant + Elite)
       - "3% discount per ¥50,000 order"
         (Crown VIP)
       - "Mystery gift with every
         shipment" (Crown VIP) — differs
         from current DB "Mystery gift on
         tier-up" label
     These are display-only static
     copy. Admin cannot edit them via
     TierEditDialog. To make them
     editable would require:
       1. Schema additions to
          loyalty_tiers:
            - discount_percent numeric
            - discount_threshold_jpy int
            - min_item_value_jpy int
            - mystery_gift_cadence text
              (replaces boolean:
              'tier_up', 'every_order',
              'monthly', NULL)
            - Optional: extra_benefits
              jsonb for future
              extensibility
       2. Migration to seed existing
          tiers with TIER_STATIC values
       3. TierEditDialog form expansion
          (~4 new fields)
       4. TiersTab dynamic benefit
          rendering (loop over benefit
          columns instead of 3 hardcoded
          spans)
       5. Customer portal — replace
          TIER_STATIC with DB-sourced
          tier benefits
     SEPARATE FROM display expansion:
     ENFORCEMENT is its own project.
     Currently free_shipping is
     display-only (no edge function
     enforces it). Future enforcement
     work would touch:
       - record-payment /
         record-multi-payment (apply
         discount to grand total)
       - cash-order pricing logic
     Estimated effort: ~5 hours
     display-side expansion.
     Enforcement deferred to its own
     scope.
     Trigger: When admin requests
     ability to edit benefits beyond
     the 3 currently supported, OR
     when business rules change such
     that hardcoded TIER_STATIC values
     drift from reality. Bug #86
     (Radiant data drift) was the
     proximate trigger for logging
     this roadmap item.
  ⏳ Phase 6 — Redemption Model Overhaul
     (DETAILED SPEC, locked
     2026-05-09)

     Spec locked in design session
     2026-05-09. Implementation
     phased gradually after the
     pre-Phase 6 loose-end cleanup
     items below complete.

     PRE-PHASE 6 — LOOSE ENDS
     (~5.5 hrs total):
       - Void email notification
         (~2 hrs) — see PENDING
         entry below
       - Phase 4.2.1 milestone
         emission (~1.5 hrs)
       - P5 admin session timeout
         2hr (~2 hrs)

     ─────────────────────────────
     AREA 1 — BIRTHDAY BONUS
     ─────────────────────────────

     Eligibility:
       - Claim window: anytime
         during customer's birth
         MONTH
       - Frequency: once per
         calendar year
       - New enrollees: immediate
         eligibility
       - Missed window: closes for
         the year (cannot retro-
         claim)
       - Promo visibility: only to
         customers whose birth
         month matches current
         month

     Bonus points (tier-based):
       - Glimmer:    500 pts
       - Radiant:  1,000 pts
       - Elite:    1,500 pts
       - Crown VIP: 2,000 pts

     Expiration rule:
       - Bonus expires LAST DAY of
         month BEFORE next birth
         month
       - Example: May birthday →
         claim May 2026 → expires
         April 30 2027
       - All May-birthday
         customers expire same day

     Expiration notifications:
       - Single warning 1 month
         before expiry
       - In-portal + email

     ─────────────────────────────
     AREA 1B — BIRTHDAY FIELD
     SCHEMA
     ─────────────────────────────

     Capture:
       - Lazy capture only —
         customer enters via
         profile when ready
       - Currently empty for all
         663 customers
       - Customer-set first; admin
         cannot pre-populate

     Lock behavior:
       - Locked immediately after
         customer first save
       - Customer cannot edit
         again
       - Admin/staff can override
         ONCE only (correction
         path)
       - After admin override →
         permanently locked

     Eligibility dependency:
       - No birthday set → no
         Birthday Bonus button
         visible

     Date format:
       - Month + day only (no
         year)
       - birth_month smallint
         1-12
       - birth_day smallint 1-31
       - DB CHECK constraint
         validates valid month/
         day combos

     Schema additions on customers
     table:
       - birth_month smallint NULL
       - birth_day smallint NULL
       - birthday_set_at
         timestamptz NULL
       - birthday_corrected_at
         timestamptz NULL
       - birthday_corrected_by_user_id
         uuid NULL
       - birthday_correction_reason
         text NULL

     Lock state (derivable):
       - IF birthday_corrected_at
         IS NOT NULL → permanently
         locked
       - ELSE IF birthday_set_at
         IS NOT NULL → admin-
         correctable once
       - ELSE → empty, customer-
         settable

     ─────────────────────────────
     AREA 2 — POINTS LOTS
     ARCHITECTURE
     ─────────────────────────────

     New table: loyalty_point_lots

     Columns:
       - id uuid PK
       - member_id uuid FK
       - source_type enum
         ('order_earn',
          'birthday_bonus',
          'promo_bonus',
          'admin_adjust',
          'refund_restoration')
       - source_reference text
       - original_amount numeric
       - remaining_amount numeric
       - earned_at timestamptz
         NOT NULL
       - expires_at timestamptz
         NULL (NULL = no
         expiration)
       - consumed_at timestamptz
         NULL
       - expired_at timestamptz
         NULL
       - notes text NULL

     Expiration rules by source:

       source_type='order_earn':
         - expires_at: 12 months
           from earned_at
           INITIALLY
         - ROLLING extension: any
           customer purchase
           extends ALL active
           lots' expires_at to
           (purchase_date + 12
           months)
         - "Inactivity expiration"
           — customer must
           purchase to keep points
           alive

       source_type='birthday_bonus':
         - expires_at: last day
           of month before next
           birth month
         - DOES NOT roll — fixed
           expiry

       source_type='promo_bonus':
         - expires_at:
           configurable per promo

       source_type='admin_adjust':
         - expires_at:
           configurable

       source_type='refund_restoration':
         - Special — restores
           original consumed lot's
           remaining_amount (no
           new lot)

     Consumption order:
       - FIFO by expires_at ASC
         NULLS LAST (expiring
         soonest first)
       - Within same expires_at:
         FIFO by earned_at

     New table:
     loyalty_lot_consumption

     Columns:
       - id uuid PK
       - redemption_id uuid FK
       - lot_id uuid FK
       - amount numeric
       - consumed_at timestamptz
         NOT NULL
       - restored_at timestamptz
         NULL
       - restored_amount numeric
         NULL

     Refund rule (Q4.4):
       - Void/cancellation
         reversal restores
         consumed lots
       - Lot's remaining_amount
         increases by amount
         drawn
       - Original earned_at AND
         expires_at unchanged

     Order cancellation/forfeiture:
       - When status → cancelled/
         forfeited:
           * Find lots from order
           * Reduce
             remaining_amount
           * Customer keeps
             points already spent
             (no clawback)
           * Audit log entry
       - Cancellation REVERSAL:
         restore lots via Q4.4
         path

     Daily cron: expire-points
       - Schedule: 00:30 UTC
         (08:30 PHT)
       - Find lots: expires_at
         <= today AND expired_at
         IS NULL AND
         remaining_amount > 0
       - Set expired_at = now()
       - Decrement
         member.remaining_points
       - Set lot.remaining_amount
         = 0
       - Audit log per lot
       - Send notifications

     ─────────────────────────────
     AREA 3 — SERVICE CATALOG
     ─────────────────────────────

     Initial catalog (9 services):
       1. Resize
       2. Certification
       3. Change Color
       4. Polishing
       5. Engraving
       6. Repair
       7. Stone setting
       8. Cleaning
       9. Plating restoration

     Schema:

       loyalty_services:
         - id uuid PK
         - name text NOT NULL
           UNIQUE
         - description text
         - is_active boolean
           DEFAULT true
         - display_order int
           DEFAULT 0
         - created_at, updated_at

       loyalty_service_requests:
         - id uuid PK
         - customer_id uuid FK
         - member_id uuid FK
         - service_id uuid FK
         - customer_notes text
         - invoice_reference text
           NULL (optional free
           text)
         - proposed_points_cost
           int NULL
         - proposed_at
           timestamptz NULL
         - proposed_by_user_id
           uuid NULL
         - status enum
           ('requested',
            'cost_set',
            'cost_accepted',
            'declined',
            'cancelled',
            'fulfilled')
         - redemption_id uuid
           NULL FK
         - scheduled_fulfillment_date
           date NULL (auto-set to
           cost_accepted_at + 14
           days; admin can extend,
           never shorten)
         - fulfilled_at
           timestamptz NULL
         - fulfilled_by_user_id
           uuid NULL
         - fulfillment_notes text
           NULL
         - created_at, updated_at

     Workflow:

       1. Customer browses
          catalog (no prices
          shown)
       2. Customer requests
          service with optional
          notes + optional
          invoice reference
            → status='requested'
       3. Admin/staff reviews +
          sets cost
            → status='cost_set'
            → Customer notified
       4. Customer accepts or
          declines
            - Accept →
              status='cost_accepted'
            - Redemption row
              CREATED (first
              time)
            - Points debited from
              expiring-soonest
              lots
            - scheduled_fulfillment_date
              auto-set
              TODAY + 14 days
            - Decline →
              status='declined'
              (no redemption)
       5. Admin fulfills
            → status='fulfilled'
            → Customer notified
       6. Cancel paths
            - Before
              cost_accepted: just
              mark cancelled
            - After cost_accepted:
              void redemption
              (Phase 3.2.1) +
              refund points

     Notifications — 4 new
     templates (all in-portal +
     email):
       - service_cost_proposed
       - service_confirmed
       - service_fulfilled
       - service_cancelled

     ─────────────────────────────
     AREA 4 — DISCOUNT AUTO-APPLY
     ON INVOICE
     ─────────────────────────────

     Generic "Spend Points for
     Discount on New Order"
     reward.

     Reward model:
       - Single generic reward in
         catalog
       - No fixed points cost
       - Customer enters
         invoice_number +
         points_to_spend
       - Admin approves →
         discount auto-applied

     Points-to-yen ratio:
       - 1:1 always
       - For PHP accounts:
         PHP_amount =
         JPY_amount × 0.42 rate

     Invoice type constraint:
       - Only NEW orders
         (total_paid = 0) qualify
       - Both layaway AND cash
         orders

     Discount application:
       - Adds to invoice's
         total_paid as VIRTUAL
         PAYMENT
       - Original total_amount
         unchanged
       - remaining_balance
         recalculated

     Cascade logic (when discount
     exceeds downpayment):
       1. Apply to downpayment
          first
       2. Cascade to installment
          1 if exceeds
       3. Continue cascading to
          installment 2, 3...
       4. Until discount fully
          consumed

     Examples:

       Within DP:
         Layaway: ¥30,000, DP
         ¥6,000, 6×¥4,000
         Redeem 3,000 pts → DP
         ¥3,000 cash needed,
         installments unchanged

       Cascade:
         Layaway: ¥30,000, DP
         ¥6,000, 6×¥4,000
         Redeem 8,000 pts → DP
         fully covered,
         installment 1 reduced
         ¥4,000→¥2,000

       Multi-installment cascade:
         Redeem 12,000 pts → DP +
         installment 1 fully
         covered, installment 2
         reduced ¥4,000→¥2,000

     Void reciprocal (Phase
     3.2.1 extension):
       - Refund points to
         original lot
       - Reduce invoice
         total_paid
       - Reverse cascade —
         restore installment
         amounts
       - Recalculate
         remaining_balance
       - Modal warning if invoice
         has cash payments since
         approval

     Schema additions:
       - loyalty_redemptions:
         redemption_kind enum
           ('catalog_reward',
            'discount_on_order',
            'service_request')
       - layaway_accounts:
         loyalty_redemption_id
           uuid NULL FK
         loyalty_discount_jpy
           numeric NULL
       - cash_orders:
         loyalty_redemption_id
           uuid NULL FK
         loyalty_discount_jpy
           numeric NULL

     ─────────────────────────────
     AREA 5 — TIER BENEFITS
     DISPLAY-ONLY
     ─────────────────────────────

     Zero-cost rewards become
     display-only tier perks.
     Hide "Redeem Now" button.
     Show "Tier Perk —
     Automatically Applied"
     badge.

     ─────────────────────────────
     ROLLOUT — GRADUAL
     ─────────────────────────────

     HISTORICAL PRE-IMPLEMENTATION PLANNING.
     Actual implementation of Phase 6.1
     (Points lots + 464 member migration)
     diverged from this plan on 2026-05-15
     (Cynthia decision): summary-only
     migration instead of per-event
     reconstruction. For canonical migration
     design + lot reconciliation rule, see
     the LOYALTY DATA & MIGRATION section.
     ─────────────────────────────

     Phase 6.0 — Pre-phase loose
     ends (~5.5 hrs)
       - Void email notification
       - Phase 4.2.1 milestone
         emission
       - P5 session timeout

     Phase 6.1 — Points lots +
     464 member migration BUNDLED
     ⚠️ PARTIALLY COMPLETE
     ✅ Migration done 2026-05-15→16 (summary-only,
        not per-event reconstruction — see
        LOYALTY DATA & MIGRATION)
     ❌ process-loyalty-redemption refactor
        (consume from lots) — NEVER BUILT
        — see KNOWN OPEN ITEMS — Redemption wiring gap
     (originally estimated ~15-18 hrs)
       - Schema:
         loyalty_point_lots +
         loyalty_lot_consumption
       - award-loyalty-points
         refactor
       - process-loyalty-redemption
         refactor (consume from
         lots)
       - Daily expiration cron
       - 464 member migration
         from Google Sheets
       - Validation:
         SUM(lot remaining) =
         member.remaining_points
       - Note: Production DB has
         1 member with 200 pts
         (Test Customer from
         2026-05-08 smoke test)
         — handled as edge case

     Phase 6.2 — Birthday Bonus
     (~10 hrs)
       - Schema:
         customers.birth_* +
         lock fields
       - Profile birthday capture
         UI
       - "Claim Birthday Bonus"
         button (month-gated)
       - claim-birthday-bonus
         edge function
       - Expiration cron +
         notifications

     Phase 6.3 — Service catalog
     (~12 hrs)
       - Schema:
         loyalty_services +
         loyalty_service_requests
       - Admin services
         management UI
       - Customer service
         request flow
       - Cost approval workflow
       - 4 new notification
         templates

     Phase 6.4 — Discount auto-
     apply (~15 hrs)
       - Schema:
         redemption_kind,
         loyalty_redemption_id FK
       - New "Spend Points for
         Discount" reward
       - Backend approve/void
         branches with cascade
       - Frontend discount flow

     Phase 6.5 — Tier display-
     only (~3 hrs)

     TOTAL ESTIMATE: ~60-63 hrs
     = 6-8 sessions

     ─────────────────────────────
     BACKFILL STRATEGY ⚠️ SUPERSEDED
     (actual implementation was summary-only,
      see LOYALTY DATA & MIGRATION)
     ─────────────────────────────

     Primary source: Google
     Sheets historical records
     (464+ members with full
     transaction history)
     Secondary: DB
     loyalty_transactions table

     Process:
       1. Extract per-member
          transaction history
       2. Reconstruct lots with
          original earned_at +
          computed expires_at
       3. Reconstruct consumption
          rows for spending
          events
       4. Validate: SUM =
          member.remaining_points
       5. Cutover with feature
          flag

     ─────────────────────────────
     DESIGN DECISIONS LOG
     ─────────────────────────────

     Birthday Bonus:
       Q1.1 = birth month window
       Q1.2 = once per calendar
              year
       Q1.3 = immediate
              eligibility
       Q1.4 = window closes if
              missed
       Q2.1 = tier-based
              500/1000/1500/2000
       Q2.2 = last day of pre-
              birth-month next
              year
       Q2.3 = 1 month warning

     Birthday Field:
       Q3.1 = lazy capture
              customer-set
       Q3.2 = immediate lock
       Q3.3 = admin one
              correction
       Q3.4 = no birthday no
              claim
       Q3.5 = month+day no year

     Points Lots:
       Q4.1 = 12-month inactivity
              rolling
       Q4.2 = no tier bonuses
       Q4.3 = promo bonus
              separate
       Q4.4 = restore original
              lot
       Q4.5 = expiring soonest
              first

     Service Catalog:
       Q5.1 = 9 services
       Q5.2 = variable cost with
              customer approval
       Q5.3 = status flow + 14-
              day scheduled
              minimum
       Q5.4 = in-portal + email
              all stages
       Q5.5 = optional free-text
              invoice ref

     Discount:
       Q6.1 = generic reward
       Q6.2 = 1:1 ratio
       Q6.3 = virtual payment
              via total_paid
       Q6.4 = NEW orders only
       Q6.5 = both layaway +
              cash
       Q6.6 = auto-reversal on
              void
       Q6.7 = DP first then
              cascade

     Rollout:
       Q7.1 = points lots first
       Q7.2-Q7.3 = Google Sheets
                   backfill
                   bundled with
                   464 member
                   migration
       Q7.4 = after loose ends
       Q7.5 = gradual

     Trigger: Phase 6.0 loose
     ends complete + design
     session results approved
     for build.
  ⏳ Void email notification (small
     standalone fix)

     Phase 3.2.1 (LIVE 2026-05-08) ships
     in-portal notification for void via
     buildRedemptionCancelledNotification
     + emitNotification, but does NOT
     send a transactional email to the
     customer's inbox.

     Approve flow sends both:
       - Transactional email via
         send-transactional-email
         ("Redemption confirmed: N
         points used")
       - In-portal notification

     Void flow only sends:
       - In-portal notification
         (asymmetric)

     Customer experience: gets email
     when redemption approved, but only
     sees cancellation in portal — no
     email when admin voids.

     Fix scope (~2 hours):
       1. Read approve email pipeline
          (template + invocation
          pattern)
       2. Build "redemption_voided"
          email template mirroring the
          approve template's visual
          style
       3. Wire into void branch in
          process-loyalty-redemption
          after the in-portal
          notification emit
       4. Smoke test: void a
          redemption → verify customer
          receives email

     Email content should include:
       - Reward name
       - Points refunded
       - Cancellation reason (from
         cancellation_reason)
       - New points balance
       - Link to loyalty dashboard

     Self-contained — does NOT depend
     on Phase 6 redemption overhaul.
     Can be shipped any time.

### PWA TOKEN-TO-SESSION REDEMPTION (Phase A)

  **STATUS: ABANDONED 2026-05-04 — preserved for historical reference only.
  Verified still abandoned 2026-05-17 (no frontend wiring exists). See
  SYSTEM STATUS → PWA Install for current canonical status.** Replaced by
  email/password auth workstream on
  feature/email-password-auth branch. See EMAIL/PASSWORD
  AUTH subsection below for the active replacement. The
  Phase A scope below is preserved for historical
  reference only and should NOT be picked up.

  Multi-phase PWA fix project lineage:
    Phase 0 (Known Fixed Bug #65) — Cleanup of
            failed dynamic manifest approach.
            Reverted PR-1 (cae1bc8, bug #61)
            and PR-2 (bef1949, bug #62).
            Static manifest remains; PWA
            install no longer works.
    Phase A — Token-to-cookie/session redemption
            (planned, not yet shipped).
    Phase 6 — Dead-shortcut UX handler for
            customers who installed the broken
            admin-context PWA pre-#65, plus
            customers on iOS < 17.2 where A2HS
            cannot reliably redeem the token.

  Phase A scope (planned):
    - New customer_portal_sessions table
      (server-side session keyed by token swap)
    - New redeem-portal-token edge function;
      must be added to
      .github/workflows/supabase-functions-deploy.yml
      so it auto-deploys with the rest
    - 7 portal-facing edge functions accept
      session_id alongside token:
        customer-portal
        verify-portal-pin
        set-portal-pin
        submit-payment
        submit-cash-payment
        process-loyalty-redemption
        join-loyalty-program
    - LoyaltyPortal.tsx — additive only
      (new useEffect for token → session
      redemption + session_id branch in
      fetchPortal)
    - Add audit_delete_cleanup_invariants()
      allowlist row for the new
      customer_portal_sessions table when
      it is created (otherwise the audit
      RPC will flag it as a missing-cleanup
      gap on customers delete-account)
    - Solves the iOS A2HS limitation that
      sank bug #62's manifest approach

  Sharp edges to capture in the eventual
  Known Fixed Bug entry:
    - S5: multi-customer same-device caveat
          — sessions are per-token, not
          per-device, so a phone shared
          between two enrolled customers
          will show whichever portal
          redeemed last
    - S9: iOS 7-day ITP storage uncertainty
          — Safari may evict the session
          cookie within 7 days of last
          interaction; document the
          re-redeem flow
    - Pre-iOS-17.2 customers fall back to
      the Messenger-link prompt path
      (Phase 6 still planned)

### EMAIL/PASSWORD AUTH (Phase B)

**STATUS: SHIPPED TO PRODUCTION 2026-05-05** — replaces abandoned
Phase A PWA approach. Merged to main at commit 337d65c.
End-to-end production validation complete 2026-05-06 via
CJ-2026-05088 re-migration (test fixture; auth_user_id
bcd8c2cf-23e0-4f9c-b507-f8ef15620da2).

Branch: `feature/email-password-auth` (created 2026-05-04 from
main at commit 491e44f, merged to main 2026-05-05, deleted
post-merge)

Per-customer auth routing (LOCKED 2026-05-04):
  Both auth methods coexist permanently. Per-customer
  routing is driven by customers.auth_user_id:

    auth_user_id IS NULL  → messages contain token URL,
                            customer logs in via the
                            Messenger link
    auth_user_id NOT NULL → messages contain bare portal
                            URL, customer logs in with
                            email/password

  The token endpoint stays deployed indefinitely.
  Existing token URLs continue to work for any
  customer (no active revocation). The auth_user_id
  flag controls only which URL gets sent in new
  messages.

Phase 0 — Data cleanup (✅ COMPLETE 2026-05-04):
  - 4 duplicate-email customers investigated
  - Kariemhe pair: deleted CJ-2026-04760 (zero linked
    data), kept CJ-2026-05104 "Karie Mhe Calon"
  - Cabalza pair: deferred (family sharing one email;
    keep using legacy token auth indefinitely)

Step 1 — Branch creation (✅ COMPLETE 2026-05-04):
  - Branch pushed with -u tracking to origin
  - Working tree clean

Step 2 — Database schema changes
          (✅ COMPLETE 2026-05-04, with caveats):
  6 SQL migration files committed to branch at 2d3ac1f
  (originally; rebased to 208e8ef on top of main):
    - 20260504000001_add_customer_role.sql
    - 20260504000002_add_auth_user_id_to_customers.sql
    - 20260504000003_partial_unique_email_index.sql
    - 20260504000004_sync_auth_email_to_customer.sql
    - 20260504000005_customer_rls_policies.sql
    - 20260504000006_customer_rls_policies_remainder.sql

  ⚠️ PROCEDURAL DRIFT: Files 1-5 (enum, FK column,
  partial unique email index, email sync trigger,
  3 of 9 customer RLS policies) were applied to
  production via SQL Editor on 2026-05-04 ahead of
  the merge plan. Effect on production: zero — all
  changes dormant because no customer has
  auth_user_id set yet, and no code path reads or
  writes the new structures. Procedural rule
  violated: schema changes were supposed to wait for
  merge approval. File 6 (6 remaining customer RLS
  policies for payments / payment_submissions /
  loyalty_members / loyalty_transactions /
  loyalty_redemptions / loyalty_notification_recipients)
  is NOT yet in production — applied at merge time.

  Production state vs branch state:
    Files 1-5 schema: branch == prod
    File 6 RLS policies: branch ahead of prod
                          (will reconcile at merge time)

  Process safeguard going forward: SQL intended to
  be run is preceded by an explicit
  "Run this in SQL Editor:" instruction line in
  Claude responses. Anything inside design proposals
  without that prefix is design only and must not
  be executed.

Step 3 — Backend dual-auth (⏳ PENDING):
  - 7 portal edge functions accept BOTH old auth
    (token/session) AND new auth (Bearer JWT)
  - 1-2 new functions: setup-customer-account, optionally
    invite-customer-account
  - Both auth paths remain supported permanently
    (verify-portal-pin and redeem-portal-token are
    NOT deprecated)

  Pre-Step-3 investigation REQUIRED:
    Before any code is written for Step 3, the
    existing email infrastructure must be inventoried
    end-to-end:
      - Every edge function that calls
        send-transactional-email
      - Every email template in use (auth, reminders,
        loyalty notifications, payment confirmations,
        cash order flows, forfeit warnings, etc.)
      - Every place a portal URL is embedded in a
        customer-facing message (so the
        getPortalLinkForCustomer helper can be
        applied uniformly — see Per-customer auth
        routing above)
      - Every cron job that sends emails
    Goal: ensure new customer auth emails (signup
    verification, password reset, email change)
    integrate cleanly with the established
    auth-email-hook + send-transactional-email
    sole-sender pattern. No parallel paths, no
    duplicate-send risk.

Step 4 — Frontend customer login (⏳ PENDING):
  - 4 new routes: /portal/login, /portal/forgot-password,
    /portal/reset-password, /portal/setup
  - Modify CustomerPortal.tsx + LoyaltyPortal.tsx
  - 4-B4-1 SHIPPED 2026-05-05: getPortalAuthHeaders extracted
    to src/lib/portal-auth.ts shared module (commit 2b8c0b3)
  - 4-B4-2 SHIPPED 2026-05-05: LoyaltyPortal dual-auth integration —
    authMode/accessToken/bootstrapping state, bootstrap useEffect,
    dual-auth fetchPortal, redirect changed to /portal/login,
    TopBar back button auth-mode aware
  - 4-B4-3 SHIPPED 2026-05-05: CustomerPortal View → handler conditional
    navigation — session mode navigates to /loyalty (no token), token mode
    preserves /loyalty?token=X behavior; authMode prop plumbed from parent
    CustomerPortal to loyalty card sub-component

#### PHASE B 4-B END-TO-END VALIDATED (2026-05-05)

  Full session-auth customer journey passes all 6 checkpoints on Lovable
  preview environment (preview--chajewelslayaway.lovable.app):

    Checkpoint A — CustomerPortal home in session mode: customer name,
      stats grid, payment buttons, My Loyalty card with View → arrow
    Checkpoint B — Click View → goes to /loyalty WITHOUT ?token= (4-B4-3
      conditional navigation), LoyaltyPortal renders via dual-auth
      fetchPortal (4-B4-2)
    Checkpoint C — All loyalty sub-tabs work (Alerts, Profile, Rewards,
      Points). Q2 reactive bet validated — sub-components receive
      portalToken='' but use supabase.functions.invoke() SDK auto-Bearer.
      No 4-B4-4 substep needed.
    Checkpoint D — Back to Portal goes to /portal WITHOUT ?token=
      (4-B4-2 TopBar conditional fix)
    Checkpoint E — Sign Out clears session, redirects to /portal/login
      (4-B3 sign-out button)
    Checkpoint F — Re-sign-in lands directly at /portal (auth_user_id
      already linked, skips /portal/setup flow)

  Test fixture: customer CJ-2026-05088 "Test Customer",
  email chajewelsjapan@gmail.com, auth_user_id
  3e6ca23f-0b14-44b4-ab41-3d1702bdda65. Linked via /portal/setup
  flow validating setup-customer-account end-to-end.

  Force-deployed during testing (auto-deploy was stale):
    setup-customer-account — Step 3g function never auto-deployed
      (workflow path filter bug, see open items)
    customer-portal — Step 3f-2 modifications were stale on Supabase,
      blocking session-mode fetchPortal until manual redeploy

Step 5 — Admin tools (✅ COMPLETE 2026-05-05):
  - 5-1 SHIPPED at fa64262: portal-setup-invite email template +
    registry entry + setup_link_sent_at column migration
  - 5-2 SHIPPED at 3ee12b4: Send Setup Link button + AlertDialog
    confirm + Migrated/Token-based status badge in
    CustomerPortalShareMenu, email pre-fill on PortalSetup,
    setup_link_sent_at tracking
  - Email-only delivery via existing send-transactional-email +
    portal-setup-invite template
  - Visible to admin + finance roles on CustomerDetail page
  - Validated end-to-end 2026-05-06: setup link → email →
    setup form (email pre-filled) → password creation →
    sign-in success → CJ-2026-05088 re-migrated cleanly

Step 6 — Branch testing (✅ COMPLETE 2026-05-05):
  - Full 6-checkpoint validation on Lovable preview (see
    PHASE B 4-B END-TO-END VALIDATED above)
  - Step 5 send-flow validated post-CSS-fix on preview
    before merge

Step 7 — Merge approval (✅ COMPLETE 2026-05-05):
  - Cynthia approved merge after Step 5 validation passed
  - Merged at 337d65c via fast-forward of main + parallel
    Lovable bot commits (b191129, b013b4b)
  - 38 files changed, 2062 insertions, 169 deletions, zero conflicts
  - Firebase auto-deploy completed in ~30 seconds
  - Production verified: portal.chajewelsjp.com/portal/login
    returns HTTP/2 200, /portal/setup?email=... pre-fill works

Customer rollout (post-launch):
  - Migration is opt-in only via existing token visit
    ("set up email/password if you'd like — both
    methods will continue to work")
  - Messenger broadcasts + admin invites encourage
    adoption but no deadline is enforced
  - Token auth has NO sunset — supported as long as
    any customer uses it
  - Setting up email/password does NOT revoke
    existing tokens (they just stop appearing in
    new messages)
  - 71 no-email customers stay on token auth
    indefinitely (no email → cannot migrate, but
    no expiration either)
  - Cabalza family (shared email) stays on token
    auth indefinitely
  - Customers who never opt in stay on token auth
    indefinitely

Locked decisions:
  - Email verification ON for post-launch self-signups
  - Email verification ON for migration signups
    (corrected 2026-05-05 after testing — Cynthia confirmed
    verification gate is desired before account access;
    PortalSetup.tsx handles the email-click round-trip via
    emailRedirectTo + onAuthStateChange + getSession on mount)
  - Customer-initiated email change: standard verification
  - Admin-initiated email change: override + notify
  - Password: 8 chars + 1 letter + 1 number
  - Session refresh token: 30 days
  - Empty accounts state: "You don't have any orders yet"
    with shop/Messenger CTA
  - Token auth sunset: NONE — supported indefinitely
  - Token revocation on signup: NONE — opting into
    email/password does not revoke existing tokens
  - Portal link in customer messages: bare URL
    (https://portal.chajewelsjp.com) when
    customers.auth_user_id IS NOT NULL,
    token-bearing URL otherwise. Implemented via
    centralized helper getPortalLinkForCustomer().
  - Migration policy: opt-in only, no deadline,
    no forced migration

Branch isolation rules (LOCKED):
  - All work on feature/email-password-auth
  - NO commits to main during development
  - User explicitly approves merge to main only after
    full testing
  - portal.chajewelsjp.com stays customers-only

#### Path forward (decided 2026-05-05)

  Path β chosen — build Phase B Step 5 (admin "Send setup link" UI)
  before merging branch to main. Rationale: Step 5 unblocks scaled
  migration via broadcast invites instead of manual per-customer
  Messenger sharing. Step 5 is additive (UI-only, no backend change),
  low risk.

  Open items (post-launch):
    - RLS file 6 — 6 staged SELECT-only policies on:
      payments, payment_submissions, loyalty_members,
      loyalty_transactions, loyalty_redemptions,
      loyalty_notification_recipients. Apply only if customer-side
      direct PostgREST reads are introduced. Currently all customer
      reads flow through service-role edge functions (which bypass
      RLS), so file 6 is preventive infrastructure with no active
      need.
    - Workflow path filter bug:
      .github/workflows/supabase-functions-deploy.yml uses
      contains(join(github.event.commits.*.modified, ' '), '...') only.
      New files (commits.*.added) are not detected. setup-customer-account
      Step 3h workflow trigger compensated by adding the file path
      explicitly, but the underlying .added bug remains for future new
      functions. Fix: add ".added" check alongside ".modified".
    - Accessibility cleanup on 4 portal auth pages
      (PortalLogin, PortalSetup, PortalForgotPassword,
      PortalResetPassword). Real WCAG 1.3.1 Level A gap:
      missing id / htmlFor / name attributes on form labels
      and inputs. Plus minor polish (aria-busy on submit,
      aria-describedby on errors, type="button" on nav buttons
      inside forms). Estimated 30-45 min mechanical fix. Not a
      blocker — forms work for assistive tech via visual
      proximity + sonner toasts. Standalone code commit,
      separate from docs.
    - Bulk migration follow-through (582 invites delivered
      2026-05-07 via bulk-send-setup-invites). Track conversion
      rate via auth_user_id population on customers table. No
      active blocker — passive wait for customer signups.

### SYSTEM & PRODUCT (added 2026-04-27)
  - Session timeout — auto-logout 2 hours
    inactivity (P5)
  - Admin audit log for manual DB changes (P6)
  - Loyalty amount field — make visible to staff
    role
  - Dispatcher pattern cleanup: process-email-queue INSERTs new "sent" rows into email_send_log instead of UPDATE-ing the existing "pending" row, and doesn't store idempotency_key or provider response metadata on the sent row. Cosmetic/forensic limitation only — orphans pending rows in the log and prevents tracing provider message IDs. Not customer-impacting. Surfaced during Bug #109 investigation, 2026-05-15.


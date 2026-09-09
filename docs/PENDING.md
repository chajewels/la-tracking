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

### LOYALTY TIER BENEFITS — Schema Expansion (RESOLVED 2026-07-06)
  ✅ RESOLVED 2026-07-06 — customer portal has read DB benefits (fallback to TIER_STATIC when empty) since f72f13d 2026-06-27; the TierEditDialog warning was removed with it. Final gap closed today: CustomerLoyaltyTab (staff view) now applies the identical DB-first merge, so admin edits propagate to BOTH views. The 'do not edit tier-benefit fields' rule is LIFTED — admins may populate benefits via TierEditDialog; any tier with an empty benefits array falls back to the hardcoded copy.

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

### PORTAL_TOKEN COLUMN REVOKE (RESOLVED 2026-07-06 — analyzed, accepted with rationale)
  Security Batch 4's migration `20260605093651_…` ran a column-level
  `REVOKE SELECT (portal_token)` on extension_requests and
  payment_submissions. That REVOKE was indeed a no-op (a column-level
  REVOKE cannot subtract from a table-level grant) — that part of the
  original finding was correct.

  RESOLVED 2026-07-06 after a full read-only investigation. Two facts
  close this item without the grant surgery originally prescribed:

  (a) The exposure is self-bounded. Both anon SELECT policies
      ("Token customers can view own extension_requests" /
      "Anon can view own submissions by token") require
      portal_token = current_setting('request.headers')::json
      ->> 'x-portal-token' AND an EXISTS check against
      customer_portal_tokens (active, unexpired). There is no anon
      SELECT/ALL policy WITHOUT this self-filter. An anon caller can
      therefore read only rows whose portal_token equals the token
      they already presented in their own request header — the sole
      theoretical `select('portal_token')` returns the caller's own
      already-held token, not any other row's. The frontend consumer
      census confirms zero anon `select('*')` on either table; the
      portal reads submissions via the customer-portal edge function
      (service_role, explicit column list, portal_token omitted).

  (b) The originally-prescribed fix is prohibited by a locked rule.
      "REVOKE table SELECT + GRANT column-list minus portal_token"
      is exactly the move that broke PostgREST in Bug #2302
      (see docs/FIXED-BUGS.md): PostgREST generates explicit column
      lists internally and errors on a revoked privilege; REVOKE +
      NOTIFY pgrst reload also failed. Additionally, the anon SELECT
      policies reference portal_token in their USING clause, so anon
      must retain column visibility for RLS to evaluate at all. The
      only proven-working confidentiality pattern (relocate the
      column to a side table with no anon/authenticated SELECT
      policy, per the customer_pins fix) does not fit: portal_token
      is the per-row auth key those policies filter on, not a
      relocatable standalone secret.

  DECISION: accept the residual. The self-bounded read is not a
  meaningful disclosure (caller reads only a token they already
  hold), and no rule-compliant grant/relocation change improves it
  without high-risk rewrites of live portal-auth RLS for no gain.
  DO NOT attempt the column-level REVOKE / column-list regrant on
  these tables — it will break PostgREST (Bug #2302) and disable the
  token RLS policies. If a future confidentiality requirement ever
  demands removing even the self-scoped read, the only rule-compliant
  path is a full portal-auth RLS redesign, scoped as its own session.

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

### STORE CREDIT — deferred / not built (2026-07-11)
  Phase A shipped and is live (see docs/STORE-CREDIT.md). Deferred items:
  - Store credit EXPIRY WARNING: credit is forfeited at 1 year with NO reminder
    to the customer. A scheduled notification (e.g. 30 days out) is not built.
    DECISION PENDING.
  - No EMAIL on points revocation or store-credit issuance (in-app notifications
    only).
  - Store credit + loyalty new-order-discount cannot currently be STACKED on the
    same brand-new order (both require an unpaid order; whichever applies first
    blocks the other).
  - Partial/defect reversals are not automated — admins issue credit manually
    (A4b).
  - Shopify orders/cancelled + refunds/create do NOT yet hook into store credit
    (Phase B).

### STORE CREDIT — Phase C + partial refunds (2026-07-12)
  - PHASE C — mirror Hub store credit into Shopify's native store-credit account
    so customers can spend it at checkout. SHIPPED 2026-07-13 (see
    docs/STORE-CREDIT.md Phase C). The Hub MINTS, Shopify MIRRORS — one-way
    authority, bidirectional sync, Shopify never mints; drift detected nightly by
    reconcile-store-credit (report-only). PHP credit cannot mirror (the Shopify
    store is JPY-only).
  - refunds/create (PARTIAL refunds from Shopify) — still unhandled. Phase A/B/C
    support full-order reversal only; a partial refund in Shopify does nothing in
    the Hub. Policy undecided.

### STORE CREDIT — Phase C shipped; remaining pending (2026-07-13)
  - PURGE ALL SHOPIFY TEST DATA BEFORE GO-LIVE (LAUNCH BLOCKER). 13 test orders
    (SH-1001 … SH-1013) plus their payments, line items, loyalty transactions,
    store-credit lots and test customers are still in the database. All are
    currently cancelled with zero paid, so they do not pollute revenue — but they
    must be purged before launch. Ideally via a delete-cash-order tool rather than
    hand-written SQL.
  - refunds/create (PARTIAL refunds from Shopify) — still unhandled. Policy
    undecided.
  - A6 — store-credit expiry warning: credit is forfeited at 1 year with NO
    reminder to the customer.
  - A8 — no email on points revocation or store-credit issuance (in-app
    notifications only).
  - delete-cash-order — still unscoped; now also needed for the pre-launch purge.
  - WONDER (storefront): (1) the Shopify order-confirmation email tells a
    bank-transfer customer we are "preparing your shipment" before they have paid —
    it must be payment-status aware; (2) checkout should prompt customer sign-in,
    otherwise customers cannot see or spend their store credit and will be charged
    full price.
  - PAGE365 integration — requirements document sent; awaiting their response.

### Edge-function Deno CI gate (added 2026-09-09 — BOTH STEPS BLOCKING)

CI runs a two-step Deno gate on `supabase/functions` (job `edge-functions` in
`.github/workflows/firebase-deploy.yml`), added after three edge functions
shipped with syntax errors that no check in the repo could see —
`tsconfig.app.json` includes only `src`, so `supabase/functions` had never been
compiled by CI at all (the truncation in `review-payment-submission` survived
five days on `main`).

**There is no backlog item left here.** Both steps are blocking and both are
clean. What remains below is the operating manual — read it before changing
the job.

**Config lives OUTSIDE the deployment directory — do not move it back.**
Both steps pass `--config development/deno.ci.json`. There is deliberately NO
`deno.json` that we own anywhere under `supabase/functions/`, because that
directory is what the Supabase edge runtime reads at deploy time and
`nodeModulesDir` changes module resolution. An untested resolution setting
next to the sole writer to the `payments` table is not a risk worth taking.
`development/deno.ci.json` also sets `"lock": false` so no `deno.lock` churns.

That the deploy path reads these files is not a hypothesis: seven per-function
`deno.json` files already exist under `supabase/functions/<name>/` (the
React-email functions — `auth-email-hook`, `send-transactional-email`,
`preview-transactional-email`, `process-email-queue`, `handle-email-events`,
`handle-email-suppression`, `handle-email-unsubscribe`) carrying real
deploy-time settings: `jsx: react-jsx`, `jsxImportSource: npm:react@18.3.1`.
Leave them alone — they are the reason the CI config lives elsewhere.

  - **Parse check — `deno lint --config development/deno.ci.json
    supabase/functions` — BLOCKING.** A near-pure syntax gate: `deno lint`
    parses every file and resolves no imports, so a file that cannot be parsed
    fails the step regardless of which rules are enabled or what the network is
    doing. That is exactly the class of defect that got through.

    The config turns off all rule *tags* and re-enables exactly five rules:
    `no-dupe-args`, `no-dupe-keys`, `no-dupe-class-members`,
    `no-unsafe-finally`, `no-with`. Each is a genuine bug rather than a style
    opinion, and all five are clean across the fleet.

    The five are not decoration — `deno lint` REFUSES to run with an empty rule
    set (`error: No rules have been configured`, exit 1), which is how the first
    version of this job failed. Do NOT empty the `include` list, and do NOT
    re-enable the rule tags without a separate cleanup pass: the fleet has never
    been linted and the full `recommended` set would go red on day one.

    Verified against Deno 2.9.6 (the version CI installs): clean on all 149
    files, and red with a `SyntaxError` on both real defects from commit
    `5138a7e` — the 601-line truncated `review-payment-submission` and the
    spliced import in `award-loyalty-points`.

  - **Type check — `deno check --config development/deno.ci.json` over every
    `supabase/functions/*/index.ts` EXCEPT the generated `mcp` bundle —
    BLOCKING as of run 2099.**

    **`supabase/functions/mcp/index.ts` is excluded deliberately.** It is
    generated by `@lovable.dev/mcp-js` from `src/lib/mcp/`, and the bundler
    strips the types its source already carries — `ctx: ToolContext` is emitted
    as `ctx`, and `process.env.SUPABASE_URL!` loses its non-null assertion.
    That produced 4 errors (TS7006 ×2, TS2345 ×2) that were transpilation
    artifacts, not defects. The source is correctly typed AND is already
    type-checked by the `Typecheck` step in `build-and-deploy`, since
    `tsconfig.app.json` includes `src`. Type-checking the bundle adds nothing
    and only re-reports the loss. If the exclusion is ever removed, expect
    those 4 back.

    **Type debt across the hand-written fleet is ZERO** — run 2098 checked
    99/99 functions and every error came from that one generated file. This is
    why the step could go blocking immediately rather than after a cleanup
    campaign.

    Unlike the parse check, this step fetches type definitions over the network
    (`esm.sh`). A transient outage there turns the job red. That is an accepted
    cost: the job is decoupled from `build-and-deploy`, so a red edge job never
    blocks a frontend deploy or a customer-facing hotfix — re-run it.

Two limits worth restating, so this is not mistaken for more protection than
it is:
  - The job is **decoupled** from `build-and-deploy` (no `needs:`) — a Deno
    failure never blocks the frontend deploy, and a frontend failure never
    hides a Deno failure.
  - CI does not deploy edge functions (Lovable IDE is the only deploy path —
    see CLAUDE.md TOOL OWNERSHIP RULES). This is a **detection** gate on
    `main`, not a prevention gate on the deploy.

**Do not measure edge-function type debt from the Claude Code web sandbox.**
Its egress proxy answers 403 to CONNECT for `esm.sh`, and nearly every edge
function imports `supabase-js` from there on line 1 — so a local sweep fails
~90 of 99 functions on network errors that look nothing like type errors until
you read the actual stderr. GitHub Actions reaches `esm.sh` fine. Measure in
CI, not locally.

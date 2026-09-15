## PENDING ITEMS (as of 2026-05-25)

### process-loyalty-redemption validates the body before it checks auth (found 2026-09-15)

An unauthenticated `POST` with `{}` returns **400** `action must be 'create',
'approve', 'cancel', or 'void'` — not 401. Confirmed in source: `action` is
validated at `index.ts:101-105`, while the auth paths (service-role JWT claims,
then `resolvePortalAuth`) only begin at :112 and the 401s are at :145/:149.

**Not a hole.** Nothing is read, written or leaked beyond the four action names,
and every real branch is still gated (401 at :145/:149, then the role checks at
:206, :491, :688, :806). It surfaced only because a deploy verification probed
the function unauthenticated and got 400 where the other eight gave 401.

Worth reordering on principle — authenticate, then validate shape — but not as a
drive-by: this is the redemption path, and moving its gate is its own change with
its own reasoning. Filed rather than fixed.

### CI — Firebase preview channels are at the per-site cap (found 2026-09-15)

`build-and-deploy` fails on every NEW pull request at the
`firebase hosting:channel:deploy` step, in ~2.8s with no output. First seen on
PR #71.

**Not a code failure.** Typecheck, build and the Deno gates all pass, and the
identical tree deployed to the `develop` channel three minutes earlier. **A push
to `main` is unaffected** — production takes the `firebase deploy --only hosting`
branch, which creates no channel — so this never blocks a release.

**Cause (hypothesis, arithmetic fits exactly).** Per-PR channels landed in
`12a58907` on 2026-09-11. Every PR #22–#71 was opened on or after that date, so
49 live `pr-N` channels plus the long-lived `develop` channel = 50, which is
Firebase Hosting's documented per-site preview-channel limit. `pr-70` took the
50th slot at 07:55; `pr-71` asked for the 51st at 08:15. Unconfirmed only
because nothing in the Claude Code sandbox can reach Firebase to enumerate the
channels, and `rerun-failed-jobs` returns 403 there.

**Why the log cannot say so.** The step runs
`firebase … --json > channel.json` under `set -euo pipefail`. In `--json` mode
the CLI writes errors to stdout, so the error object lands in `channel.json`,
and a non-zero exit aborts the step before the `cat channel.json` that would
print it. The only branch written to surface an error runs when firebase
*succeeds* but omits a URL, so every genuine CLI failure is silent by
construction.

**Two fixes, neither applied** (both proposed in full on PR #71, deliberately
not pushed there — widening a `develop` -> `main` release PR with an unrelated
CI change is worse than a red preview check):
  1. Capture firebase's exit status instead of letting `set -e` swallow it, and
     `cat channel.json` on failure.
  2. Delete the `pr-N` channel when its PR closes (`pull_request: [closed]` +
     `firebase hosting:channel:delete … --force || true`), so the cap stops
     being reached at all.

**To unblock previews now:** prune the `pr-N` channels of merged/closed PRs in
the Firebase console (Hosting -> `chajewelslayaway` -> Channels), or
`firebase hosting:channel:list --only main --project cha-jewels-la-tracking`
then `…:delete pr-<n> … --force`.

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

### QUEUED EMAIL PIPELINE — DEFERRED (owner decision 2026-09-14)

Not a priority until the storefront is built and ready to publish. Customers are
reached on Messenger meanwhile. The only email work in scope right now is the web
order confirmation and the CSR payment confirmation — both tracked separately and
both still active.

**Trigger to pick this up: before the storefront production release.**

**The path.** `send-transactional-email` → pgmq `transactional_emails` →
`process-email-queue`. This is the ONLY path that set `unsubscribe_token`.

**The failure.** 164 refusals, `400 missing_unsubscribe`, from 2026-09-04
02:03:38 to 2026-09-09 14:08:13. The message in full:

> This project is migrating to Lovable-managed email sending. Publish the project
> to complete the migration, then retry; do not set unsubscribe_token manually.

Two instructions in one message. The second one is what bit this pipeline.

**It stopped failing on 09-09 because the pipeline went IDLE, not because it was
fixed.** `process-email-queue` has no cron entry — CLAUDE.md's "every 5 seconds"
line was stale and is now corrected. It is kicked over HTTP by
`send-transactional-email`, and nothing has called it since.

**Nothing is stranded.** The queue is empty. The 464 rows in
`transactional_emails_dlq` are 100–171 days old and unrelated to this.

**The fix is written and merged to develop (#52) but NOT DEPLOYED.**
`unsubscribe_token` removed from the `sendLovableEmail` payload in
`process-email-queue`; the mint/look-up block removed from
`send-transactional-email`. `email_unsubscribe_tokens` and
`handle-email-unsubscribe` are untouched, so unsubscribe links in already-
delivered emails stay valid.

**Deploy set when this is picked up: exactly two functions**,
`send-transactional-email` and `process-email-queue`. Neither is a shared module,
so the six HTTP callers below need no redeploy.

**Six callers are still on this path and are therefore silently non-functional
until it is deployed:**

| Function | Note |
|---|---|
| `bulk-send-setup-invites` | |
| `process-loyalty-notification-queue` | |
| `request-extension` | **customer-facing** |
| `restore-loyalty-points` | |
| `revoke-loyalty-points` | |
| `send-loyalty-notification` | |

**Unproven until a send through `send-transactional-email` reaches
`status='sent'` in `email_send_log`.** An idle queue and a working queue look
identical.

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


Cancelling a web order from CashOrderDetail sets the status but leaves
`website_product_variants.stock_qty` decremented. Only the 72-hour expiry
(`expire_web_order_atomic`) puts stock back. Needed: route the Hub cancel of a
`source_channel = web` order through an RPC that restores stock the same way.

---

### CUSTOMER PORTAL ACCESS — PARKED 2026-09-15 (owner decision)

Findings from the portal→storefront investigation of 2026-09-15. Recorded as
facts, in the order they were found. The portal remains the PRIMARY customer
surface; nothing is retired and nothing is migrated.

#### A. TOKEN CLIFF — TIME-CRITICAL. FIRST LAPSE **2026-09-18**.

632 active portal tokens. **447 expire within 30 days, 438 within 13, earliest
2026-09-18.** 145 of those customers hold live layaway plans. The mass arrives
on Sunday **2026-09-20** (195 tokens in one day); by Tuesday 2026-09-22, 408 of
the 632 are dead.

The cause is the column default: `customer_portal_tokens.expires_at DEFAULT
now() + '180 days'`, and the Hub's mint (`CustomerPortalShareMenu.tsx:130`)
never sets the column. Every token's death is its mint date plus 180 days, and
the mint dates are the March bulk run (195 on 2026-03-24, 138 on 03-25, …).
Not one has been renewed in the six months since — there is no renewal path.

Expiry is enforced (`portal-auth.ts:164`, `throw new Error('Token expired')`).
Nothing re-mints. The only mint is a CSR pressing Regenerate, one customer at
a time.

The fix is a dated `UPDATE` on `expires_at` — reversible, no code, no deploy,
no schema change (the table has no triggers and no CHECK constraints).

**If it passes unactioned:** saved links and every link in past emails stop
working. The customer lands on an error screen reading "Token expired" with no
sign-in offer and no recovery on it. Recoverable only by a CSR regenerating
each link by hand.

#### B. NO WARNING SYSTEM
No notification, no dashboard indicator, no report, no cron watching
`expires_at`. `buildPortalLinkForCustomerId` treats an expired token as NO
token and falls back to a bare `/portal` URL, so `send-reminders` keeps sending
— 5,067 reminders in 90 days — the email looks normal, the customer lands on a
page that cannot identify them, and success is reported. Same failure shape as
the September email outage: the system reports success while the thing it is
for has stopped working. Staff find out when a customer complains.

*Status 2026-09-15: ADDRESSED — daily `portal-token-check`, the
`portal_token_expiry_report` verdict, the sidebar pill, the dashboard banner and
the CSR Monitoring → Portal links worklist. Last-seen recording landed with it
(see K).*

#### C. NO BULK REGENERATION
One CSR click per customer, against 447.

*Still open, and it caps what the warning in B is worth: a warning 60 days out
converts a weekend outage into scheduled work and lets staff take the customers
with live plans first, but the fix is still one click each. Near-certain
follow-up rather than a maybe.*

#### D. 50 CUSTOMERS WITH NO EMAIL, HOLDING LIVE PLANS
(144 across all real customers.) No email-based sign-in can ever reach them, on
either surface. Reachable only by the expiring token. Needs an email-collection
campaign or a CSR-mediated route — an owner decision, not code.

#### E. FIVE `source_channel = 'web'` FILTERS
`website/index.ts` lines 1205, 1226, 1266, 1287 (reads) and 1358 (pay). Every
live plan is `hub_manual` — 491 live, 1,448 in total, against 1 web — so all
290 plan-holders see an empty account on the storefront.

Owner decision 2026-09-15: the portal stays PRIMARY; the storefront becomes a
READ-ONLY second view; payment submission stays in the portal.

*Status: built, PR open, NOT merged* — la-tracking #67 (four read filters
relaxed, pay filter kept) and cha-jewels-web #26.

#### F. COPY PASS FOR REAL PLAN STATES — belongs with E, not after it
`overdue`, `extension_active`, `forfeited`, `final_settlement` and `completed`
all render with copy written for a healthy new plan. Worst case: all 53
forfeited plans carry a positive `remaining_balance` (up to ₱478,556), shown in
gold under "Still to pay" on a plan that cannot accept a payment.
*Status: included in cha-jewels-web #26, NOT merged.*

#### G. PENALTIES INVISIBLE ON THE STOREFRONT
`penalty_amount` exists in `lib/types.ts:236` and is rendered nowhere; the
portal has ~12 render sites. A customer sees a balance silently including
penalties they cannot see itemised. Should land before anyone is invited to
view a balance there.

#### H. CASH-ORDER PAYMENT ABSENT FROM THE STOREFRONT
Not gated — missing. `GET /orders/:id` shows transfer instructions and stops;
the `website` function has no pay endpoint for orders. A web cash customer can
only report a transfer via the portal.

#### I. PIN AS A SECOND LOCKOUT
Every portal arrival needs a 4-digit PIN, the last four of the mobile number on
file (`verify-portal-pin`, hashes in `customer_pins`). A customer whose number
changed has no examined recovery path.

#### J. HOUSEKEEPING
- `customer_portal_sessions` is dead: 20 rows, last used 2026-05-06, zero in 30
  days. Everything runs on the raw token.
- 29 of the 30 transactional email templates hardcode
  `portal.chajewelsjp.com`, so any change to how customers reach their account
  means editing all 29.

#### Two facts that should govern any future migration decision

- **The 2026 setup-invite campaign converted 71 of 597 attempts — about 12%.**
  That is the measured rate at which this base will set a password when asked.
- **The eight duplicate email addresses across sixteen customer rows are
  deliberately LEFT AS-IS** (owner decision 2026-09-15). Six of them would sign
  in and reach the linked twin that holds no plan — a blank account, silently,
  with no error. Only the failure is made visible (a `portal_blank_account`
  staff notification plus customer-facing wording, in la-tracking #67); the
  data is not touched.


---

### PORTAL LINKS — ITEMS ADDED 2026-09-15 (second pass)

#### K. LAST-SEEN IS NOW RECORDED; THE LIFECYCLE DECISION IS DEFERRED, NOT TAKEN

`customer_portal_tokens.last_used_at` / `use_count` and
`customers.portal_last_seen_at` are written by `record_portal_seen`, called
fire-and-forget from `_shared/portal-auth.ts` on all three auth paths, throttled
to one write an hour.

**The decision this exists to inform.** Should token expiry run from the mint or
from last use? Measured on 2026-09-15, use-based would take March 2027 from 70%
of tokens to 55%, and the peak day from 195 to 149 — a lower wall, still a wall.
But the measurement was built from customers taking an ACTION that left a row; a
read-only visit wrote nothing, so **153 was a floor, not a count**, and the
"would lapse on scattered dates" group was empty only because the portal was 175
days old against a 180-day window. Revisit once `last_used_at` has ~6 months of
real data — the extension runs to 2027-03-17, so there is room.

Two facts to carry into that revisit: **76 of the 632 token-holders also hold a
password**, so their token lapsing costs them nothing; and `use_count` counts
SESSIONS, not page loads, because it shares the one-hour throttle.

#### L. `send-reminders` SENDS A LINK THAT IDENTIFIES NOBODY

Found 2026-09-15 while investigating the "silent fallback". **The premise was
wrong in a way worth recording**: `send-reminders` does NOT call
`buildPortalLinkForCustomerId`. It hardcodes, at index.ts:254 and :291:

    portalUrl: `https://portal.chajewelsjp.com/portal?invoice=${alert.invoice}`

and `CustomerPortal.tsx:316` reads `params.get('token')` and nothing else.
**`?invoice=` has never authenticated anybody** — not since it was written, and
independently of token expiry. So the ~5,067 reminders per 90 days were never a
token-expiry casualty.

It is not a dead end: with no token the page hits the `authMode === null` branch,
which offers Sign in and First-time setup. But the parameter is inert and the
link is less useful than it looks. **The honest fix is to stop pretending it does
something** — either drop the parameter, or make the portal read it and
pre-select that invoice after sign-in. Deliberately NOT bundled with the
token-expiry work, where it would have been buried.

The real blast radius of the expired-token fallback is the loyalty functions
(`award-loyalty-points`, `loyalty-inactivity-check`, `process-loyalty-redemption`,
`restore-`/`revoke-loyalty-points`, `join-loyalty-program`,
`send-loyalty-notification`, `process-loyalty-notification-queue`) plus
`request-extension` — roughly **758 emails over five months**, not 5,067.

#### M. THE 180 DAYS WAS NEVER CHOSEN

`expires_at timestamptz DEFAULT (now() + interval '180 days')` comes from
`supabase/migrations-archive/20260322063951_c9829517-…sql`, a UUID-named
Lovable-generated migration dated the same day as the bulk mint. No comment, no
policy. `docs/` and `CLAUDE.md` record no rationale for portal-token expiry at
all, and the Hub's mint never sets the column, so no human has ever chosen a
value for a single token.

What expiry would protect against is already covered: the token is
`gen_random_bytes(32)` (256 bits, not enumerable); a leaked URL alone opens
nothing because the PIN gate demands the last four of the mobile; and `is_active`
is an immediate, independent revocation control. What expiry adds beyond those is
a bound on an *undetected* leak.

(Related, and also unexamined: `docs/PORTAL-PIN-AUTH.md` is stale — it describes
SHA-256 hashes on `customers`, which moved to PBKDF2 in `customer_pins` on
2026-06-07.)

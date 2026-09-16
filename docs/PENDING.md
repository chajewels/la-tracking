## PENDING ITEMS (as of 2026-05-25)

### An unpaid deposit should not release the piece while a settlement date is still ahead — NOT BUILT (filed 2026-09-15)

Cynthia described a rule that the system does not have: a customer who has not sent the
deposit should not automatically lose the piece if the date they are still working towards
has not arrived yet. Today the hourly sweep is unconditional — `expire_web_layaway_atomic`
releases any web layaway whose `transfer_due_at` has passed with `total_paid = 0`, and the
only thing that stops it is a payment, a payment row, or an unreviewed submission
(INVARIANT 12).

Filed here because the column that would have carried the second date,
`layaway_accounts.settlement_due_at`, was dropped on 2026-09-15 (owner decision) and the
rule must not be lost with it. The column was never the rule: it stored a date and nothing
read it, so it would not have changed the sweep's behaviour by a single row.

Open questions before anything is built:

- **Whose date is it.** A date staff enter per plan, or the plan's own last schedule row
  (`end_date`, which already exists and needs no new column)?
- **What "not released" means.** The stock stays held indefinitely, or the deposit deadline
  is simply moved — which `set-account-deadlines` already does today, with a reason and an
  audit row, and is the cheapest answer if it is enough.
- **What ends it.** A held piece with no deposit and no deadline is stock that never comes
  back on sale. Something has to close it.

If the answer is "move the deadline", nothing needs building. If it is a real second date,
it comes back as a decision first and a column second — that order, this time.

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

**Cause — CONFIRMED 2026-09-15 by CI itself**, once fix 1 below made the step
print what the CLI had been saying all along. PR #75's run reported:

    HTTP Error: 429, Couldn't create channel on
    `projects/1030604802483/sites/chajewelslayaway`: channel quota reached.

So it is the per-site preview-channel quota, exactly as the arithmetic
suggested: per-PR channels landed in `12a58907` on 2026-09-11, every PR #22–#71
was opened on or after that date, and 49 live `pr-N` channels plus the
long-lived `develop` channel = 50, Firebase Hosting's documented limit. `pr-70`
took the 50th slot at 07:55; `pr-71` asked for the 51st at 08:15 and every PR
since has been refused with 429.

This is worth keeping as a method note: the hypothesis was right, but it stayed
a hypothesis for hours because the evidence was being thrown away by the step's
own redirect. Making a failure state its own cause was cheaper than reasoning
about it.

**Why the log cannot say so.** The step runs
`firebase … --json > channel.json` under `set -euo pipefail`. In `--json` mode
the CLI writes errors to stdout, so the error object lands in `channel.json`,
and a non-zero exit aborts the step before the `cat channel.json` that would
print it. The only branch written to surface an error runs when firebase
*succeeds* but omits a URL, so every genuine CLI failure is silent by
construction.

**Both fixes are now in `.github/workflows/firebase-deploy.yml`** (owner
decision 2026-09-15, its own PR — a release PR was never the place for a CI
change):
  1. The deploy step captures firebase's exit status instead of letting `set -e`
     take it, and prints `channel.json` on failure. The log stops being silent
     by construction, so the NEXT failure states its own cause.
  2. A `cleanup-preview-channel` job runs on `pull_request: closed` and deletes
     that PR's channel, never failing the run when the channel is already
     absent. `pull_request.types` had to be spelled out in full, because naming
     any type replaces the default list; `build-and-deploy` and
     `edge-functions` skip a closed event explicitly.

**STILL NEEDS ONE MANUAL PRUNE — the fix is not retroactive.** Job 2 only
releases channels of PRs that close from now on. The ~49 channels already
stranded by PRs closed BEFORE it existed are still holding the cap, and PRs
#71, #72 and #73 never got a channel at all, so closing them frees nothing.
Until someone prunes, every new PR still fails this step.
  - Firebase console: Hosting -> `chajewelslayaway` -> Channels, delete the
    `pr-N` rows of closed PRs; or
  - `firebase hosting:channel:list --site chajewelslayaway --project cha-jewels-la-tracking`
    then `firebase hosting:channel:delete pr-<n> --site chajewelslayaway --project cha-jewels-la-tracking --force`

    Note `--site`, NOT `--only`: `hosting:channel:list` and
    `hosting:channel:delete` take a site ID and have no target indirection,
    unlike `hosting:channel:deploy`, which takes `--only main`. An earlier
    version of this entry gave `--only main` for the list command; that is
    wrong and would not have run.

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

---

## ADDRESS BOOK — WHAT 20260915160000 DELIBERATELY DID NOT BUILD (2026-09-15)

The emergency fix made the checkout's address write non-destructive and gave
every web order its own `ship_to_snapshot`. Three things were left out on
purpose, and are now unblocked rather than done:

**A. The storefront's address CRUD UI** — add / edit / set-default / delete, on
the account page. Cynthia asked for it; it was held back because a safe write
endpoint is its precondition and that endpoint was the emergency. It is now
safe to build: `upsert_customer_addresses` updates in place, so editing an
address no longer rewrites its id, and `ship_to_snapshot` means a delete can no
longer change where a past order went.

**B. Per-address routes.** `PUT /me/addresses` still sends the WHOLE list —
upsert-by-id makes that safe, but `POST /me/addresses`, `PATCH
/me/addresses/:id`, `DELETE /me/addresses/:id` and a `set_default` action are
the shape this should have. Do it with the CRUD UI, not before: a delete route
with no UI is a hole with no user.

**C. Convergence — the Hub on the flat columns, the storefront on
`customer_addresses`.** Still filed, still not started. The drift is currently
ZERO (879 customers carrying a country in `location` and nothing else; 1 real
row in `customer_addresses`; the 2026-09-10 backfill reverted the same day), so
nothing about this fix makes convergence harder. Whenever it happens, the
snapshot is what protects order history from it.

**Not covered by the snapshot, and not at risk:** a web layaway's
`recipient_name`, `recipient_phone` and `gift_note` live on `checkout_quotes`
only — `layaway_accounts` has no such columns. Those are plain text on the
quote, unaffected by anything that happens to the address book, and the quote
row is never deleted. If layaway plans ever need them on the account itself,
that is a separate, non-urgent copy.

---

## RECONCILIATION — WHAT THE 2026-09-16 PR LEFT (and what it deliberately did not touch)

The nightly reconciliation was found dead on 2026-09-16: measured on live, 493
accounts in scope, ~120 reconciled per night at 1.56 s each, the run dying
against a hard ~185 s ceiling every night within 1.2 s of the same duration,
and `last_daily_reconciliation` reading 2026-05-19 — four months stale.

**Done** (loyalty sweep split out + cron; Check 17 and 17b built; the hardcoded
`penalty_cron` pass deleted).

**Still open, in the order they should be taken:**

**A. The run is starved by its ordering, not only by the ceiling.** It selects
`ORDER BY layaway_accounts.updated_at ASC`, but `reconcile-account` has been
report-only since Bug #34 and writes nothing to that table — so the job cannot
advance its own cursor. Measured: 220 distinct accounts touched across 8
nights, **301 of 493 never reconciled once in that window**. Raising the
timeout would not fix this; the tail would still never be reached. Fix: order
by least-recently-reconciled from `reconciliation_log`, which needs no schema
change.

**B. Time-box the account loop.** Stop on elapsed rather than on a row count,
write the stamp with `accounts_remaining`, and let a more frequent schedule
drain the set — so a partial run is a recorded partial run rather than a silent
truncation. (The loyalty sweep already works this way; copy it.)

**C. The real cost driver: 493 sequential inter-function HTTP calls to compute
a REPORT.** `reconcile-account` writes nothing; it computes drift and logs a
row. That is a single SQL RPC's worth of work being done as ~500 round trips.
Replacing it is the architecturally right answer and a much larger change —
explicitly out of scope of the outage fix, and not to be smuggled into A or B.

**D. `daily-penalty-engine` records no completion stamp,** which is why the
health check for it could only ever have been the hardcoded pass that was just
deleted. Give it the same `system_settings` stamp the reconciliation and sweep
jobs write, then add its staleness check alongside 17. Do NOT substitute a
proxy such as "were penalties created recently" — a night on which nobody is
overdue legitimately produces zero penalties, so that check would report
failure on healthy days and train people to ignore the panel.

**E. Health checks 15 and 16 are documented in CLAUDE.md's history but were
never built** (15: installment payments exceeding `schedule.paid_amount`;
16: non-DP payments in the last 24h with no allocations). CLAUDE.md now says so
plainly. Build them or stop describing them.

## THE CLAIM HOLD DOES NOT EXIST (filed 2026-09-16 — record, not a plan)

`/faq` now promises a claimed piece is held **24 hours for a new customer and
72 for a returning one** (owner-confirmed 2026-09-16). **Nothing enforces it.**
Nothing enforced the 60 minutes it replaced either. Whoever builds this should
start from the findings below rather than rediscovering them.

What is already in place, and what it is worth:

| | |
|---|---|
| `website_live_claims` | table exists: `code` UNIQUE, `product_variant_id`, `customer_id`, `csr_id`, `price_locked`, `status`, **`expires_at timestamptz NOT NULL`** |
| `idx_website_live_claims_status` | index on `(status, expires_at)` — the exact shape an expiry sweep needs |
| `website_claim_status` enum | `held / paid / layaway / expired / released` |
| **rows ever written** | **none.** No RPC, no edge function, no trigger inserts a claim |
| **the only reader** | `GET /claims/:code` in `supabase/functions/website/index.ts` — read-only |
| `POST /claims/:code/checkout` | returns **`501 not_implemented`** |
| **`'expired'` / `'released'`** | appear ONLY in their `CREATE TYPE`. Never written anywhere |
| **a cron that expires claims** | **none.** All 13 jobs checked; `auto-expire-cash-orders` sweeps `cash_orders` and web layaways, never claims |
| `loyalty_tiers.hold_minutes` | `DEFAULT 60`, read in exactly ONE place — `website/index.ts` GET /loyalty/tiers, which **serves** it to the storefront and never compares it to a clock |

So the number was published for months and acted on never. Consequence today:
**no claim is released automatically, ever.** A claimed piece is held until a
human releases it in Messenger. Customers are not losing pieces to a 60-minute
timer — the timer does not exist.

What a build needs, in order:

1. **A writer.** Nothing creates a claim row. Until something does, every
   expiry mechanism has nothing to sweep. This is the whole of the work — the
   table and the index are already right.
2. **A deadline from the customer's HISTORY, not their tier.** 24h vs 72h turns
   on whether the customer has bought before. `hold_minutes` on `loyalty_tiers`
   models the old per-tier rule and is the wrong shape; it should be dropped
   from the tier ladder rather than repurposed. The storefront already stopped
   rendering it (`HUB_HOLD_MINUTES` in `cha-jewels-web/lib/loyalty.ts` mirrors
   it under a name that says it is not authoritative).
3. **An hourly sweep** setting `status = 'expired'` where `status = 'held' AND
   expires_at < now()`, returning stock, following the shape of
   `auto-expire-cash-orders`. The index already supports the predicate.
4. **`POST /claims/:code/checkout`**, which today refuses with 501 — without it
   a claim cannot convert and the hold means nothing either way.

Until 1–4 exist, `/faq` states a term the system cannot keep. That is a
statement about the copy, not a defect in it: the hold is a real business rule
that staff apply by hand, and the FAQ describes what staff do.

## FREE SHIPPING: THE FAQ SAYS ¥8,000, THE RATE CARD SAYS ¥50,000 (filed 2026-09-16)

Not a missing feature — a **numerical contradiction**, and the one a customer
actually hits.

Shipping is computed in exactly one place: `shippingFor()` in
`supabase/functions/website/index.ts`, which takes the PRODUCT SUBTOTAL in JPY
and the destination country and returns the active `shipping_rates` row with the
HIGHEST `min_subtotal_jpy` the subtotal clears. The storefront never computes
shipping — `checkout-flow.tsx` renders `quote.shipping_jpy` and nothing else.

The card seeded by `20260911120000_phase2_step2_checkout.sql`:

```
('JP', 0, 800), ('JP', 50000, 0), ('PH', 0, 3500), ('PH', 100000, 0)
```

So Japan free shipping EXISTS, at **¥50,000**. `/faq` says **¥8,000**. A ¥8,000
Japanese order reads "free" on the FAQ and is charged ¥800 at checkout.

**The Japan half needs no code.** The threshold is already a data dimension;
only the number is wrong. It belongs in the Hub, because the rate card is Hub
data and the storefront has no shipping logic to put it in. Read before writing
— the live table may have been edited since the seed:

```sql
-- READ FIRST
SELECT country, min_subtotal_jpy, fee_jpy, is_active
FROM public.shipping_rates ORDER BY country, min_subtotal_jpy;

-- THEN, if JP still reads (0, 800) and (50000, 0):
UPDATE public.shipping_rates
   SET min_subtotal_jpy = 8000
 WHERE country = 'JP' AND min_subtotal_jpy = 50000 AND fee_jpy = 0;
```
Do NOT simply insert `('JP', 8000, 0)` and leave the 50,000 row: two free rows
are harmless but the card then says two different things, and the next person
reading it cannot tell which is intended.

**The international five-item grouping CANNOT be expressed and needs a build
plus decisions.** `shipping_rates` keys on `(country, min_subtotal_jpy)` only.
It has no item count, no per-item price floor, no customer tier — and `/faq`'s
rule needs all three: "five eligible items, each priced at ¥8,000 or more", and
"a qualifying group may include purchases from five friends". Five friends'
purchases are five separate carts belonging to five customers; the checkout has
no representation for that at all. Before any code:

- Is the group assembled by staff (an invoice-level decision) or by the
  customer at checkout? If staff, this is a Hub-side manual adjustment and
  `shipping_rates` is the wrong home entirely.
- Does "each priced ¥8,000 or more" mean unit price or line total?
- How does a five-friend group become one shipment against five orders?

## THE FIVE-ITEM GROUPING IS A TIER LADDER THAT NEITHER PAGE STATES (filed 2026-09-16)

`cha-jewels-web/lib/loyalty.ts` tier perks:

| level | free shipping every | per-item minimum |
|---|---|---|
| Glimmer, Radiant | *(not offered)* | — |
| **Elite** | **4 items** | ¥8,000 |
| **Crown VIP** | **3 items** | ¥8,000 |
| `/faq` base rule | **5 items** | ¥8,000 |

Consistent as a ladder — 5 base, 4 at Elite, 3 at Crown VIP — but **neither
page says so.** `/faq` does not mention that tiers reduce the count; the loyalty
page does not mention the base of five. A Crown VIP reading the FAQ concludes
they need five items when they need three.

Copy fix on both pages, and it should wait for the grouping decision above:
there is no point publishing a ladder whose base rule has no mechanism.

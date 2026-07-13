# Cha Jewels Layaway System — Claude Code Context

## ⚠️ MAINTENANCE — READ BEFORE EDITING THIS FILE

This file is the LEAN CORE: durable, always-load rules only. Trimmed from 425 KB
to ~52 KB on 2026-05-22. Detailed history, status, and feature mechanics live in
`docs/` and are read on demand — NOT injected every turn.

Where new content goes (do NOT append it here):
- A rule changes (formula, invariant, enum, cap) → edit that section IN PLACE here. No dated changelog entries.
- A bug is fixed → append to docs/FIXED-BUGS.md
- A new open bug / pending task → docs/OPEN-BUGS.md or a GitHub issue
- Session status / "what we did" → handled automatically by claude-mem; do NOT log here
- A new feature shipped → docs/ (new or existing file)
- A new audit RPC → docs/AUDIT-RPCS.md
- An operational learning / schema note → docs/SCHEMA-FACTS.md

NEVER append changelogs, status snapshots, or bug logs to this file — that is what
ballooned it to 425 KB. Keep the core small.

Reference docs (read the relevant one when a task touches that area):
- docs/FIXED-BUGS.md — fixed-bug history (do not reintroduce)
- docs/OPEN-BUGS.md — known open bugs
- docs/PENDING.md — pending items / roadmap
- docs/SYSTEM-STATUS.md — point-in-time status snapshot
- docs/AUDIT-RPCS.md — full SQL of audit_account / audit_all_accounts
- docs/INVOICE-GENERATOR.md — invoice generator feature
- docs/CASH-ORDERS.md — cash order confirm/expiry/partial-payment mechanics
- docs/SCHEMA-FACTS.md — schema facts, operational learnings, proof-of-payment, account notes
- docs/RETROACTIVE-AND-EMAIL.md — retroactive enrollment award + email rate limit
- docs/LOYALTY-LIFECYCLE.md — loyalty lifecycle integration (Bug #99)
- docs/HEALTH-CHECKS.md — health checks 15-21 + periodic health queries
- docs/KNOWN-ISSUES.md — DP-detection caveats
- docs/VERIFICATION.md — how to run account health verification
- docs/TEST-ACCOUNTS.md — benchmark test account setups (TEST-001..005)
- docs/AUTO-DEPLOY.md — STALE/ARCHIVED: describes the removed GitHub Actions deploy workflow, which never functioned; deploys are via Lovable IDE only
- docs/PORTAL-PIN-AUTH.md — VERIFY: may be stale (portal migrated to email/password)
- docs/RECENT-UPDATES.md — older changelog (archived)
- docs/SHOPIFY-INTEGRATION.md — Shopify↔Hub integration architecture & roadmap (design locked, Phase 0 done)
- docs/STORE-CREDIT.md — store credit (Phase A): policy, schema, RPCs, edge functions, UI, notifications

## CURRENCY CONVERSION STANDARD — NON-NEGOTIABLE

  JPY = PHP ÷ php_jpy_rate       ← divide to go PHP → JPY
  PHP = JPY × php_jpy_rate       ← multiply to go JPY → PHP

  Example (rate = 0.42):
    ₱10,000 ÷ 0.42 = ¥23,810   ✓ CORRECT
    ₱10,000 × 0.42 = ¥4,200    ✗ WRONG

  NEVER multiply PHP by rate to get JPY — this is always wrong.
  NEVER divide JPY by rate to get PHP — this is always wrong.

  This applies to ALL RPCs, edge functions, frontend calculations,
  and business-rules.ts toJpy() function.

  The rate represents: ¥1 = ₱[rate]  (e.g. ¥1 = ₱0.42)
  Stored in: system_settings WHERE key = 'php_jpy_rate' (jsonb scalar)

  Frontend:  src/lib/currency-converter.ts → toJpy() / phpToJpy()
             uses Math.round(phpAmount / rate)  ✓

  SQL RPCs:  CASE WHEN currency = 'JPY' THEN amount
                  WHEN currency = 'PHP' THEN amount / rate
                  ELSE amount END              ✓

  get_forecast_6m() returns raw (month, currency, remaining) rows —
  NO conversion in SQL. Frontend calls toJpy() per row.

  ⚠️ JSONB STORAGE NOTE: php_jpy_rate is stored in system_settings as a JSON STRING (not JSON number):
    Actual storage: {"php_jpy_rate": "0.42"}  (quoted string)

  Correct SQL extraction:
    SELECT (value #>> '{}')::numeric FROM system_settings WHERE key = 'php_jpy_rate'  ✓

  WRONG extraction (errors with "invalid input syntax for type numeric"):
    SELECT (value::text)::numeric FROM ...  ✗  -- returns '"0.42"' with literal quotes, fails to cast

  The #>> '{}' operator strips JSON quoting and works for both JSON string and JSON number storage. Always use this idiom for php_jpy_rate extraction in any new RPC.

## STORE CREDIT — NON-NEGOTIABLE

  Locked policy. Mechanics (schema, RPCs, edge functions, UI) live in docs/STORE-CREDIT.md.

  - Store credit = MONEY ACTUALLY RECEIVED only. Synthetic loyalty-redemption
    payments (reference_number LIKE 'LOYALTY-%') are EXCLUDED.
  - REDEEMED loyalty points are NEVER returned on cancellation. Permanent.
  - EARNED loyalty points ARE revoked when the order is cancelled.
  - Store credit is REAL MONEY, a PAYMENT METHOD not a discount — total_amount is
    never modified (INVARIANT 7); total_paid rises. It EARNS loyalty points when
    spent (funds the order like cash).
  - NO CURRENCY CONVERSION. JPY credit pays JPY orders only; PHP pays PHP only.
    Balances are tracked separately per currency and are never summed.
  - 1-YEAR VALIDITY from issuance. Expiry = forfeiture.
  - LAYAWAY NEVER AUTO-ISSUES STORE CREDIT — cancellation auto-credit is CASH
    ORDERS ONLY. Layaway store credit is manual-only (admin-issued).
  - Lot model: consumption is FIFO by SOONEST EXPIRY. Voiding a lot cancels ONLY
    the unspent remainder; any portion already applied to an order is a real
    payment and is NOT reversed.
  - Shopify cancellation auto-issues Hub store credit (cash orders only, same
    locked policy) — see docs/STORE-CREDIT.md Phase B.
  - When cancelling in Shopify, ALWAYS choose "Later" (no refund). "Original
    payment method" refunds cash; "Store credit" uses SHOPIFY's separate credit
    ledger. Either one double-pays the customer on top of the Hub credit.
  - Service-role callers pass p_source = 'shopify_webhook'; the audit trail then
    records actor = 'shopify_webhook' and the user-identity guard is skipped for
    that source only. Human callers default to p_source = 'staff' and the guard
    still fires.
  - Hub ↔ Shopify sync is LIVE (Phase C, see docs/STORE-CREDIT.md). The Hub
    MINTS; Shopify MIRRORS. Authority one-way, sync bidirectional. Shopify never
    mints.
  - NEVER issue/void/redeem store credit via SQL — the Shopify push lives in the
    edge functions, not the RPCs. Calling an RPC directly bypasses the sync and
    drifts the ledgers. Use the UI.
  - NEVER use Shopify's "Collect payment" on an order that used store credit (it
    charges the full total and ignores the credit). Use "Capture payment".
  - Drift detection: reconcile-store-credit runs nightly; Settings → Store Credit.
    It REPORTS ONLY and must never auto-repair.

## GENERATED FILES & DEPLOY VERIFICATION — NON-NEGOTIABLE

  - src/integrations/supabase/types.ts is SUPABASE-AUTO-GENERATED. Lovable
    regenerates it on every edge-function deploy. NEVER hand-edit it. After a
    schema change the new types arrive on Lovable's next push. Hand-editing it
    caused a CI failure (TS2300/TS2717) this session — if a type is missing, cast
    at the call site instead.
  - LOVABLE'S REPO MIRROR CAN LAG GITHUB. A Lovable "deployed successfully" does
    NOT prove it deployed main's tip. Every edge-function deploy prompt MUST
    assert on SOURCE CONTENT (e.g. `grep -c "<a string unique to the new code>"
    <file>` plus the file's line count) BEFORE deploying, and STOP if it fails. A
    lagging mirror silently shipped a stale build this session.

## DOMAIN ARCHITECTURE — STRICT RULE (NON-NEGOTIABLE)

  This rule has been violated repeatedly. Anyone reading this file
  (human, Claude, Lovable, future-self) MUST apply it before suggesting,
  testing, documenting, or sharing any URL with a chajewelsjp.com host.

  TWO SUBDOMAINS, TWO AUDIENCES — NO EXCEPTIONS:

    portal.chajewelsjp.com   →   CUSTOMERS ONLY
    app.chajewelsjp.com      →   INTERNAL ONLY (admin, staff, CSR, finance)

  ALL customer-facing routes use portal.chajewelsjp.com:
    /portal                   customer home
    /portal/login             customer email/password sign-in (Phase B)
    /portal/setup             customer email/password signup (Phase B)
    /portal/forgot-password   customer password reset request (Phase B)
    /portal/reset-password    customer password reset completion (Phase B)
    /loyalty                  customer loyalty portal
    Token-based legacy paths  /portal?token=X, /loyalty?token=X

  ALL internal/employee routes use app.chajewelsjp.com:
    /login                    admin/staff/CSR/finance sign-in
    /dashboard, /customers, /finance, /operations, /loyalty-admin, etc.

  BEFORE suggesting, testing, sharing, or documenting ANY URL with
  a chajewelsjp.com host, check the audience:
    Customer-facing?     →   portal.*
    Internal/employee?   →   app.*

  FORBIDDEN PATTERNS (these are recurring violations):
    - Telling a customer to visit app.chajewelsjp.com for any reason
    - Suggesting app.chajewelsjp.com/portal/... as a test URL
    - Including app.chajewelsjp.com in customer-facing emails, share
      buttons, marketing copy, QR codes, or print materials
    - Internal staff using portal.chajewelsjp.com for their work
    - Mixing the two in walkthroughs or screenshots

  The two subdomains may serve the same React build but route by host.
  They are functionally separate. The customer must NEVER see
  app.chajewelsjp.com. Internal staff must NEVER use
  portal.chajewelsjp.com for their work.

## TEST ACCOUNT EXCLUSION — NON-NEGOTIABLE

Real accounts have purely numeric invoice numbers. All test/scaffolding accounts have non-numeric invoices (families: TEST-001..005, CJ-2026-*). The canonical exclusion applied to EVERY operational and financial surface is: keep numeric only — SQL `invoice_number ~ '^[0-9]+$'`; PostgREST `.filter('<embed>.invoice_number','match','^[0-9]+$')`. The old `TEST-%`/`TEST%` filters are INCOMPLETE (miss the CJ- family) and must be replaced by this rule.

Status (2026-05-23): applied across all frontend surfaces (Dashboard, Finance, CSR Monitoring, CSR Alerts, Smart Reminders, Extensions, Audit panels) and all 20 SQL reporting RPCs (13 fc_*, get_collection_analytics, get_monthly_sales, get_monthly_analytics, get_aging_buckets, get_forecast_6m, get_forecast_drilldown, get_top_outstanding_customers). Also enforced in the dashboard-summary EDGE FUNCTION — every layaway_accounts query plus the cash_orders and layaway_accounts payment joins use .filter('<embed>.invoice_number','match','^[0-9]+$'); this powers all Overview headline KPIs (Total Receivables, Predicted, Collections This Month, etc.).

Finance dashboard client-side cascade: useAccounts() returns rawAccounts (unfiltered); Finance.tsx derives `accounts` = rawAccounts filtered to /^[0-9]+$/.test(invoice_number). Every downstream memo inherits it — accountMap, collFiltered (via accountMap.has(p.account_id)), totalForfeitedCollected, recentCompleted. One root filter, all figures clean.

Documented exception: get_staff_performance is intentionally NOT numeric-filtered — it counts confirmed payment_submissions per reviewer (a staff-activity metric), so test-account submissions are legitimately counted as real staff actions. The other unfiltered helpers (get_bulk_setup_invite_candidates, get_recent_qualifying_order, get_unpaid_schedule) are operational, not dashboard counts.

Resolved this sweep: get_monthly_sales ALL-mode currency-conversion bug fixed (#132); get_monthly_analytics + get_aging_buckets numeric filters added (#133); the get_collection_analytics concern is closed — collection_rate is now a true capped efficiency = collected_due / expected, both summed from schedule_with_actuals by due-month (#137).

Re-runnable audit — find any reporting function still missing the filter:
  SELECT p.proname, (pg_get_functiondef(p.oid) LIKE '%^[0-9]+$%') AS has_numeric_filter
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname='public' AND (p.proname LIKE 'get%' OR p.proname LIKE 'fc%')
  ORDER BY has_numeric_filter, p.proname;
  Expected false only for the four helpers named above — none are financial dashboard counts.

DB-enforced as of 2026-06-12: the convention is now backed by a `customers.is_test` boolean flag plus the `enforce_test_invoice_prefix()` trigger function attached BEFORE INSERT OR UPDATE on both `layaway_accounts` and `cash_orders`. Any account written under a customer where `is_test = true` gets its `invoice_number` auto-prefixed to `TEST-<number>` at write time — staff cannot accidentally save a purely-numeric invoice for a test customer, so the regex filters exclude the account regardless of what was typed in. **The rule is now: every new test customer MUST be flagged `is_test = true`. That is the single manual step; everything downstream is automatic.** Test Customer (customer_id `4201767c-54e6-48d0-8c9e-c1b3c07a931e`) is already flagged. See `docs/SCHEMA-FACTS.md` for the column/trigger spec and `docs/FIXED-BUGS.md` Bug #220-era TEST-4567 incident for the original leak that motivated the trigger.

## PERMISSION RESOLUTION ORDER

When checking whether a user can perform an action:

  1. user_permission_overrides WHERE user_id = this_user
       → if a row exists for this permission_key, use granted value
  2. role_permissions WHERE role = user's role
       → fallback when no override exists
  3. admin role → always full access regardless of any override

  Table: user_permission_overrides (user_id, permission_key, granted)
  Managed via Settings → Permission Matrix → By Member view
  RLS: admins only (has_role(auth.uid(), 'admin'))

## PAYMENT SUBMISSION RATE LIMITS

  Per account per rolling 24 hours (excludes rejected status):

  - Downpayment on trade account (is_trade=true): max 10
  - Downpayment on non-trade account:             max 5
  - Installment / other:                          max 3

  Implemented in record-payment/index.ts. DP caps filter the count by
  submission_type='downpayment' so DP and non-DP caps are independent
  (hitting the DP cap does not consume installment headroom and vice
  versa).

  submit-payment/index.ts uses a flat 3-cap for all submissions (no
  DP branch, no trade branch). Customer-portal DP submissions hit
  this cap at attempt 4 regardless of trade status.

  record-multi-payment/index.ts is uncapped (intentional — staff
  batch entry path).

  HTTP 429 returned on cap exceeded. Frontend handler in
  RecordPaymentDialog.tsx parses error.message containing 'Too many'.

## ADDING NEW MENU ITEMS / ROUTES — NON-NEGOTIABLE (added 2026-06-01)

When adding a new route to App.tsx + a sidebar entry to AppSidebar.tsx, the
route must be granted access via ONE of these two paths:

  1. PERM-GATED ROUTE (most common):
     a. Add an entry to PAGE_PERMISSION_MAP in src/contexts/PermissionsContext.tsx
        mapping the path → permission_key (e.g. `'/my-new-page': 'view_my_thing'`)
     b. Seed rows in role_permissions table for each role that should have access
        (admin still gets a row even though admin short-circuits — keep DB consistent)

  2. UNIVERSALLY-ACCESSIBLE ROUTE (any authenticated user, no perm check):
     Add the path to PUBLIC_AUTHENTICATED_PATHS in PermissionsContext.tsx.
     Use this for Help, Glossary, FAQ, Changelog, or any content intended
     for ALL authenticated users regardless of role.

Without either entry, canAccessPage returns false and ProtectedRoute renders
"Access Denied" — including for admins on perm keys that don't yet have DB rows.

Admin short-circuit in can(): if the current user has the 'admin' role,
can() returns true unconditionally — matches the documented rule "admin role
→ always full access regardless of any override". This prevents access
denials on newly-added permission keys that haven't yet been seeded in
role_permissions.

## HELP CENTER SCREENSHOTS — NON-NEGOTIABLE (updated 2026-06-01)

Help Center screenshots live in the Supabase Storage bucket `brand-assets` (public read). They are NOT committed to the repo.

Files in this bucket are stored WITHOUT file extensions (e.g. `Signin_Page`, `Landing_page`, not `Signin_Page.png`). Markdown references must also omit the extension.

Markdown files in src/help-content/ reference screenshots by filename only:

  ![alt text](Landing_page)

Help.tsx's `img` component override on ReactMarkdown resolves relative filenames to the bucket's public URL via:

  supabase.storage.from('brand-assets').getPublicUrl(filename).data.publicUrl

Absolute URLs (http://, https://, or /) pass through unchanged.

All images are wrapped in a click-to-zoom lightbox (shadcn Dialog, 95vw/95vh max).

To add a new screenshot for any Help section:
  1. Upload the file to the `brand-assets` bucket via Supabase Storage UI (no file extension)
  2. Reference it in markdown using just the filename (no extension)
  3. No code change required for the image to render

## BRAND STYLE STANDARD (updated 2026-07-06 — Deco Ledger)

  Canonical brand gold (Deco Ledger, confirmed by Cynthia 2026-07-06):
    --gold-500: #C9A227 = hsl(46 68% 47%)   primary gold — active states,
                                            key CTAs, tier badges, hairlines
    --gold-300: #E5C860 = hsl(47 72% 64%)   hover/focus accents, focus ring
  The former gold #D4AF37 is RETIRED. Gold is applied ONLY via theme tokens
  (--primary / --accent / --ring / --gold family in src/index.css; TS mirror
  incl. chartColors in src/theme/tokens.ts). Hardcoded gold hex literals are
  allowed ONLY in src/theme/ and src/index.css — never in components/pages.

  Semantic tokens --success / --warning / --danger / --info (plus
  *-foreground) ARE defined as of 2026-07-06 (Phase 1 Deco Ledger commit) —
  the matching Tailwind classes are safe to use. The signature structural
  divider is the 1px gold hairline: .hairline-gold / .hairline-b /
  .hairline-t (gold-500 at 40%).

  Check (brand-gold family only — a full any-hex sweep returns hundreds of
  legitimate chart/UI colors and is intentionally out of scope):
    grep -rnE "#D4AF37|#E7D7A2|#C9A227|#E5C860|#E8C84A" src --include="*.tsx" --include="*.ts" | grep -v "src/theme/"
  Target: 0 hits. The gold-literal migration COMPLETED 2026-07-06 (Phase 5)
  — all former debt rows (Finance/Commissions/Timesheet/Inquiries charts,
  ForgotPassword, Login, PortalLogin, AuthContext splash, AdminSplashScreen,
  TierCelebrationModal confetti) now import from src/theme/tokens. The
  avatar gradients (AppSidebar/AppLayout) use the gold-gradient class.
  Never reintroduce a gold hex outside src/theme/ and src/index.css.

  Remaining tracked debt (each row re-justified 2026-07-06, Phase 5):
    - .github/workflows/.github/workflows/firebase-hosting.yml — INERT
      nested duplicate workflow (survives — lives outside src/, needs its
      own cleanup commit; GitHub never executes nested paths). NOTE: the
      REAL deploy workflow .github/workflows/firebase-deploy.yml is LIVE —
      pushes to main deploy the frontend to production hosting; feature
      branches deploy nothing. docs/AUTO-DEPLOY.md describes a different,
      removed workflow (Supabase edge functions) and does not apply.
    - PACKAGE-LOCK PRIVATE-REGISTRY QUIRK (survives — main-side fix only):
      as of fbc9338 (MCP integration), package-lock.json pins ~94 tarball
      URLs to Lovable's private registry
      (europe-west1-npm.pkg.dev/lovable-core-prod/sandbox-npm-cache).
      `npm ci` and fresh installs OUTSIDE Lovable/CI fail with 403 on the
      newer entries; plain `npm install` on the GitHub Actions runner
      succeeds (evidence: firebase-deploy green on fbc9338 and every run
      since). Do NOT edit the lockfile from a feature branch. REVISIT
      TRIGGER: if a future deploy fails at npm install, regenerate the
      lockfile against registry.npmjs.org as a main-side fix.

  Background photo: brand-assets/IMG_4761.jpeg (Supabase Storage, public)
  Used by: AppLayout.tsx (Hub interior, under bg-black/72 overlay)
           PortalLogin.tsx (PORTAL_HERO constant)
  Admin login (Login.tsx) intentionally keeps IMG_3197.jpeg — now as the
  poster/fallback/reduced-motion image for the HERO_VIDEO constant
  (brand-assets//SigninVideo.mp4, Seedance-generated
  "necklaces one by one", plays once and freezes on its final frame = the
  photo). The DOUBLE SLASH in that video's storage key is real — never
  "normalize" it (same rule as the post-login splash asset).

  Gold tokens --gold / --gold-light / --gold-dark remain defined in :root and
  .dark and now alias the Deco Ledger family (--gold = gold-500,
  --gold-light = gold-300).

## POST-LOGIN SPLASH (added 2026-07-06)

  Full-screen video splash after a SUCCESSFUL staff sign-in on the Hub
  (src/components/auth/PostLoginSplash.tsx, wired in src/pages/Login.tsx).
  The Lovable route for this feature was CANCELLED — this on-branch
  implementation is canonical.

  Triggers ONLY on a fresh staff sign-in with NO ?next param:
    - ?next set (OAuth consent flows) → navigate(nextPath) exactly as
      before; the splash NEVER shows. The relative-only open-redirect
      validation on ?next is unchanged.
    - Session restore (visiting /login with a live session) → redirect as
      before, no splash. Enforced by freshLoginRef, set BEFORE the
      signInWithPassword await so the async SIGNED_IN event cannot race
      the gate; reset on failed sign-in.
    - The pre-login AdminSplashScreen and the type=recovery hash guard
      are independent and unchanged.

  Failsafes (all mandatory, all timers cleaned up on unmount):
    video onError → proceed immediately; 5s canplay watchdog → proceed;
    prefers-reduced-motion → no video, backdrop + "Enter Dashboard"
    button immediately. These are BROKEN-VIDEO protection only — there is
    NO auto-navigate timer: the splash waits for the user (button / Enter
    / ESC). The former 15s auto-navigate was removed by owner decision
    (2026-07-06). All exits are idempotent.

  Presentation (blur-fill, 2026-07-06): TWO layers of the SAME video
  source. Background: object-cover full viewport, blur(40px) + scale(1.1)
  to hide blur edges, under a surface-0 ~45% dark overlay — the screen is
  dressed edge to edge. Foreground: CONTAINED and centered (square aspect
  preserved, max ~92vh/94vw) — the actual content is never cropped. Both
  layers share the canplay-driven fade-in. Until canplay: surface-0
  backdrop with the shimmer treatment — never a black flash (no poster
  asset exists).

  Sound (2026-07-06): the hosted MP4 carries an AAC track. The FOREGROUND
  video attempts UNMUTED playback (valid — the splash mounts from the
  sign-in click = user activation). If the browser rejects unmuted
  autoplay (NotAllowedError), fall back: set muted, play again, and show
  an unmute toggle (gold icon button, bottom-right, aria-label
  "Unmute"/"Mute") that flips muted on tap; when playing WITH sound the
  same toggle acts as the mute control. The BACKGROUND blur layer is
  ALWAYS muted. Playback loops (audio loops with it — the toggle is the
  user's control). Reduced-motion path unchanged: no video at all.

  Video URL constant (in PostLoginSplash.tsx): the DOUBLE SLASH in
  .../brand-assets//AdminSpalshScreen.mp4 is part of the real storage
  object key — NEVER "normalize" it; the single-slash URL is a different,
  nonexistent object.

  Guard invariants locked by src/test/post-login-splash-guard.test.tsx:
  session-restore no-splash + redirect; fresh-sign-in splash survives the
  late SIGNED_IN event; failed sign-in resets the guard; ?next sign-in
  navigates to nextPath with no splash.

## total_amount DEFINITION — NON-NEGOTIABLE (updated 2026-04-12)

  layaway_accounts.total_amount = TOTAL ACCOUNT OBLIGATION.
  Includes: downpayment_amount + SUM(base_installment_amounts) + SUM(account_services)
  Services are included in total_amount at the time of service creation.

  The following operations MUST NOT write to total_amount:
  - Adding a penalty (add-penalty, recalculate-penalties)
  - Waiving a penalty (approve-waiver)
  - Recording a payment (record-payment, record-multi-payment)
  - Reconciliation (reconcile-account, daily-reconciliation)

  The only legitimate writes to total_amount are:
  - create-layaway-account  (initial set)
  - edit-account            (admin correction — admin only, via EditAccountDialog)
  - add/delete installment  (AccountDetail.tsx schedule editor)
  - add-service             (adds service amount to total_amount)

  Canonical remaining_balance formula:
    remaining_balance = total_amount + Σ(non-waived penalty_fees) - Σ(non-voided payments)
    total_paid        = Σ(payments.amount_paid WHERE voided_at IS NULL)

  NOTE: Services are already in total_amount — do NOT add services separately
  in the remaining_balance formula. Only penalties are added separately.

  Never compute total_paid from SUM(schedule.paid_amount) — schedule rows are
  derived data; payments table is the single source of truth.

## CALCULATION STANDARD — NON-NEGOTIABLE (updated 2026-04-12)

### Core Formula
  totalLAAmount     = total_amount + activePenalties
                      (services are already in total_amount — do NOT add separately)
  remainingBalance  = totalLAAmount - totalPaid

### Penalty Status Rules
  | status | counts in activePenalties? | meaning                       |
  |--------|---------------------------|-------------------------------|
  | active | YES                       | penalty charged, not yet paid |
  | paid   | YES                       | penalty charged and collected |
  | waived | NO                        | penalty forgiven, excluded    |

  activePenalties = SUM(penalty_fees.penalty_amount)
                    WHERE status != 'waived'
                    (includes both 'active'/'unpaid' and 'paid')

### Why paid penalties stay in totalLAAmount
  A paid penalty was a legitimate charge that increased the account obligation.
  The customer paid it. It must remain in totalLAAmount or the balance will be
  artificially reduced.

### sumOfPendingMonths reconciliation
  sumOfPendingMonths = SUM(layaway_schedule.total_due_amount)
                       WHERE status IN ('pending', 'overdue', 'partially_paid')

  This MUST equal remainingBalance within ₱1 tolerance.
  If it does not → schedule rows are stale and need resyncing.

### Waiver rule
  When a penalty is waived:
  - penalty_fees.status = 'waived', waived_at = now()
  - It is EXCLUDED from activePenalties
  - remainingBalance DECREASES by the waived amount
  - The corresponding layaway_schedule.total_due_amount must be reduced
    by the waived penalty_amount
  - If penalty was already paid before waiver request → status stays 'paid',
    CANNOT be waived retroactively

### totalPaid
  totalPaid = SUM(payments.amount_paid) WHERE voided_at IS NULL
  (includes downpayment + all installment payments + penalty payments)
  layaway_accounts.total_paid must always be kept in sync with this.

### Penalty display (admin + customer portal)
  penalty_fees.status = 'paid'         → green "Paid"
  penalty_fees.status = 'waived'       → gray strikethrough "Waived"
  penalty_fees.status = 'unpaid'          → red "Applied"

## Account Creation Rules

- Downpayment is NEVER marked paid at creation
- `dp_paid` always starts at 0; `total_paid = 0` on new accounts
- DP is only marked paid after payment submission is validated by staff
- Never bypass the payment validation flow
- The "Downpayment Paid" input field does NOT exist on the creation form
- DP excess over downpayment_amount waterfalls into installments (Month 1 onward) — see INVARIANT 11 (Bug #250, 2026-07-06). The required DP portion still never allocates.
- Loyalty Product Amount (JPY) is REQUIRED when the selected customer has a loyalty tier (any tier), on BOTH layaway and cash-order creation. Enforced on two layers: frontend UX (NewAccount.tsx / NewCashOrder.tsx) and the authoritative edge function (create-layaway-account / create-cash-order return 400 LOYALTY_AMOUNT_REQUIRED). Optional for non-members.

## PAYMENT HISTORY AS SOURCE OF TRUTH — NON-NEGOTIABLE

  payments table is the SINGLE source of truth for all money received.
  layaway_schedule.paid_amount must ALWAYS reflect payment_allocations,
  which in turn must reflect the payments table.

  Sync chain:
    payments → payment_allocations → layaway_schedule.paid_amount → account totals

  Invariants:
    SUM(payment_allocations WHERE allocation_type='installment' AND schedule_id=X)
      ≈ layaway_schedule.paid_amount for row X

    SUM(non-voided payments.amount_paid) for account
      ≈ account.total_paid

  Automatic enforcement:
    1. record-payment and record-multi-payment invoke reconcile-account after
       each successful payment (real-time sync).
    2. daily-reconciliation edge function runs once per day for all accounts.
       Completion timestamp stored in system_settings.key = 'last_daily_reconciliation'.
    3. System Health Check 15 (CRITICAL) detects accounts where installment
       payments exceed schedule.paid_amount — flags stale schedule rows.
    4. System Health Check 16 detects non-DP payments in last 24h without allocations.
    5. System Health Check 17 verifies daily-reconciliation ran within 25 hours.

  reconcile-account edge function:
    Body: { account_id } or { invoice_number }
    Behavior: REPORT-ONLY (no DB writes since Bug #34 fix 2026-04-20)
    Steps: load data → compute canonical drift → INSERT one row to
           reconciliation_log
    Does NOT write to: penalty_fees, layaway_schedule, layaway_accounts
    Drift detection currently covers: account.total_paid,
    account.remaining_balance, account.status, schedule.status,
    schedule.paid_amount
    NOT yet covered (known gap, verified 2026-05-17): penalty_fees
    status vs payment_allocations consistency — accounts can have
    categorization noise (penalty allocations recorded as 'installment'
    type) that this drift checker does not surface. See Resolved
    Bug #7 entry for empirical details.
    CANONICAL PATTERN (confirmed 2026-05-18): the earlier
    aspirational description ("create missing allocations → sync
    schedule → auto-waive penalties → recalculate totals") was
    never the actual behavior — reconcile-account only writes a
    reconciliation_log drift row. Any function that needs
    allocations / schedule sync / account totals applied MUST
    inline those writes itself; calling reconcile-account does
    NOT fix anything. Reference implementation: process-loyalty-
    redemption Phase B Patch 2 (commit 8130ace) — inline waterfall
    allocation + per-row schedule UPDATE + account totals UPDATE.

    SUPERSEDED (2026-07-05): the inline-waterfall pattern above for
    the confirm/write path is now consolidated in the
    allocate_payment_atomic Postgres RPC (single transaction:
    waterfall + payment insert + payment_allocations + penalty_fees
    + layaway_schedule + layaway_accounts totals). review-payment-
    submission is the ONLY write-mode caller (p_preview:false) — it
    delegates its allocatePaymentToAccount body entirely to the RPC.
    record-payment and record-multi-payment call the SAME RPC with
    p_preview:true to compute an exact (INVARIANT-1-accurate) plan
    without writing. Any OTHER function needing to apply allocations
    should call allocate_payment_atomic rather than re-inlining the
    waterfall; process-loyalty-redemption's downpayment path stays
    inline (DP payments never allocate to schedule).

## ENUM VALUES — NON-NEGOTIABLE

### penalty_fee_status
  Valid values: 'unpaid' | 'paid' | 'waived'
  - unpaid: penalty charged, not yet collected
  - paid:   penalty charged and collected
  - waived: penalty forgiven by admin — excluded from totals

  NEVER use 'active' — it does not exist in this enum.
  Any code filtering WHERE status = 'active' on penalty_fees is a bug.

### account_status
  Valid values: 'active' | 'overdue' | 'completed' | 'cancelled' |
                'forfeited' | 'final_forfeited' | 'extension_active' |
                'reactivated' | 'final_settlement'

### schedule_status
  Valid values: 'pending' | 'partially_paid' | 'paid' | 'overdue' | 'cancelled'

## PLAN CONFIGURATIONS — NON-NEGOTIABLE

  Stored in: plan_configurations table
  Columns: plan_months, display_label, min_amount_jpy, min_amount_php,
           dp_percentage, is_active, risk_tier

  Current plans:
    3M  → no minimum, LOW risk
    6M  → no minimum, LOW risk
    8M  → min ¥300,000 / ₱126,000, MODERATE risk
    10M → min ¥600,000 / ₱252,000, HIGH risk
    12M → min ¥1,000,000 / ₱420,000, CRITICAL risk

  Enforcement:
  - DB trigger: trg_enforce_plan_minimum fires BEFORE INSERT OR UPDATE
    on layaway_accounts — blocks total_amount below minimum for plan
  - Applies to JPY and PHP accounts separately using correct minimum
  - 3M and 6M have min = 0 — trigger passes through immediately
  - Never hardcode plan minimums in UI — always read from plan_configurations

## PAYMENT ALLOCATION RULES

  Note: DP payments are excluded from this allocation flow per
  INVARIANT 11. They are recorded as payment rows but never create
  payment_allocations against schedule. The rules below apply to
  installment payments only.

  Exact payment:    status → paid. No carry. total_due_amount = base (unchanged).

  Overpayment:      current month set to paid. Surplus waterfalls to next pending
                    months (reduces their total_due_amount).

  Underpayment:     status → partially_paid.
                    paid_amount = amount received.
                    Next row: COMPLETELY UNTOUCHED. No changes.

    carry_over (manual staff action only):
                    Staff clicks Carry Over button in AccountDetail UI.
                    Calls carry-over edge function.
                    Source row → paid. Next row gets carried_amount = shortfall.
                    NEVER happens automatically.

  NEVER:
    - Change base_installment_amount for any of the above
    - Inflate total_due_amount on next row
    - Auto-carry without explicit admin button click
    - Call accept-underpayment to perform carry (it is audit-log only)

  total_due_amount semantics by status:
    pending / overdue:    base_installment_amount + penalty_amount + carried_amount (full amount owed)
    partially_paid:       full amount owed (base + penalty + carried) — paid_amount tracked separately
    paid:                 amount actually paid (= paid_amount)

  When processing an existing partially_paid row in edge functions:
    total_due_amount holds the FULL amount owed (base + penalty + carried),
    independent of paid_amount. Remaining for the row is computed as
    total_due_amount - paid_amount at read time.

    audit_account() Check 12 enforces this semantic by subtracting
    paid_amount from total_due_amount for partially_paid rows when
    summing pending months.

  CACHE-STALENESS TEST (added 2026-05-23 — prevents the misdiagnosis logged in OPEN-BUGS "Schedule cache staleness"):
    Because total_due_amount is the GROSS (above) and per-row remaining is
    total_due_amount − paid_amount (= actual_remaining = total_due − allocated
    in the view), total_due_amount ≠ actual_remaining on a non-paid row is
    EXPECTED whenever any payment is allocated — that gap is the payment, NOT
    drift. A row is genuinely stale ONLY when:
      total_due_amount ≠ base_installment_amount + penalty_amount + carried_amount
    Repair a genuine stale row by resetting total_due_amount to that GROSS sum
    (leave paid_amount / allocated untouched). NEVER flatten total_due_amount to
    actual_remaining — that overwrites the gross and breaks void/restore.

## Git Workflow

- Commit and push all changes directly to **main** branch
- Do NOT create feature branches unless explicitly asked
- Versioning: package.json version is the app version (shown in the sidebar with the build commit). Bump MINOR when a feature ships, PATCH for fixes — only when a prompt explicitly says to bump.

## TOOL OWNERSHIP RULES (updated 2026-05-10)

  Lovable → src/ AND supabase/functions/ file creation and editing.
            Lovable ALSO handles ALL Supabase edge function
            deployments via direct Supabase Dashboard tooling access.
            NOTE (corrected 2026-07-05): the GitHub Actions workflow "Deploy Supabase
            Edge Functions" was removed — investigation proved it NEVER deployed
            anything (required secrets never existed and cannot be created under
            Lovable Cloud; its green runs were 100% skipped steps). Lovable IDE is
            the ONLY edge-function deploy path. Never assume GitHub CI deploys any
            Supabase resource for this repo.
  Claude Code → src/ AND supabase/functions/ editing when explicitly
                directed by Cynthia. Default mode is read-only audit
                and diagnosis. May commit and push to git when asked.
  Cloud Shell → git operations only (pulls, merges, pushes, repo
                audits). Cynthia has NO direct Supabase deployment
                access — NEVER suggest `npx supabase functions deploy`
                from Cloud Shell. If a function appears stale,
                escalate to Lovable to redeploy via Supabase
                Dashboard tooling.
  Supabase SQL Editor → database changes only (pure SQL)

  Practice rules (apply to both Lovable and Claude Code):
  - No prompt written without plan confirmed first.
  - No step executed without explicit go signal from Cynthia.
  - SQL changes are applied in the SQL Editor by Cynthia and are NOT
    committed to repo as migrations unless explicitly told to.

  CLAUDE.md is the single source of truth — both Lovable and
  Claude Code must read it before any changes.

## Active Features

### Product Inquiry Tracker (added 2026-06-12)

- Route: `/inquiries` (sub-item under CSR Monitoring sidebar)
- Tables: `product_inquiries`, `inquiry_dropdown_options`
- Permission keys: `view_inquiries` + `manage_inquiries` (all 4 roles, is_allowed=true)
- 805 rows migrated from Google Sheet on 2026-06-12 (803 initial + 2 multi-category source rows recovered)
- `order_placed` backfilled from source CSV on 2026-06-12 (No 367 / Yes 85 / Joy Mine 3 / null 350)
- Two tabs: Inquiry List (filterable + paginated table, add/edit) + Demand Map (Top 20 bar chart + quadrant scatter)
- All dropdowns configurable via `inquiry_dropdown_options` with inline + Add in form
- No edge functions. No deploys needed.

### Timesheet — BUILT & LIVE (see docs/TIMESHEET-SPEC.md, docs/SYSTEM-STATUS.md)

- Staff monthly timesheet under CSR Operations → Timesheet (`/timesheet`). Pure-TS pay engine + RLS, no edge function.
- Spillover rows count toward the month (NOT display-only) — see docs/TIMESHEET-SPEC.md "31-row grid & spillover".
- Schema + RLS detail: docs/SCHEMA-FACTS.md "Timesheet tables".

## Project Overview

Jewelry layaway management system built with:

- React + TypeScript
- Tailwind CSS
- Supabase (database + edge functions)
- Vite

## Key Files to Read First

- src/lib/business-rules.ts (calculation engine)
- src/components/AccountDetail.tsx (main account view)
- src/components/MultiInvoicePaymentDialog.tsx (split payment)
- supabase/functions/ (edge functions)

## Core Calculation Rules (NEVER change these)

All values come from computeLayaway() in business-rules.ts

  totalLAAmount = baseLA + non-waived penalties + services
  totalPaid = downPayment + Σ(actualPaid of PAID/PARTIAL months)
  remainingBalance = totalLAAmount - totalPaid

## Display Rules (NEVER break these)

### Dates

  Schedule list → always show due_date (when payment is due)
  Payment History → always show created_at (when payment was made)
  NEVER mix these two

### Amounts

  - Drop .00 on whole numbers: ₱3,956 not ₱3,956.00
  - Keep 2 decimals when non-zero: ₱22,103.27
  - Always use ₱ symbol
  - Comma separators: ₱22,103.27
  - Never show ₱0 penalties

### Customer Message Templates

  SINGLE PAYMENT:
  Thank you for your payment. ₱ [amount] has been received.
  Inv # [invoiceNumber]
  View your updated account and payment schedule here:
  🔗 [portalLink]
  🔐 Your portal PIN is the last 4 digits of your mobile number on file: [pin]   (only for legacy token-link customers — omitted when auth_user_id is set)
  Next payment: [nextDueMonth] — ₱ [nextMonthAmount]
  Thank you for your continued trust in Cha Jewels! 🧡

  ---

  SPLIT PAYMENT (2+ accounts same customer):
  Thank you for your payment. A total of ₱ [totalAmount]
  has been received across [N] accounts:
    Inv #[num] — [label]: ₱ [amount]
    Inv #[num] — [label]: ₱ [amount]
  View your accounts here:
  🔗 [portalLink]
  🔐 Your portal PIN is the last 4 digits of your mobile number on file: [pin]   (only for legacy token-link customers — omitted when auth_user_id is set)
  Next payments:
    [label] — [nextDueMonth]: ₱ [nextDueAmount]
    [label] — [nextDueMonth]: ₱ [nextDueAmount]
  Thank you for your continued trust in Cha Jewels! 🧡

  ---

  FULLY PAID:
  Same as single but replace next payment line with:
  🎉 Your layaway is now fully paid! Thank you!

  ---

  BATCH PAYMENT (individual account after multi-invoice):
  Your account has been updated.
  Inv # [invoiceNumber]
  View your account here:
  🔗 [portalLink]
  Thank you for your continued trust in Cha Jewels! 🧡

## Monthly Row Display Rules

  IF penalty > 0 AND not waived:
    ✅ Nth month Mon YY: ₱ [base] + ₱ [penalty] (Penalty) = ₱ [total] (PAID)
  IF no penalty or waived:
    ✅ Nth month Mon YY: ₱ [base] (PAID)
  Never show "+ ₱0 (Penalty)"

## Payment Recording Rules

Every payment operation must update ALL 3 tables atomically:
  1. payments table — insert actual cash received
  2. schedule_items — update paid_amount and status
  3. penalty_fees — update status if penalty was paid

Never update one without the others.
Use edge functions with transactions to ensure atomicity.
If any of the 3 updates fail, roll back all of them.

## Ghost Amount Prevention

When completing a partially_paid month:
  - Set paid_amount = total_due_amount exactly
  - Set status = 'paid'
  - Never carry over excess to next month
  - Next month stays pending with paid_amount = 0

## SYSTEM INVARIANTS (permanent — never violate)

  INVARIANT 1 — total_paid source:
    ONLY: SUM(payments.amount_paid WHERE voided_at IS NULL)
    NEVER: payment_allocations or layaway_schedule.paid_amount

  INVARIANT 2 — per-row remaining source:
    ONLY: schedule_with_actuals.actual_remaining
    NEVER: layaway_schedule.total_due_amount or paid_amount

  INVARIANT 3 — waterfall order:
    ALWAYS: earliest actual_remaining > 0 first (due_date ASC)
    NEVER: skip a month with actual_remaining > 0

  INVARIANT 4 — payment ceiling:
    NEVER accept payment > account.remaining_balance

  INVARIANT 5 — carry-over storage:
    ONLY: layaway_schedule.carried_amount via carry-over edge function
          (manual staff action)
    NEVER: inflate total_due_amount on any row
    NEVER: write carried_amount from accept-underpayment
    NEVER: write carried_amount automatically on underpayment

  INVARIANT 6 — total_paid direction:
    INCREASES: record-payment only
    DECREASES: void-payment only
    NEVER decreases via reconcile-account

  INVARIANT 7 — base_installment_amount:
    Set at schedule creation only
    NEVER modified after creation under any circumstance
    Enforced by DB trigger: prevent_base_amount_change

  INVARIANT 8 — paid schedule row freeze:
    Once layaway_schedule.status = 'paid', these fields are frozen:
    status, paid_amount, total_due_amount
    Enforced by DB trigger: enforce_paid_row_freeze
    Rules:
    - Rule 1: bypass flag app.allow_paid_row_edit = 'true' allows all changes
    - Rule 2: paid_amount decreasing → allowed (void-payment)
    - Rule 3: paid_amount increasing within ceiling → allowed (restore-payment)
    - Rule 4: paid_amount increasing beyond ceiling → BLOCKED (waterfall over-allocation)
    NEVER modified by: waterfall, reconcile, Keep handler, carry-over

  INVARIANT 9 — total_amount admin-only writes:
    total_amount on layaway_accounts can only be changed by admin.
    Enforced by DB trigger: prevent_total_amount_change
    Bypass: app.allow_total_amount_edit = 'true' (edge functions only)
    NEVER modified by: non-admin users, direct PostgREST calls
    Edge functions with bypass:
    - add-installment (admin only, bypass flag set)
    - delete-installment (admin only, bypass flag set)
    - add-service (admin only, bypass flag set)
    Client-side writes: NONE — all routes through edge functions

  INVARIANT 10 — loyalty award basis:
    Award amount is derived from layaway_accounts.loyalty_jpy_amount
    (committed at account creation = full layaway commitment), NOT from
    payment.amount_paid. Editing payment amount does not adjust loyalty.
    Voiding an installment payment does not revoke loyalty (only DP voids
    do, per CLAUDE.md DP detection heuristic). See LOYALTY LIFECYCLE
    INTEGRATION section for full lifecycle wiring.

  INVARIANT 11 — DP allocation (updated 2026-07-06, Bug #250):
    DP payments up to the account's downpayment_amount create NO
    payment_allocations against schedule rows. DP paid in EXCESS of
    downpayment_amount WATERFALLS into installments (Month 1 onward)
    exactly like an installment payment — real payment_allocations,
    schedule paid_amount updated. The split happens in
    allocate_payment_atomic: for a DP payment it computes the excess
    over downpayment_amount (counting prior non-voided DP payments) and
    feeds ONLY that excess into the existing waterfall; the required
    portion is recorded as a payment (INVARIANT 1) with no allocation.
    DP detection: reference_number starts with 'DP-' OR remarks ILIKE
    '%down%' (non-voided).
    Void path (void-payment) already unwinds correctly: it deletes the
    voided payment's allocations and recomputes each affected schedule
    row's paid_amount from remaining non-voided allocations — a voided
    excess-bearing DP therefore reverses its Month 1+ allocation
    automatically. No void-path change was needed.
    audit_account no longer subtracts DP overage from v_sum_pending
    (the excess now lives in schedule rows and is already counted).
    See Bug #160 (edit-payment-amount guard) and Bug #250 in
    docs/FIXED-BUGS.md.

## TIMEZONE STANDARD — NON-NEGOTIABLE (updated 2026-04-25)

  Canonical timezone: PHT (Asia/Manila, UTC+8)
  All date comparisons use PHT midnight as the day boundary.

  Frontend: import getPHTToday() from src/lib/date-utils.ts
    NEVER use: new Date().toISOString().split('T')[0]
    NEVER use: Asia/Tokyo — that is JST (UTC+9), not PHT
    ALWAYS use: getPHTToday() for any "today" date string

  Edge functions (Deno):
    NEVER use: new Date().toISOString().split('T')[0]
    ALWAYS use: Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Manila'
    }).format(new Date())

  Display timestamps:
    ALWAYS use: formatPHTDisplay() from date-utils.ts
    Show 'PHT' suffix on all displayed timestamps
    RefreshControl "Last updated" must show PHT time

  Cron jobs (all times are UTC, PHT = UTC+8):
  Jobs run in strict dependency order every morning:

    daily-send-reminders:          00:00 UTC = 08:00 PHT ✅
    daily-penalty-engine:          00:05 UTC = 08:05 PHT ✅
    daily-auto-forfeit:            00:10 UTC = 08:10 PHT ✅
    daily-reconciliation:          00:20 UTC = 08:20 PHT ✅
    loyalty-inactivity-check:      00:25 UTC = 08:25 PHT ✅
    auto-expire-cash-orders:       00:30 UTC = 08:30 PHT ✅
    deactivate-expired-promotions: every hour            ✅
    loyalty-notification-queue:    every hour            ✅
    fc-alert-evaluation:           every 30 minutes      ✅
    process-email-queue:           every 5 seconds       ✅
    cleanup-loyalty-images:        Sun 03:00 UTC = Sun 11:00 PHT ✅

  ORDERING RULE — never violate this sequence:
    1. Reminders fire first (before penalties)
    2. Penalty engine runs after reminders
    3. Auto-forfeit runs after penalty engine
    4. Reconciliation runs after forfeitures
    5. Loyalty inactivity check runs last
       (needs fully reconciled account data)
    6. daily-reconciliation must never be scheduled
       before 00:15 UTC

  RACE CONDITION RULE (RETIRED 2026-05-20):
    The duplicate daily-payment-reminders cron was removed
    2026-05-20 — daily-send-reminders is now the sole reminder
    cron. The 2-minute offset rule no longer applies. NEVER
    re-add a second cron pointing at /send-reminders — see
    EMAIL SENDING — LOVABLE WORKSPACE RATE LIMIT for why.

  CRON AUTH RULE (added 2026-06-05):
    Any pg_cron job calling a service-role-gated edge function MUST
    use the Vault-backed service key — never an embedded key.
    Pattern: the cron body resolves the key at fire time via
      (SELECT decrypted_secret FROM vault.decrypted_secrets
        WHERE name = 'email_queue_service_role_key')
    and passes it as `Authorization: Bearer <key>` to pg_net's
    outbound POST. Embedded keys (anon, dashboard-pasted service
    role) drift out of sync with the runtime
    `SUPABASE_SERVICE_ROLE_KEY` env value over time (Supabase's
    `sb_secret_*` rollout, key rotations, security passes that
    tighten gates) and silently 401 at every tick.
    Canonical adopters: loyalty-sheet-reconcile, process-email-queue,
    fc-alert-evaluation, daily-penalty-engine, daily-auto-forfeit.
    When adding a new cron, copy the Vault pattern from one of
    those; do not hand-edit the Authorization header to anything
    else. See `docs/LOYALTY-OPERATIONS.md` for the full SQL snippet.

  EDGE FUNCTION SERVICE-ROLE AUTH PATTERN (locked — added 2026-06-06):
    Inside a service-role-gated edge function, identify the caller
    via JWT claims, NOT string equality:
      if (parseJwtClaims(token)?.role !== "service_role") { return 401; }
    Run behind gateway `verify_jwt = true` in `supabase/config.toml`
    so the signature is validated before the handler executes.
    NEVER write `token === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")`:
    Vault-stored keys and env-injected keys are both valid
    same-project `service_role` JWTs but may not be string-identical
    (different issuance times, different signing rotations) — the
    equality check rejects legitimate Vault-backed cron callers and
    breaks the nightly suite. Shared helper:
    `supabase/functions/_shared/jwt-claims.ts` (`parseJwtClaims`).
    Root-caused as Bug #168 (2026-06-06, commit `04a7f47`).

    SHARED-HELPER CONVENTION (locked — added 2026-07-05):
    NEW edge functions, and any existing function being edited for
    other reasons, MUST use _shared/cors.ts (corsHeaders/corsPreflight/
    jsonResponse) and _shared/handler.ts (requireAuth/requirePermission)
    instead of inline copies. The fleet converges opportunistically —
    no dedicated migration batches.

    NEVER accept the anon key as an internal-bypass credential, and
    NEVER allow a missing Authorization header to skip the gate
    (added 2026-06-06 after Bug #170):
      - `SUPABASE_ANON_KEY` is shipped in every browser bundle —
        treating an `isInternalKey = (token === SUPABASE_ANON_KEY)`
        match as authorization is equivalent to no auth at all. Any
        caller can copy the anon key out of the public bundle and
        mint the bypass header.
      - An `if (authHeader) { …gate… }` wrapper is NOT a gate — a
        request with no Authorization header skips the entire check
        and reaches the handler. The Authorization header MUST be
        mandatory; reject with 401 when missing or malformed before
        any other work.
      - For functions that mutate account/financial state via a user
        action (System Health "fix" entry points, admin-only repair
        RPCs, etc.), pair the JWT validation with a real role or
        permission check (`hasPermission(user.id, '<permission_key>')`)
        — `getUser()` succeeding only proves the caller has *some*
        valid session, not the right to mutate. Reject with 403 on
        permission failure.
      Root-caused as Bug #170 (2026-06-06, commit `28bc07e`,
      deployed 2026-06-06 09:15 UTC).

    Service-role-only functions using this claims gate (added
    2026-06-07, commit `b1e41d3`): `sync-loyalty-to-sheet` —
    callers are loyalty edge functions (`adjust-loyalty-points`,
    `award-loyalty-points`, `loyalty-inactivity-check`,
    `loyalty-sheet-reconcile`, `process-loyalty-redemption`) +
    `customer-portal`; all send `Bearer` env service role key.
    `append-cash-receipt` — caller is `review-payment-submission`
    (internal only). Both also `verify_jwt = true` in
    `supabase/config.toml`.

    User-permission-gated edge functions (staff frontend callers
    only, no service-role path): `fix-account-status` — requires
    valid user JWT + `hasPermission(user.id, 'system_health')`.
    `system-health-check` — requires valid user JWT + `user_roles`
    IN (`admin`, `staff`, `finance`, `csr`).
    `get-page365-order` — requires valid user JWT + `user_roles`
    IN (`admin`, `staff`, `finance`, `csr`). Only caller:
    `InvoiceGeneratorSheet.tsx` (`invoke`).
    Never reintroduce an `isInternalKey` or anon-key bypass on
    any of these.

    `verify-portal-pin` — public-facing endpoint, **no**
    `verify_jwt = true` (intentional). Auth handled internally
    by `resolvePortalAuth`. PIN data lives in `customer_pins`
    table — NOT `customers`. `customers` is queried for `id` +
    `mobile_number` only. PIN hashing: PBKDF2-SHA256, 100,000
    iterations, 16-byte salt, format
    `pbkdf2:{saltHex}:{hashHex}`. Legacy SHA-256 hashes migrate
    on next successful login. Never revert to SHA-256. Never
    move PIN columns back to `customers`.

    `customer_pins` table (added 2026-06-07, Bug #177): RLS
    enabled, no SELECT policy for `authenticated`. Only
    `service_role` can read (via RLS bypass).
    `portal_pin_hash`, `portal_pin_attempts`,
    `portal_pin_locked_until` were DROPPED from `customers` on
    2026-06-07. Do not add PIN columns back to `customers`
    under any circumstances.

    `fix-account-totals` — service-role-only gate. No frontend
    or edge-function callers. Manually-triggered admin utility
    that rewrites `total_paid`, `remaining_balance`, schedule
    `paid_amount`, and allocation records across active accounts;
    must stay behind the service-role claims gate +
    `verify_jwt = true`.

## DISPLAY RULES (permanent)

  ALL schedule display reads from schedule_with_actuals view
  actual_remaining → only source for per-row remaining
  allocated        → only source for per-row paid amount
  computed_status  → only source for row status in display
  paid_amount and total_due_amount → write-only caches, never read for display
  All next-payment logic → getNextPaymentRow() from business-rules.ts
  All pending sum logic  → sumPendingRows() from business-rules.ts
  No inline reimplementation of canonical functions permitted

## CHART TERMINOLOGY (display convention — added 2026-05-23)

Consistent labels across the Finance dashboard. The underlying metrics are unchanged — only the labels were standardized.

  "Collected" / "Total Collected" = cash actually received, bucketed by PAYMENT DATE.
    Source: get_monthly_analytics.collected_jpy (SUM payments by date_paid) and
    get_collection_analytics.collected. Shown in: Overview Monthly Performance bar/stat,
    and the Analytics "Collected vs Sales" chart.

  "Paid vs Due" chart = collection efficiency against the schedule.
    "Paid" = collected_due (payments allocated to each month's installments, bucketed by
    DUE month, capped at expected). "Due" = expected. Drives Best Month / Average Rate.
    (Formerly mislabeled "Collected vs Expected", which collided with the cash "Collected".)

  "Penalties Collected" = penalty_fees WHERE status='paid'. Same metric on both Overview
    and Analytics (Overview's former "Penalties Paid" was renamed to match).

  Forfeited — two DIFFERENT metrics, do not conflate:
    "Total Forfeited" (Overview) = remaining balance LOST on forfeited/final_forfeited accounts.
    "Recovered (Forfeited)" (Analytics) = cash COLLECTED from forfeited accounts before
    forfeiture (6-month window, excludes final_settlement).

  RULE: "Collected" always means cash received. The schedule-efficiency metric is "Paid vs Due",
  never "Collected".

## REALTIME SYNC (added 2026-05-24)

  supabase_realtime publication now contains: payments,
  payment_allocations, layaway_schedule, layaway_accounts, penalty_fees,
  payment_submissions, account_services, financial_alerts,
  loyalty_members, loyalty_transactions, staff_notifications,
  service_jobs, trade_ins (2026-07-05 — the last two were repairs of
  SYNC_TABLES entries that had never been published, so their
  subscriptions were dead).

  useRealtimeSync (src/hooks/useRealtimeSync.ts) is rendered once at the
  App root (inside AuthProvider/PermissionsProvider, sibling of Routes,
  via the RealtimeSyncMount wrapper in src/App.tsx) and is gated on the
  internal-user predicate (session && roles.length > 0 — the same signal
  ProtectedRoute admits internal admin/staff/finance/csr users with). The
  customer portal and unauthenticated visitors never open a channel.

  On any postgres_changes event from the SYNC_TABLES it invalidates
  REALTIME_INVALIDATE_KEYS — the union of CORE_KEYS, PAYMENT_KEYS,
  MONITORING_KEYS, SUBMISSION_KEYS, SERVICES_KEYS, LOYALTY_KEYS,
  NOTIFICATION_KEYS, plus 'account' and 'customer-detail'
  — debounced 250ms so a burst of writes coalesces into one refetch
  round. Every actively-rendered internal dashboard card refetches live
  without a manual reload.

  When adding a new mutating table or a new dashboard query key:
    - If the table drives a card, add it to SYNC_TABLES.
    - If the key isn't covered by any of the four KEY groups, add it to
      one of them (so it's swept into REALTIME_INVALIDATE_KEYS).

## TEAM MEMBER LIFECYCLE (added 2026-05-24)

  Members are created via create-team-member (auth user + user_roles row).

  Deactivate / reactivate go through the same function:
    action: 'deactivate' | 'reactivate'  (admin/manage_team gated)
  - deactivate: profiles.status='inactive' + auth ban (ban_duration set);
    user_roles row KEPT so the member stays listed and reactivatable, and
    historical attribution (created_by_user_id, audit logs, etc.) is
    preserved. Self-deactivation is blocked.
  - reactivate: profiles.status='active' + auth unban.

  Effect on session: re-login is blocked immediately; any live session
  dies on next token refresh.

  user_status enum = active | inactive | suspended.

  There is no hard delete — it would orphan ~40 attribution columns,
  most without FKs. Deactivate is the supported delete-equivalent.

  create-team-member stamps user_metadata.is_team_member=true on the
  auth user; the on_auth_user_created → handle_new_user trigger inserts
  a profiles row ONLY when
  `COALESCE(NEW.raw_user_meta_data->>'is_team_member','false') = 'true'`
  (key present AND value true), so self-signup customers (Phase B) never
  get a profile and never leak into team lists (Bug #151).

  Session idle-timeout (2026-05-26): 2h inactivity auto sign-out with a
  5-minute warning modal, enforced in AuthContext for ALL authenticated
  sessions — both the internal app and the customer portal. Resets on
  mouse/key/click/scroll/touch. Frontend-enforced (Supabase Auth
  otherwise keeps sessions alive via token refresh).

## VIEW FIELD MAPPING

  schedule_with_actuals vs layaway_schedule (write-only cache):
    OLD paid_amount       → NEW allocated
    OLD total_due_amount  → NEW actual_remaining (for display)
    OLD status            → NEW computed_status (display) / db_status (writes)

## CARRY-OVER RULES (updated 2026-03-29)

  Underpayment default behavior:
    When a payment underpays a month, the row is marked 'partially_paid'.
    The next row is COMPLETELY UNTOUCHED — no carry is written automatically.
    This is enforced in review-payment-submission (auto-carry removed 2026-03-29).

  Carry-over is a MANUAL STAFF DECISION ONLY:
    Staff clicks the "Carry Over" button on a partially_paid row in AccountDetail.
    This calls the carry-over edge function (NOT accept-underpayment).

  carry-over edge function (updated 2026-04-19):
    Endpoint: /functions/v1/carry-over

    total_due_amount formula:
      CORRECT: total_due_amount = existing_total_due_amount + shortfall
      WRONG:   total_due_amount = base_installment_amount + shortfall
      This preserves all previous Keep reductions on the destination row.
    Body: { schedule_row_id, account_id }
    Auth: Bearer token + confirm_payment permission via checkPermission (matrix-driven; overrides respected)
    Steps:
      1. Validates source row status === 'partially_paid'
      2. Validates source row paid_amount > 0
      3. Computes shortfall from source.paid_amount (NOT SUM of allocations)
         shortfall = ceiling (base + penalty + carried) - paid_amount
      4. Finds next row by installment_number + 1
      5. Marks source row as 'paid' with paid_amount preserved
      6. Writes carried_amount = shortfall to next row, clears carried_by_payment_id
      7. Reverts step 5 if step 6 fails
    Net effect: source row closes as paid, next row carries the shortfall

  accept-underpayment edge function:
    Purpose: Records AUDIT LOG only when staff acknowledges an underpayment
    What it does NOT do: Does NOT write carried_amount, does NOT mark source
    row as paid, does NOT touch next row
    Net DB effect: Zero row changes — audit log entry only

  carried_amount column:
    Written ONLY by the carry-over edge function
    Cleared by void-payment when a payment that triggered carry is voided
    NEVER written by accept-underpayment
    NEVER written by inflating total_due_amount
    NEVER written automatically on underpayment

  FORBIDDEN:
    - Auto-carry on underpayment
    - Inflating total_due_amount on any row
    - Writing carried_amount from accept-underpayment
    - carried_amount written when source row is still partially_paid
    - Running carry-over on a paid source row (must be partially_paid)
    - Writing carried_amount without a valid carried_from_schedule_id
    - Writing carried_amount when source row paid_amount = 0
    - Adding services separately to remaining_balance (services are in total_amount)

## CARRIED_AMOUNT PRESERVATION (added 2026-05-21)

  total_due_amount = base_installment_amount + penalty_amount + carried_amount
  on EVERY recompute. carried_amount is part of the row's full obligation and
  must be re-added whenever total_due_amount is rewritten.

  Recompute sites: penalty-engine (Step 5 + Step 5b self-heal), add-penalty, approve-waiver.

  INVARIANT 5 ("never inflate total_due_amount") means never inflate WITHOUT a
  backing carried_amount/allocation — including the legitimate carried_amount is REQUIRED, not forbidden.

  FRONTEND BINDING: This rule applies to ALL total_due_amount writers, including direct frontend .update() calls (e.g. Waivers.tsx, ApplyPenaltyCapDialog.tsx) — not only edge functions. Any recompute of an EXISTING schedule row's total_due_amount MUST be base_installment_amount + penalty + carried_amount. The ONLY exemption is inserting a brand-new installment row (no carry exists yet) — e.g. EditAccountDialog "Add new installments", where total_due = base is correct.


## CUSTOMER CODE STANDARD (added 2026-04-19)

  Format: CJ-YYYY-XXXXX
  - CJ = Cha Jewels
  - YYYY = year customer was created
  - XXXXX = 5-digit sequential number incrementing by 8 per year
  - Example: CJ-2026-00008, CJ-2026-00016, CJ-2026-00024

  Auto-generated by DB trigger: auto_generate_customer_code
  BEFORE INSERT on customers table
  All 484+ existing customers backfilled ✅

  Used for cross-platform synchronization with Loyalty App.
  This is the universal customer identifier across all Cha Jewels platforms.

### Forensic repair (manual customer_code edits)

  If a customer_code is ever corrupted (e.g., a row backfilled
  from an external source with malformed data, or a manual
  override before the EditCustomer lock landed on 2026-04-28),
  the only repair path is direct SQL Editor.

  After the prevent_customer_code_change trigger landed
  (2026-05-08), forensic repairs require a transaction-scoped
  GUC bypass via SET LOCAL. Without it, the UPDATE fails with:
  "customer_code is immutable post-creation..."

    BEGIN;
    SET LOCAL app.allow_customer_code_change = 'on';
    UPDATE public.customers
       SET customer_code = 'CJ-YYYY-XXXXX'
     WHERE id = '<uuid>';
    INSERT INTO public.audit_logs
      (entity_type, entity_id, action,
       old_value_json, new_value_json,
       performed_by_user_id)
    VALUES ('customer', '<uuid>',
            'manual_customer_code_repair',
            jsonb_build_object('customer_code', '<old>'),
            jsonb_build_object('customer_code', 'CJ-YYYY-XXXXX'),
            auth.uid());
    COMMIT;

  EditCustomerDialog UI does NOT allow customer_code edits
  (locked 2026-04-28 after the Charm Monaka incident — see
  Known Fixed Bugs #54).

## PENALTY STANDARD — NON-NEGOTIABLE (added 2026-04-12)

### PHP accounts:
  - Week 1: ₱500 per event
  - Week 2: ₱500 per event
  - Non-final months (months 1 to n-1): cap ₱1,000 (2 events — Cycle 1 only)
  - Final month only (installmentNumber === planMonths): cap ₱3,000 (6 events — Cycles 1+2+3)

### JPY accounts:
  - Week 1: ¥1,000 per event
  - Week 2: ¥1,000 per event
  - Non-final months (months 1 to n-1): cap ¥2,000 (2 events — Cycle 1 only)
  - Final month only (installmentNumber === planMonths): cap ¥6,000 (6 events — Cycles 1+2+3)

### Grace period rule (updated 2026-04-13):
  - Grace period (7 days) is NOT permanently consumed.
  - It applies when ALL of these are true:
    * Account has an overdue row within 7 days of due date
    * No UNPAID penalties exist on any schedule row
    * No other rows are overdue or partially_paid
  - Grace RESETS when account is fully caught up:
    * All schedule rows paid
    * No unpaid penalties on any row
  - When fully caught up and goes overdue again → grace applies again
  - Waived penalties do NOT count against grace
  - Paid penalties do NOT count against grace

  Implemented in:
    supabase/functions/penalty-engine/index.ts (week1Offset = graceConsumed ? 0 : 7)
    src/pages/AccountDetail.tsx (isInGracePeriod display)

### Penalty trigger schedule (per overdue month):
  Cycle 1: week1:1 → due_date + 7 (or +0 if grace consumed), week2:1 → due_date + 14
  Cycle 2: week1:2 → due_date + 1 month, week2:2 → due_date + 1 month + 14 days
  Cycle 3: week1:3 → due_date + 2 months, week2:3 → due_date + 2 months + 14 days
  (Final month only gets Cycles 2 and 3 — non-final months cap at Cycle 1)

### Penalty engine timing:
  Cron: 00:05 UTC daily (= 8:05 AM PHT)
  Due date filter: due_date <= today (includes the due date itself)
  Penalties apply ON the due date at 8 AM PHT — the grace period is
  the customer's consideration time, not the filter.

### Freeze guard:
  Accounts with pending payment submissions (status='submitted' or 'under_review')
  are frozen — no new penalties until the submission is resolved.

## FORFEITURE STANDARD — NON-NEGOTIABLE (added 2026-04-12)

### Status flow:
  OVERDUE → FORFEITED → EXTENSION_ACTIVE → FINAL_FORFEITED

### PATH 1 — Final month penalty cap reached:
  Condition: final month penalty total >= cap (₱3,000/¥6,000)
             AND final month due_date <= today
  Effect: account status → 'forfeited', unpaid schedule rows → 'cancelled'
  No 90-day payment guard on this path.

### PATH 2 — 3 calendar months overdue:
  Condition: first unpaid due date is 3+ calendar months ago (day-level precision)
             AND last non-voided payment > 90 days ago (safety guard)
  Effect: account status → 'forfeited', unpaid schedule rows → 'cancelled'

### 90-day payment safety guard (clarified 2026-05-15):
  The safety guard "last non-voided payment > 90 days ago" applies to BOTH PATH 2
  AND PATH 3 (not just PATH 2 as originally documented). Implementation puts this
  guard in the per-account loop BEFORE either path check, so any account with a
  payment within 90 days is skipped entirely. This is intentional — keeps recently-
  paying customers out of auto-forfeit regardless of overdue duration or penalty count.

### PATH 3 — 6th penalty occurrence → final_settlement:
  Condition: total penalty_fees rows (unpaid + paid) across all unpaid months >= 6
             AND no existing final_settlement_records for this account
             AND last non-voided payment > 90 days ago (shared safety guard with PATH 2)
  Effect: creates final_settlement_records, account status → 'final_settlement'
          Schedule rows are NOT cancelled (stay in 'overdue' status) — only PATH 1
          and PATH 2 (true forfeits) cancel unpaid schedule rows.
  Empirical verification: confirmed 2026-05-15 on fixture CJ-2026-FORFEIT-PATH3-NEW.
  Loyalty preserved per Bug #101 fix — lot stays ACTIVE, no revoke transaction
  logged, cumulative_spend_jpy unchanged.

  Fixture forensic note (2026-05-18): the fixture's account-side state remains
  intact and matches PATH 3 expectations. Loyalty-side data (loyalty_member,
  loyalty_point_lot, loyalty_transactions) was subsequently removed from the
  database between 2026-05-15 and 2026-05-18. The only migration in the
  20260515-20260518 window (20260516010044) drops three loyalty auto-award
  DB triggers and does not delete any rows. The data wipe was therefore not
  migration-driven — most likely a manual SQL cleanup, edge function call, or
  direct admin action, with no audit trail captured in session history. Admin
  UI for customer CJ-2026-05456 ("Test Path3 Customer") confirms "Not enrolled"
  in the Loyalty tab as of 2026-05-18. The 2026-05-15 empirical verification
  stands as proof of record; re-verification on this fixture is not possible
  without rebuilding the loyalty side.

### After forfeiture:
  - Admin can grant ONE-TIME extension → status = 'extension_active'
  - Extension has an end date (typically 1 month)
  - extension_active + extension expires → 'final_forfeited' (PERMANENT)
  - extension_active + extension month penalty cap reached → 'final_forfeited' (PERMANENT)
  - FINAL_FORFEITED blocks all further negotiation/reactivation

  Extension request window (customer portal):
  - Customer can request extension from portal within 7 days of forfeiture
  - Reference date: layaway_accounts.forfeited_at (timestamptz column)
  - forfeited_at is set by auto-forfeit-settlement (PATH 1 and PATH 2)
    and manual-forfeit edge functions
  - After 7 days: hide request button, show message:
    "The extension request window has closed. Please contact us directly
     for assistance."
  - Within 7 days: show "Request Extension" button
  - Once request submitted: button disabled, shows "Extension Request Pending"
  - Extension requests stored in: extension_requests table
  - Admin reviews in: CSR Monitoring → Extensions tab

### Independence rule:
  penalty-engine and auto-forfeit-settlement are INDEPENDENT
  — neither calls the other. Penalty engine creates penalties;
  auto-forfeit-settlement checks forfeiture conditions.

## TRADE PROGRAM — NON-NEGOTIABLE (added 2026-05-31)

### Overview
Trade Program lets fully-paid layaway customers exchange their item for a new piece. The is_trade flag on layaway_accounts and cash_orders identifies accounts/orders that originated from a trade transaction. Policy: https://chajewelstrade.chajewelsjp.com/

### is_trade flag rules
  - Set at creation only — LOCKED after creation, never editable via app UI
  - Admin override via SQL Editor is permitted for one-time backfills only
  - Pure metadata — has NO effect on calculations, payments, penalties, forfeiture, or any business rule
  - Default false on all accounts

### Display
  - "🔄 Trade" amber Badge rendered next to status pill in AccountDetail + CashOrderDetail headers
  - Visible to all roles when is_trade=true
  - No badge column in list tables (admin decision — keeps lists clean)

### Metric definitions (Finance Overview KPI cards + trend chart)
  - Active Trade: is_trade=true AND status IN ('active','overdue','extension_active','reactivated') — LAYAWAY ONLY (cash orders have no in-progress state, only completed/cancelled)
  - Total Trade: is_trade=true AND status::text != 'cancelled' — layaway + cash orders combined
  - Completed Trade: is_trade=true AND status='completed' — layaway + cash orders combined
  - Total Trade Value (JPY): SUM(total_amount) WHERE is_trade=true AND status::text != 'cancelled', PHP converted via ÷ php_jpy_rate
  - Trade Share %: (Total Trade count) / (All non-cancelled accounts count, layaway + cash combined) × 100

### RPCs (Supabase SQL Editor)
  - get_trade_kpis() → jsonb { active_count, total_count, completed_count, total_value_jpy, share_percent, all_accounts_count }
  - get_trade_monthly_trends(p_months_back int DEFAULT 12) → TABLE (month text, trade_count int, trade_value_jpy numeric); date basis: COALESCE(order_date, created_at::date); excludes cancelled

### UI surfaces (locked decisions)
  - Creation: "Trade Program" checkbox in NewAccount.tsx + NewCashOrder.tsx with amber tint when checked and policy link
  - Detail badge: amber-styled Badge next to status pill in AccountDetail.tsx + CashOrderDetail.tsx
  - Finance > Overview: 3 KPI StatCards (Trade Accounts / Total Trade Value / Trade Share) between Cash Orders row and AgingBuckets
  - Finance > Overview: TradeProgramTrends dual-line Recharts chart below MonthlyAnalyticsChart

## ACCOUNT-SCOPE COVERAGE — NON-NEGOTIABLE (added 2026-06-05)

Account-scoped features, notifications, and audits MUST cover BOTH
`layaway_accounts` AND `cash_orders` — cash orders are first-class
accounts. This applies to:

  - DB triggers that emit `staff_notifications` for "account
    created" / similar lifecycle events
  - Reporting RPCs, dashboard KPIs, and money roll-ups
  - Test-account exclusion (numeric invoice_number regex)
  - Audit panels, drift checks, and ad-hoc operator queries
  - Frontend list/detail surfaces and search

When adding a new account-scoped surface, the default question is
"how does this behave for cash orders?" not "do cash orders apply?".
Trade Program, staff_notifications triggers, and Finance Overview
KPIs are the canonical examples — see TRADE PROGRAM section above
(both tables carry `is_trade`) and the staff_notifications trigger
inventory in docs/SYSTEM-STATUS.md (2026-06-05 entry).

## SIDEBAR ARCHITECTURE — NON-NEGOTIABLE (added 2026-05-31)

### Item types
Two kinds of sidebar items in src/components/layout/AppSidebar.tsx:
- **Leaf items** (Dashboard, Executive Dashboard, Admin Audit): direct Link to path
- **Parent items with sub-menus** (Customers, CSR Monitoring, Finance, Promotions, Loyalty, Settings): collapsible group with children that navigate via ?tab= query param

### MenuItem type contract
  type SubMenuItem = { label, tab, badgeKey?, permFilter? }
  type MenuItem = { label, icon, path? (leaf), parentPath? (parent), children?, adminOnly?, permPath? }

### Navigation convention
- Sub-item links: `${parentPath}?tab=${child.tab}`
- Each parent page reads ?tab from URL via useSearchParams and switches active tab
- Refresh, deep links, browser back/forward all stay in sync with active tab
- Sub-item label is text-only (no icons) — keeps Loyalty's 12 sub-items readable

### Tab URL sync pattern (applied to all 6 parent pages)
Customers, Monitoring, Finance, Promotions, LoyaltyAdmin, SettingsPage all use this pattern:
  - Initialize tab state from searchParams.get('tab') with fallback to default
  - setTab wraps both local state update + setSearchParams(..., { replace: true })
  - useEffect on [searchParams] mirrors external URL changes to local state
LoyaltyAdmin reads directly from searchParams each render (alternative pattern, equivalent effect).

### Accordion behavior
- Hover-based: only one parent expanded at a time
- Hover on parent → that parent expands, all others collapse
- Hover on leaf → all parents collapse
- Click on parent → toggles (close if open; open + close others if closed)
- Auto-expand on path match: navigating to /parentPath opens that parent automatically

### Permission gating
- `adminOnly` on MenuItem hides whole parent
- `permPath` on MenuItem uses canSeeNav()
- `permFilter` on SubMenuItem uses can() — gates individual sub-items
- If all sub-items of a parent are gated out, the parent itself is hidden

### Badges
- Parent aggregate badge: badgeCountByPath (path → count)
- Sub-item specific badge: badgeBySubKey (badgeKey → count)
- Both visible simultaneously — Finance parent shows submissions + waivers total, Documentation sub-item shows the same count

### Locked UI decisions
- Parent "inside" indicator: subtle border-l-[#D4AF37]/40 when location.pathname === parentPath
- Active sub-item: full gold accent (matches leaf active styling)
- No hover delay (immediate accordion switch) — can be revisited if jitter becomes an issue

## PAYMENT SUBMISSION FLOW (locked — 2026-04-13, restore added 2026-06-04, universal-submission redesign 2026-06-12)

  ALL payments regardless of submitter must go through
  Submissions review before appearing in Proof of Payment.

  UNIVERSAL-SUBMISSION POLICY (locked 2026-06-12, Bug #219):
    Recording a payment ALWAYS creates a pending payment_submissions
    row, for EVERY role including admin and finance. Direct writes to
    the payments table happen ONLY via the confirmation flow
    (review-payment-submission). Cash orders already comply
    (submit-cash-payment is submission-only for all roles).

    The previous confirm_payment-coupled direct-write branches in
    record-payment / record-multi-payment were removed. The dialog's
    "find a confirmed row, else INSERT a fresh pending submission"
    fallback in RecordPaymentDialog was removed (it was the root
    cause of the 19115/18132 stray-pending incident).

  Flow:
    1. Customer submits via portal → status='submitted'
    2. Staff/Admin/Finance/CSR submits from AccountDetail → status='submitted'
       (no role exception — every role goes through submissions)
    3. Admin/Finance reviews in Submissions tab → clicks Confirm
       → status='confirmed' AND payment row is created via
       review-payment-submission
    4. ONLY confirmed submissions appear in Proof of Payment

  NO payment goes directly to Proof of Payment without
  confirmation in Submissions tab. The payments table is written
  ONLY by review-payment-submission (single source of writes).

  The only way status becomes 'confirmed' is via explicit reviewer
  click in the Submissions tab (review-payment-submission edge
  function). Nothing else writes status='confirmed' — all INSERT
  paths (submit-payment, record-payment for every role,
  record-multi-payment for every role, submit-cash-payment for
  every role) use status='submitted'.

  RESTORE PATH (added 2026-06-04):
    A rejected submission can be restored to the review queue by users
    with reject_submission permission. Restore action:
    - Validates submission.status === 'rejected' (400 otherwise)
    - Flips status to 'submitted' (re-enters queue)
    - Preserves reviewer_user_id and reviewer_notes as rejection history
    - Writes audit_logs entry: entity_type='payment_submission',
      action='restored_from_rejected', captures restorer + optional reason
    - Works for both layaway and cash-order submissions
    - Does NOT fire customer notifications (internal recovery action)
    - Does NOT create or modify payments, allocations, schedule, or
      cash_orders — only flips submission.status

  PROOF REQUIRED — ALL submit paths + confirm (updated 2026-06-30):
    proof_url is now REQUIRED for EVERY submit path, enforced
    server-side with a 400 "Proof of payment is required" when
    proof_url is missing/empty/whitespace:
      - Portal: submit-payment + submit-cash-payment (added 2026-06-06).
      - Staff: record-payment + record-multi-payment (added 2026-06-30) —
        the prior staff exemption / insert-then-attach-without-proof flow
        is GONE. Staff dialogs now upload proof FIRST and pass proof_url
        in the invoke body; the edge function attaches it to the created
        submission. Preview calls (preview_only) write nothing and are
        exempt.
    No submission can be CONFIRMED without proof: review-payment-submission
    returns 400 "Proof of payment is required to confirm this submission."
    when action='confirmed' and proof_url is empty — covers both layaway
    and cash-order confirm branches.
    Staff can attach/replace proof on a pending submission directly from
    the Submissions tab (proof-only action; layaway + cash).
    BulkPaymentImport requires proof per row — proofless bulk rows are
    rejected.

  2026-06-06: record-payment + record-multi-payment now set sender_name
    at payment_submissions insert (staff name from user_metadata/email),
    so notify_submission_created staff-bell bodies no longer show
    "Unknown sender" for staff-recorded payments.

## LOYALTY AWARD SYSTEM (added 2026-04-27, updated 2026-05-16)

### Canonical award path (SOLE path — Layer-2 triggers removed 2026-05-16):
  review-payment-submission → award-loyalty-points edge function.
  - Layaway: awards ONLY on downpayment submission confirm
    (submissionIsDP). Never on monthly installment confirm.
  - Cash: awards ONLY when the confirming payment makes the
    cash order fully paid (isFullyPaid → status 'completed').
  The Layer-2 DB triggers (trg_loyalty_on_cash_order_complete,
  trg_loyalty_on_layaway_complete) and function
  award_loyalty_points_on_complete() were DROPPED via
  migration 20260516000000_drop_layer2_loyalty_triggers.sql —
  they only INSERTed transaction rows without updating
  loyalty_members counters or creating point lots, producing
  ghost audit rows. Do NOT reintroduce a DB-trigger award path.

### Points formula:
  points = floor(loyalty_jpy_amount / 10000)
           × 100
           × current_tier_multiplier

### Tier multipliers:
  Glimmer:   1x
  Radiant:   2x
  Elite:     2x
  Crown VIP: 3x

### new_order_discount net-spend rule (2026-05-26):
  process-loyalty-redemption reduces the target order's loyalty_jpy_amount by value_applied_jpy on approval (floored at 0) and restores it on void. award-loyalty-points is unchanged — it reads the already-net loyalty_jpy_amount, so both points and cumulative_spend_jpy accumulate on net of the discount, not gross. The cancel action (pending-only) never touches loyalty_jpy_amount.

### DP confirmation loyalty toast (added 2026-06-04):
  DP confirmation loyalty toast: review-payment-submission captures award-loyalty-points responses for layaway DP confirms (single + split) and returns them as loyalty_awards[]; PaymentSubmissions.tsx toasts awarded results to the reviewer. Skips are silent; hard failures show a warning toast. Cash-order completion awards remain fire-and-forget (no toast).



## LOYALTY SYSTEM RULES (locked 2026-05-16) — NON-NEGOTIABLE

  1. Portal signup creates a customers row + auto-enrolls.
     setup-customer-account: when the verified email matches no
     existing customer, it creates the customers row (full_name
     required; email + auth_user_id from the JWT; optional
     mobile_number / facebook_name / messenger_link / location /
     country; customer_code via existing trigger) AND inserts a
     loyalty_members row at the Glimmer tier with all counters 0.
     Existing-customer emails continue the link-only path
     unchanged. Profile fields are collected on PortalSetup.tsx
     and stashed in localStorage (key 'portal-setup-profile') so
     they survive the email-verification page reload.

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

## LOYALTY INACTIVITY — last_purchase_at SOURCE OF TRUTH (added 2026-05-20)

  - `loyalty_members.last_purchase_at` = order_date of the member's
    MOST RECENT SUCCESSFUL order. Successful = layaway status IN
    (`active`, `overdue`, `completed`, `extension_active`,
    `reactivated`); cash status IN (`completed`, `pending`). NEVER
    `cancelled` / `forfeited` / `final_forfeited` (layaway) or
    `cancelled` / `expired` (cash).

  - `loyalty-inactivity-check` (pg_cron job 16, 180-day) now derives
    `effectiveLastPurchase = GREATEST(stored last_purchase_at, MAX
    successful order_date)` per member and measures the 166-day
    warning + 180-day expiry against it. Read-only derivation — the
    cron does NOT write `last_purchase_at` back. This guarantees a
    member with a recent real order is never warned or expired even
    if `award-loyalty-points` never fired for it. The customer's
    `order_date` source is queried in one paginated pass per table
    (`layaway_accounts` + `cash_orders`) and JS-aggregated to a
    per-customer `Map<customer_id, Date>` — no N+1, no `.in(customerIds)`
    URL-length risk (Bug #59 precedent).

  - `created_at` is the row INSERT/import timestamp (bulk import =
    `2026-03-20`) — NEVER use `created_at` as an order/purchase
    date. Use `order_date` (`layaway_accounts` & `cash_orders`)
    and `date_paid` (`payments`). `customers.created_at` has the same
    March-2026 import contamination — see docs/SCHEMA-FACTS.md
    ("customers.created_at import contamination"; the Dashboard New
    Customers trend clips at NEW_CUSTOMER_TREND_CUTOFF = 2026-04).

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

## PLAN DURATION — payment_plan_months IS AUTHORITATIVE (added 2026-05-20)

  `layaway_accounts.payment_plan_months` is the configured PLAN DURATION
  product attribute — NOT a cache, NOT derivable from the schedule. It is
  sourced from `plan_configurations` and gated by a DB trigger.

### Source of truth
  `plan_configurations` table holds the allowed durations:
    - 3, 6, 8, 10, 12 months (the only valid values)
    - Each row carries `min_amount_php`, `min_amount_jpy`,
      `dp_percentage`, `risk_tier`
  `enforce_plan_minimum_amount` trigger fires BEFORE INSERT OR UPDATE on
  `layaway_accounts` and REJECTS any `payment_plan_months` value that is
  not a configured duration (and any total below that duration's minimum).
  Consequence: the column can ONLY ever hold a configured duration. The
  trigger guarantees this.

### Engines read this column directly — that is correct
  `penalty-engine`, `add-penalty`, `auto-forfeit-settlement`,
  `finance-reconciliation`, business-rules `getPenaltyCap` /
  `isPenaltyOverCap`, and the AccountDetail / PenaltyCapAuditPanel UI all
  use `payment_plan_months` to identify the final installment for the
  ₱3,000 / ¥6,000 final-month penalty cap and forfeiture logic. This is
  the intended design.

### NEVER derive plan length from the schedule
  - `MAX(installment_number)` over non-cancelled rows is NOT the source.
  - `count(*)` of schedule rows is NOT the source.
  - Either can drift from the configured duration due to admin schedule
    edits; that is an account-level anomaly, NOT a bug in the column.

### NEVER write payment_plan_months from schedule operations
  `add-installment` and `delete-installment` MUST NOT sync
  `payment_plan_months` to the new schedule row count. Doing so:
    1. Inverts the source of truth (configured product → derived cache).
    2. Hits the trigger — any non-configured value (e.g. 5, 7, 9, 11)
       is rejected, so the write fails outright and the edge function
       returns a 500.
  An admin who adds a 7th installment to a 6-month plan creates a
  schedule with 7 rows but the account remains a 6-month plan. That is
  the documented behavior.

### Schedule-vs-column mismatches are admin-edit anomalies, not bugs
  Examples where the schedule row count differs from
  `payment_plan_months`:
    - INV 18748 (logged delete-installment)
    - CJ-2026-FORFEIT-P1, CJ-2026-FORFEIT-P3, CJ-2026-PATH1-TEST,
      CJ-2026-RESTORE-TEST (test fixtures with manually-adjusted
      schedules)
  In every such case, `payment_plan_months` remains the correct
  configured duration; the schedule is the anomaly. Do not "fix" by
  rewriting the column.

### Aborted-fix record
  Commit `f113cd2` (2026-05-20) attempted to make `payment_plan_months`
  a schedule-derived cache: engines read MAX(installment_number), and
  add/delete-installment wrote `payment_plan_months = schedule MAX`.
  That write hits the `enforce_plan_minimum_amount` trigger and 500s on
  any non-configured count (e.g. deleting from 6→5 rows). Reverted in
  commit `29505ae` (2026-05-20). DO NOT REOPEN this approach.

## LOYALTY GOOGLE SHEET SYNC TAXONOMY — NON-NEGOTIABLE (added 2026-05-16)

Canonical event_type values consumed by sync-loyalty-to-sheet:

  Members tab events:      enrolled, tier_changed, status_changed, admin_edited
  Transactions tab events: earned, bonus, redeemed, expired, adjusted, refunded, revoked, birthday_bonus

Caller responsibilities:
  - join-loyalty-program       → emits enrolled
  - award-loyalty-points       → emits earned + bonus (if promo) + tier_changed (if upgrade)
  - process-loyalty-redemption → emits redeemed (approve), revoked (void)
  - loyalty-inactivity-check   → emits expired, tier_changed (downgrade), status_changed (if wired)

Forbidden:
  - Any caller sending event_type values outside this taxonomy
  - Emission without member_id in the payload
  - Sync calls that block the parent function's return (must remain fire-and-forget)

Sheet ID location: system_settings.loyalty_sheet_id (configured via Loyalty Settings UI).

### Sync function implementation (live as of 2026-05-16)

- sync-loyalty-to-sheet/index.ts writes rows in real-time to the Sheet configured in system_settings.loyalty_sheet_id.
- Sheet tabs: Members (11 cols) and Transactions (13 cols). Column order is locked — see headers in row 1 of each tab.
- Authentication: getServiceAccountAccessToken() from _shared/google-auth.ts (same SA as invoice generator).
- Activity Status (Members tab Col I): derived from last_purchase_at — null or <90 days = "Active", ≥90 days = "Inactive".
- PHT timestamps (Col A both tabs): formatted via Intl.DateTimeFormat with timeZone 'Asia/Manila'.
- Real-time only in v1. loyalty_sheet_sync_frequency setting is informational only; the function ignores it and writes every event immediately.
- Append endpoint: spreadsheets.values.append (NOT batchUpdate) — sheet auto-finds next empty row.
- Graceful skip: if loyalty_sheet_id is empty in system_settings, function returns { disabled: true } without erroring.

Forbidden:
- Modifying sheet column order without coordinated header update in the actual Google Sheet
- Calling sync-loyalty-to-sheet with event_type outside the canonical taxonomy
- Removing the activity_status derivation (Members Col I depends on it)

## SHEET SYNC ARCHITECTURE — NON-NEGOTIABLE (added 2026-06-05)

The Google Sheet backup (configured via `system_settings.loyalty_sheet_id`)
mirrors every `loyalty_transactions` row through two complementary paths.
This architecture exists because Bug #163's catch-up revealed that any
non-fast-path write (SQL RPC backfill, direct INSERT, migration, emission
failure) silently bypassed the sheet — leaving permanent gaps in the
backup that nothing reconciled.

**Fast path — synchronous, ~1 second latency.**
- `award-loyalty-points` (and any future writer to `loyalty_transactions`)
  POSTs to `sync-loyalty-to-sheet` via inter-function HTTP immediately
  after each row insert. On 200 response, the writer marks
  `loyalty_transactions.synced_to_sheet_at = NOW()` on the row it just
  inserted.
- Covers natural awards triggered by `review-payment-submission` (the
  steady-state production path).

**Recovery path — async, hourly catch-up via pg_cron.**
- `loyalty-sheet-reconcile` edge function queries
  `loyalty_transactions WHERE synced_to_sheet_at IS NULL` within a 30-day
  window, fans out to `sync-loyalty-to-sheet` per row, marks synced on
  success. Returns `{processed, succeeded, failed, remaining}` summary.
- Catches: SQL backfills, direct INSERTs, migrations, any emission failure
  in the fast path, future writers that forget to set the marker.
- pg_cron jobid 21, schedule `7 * * * *` (hourly at :07 UTC), Vault-backed
  auth pattern (`email_queue_service_role_key`).

**Locked invariants:**

1. **Every `loyalty_transactions` row eventually reaches the Google Sheet.**
   Within ~1 second for natural awards (fast path), within ~1 hour for
   everything else (recovery path).

2. **`synced_to_sheet_at` is write-once.** NULL → timestamp; never flips
   back to NULL. Resync requires deliberate operator action (UPDATE the
   column to NULL on specific rows to force re-emission).

3. **`loyalty-sheet-reconcile` is intentionally unauthenticated.** Matches
   `sync-loyalty-to-sheet`'s pattern (the function it fans out to). Risk
   surface is minimal: only emits already-existing data and writes a
   metadata column. Strong auth (env-equality, JWT decode) would break
   the Vault-backed cron pattern because Supabase's `sb_secret_*`
   key-format rollout produces a runtime env value that diverges from any
   Dashboard- or Vault-stored copy.

4. **`award-loyalty-points` retains strict env-equality + admin/finance
   user-fallback auth.** It modifies customer point balances — different
   risk profile than the read-mostly reconciler. The auth pattern there
   stays per Bug #163.

5. **Schema:** `loyalty_transactions.synced_to_sheet_at timestamptz`,
   nullable, no default. Partial btree index
   `idx_loyalty_transactions_unsynced` on `(created_at) WHERE
   synced_to_sheet_at IS NULL` keeps the unsynced lookup tiny in
   steady-state.

6. **Event-type routing in the reconciler** mirrors
   `sync-loyalty-to-sheet`'s canonical taxonomy:
   - Transactions-tab events (8): `earned`, `bonus`, `redeemed`, `expired`,
     `adjusted`, `refunded`, `revoked`, `birthday_bonus`
   - Members-tab events sourced from `loyalty_transactions` (2):
     `tier_changed`, `enrolled`
   - Members-tab events NOT in `loyalty_transactions` (`status_changed`,
     `admin_edited`): out of scope for this reconciler. Phase 2 if needed.

**Operator references:**
- Reconciler source: `supabase/functions/loyalty-sheet-reconcile/index.ts`
- Cron entry: `cron.job WHERE jobname = 'loyalty-sheet-reconcile'`
- Manual trigger via SQL Editor uses the same Vault pattern as the cron
  (see `docs/LOYALTY-LIFECYCLE.md` for the snippet, once that doc is
  updated)
- Incident context: see `docs/FIXED-BUGS.md` Bug #163 entry, including
  the architecture rationale in the Resolution & catch-up notes

## FILL-PAYMENT-TRACKING DUAL OUTPUT (added 2026-06-06)

2026-06-06: `fill-payment-tracking` now also generates the monthly
tax-declaration file (`申告用フォーマット_MM Month YYYY`) into the
Tax Account Drive folder from the same source upload — Overseas
tab columns B/D/E, Japan tab columns B/D/G (Deposit date /
Customer / Amount), non-blocking relative to the tracking output.

2026-07-06: on success, fill-payment-tracking upserts its output sheet ID into system_settings.payment_tracking_sheet_id so append-payment-tracking always targets the newest generated sheet.

2026-07-06: pre-cohort payment months are totalled into the first month column (merged by column), not dropped — Bug #246.

## SERVICES RULE (added 2026-04-12)

  account_services are included in total_amount at the time of service creation.
  When a service is added:
    total_amount = downpayment_amount + SUM(base_installment_amounts) + SUM(account_services)

  remaining_balance = total_amount + Σ(non-waived penalties) - Σ(non-voided payments)
  Services are NOT added separately in remaining_balance formula — they are in total_amount.

  NEVER add services as a separate term alongside total_amount in the formula.

## DECIMAL RULES

  DB: all money columns NUMERIC(12,2)
  JS: use moneyAdd(), moneySub(), toInt(), fromInt() from business-rules.ts
  Never use raw +/- on money values in JS
  Money equality: always use moneyEqual() with EPSILON tolerance
  JPY: always Math.round() — never display fractional yen
  PHP: always exactly 2 decimal places

## SCHEDULE EDIT RULES

  Allowed edits: due_date only (via extend-schedule edge function)
  Locked forever: base_installment_amount (DB trigger), installment_number (DB trigger)
  Locked on completed/forfeited accounts: all edits rejected
  Adding rows: only via add-installment edge function
  Deleting rows: only via delete-installment edge function
                 requires zero allocations and zero carried_amount
  Every edit: requires reason, logged to schedule_audit_log

## LOCKED RULE (2026-05-17): GUC bypass before write via supabase-js

  When an edge function needs to bypass a BEFORE-trigger guard
  (e.g., prevent_schedule_deletion, prevent_total_amount_change)
  for a subsequent write operation, the bypass MUST be wrapped
  in a SECURITY DEFINER RPC that performs both set_config and
  the write in a single transaction.

  DO NOT use the 2-HTTP-call pattern:
    await supabase.rpc('set_config', {..., is_local: true});
    await supabase.from(table).delete()/.update()/...;

  This pattern fails Bug #39: set_config(is_local: true) is
  SCOPED TO THE TRANSACTION of HTTP call 1. HTTP call 2 may use
  a different connection/transaction, so the GUC does not persist.
  The trigger fires, the write is blocked, and depending on the
  edge function's error handling, the failure may be silent.

  CORRECT pattern (single transaction guarantee):
    CREATE FUNCTION xxx_atomic(...) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER AS $$
    BEGIN
      PERFORM set_config('app.your_guc', 'on', true);
      INSERT INTO audit_table (...);  -- if applicable
      DELETE FROM target_table WHERE ...;  -- or UPDATE/INSERT
      RETURN jsonb_build_object('success', true);
    END;
    $$;

    -- Edge function:
    const { data, error } = await supabase.rpc('xxx_atomic', {...});
    if (error) throw error;
    if (data?.error) throw new Error(data.error);

  REFERENCE IMPLEMENTATIONS:
  - delete_schedule_row_atomic (2026-05-17, schedule row deletion)
  - delete_account_atomic (updated 2026-05-17 to use this pattern)
  - allocate_payment_atomic (payment allocation waterfall + payment insert + schedule/penalty/account-totals writes, all in one transaction; preview mode computes the exact plan without writing)

  AUDIT REQUIRED: any existing supabase-js 2-call GUC bypass pattern
  (e.g., app.allow_total_amount_edit set_config followed by .update())
  must be reviewed for Bug #39 exposure and converted to atomic RPC
  if the same failure mode could apply.

## VOID/RESTORE RULES

  Void: always deletes payment_allocations by payment_id (never by schedule_id)
  Carry cascade: voiding a payment that triggered carry clears carried_amount on next row
  Restore: validates allocation ceiling per row before recreating allocations
           rejects if row already fully allocated

## PLAN MINIMUM ENFORCEMENT (added 2026-04-23)

  Minimum amounts stored in: plan_configurations table
  Columns: plan_months, min_amount_jpy, min_amount_php

  Current minimums:
    3M: no minimum
    6M: ¥25,000 / ₱10,500
    8M: ¥300,000 / ₱126,000
    10M: ¥600,000 / ₱252,000
    12M: ¥1,000,000 / ₱420,000

  Enforcement layers:
    1. UI — NewAccount.tsx reads plan_configurations on load,
       shows minimum subtitle on each plan pill button,
       shows red warning under Total Amount if below minimum,
       disables Create button when below minimum — commit 639c3f6
    2. DB trigger — trg_enforce_plan_minimum fires on INSERT
       and UPDATE via enforce_plan_minimum_amount() function.
       Blocks any account creation or edit below the minimum.
    3. Both PHP and JPY enforced — hard block, no override


## LOYALTY new_order_discount -> DOWNPAYMENT (added 2026-05-26)

- A new_order_discount redemption on a LAYAWAY account is applied to the downpayment, NOT to installment schedule rows.

- process-loyalty-redemption approve handler (layaway branch): the synthetic payment is inserted with reference_number 'LOYALTY-{id}', payment_method 'loyalty_redemption', and remarks containing "downpayment" so DP detection (AccountDetail, fix-account-totals, restore-payment) classifies it as a downpayment payment. NO payment_allocations / schedule waterfall is created (downpayment payments do not allocate to schedule rows).

- Account totals still update (total_paid += amount, remaining -= amount) independent of allocations.

- Void path unchanged: matches reference_number 'LOYALTY-%'; its allocation-reversal loop is a no-op with no allocations; totals revert off amount_paid.

- Cash (cash_order_id) branch is unchanged.

## FRONTEND / DESIGN WORKFLOW (added 2026-06-19)

1. Before writing any library/framework code (React, Tailwind, Firebase),
   consult Context7 for current docs — don't rely on memory.

2. Build structure with shadcn/ui primitives by default. Check the shadcn
   MCP registry before hand-rolling any component (buttons, cards, dialogs,
   forms, etc.).

3. Only when a component needs motion or visual richness, layer Magic on
   TOP of the shadcn foundation — animated counters, bento grids, shimmer,
   hover effects. Do not reach for Magic for plain/static UI.

4. After any frontend change, verify in a real browser with Playwright:
   start the dev server, navigate to the route, screenshot it, check
   desktop and mobile (~375px), and read the console for errors before
   saying it's done.

5. TYPECHECK — the canonical command is:
     npx tsc -p tsconfig.app.json --noEmit
   This is the EXACT command CI runs on main pushes. NEVER use bare
   `npx tsc --noEmit`: the root tsconfig.json is solution-style with
   `"files": []` and checks ZERO files — it always exits 0, a false
   green. Evidence: deploy #1896 (2026-07-07) failed at Typecheck on a
   TransactionsTab error that bare `tsc --noEmit` had passed all
   session long.

6. KPI + CHART ANIMATION STANDARDS (set 2026-07-07):
   - KPI cards rendered with the shared StatCard pass countUpValue +
     formatValue + staggerIndex uniformly; bespoke KPI values use
     <AnimatedNumber> (src/components/shared/AnimatedNumber.tsx). Both
     draw from theme/motion — a numeric KPI display without them is a
     defect.
   - KPI value DEFINITION: the primary headline figure of a titled
     card. Table cells, rows, badges, and in-panel counts never
     animate.
   - Charts take useChartAnimation() props (800ms ease-out,
     reduced-motion aware) on every recharts series element — an
     unconfigured series is a defect.
   - Dashboard data hooks use React Query with staleTime +
     keepPreviousData — hand-rolled useEffect fetches and staleTime: 0
     on dashboards are defects.
   - Heavy pages (Executive Dashboard, Finance) are cache-prefetched at
     app idle via usePrefetchHeavyPages, role-gated to the sidebar's own
     visibility rules; new heavy dashboards join the prefetcher
     (standard 2026-07-07).

## Migrations baseline (2026-07-05)

`supabase/migrations/` now holds a single live-introspected baseline:
`20260705230000_baseline_live_schema.sql`. It was generated on 2026-07-05
directly from the live Postgres catalogs (pg_type/pg_enum, pg_class,
pg_attribute, pg_constraint, pg_proc via `pg_get_functiondef`, pg_trigger via
`pg_get_triggerdef`, pg_indexes, pg_policies, pg_publication_tables, and
`information_schema.routine_privileges`) and captures the full public-schema
DDL: extensions, enums, tables + constraints, foreign keys, functions, views,
triggers, indexes, RLS + policies, function EXECUTE grants, and the realtime
publication. All 12 live cron jobs are captured as cron.schedule() statements (extracted from cron.job via the SQL Editor, 2026-07-05).

The 100 pre-baseline migration files are archived in
`supabase/migrations-archive/` (filenames preserved). They are kept for
historical reference only and are NOT applied by any tooling — Supabase CLI
reads `supabase/migrations/` exclusively.

The LIVE DB remains authoritative. The baseline reflects live state at the
moment of generation but is NOT a replacement for it — NEVER push the
baseline to the live project (`supabase db push`, `supabase migration up`, or
equivalent). Migration-history mismatch against live is expected and
irrelevant. Purpose: faithful fresh rebuilds (local dev, staging bootstrap)
and an in-repo source of truth. Any future schema change to the live DB must
be added as a NEW migration file in `supabase/migrations/` alongside the
baseline (do not edit the baseline in place).


Known pre-existing quirk (NOT from this work): fc_cohort_timeline.collection_rate
can exceed 100% because actual_collected includes downpayment while
expected_collected excludes it. Drives a noisy quality-degradation alert.
Separate ticket if undesired.

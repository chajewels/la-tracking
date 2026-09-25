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
- docs/WEBSITE-VERCEL.md — Vercel storefront integration: `website` API contract, revalidation chain, the three secrets, go-live checklist
- docs/SERVICE-REQUESTS.md — customer service requests: how they differ from service_jobs, statuses, the is_test exclusion, the untyped-table cast
- docs/NEWSLETTER-SUBSCRIBERS.md — newsletter subscribers: the table, the is_test rule, why re-subscribe never touches consented_at, and what a Hub send would actually require
- docs/RESERVE-FIRST.md — reserve first, pay after staff confirm: the A1 RPC contract and what A2 built (switch system_settings.web_reservation_mode)
- docs/WEBSITE-WORKSPACE.md — the /website workspace: the five tabs (Page365 stock added 2026-09-26), the manage_website_catalog / manage_website_content split, the query-preserving redirect from /website-catalog, and where each website table's editor lives
- Moved out of CLAUDE.md on 2026-09-24 (verbatim; CLAUDE.md keeps the rules
  and a pointer): docs/CRON-AND-EDGE-AUTH.md, docs/LOYALTY-RULES.md,
  docs/WEB-LAYAWAY.md, docs/PAGE365-IMPORT.md, docs/MIGRATIONS.md,
  docs/BRAND-STYLE.md, docs/RECONCILIATION.md, docs/PAYMENT-SUBMISSIONS.md,
  docs/PLAN-DURATION.md, docs/LOYALTY-SHEET-SYNC.md, docs/SIDEBAR.md,
  docs/EMAIL-DELIVERY.md, docs/TEST-ACCOUNT-EXCLUSION.md, docs/TRADE-PROGRAM.md,
  docs/POST-LOGIN-SPLASH.md, docs/INQUIRY-TRACKER.md, docs/REASSIGN-OWNER.md,
  docs/PENALTY-AND-FORFEITURE.md, docs/LOVABLE-VERIFICATION.md,
  docs/SCHEMA-FACTS-CUSTOMER-CODE.md
- SIZE LIMIT: keep this file under ~120k characters (Claude Code stops loading
  it at 150k). Long reference text goes to docs/; rules stay here.

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
    Partial refunds MUST be done via Edit order → Update order ONLY; NEVER the
    Refund page (all three of its methods move value on Shopify's side — the
    real-cash gate will block the Hub mint and the customer gets paid through
    the wrong ledger).
  - Shopify partial refunds auto-mint Hub credit (source_type
    shopify_partial_refund, keyed per refund id); the "You owe the customer"
    banner in Shopify is permanent and cosmetic — never settle it.
  - cash_orders 'cancelled' is TERMINAL. Every status writer in shopify-webhook
    must chain .neq("status","cancelled") — fetch-time status checks are racy
    (proven SH-1017/SH-1018). Payment arriving for a cancelled order books
    nothing; staff notification shopify_paid_after_cancel handles it manually.
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
  - WEB ORDERS (source_channel='web', 2026-09-13): cancelling a PAID web order
    records a REFUND DECISION (cash_orders.refund_status: refund_issued /
    refund_pending / store_credit_issued / no_refund + refund_note). Store
    credit is minted ONLY for store_credit_issued — never automatically; a
    refund is never also credit and no_refund is a forfeiture. The one
    terminal RPC is terminate_web_order_atomic (expired | cancelled): points
    reversal, credit decision, status, stock back on sale, note, audit — one
    transaction, once. Web orders are NEVER hard-deleted (trigger
    trg_prevent_web_order_delete); cancel is the only exit.

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
  - AN ASSERTION MUST TEST CODE, NOT PROSE. Every grep in a Lovable message is
    re-run against the file with all comment lines stripped; if the count moves,
    the pattern is matching an explanatory comment and must be rewritten to a
    form that discriminates (anchor it, e.g. `^function foo`, or include
    punctuation only code has). Three of eleven candidates failed this test on
    2026-09-15 and four did on 2026-09-14. Also require each count to DIFFER from
    the pre-release main: an assertion that passes identically before and after
    proves nothing about the deploy.
  - AN ASSERTION NOBODY CAN SATISFY IS WORSE THAN NO ASSERTION (added 2026-09-15,
    THIRD occurrence). A check that cannot be run gets substituted, waved
    through, or reported as a pass on different evidence — and that is worse than
    asking for something weaker and true. Three times now a message has asked
    Lovable for proof it had no way to produce: a preview render needing
    LOVABLE_API_KEY (2026-09-14, answered 401); an end-to-end customer flow
    needing a signed-in session, a cart and an address (2026-09-15); and message
    K's step 3(d), "GET /website/layaway and the portal must answer 200 not 400"
    (2026-09-15), which needs the website API key and a real customer session.
    Before writing a verification step, ask what the agent can actually observe
    with the access it has, and ask for THAT — the deployed function body plus
    its version and timestamp, not a synthesised user journey. Where the real
    proof needs a human in a browser, say so in the message and assign it to the
    owner's own acceptance run instead of dressing it up as an automated check.
    The model answer (Lovable refusing to fake a check, 2026-09-15):
    docs/LOVABLE-VERIFICATION.md (moved verbatim 2026-09-24).

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

  All customer-portal writes go through a service-role edge function. Never
  write to a table directly from the portal via PostgREST — anon RLS policies
  that reference another RLS-protected table silently fail closed (Bug #165).

## TEST ACCOUNT EXCLUSION — NON-NEGOTIABLE

  Full text (status per surface, the re-runnable audit query, history):
  docs/TEST-ACCOUNT-EXCLUSION.md (moved verbatim 2026-09-24).

  - Real accounts have purely numeric invoice numbers. The exclusion on EVERY
    operational and financial surface is keep-numeric-only: SQL
    `invoice_number ~ '^[0-9]+$'`; PostgREST
    `.filter('<embed>.invoice_number','match','^[0-9]+$')`. The old TEST-% filters
    are incomplete and must be replaced.
  - Documented exceptions: get_staff_performance, get_bulk_setup_invite_candidates,
    get_recent_qualifying_order, get_unpaid_schedule.
  - DB-enforced: every new test customer MUST be flagged customers.is_test = true;
    enforce_test_invoice_prefix() then prefixes TEST- automatically.

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

## BRAND STYLE STANDARD (Deco Ledger, 2026-07-06)

  Full text incl. the tracked-debt list (nested workflow, package-lock
  registry quirk, email-template gold, SheetJS pin), background photos and
  video assets: docs/BRAND-STYLE.md (moved verbatim 2026-09-24).

  - Gold: --gold-500 #C9A227 (primary), --gold-300 #E5C860 (hover/focus). The
    old #D4AF37 is RETIRED. Gold only via theme tokens (src/index.css,
    src/theme/tokens.ts); hex literals ONLY in src/theme/ and src/index.css.
  - Semantic tokens --success/--warning/--danger/--info exist; signature
    divider is the 1px gold hairline (.hairline-gold / -b / -t).
  - TWO CHECKS, both must be 0:
      1. retired gold, repo-wide, CASE-INSENSITIVE:
         grep -rniE "#D4AF37|#E7D7A2|#E8C84A" src supabase/functions --include="*.tsx" --include="*.ts"
      2. token discipline, src only (do NOT widen — email templates must inline
         the canonical #C9A227):
         grep -rnE "#D4AF37|#E7D7A2|#C9A227|#E5C860|#E8C84A" src --include="*.tsx" --include="*.ts" | grep -v "src/theme/"
  - Email templates: canonical literal hex only.
  - Keep package-lock.json on registry.npmjs.org; if private-registry URLs
    reappear, regenerate on main, never from a feature branch.
  - SheetJS stays at 0.18.5 for the admin-only catalog importer; NEVER feed
    customer- or portal-supplied files through it.
  - The DOUBLE SLASH in brand-assets//… video keys is real — never normalize it.

## POST-LOGIN SPLASH (2026-07-06)

  Full mechanics: docs/POST-LOGIN-SPLASH.md (moved verbatim 2026-09-24).
  Shows ONLY on a fresh staff sign-in with no ?next (freshLoginRef set before
  the sign-in await); never on session restore or ?next flows. Failsafes
  (onError, 5s canplay watchdog, reduced motion) are mandatory; there is NO
  auto-navigate timer. The DOUBLE SLASH in brand-assets//AdminSpalshScreen.mp4
  is the real key — NEVER normalize it. Invariants are locked by
  src/test/post-login-splash-guard.test.tsx.

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

- Installment 1 due date = order month + 1 month, never the order month itself. Same day-of-month as order_date; if that day does not exist in the target month, fall back to the last day of that month. Enforced in FOUR places that must always agree: create-layaway-account (index.ts, `getMonth() + i + 1`), restructure-account (index.ts, `getMonth() + i + 1`), the frontend preview generateScheduleDates() in src/lib/calculations.ts, and the `layaway_quote` SQL function (`p_order_date + make_interval(months => n)`), which is what the storefront quotes a customer before the account exists. Any change to one must be mirrored in the other three — a storefront quote that disagrees with the account the Hub then creates is a promise broken at creation time.
- Downpayment is NEVER marked paid at creation
- `dp_paid` always starts at 0; `total_paid = 0` on new accounts
- DP is only marked paid after payment submission is validated by staff
- Never bypass the payment validation flow
- The "Downpayment Paid" input field does NOT exist on the creation form
- DP excess over downpayment_amount waterfalls into installments (Month 1 onward) — see INVARIANT 11 (Bug #250, 2026-07-06). The required DP portion still never allocates.
- Loyalty Product Amount (JPY) is REQUIRED when the selected customer has a loyalty tier (any tier), on BOTH layaway and cash-order creation. Enforced on two layers: frontend UX (NewAccount.tsx / NewCashOrder.tsx) and the authoritative edge function (create-layaway-account / create-cash-order return 400 LOYALTY_AMOUNT_REQUIRED). Optional for non-members. After creation it is editable in Manage Invoice (layaway EditAccountDialog and cash CashOrderDetail) with permission edit_loyalty_amount (admin + per-user override), and only until the order earns points: trg_guard_loyalty_jpy_amount refuses a signed-in user's change without the permission or once an 'earned' loyalty_transactions row exists for the order (service-role callers — redemption net-spend RPCs, shopify-webhook, derive_order_loyalty_jpy — are not gated). A Manage Invoice total change does NOT update it automatically; the field shows a "Use ¥Y" nudge (total − shipping, PHP ÷ rate) instead. Correcting an order that already earned points is a separate path (#19751 is the known case).

## PAYMENT HISTORY AS SOURCE OF TRUTH — NON-NEGOTIABLE

  Full text (reconcile-account history, Checks 15–17b, the allocation RPC):
  docs/RECONCILIATION.md (moved verbatim 2026-09-24).

  - payments is the SINGLE source of truth for money received. Chain:
    payments → payment_allocations → layaway_schedule.paid_amount → totals.
    SUM(installment allocations for row X) ≈ schedule.paid_amount;
    SUM(non-voided payments) ≈ account.total_paid.
  - reconcile-account is REPORT-ONLY (writes one reconciliation_log row); it
    fixes nothing. Anything that needs allocations/schedule/totals written MUST
    call allocate_payment_atomic (review-payment-submission is the only
    write-mode caller; record-payment / record-multi-payment use
    p_preview:true). Only process-loyalty-redemption's DP path stays inline.
  - daily-reconciliation stamps system_settings.last_daily_reconciliation;
    Check 17 (reconciliation_staleness, > 25h) and 17b (loyalty_sweep_staleness)
    exist. Checks 15 and 16 are NOT built — never describe a check here before
    it exists.

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
    6M  → min ¥25,000 / ₱10,500, LOW risk
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

## Git Workflow — NON-NEGOTIABLE (changed 2026-09-11)

**`main` is production.** A push to `main` deploys the Hub frontend to live
Firebase Hosting (`chajewelslayaway`). It is changed only by a PR from
`develop`, merged by Cynthia — plus Lovable, see the exception below.

**`develop` is where work lands.** All Claude Code work goes to `develop`, or to
a short-lived feature branch merged into `develop`. Never push to `main`
directly. A push to `develop` deploys to the `develop` Firebase Hosting preview
channel; every PR gets its own `pr-<number>` channel, and the workflow posts the
URL as a single sticky comment on the PR.

This replaces the previous rule ("commit and push all changes directly to
main"), which is why `main` used to be edited directly throughout this file's
history. The same workflow is in force on the storefront repo
(`chajewels/cha-jewels-web`); the two now match.

### THE LOVABLE EXCEPTION — main is not protected against Lovable

Lovable mirrors `main` and commits its own work to `main`. It does not use
`develop` and cannot be made to. **This is accepted, not a gap**, because
Lovable only touches the repo when Cynthia approves a message — the human
review that a PR would otherwise provide happens before the message is sent,
not after the commit lands. In effect an approved Lovable message *is* the
review.

Two consequences to work with rather than around:

- **Never assume `main` equals `develop`.** Lovable may have moved `main` since
  `develop` branched. Before opening a `develop` -> `main` PR, and before any
  work that reads `main`, fetch it: `git fetch origin main`. Merge `main` into
  `develop` when it has moved; never rebase `develop` onto it (other branches
  are cut from `develop`).
- **Do not "clean up" Lovable's direct commits to `main`.** They are legitimate.
- **After EVERY squash-merge of a release PR into `main`, merge `main` back into
  `develop` immediately** (`git fetch origin main && git checkout develop &&
  git merge origin/main && git push origin develop`). A squash creates a commit
  `develop` does not have, so the next `develop` -> `main` PR conflicts on any
  file both sides touched since (2026-09-13: #35 was not merged back and #38
  conflicted on docs/FIXED-BUGS.md). "Main and develop have identical content"
  is NOT the same as "develop contains main"; only the merge-back makes the
  next release PR clean.

### MIGRATIONS MUST BE ON `main` BEFORE A LOVABLE APPLY MESSAGE

Lovable deploys and applies migrations from its mirror of `main`. A migration
sitting on `develop` is invisible to it, and an apply message naming a file
Lovable cannot see fails its own source assertions — which is the intended
behaviour, not a bug to work around by weakening the assertions.

So a step's Hub work is merged **once, at the end of the step**: the migration
and the Hub frontend that depends on it go `develop` -> `main` in the same PR,
and only then is the Lovable apply-and-deploy message sent. Never merge a
migration to `main` ahead of the frontend that needs it, and never send an apply
message for a migration that is still on `develop`.

Every Lovable apply message must still assert on SOURCE CONTENT (grep counts
plus line counts) before applying or deploying, and STOP if an assertion fails —
see "GENERATED FILES & DEPLOY VERIFICATION".

### ONE SENDER PER LOVABLE MESSAGE — AND THAT SENDER IS CLAUDE CODE

Every Lovable apply/deploy message is sent exactly once, by Claude Code, from
this session, after Cynthia's OK. Nobody else sends it — not Claude chat, not a
second session, not Cynthia pasting it herself. Claude Code checks the Lovable
message queue before every send and never resends after a transport timeout.

Why this is a rule: on 2026-09-11 the transfer_payment_methods message went to
Lovable twice — once from Claude chat at 11:34 UTC and once from Claude Code at
12:51 UTC. Both runs were idempotent by construction (CREATE TABLE IF NOT
EXISTS, copy skipped when populated), so nothing broke, but the second run's
report misattributed the two bank rows Cynthia had entered in between to the
migration's copy block, and it cost an hour of untangling. Two senders means
two mirrors of the truth; one sender means one.

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
    EXCEPTION, and it is not optional: a SQL Editor change that alters a
    FUNCTION BODY is committed as a migration in the same session. Data fixes
    and one-off queries stay uncommitted as before; function bodies do not,
    because the next rebuild from the baseline silently reverts them — see
    "A SQL EDITOR CHANGE THAT IS NEVER COMMITTED…" in docs/MIGRATIONS.md.

  CLAUDE.md is the single source of truth — both Lovable and
  Claude Code must read it before any changes.

## Active Features

  Product Inquiry Tracker (/inquiries) and Timesheet (/timesheet): full notes in
  docs/INQUIRY-TRACKER.md (moved verbatim 2026-09-24) and docs/TIMESHEET-SPEC.md.
  - INVARIANT: never SUM or AVG accumulated_inquiry_count (a running total);
    aggregate inquiry_count from the base table instead.
  - Never add an INSTEAD OF UPDATE trigger to product_inquiries_with_accumulated.
  - Timesheet spillover rows count toward the month (not display-only).

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
    audit_account still subtracts DP overage from v_sum_pending, but
    only the UNALLOCATED portion — GREATEST(0, overage - v_dp_allocated),
    where v_dp_allocated is summed from payment_allocations over the DP
    payments. Post-#250 the excess lives in schedule rows and is already
    counted, so that term normally evaluates to 0 and the outcome matches
    "no longer subtracts"; the mechanism does not, and the difference
    matters to anyone reading or rebuilding the function. (The
    v_dp_allocated refinement is SQL-Editor-only work on top of Bug #233;
    its live body is recorded in
    supabase/migrations/20260917070200_record_live_drifted_functions.sql.)
    See Bug #160 (edit-payment-amount guard) and Bug #250 in
    docs/FIXED-BUGS.md.

  INVARIANT 12 — an unconfirmed submission freezes automated status
  (added 2026-09-14, owner decision):
    An account or order carrying a payment_submissions row in status
    'submitted' or 'under_review' must NOT have its status moved by any
    automated path. The money may already be in the bank; only the
    reviewer knows. Applies to web-layaway expiry
    (expire_web_layaway_atomic refuses with 'submission_pending'),
    auto-forfeit-settlement (skips such accounts before the path checks),
    and the penalty engine (its pre-existing freeze guard is the same
    rule and predates this invariant). Cash-order expiry: enforced since
    2026-09-23 (#298) — auto-expire-cash-orders skips and reports such
    orders (frozen_pending_submission) and NEVER auto-rejects the
    submission, and terminate_web_order_atomic refuses outcome 'expired'
    and any system-sourced cancel with 'submission_pending'. Before #298
    this line claimed the inheritance while the code expired the order and
    rejected the submission.
    Every new automated status writer MUST carry the same NOT EXISTS
    guard. A staff member acting deliberately is never blocked by this —
    the freeze is on automation, not on people.

## TIMEZONE, CRON ORDER & EDGE-FUNCTION AUTH — NON-NEGOTIABLE

  Full text, cron table and per-function auth inventory: docs/CRON-AND-EDGE-AUTH.md (moved verbatim 2026-09-24)

  TIMEZONE: canonical is PHT (Asia/Manila, UTC+8); PHT midnight is the day boundary.
    Frontend: getPHTToday() (src/lib/date-utils.ts) for "today"; display via
    formatPHTDisplay() with a 'PHT' suffix (RefreshControl too).
    Edge: Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date()).
    NEVER new Date().toISOString().split('T')[0]. NEVER Asia/Tokyo (that is JST).

  CRON ORDERING RULE — never violate (UTC): reminders 00:00 → penalty engine
  00:05 → auto-forfeit 00:10 → daily-reconciliation 00:20 (never before 00:15)
  → loyalty-inactivity-check 00:25 → loyalty-award-sweep 00:35. The award sweep
  is DELIBERATELY its own job (time-boxed, resumes from a reconciliation_log
  cursor); never move it back inline into daily-reconciliation. daily-fx-rate
  (00:45) is independent and writes only fx_rates; `website` derives price_php
  at read time and NEVER stores a peso price. auto-expire-cash-orders (:40
  hourly) is the ONLY web/cash expiry path. web-reservation-sweep runs :23
  hourly. process-email-queue has NO cron — silence means nothing is calling it,
  not that it is healthy. NEVER re-add a second cron pointing at /send-reminders.

  CRON AUTH RULE: a pg_cron job calling a service-role-gated function MUST read
  the key from Vault at fire time ((SELECT decrypted_secret FROM
  vault.decrypted_secrets WHERE name = 'email_queue_service_role_key')) — never
  an embedded key. Copy the pattern from an existing adopter.

  EDGE FUNCTION SERVICE-ROLE AUTH PATTERN (locked): identify service callers by
  JWT claims — parseJwtClaims(token)?.role !== "service_role" → 401 — behind
  verify_jwt = true. NEVER token === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
  (Bug #168).
  SHARED-HELPER CONVENTION (locked): new functions, and any function edited for
  other reasons, MUST use _shared/cors.ts and _shared/handler.ts
  (requireAuth/requirePermission) instead of inline copies.
  NEVER accept the anon key as an internal bypass (it is in every bundle), and
  NEVER let a missing Authorization header skip the gate — 401 first. Functions
  that mutate account/financial state for a user MUST also check a real
  role/permission (403 on failure) (Bug #170). Never reintroduce an
  isInternalKey / anon-key bypass on any function.
  verify-portal-pin: public, no verify_jwt (intentional); PINs live in
  customer_pins (RLS, service_role only), PBKDF2-SHA256 100k iterations. Never
  revert to SHA-256; never add PIN columns back to customers.
  fix-account-totals: service-role claims gate + verify_jwt = true, always.

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

  customer_code is IMMUTABLE after creation (prevent_customer_code_change);
  EditCustomerDialog never edits it. The forensic-repair SQL (SET LOCAL
  app.allow_customer_code_change + audit row) is in
  docs/SCHEMA-FACTS-CUSTOMER-CODE.md (moved verbatim 2026-09-24).

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

  ACCOUNT-SCOPED RUN (2026-09-20): penalty-engine accepts { account_id } and
  evaluates that one account with IDENTICAL rules (a strict subset of the
  nightly run — no rule changed, only when it is evaluated).
  reactivate-account calls it (non-blocking) after the reactivation writes.
  Full text: docs/PENALTY-AND-FORFEITURE.md (moved verbatim 2026-09-24).

### Freeze guard:
  Accounts with pending payment submissions (status='submitted' or 'under_review')
  are frozen — no new penalties until the submission is resolved.

### Waiver grace period + auto-unwaive (added 2026-08-18):
  An approved waiver holds a penalty for penalty_waiver_grace_days
  (system_settings, default 7) counted from penalty_fees.penalty_date —
  NOT from the approval date. Staff approving a waiver late give the
  customer less time, by design; the deadline is anchored to when the
  penalty was incurred, not to admin action.

  Inside the window: penalty-engine leaves the waived row completely
  alone — no increment, no schedule write.

  Past the window: penalty-engine reinstates the penalty (status back
  to 'unpaid'), sets the linked penalty_waiver_requests row to
  'auto_unwaived' (auto_unwaived_at stamped), logs an audit_logs entry,
  and emails the customer (penalty-waiver-revoked template).

  penalty_date is NEVER rewritten by any of this — it permanently
  records when the penalty was originally incurred, not when it was
  waived or reinstated.

  approve-waiver's confirmation email (penalty-waived template) shows
  the same deadline via an optional graceDeadline prop, computed as
  min(penalty_date across the batch) + penalty_waiver_grace_days.

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

  PATH 3 fixture forensic note: docs/PENALTY-AND-FORFEITURE.md (moved verbatim 2026-09-24).

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
  Still true as of 2026-09-20. reactivate-account calling penalty-engine
  (account-scoped) is a THIRD party invoking the engine, not these two
  becoming coupled — auto-forfeit-settlement neither calls nor is called.

## TRADE PROGRAM — NON-NEGOTIABLE (2026-05-31)

  Full text (metric definitions, RPCs, UI surfaces): docs/TRADE-PROGRAM.md (moved verbatim 2026-09-24).
  - is_trade on layaway_accounts and cash_orders is set at creation and LOCKED
    after (SQL override only for one-time backfills). Pure metadata — NO effect
    on calculations, payments, penalties or forfeiture. Default false.
  - Detail pages show the amber "🔄 Trade" badge; no list column.
  - LOCKED UI surfaces: the "Trade Program" checkbox (amber, policy link) on
    NewAccount + NewCashOrder; Finance → Overview has 3 trade KPI StatCards
    (between the Cash Orders row and AgingBuckets) and the TradeProgramTrends
    chart below MonthlyAnalyticsChart. RPCs get_trade_kpis /
    get_trade_monthly_trends.

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

## ORDER DELETION — NON-NEGOTIABLE (added 2026-09-13)

  A COMPLETED order, or ANY order that has received money (total_paid > 0 or a
  non-voided payment row), is NEVER deleted — by anyone, through any path. This
  covers layaway_accounts AND cash_orders (ACCOUNT-SCOPE rule). It is the
  web-order rule (trg_prevent_web_order_delete) applied to every order.

  Why: cash order 19144 (¥463,980, completed) was deleted 2026-08-26 and
  layaway 19278 (₱523,712, completed) on 2026-08-25, both through the Hub's
  Delete button under the shared sales@ login; their payment rows went with
  them and the money vanished from every report and receipt roster.

  The only exits for such an order are reversals that stay on the books:
    - cancel (cash) / cancel or forfeit (layaway) WITH a reason
    - void the payment (void-payment / void-cash-payment), then cancel
    - edit-account / restructure for a genuine correction
  A wrong customer or wrong amount is fixed by cancel + re-create, never by
  delete + re-create.

  Enforced in three layers (migration 20260913110000_prevent_paid_order_delete):
    1. BEFORE DELETE triggers trg_prevent_paid_layaway_delete /
       trg_prevent_paid_cash_order_delete (prevent_paid_order_delete()) — no
       bypass GUC, so SQL Editor deletes are refused too.
    2. delete_account_atomic / delete_cash_order_atomic return
       {error:'paid_order_delete_forbidden'} BEFORE touching child rows.
    3. delete-account / delete-cash-order edge functions answer 409; the Hub
       hides the Delete button on such orders and shows the rule instead.
  Exempt: orders of customers flagged is_test = true (scaffolding, not money).
  Unpaid, never-completed orders (typos, duplicates with ₱0/¥0 received) can
  still be deleted by admin as before.

## REASSIGN OWNER — NON-NEGOTIABLE (added 2026-09-24, owner-approved)

  Moving a layaway plan or cash order to another customer. ONE writer:
  reassign_order_owner_atomic (SQL, service_role only) behind the
  reassign-order-owner edge function (requireAuth, no service-role path;
  requirePermission('reassign_owner')). The Hub's ReassignOwnerDialog is the
  only UI, on AccountDetail and CashOrderDetail. A signed-in user can no longer
  write customer_id on either order table at all — trg_guard_order_customer_id
  raises whenever auth.uid() IS NOT NULL — so the old browser .update() is
  retired for good. Preview (apply:false) writes nothing. Full mechanics:
  docs/SCHEMA-FACTS.md "Reassign Owner".

  R1 PRIORITY — FIRST CHECK. An account "has points" if its loyalty_members row has total_points_earned > 0 OR cumulative_spend_jpy > 0 OR spend_baseline_jpy > 0 (any loyalty history).
     - current owner has points → REFUSE (points_account_is_current_owner): the order never leaves a points account.
     - both have points → REFUSE (both_have_points): manual handling by the owner.
     - target has points, current has none → allowed.
     - neither has points → allowed.
  R2 Cash orders behave exactly like layaway.
  R3 Permission: requirePermission('reassign_owner') server-side (live role_permissions/overrides). Setting or changing the loyalty amount inside the reassign additionally requires 'edit_loyalty_amount'.
  R4 The loyalty product amount (excluding shipping and service fees) must be set (> 0) before a reassign completes — always, for every reassign. The dialog collects it if empty.
  R5 Also refuse (with a plain-words reason): order already earned by ANY member (all markers from your section F, including an in-flight claim with transaction_id IS NULL, earned rows, order_earn/promo_bonus lots on the invoice incl. consumed/expired/revoked, bonus rows on the invoice); Shopify orders (SH- invoices or Shopify-sourced); split payment submissions covering more than one order; any non-cancelled loyalty redemption on the order; any store credit applied to or issued from the order; status closed (layaway: cancelled, forfeited, final_forfeited; cash: cancelled, expired); crossing is_test in either direction; same owner; not found.
  R6 Catch-up award for the NEW owner when: new owner is enrolled AND award point >= new owner's enrolled_at − grace days (system_settings.loyalty_enrollment_grace_days, default 3). Award point: layaway = earliest non-voided payments.created_at for the account matching the DP rule (reference_number LIKE 'DP-%' OR remarks ILIKE '%down%'), excluding LOYALTY-% rows; fallback = updated_at of the confirmed DP submission; never date_paid. Cash = completed_at; fallback = created_at of the payment that made it fully paid. Orders not yet at their award point: no catch-up (they earn normally later).
  R7 Catch-up specifics: current tier multiplier (ratchet as today), NO promo; emails/notifications as usual; member.last_purchase_at = GREATEST(existing, order_date) and prev_purchase_at shifts only if that value changes; the new lot expires_at = order_date + 180 days; the member's OTHER live lots are only ever extended: GREATEST(expires_at, order_date + 180 days) — never shortened. If order_date + 180 days is already past, still award (spend counts toward tier) — the points are born expired; the preview must say so.
  R8 A written reason is required for every reassign. Web orders are allowed.
  R9 If the move commits but the catch-up award fails: the move stands; insert a staff_notifications row type 'reassign_catch_up_failed' naming the invoice, both customers and the error.
  R10 Out of scope: changing the normal award's last_purchase_at = now(); any merge-customers tool.
  R11 IDENTITY MATCH. A reassign is allowed only if the target account matches the CURRENT owner on at least one of: full name, Facebook name (both: lower-case, trim, collapse spaces), mobile (last 10 digits, only when >= 10 digits), email (exact, case-insensitive) — the same normalisation as find_customer_matches. No match → refused: code different_customer_details, message "Different customer details — this order can only move to another account of the same customer. Contact the owner."
     Exception: a user holding the permission reassign_owner_unmatched may move an order with NO matching detail (an order put on the wrong customer), only by explicitly choosing the override and with the required written reason; it is logged as an unmatched reassign. The override bypasses ONLY R11 — every other refusal (R1 points-account rule, earned order, closed status, Shopify, split submissions, redemptions/store credit, test↔real, same owner, loyalty amount) still applies.

  ("Section F" in R5 is the 2026-09-24 investigation report; its markers are
  the ones listed in the same rule, all checked by reassign_order_owner_atomic.)

  How "born expired" lots are written, the separate catch-up call, the child
  rows that move, and permissions: docs/REASSIGN-OWNER.md (moved verbatim 2026-09-24).
  R11 mechanics (p_allow_unmatched, override_not_permitted, audit flags):
  docs/REASSIGN-OWNER.md "R11 MECHANICS".

## WEB LAYAWAY — NON-NEGOTIABLE (added 2026-09-14)

  Full text with the harness findings and rationale: docs/WEB-LAYAWAY.md (moved verbatim 2026-09-24).

  - A web layaway is a layaway_accounts row with source_channel = 'web' — same
    table, schedule, payments and invariants. There is no second account model.
    Item lines live in layaway_account_items.
  - ONE WRITER: create_web_layaway_atomic (recomputes from layaway_quote,
    refuses below_plan_minimum, one transaction). `website` never writes a
    layaway row itself. The invoice number is reserved at quote time
    (checkout_quotes.reserved_invoice_seq) and carried to the account; gaps are
    by design.
  - THE DEPOSIT DEADLINE IS A FIELD (transfer_due_at), moved ONLY through
    set_account_deadlines / set-account-deadlines (edit_account, audited). A
    REASON IS REQUIRED (400 reason_required); creation is exempt. On a cash
    order it writes transfer_due_at AND expires_at together. Web default 72h.
    No violation predicate, no automatic violator classification.
  - A DEADLINE IS MOVED, NEVER REMOVED: null → deadline_required. Backdating is
    legal but returns deadline_in_past: true and the Hub warns.
  - What a deadline does depends on the channel (web layaway expires; Hub
    layaway: reminder only; cash: cancelled, stock back for web only). Any
    surface stating a consequence must state the one for THAT order.
  - THE DEADLINE IS SPENT ONCE THE DEPOSIT IS CONFIRMED (layaway only):
    set_account_deadlines refuses already_paid / payment_exists. The Hub says
    why. A cash order's deadline stays live while a balance remains.
  - THERE IS ONE DEADLINE: never re-add settlement_due_at or any settlement
    date to layaway_accounts, set_account_deadlines or the creation forms.
  - EXTENSION is a later deadline and only while the order is live. An expired
    or cancelled order is NEVER revived (exception: cash-order revive, Bug #217;
    on a WEB cash order it is ONE RPC, revive_web_cash_order_atomic — never
    revive a web order with client-side writes).
  - A forfeit of a web layaway (staff or automatic) returns its stock in the
    same transaction/statement (stock_released_at); reactivation re-holds it or
    fails with web_layaway_stock_unavailable (trigger
    trg_release_forfeited_web_layaway_stock covers automatic forfeits, so
    auto-forfeit-settlement stays LOCKED). Both paths send the storefront
    layaway-forfeited email. Reactivation is all-or-nothing
    (reactivate_layaway_atomic).
  - EXPIRY: expire_web_layaway_atomic (hourly sweep) releases a web plan whose
    deposit never arrived; refuses already_paid, payment_exists,
    submission_pending (INVARIANT 12). There is NO cancel-after-deposit.
  - The writer refuses on NOT eligible OR term_downgraded — never drop
    term_downgraded as redundant.
  - TWO BASES, NEVER CONFLATED: deposit = 30% of the TOTAL; loyalty = PRODUCT
    amount only, less points redeemed, ALWAYS IN YEN (even on a peso plan).
  - Currency is the customer's choice; peso plans convert at the stored fx_rate
    and the parts sum exactly. Web orders PAID IN FULL may settle in yen or
    pesos too (2026-09-25): create_web_order_atomic converts total and shipping
    once at the quote's fx_rate, half-up to a whole peso, and stores it in
    cash_orders.fx_rate_used / fx_rate_date; item lines and loyalty_jpy_amount
    stay YEN. EVERY peso figure the `website` function produces (catalog
    price_php, full-payment and layaway checkout quotes, /layaway/quote) uses
    the integer half-up in _shared/settlement.ts (twin: src/lib/web-settlement.ts),
    never Math.round on floats. Mechanics: docs/CASH-ORDERS.md "WEB ORDERS IN PESOS".
  - DISPLAYED DOWN PAYMENTS COME FROM THE HUB (2026-09-25): the storefront never
    computes or converts money. Catalog down_payment_jpy/_php/_pct come from
    website_down_payments (which calls layaway_quote — never a TypeScript copy
    of the deposit rule), for the piece alone; a figure the Hub cannot produce
    is OMITTED, never estimated. /layaway/quote takes { price_jpy, currency }
    and converts in the Hub; peso term minimums are min_amount_php. Full text:
    docs/WEB-LAYAWAY.md "DISPLAYED DOWN PAYMENTS".
  - Web layaways are NEVER hard-deleted (trg_prevent_web_layaway_delete).

## PAGE365 IMPORT — NON-NEGOTIABLE (added 2026-09-19)

  Full text: docs/PAGE365-IMPORT.md (moved verbatim 2026-09-24).

  - NO new write path: create-cash-order / create-layaway-account create the
    order exactly as for a typed one (minimums, loyalty gate, permissions,
    is_test prefix all apply).
  - page365-fetch-order NEVER WRITES AN ORDER; it refuses the whole import,
    naming the field, when anything is missing or totals do not reconcile.
  - THE ?sig= IS A CAPABILITY: used for the single fetch and dropped — never
    stored, logged or returned. Only slug and invoice number survive.
  - PAGE365 INVOICES ARE JPY. The account currency is the CSR's choice; PHP
    converts at system_settings.php_jpy_rate, carried on the draft. NEVER use
    currency-converter.ts getConversionRate() server-side or for a stored figure.
  - A RESIZE FEE IS A SERVICE (account_services), never a product line, never
    in loyalty_jpy_amount.
  - ITEM NOTES ARE DISPLAYED, NEVER APPLIED. Page365's OWN stock is never read;
    origin is never auto-set.
  - PHOTOS ARE COPIED, NEVER HOTLINKED; a photo that cannot be copied is null.
  - The double-import guard is uq_*_page365_no + 409 already_imported;
    consume_page365_draft is a courtesy. One invoice_number across BOTH order
    tables (public.invoice_numbers); registry triggers are trg_zz_* and must
    keep sorting after enforce_test_invoice_prefix.
  - DISCOUNTS: price_total is already net (subtotal + shipping −
    price_discount − campaign_discount), reconciled to the yen; a negative is
    refused. A promo code is never written to the order.
  - LOYALTY BASIS = PRODUCT LINES − DISCOUNT, in yen; services and shipping
    never in it.
  - THE UI IS THE ONLY WAY IN AND NEVER AUTO-DECIDES: every field editable, the
    customer is SUGGESTED never auto-selected, notes never parsed. The route is
    permissioned on create_cash_order OR create_account.
  - LINE ITEMS ARE WRITTEN INSIDE THE CREATING FUNCTION (_shared/order-extras.ts);
    a failure rolls the order back.
  - STOCK (2026-09-26; updated 2026-09-28 PR 2; docs/PAGE365-IMPORT.md "STOCK"
    and "PR 2"): PAGE365 IS THE STOCK MASTER. With system_settings.
    page365_stock_mode = 'inventory_sync' (live) an import NEVER changes website
    stock: page365_apply_stock (service role, lines from the STORED DRAFT, never
    the browser) CLAIMS each line in page365_stock_lines, matches it (FIRST WORD
    = exactly ONE website_products.sku with exactly ONE variant; else a FLAG,
    never a guess; service/resize skipped) and records it as 'page365_master'.
    'invoice' mode = the #195 decrement (claim, stock_qty >= q, held/released
    via trigger page365_stock_follow_order) — the ROLLBACK only. Former held
    lines are 'absorbed': cancel / expire / forfeit / delete of such an order
    returns NOTHING. Never edit page365_stock_follow_order's body (absorbed and
    page365_master rely on it acting only on held/released). Resolving a flag
    needs a note and never moves stock. Never write page365_stock_lines or its
    stock by hand.
  - "DON'T SYNC WITH PAGE365" (2026-09-28): website_products.
    page365_sync_disabled, switched in Catalog by manage_website_catalog only
    (audited). A switched-off product is ALWAYS skipped: fetch category
    'not_synced', never proposed, never applied (apply reads the switch LIVE),
    photos never copied, and an invoice import never moves its stock in either
    mode. Never set it in a migration.
  - INVENTORY FETCH (2026-09-27; docs/PAGE365-IMPORT.md "INVENTORY"): staff
    read the whole Page365 catalogue (page365-inventory-fetch, chunked,
    resumable, <= 4 req/s) and apply ticked rows. TARGET = max(0, Page365
    available - page365_web_holds - page365_invoice_holds) — a website-reserved
    piece is never put back on sale; unpaid imported Page365 invoices are held
    off while page365_hold_unpaid_invoices is true (open question: does an
    unpaid Page365 invoice lower `available`? — safe either way). Match per
    VARIANT on the code (first word; multi-variant listings use variant names),
    exact, never fuzzy. Decreases pre-ticked; increases need a tick and are sent
    as increases. page365_inventory_apply is COMPARE-AND-SET (stock_qty = seen
    at fetch, else changed_since_fetch), only on a 'ready' run (a partial/failed
    read — outage, count drop > 20 % — applies nothing). #195 'held' variants
    are EXCLUDED only in 'invoice' mode. New codes listed, prices reported,
    Hub-only flagged — never created, repriced or zeroed. Photos: every photo of
    a matched product, one row per (variant, page365_photo_id), staff photos
    never touched; the Catalog save must carry page365_photo_id through (else
    duplicates). An invoice line keeps ONE main photo and reuses the catalogue's
    stored copy when there is one. Customer reviews are never stored.

## CUSTOMER ADDRESSES — NON-NEGOTIABLE (added 2026-09-15)

  A CHECKOUT NEVER DELETES A ROW THE CUSTOMER DID NOT ASK TO REMOVE.
  `customer_addresses` ids are load-bearing: `cash_orders.ship_to_address_id`
  and `checkout_quotes.ship_to_address_id` are both ON DELETE SET NULL, so
  deleting a row blanks the shipping address on every order and quote pointing
  at it — silently, with no error and nothing in any log. The original
  `replace_customer_addresses` did exactly that on EVERY checkout that sent an
  address (DELETE-then-INSERT with fresh uuids), and the storefront calls it on
  every one.
  The writer is `upsert_customer_addresses`: an entry carrying an id belonging
  to that customer UPDATES in place, an entry without one INSERTs, and a row
  the payload does not mention is LEFT ALONE. `replace_customer_addresses`
  survives as a forwarding alias ONLY, so a stale caller cannot reach the old
  body. Never re-introduce a delete-all write path here; a real delete route
  belongs behind its own endpoint, per address.

  AN ORDER KEEPS ITS OWN ADDRESS. `cash_orders.ship_to_snapshot` and
  `layaway_accounts.ship_to_snapshot` hold the address AS IT WAS at creation
  and are AUTHORITATIVE for display; the FK is a convenience link to the live
  address book and may legitimately go NULL. Every snapshot — both writers and
  any backfill — comes from `public.address_snapshot(uuid)` and from nowhere
  else, so a backfilled order and a newly-written one cannot disagree. Any new
  surface showing where an order went reads the snapshot first and the FK only
  as a fallback (`shipToAddress()` in `website/index.ts` is the reference).
  `layaway_accounts` has NO `ship_to_address_id` at all: the snapshot is the
  only address a plan carries.

  THE TWO STORES HAVE NOT DIVERGED, and that is worth keeping true. The Hub
  reads the flat columns on `customers`; the storefront reads
  `customer_addresses`. As of 2026-09-15 the drift is zero — the flat columns
  hold a COUNTRY in `location` and nothing else (879 rows), the table holds 1
  real row, and the 2026-09-10 backfill that manufactured 871 junk "addresses"
  from `location` was reverted the same day (20260910160000). Convergence is
  filed in docs/PENDING.md, not done. Never seed `customer_addresses` from the
  flat columns again.

## SIDEBAR ARCHITECTURE — NON-NEGOTIABLE (2026-05-31, refresh PR #165)

  Full text (types, navigation, badges, accordion): docs/SIDEBAR.md (moved verbatim 2026-09-24).

  - Sub-items navigate via `${parentPath}?tab=${child.tab}`; every parent page
    keeps ?tab in sync both ways (refresh, deep links, back/forward).
  - Gating: adminOnly / permPath (canSeeNav) / permFilter (can()); a parent
    whose sub-items are all gated out is hidden.
  - LOCKED UI: ONE active indicator — the sliding gold ActivePill; never
    reintroduce the old parent border / sub-item accent. It FLIPs from its last
    rect; never swap back to framer layoutId without a shared layout route.
    The expanded group is seeded from the route on first render. Icon-only
    collapse is remembered in localStorage 'cj-hub-sidebar-open' (every access
    try/catch). Hover accordion, one parent open, no hover delay. Section
    headers: Deco serif small caps + trailing gold hairline. Sub-item labels
    are text-only.

## PAYMENT SUBMISSION FLOW (locked 2026-04-13; universal submission 2026-06-12)

  Full text (restore path, proof rules history, sender_name): docs/PAYMENT-SUBMISSIONS.md (moved verbatim 2026-09-24).

  - UNIVERSAL SUBMISSION: recording a payment ALWAYS creates a pending
    payment_submissions row, for EVERY role incl. admin/finance. The payments
    table is written ONLY by review-payment-submission on an explicit reviewer
    Confirm. Nothing else writes status 'confirmed'.
  - ONLY confirmed submissions appear in Proof of Payment.
  - PROOF REQUIRED on EVERY submit path (portal and staff; 400 "Proof of
    payment is required"; previews exempt) and to CONFIRM (400). Bulk import
    rows need proof too.
  - RESTORE (reject_submission permission): rejected → submitted only; keeps
    rejection history; writes an audit row; sends no customer notification;
    touches no payments/allocations/schedule/cash_orders.
  - Web reservations: every submit and confirm path refuses an unconfirmed
    reservation with 409 not_ready_for_payment (docs/RESERVE-FIRST.md).

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

  Full text of rules 1–14 with rationale and incident history:
  docs/LOYALTY-RULES.md (moved verbatim 2026-09-24). The rules themselves:

  1. Portal signup (setup-customer-account) creates the customers row and
     auto-enrolls at Glimmer; an existing email only links. DUPLICATE BLOCK:
     find_customer_matches on name / Facebook name / mobile / email; any match →
     409 already_registered, nothing created, bell duplicate_signup_blocked. Same
     rule on website POST /auth/customer and every Hub create path — no "create
     anyway". EVERY enrollment path MUST set enrollment_source, write one
     'enrolled' ledger row naming the source, send the 'enrolled' sheet event and
     set synced_to_sheet_at on success. Customer-authed callers may send only
     portal_join / storefront_checkout / storefront_join. website POST
     /loyalty/join NEVER enrolls (it records a failed enrollment and raises bell
     'loyalty_join_failed').
  2. review-payment-submission is the SOLE award path: layaway on DP confirm,
     cash on full completion. NEVER on installments. No DB-trigger award path.
  3. Awards are currency-agnostic, based on loyalty_jpy_amount; skip
     'no_loyalty_amount' when <= 0 or null.
  4. system_settings.loyalty_enabled gates award and join server-side,
     fail-closed (anything but strict true = disabled).
  5. Flipping loyalty_enabled = true is THE go-live event (owner, via SQL).
  6. The portal shows lot expiry (next-expiring lot, "expiring soon" < 30 days).
  7. Redemption APPROVE: admin / finance / staff. CANCEL and VOID: admin only,
     frontend and server.
  8. The staff bell covers the full redemption lifecycle (requested / approved /
     cancelled / voided), non-blocking.
  9. REDEEMED POINTS ARE NOT RETURNED on order cancellation/forfeiture — only
     when an admin voids the REDEMPTION itself. Applies to Shopify too. Never
     add automatic point return on cancellation.
  10. Partial Shopify refunds revoke earned points proportionally (redeemed
     never returned; promo_bonus lots untouched).
  11. TIER = LIFETIME cumulative spend, never a 12-month window. The only time
     rule is the 180-day inactivity step-down (one tier; requalify_spend_jpy to
     regain). NO grace period, NO retroactive tier changes. Copy says "lifetime
     purchases". Emails: warning at 150 days, notice on step-down, restored.
  12. loyalty_transactions is APPEND-ONLY; awards are idempotent through
     loyalty_award_claims; every reversal is a ledger row, never a delete.
     loyalty_integrity_report(): a healthy report is EXACTLY ONE ROW (the Test
     Customer baseline, docs/TEST-ACCOUNTS.md); any other row is a finding.
  13. POINTS are reversed from surviving lots; SPEND from the order's own ledger
     basis (loyalty_order_spend_basis). NEVER use loyalty_jpy_amount as the
     reversal basis; NEVER honour revoke_loyalty_points' p_spend_jpy (ignored).
     Exactly ONE revoke_loyalty_points (10 args) — never add a second overload.
     A reversal that cannot be sourced (no earned/revoked row, money WAS
     received) raises audit + bell 'loyalty_reversal_unsourced' and RETURNS,
     never refuses. An order that received NO money stays silent — a
     loyalty_jpy_amount alone proves nothing (2026-09-24). Corrections that add
     points are an 'earned' row + revoke-and-replace of the one active
     order_earn lot, expiry preserved (never 'adjusted').
  14. CUSTOMERS NEVER SEE LEDGER NOTES — build lines through toCustomerActivity;
     customer-portal never selects notes; a new transaction type needs a label
     key in i18n/portal.ts.
  - A CLOSED ORDER CAN NEVER BACK A REDEMPTION (form, create, and
     approve_redemption_atomic). Layaway closed = cancelled / forfeited /
     completed / final_settlement; a cash order is open only while pending. A
     catalog_reward invoice must be the customer's own open order.

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

  - The 2026-05-20 backfill and the Honey Faye restoration:
    docs/LOYALTY-RULES.md (moved verbatim 2026-09-24).

## PLAN DURATION — payment_plan_months IS AUTHORITATIVE (2026-05-20)

  Full text (examples, the aborted f113cd2 fix, change-payment-plan mechanics):
  docs/PLAN-DURATION.md (moved verbatim 2026-09-24).

  - payment_plan_months is the configured duration from plan_configurations
    (3/6/8/10/12), enforced by enforce_plan_minimum_amount. Engines read it
    directly for the final-month cap and forfeiture — correct by design.
  - NEVER derive plan length from the schedule (MAX(installment_number) or
    count). NEVER write payment_plan_months from add/delete-installment. A
    schedule/column mismatch is an admin-edit anomaly — do not "fix" the column.
    DO NOT REOPEN the schedule-derived approach (f113cd2, reverted 29505ae).
  - The ONLY plan-change path: change-payment-plan (permission
    change_payment_plan) → change_payment_plan_atomic, called only from Manage
    Invoice. Active/overdue only; new plan 3/6/8; reason required. Pending
    submissions do not block. FIXED rows 1..k are never touched; open rows are
    UPDATED IN PLACE, never deleted and re-inserted (deleting cascades). apply
    false = preview. restructure-account is NOT a plan-change path.

## LOYALTY GOOGLE SHEET SYNC — NON-NEGOTIABLE

  Full taxonomy, column layout and architecture: docs/LOYALTY-SHEET-SYNC.md (moved verbatim 2026-09-24).

  - Canonical event_type values ONLY — Members tab: enrolled, tier_changed,
    status_changed, admin_edited; Transactions tab: earned, bonus, redeemed,
    expired, adjusted, refunded, revoked, birthday_bonus. Every emission carries
    member_id and is fire-and-forget (never blocks the caller).
  - Never change sheet column order without the matching header change; never
    remove the activity_status derivation (Members col I).
  - Fast path (writer POSTs sync-loyalty-to-sheet and sets synced_to_sheet_at)
    + hourly recovery (loyalty-sheet-reconcile, cron :07, Vault auth).
    INVARIANTS: every loyalty_transactions row eventually reaches the sheet;
    synced_to_sheet_at is write-once (NULL → timestamp); loyalty-sheet-reconcile
    is intentionally unauthenticated; award-loyalty-points keeps its strict auth.

## FILL-PAYMENT-TRACKING DUAL OUTPUT (added 2026-06-06)

2026-06-06: `fill-payment-tracking` now also generates the monthly
tax-declaration file (`申告用フォーマット_MM Month YYYY`) into the
Tax Account Drive folder from the same source upload — Overseas
tab columns B/D/E, Japan tab columns B/D/G (Deposit date /
Customer / Amount), non-blocking relative to the tracking output.

2026-07-06: on success, fill-payment-tracking upserts its output sheet ID into system_settings.payment_tracking_sheet_id so append-payment-tracking always targets the newest generated sheet.

2026-07-06: pre-cohort payment months are totalled into the first month column (merged by column), not dropped — Bug #246.

2026-09-11: append-payment-tracking is now a per-invoice REWRITE (not additive). It locates the invoice across every sheet in system_settings.payment_tracking_sheets ([{id, cohort:"YYYY-MM"}], newest first) and rewrites G..(TOTAL-1) from get_tracking_for_invoices. Body: { invoice_number }. fill-payment-tracking prepends each generated sheet to that array; the scalar payment_tracking_sheet_id is kept for compatibility only. Callers must await the call (isolate shutdown killed unawaited appends).

2026-09-11 (follow-up): every payment-mutation edge function (review-payment-submission, void-payment, edit-payment-amount, restore-payment, void-cash-payment, restore-cash-payment) calls `refreshPaymentTracking(invoice, caller)` from `_shared/payment-tracking.ts` before returning. Any new function that inserts, voids, edits, or restores a payment MUST add the same call. Only exception: shopify-webhook (Shopify orders are not in tracking rosters).

## EMAIL DELIVERY MONITORING — NON-NEGOTIABLE (2026-09-13)

  Full text: docs/EMAIL-DELIVERY.md (moved verbatim 2026-09-24).

  - EVERY email attempt is logged via _shared/email-log.ts recordEmailAttempt()
    (sent | failed | suppressed | skipped) by both senders. A new sender that
    bypasses the helpers MUST call recordEmailAttempt() itself. A row absent from
    email_send_log means the send was never reached.
  - Sent rows never carry idempotency_key (kept in metadata).
  - The first refusal raises bell 'email_send_refused' (max once/24h).
  - email_delivery_report(p_hours) gives the verdict (refused / silent /
    degraded / ok); cron email-health-check 00:50 UTC raises
    'email_delivery_outage'. Shown in the sidebar pill, Dashboard banner and
    Settings. REPORT-ONLY — nothing re-sends automatically (owner decision).

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

   Canonical typecheck: `npx tsc -p tsconfig.app.json --noEmit` — exit 0
   with no output as of 2026-09-11 (f31ab09). Any error is a regression;
   there is no accepted baseline. (`tsc --noEmit` without -p is a
   documented false green.)

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

## Migrations baseline & FUNCTION CHANGES — NON-NEGOTIABLE

  Full text (baseline description, the Bug #280 incident, drift-audit census):
  docs/MIGRATIONS.md (moved verbatim 2026-09-24).

  - supabase/migrations/ holds the 2026-07-05 live-introspected baseline plus
    later migrations; supabase/migrations-archive/ is history only. LIVE is
    authoritative. NEVER push the baseline to live (db push / migration up).
    New schema changes are NEW migration files; never edit the baseline.
  - Every migration version (14-digit prefix) must be unique:
    `ls supabase/migrations | cut -c1-14 | sort | uniq -d` prints nothing.
  - FUNCTION CHANGES START FROM LIVE (Bug #280):
    1. Never rebuild a function body from the repo. Start from
       pg_get_functiondef on live. Prefer an md5-guarded in-place patch; for a
       full replace, reconstruct with your edits reversed and require its md5 to
       equal live before writing the migration.
    2. A SQL Editor change to a function body gets a record-only migration in
       the same session.
    3. Run scripts/function-drift-audit before any migration that redefines a
       function; all three buckets (a_differs, b_live_only, c_repo_only) must
       stay 0.
  - After any DROP + CREATE FUNCTION, re-assert its REVOKE/GRANT in the same
    migration (the default ACL grants PUBLIC; 2026-09-24).

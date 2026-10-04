# Cha Jewels Layaway System — Claude Code Context

## ⚠️ MAINTENANCE — READ BEFORE EDITING THIS FILE

This file is the LEAN CORE: durable, always-load rules only (trimmed 2026-05-22
and 2026-10-02). History, status and feature mechanics live in `docs/`, read on
demand — NOT injected every turn.

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
- docs/CASH-ORDERS.md — cash order confirm/expiry/partial-payment mechanics; rules moved 2026-10-02
- docs/SCHEMA-FACTS.md — schema facts, operational learnings, proof-of-payment, account notes; rules moved 2026-10-02
- docs/RETROACTIVE-AND-EMAIL.md — retroactive enrollment award + email rate limit
- docs/LOYALTY-LIFECYCLE.md — loyalty lifecycle integration (Bug #99); rules moved 2026-10-02
- docs/HEALTH-CHECKS.md — health checks 15-21 + periodic health queries
- docs/KNOWN-ISSUES.md — DP-detection caveats
- docs/VERIFICATION.md — how to run account health verification
- docs/TEST-ACCOUNTS.md — benchmark test account setups (TEST-001..005)
- docs/AUTO-DEPLOY.md — ARCHIVED (the removed, never-working GH Actions deploy; deploys are Lovable only)
- docs/PORTAL-PIN-AUTH.md — VERIFY: may be stale (portal migrated to email/password)
- docs/RECENT-UPDATES.md — older changelog (archived)
- docs/SHOPIFY-INTEGRATION.md — Shopify↔Hub integration architecture & roadmap (design locked, Phase 0 done)
- docs/STORE-CREDIT.md — store credit (Phase A): policy, schema, RPCs, edge functions, UI, notifications; rules moved 2026-10-02
- docs/WEBSITE-VERCEL.md — Vercel storefront integration: `website` API contract, revalidation chain, the three secrets, go-live checklist
- docs/SERVICE-REQUESTS.md — customer service requests: how they differ from service_jobs, statuses, the is_test exclusion, the untyped-table cast
- docs/NEWSLETTER-SUBSCRIBERS.md — newsletter subscribers: the table, the is_test rule, why re-subscribe never touches consented_at, and what a Hub send would actually require
- docs/RESERVE-FIRST.md — RETIRED by PR 10 (2026-10-01), history only; every checkout is a draft (docs/WEB-ORDER-DRAFTS.md)
- docs/WEB-ORDER-DRAFTS.md — website orders PR 3: drafts held until staff Confirm (dormant behind system_settings.web_checkout_mode), the materialize contract, web_released_at; rules moved 2026-10-02
- docs/WEB-PAYMENT-REMINDERS.md — stage D payment reminder + 48h reservation bell: eligibility, timing, the off/owner_only/on switch, email history
- docs/PAIDY.md — Paidy あと払い: offer rule, dashboard capture + Hub auto-record, payment lock, cases, webhook inbox, go-live
- docs/SQUARE.md — Square card payments: switch + public ids, square_payments ledger, agreement, capture/void
- docs/MEDIA-CUTOUTS.md — automatic background removal for website photos (PR 1 of 3): queue keyed by source URL, worker, quality checks, switch + cap, Photos tab, timing test / D10 path; rules moved 2026-10-02
- docs/HERO-PICKS.md — hero from ticked product cut-outs: website_hero_picks, the hero_photo_source switch (ships hero_record), carry-over, the release order (PR 1–4); rules moved 2026-10-02
- docs/HERO-CUTOUTS.md — the HERO-ONLY cut-out record (original tool, BiRefNet via the storefront workflow), separate from Photoroom: approval-first, go-live switch (admin, ships "approve"), admin approve/reject audited, service-only writer, once per unchanged source
- docs/SHIPPING-FEES.md — the shipping rate card (Website → Settings → Shipping fees, admin, audited, never deleted) and couriers (Pabitbit on the LBC template; planned_shipping_method_id; PH-only default)
- docs/WEBSITE-WORKSPACE.md — the /website workspace: six tabs, the manage_website_catalog / manage_website_content split, the /website-catalog redirect, where each website table's editor lives. Payment details, Payment reminders, Paidy, Card payments (Square) and Shipping fees live on Website → Settings, ADMIN ONLY (/settings?tab=payment-details redirects)
- Every doc named in a "Rules moved from CLAUDE.md" pointer below holds the
  full text moved out verbatim on 2026-09-24 / 2026-10-02 under that heading;
  CLAUDE.md keeps the one-line rules and the pointer.
- SIZE LIMIT: under 100k characters (Claude Code stops loading at 150k). Long
  reference text goes to docs/; rules stay here.

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
  ONE PESO RATE (owner 2026-10-03): the WEBSITE uses this same setting for
  every ₱ figure (_shared/php-jpy-rate.ts); fx_rates / fetch-fx-rate are
  retired history — never re-add a market rate.

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
  - SHOPIFY OPS (full text: docs/STORE-CREDIT.md "Rules moved from CLAUDE.md"):
    cancel with "Later" (no refund) ONLY; partial refunds ONLY via Edit order →
    Update order, NEVER the Refund page; the "You owe the customer" banner is
    cosmetic — never settle it; cash_orders 'cancelled' is TERMINAL (every
    shopify-webhook status writer chains .neq("status","cancelled"));
    service-role callers pass p_source = 'shopify_webhook'.
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
  - WEB ORDERS (2026-09-13): cancelling a PAID web order records a REFUND
    DECISION (cash_orders.refund_status); credit is minted ONLY for
    store_credit_issued, never automatically; the one terminal RPC is
    terminate_web_order_atomic; web orders are NEVER hard-deleted — docs
    "Rules moved from CLAUDE.md".

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
  - AN ASSERTION NOBODY CAN SATISFY IS WORSE THAN NO ASSERTION (2026-09-15, third
    occurrence): ask only for what the agent can observe with the access it has
    (the deployed function body, version, timestamp), never a synthesised user
    journey; proof that needs a human in a browser goes to the owner's own
    acceptance run. Full text and the three incidents: docs/LOVABLE-VERIFICATION.md
    "Rules moved from CLAUDE.md".

## DOMAIN ARCHITECTURE — STRICT RULE (NON-NEGOTIABLE)

  Violated repeatedly. Everyone (human, Claude, Lovable) MUST apply it before
  suggesting, testing, documenting or sharing any chajewelsjp.com URL.

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

  Check the audience first: customer-facing → portal.*; internal → app.*

  FORBIDDEN PATTERNS (recurring violations): a customer ever told to visit
  app.*, app.* in any customer-facing material or test URL, staff using
  portal.*, mixing the two — list: docs/SCHEMA-FACTS.md "Rules moved from CLAUDE.md".

  Same React build, routed by host, functionally separate. The customer must
  NEVER see app.*; staff must NEVER work on portal.*.

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

## PRODUCT REVIEWS (PR-R1, 2026-09-30): order-linked invites, owner approval before anything is public — docs/SCHEMA-FACTS.md "Product reviews".

## SHIPPING FEES & COURIERS — NON-NEGOTIABLE (2026-09-27; docs/SHIPPING-FEES.md)

  - Charged on the pieces subtotal; highest active threshold reached applies.
    Live: JP 0→800, 8000→0; PH 0→3500, 100000→0. "JP free from ¥50,000" is retired.
  - shipping_rates changes ONLY via set_shipping_rate / deactivate_shipping_rate
    (admin, audited; Website → Settings → Shipping fees). NEVER delete a rate —
    deactivate (guard trigger refuses DELETE/TRUNCATE). Never edit it in SQL.
  - planned_shipping_method_id has NO DB default; only PH is preselected
    (Pabitbit, LBC number + LBC template) by the confirmation screen.

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

  record-payment caps DP and non-DP independently; submit-payment (portal) is a
  flat 3-cap; record-multi-payment is uncapped (staff batch path); HTTP 429 on
  cap exceeded. docs/PAYMENT-SUBMISSIONS.md "Rules moved from CLAUDE.md".

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

Admin short-circuit in can(): an 'admin' user gets true unconditionally
("admin role → always full access"), so a newly-added permission key that is
not yet seeded in role_permissions never denies an admin.

## HELP CENTER SCREENSHOTS — NON-NEGOTIABLE (updated 2026-06-01)

Help Center screenshots live in the Supabase Storage bucket `brand-assets` (public read), NOT in the repo, stored WITHOUT file extensions (`Signin_Page`, not `Signin_Page.png`); Markdown references omit the extension too.

Markdown in src/help-content/ references a screenshot by filename only (no
extension); Help.tsx resolves it to the bucket's public URL; adding one needs
no code change. docs/SCHEMA-FACTS.md "Rules moved from CLAUDE.md".

## BRAND STYLE STANDARD (Deco Ledger, 2026-07-06)

  Full text incl. the tracked-debt list (nested workflow, package-lock
  registry quirk, email-template gold, SheetJS pin), background photos and
  video assets: docs/BRAND-STYLE.md (moved verbatim 2026-09-24).

  - Gold: --gold-500 #C9A227 (primary), --gold-300 #E5C860 (hover/focus). The
    old #D4AF37 is RETIRED. Gold only via theme tokens (src/index.css,
    src/theme/tokens.ts); hex literals ONLY in src/theme/ and src/index.css.
  - Semantic tokens --success/--warning/--danger/--info exist; signature
    divider is the 1px gold hairline (.hairline-gold / -b / -t).
  - TWO CHECKS, both must be 0: (1) retired gold repo-wide, case-insensitive;
    (2) token discipline in src outside src/theme/ (do NOT widen — email
    templates inline #C9A227). Commands: docs/BRAND-STYLE.md "Rules moved".
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
- Loyalty Product Amount (JPY) is REQUIRED when the selected customer has a loyalty tier, on BOTH layaway and cash-order creation (frontend + edge function 400 LOYALTY_AMOUNT_REQUIRED); optional for non-members; editable later only with edit_loyalty_amount and only until the order earns points (trg_guard_loyalty_jpy_amount). Full text: docs/SCHEMA-FACTS.md "Rules moved from CLAUDE.md".

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

  An existing partially_paid row's total_due_amount is the FULL amount owed;
  remaining = total_due_amount - paid_amount at read time (audit_account Check
  12 does the same). docs/RECONCILIATION.md "Rules moved from CLAUDE.md".

  CACHE-STALENESS TEST (2026-05-23): a row is genuinely stale ONLY when
    total_due_amount ≠ base_installment_amount + penalty_amount + carried_amount;
    total_due_amount ≠ actual_remaining is the payment, not drift. Repair by
    resetting to that GROSS sum; NEVER flatten total_due_amount to
    actual_remaining. docs/RECONCILIATION.md "Rules moved from CLAUDE.md".

## Git Workflow — NON-NEGOTIABLE (changed 2026-09-11)

**`main` is production.** A push to `main` deploys the Hub frontend to live
Firebase Hosting (`chajewelslayaway`). It is changed only by a PR from
`develop`, merged by Cynthia — plus Lovable, see the exception below.

**`develop` is where work lands.** All Claude Code work goes to `develop`, or to
a short-lived feature branch merged into `develop`. Never push to `main`
directly. A push to `develop` deploys to the `develop` Firebase Hosting preview
channel; every PR gets its own `pr-<number>` channel, and the workflow posts the
URL as a single sticky comment on the PR.

History, rationale and the incidents behind every rule in this section:
docs/GIT-WORKFLOW.md "Rules moved from CLAUDE.md". The same workflow is in force
on the storefront repo (`chajewels/cha-jewels-web`).

### THE LOVABLE EXCEPTION — main is not protected against Lovable

Lovable mirrors `main` and commits its own work to `main`; it does not use
`develop`. **This is accepted, not a gap** — an approved Lovable message *is*
the review (docs/GIT-WORKFLOW.md).

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

Lovable deploys and applies migrations from its mirror of `main`; a migration on
`develop` is invisible to it and the apply message's source assertions fail — by
design, never to be weakened.

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

Why: the 2026-09-11 transfer_payment_methods message was sent twice — docs/GIT-WORKFLOW.md.

- Versioning: package.json version is the app version (shown in the sidebar with the build commit). Bump MINOR when a feature ships, PATCH for fixes — only when a prompt explicitly says to bump.

## TOOL OWNERSHIP RULES (updated 2026-05-10)

  Lovable → src/ AND supabase/functions/ file creation and editing.
            Lovable ALSO handles ALL Supabase edge function
            deployments via direct Supabase Dashboard tooling access.
            Lovable IDE is the ONLY edge-function deploy path; the GitHub
            Actions deploy workflow was removed (it never deployed anything —
            docs/AUTO-DEPLOY.md "Rules moved from CLAUDE.md").
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
  - DEPENDENCIES ARE FROZEN: no one, Lovable included, touches package.json,
    bun.lock, drizzle/ or prisma/, not even to "fix preview errors". A change
    is a "deps:" PR updating .github/package-guard.sha256; CI fails all else.
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

  Opening and closing words are picked at random per open from public.message_lines (owner decision 2026-10-01). The templates below are line 1 of each pool and the fallback. Figures, links, PIN line, headers, notices and policy sentences are fixed. Pools and placeholders: src/lib/message-lines.ts and docs/SCHEMA-FACTS.md. Lines are edited ONLY in Hub → Settings → Message lines (admin, audited; line 1 of every pool is locked = the code fallback; lines are switched off, never deleted).

  The SINGLE PAYMENT, SPLIT PAYMENT, FULLY PAID and BATCH PAYMENT template
  texts (line 1 of each pool = the code fallback) are in docs/SCHEMA-FACTS.md
  "Rules moved from CLAUDE.md" and src/lib/message-lines.ts; the PIN line is
  shown only when [portalLink] is a token link (PORTAL LINK RULE below).

### PORTAL LINK RULE (both builders: src/lib/portal-link.ts, _shared/portal-link.ts)

  1. customers.portal_password_at set    → bare URL (sign-in), intent honoured
  2. else a live (active, unexpired) token → token URL, intent honoured
  3. else auth_user_id set                → bare URL, intent honoured
  4. else                                 → https://portal.chajewelsjp.com/portal
  auth_user_id alone is no password (magic-link sign-ins set it). Column set by
  setup-customer-account + portal-auth Path 0 on a password sign-in.
  PIN line: shown iff the built URL is a token link (isTokenLink) and a PIN
  exists; never keyed on auth_user_id. History: docs/FIXED-BUGS.md
  "Portal password customers got token links" (2026-09-28).

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
    allocate_payment_atomic (only the EXCESS enters the
    waterfall; the required portion is a payment with no allocation). DP
    detection: reference_number starts with 'DP-' OR remarks ILIKE '%down%'
    (non-voided). Void path, audit_account's v_dp_allocated term and history:
    docs/RECONCILIATION.md "Rules moved from CLAUDE.md" (Bug #160, Bug #250).

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
  → loyalty-inactivity-check 00:25 → loyalty-award-sweep 00:35 (its own job;
  never inline). auto-expire-cash-orders (:40 hourly) is the ONLY web/cash
  expiry path; process-email-queue has NO cron; NEVER re-add a second cron
  pointing at /send-reminders. Full table: docs/CRON-AND-EDGE-AUTH.md "Rules moved".

  CRON AUTH RULE: a pg_cron job calling a service-role-gated function MUST read
  the key from Vault at fire time ((SELECT decrypted_secret FROM
  vault.decrypted_secrets WHERE name = 'email_queue_service_role_key')) — never
  an embedded key. Copy the pattern from an existing adopter.

  EDGE FUNCTION SERVICE-ROLE AUTH (locked): service callers by JWT claims
  (parseJwtClaims(token)?.role !== "service_role" → 401) behind verify_jwt =
  true; NEVER compare the token to SUPABASE_SERVICE_ROLE_KEY (Bug #168); NEVER
  an anon-key / isInternalKey bypass; 401 first on a missing header; mutating
  functions also check a real role/permission (403, Bug #170). New or edited
  functions use _shared/cors.ts + _shared/handler.ts. verify-portal-pin stays
  public (PBKDF2-SHA256 100k; never SHA-256; no PIN columns on customers).
  Full text: docs/CRON-AND-EDGE-AUTH.md "Rules moved from CLAUDE.md".

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

Consistent labels across the Finance dashboard; metric definitions (Collected,
Paid vs Due, Penalties Collected, the two Forfeited metrics):
docs/SCHEMA-FACTS.md "Rules moved from CLAUDE.md".

  RULE: "Collected" always means cash received. The schedule-efficiency metric is "Paid vs Due",
  never "Collected".

## REALTIME SYNC (added 2026-05-24)

  useRealtimeSync (src/hooks/useRealtimeSync.ts) is mounted once at the App
  root, internal users only (the portal never opens a channel), and invalidates
  REALTIME_INVALIDATE_KEYS on any postgres_changes event from SYNC_TABLES,
  debounced 250 ms. Published tables and mechanics: docs/SCHEMA-FACTS.md
  "Rules moved from CLAUDE.md".

  When adding a new mutating table or a new dashboard query key:
    - If the table drives a card, add it to SYNC_TABLES.
    - If the key isn't covered by any of the four KEY groups, add it to
      one of them (so it's swept into REALTIME_INVALIDATE_KEYS).

## TEAM MEMBER LIFECYCLE (added 2026-05-24)

  create-team-member creates members and handles deactivate / reactivate
  (admin/manage_team): deactivate = profiles.status 'inactive' + auth ban, the
  user_roles row KEPT; there is NO hard delete. handle_new_user inserts a
  profile ONLY when user_metadata.is_team_member = 'true' (Bug #151). Session
  idle-timeout: 2h with a 5-minute warning, all authenticated sessions.
  Full text: docs/SCHEMA-FACTS.md "Rules moved from CLAUDE.md".

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

  carry-over edge function (/functions/v1/carry-over; confirm_payment permission):
    total_due_amount = existing_total_due_amount + shortfall (NEVER base +
    shortfall — that drops Keep reductions); shortfall is computed from
    source.paid_amount, NOT SUM of allocations; source row → paid, next row gets
    carried_amount. accept-underpayment writes an AUDIT LOG ONLY — zero row
    changes. Steps and body: docs/SCHEMA-FACTS.md "Rules moved from CLAUDE.md".

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

  FRONTEND BINDING: applies to ALL total_due_amount writers, incl. direct frontend .update() calls (Waivers.tsx, ApplyPenaltyCapDialog.tsx). Any recompute of an EXISTING row MUST be base + penalty + carried_amount. ONLY exemption: inserting a brand-new installment row (no carry yet; EditAccountDialog "Add new installments", total_due = base).


## CUSTOMER CODE STANDARD (added 2026-04-19)

  Format: CJ-YYYY-XXXXX
  - CJ = Cha Jewels
  - YYYY = year customer was created
  - XXXXX = 5-digit sequential number incrementing by 8 per year
  - Example: CJ-2026-00008, CJ-2026-00016, CJ-2026-00024

  Auto-generated by trigger auto_generate_customer_code (BEFORE INSERT on customers); all existing customers backfilled.

  The universal customer identifier across all Cha Jewels platforms (Loyalty App sync).

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
  The 7-day grace is NOT permanently consumed: it applies only when no UNPAID
  penalty exists and no other row is overdue / partially_paid, and RESETS when
  the account is fully caught up; waived and paid penalties do NOT count against
  it (penalty-engine week1Offset = graceConsumed ? 0 : 7; AccountDetail
  isInGracePeriod). Full text: docs/PENALTY-AND-FORFEITURE.md "Rules moved".

### Penalty trigger schedule (per overdue month):
  Cycle 1 at due_date + 7 (+0 if grace consumed) and + 14; Cycles 2 and 3 one and
  two months later (final month only) — docs/PENALTY-AND-FORFEITURE.md "Rules moved".

### Penalty engine timing:
  Cron 00:05 UTC daily (8:05 AM PHT); due_date <= today (the due date itself
  included). ACCOUNT-SCOPED RUN (2026-09-20): { account_id } evaluates one
  account with IDENTICAL rules; reactivate-account calls it (non-blocking).
  Full text: docs/PENALTY-AND-FORFEITURE.md (moved verbatim 2026-09-24).

### Freeze guard:
  Accounts with pending payment submissions (status='submitted' or 'under_review')
  are frozen — no new penalties until the submission is resolved.

### Waiver grace period + auto-unwaive (added 2026-08-18):
  An approved waiver holds a penalty for penalty_waiver_grace_days (default 7)
  counted from penalty_fees.penalty_date — NOT the approval date; past the window
  penalty-engine reinstates it ('unpaid', request 'auto_unwaived', audit, email).
  penalty_date is NEVER rewritten. Full text: docs/PENALTY-AND-FORFEITURE.md
  "Rules moved from CLAUDE.md".

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
  Applies to BOTH PATH 2 AND PATH 3, checked BEFORE either path: any account with
  a payment within 90 days is skipped entirely — docs "Rules moved".

### PATH 3 — 6th penalty occurrence → final_settlement:
  Condition: total penalty_fees rows (unpaid + paid) across all unpaid months >= 6
             AND no existing final_settlement_records for this account
             AND last non-voided payment > 90 days ago (shared safety guard with PATH 2)
  Effect: creates final_settlement_records, account status → 'final_settlement'
          Schedule rows are NOT cancelled (stay in 'overdue' status) — only PATH 1
          and PATH 2 (true forfeits) cancel unpaid schedule rows.
  Loyalty preserved (Bug #101): lot stays ACTIVE, no revoke, spend unchanged.

  PATH 3 fixture forensic note: docs/PENALTY-AND-FORFEITURE.md (moved verbatim 2026-09-24).

### After forfeiture:
  - Admin can grant ONE-TIME extension → status = 'extension_active'
  - Extension has an end date (typically 1 month)
  - extension_active + extension expires → 'final_forfeited' (PERMANENT)
  - extension_active + extension month penalty cap reached → 'final_forfeited' (PERMANENT)
  - FINAL_FORFEITED blocks all further negotiation/reactivation

  Extension request window (customer portal): within 7 days of
  layaway_accounts.forfeited_at; after that the button is hidden and the
  closed-window message shown; requests live in extension_requests, reviewed in
  CSR Monitoring → Extensions — docs "Rules moved from CLAUDE.md".

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
Canonical examples: Trade Program, staff_notifications triggers, Finance
Overview KPIs — docs/SCHEMA-FACTS.md "Rules moved from CLAUDE.md".

## ORDER DELETION — NON-NEGOTIABLE (added 2026-09-13)

  A COMPLETED order, or ANY order that has received money (total_paid > 0 or a
  non-voided payment row), is NEVER deleted — by anyone, through any path. This
  covers layaway_accounts AND cash_orders (ACCOUNT-SCOPE rule). It is the
  web-order rule (trg_prevent_web_order_delete) applied to every order.

  Why: orders 19144 and 19278 were deleted in Aug 2026 and their payments
  vanished — docs/CASH-ORDERS.md "Rules moved from CLAUDE.md".

  The only exits for such an order are reversals that stay on the books:
    - cancel (cash) / cancel or forfeit (layaway) WITH a reason
    - void the payment (void-payment / void-cash-payment), then cancel
    - edit-account / restructure for a genuine correction
  A wrong customer or wrong amount is fixed by cancel + re-create, never by
  delete + re-create.

  Enforced in three layers (BEFORE DELETE triggers with no bypass GUC, the
  *_atomic RPCs, the edge functions → 409; migration 20260913110000). Exempt:
  is_test customers; unpaid never-completed orders may still be deleted by
  admin. docs/CASH-ORDERS.md "Rules moved from CLAUDE.md".

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
  R5 Also refuse, with a plain-words reason: an order already earned by ANY member (any marker, incl. in-flight claims and lots on the invoice); Shopify orders; split submissions covering more than one order; any non-cancelled redemption or store credit on the order; closed status; crossing is_test; same owner; not found; ANY Paidy history on a cash order (paidy_order, owner 2026-10-04). Full list: docs/REASSIGN-OWNER.md "Rules moved from CLAUDE.md".
  R6 Catch-up award for the NEW owner only when enrolled AND the award point >= enrolled_at − loyalty_enrollment_grace_days (default 3); award point = the DP payment's created_at (layaway) / completed_at (cash), NEVER date_paid; not yet at the award point → no catch-up — docs "Rules moved".
  R7 Catch-up: current tier multiplier, NO promo; the member's OTHER live lots are only ever EXTENDED, never shortened; order_date + 180 days already past still awards, born expired (the preview must say so) — docs "Rules moved".
  R8 A written reason is required for every reassign. Web orders are allowed, except one with Paidy history (R5).
  R9 If the move commits but the catch-up award fails: the move stands; insert a staff_notifications row type 'reassign_catch_up_failed' naming the invoice, both customers and the error.
  R10 Out of scope: changing the normal award's last_purchase_at = now(); any merge-customers tool.
  R11 IDENTITY MATCH: the target must match the CURRENT owner on full name, Facebook name, mobile (last 10 digits) or email (find_customer_matches normalisation), else refused different_customer_details. Only reassign_owner_unmatched may override, explicitly and with the written reason; the override bypasses ONLY R11, every other refusal still applies — docs "Rules moved".

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
  - Currency is the customer's choice; peso plans and web orders PAID IN FULL
    convert ONCE at the quote's fx_rate with the integer half-up in
    _shared/settlement.ts (twin src/lib/web-settlement.ts), never Math.round on
    floats; item lines and loyalty_jpy_amount stay YEN. docs/CASH-ORDERS.md
    "WEB ORDERS IN PESOS"; docs/WEB-LAYAWAY.md "Rules moved from CLAUDE.md".
  - DISPLAYED DOWN PAYMENTS COME FROM THE HUB: the storefront never computes or
    converts money; website_down_payments calls layaway_quote (never a TS copy of
    the deposit rule); a figure the Hub cannot produce is OMITTED, never
    estimated. docs/WEB-LAYAWAY.md "DISPLAYED DOWN PAYMENTS" / "Rules moved".
  - Web layaways are NEVER hard-deleted (trg_prevent_web_layaway_delete).
  - WEB ORDER DRAFTS are THE ONLY CHECKOUT PATH (PR 10, 2026-10-01): written
    ONLY by the *_web_draft_atomic functions; page365_web_holds MUST count held
    draft lines; web_checkout_mode is 'draft' and stays so (never change it in
    SQL); never re-add a checkout that writes an order or plan directly.
    docs/WEB-ORDER-DRAFTS.md "Rules moved from CLAUDE.md".

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
  - Full text of the sub-rules below (moved 2026-10-02): docs/PAGE365-IMPORT.md
    "Rules moved from CLAUDE.md". One line each here; read the doc before touching
    stock, inventory, landing, schedule or hide-follow code.
  - STOCK: PAGE365 IS THE STOCK MASTER (page365_stock_mode 'inventory_sync'); an
    import NEVER changes website stock; a flag, never a guess; never edit
    page365_stock_follow_order's body; never write page365_stock_lines by hand.
  - "DON'T SYNC WITH PAGE365": website_products.page365_sync_disabled (Catalog,
    manage_website_catalog, audited); a switched-off product is ALWAYS skipped by
    every fetch / apply / import path; never set it in a migration.
  - INVENTORY FETCH: TARGET = max(0, Page365 available − page365_web_holds −
    page365_invoice_holds); match per VARIANT on the code, exact, never fuzzy;
    apply is COMPARE-AND-SET on a 'ready' run only; prices reported, never
    repriced; customer reviews never stored.
  - AUTO-LAND: every NEW code with Page365 available > 0 lands as ONE Hub
    product, status DRAFT (NEVER published), origin UNKNOWN (never guessed);
    publishing is refused server-side until complete; sold-out codes never land.
  - SCHEDULE: pg_cron page365-inventory-schedule (Vault key, every 5 min);
    page365_inventory_auto_apply (default OFF; changed ONLY by
    set_page365_inventory_auto_apply; never flip it in a migration) applies
    decreases AND increases from a 'ready' scheduled run inside its 30-min window;
    prices and re-publishing NEVER apply automatically; one reader at a time.
  - INTERVAL: page365_inventory_interval_minutes ONLY 5/10/20/30, changed ONLY by
    set_page365_inventory_interval (never in a migration); never change the cron
    schedule to change the cadence; the 30-min auto-apply window is not the cadence.
  - HIDE-FOLLOW: SEEN then missing from 2 COMPLETE reads in a row (last seen
    >= 30 min before) → stock 0 + status 'draft'; never a never-seen / Hub-only,
    switched-off or unpublished product, never from a partial read; NEVER
    re-published automatically.
  - QUICK FETCH: scheduled reads and the default button are QUICK; the first
    scheduled read after 02:00 PHT is FULL; never a second reader
    (page365_inventory_reader lease).
  - ITEM TYPES + METAL STAMP: item_kind is EXACTLY jewelry | watch | accessory;
    a metal stamp is required for JEWELRY only, and only to PUBLISH (never re-add
    an every-product or creation-time stamp rule); kind and stamps are read ONLY
    from what Page365 prints.

## MEDIA CUT-OUTS (BACKGROUND REMOVAL) — NON-NEGOTIABLE (added 2026-10-05)

  Full text: docs/MEDIA-CUTOUTS.md.
  - One row per SOURCE PHOTO URL (website_media_cutouts.source_url), never per
    media id (the Catalog save re-inserts media rows). A new URL is a new row;
    old rows and staff decisions are never touched. Originals never modified.
  - The enqueue trigger must never fail a media write.
  - media_cutout_mode off|test|on FAILS TO OFF; invalid cap = 0; off = no
    provider call at all (only staff-uploaded own cut-outs finish); changed ONLY
    via set_media_cutout_settings (audited, guard trigger), never in a
    migration or SQL — docs "Rules moved from CLAUDE.md".
  - "Upload from Photoroom" (Website → Photos): Photoroom APP exports matched by
    file name, applied ONLY as own_cutout through review_media_cutout — no API
    call; never auto-apply an unmatched, duplicate, busy or non-transparent file.
    Full text of this and the next three rules: docs/MEDIA-CUTOUTS.md "Rules
    moved from CLAUDE.md".
  - APPROVAL FIRST (owner 2026-10-02, migration 20261026100000): ok /
    auto_fixed = "To approve"; ONLY `approved` is ever shown on the website or
    ticked for the hero. Automation never overwrites approved/rejected.
  - CUT ONCE / PUBLISH GATE: max 2 paid calls per photo, then Needs owner;
    COMPLETED is FINAL for every role; cut ONLY while the product is published
    (status 'active'), DB-enforced, never bypassed in SQL.
  - PROVIDER ERRORS: Failed = a real PHOTO problem only; provider/account errors
    (401/402/403/429/5xx, no provider, result expired) are never Failed — the
    photo goes back by itself; a refusal is NOT a paid call.
  - PROVIDER = REPLICATE men1scus/birefnet (since 2026-09-28); the reader fails
    to photoroom (its default, not the live choice); a provider is called ONLY
    when selected; provider + price change ONLY via set_media_cutout_provider.
  - PHOTOROOM_API_KEY / FAL_KEY / REPLICATE_* are edge secrets only — never
    repo, DB, logs, chat.
  - A hole INSIDE the piece that is not plausible backdrop (interior_hole) or
    Photoroom uncertainty >= 0.45 (uncertain) is needs_review, never OK /
    auto_fixed. Never drop these checks: "Test 30" shipped two watches with
    erased dials as passed.
  - HERO PICKS: the hero uses product cut-outs an ADMIN ticked "Use on hero"
    ONLY while hero_photo_source = 'product_ticks' (changed ONLY via
    set_hero_photo_source; never in a migration or SQL); hero_lineup_rows is THE
    order (per category, oldest tick first, max 3, never an untagged fallback).
    docs/HERO-PICKS.md "Rules moved from CLAUDE.md".

## WEB PAYMENT REMINDERS — NON-NEGOTIABLE (added 2026-10-04)

  Full text: docs/WEB-PAYMENT-REMINDERS.md.
  - ONE transactional reminder before a confirmed, unpaid WEB order's / web
    layaway's deadline (6h before a 24h one, 24h before a 72h one); max 2 per
    order; web only. It never reads consent / cart-reminder / suppression data.
  - SQL decides (web_payment_reminder_eligible, claim_ under a row lock);
    the edge function only sends via sendStorefrontEmail. Change the TS mirror
    (_shared/web-payment-reminder-rules.ts) with the SQL.
  - Switch web_payment_reminders_mode off|owner_only|on (fail-closed) +
    owner list: changed ONLY via set_web_payment_reminders (admin, audited);
    never in a migration or SQL.
  - Layaway emails are ENGLISH ONLY — subjects AND bodies, every layaway
    email (owner rule, 2026-09-27). Layaway templates have NO lang prop and no
    Japanese copy; never pass one or add one. Guarded by
    development/layaway-english.test.ts (CI). Exceptions: the registered
    company name in the footer and stored transfer-account details.

## CART REMINDERS (STAGES A/B) — NON-NEGOTIABLE (added 2026-10-01)

  Full text: docs/CART-REMINDERS.md. Migration 20261021100000_cart_reminders.sql.
  - PROMOTIONAL: opt-in only (consent kind 'cart_reminder', checkbox OFF by
    default), append-only consent events (never UPDATE/DELETE), full sender
    block in every email; ONE email per cart cycle, never within 7 days, never
    once an order exists.
  - SQL decides WHO and WHEN (cart_reminder_candidates / claim_cart_reminder);
    the sweep only renders and sends. Switch cart_reminders_mode off|owner_only|on
    (fail-closed; seeded off).
  - ONE LANGUAGE PER EMAIL; THE JAPANESE EMAIL NEVER MENTIONS LAYAWAY, a deposit
    or a reserve figure (JA_FORBIDDEN; CI test).
  - EVERY MONEY FIGURE IS THE HUB'S, recomputed at send time; no percentage, rate
    or conversion in the template or sender.
  - The opt-out link touches ONLY the consent row; a PROVIDER unsubscribe
    withdraws consent and rings bell cart_reminder_unsubscribed.
    Full text: docs/CART-REMINDERS.md "Rules moved from CLAUDE.md".
  - Stage D (payment reminders) reads NO cart-reminder data and never will.

## CUSTOMER ADDRESSES — NON-NEGOTIABLE (added 2026-09-15)

  A CHECKOUT NEVER DELETES A ROW THE CUSTOMER DID NOT ASK TO REMOVE.
  `customer_addresses` ids are load-bearing (the ship_to_address_id FKs are ON
  DELETE SET NULL): deleting a row silently blanks the shipping address on every
  order and quote pointing at it — docs/SCHEMA-FACTS.md "Rules moved from CLAUDE.md".
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

  THE TWO STORES HAVE NOT DIVERGED (Hub: flat columns on `customers`; storefront:
  `customer_addresses`), and that is worth keeping true. Never seed
  `customer_addresses` from the flat columns again — docs "Rules moved".

## SIDEBAR ARCHITECTURE — NON-NEGOTIABLE (2026-05-31, refresh PR #165)

  Full text (types, navigation, badges, accordion): docs/SIDEBAR.md (moved verbatim 2026-09-24).

  - Sub-items navigate via `${parentPath}?tab=${child.tab}`; every parent page
    keeps ?tab in sync both ways (refresh, deep links, back/forward).
  - Gating: adminOnly / permPath (canSeeNav) / permFilter (can()); a parent
    whose sub-items are all gated out is hidden.
  - LOCKED UI: ONE active indicator — the sliding gold ActivePill (FLIP from its
    last rect; never framer layoutId, never the old parent border / sub-item
    accent); collapse remembered in localStorage 'cj-hub-sidebar-open'; hover
    accordion, one parent open. Full text: docs/SIDEBAR.md "Rules moved".

## PAYMENT SUBMISSION FLOW (locked 2026-04-13; universal submission 2026-06-12)

  Full text (restore path, proof rules history, sender_name): docs/PAYMENT-SUBMISSIONS.md (moved verbatim 2026-09-24).

  - UNIVERSAL SUBMISSION: recording a payment ALWAYS creates a pending
    payment_submissions row, for EVERY role incl. admin/finance. The payments
    table is written ONLY by review-payment-submission on an explicit reviewer
    Confirm. Nothing else writes status 'confirmed'.
  - ONLY confirmed submissions appear in Proof of Payment.
  - PROOF REQUIRED on EVERY submit path (portal and staff; 400 "Proof of
    payment is required"; previews exempt) and to CONFIRM (400). Bulk import
    rows need proof too: one batch proof, or the row's own proof_url. ONE
    exception (PD1, 2026-10-03): a 'paidy' submission — its proof is the
    authorisation read back from Paidy (docs/PAIDY.md).
  - BATCHES (bulk import, multi-invoice) go through insert_payment_submissions_batch
    in one transaction, idempotent on batch_key (docs/PAYMENT-SUBMISSIONS.md
    "BATCH INSERT"). Never loop single inserts for a batch.
  - RESTORE (reject_submission permission): rejected → submitted only; keeps
    rejection history; writes an audit row; sends no customer notification;
    touches no payments/allocations/schedule/cash_orders.
  - Web reservations: every submit and confirm path refuses an unconfirmed
    reservation (a web order whose ready_confirmed_at is NULL) with 409
    not_ready_for_payment. Since PR 10 (2026-10-01) only a draft can be
    unconfirmed — materialize_web_draft_atomic stamps ready_confirmed_at.

## PAIDY あと払い & SQUARE CARDS — NON-NEGOTIABLE (2026-10-03/04; docs/PAIDY.md, docs/SQUARE.md)

  - Paidy ONLY on a confirmed YEN cash order with a complete Japanese
    delivery address, money due and nothing paid yet (_shared/paidy-rules.ts).
  - PAIDY_SECRET_KEY is an edge secret ONLY (never DB/repo/chat/prompt);
    set_paidy_settings refuses an sk_ key. The website reads the PUBLIC key
    from the Hub; it has no Paidy env.
  - paidy_mode off|test|on (fail-closed) + paidy_public_key change ONLY via
    set_paidy_settings (admin, audited, guard trigger); never in SQL. Key
    family must match the mode; the secret's family is checked too.
  - Trust NOTHING about a Paidy payment not read back from Paidy. The Hub
    NEVER captures: staff capture in the Paidy dashboard, the Hub records it
    (actor paidy_auto); close on Reject; past expires_at auto-rejects (PD4); a
    refund before recording is a staff case. docs/PAIDY.md "Follow-up".
  - PAIDY INTEGRITY: file only via file_paidy_submission_atomic; record only
    via finalize_cash_submission_atomic (exact yen, provider_capture_id).
  - PAIDY LOCK: while cash_order_payment_lock says paidy_*, NO other payment
    on that order, any route incl. store credit / loyalty / restore (two
    triggers); fallback = staff Reject; never reassigned. Paidy rows
    are immutable, never restored; exceptions go to paidy_cases.
  - SQUARE = same shape with a card (S1 2026-10-04): square_mode off|test|on,
    PUBLIC square_app_id / square_location_id, card_agreement_min_jpy (0 =
    EVERY card payment needs the e-signed Card Purchase Agreement, owner D9)
    change ONLY via set_square_settings (admin, audited, guard, refuses a
    token). SQUARE_ACCESS_TOKEN / SQUARE_WEBHOOK_SIGNATURE_KEY: edge secrets
    ONLY. Yen cash orders, any country, never layaway. Authorise on pay,
    CAPTURE only on reviewer Confirm, VOID on Reject.

## LOYALTY AWARD SYSTEM (added 2026-04-27, updated 2026-05-16)

### Canonical award path (SOLE path — Layer-2 triggers removed 2026-05-16):
  review-payment-submission → award-loyalty-points edge function.
  - Layaway: awards ONLY on downpayment submission confirm
    (submissionIsDP). Never on monthly installment confirm.
  - Cash: awards ONLY when the confirming payment makes the
    cash order fully paid (isFullyPaid → status 'completed').
  Do NOT reintroduce a DB-trigger award path (the Layer-2 triggers were DROPPED
  2026-05-16 — docs/LOYALTY-LIFECYCLE.md "Rules moved from CLAUDE.md").

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
  process-loyalty-redemption nets value_applied_jpy off the order's
  loyalty_jpy_amount on approval (floored at 0) and restores it on void; awards
  read the already-net figure — docs/LOYALTY-LIFECYCLE.md "Rules moved".

### DP confirmation loyalty toast (added 2026-06-04):
  review-payment-submission returns loyalty_awards[] on layaway DP confirms and
  PaymentSubmissions.tsx toasts them; cash completion stays fire-and-forget — docs.



## LOYALTY SYSTEM RULES (locked 2026-05-16) — NON-NEGOTIABLE

  Full text of rules 1–14 with rationale and incident history:
  docs/LOYALTY-RULES.md (moved verbatim 2026-09-24). The rules themselves:

  1. Portal signup (setup-customer-account) creates the customers row and
     auto-enrolls at Glimmer. DUPLICATE BLOCK: find_customer_matches → 409
     already_registered on every path, no "create anyway". EVERY enrollment
     path sets enrollment_source + one 'enrolled' ledger row; website POST
     /loyalty/join NEVER enrolls. docs/LOYALTY-RULES.md "Rules moved from CLAUDE.md".
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
  13. POINTS are reversed from surviving lots; SPEND from
     loyalty_order_spend_basis — NEVER loyalty_jpy_amount, NEVER p_spend_jpy;
     exactly ONE revoke_loyalty_points (10 args); a revoke only ever LOWERS a
     tier; an unsourced reversal raises bell 'loyalty_reversal_unsourced' and
     RETURNS, never refuses — docs "Rules moved".
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
    `cancelled` / `expired` (cash). AND money received (total_paid > 0):
    an unpaid order never resets the 180-day clock; a paid order later
    cancelled still counts (owner rule 2026-09-29).

  - loyalty-inactivity-check measures the 166-day warning + 180-day expiry
    against effectiveLastPurchase = GREATEST(stored last_purchase_at, MAX
    successful order_date), read-only (never written back). NEVER use
    `created_at` as an order/purchase date (import contamination) — use
    `order_date` / `date_paid`. docs/LOYALTY-RULES.md "Rules moved from CLAUDE.md".

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
    change_payment_plan) → change_payment_plan_atomic, from Manage Invoice only;
    active/overdue, new plan 3/6/8, reason required; FIXED rows never touched,
    open rows UPDATED IN PLACE; restructure-account is NOT a plan-change path.
    docs/PLAN-DURATION.md "Rules moved from CLAUDE.md".

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

fill-payment-tracking also generates the monthly tax-declaration file;
append-payment-tracking is a per-invoice REWRITE across
system_settings.payment_tracking_sheets and must be awaited. History:
docs/SCHEMA-FACTS.md "Rules moved from CLAUDE.md".

2026-09-11 (follow-up): every payment-mutation edge function (review-payment-submission, void-payment, edit-payment-amount, restore-payment, void-cash-payment, restore-cash-payment) calls `refreshPaymentTracking(invoice, caller)` from `_shared/payment-tracking.ts` before returning. Any new function that inserts, voids, edits, or restores a payment MUST add the same call. Only exception: shopify-webhook (Shopify orders are not in tracking rosters).

## EMAIL DELIVERY MONITORING — NON-NEGOTIABLE (2026-09-13)

  Full text: docs/EMAIL-DELIVERY.md (moved verbatim 2026-09-24).

  - Both senders retry ONCE in-call (2 s, same idempotency_key) on transient errors only — _shared/email-retry.ts; never add a replay job.
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
  - Render email ONLY with renderEmail (_shared/render-email.ts); never
    renderAsync — it splits UTF-8 across stream chunks (U+FFFD). CI-guarded.

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
  JPY: always Math.round() — never display fractional yen; PHP: exactly 2 decimals

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

  NEVER the 2-HTTP-call pattern (rpc('set_config', is_local) then .delete()/
  .update()): set_config is scoped to call 1's transaction (Bug #39) and the
  guarded write fails, sometimes silently. Pattern and example:
  docs/MIGRATIONS.md "Rules moved from CLAUDE.md".

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

5. TYPECHECK — the canonical command is `npx tsc -p tsconfig.app.json --noEmit`
   (the EXACT CI command). NEVER bare `npx tsc --noEmit`: the root tsconfig checks
   ZERO files and always exits 0 — a documented false green (deploy #1896). Any
   error is a regression; there is no accepted baseline. Evidence:
   docs/HUB-UI-MOTION-REVIEW.md "Rules moved from CLAUDE.md".

6. KPI + CHART ANIMATION STANDARDS (2026-07-07): StatCard KPIs pass countUpValue
   + formatValue + staggerIndex, bespoke KPIs use <AnimatedNumber>; charts take
   useChartAnimation() on every series; dashboard hooks use React Query with
   staleTime + keepPreviousData; heavy pages join usePrefetchHeavyPages. A
   surface without them is a defect — docs/HUB-UI-MOTION-REVIEW.md "Rules moved".

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
  - RLS policies call auth.uid() / is_staff() / has_role() inside a scalar
    sub-select — (SELECT is_staff((SELECT auth.uid()))) — never bare (a bare
    call runs once per row; 8 s timeouts, 2026-09-29, PR #265).
  - Every view in public is created WITH (security_invoker = true); a view
    owned by postgres without it bypasses RLS (schedule_with_actuals leak,
    2026-09-29, PR #266).

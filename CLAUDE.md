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
- docs/PAIDY.md — Paidy あと払い, Paidy refunds
- docs/SQUARE.md — Square cards, card refunds, cancellation charge, staff bell emails
- docs/CHECKOUT-CHOICE.md — payment method chosen at checkout + points
- docs/COD.md — cash on delivery (代金引換)
- docs/MEDIA-CUTOUTS.md — automatic background removal for website photos (PR 1 of 3): queue keyed by source URL, worker, quality checks, switch + cap, Photos tab, timing test / D10 path; rules moved 2026-10-02
- docs/HERO-PICKS.md — hero from ticked product cut-outs: website_hero_picks, the hero_photo_source switch (ships hero_record), carry-over, the release order (PR 1–4); rules moved 2026-10-02
- docs/HERO-CUTOUTS.md — the HERO-ONLY cut-out record (original tool, BiRefNet via the storefront workflow), separate from Photoroom: approval-first, go-live switch (admin, ships "approve"), admin approve/reject audited, service-only writer, once per unchanged source
- docs/SHIPPING-FEES.md — the shipping rate card (Website → Settings → Shipping fees, admin, audited, never deleted) and couriers (Pabitbit on the LBC template; planned_shipping_method_id; PH-only default)
- docs/WEBSITE-WORKSPACE.md — the /website workspace: six tabs, the manage_website_catalog / manage_website_content split, the /website-catalog redirect, where each website table's editor lives. Payment details, Payment reminders, Paidy, Card payments (Square) and Shipping fees live on Website → Settings, ADMIN ONLY (/settings?tab=payment-details redirects)
- docs/WEBSITE-COUPONS.md — website checkout coupon codes: pieces only, coupon before points, held/used/released, website_coupon_quote is the only maths, the draft stores reduced figures and the review screen adds the coupon back
- docs/PAYSLIPS.md — Timesheet → Payslips (admin + can_view_all only)
- docs/RECEIPTS.md — website receipts (領収書): web orders only, tax rule, cancel-never-edit, switch, font
- docs/TOOL-OWNERSHIP.md — who edits/deploys what (Lovable, Claude Code, Cloud Shell, SQL Editor); moved 2026-10-28
- docs/DEPLOY-AND-MIGRATIONS.md — generated types, Lovable deploy assertions, migrations baseline & function changes; moved 2026-10-28
- docs/PERMISSIONS.md — permission resolution, adding routes/menu items, team member lifecycle; moved 2026-10-28
- docs/UI-CONVENTIONS.md — help screenshots, brand style, splash, realtime sync, sidebar, frontend workflow; moved 2026-10-28
- docs/DISPLAY-RULES.md — date columns, customer message templates, portal link rule; moved 2026-10-28
- docs/REMINDERS.md — web payment reminders + cart reminders mechanics; moved 2026-10-28
- Every doc named in a "Rules moved from CLAUDE.md" pointer below holds the
  full text moved out verbatim on 2026-09-24 / 2026-10-02 / 2026-10-18 under that heading;
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
  Exception (owner 2026-10-26): the Payslips payment dialog pre-fills yen from today's market rate fetched in the browser (docs/PAYSLIPS.md); nothing is stored.

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
    shopify-webhook status writer chains .neq("status","cancelled")).
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
  - CARD / PAIDY REFUNDS & CANCELLATION CHARGE — full text docs/SQUARE.md, docs/PAIDY.md (moved 2026-10-18):
    - CANCELLATION CHARGE: cash order cancelled on its Japan-time order day → 100 % credit; a later Japan day → 30 % of money PAID kept, 70 % credit; Shopify 100 %; no override; ONE formula cancellation_credit_split + _shared/cancellation-credit.ts.
    - CARD REFUNDS: ONLY in Square; "refund issued" records only Square's COMPLETED refunds of the recorded card money, never the gross; the FAILED/REJECTED or > 1-year exception is ADMIN-approved first.
    - SQUARE ANSWERS ARE VALIDATED: never write a provider figure the Hub could not read.
    - STAFF BELL EMAILS: listed types also emailed to Brenda + active admins; changed ONLY via set_staff_bell_emails; never a customer email.
    - NO DOUBLE COMPENSATION: money refunded through Square or held/taken by a chargeback is NEVER also issued as store credit.
    - PAIDY — SAME RULE: a VERIFIED Paidy refund refuses "store credit issued"; record_paidy_refund is the ONLY paidy_refunds writer.

## Generated files & Lovable deploy verification: read docs/DEPLOY-AND-MIGRATIONS.md before touching src/integrations/supabase/types.ts or writing any Lovable deploy message.

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

## WEBSITE RECEIPTS (領収書) — NON-NEGOTIABLE (owner 2026-10-27; docs/RECEIPTS.md)
  - source_channel 'web' only; written ONLY by web_receipt_sync (deferred triggers) + the receipt RPCs.
  - generate-invoice rule: items excl. tax (round(unit ÷ 1.1) × qty) = 小計; 消費税 = incl. − 小計;
    − 割引 + 送料 (+代引手数料, +延滞金) = 合計 = money received, exactly, or no receipt (+1 bell). Peso: per line at fx_rate_used.
  - Never edit or delete a receipt: cancel (reason kept) and issue a NEW number. Switch
    web_receipts_mode off|test|on ONLY via set_web_receipts_mode. Font: private receipt-assets; no seal.

## PRODUCT REVIEWS (PR-R1, 2026-09-30): order-linked invites, owner approval before anything is public — docs/SCHEMA-FACTS.md "Product reviews".

## SHIPPING FEES & COURIERS — NON-NEGOTIABLE (2026-09-27; docs/SHIPPING-FEES.md)

  - Charged on the pieces subtotal; highest active threshold reached applies.
    Live: JP 0→800, 8000→0; PH 0→3500, 100000→0. "JP free from ¥50,000" is retired.
  - shipping_rates changes ONLY via set_shipping_rate / deactivate_shipping_rate
    (admin, audited; Website → Settings → Shipping fees). NEVER delete a rate —
    deactivate (guard trigger refuses DELETE/TRUNCATE). Never edit it in SQL.
  - Courier mechanics: read docs/SHIPPING-FEES.md before touching planned_shipping_method_id or the courier preselection.

## Permission resolution order: read docs/PERMISSIONS.md before touching permission checks, user_permission_overrides or role_permissions.

## PAYMENT SUBMISSION RATE LIMITS

  Per account per rolling 24 hours (excludes rejected status):

  - Downpayment on trade account (is_trade=true): max 10
  - Downpayment on non-trade account:             max 5
  - Installment / other:                          max 3

  record-payment caps DP and non-DP independently; submit-payment (portal) is a
  flat 3-cap; record-multi-payment is uncapped (staff batch path); HTTP 429 on
  cap exceeded. docs/PAYMENT-SUBMISSIONS.md "Rules moved from CLAUDE.md".

## Adding menu items / routes: read docs/PERMISSIONS.md before touching App.tsx routes, AppSidebar.tsx or PAGE_PERMISSION_MAP.

## Help Center screenshots: read docs/UI-CONVENTIONS.md before touching src/help-content/ or Help.tsx.

## Brand style (Deco Ledger): read docs/UI-CONVENTIONS.md before touching colours, theme tokens, email-template hex, package-lock.json or SheetJS.

## Post-login splash: read docs/UI-CONVENTIONS.md before touching the staff sign-in flow or the splash video.

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

## Git workflow (main = production, develop, the Lovable exception, merge-back, one sender per Lovable message): read docs/GIT-WORKFLOW.md before touching any branch, PR, merge or Lovable message.

## Tool ownership (Lovable / Claude Code / Cloud Shell / SQL Editor, frozen dependencies): read docs/TOOL-OWNERSHIP.md before touching src/, supabase/functions/, package.json or any SQL change.

## Active features (Inquiry Tracker, Timesheet): read docs/SCHEMA-FACTS.md before touching /inquiries, /timesheet or product_inquiries_with_accumulated.

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

Dates, customer message templates, PORTAL LINK RULE: read docs/DISPLAY-RULES.md before touching date columns, message_lines or the portal-link builders.

### Amounts

  - Drop .00 on whole numbers: ₱3,956 not ₱3,956.00
  - Keep 2 decimals when non-zero: ₱22,103.27
  - Always use ₱ symbol
  - Comma separators: ₱22,103.27
  - Never show ₱0 penalties

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

## Realtime sync: read docs/UI-CONVENTIONS.md before touching useRealtimeSync, SYNC_TABLES, or adding a mutating table / dashboard query key.

## Team member lifecycle: read docs/PERMISSIONS.md before touching create-team-member, handle_new_user or the session idle-timeout.

## VIEW FIELD MAPPING

  schedule_with_actuals vs layaway_schedule (write-only cache):
    OLD paid_amount       → NEW allocated
    OLD total_due_amount  → NEW actual_remaining (for display)
    OLD status            → NEW computed_status (display) / db_status (writes)

## CARRY-OVER RULES (updated 2026-03-29)

  No auto-carry on underpayment (PAYMENT ALLOCATION RULES) is enforced in
  review-payment-submission (auto-carry removed 2026-03-29).

  carry-over edge function (/functions/v1/carry-over; confirm_payment permission):
    total_due_amount = existing_total_due_amount + shortfall (NEVER base +
    shortfall — that drops Keep reductions); shortfall is computed from
    source.paid_amount, NOT SUM of allocations; source row → paid, next row gets
    carried_amount. accept-underpayment writes an AUDIT LOG ONLY — zero row
    changes. Steps and body: docs/SCHEMA-FACTS.md "Rules moved from CLAUDE.md".

  carried_amount column:
    Written ONLY by the carry-over edge function
    Cleared by void-payment when a payment that triggered carry is voided

  FORBIDDEN:
    - carried_amount written when source row is still partially_paid
    - Running carry-over on a paid source row (must be partially_paid)
    - Writing carried_amount without a valid carried_from_schedule_id
    - Writing carried_amount when source row paid_amount = 0

## CARRIED_AMOUNT PRESERVATION (added 2026-05-21)

  total_due_amount = base_installment_amount + penalty_amount + carried_amount
  on EVERY recompute. carried_amount is part of the row's full obligation and
  must be re-added whenever total_due_amount is rewritten.

  Recompute sites: penalty-engine (Step 5 + Step 5b self-heal), add-penalty, approve-waiver.

  INVARIANT 5 ("never inflate total_due_amount") means never inflate WITHOUT a
  backing carried_amount/allocation — including the legitimate carried_amount is REQUIRED, not forbidden.

  FRONTEND BINDING: applies to ALL total_due_amount writers, incl. direct frontend .update() calls (Waivers.tsx, ApplyPenaltyCapDialog.tsx). Any recompute of an EXISTING row MUST be base + penalty + carried_amount. ONLY exemption: inserting a brand-new installment row (no carry yet; EditAccountDialog "Add new installments", total_due = base).


## Customer code standard (CJ-YYYY-XXXXX, immutable): read docs/SCHEMA-FACTS.md before touching customers.customer_code or its triggers.

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

### After forfeiture (owner rules 2026-10-20; supersede Bug #108 + the extension-month cap):
  - ONE-TIME reactivation → 'extension_active', only while whole days since
    forfeited_at <= 7: the SAME window as the portal request, staff included
    (refusal = the customer's closed-window words). ONE helper for every caller:
    _shared/extension-rules.ts.
  - END = PHT day of forfeited_at + 1 month, same day, clamped (Jan 31 → Feb 28/29);
    never the reactivation/request date; null forfeited_at → 409 forfeited_at_missing.
  - Penalties continue through the extension (no reset); NONE on/after the end date.
  - 'final_forfeited' ON the end date (today PHT >= end; 08:10 PHT run), frozen
    skip first. The extension-month penalty cap is retired.
  - Customers are told end − 1 ("settle by"); the Hub badge shows the end date.
  - FINAL_FORFEITED blocks all further negotiation/reactivation. ONE exception (R7): one FULL
    settlement submitted with proof ON the PHT final-forfeit day — docs "Same-day settlement".
  Requests: extension_requests, CSR Monitoring → Extensions. Full text:
  docs/PENALTY-AND-FORFEITURE.md "Extension end date and final forfeiture".

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
  - Trade badge and LOCKED UI surfaces: read docs/TRADE-PROGRAM.md before touching the Trade checkbox, badge, trade KPI cards or trends chart.

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

## LAYAWAY CANCEL vs FORFEIT — NON-NEGOTIABLE (owner 2026-10-21)

  FORFEIT = the customer could not settle her dues; CANCEL = she voluntarily
  asked to cancel. ONE writer cancel_layaway_atomic behind cancel-layaway
  (forfeit_account): revokes earned points, never returns redeemed ones, never
  issues store credit; terminal (except a Page365 void-sync cancel, restored
  on renewal). Full rules: docs/LAYAWAY-CANCEL.md.

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

  Writer, dialog, R2 and R11 identity-match mechanics: read docs/REASSIGN-OWNER.md before touching reassign_order_owner_atomic, reassign-order-owner or ReassignOwnerDialog.

  R1 PRIORITY — FIRST CHECK. An account "has points" if its loyalty_members row has total_points_earned > 0 OR cumulative_spend_jpy > 0 OR spend_baseline_jpy > 0 (any loyalty history).
     - current owner has points → REFUSE (points_account_is_current_owner): the order never leaves a points account.
     - both have points → REFUSE (both_have_points): manual handling by the owner.
     - target has points, current has none → allowed.
     - neither has points → allowed.
  R3 Permission: requirePermission('reassign_owner') server-side (live role_permissions/overrides). Setting or changing the loyalty amount inside the reassign additionally requires 'edit_loyalty_amount'.
  R4 The loyalty product amount (excluding shipping and service fees) must be set (> 0) before a reassign completes — always, for every reassign. The dialog collects it if empty.
  R5 Also refuse, with a plain-words reason: an order already earned by ANY member (any marker, incl. in-flight claims and lots on the invoice); Shopify orders; split submissions covering more than one order; any non-cancelled redemption or store credit on the order; closed status; crossing is_test; same owner; not found; Paidy history (paidy_order); card history — any square_card_attempts / square_payments row or a square submission (card_order, S04 2026-10-08). Full list: docs/REASSIGN-OWNER.md "Rules moved from CLAUDE.md".
  R6 Catch-up award for the NEW owner only when enrolled AND the award point >= enrolled_at − loyalty_enrollment_grace_days (default 3); award point = the DP payment's created_at (layaway) / completed_at (cash), NEVER date_paid; not yet at the award point → no catch-up — docs "Rules moved".
  R7 Catch-up: current tier multiplier, NO promo; the member's OTHER live lots are only ever EXTENDED, never shortened; order_date + 180 days already past still awards, born expired (the preview must say so) — docs "Rules moved".
  R8 A written reason is required for every reassign. Web orders are allowed (not Paidy ones, R5).
  R9 If the move commits but the catch-up award fails: the move stands; insert a staff_notifications row type 'reassign_catch_up_failed' naming the invoice, both customers and the error.
  R10 Out of scope: changing the normal award's last_purchase_at = now(); any merge-customers tool.

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
  - Deadline, extension/revive, forfeit-stock and checkout-draft mechanics: read docs/WEB-LAYAWAY.md before touching transfer_due_at, set_account_deadlines, revive_web_cash_order_atomic, web layaway stock release or *_web_draft_atomic.
  - THE DEADLINE IS SPENT ONCE THE DEPOSIT IS CONFIRMED (layaway only):
    set_account_deadlines refuses already_paid / payment_exists. The Hub says
    why. A cash order's deadline stays live while a balance remains.
  - EXPIRY: expire_web_layaway_atomic (hourly sweep) releases a web plan whose
    deposit never arrived; refuses already_paid, payment_exists,
    submission_pending (INVARIANT 12). Expiry never cancels after a deposit;
    a paid plan ends only by staff Cancel or forfeit (docs/LAYAWAY-CANCEL.md).
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

## PAGE365 IMPORT — NON-NEGOTIABLE (added 2026-09-19)

  Full text: docs/PAGE365-IMPORT.md (moved verbatim 2026-09-24).

  - NO new write path: create-cash-order / create-layaway-account create the
    order exactly as for a typed one (minimums, loyalty gate, permissions,
    is_test prefix all apply).
  - page365-fetch-order NEVER WRITES AN ORDER; it refuses the whole import,
    naming the field, when anything is missing or totals do not reconcile.
  - ?sig= capability, item notes, photos, double-import guard, UI, line items, stock, sync switch, auto-land, interval, hide-follow, quick fetch, item types, FOLLOW (code / name / photos follow Page365, never price) and Catalog delete (ONLY via delete_website_product_atomic): read docs/PAGE365-IMPORT.md before touching any Page365 code.
  - VOID SYNC: 'voided' cancels a LIVE order; renewal restores only what the
    sync cancelled; writer page365_apply_invoice_stage — docs "Void sync".
  - PAGE365 INVOICES ARE JPY. The account currency is the CSR's choice; PHP
    converts at system_settings.php_jpy_rate, carried on the draft. NEVER use
    currency-converter.ts getConversionRate() server-side or for a stored figure.
  - ANY SERVICE LINE (resize, certificate…) is a SERVICE, never a product line,
    never in loyalty_jpy_amount (_shared/page365-service-lines.ts).
  - DISCOUNTS: price_total is already net (subtotal + shipping −
    price_discount − campaign_discount), reconciled to the yen; a negative is
    refused. A promo code is never written to the order.
  - LOYALTY BASIS = PRODUCT LINES − DISCOUNT, in yen; services and shipping
    never in it.
  - Full text of the sub-rules below (moved 2026-10-02): docs/PAGE365-IMPORT.md
    "Rules moved from CLAUDE.md". One line each here; read the doc before touching
    stock, inventory, landing, schedule or hide-follow code.
  - INVENTORY FETCH: TARGET = max(0, Page365 available − page365_web_holds −
    page365_invoice_holds); match per VARIANT on the code, exact; a code on 2+
    listings → only the one whose 4 words after the code match the Hub name
    (>= 3, no tie), else flagged + one bell (docs "DUPLICATE CODE");
    COMPARE-AND-SET apply on 'ready' only; prices reported; reviews never stored.
  - SCHEDULE: pg_cron page365-inventory-schedule (Vault key, every 5 min);
    page365_inventory_auto_apply (default OFF; changed ONLY by
    set_page365_inventory_auto_apply; never flip it in a migration) applies
    decreases AND increases from a 'ready' scheduled run inside its 30-min window;
    prices and re-publishing NEVER apply automatically; one reader at a time.

## Media cut-outs & hero picks: read docs/MEDIA-CUTOUTS.md before touching website_media_cutouts, cut-out providers, Website → Photos or hero picks.

## Web payment reminders (incl. layaway emails ENGLISH ONLY): read docs/REMINDERS.md before touching web payment reminders or any layaway email template.

## Cart reminders (stages A/B): read docs/REMINDERS.md before touching cart reminders, consent or the opt-out link; the money rules stay here:
  - ONE LANGUAGE PER EMAIL; THE JAPANESE EMAIL NEVER MENTIONS LAYAWAY, a deposit
    or a reserve figure (JA_FORBIDDEN; CI test).
  - EVERY MONEY FIGURE IS THE HUB'S, recomputed at send time; no percentage, rate
    or conversion in the template or sender.

## Customer addresses (never delete-all; orders keep their own snapshot): read docs/SCHEMA-FACTS.md before touching customer_addresses, ship_to_snapshot or upsert_customer_addresses.

## Sidebar architecture: read docs/UI-CONVENTIONS.md before touching AppSidebar, ?tab navigation or the ActivePill.

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
    exception: a 'paidy' submission (proof = Paidy's read-back; docs/PAIDY.md PD1).
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

## PAIDY あと払い & SQUARE CARDS — NON-NEGOTIABLE (2026-10-03/04)

  Full text: docs/PAIDY.md, docs/SQUARE.md, docs/CHECKOUT-CHOICE.md, docs/COD.md (moved 2026-10-18).
  - Paidy ONLY on a confirmed YEN cash order, JP delivery address, money due, nothing paid (_shared/paidy-rules.ts).
  - PAIDY_SECRET_KEY and Square tokens: edge secrets ONLY, never DB/repo/chat.
  - paidy_mode / square_mode (off|test|on, fail-closed) + public keys: ONLY via set_paidy_settings / set_square_settings (admin, audited).
  - Trust NOTHING about a Paidy payment not read back from Paidy; the Hub NEVER captures.
  - PAIDY INTEGRITY: file only via file_paidy_submission_atomic; record only via finalize_cash_submission_atomic.
  - CHECKOUT CHOICE: the method is LOCKED at checkout; staff change it ONLY via change_web_payment_method_atomic; checkout points are a loyalty discount, not money.
  - PAIDY LOCK: while cash_order_payment_lock says paidy_*, NO other payment on that order; Paidy rows immutable.
  - SQUARE: yen cash orders, never layaway; authorise on pay, CAPTURE only on Confirm, VOID on Reject.
  - SQUARE INTEGRITY: reserve_square_attempt BEFORE Square; card_payment_unresolved blocks other payment/expiry/cancel.
  - COD 代金引換: yen, JP, cod_mode via set_cod_settings only; ONE fee rule cod_fee_jpy, never loyalty/points; staff record it IN FULL ONLY; Paidy and COD only for customers living in Japan.

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
     ONE exception: confirm-web-draft awards when checkout points paid the
     WHOLE deposit / order (docs/CHECKOUT-CHOICE.md).
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
    successful order_date), read-only (never written back); orders with a
    known loyalty amount < ¥10,000 do NOT count (2026-10-19). NEVER use
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

## Loyalty Google Sheet sync: read docs/LOYALTY-SHEET-SYNC.md before touching sync-loyalty-to-sheet, loyalty-sheet-reconcile or sheet event_type values.

## FILL-PAYMENT-TRACKING DUAL OUTPUT (added 2026-06-06)

fill-payment-tracking also generates the monthly tax-declaration file;
append-payment-tracking is a per-invoice REWRITE across
system_settings.payment_tracking_sheets and must be awaited. History:
docs/SCHEMA-FACTS.md "Rules moved from CLAUDE.md".

2026-09-11 (follow-up): every payment-mutation edge function (review-payment-submission, void-payment, edit-payment-amount, restore-payment, void-cash-payment, restore-cash-payment) calls `refreshPaymentTracking(invoice, caller)` from `_shared/payment-tracking.ts` before returning. Any new function that inserts, voids, edits, or restores a payment MUST add the same call. Only exception: shopify-webhook (Shopify orders are not in tracking rosters).

## Email delivery monitoring: read docs/EMAIL-DELIVERY.md before touching any email sender, retry, email_send_log or renderEmail.

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

  Enforcement layers:
    1. UI — NewAccount.tsx reads plan_configurations on load,
       shows minimum subtitle on each plan pill button,
       shows red warning under Total Amount if below minimum,
       disables Create button when below minimum — commit 639c3f6
    2. DB trigger (see PLAN CONFIGURATIONS above).
    3. Both PHP and JPY enforced — hard block, no override


## LOYALTY new_order_discount -> DOWNPAYMENT (added 2026-05-26)

- A new_order_discount redemption on a LAYAWAY account is applied to the downpayment, NOT to installment schedule rows.

- process-loyalty-redemption approve handler (layaway branch): the synthetic payment is inserted with reference_number 'LOYALTY-{id}', payment_method 'loyalty_redemption', and remarks containing "downpayment" so DP detection (AccountDetail, fix-account-totals, restore-payment) classifies it as a downpayment payment. NO payment_allocations / schedule waterfall is created (downpayment payments do not allocate to schedule rows).

- Account totals still update (total_paid += amount, remaining -= amount) independent of allocations.

- Void path unchanged: matches reference_number 'LOYALTY-%'; its allocation-reversal loop is a no-op with no allocations; totals revert off amount_paid.

- Cash (cash_order_id) branch is unchanged.

## Frontend / design workflow (typecheck is `npx tsc -p tsconfig.app.json --noEmit`; KPI + chart animation standards): read docs/UI-CONVENTIONS.md before touching any frontend code.

## Migrations baseline & function changes: read docs/DEPLOY-AND-MIGRATIONS.md before touching supabase/migrations/, any function body, RLS policy, view or SECURITY DEFINER grant.

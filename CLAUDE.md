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
- docs/WEBSITE-WORKSPACE.md — the /website workspace: the four tabs, the manage_website_catalog / manage_website_content split, the query-preserving redirect from /website-catalog, and where each website table's editor lives

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
    THE THIRD OCCURRENCE IS ALSO THE MODEL ANSWER: Lovable refused to fake it —
    "I could not run either of these two, and I'm not going to report a pass on
    other evidence" — then reported what it COULD observe (both endpoints reach
    their auth gate and return 401, not 404; both plans' lines carry a variant
    with photos and a null stored image, the exact case the resolver fills at
    read time) and handed the 200-with-photo confirmation to the acceptance run.
    That is the behaviour the rule wants. The defect was in the ASK, not the
    answer.

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

  TWO checks, different purposes. Both must pass; running only the first
  is what let the retired gold survive in the email templates until
  2026-09-09 (see below).

  1. RETIRED GOLD — repo-wide, CASE-INSENSITIVE, target 0 hits:
       grep -rniE "#D4AF37|#E7D7A2|#E8C84A" src supabase/functions --include="*.tsx" --include="*.ts"
     The -i is not optional: 29 of the 79 occurrences found on 2026-09-09
     were lowercase `#d4af37` and invisible to a case-sensitive grep.

  2. TOKEN DISCIPLINE — src only, target 0 hits:
       grep -rnE "#D4AF37|#E7D7A2|#C9A227|#E5C860|#E8C84A" src --include="*.tsx" --include="*.ts" | grep -v "src/theme/"
     Scoped to src BY DESIGN. Do NOT widen this one to supabase/functions:
     the transactional email templates must inline literal hex (mail
     clients do not resolve CSS custom properties), so they legitimately
     carry ~79 canonical #C9A227 literals and would fail it forever.
     Check 1 is what governs them.

  Target: 0 hits on both. The gold-literal migration COMPLETED 2026-07-06 (Phase 5)
  — all former debt rows (Finance/Commissions/Timesheet/Inquiries charts,
  ForgotPassword, Login, PortalLogin, AuthContext splash, AdminSplashScreen,
  TierCelebrationModal confetti) now import from src/theme/tokens. The
  avatar gradients (AppSidebar/AppLayout) use the gold-gradient class.
  Never reintroduce a gold hex outside src/theme/ and src/index.css.

  Remaining tracked debt (each row re-justified 2026-07-06, Phase 5):
    - .github/workflows/.github/workflows/firebase-hosting.yml — INERT
      nested duplicate workflow (survives — lives outside src/, needs its
      own cleanup commit; GitHub never executes nested paths). NOTE: the
      REAL deploy workflow .github/workflows/firebase-deploy.yml is LIVE.
      As of 2026-09-11 it deploys to PRODUCTION hosting only on a push to
      main; pushes to develop go to the `develop` preview channel and each
      PR gets a `pr-<number>` channel with the URL posted on the PR. The
      Typecheck and Deno gates run on all three. docs/AUTO-DEPLOY.md
      describes a different, removed workflow (Supabase edge functions)
      and does not apply.
    - PACKAGE-LOCK PRIVATE-REGISTRY QUIRK (RESOLVED 2026-09-09): from
      fbc9338 (MCP integration) until 2026-09-09, package-lock.json pinned
      ~94 tarball URLs to Lovable's private registry
      (europe-west1-npm.pkg.dev/lovable-core-prod/sandbox-npm-cache), so
      `npm ci` and fresh installs OUTSIDE Lovable/CI failed with 403 on the
      newer entries. The Claude Code web sandbox made this worse than
      documented: its egress proxy REJECTS europe-west1-npm.pkg.dev
      outright (connect_rejected, organization policy), so `npm install`
      there hangs rather than failing fast, and killing it mid-run leaves
      node_modules unusable. The lockfile was regenerated against
      registry.npmjs.org as the sanctioned main-side fix. Keep it that way:
      if private-registry URLs reappear, regenerate on main again — never
      from a feature branch.

    - TRANSACTIONAL EMAIL TEMPLATES (RESOLVED 2026-09-09): all 29
      templates under supabase/functions/_shared/transactional-email-
      templates/ carried the RETIRED #D4AF37 — 79 occurrences (50
      uppercase, 29 lowercase in every footerBrand). They survived the
      2026-07-06 Phase 5 migration because the only documented check was
      scoped to `src`, and these live under supabase/. Swapped to
      #C9A227 and the check widened (above). These files intentionally
      use literal hex — emails cannot read CSS variables — so the rule
      for them is "canonical literal only", never "no literal".
      NOTE (unfixed, separate decision): the shared `button` style sets
      color #ffffff on the gold fill. White on #C9A227 measures ~2.4:1,
      short of AA — slightly better than the ~2.1:1 it was on #D4AF37,
      but still failing. extension-requested.tsx already uses dark
      #1a1a2e text on gold and is the accessible pattern. Left as-is
      because it is a visual change, not a token swap.

    - SHEETJS (`xlsx`) PINNED AT 0.18.5 (accepted 2026-09-09): 0.18.5 is
      the last release SheetJS published to npm. It carries a
      prototype-pollution advisory (GHSA-4r6h-8v6p-xvw6) and a ReDoS
      (GHSA-5pgg-2g8v-p4x9); both are fixed only in >=0.19.3 / >=0.20.2,
      which ship from cdn.sheetjs.com and not from npm. Accepted because
      the only parser is the Website Catalog spreadsheet importer — an
      admin-only, browser-side parse of a file that admin chose. Do NOT
      feed customer- or portal-supplied files through it. REVISIT TRIGGER:
      if SheetJS resumes publishing to npm, or if any parsing moves
      server-side or accepts a file from outside the Hub, upgrade or
      replace the library.

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

- Installment 1 due date = order month + 1 month, never the order month itself. Same day-of-month as order_date; if that day does not exist in the target month, fall back to the last day of that month. Enforced in FOUR places that must always agree: create-layaway-account (index.ts, `getMonth() + i + 1`), restructure-account (index.ts, `getMonth() + i + 1`), the frontend preview generateScheduleDates() in src/lib/calculations.ts, and the `layaway_quote` SQL function (`p_order_date + make_interval(months => n)`), which is what the storefront quotes a customer before the account exists. Any change to one must be mirrored in the other three — a storefront quote that disagrees with the account the Hub then creates is a promise broken at creation time.
- Downpayment is NEVER marked paid at creation
- `dp_paid` always starts at 0; `total_paid = 0` on new accounts
- DP is only marked paid after payment submission is validated by staff
- Never bypass the payment validation flow
- The "Downpayment Paid" input field does NOT exist on the creation form
- DP excess over downpayment_amount waterfalls into installments (Month 1 onward) — see INVARIANT 11 (Bug #250, 2026-07-06). The required DP portion still never allocates.
- Loyalty Product Amount (JPY) is REQUIRED when the selected customer has a loyalty tier (any tier), on BOTH layaway and cash-order creation. Enforced on two layers: frontend UX (NewAccount.tsx / NewCashOrder.tsx) and the authoritative edge function (create-layaway-account / create-cash-order return 400 LOYALTY_AMOUNT_REQUIRED). Optional for non-members. After creation it is editable in Manage Invoice (layaway EditAccountDialog and cash CashOrderDetail) with permission edit_loyalty_amount (admin + per-user override), and only until the order earns points: trg_guard_loyalty_jpy_amount refuses a signed-in user's change without the permission or once an 'earned' loyalty_transactions row exists for the order (service-role callers — redemption net-spend RPCs, shopify-webhook, derive_order_loyalty_jpy — are not gated). A Manage Invoice total change does NOT update it automatically; the field shows a "Use ¥Y" nudge (total − shipping, PHP ÷ rate) instead. Correcting an order that already earned points is a separate path (#19751 is the known case).

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
    3. Check 17 — `reconciliation_staleness` in system-health-check — fails when
       system_settings.last_daily_reconciliation is older than 25 hours, and
       pushes an issue so `overall` reads ISSUES_FOUND. It is registered in
       OPS_META so the Hub panel actually renders it.
    4. Check 17b — `loyalty_sweep_staleness` — the same test for
       last_loyalty_award_sweep. Its stamp carries `remaining`, so a run that
       stopped on its time budget reads as progress, not as an outage.

    CHECKS 15 AND 16 ARE NOT BUILT. They were documented here as though they
    were, for months. Check 17 was documented the same way and was not built
    either, which is exactly why daily-reconciliation could stop completing on
    2026-05-20 and sit at a 2026-05-19 stamp for four months with nothing
    anywhere reporting it. 17 and 17b now exist; 15 and 16 are filed in
    docs/PENDING.md. Do not describe a check here before it exists — this
    section is read as an inventory, and an inventory that lists checks nobody
    built is worse than a short one.

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
    "A SQL EDITOR CHANGE THAT IS NEVER COMMITTED…" under Migrations baseline.

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
- Accumulated total: read-only view `product_inquiries_with_accumulated` adds
  `accumulated_inquiry_count` = RUNNING SUM(inquiry_count), partitioned by
  `lower(coalesce(nullif(btrim(item_code),''), nullif(btrim(product_name),'')))`,
  ordered `last_inquired_date ASC NULLS FIRST, created_at ASC, id ASC`, frame
  `ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`. Each row shows the item's
  total AS OF that inquiry; the item's grand total is the value on its MOST
  RECENT row. Explicit ROWS (not default RANGE) so tied dates still increment
  one at a time. Inquiry List reads the VIEW; Demand Map reads the BASE TABLE.
- The view contains a window function and is therefore not auto-updatable — staff
  cannot write the column via PostgREST (SQLSTATE 55000, verified 2026-08-06).
  This is the protection; no guard trigger and no hidden input are involved.
  Never add an INSTEAD OF UPDATE trigger to this view.
- INVARIANT: never SUM or AVG `accumulated_inquiry_count`. It is a running
  cumulative figure, so aggregating it across rows is always meaningless. To get
  an item's grand total, read the value on its most recent row, or aggregate
  `inquiry_count` from the BASE TABLE (which is what the Demand Map does).
- Changed from grand-total to running-total on 2026-08-06 per owner request:
  staff need to see demand accumulating per logged inquiry, not the same figure
  repeated. Verified EM378 runs 1..16 and PND8 runs to 30 across 17 rows.
- Per-row `inquiry_count` remains staff-editable and is the only input to the
  accumulation (860 rows / 937 total counts as of 2026-08-06).
- loadList casts the relation name (`as any`) until types.ts regenerates to
  include the view; remove the cast when it lands under Views.
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
    loyalty-award-sweep:           00:35 UTC = 08:35 PHT ✅  — recovers missed loyalty awards; split out of daily-reconciliation 2026-09-16 (see below)
    auto-expire-cash-orders:       40 * * * * (hourly at :40) ✅  — the ONLY web/cash order expiry path since 2026-09-13; the SQL cron expire_transfer_orders() is gone
    web-reservation-sweep:         23 * * * * (hourly at :23) ⏳ scheduled by migration 20260924100000 — reserve-first: 72h unconfirmed reservations auto-cancelled + one sales@ reminder at 24h (docs/RESERVE-FIRST.md)
    daily-fx-rate:                 00:45 UTC = 08:45 PHT ✅
    portal-token-check:            00:55 UTC = 08:55 PHT ✅  — portal links approaching expiry; Vault-backed, independent of the chain
    deactivate-expired-promotions: every hour            ✅
    loyalty-notification-queue:    every hour            ✅
    fc-alert-evaluation:           every 30 minutes      ✅
    process-email-queue:           NO CRON — see below      ⚠️
    cleanup-loyalty-images:        Sun 03:00 UTC = Sun 11:00 PHT ✅

  process-email-queue HAS NO CRON (verified against cron.job 2026-09-14 — the
  former "every 5 seconds" entry is gone and this line was stale). It is kicked
  over HTTP by send-transactional-email after that function enqueues onto pgmq
  `transactional_emails`. Consequence when diagnosing: silence from this
  pipeline means nothing is calling it, NOT that it is healthy. Its last
  activity of any kind was 2026-09-09 14:08 (164 consecutive refusals — see
  docs/FIXED-BUGS.md Bug #270).

  ORDERING RULE — never violate this sequence:
    1. Reminders fire first (before penalties)
    2. Penalty engine runs after reminders
    3. Auto-forfeit runs after penalty engine
    4. Reconciliation runs after forfeitures
    5. Loyalty inactivity check runs last
       (needs fully reconciled account data)
    6. The loyalty award sweep (00:35) runs after that, and is DELIBERATELY
       ITS OWN JOB rather than a tail block of daily-reconciliation. It used to
       be the last block of that function, after a loop over every active
       account — a loop which cannot finish in one run at current volume. The
       loop's own predicate (status IN active / overdue / extension_active /
       final_settlement, no test filter) selects 535 accounts at ~1.56s each
       against a hard ~185s ceiling; before the 2026-09-17 time-box it simply
       died after ~120, and everything sequenced after it was unreachable
       rather than merely skipped — the sweep produced ONE staff notification
       in ninety days. It is now time-boxed and resumes from a
       reconciliation_log cursor, so the 535 drain over about SIX runs
       (measured 2026-09-17: evaluated 91, remaining 444, budget_exhausted
       true). Do NOT confuse 535 with the 493 the account audit reports: that
       is the same status set filtered to total_paid > 0, because
       audit_account only means anything once money has landed. 535 is the
       sweep's population and the number `remaining` counts down from. A job
       whose independence matters must not be a continuation of another job's
       request. Never move it back inline.
    6. daily-reconciliation must never be scheduled
       before 00:15 UTC

  daily-fx-rate is INDEPENDENT of that chain — it writes only
  fx_rates and touches no account data. It sits at 00:45 UTC so it
  never competes with the pipeline. fx_rates.jpy_php = PHP per 1 JPY
  (same direction as system_settings.php_jpy_rate); the `website`
  edge function derives price_php = round(price_jpy * jpy_php) at
  read time and NEVER stores a peso price.

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
    `InvoiceGeneratorSheet.tsx` (`invoke`). Reads the Google Drive
    CSV mirror by invoice number — it does NOT call Page365. Left
    untouched by the 2026-09-19 import work; the two coexist.
    `page365-fetch-order` — requires valid user JWT + `user_roles`
    IN (`admin`, `staff`, `finance`, `csr`), `verify_jwt = true`.
    Link in, parsed draft out; never writes an order.
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

  ACCOUNT-SCOPED RUN (added 2026-09-20, owner decision). penalty-engine accepts
  an optional body { account_id: uuid } and then evaluates that ONE account.
  The narrowing is a single .eq("account_id", …) on the overdue-item query and
  NOTHING ELSE: same statuses, same Guard 1 / Guard 2, same freeze guard (an
  account with a pending submission is still skipped — INVARIANT 12), same
  caps and reactivation cap bump, same stage:cycle idempotency. A scoped run is
  therefore a strict subset of the nightly run and can never create a penalty
  the nightly run would not have created the same day — only sooner. No body,
  or no account_id, is byte-for-byte the previous behaviour. The response
  carries { scope: "account" | "all", account_id } plus a `created` array of
  the rows written.

  NO RULE CHANGED HERE — ONLY WHEN THE RULES ARE EVALUATED. The amounts, the
  caps, the grace reset and the trigger schedule are all untouched.

  reactivate-account CALLS IT for the reactivated account, after the account
  update, the Extension Month row and the extension_requests block have all
  succeeded (the engine reads status, is_reactivated and the un-cancelled
  schedule rows, so it must not run before those are written). The call is
  non-blocking: a failure is logged and reactivation still succeeds, because
  the engine is idempotent and the nightly run picks up anything missed.
  Why it exists: a forfeited account sits in a status the engine does not
  select, so reactivation is the moment it re-enters scope — and the next cron
  can be up to ~24h away. Invoice 18788 was reactivated at 04:16 UTC on
  2026-09-20 with installment 6 (due that day) carrying no penalty, because the
  account had been in `final_settlement` since 2026-09-03 and was invisible to
  every cron run in between, including the one four hours earlier.

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
  Still true as of 2026-09-20. reactivate-account calling penalty-engine
  (account-scoped) is a THIRD party invoking the engine, not these two
  becoming coupled — auto-forfeit-settlement neither calls nor is called.

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

  ("Section F" in R5 is the 2026-09-24 investigation report; its markers are
  the ones listed in the same rule, all checked by reassign_order_owner_atomic.)

  HOW "BORN EXPIRED" IS WRITTEN. Nothing in the Hub expires a lot by its
  date (expiry is the member-level 180-day inactivity sweep), and FIFO spends
  the SOONEST expiry first — so a live lot with a past expires_at would be the
  first thing a redemption consumed. insert_lot_catch_up therefore writes such
  a lot already expired (remaining 0, expired_at now()), and award-loyalty-
  points writes the earned row, a matching 'expired' row (−points) and
  total_points_expired += points, leaving remaining_points unchanged. Counter,
  live lots and ledger net stay equal (loyalty_integrity_report 1 and 2), and
  the spend still counts toward the tier.

  THE CATCH-UP IS A SEPARATE CALL, AFTER THE MOVE COMMITS. The edge function
  calls award-loyalty-points with the service key and body
  { account_id | cash_order_id, catch_up: { order_date } }; catch_up from any
  other caller is refused 403. Without catch_up award-loyalty-points behaves
  exactly as before. The award's own claim (loyalty_award_claims) keeps it
  idempotent. A skip for below_minimum or loyalty_disabled is an expected
  outcome, not a failure; anything else that is not awarded:true rings R9's
  bell.

  CHILD ROWS THAT MOVE WITH THE ORDER: payment_submissions (portal_token
  cleared — it was the old owner's link), extension_requests (portal_token
  cleared), service_jobs (invoice + account_type), service_requests, the
  order's checkout_quotes row, csr_notifications. A cash order's
  ship_to_address_id points into the OLD owner's address book, so it is
  snapshotted via address_snapshot() when the order has no snapshot yet, and
  then set to NULL. One audit_logs row (entity_type 'layaway_account' |
  'cash_order', action 'reassign_owner') carries both customers, the reason,
  the moved counts, the loyalty amount before/after, the award point and the
  catch-up decision.

  PERMISSIONS: role_permissions for reassign_owner already exist live (admin,
  staff = true; finance, csr = false; 4 user overrides = false). This work
  seeded nothing; the function obeys whatever Settings holds. The
  src/lib/role-permissions.ts default for reassign_owner (['admin']) is a
  fallback table only and was not changed.

## WEB LAYAWAY — NON-NEGOTIABLE (added 2026-09-14, Phase 2 step 4)

  A web layaway is a `layaway_accounts` row with `source_channel = 'web'` —
  the same table, the same schedule, the same payments, the same invariants as
  any Hub-created plan. There is no second account model. The web-only columns
  are `web_reference` (CJ-W-XXXXXX, what the customer and the emails say),
  `quote_id`, `customer_lang`, `fx_rate_used` / `fx_rate_date`, `expired_at`,
  and the two deadline fields below. Item lines live in
  `layaway_account_items`, the layaway sibling of `cash_order_items` — the
  same parallel-child-table pattern as `payments` / `cash_payments`.

  ONE WRITER: `create_web_layaway_atomic`. It consumes the checkout quote,
  recomputes the plan from `layaway_quote` rather than trusting the quote's
  stored figures, refuses `below_plan_minimum`, inserts the account, the
  schedule and the item lines, and decrements stock — one transaction. The
  `website` edge function never writes a layaway row itself.
  THE INVOICE NUMBER IS RESERVED AT QUOTE TIME (2026-09-18): a layaway
  `checkout_quotes` row draws `reserved_invoice_seq` from `web_order_number_seq`
  on insert (trigger `trg_checkout_quotes_reserve_invoice`), `POST /checkout/quote`
  returns it as `invoice_number` / `web_reference` so the agreement is signed
  against the plan's real number, and `create_web_layaway_atomic` carries that
  same number through to the account. Abandoned quotes leave sequence gaps by
  design.

  THE DEPOSIT DEADLINE IS A FIELD, NOT A COMPUTED RULE (owner decision
  2026-09-13). `transfer_due_at` is when the deposit must arrive. It is offered
  at creation (Hub and web alike) and moved afterwards through ONE control:
  `set_account_deadlines` behind the `set-account-deadlines` edge function,
  gated on `edit_account`, audited with old value, new value and reason. A
  REASON IS REQUIRED to change it (owner decision 2026-09-15): the edge
  function refuses an empty or absent one with 400 `reason_required` BEFORE
  calling the RPC, and the Hub keeps Save disabled until it is filled. Moving
  this deadline decides when a customer's piece is released, so an audit row
  with a null reason records that it happened and nothing about why. Creation
  is exempt — it sets a first deadline rather than changing one. On a
  cash order it writes `transfer_due_at` AND `expires_at` together, because
  the hourly cron reads `expires_at` and a customer must never be shown a
  deadline the cron does not act on. Web layaway default: 72 hours.
  There is no 24h/72h violation predicate, no forfeiture lookup and no
  automatic violator classification — those were replaced by this field.

  A DEADLINE IS MOVED, NEVER REMOVED (harness finding 3, 2026-09-15).
  `set_account_deadlines` and `set-account-deadlines` both refuse a null
  `transfer_due_at` with `deadline_required`. There is no "clear the deadline"
  act and none is to be built: the hourly sweep selects on `transfer_due_at IS
  NOT NULL`, so a cleared deadline is a web plan holding its stock forever with
  no expiry path and no error anywhere. A BACKDATED deadline stays legal — it is
  how staff release a hold deliberately — but the RPC returns
  `deadline_in_past: true` and the Hub warns, so a mistyped year is visible when
  it is made.

  WHAT HAPPENS AT A DEADLINE DEPENDS ON THE CHANNEL (harness finding 2,
  2026-09-15). auto-expire-cash-orders sweeps layaways with `source_channel =
  'web'` ONLY, yet Hub-created plans carry `transfer_due_at` too. On a Hub
  layaway the deadline is a staff reminder and nothing automatic happens; on a
  cash order the job cancels every pending order past `expires_at` but returns
  stock for web ones only. Any surface that states a consequence must state the
  one that applies to THAT order.
  THE DEADLINE IS SPENT ONCE THE DEPOSIT IS CONFIRMED (harness finding 1,
  2026-09-15). A layaway whose deposit has landed is still `active`, so a
  status-only gate let the date be moved: `ok`, a written column, and an audit
  row for a decision nothing would act on (the sweep never looks at a plan with
  `total_paid > 0` again). `set_account_deadlines` now refuses with
  `already_paid`, or `payment_exists` when the cache says zero and the ledger
  disagrees — the same two tests `expire_web_layaway_atomic` makes, in the same
  order, because INVARIANT 1 makes payments authoritative. The Hub withdraws the
  control and SAYS WHY rather than hiding it. LAYAWAY ONLY: a cash order's
  deadline is `expires_at` and the hourly job cancels a pending order with a
  balance whatever has been paid, so a partially-paid cash order's deadline is
  still live and still moveable.

  THERE IS ONE DEADLINE, NOT TWO (owner decision 2026-09-15). A second column,
  `settlement_due_at`, was added on 2026-09-14 and REMOVED on 2026-09-15: it
  was built to an answer nobody had asked the purpose of, nothing ever read it,
  and no account ever carried a value (0 of 1,449 at the drop). Do not
  re-add a settlement date to `layaway_accounts`, to `set_account_deadlines`,
  or to either creation form. The plan's own last schedule row is when the plan
  ends; `end_date` already records it. The related rule Cynthia described — an
  unpaid deposit NOT releasing the piece while a settlement date is still
  ahead — is NOT built; it is filed in docs/PENDING.md and needs a decision
  before any column comes back.

  EXTENSION IS A LATER DEADLINE, AND ONLY WHILE THE ORDER IS LIVE. Live means
  active / overdue / extension_active / reactivated for a layaway, pending for
  a cash order. An expired or cancelled order is NEVER revived: if the
  customer comes back the order is created fresh, so there is no stock
  re-hold path to get wrong. (The pre-existing cash-order revive button,
  Bug #217, survives for expired cash orders only and is the one exception,
  predating this rule. On a WEB cash order it is ONE RPC since 2026-09-23,
  #298: revive_web_cash_order_atomic via revive-web-cash-order, edit_account,
  reason required — re-takes the stock or refuses out_of_stock, resets
  payment_status to pending_transfer, and sets transfer_due_at = expires_at by
  web_deposit_deadline_hours. Never revive a web order with client-side writes.)

  A STAFF FORFEIT OF A WEB LAYAWAY RETURNS ITS STOCK (2026-09-23, #298).
  manual_forfeit_layaway_atomic flips the status, cancels the unpaid schedule,
  puts the pieces back on sale and stamps layaway_accounts.stock_released_at,
  in one transaction; the customer gets the storefront layaway-forfeited email.
  While stock_released_at is set the plan holds no stock, and
  trg_rehold_released_web_layaway_stock takes it back — or fails the status
  change with web_layaway_stock_unavailable — when the plan returns to a live
  status (the one-time reactivation). AUTOMATIC forfeits release too (#299,
  2026-09-23): trg_release_forfeited_web_layaway_stock returns a web plan's
  pieces in the same statement as ANY status change to forfeited /
  final_forfeited while stock_released_at is NULL, so auto-forfeit-settlement
  (LOCKED, untouched apart from its email) is covered, and the customer gets
  the same storefront layaway-forfeited email from both paths
  (_shared/layaway-forfeit-email.ts; `final` variant for final_forfeited).
  REACTIVATION IS ALL-OR-NOTHING: reactivate-account's un-cancel, account flip
  and Extension Month row are one transaction (reactivate_layaway_atomic); a
  sold piece refuses with out_of_stock naming it and nothing changes.

  EXPIRY: `expire_web_layaway_atomic`, swept hourly by
  auto-expire-cash-orders, releases a web layaway whose deposit never arrived
  — `source_channel='web'`, `total_paid = 0`, `expired_at IS NULL`,
  `transfer_due_at` past. It sets status `'cancelled'` and stamps
  `expired_at` (no new enum value), cancels pending schedule rows, returns the
  stock ONCE, writes an audit row, and emails the customer that nothing was
  paid and nothing is owed. It refuses on `already_paid`, `payment_exists`
  and `submission_pending` (INVARIANT 12). There is NO cancel-after-deposit:
  once a deposit is confirmed the plan is a normal layaway and follows the
  normal overdue / penalty / forfeiture path.

  THE WRITER'S REFUSAL RESTS ON `term_downgraded`, NOT ON `eligible` (harness
  observation C, 2026-09-15). `create_web_layaway_atomic` refuses on `NOT
  eligible OR term_downgraded`. While the 3M plan has no minimum, every basket
  clears some term, so `layaway_quote` always returns `eligible: true` and the
  first half never fires — a ¥500 basket asking for 12M comes back `eligible:
  true, term_months: 3, term_downgraded: true`. Never drop `term_downgraded` as
  redundant: without it every below-minimum basket silently writes itself a 3M
  plan. The `eligible` half is the backstop for the day 3M gets a minimum.

  TWO BASES, NEVER CONFLATED:
    deposit  = 30% of the TOTAL (product + shipping + services)
    loyalty  = the PRODUCT amount only, less any points redeemed
  `loyalty_jpy_amount` is therefore set from the quote's yen subtotal and is
  ALWAYS IN YEN, even on a peso plan — a peso total converted into the column
  would inflate the customer's tier progress. The settlement rate and its
  date are stored on the account for audit.

  CURRENCY is the customer's choice at checkout. Yen plans store yen. Peso
  plans convert at the stored `fx_rate`: shipping is converted and the
  subtotal is the remainder, so the parts always sum to the settlement total
  exactly. Web orders paid in full remain JPY-only.

  Web layaway accounts are NEVER hard-deleted (`trg_prevent_web_layaway_delete`),
  the same rule cash web orders already carry.

## PAGE365 IMPORT — NON-NEGOTIABLE (added 2026-09-19)

  A CSR pastes a public Page365 invoice link; the Hub fetches it, the CSR
  confirms, and the Hub creates a normal cash order or layaway plan. There is
  NO new write path — `create-cash-order` and `create-layaway-account` create
  the order exactly as they do for a hand-typed one, so plan minimums, the
  loyalty gate, permissions and the `is_test` prefix all still apply.

  `page365-fetch-order` NEVER WRITES AN ORDER. Link in, draft out, into
  `page365_drafts`. It refuses the whole import naming the field when anything
  is missing or the totals do not reconcile to the yen — a half-parsed draft is
  worse than none, because the CSR cannot see what is absent until the order is
  already wrong.

  THE `?sig=` IS A CAPABILITY, NOT AN IDENTIFIER. Anyone holding the full link
  can read that customer's name, phone and address. It is used for the single
  outbound fetch and dropped: never stored on the draft, never on the order,
  never logged, never returned. Only the slug and the invoice number survive.

  PAGE365 INVOICES ARE JPY (owner decision 2026-09-19) — item prices and
  shipping alike. The draft is yen throughout; the ACCOUNT currency is the
  CSR's choice at confirmation. A PHP plan converts at
  `system_settings.php_jpy_rate`, and the rate plus the moment it was read
  travel with the draft so the peso total can be reproduced later. NEVER use
  `src/lib/currency-converter.ts` `getConversionRate()` server-side or as the
  basis of a stored figure: it reads `localStorage` with a hardcoded 0.42
  fallback, so it is per-browser and not auditable.

  A RESIZE FEE IS A SERVICE, NOT A PRODUCT LINE. The parser flags it
  `kind: 'service'`. A service belongs in `account_services` (already inside
  `total_amount`) and must never reach `loyalty_jpy_amount`, which is the
  product amount alone — booking one as a product inflates the customer's tier
  progress with a fee paid for labour.

  ITEM NOTES ARE DISPLAYED, NEVER APPLIED. "Layaway (May) 8M / DP on 09/20 /
  Resize # 16" is free text a human wrote. The CSR reads it and sets the term;
  nothing parses it into fields. Page365 stock is not a stock source, and
  `origin` is never auto-set.

  PHOTOS ARE COPIED, NEVER HOTLINKED — `promotions/page365/<no>/<n>.<ext>`,
  into `{cash_order,layaway_account}_items.image_url`. An order outlives the
  external system it came from. A photo that cannot be copied is left null; a
  missing picture is cosmetic and is not worth refusing a sound import.

  A CONSUMED DRAFT IS A COURTESY, NOT THE GUARD. `consume_page365_draft` (a
  SECURITY DEFINER RPC — `page365_drafts` deliberately has no UPDATE policy)
  stamps `consumed_at` after a successful import, and the review screen treats
  a failure as non-fatal because the order already exists. What actually stops
  a double import is `uq_{cash_orders,layaway_accounts}_page365_no` plus the
  409 `already_imported` both create functions return.

  ONE HUB ORDER PER PAGE365 INVOICE, and one invoice_number across BOTH order
  tables — see `public.invoice_numbers` in docs/SCHEMA-FACTS.md. The registry
  triggers are named `trg_zz_*` so they fire AFTER `enforce_test_invoice_prefix`
  and record the final, possibly `TEST-` prefixed, value; never rename them to
  something that sorts earlier.

  DISCOUNTS: `price_total` IS ALREADY NET (added 2026-09-23). Page365 discounts
  the INVOICE, not the lines. `price_subtotal` and every item `subtotal` stay at
  full price, and `price_total` = subtotal + shipping − `price_discount` −
  `campaign_discount`. Both fields are read, both are subtracted, and the
  reconcile is that identity to the yen; a negative in either is refused by name.
  Summing the two is deliberate — if Page365 ever reported ONE discount in BOTH,
  the total stops reconciling and the import is refused, which beats silently
  halving a customer's total. Reading neither is what refused EVERY discounted
  invoice with a 422 until this landed.
  The draft carries `discount_jpy`, `discount_breakdown` and, for display only,
  `promotion_code` and `discount_campaign_name` — a promo code is never written
  to the order. The review screen PRE-FILLS the Discount field from
  `discount_jpy` and marks it "From Page365" until the CSR types over it.
  LOYALTY BASIS = PRODUCT LINES − DISCOUNT, in yen (owner rule 2026-09-23:
  "loyalty excludes the discount and the shipping fee"). The whole discount
  comes off the product amount; services and shipping were already outside it.
  Points must never be earned on money the customer did not spend. While the
  discount is still Page365's own the basis uses the draft's exact yen figure
  rather than converting the peso input back, so the basis cannot drift when the
  CSR toggles the currency.

  THE UI IS THE ONLY WAY IN, AND IT NEVER AUTO-DECIDES. Sales → the split
  button's "From Page365" opens a paste box; a successful fetch navigates to
  `/page365/review/:draftId`, where every parsed field is editable before
  anything is created. The customer is SUGGESTED, never auto-selected — matches
  are listed with the basis shown (name / phone / name + phone) because live
  phone data is only 80 clean E.164 of 891, with 10 colliding digit-groups.
  Item notes are displayed beside their line and never parsed. A RESIZE FEE
  arrives flagged `kind: 'service'` and the CSR can move any line between
  product and service; the loyalty basis sent to the creating function is the
  PRODUCT total in yen, LESS the discount (see DISCOUNTS below) — services and
  shipping are never in it.
  Currency is the CSR's choice at review: JPY default, and PHP converts the
  total, shipping and discount with the rate the DRAFT carries (`payload.fx`,
  `system_settings.php_jpy_rate`) — shown once on screen with its source and
  read time. Line items stay in yen whatever the account currency.
  THE ROUTE IS PERMISSIONED ON EITHER CREATE KEY. `/page365/` in
  PermissionsContext resolves to `create_cash_order OR create_account`, because
  the screen can produce either and gating on one would lock out a user who
  holds the other; the cash/layaway toggle then offers only the type they can
  actually create. An unmapped path there returns false for everyone but admin
  — the documented new-feature lockout.

  LINE ITEMS ARE WRITTEN INSIDE THE CREATING FUNCTION (`_shared/order-extras.ts`),
  not by the browser afterwards. The old post-RPC writes in NewAccount.tsx and
  NewCashOrder.tsx swallowed their own failure into a `toast.warning` on an
  order the CSR had just been told was created successfully. On an import
  nobody typed the lines, so nobody would know what was lost. A failure now
  rolls the order back. Every extra field is optional and a caller that sends
  none behaves exactly as before.

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

### Locked UI decisions (updated — Hub visual refresh, approved by Cynthia, PR #165)
- ONE active indicator: the sliding gold pill (`ActivePill` in AppSidebar.tsx) —
  gold-500 tint + 1px gold inset ring + 2px gold bar on the left, gold-300 text.
  It sits on exactly one row: the active leaf, OR the active sub-item when its
  parent is expanded, OR the parent itself when its sub-menu is closed or the
  sidebar is icon-only. It replaces both former styles (the parent "inside"
  left border and the separate sub-item accent) — do not reintroduce them.
- The pill GLIDES between rows. Every page mounts its own AppLayout, so the
  sidebar remounts on each navigation and framer-motion `layoutId` cannot
  animate across it; ActivePill records its last rect on unmount and the next
  pill FLIPs from there (reduced motion: it simply appears). Never swap this
  back to `layoutId` without first moving AppLayout to a shared layout route.
- The expanded group is seeded from the route on the FIRST render (useState
  initialiser), not only in the effect — a one-frame all-collapsed state let
  whichever row slid under a stationary cursor steal the hover accordion.
- Icon-only collapse (`collapsible="icon"`) is remembered per browser in
  localStorage key `cj-hub-sidebar-open` (every access try/catch-guarded).
  On the icon rail, badges become a dot and clicking a parent opens the
  sidebar with that group expanded. Phones keep the slide-out drawer.
- Section headers: Deco serif small caps + a trailing gold hairline.
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

### Changing the plan (the ONLY path)
  change-payment-plan (edge fn, permission 'change_payment_plan' — admin +
  per-user override) → public.change_payment_plan_atomic. Manage Invoice
  (EditAccountDialog) is its only caller. Rules, all enforced in SQL:
  active/overdue accounts only; new plan 3, 6 or 8 months (10/12 not launched);
  reason required. Pending payment submissions (submitted / under_review /
  needs_clarification) do NOT block — allocation runs at confirmation against
  the schedule as it is then, so they land on the new plan; the preview
  reports them as pending_submissions (owner rule 2026-09-17). FIXED rows
  (payment, partial/paid status,
  penalty_amount, penalty_fees, waiver request, allocation, carry-over either
  way) must be installments 1..k and are never touched. Rows k+1..N get
  (total − downpayment − fixed base) split floor + remainder-on-last, due
  order_date + n months (same rule as the other four places). Open rows are
  UPDATED IN PLACE (bypass app.bypass_immutable_schedule_cols), never
  deleted and re-inserted, because deleting a layaway_schedule row CASCADES to
  payment_allocations, penalty_fees, penalty_waiver_requests and
  csr_notifications. Rows above N are deleted only when shortening (the
  preview reports the CSR notifications that go with them). Writes
  payment_plan_months + end_date, one audit_logs 'change_payment_plan' row
  and schedule_audit_log rows per changed installment. apply=false = preview,
  no writes. restructure-account is NOT a plan-change path (orphan; see
  OPEN-BUGS).

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

2026-09-11: append-payment-tracking is now a per-invoice REWRITE (not additive). It locates the invoice across every sheet in system_settings.payment_tracking_sheets ([{id, cohort:"YYYY-MM"}], newest first) and rewrites G..(TOTAL-1) from get_tracking_for_invoices. Body: { invoice_number }. fill-payment-tracking prepends each generated sheet to that array; the scalar payment_tracking_sheet_id is kept for compatibility only. Callers must await the call (isolate shutdown killed unawaited appends).

2026-09-11 (follow-up): every payment-mutation edge function (review-payment-submission, void-payment, edit-payment-amount, restore-payment, void-cash-payment, restore-cash-payment) calls `refreshPaymentTracking(invoice, caller)` from `_shared/payment-tracking.ts` before returning. Any new function that inserts, voids, edits, or restores a payment MUST add the same call. Only exception: shopify-webhook (Shopify orders are not in tracking rosters).

## EMAIL DELIVERY MONITORING — NON-NEGOTIABLE (added 2026-09-13)

  Why: from 2026-09-04 02:03 UTC to 2026-09-13 every runtime send was refused
  by the Lovable email API (400 missing_unsubscribe) and nobody noticed for
  nine days — the direct send helper wrote nothing to email_send_log and the
  storefront helper logged only to the function log. 773 customer emails lost.

  EVERY email attempt is logged. `_shared/email-log.ts` recordEmailAttempt()
  is called by BOTH senders on every outcome (sent | failed | suppressed |
  skipped). 'skipped' is the storefront helper declining to send — no address,
  a test customer at an address the owner does not read, or no API key — and it
  MUST leave a row: without one, "the customer got no email" cannot be told
  apart from "the send was never reached", and the function log that would
  settle it retains only minutes. A row absent from email_send_log therefore
  means exactly one thing: the send was never reached. 'skipped' counts as
  neither accepted nor refused in email_delivery_report, so it never moves the
  verdict. The Hub helper has no silent skip — it throws instead.
    - _shared/transactional-email-templates/send-email.ts   channel 'hub'
    - _shared/storefront-email.ts                            channel 'storefront'
  process-email-queue already wrote email_send_log (channel NULL/'queue').
  A new sender that bypasses these helpers MUST call recordEmailAttempt()
  itself; otherwise the report's 'silent' verdict is the only thing that
  will catch it. email_send_log columns added: channel, request_id (the
  Lovable request_id from the refusal body, for support tickets).
  Sent rows never carry idempotency_key (partial unique index) — the key is
  kept in metadata instead.

  FIRST REFUSAL ALERTS AT ONCE: recordEmailAttempt() on a 'failed' outcome
  inserts staff_notifications type 'email_send_refused' at most once per 24h.

  DAILY VERDICT: RPC email_delivery_report(p_hours DEFAULT 24) compares the
  customer emails the Hub should have sent in the window (reminder_logs,
  payments, cash_payments, portal payment_submissions, rejections,
  penalty_fees, approved waivers, forfeitures, loyalty_transactions,
  pre-expiry warnings, web orders placed/closed; test customers excluded)
  against email_send_log accepted / refused. Verdict:
    refused  = attempts refused and NONE accepted
    silent   = events happened but no attempt logged (a sender bypasses the log)
    degraded = some refused, some accepted
    ok       = otherwise
  Cron 'email-health-check' at 00:50 UTC (after the morning chain, Vault
  pattern) → edge function email-health-check (service role or
  system_health permission) → upserts system_settings.email_health_status
  and inserts staff_notifications type 'email_delivery_outage' (once per
  20h) whenever the verdict is not ok.

  VISIBLE IN THE HUB (src/components/system/EmailHealthIndicator.tsx):
    sidebar footer pill (always), Dashboard banner (only when not ok),
    Settings → General → "Email delivery" card with "Run check now".
  All three read the same RPC via src/hooks/useEmailHealth.ts.

  The report is REPORT-ONLY. Nothing re-sends automatically; a replay job
  was explicitly declined by the owner (2026-09-13).

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

### A SQL EDITOR CHANGE THAT IS NEVER COMMITTED IS INVISIBLE TO EVERY LATER REBUILD — NON-NEGOTIABLE (added 2026-09-17, Bug #280)

**Before replacing any function body, diff it against LIVE — `pg_get_functiondef`
— never against the baseline.** "No later migration redefines this function" is
a statement about the repo. It is not evidence about what live runs, because
the SQL Editor is a sanctioned write path (TOOL OWNERSHIP RULES) whose changes
leave no trace in `supabase/migrations/`.

This cost a real customer's points ledger. `approve_redemption_atomic` was
wired to `consume_lots_fifo` in the SQL Editor on 2026-07-05 and never
committed; the baseline generated the same day does not contain it. On
2026-09-12 a migration rebuilt that function "verbatim from the live baseline …
no later migration redefines this function" — true, and wrong — silently
reverting live to a body with no lot consumption and leaving
`consume_lots_fifo` with zero callers. Every redemption after it debited the
counter and left the lots behind. The tell was available the whole time: the
same baseline is also missing `restore_lots_for_redemption` from
`void_redemption_atomic`, yet live void still calls it — because nothing ever
rebuilt void. See docs/FIXED-BUGS.md #280.

The check is one query, and it is cheap:

    SELECT md5(pg_get_functiondef(p.oid)), length(pg_get_functiondef(p.oid))
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = '<fn>';

Reconstruct the body you are about to ship with your own edits reversed, md5 it,
and require the two to match before you write the migration. Any difference is
live carrying something the repo has never seen — stop and find out what it is.
The corollary: **when a SQL Editor change alters a function body, commit it as a
migration in the same session**, even though the general rule is that SQL is not
committed unless asked. A function body is not data; it is code that the next
rebuild will overwrite.

The LIVE DB remains authoritative. The baseline reflects live state at the
moment of generation but is NOT a replacement for it — NEVER push the
baseline to the live project (`supabase db push`, `supabase migration up`, or
equivalent). Migration-history mismatch against live is expected and
irrelevant. Purpose: faithful fresh rebuilds (local dev, staging bootstrap)
and an in-repo source of truth. Any future schema change to the live DB must
be added as a NEW migration file in `supabase/migrations/` alongside the
baseline (do not edit the baseline in place).

Every migration version (the 14-digit prefix) must be unique. Before adding a
migration, run: `ls supabase/migrations | cut -c1-14 | sort | uniq -d` — it must
print nothing.

### FUNCTION CHANGES START FROM LIVE — NON-NEGOTIABLE (added 2026-09-17, Bug #280)

The repo is a RECORD of the database's functions. It is not the definition of
them. Three rules follow, and none of them is optional.

**1. Never rebuild a function body from the repo.** Not from the
`20260705230000` baseline, not from an earlier migration, not from a snapshot in
`docs/sql/`. Start from what live actually runs:

    SELECT pg_get_functiondef(p.oid)
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = '<fn>';

Where the change is small, prefer an **md5-guarded in-place patch** over a
`CREATE OR REPLACE` of the whole body: assert the live md5 first and abort if it
has moved, so a body that changed under you stops the patch instead of being
silently overwritten. Where a full replace is unavoidable, reconstruct the
intended body with your own edits reversed, md5 it, and require it to equal live
before writing the migration. Any difference means live carries something the
repo has never seen — stop and find out what.

**2. A SQL Editor change to a function body gets a record-only migration in the
same session.** This is the corollary above, restated because it is the step
that keeps getting skipped. A record-only migration is a plain
`CREATE OR REPLACE` of the body exactly as live has it, headed with the capture
timestamp, the md5 and the reason; replaying it is a no-op. Reference files:
`20260917070050_record_live_loyalty_fixes.sql`,
`20260917070100_record_live_only_functions.sql`,
`20260917070200_record_live_drifted_functions.sql`.

**3. Run the drift audit before writing any migration that redefines a
function.** `scripts/function-drift-audit` prints a read-only SQL query; paste it
into the SQL Editor. Zero rows means live and the repo agree about every
function. Its three buckets:

    a_differs     same name, different body  — the repo will revert live
    b_live_only   live has it, the repo does not — a rebuild loses it entirely
    c_repo_only   the repo has it, live does not — a dropped function still recorded

The comparator is `pg_proc.prosrc` with whitespace collapsed, NOT
`pg_get_functiondef`: the latter canonicalises headers and reports drift on
every hand-written migration. Comment-only differences are real rows and are
worth clearing anyway — a body that differs at all is a body nobody can diff at
a glance.

The full census on 2026-09-17 found **17 (a) + 15 (b) + 2 (c)**. All 32 live
bodies are now recorded and all three buckets are 0. Keep them there.


Known pre-existing quirk (NOT from this work): fc_cohort_timeline.collection_rate
can exceed 100% because actual_collected includes downpayment while
expected_collected excludes it. Drives a noisy quality-degradation alert.
Separate ticket if undesired.

## SYSTEM STATUS (as of 2026-05-16)

### Services Tracking — Hub-native feature live (2026-06-06)

  New standalone tracker for the workshop pipeline. Hub-only —
  **NO Google Sheet sync of any kind**.

  - **Table**: `service_jobs` (already created via SQL Editor)
    with `service_type` + `service_status` enums, RLS for
    admin + staff only, FK to `customers`.
  - **Route**: `/services` page (`src/pages/Services.tsx`) with
    horizontal filter bar (status, type, updated-by, date range,
    "Active Jobs" quick filter, "Clear filters") and a default
    sort of `date_received DESC, created_at DESC`. Numeric
    invoice filter (`^[0-9]+$`) applied client-side to exclude
    test accounts.
  - **Dialog**: `ServiceJobDialog.tsx` is the single
    add/edit dialog. Invoice resolves against both
    `layaway_accounts` and `cash_orders`; sets
    `account_type='layaway'|'cash_order'` + `customer_id`
    accordingly; blocks save on unresolved. Ring Resize size
    parser (`+N` / `-N`) auto-fills the fee table; Certificate
    / Polishing / Watch Polishing / Repair prefill defaults;
    Bracelet Resize / Color Change blank.
  - **Status side-effects**: on `On-going` set
    `estimated_completion = date_received + 7 working days`
    (skips Sat/Sun); on `Completed` set
    `date_completed = getPHTToday()`; reverts to NULL when
    status leaves `Completed`.
  - **Customer detail surfaces**: `ServiceJobsSection.tsx`
    rendered as a read-only section on both
    `src/pages/AccountDetail.tsx` and
    `src/pages/CashOrderDetail.tsx`, scoped by
    `invoice_number`.
  - **Realtime**: `service_jobs` added to `SYNC_TABLES` in
    `useRealtimeSync`; new `SERVICES_KEYS` group (`services`,
    `service-jobs`, `service-jobs-by-invoice`) folded into
    `REALTIME_INVALIDATE_KEYS` so the list and per-account
    surfaces auto-refresh on any insert/update.
  - **Sidebar**: leaf entry "Services" with the `Wrench` icon,
    placed between Customers and CSR Monitoring, gated by
    `permPath: '/services'`.
  - **Access control**: `view_services` + `manage_services`
    `role_permissions` rows (admin + staff). Page perm key
    `view_services` wired through `PAGE_PERMISSION_MAP` in
    `PermissionsContext`. Finance + CSR roles automatically
    hidden from both the route and the sidebar entry.

### Contract & Agreement feature removed (2026-06-06, commit `f43d938`)

  The Contract & Agreement signature capture feature was removed in
  full: `supabase/functions/submit-signature/` directory deleted,
  `src/components/contract/ContractAgreementSection.tsx` deleted,
  `AccountDetail.tsx` import and render block removed. Database:
  `layaway_signatures` table DROPped (3 rows, RLS policy, FK
  constraints all removed via CASCADE). The `agreement_version` and
  `agreement_acceptance` columns on `cash_orders` and
  `layaway_accounts` are retained — they are populated by separate
  live flows (`create-cash-order`) and are unrelated to the
  signature capture feature. The deployed `submit-signature` edge
  function is orphaned (source deleted, table gone — any call fails
  at DB level; no callers remain). Scanner warning dismissed —
  dead code, no live surface.

### `system-health-check` gated (2026-06-06, commit `a65a356`, deployed same day)

  Previously had no inbound auth gate. Now requires user JWT +
  `user_roles` `admin / staff / finance / csr` check,
  `verify_jwt = true` in `config.toml`. See FIXED-BUGS #173.

### Extension email recipient fix + full email audit (2026-06-06, SQL fix)

  `notify_extension_event` trigger corrected — `recipient_email` now
  reads `v_customer_email` from `customers` at execution time
  (Option A). Previous version had `'sales@chajewelsjp.com'`
  hardcoded; discovered via `pg_get_functiondef`. Verified via
  `email_send_log`: `recipient_email = chajewelsjapan@gmail.com` on
  next send after fix. Full `email_send_log` audit: all 9 active
  templates (`account-forfeited`, `cash-payment-confirmed`,
  `cash-payment-submitted`, `extension-granted`, `loyalty-earned`,
  `cash-payment-submitted`, `payment-submitted`, `payment-voided`,
  `penalty-applied` / `penalty-escalation`) route to dynamic
  customer emails. `send-transactional-email` has a `template.to`
  override mechanism (L141 `effectiveRecipient = template.to ||
  recipientEmail`) — no current template has a hardcoded `to`
  pointing to staff. See FIXED-BUGS #172.

### Staff bell — redemption lifecycle coverage (2026-06-06, commit `30081eb`, deployed 2026-06-06)

  `process-loyalty-redemption` now emits `staff_notifications` at all
  four redemption lifecycle points — `redemption_requested`,
  `redemption_approved`, `redemption_cancelled`, `redemption_voided` —
  non-blocking, each insert wrapped in its own try/catch with a
  `[process-loyalty-redemption]` `console.warn` on failure. Both
  layaway-linked and cash-order-linked redemptions are covered:
  `account_id` carries the layaway link when present, `cash_order_id`
  rides inside `metadata` per the existing "Cash order created"
  convention (the `staff_notifications` table has no `cash_order_id`
  column). `NotificationsPanel.tsx` + `StaffNotificationBell.tsx`
  icon maps gained `Gift` / `Award` / `XCircle` / `Ban` cases for the
  new types; the type-filter dropdown is dynamic and picks them up
  automatically. Live emission of the four new types is pending the
  first post-deploy redemption activity.

### Payment-submission bell sender names — verified correct across all paths (2026-06-06)

  After the Bug #171 fix + historical repair, every path that creates
  a `payment_submissions` row now writes `sender_name` at insert time,
  and the AFTER-INSERT trigger `notify_submission_created` snapshots
  the correct sender into `staff_notifications.body`:

  - **Staff/CSR — `record-payment`, `record-multi-payment`**: now set
    `sender_name = user_metadata.full_name → email` at insert (commit
    `2610741`, deployed 2026-06-06 09:17 UTC).
  - **Portal — `submit-payment`, `submit-cash-payment`**: unchanged;
    `submit-payment` has populated `sender_name` since `41fddad`
    (2026-03-22); `submit-cash-payment` requires it as a NOT-NULL.
  - **Defense layer — `notify_submission_created` trigger**: COALESCE
    fallback now reads `customers.full_name` (via `NEW.customer_id`)
    before defaulting to `'Unknown sender'`, hardening against any
    future name-late insert path.
  - **Historical repair**: 25 existing bell rows rebuilt from their
    submissions' `sender_name`; 1 row with NULL `sender_name` rebuilt
    from the customer's name. Verified 0 `'Unknown sender'` rows
    remain.

  See FIXED-BUGS Bug #171 for the full incident anatomy and the
  three-layer fix.

### Proof URL — Option A Phase 1 in-place (2026-06-06)

  Frontend renderers (`PaymentProofs.tsx` view + download, `AccountDetail.tsx`
  proof view handler) now mint short-lived signed URLs on demand via
  `getProofSignedUrl()` instead of rendering the stored public URL. The
  `payment-proofs` Storage bucket remains public so legacy stored URLs in
  `payment_submissions.proof_url` continue to resolve — no migration required,
  no break to existing rendered proofs. The signed-URL path is forward-compat
  with Phase 2 (bucket flipped private, store object-path only, mint via gated
  edge function). Phase 1 narrows the practical leak window: copying a rendered
  URL out of the admin Submissions queue or customer-portal history now yields
  a URL that expires, instead of an indefinite public link. See FIXED-BUGS Bug
  #167 (commit `7ccf41e`) for the related stale-session signOut scope amendment
  bundled in the same push.

### Loyalty-sheet-reconcile gated + fix-account-status Critical CLOSED (2026-06-06)

  Two unrelated edge-function security closures shipped this session:

  - **`loyalty-sheet-reconcile`** — inbound JWT-claims gate added
    (`parseJwtClaims(token)?.role === 'service_role'`) and
    `[functions.loyalty-sheet-reconcile] verify_jwt = true` recorded in
    `supabase/config.toml`. Now matches the locked **EDGE FUNCTION
    SERVICE-ROLE AUTH PATTERN** rule (Bug #168 hardening pass). Commit
    `7ccf41e`.
  - **`fix-account-status`** — Critical-severity dual bypass closed
    (no-header request + public anon-key bypass). Strict user-JWT +
    `system_health` permission gate, `verify_jwt = true`. Commit
    `28bc07e`, deployed 2026-06-06 09:15 UTC. See FIXED-BUGS Bug #170
    for the full bypass anatomy and verification trace.

  Both functions are now indistinguishable from the Vault-backed cron
  pattern at the gateway layer (signature validation upstream, claims
  check inside) — no manual env-equality, no public-key special-case
  remains in the audited surface.

### Edge function auth gate pattern (2026-06-06)

  All cron-targeted functions now use JWT claims decode
  (`parseJwtClaims`) instead of env-string equality. Shared helper
  at `supabase/functions/_shared/jwt-claims.ts`. `verify_jwt = true`
  in `config.toml` for 10 functions total. Vault-backed cron paths
  certified empirically. See FIXED-BUGS Bug #168.

### Extension request email (2026-06-06)

  Server-side path via `notify_extension_event()` trigger; routes
  to customer email address (Option A) when customer has email;
  auth-aware portal link (`auth_user_id` → bare portal, else
  active token URL); skipped silently when email null; staff
  coverage = bell only. Replaces dead frontend fetch (anon key
  rejected by gate). Trigger verified: `email_send_log` id
  2026-06-06 05:43.

### Security scan 2026-06-06 triage

  Latest Lovable security scan + manual triage. Four findings
  reviewed; each parked with an explicit disposition rather than a
  same-day code change.

  - **payment-proofs bucket is PUBLIC — confirmed.** The
    `payment-proofs` Supabase Storage bucket is configured public,
    and all five upload sites — RecordCashPaymentDialog,
    RecordPaymentDialog, MultiInvoicePaymentDialog (staff side),
    CashPortalPaymentDialog and CustomerPortal main + edit flows
    (portal side) — store the full public URL into
    `payment_submissions.proof_url`. Anyone with a proof URL can
    fetch the image without auth — and submission rows are
    selectable by RLS to the owning customer + staff, so the URL
    is reachable from those sessions. Disposition: **not a toggle**.
    Flipping the bucket to private without a coordinated migration
    would break every existing rendered proof in the admin
    Submissions queue + customer portal history. Proper fix is a
    coordinated pass: convert the bucket to private, store only
    the object path in `proof_url` (already partially the case for
    legacy rows), add a signed-URL minting edge function gated on
    the same RLS predicates that already protect
    `payment_submissions` reads, and update every renderer to mint
    a short-lived URL on demand. Parked until that pass is
    scheduled — the URL set is currently treated as
    capability-protected (you need the URL to retrieve), which is
    inadequate against URL leaks but matches the existing live
    state.

  - **Realtime postgres_changes publication on public tables —
    acceptable, parked.** The `supabase_realtime` publication is
    populated with the eight mutating tables that
    `useRealtimeSync` listens to (per CLAUDE.md REALTIME SYNC).
    All eight tables enforce RLS, so the realtime stream a client
    receives is already filtered to rows that client could
    SELECT. The audit flag was the absence of "private channel"
    enforcement (i.e. nothing stops an authenticated customer
    from subscribing to the same channel staff use). RLS makes
    that subscription useless — they see only their own rows —
    so the practical exposure is zero. Disposition: enforcement
    of explicit private channels stays parked.

  - **brand-assets bucket public read + no write policies —
    intentional.** Public read is required for the Help Center
    image renderer (`Help.tsx` `img` override resolves filenames
    via the bucket's public URL — see CLAUDE.md HELP CENTER
    SCREENSHOTS rule). Absence of write policies is also
    intentional: uploads come through the Supabase Storage UI by
    operators, never from frontend code, so no client-facing
    INSERT/UPDATE policy is needed. Disposition: **no change**.

  - **Customer signature access — open business decision.** The
    scan flagged customer signature artifacts (the agreement
    acceptance signatures recorded on cash orders and layaway
    accounts) as broadly readable. Disposition is a product /
    legal question, not a security-implementation one: do
    signatures need to be staff-only, or do customers see their
    own at the portal? Parked pending owner decision.

### Tier re-qualification verified live (2026-06-06)

  Test Customer restore scenario passed end-to-end. Member was at
  Glimmer with `is_downgraded=true`, `earned_tier_id=Elite`, and
  `downgrade_spend_baseline` snapshotted at downgrade time. Test
  award delivered `value_applied_jpy = 2,010,000` of new spend since
  downgrade — `(newCumulative − downgrade_spend_baseline) ≥
  requalify_spend_jpy (2,000,000)` — so the gate inside
  `award-loyalty-points` Step 5b flipped `requalified = true`, the
  member update restored to Elite (`earned_tier_id = current_tier_id
  = Elite`, `is_downgraded = false`, `downgrade_spend_baseline =
  null`), and the completing purchase earned at the ratcheted Elite
  multiplier (+200 pts on this award, not the pre-restore Glimmer
  rate). Tier-change emission witnessed on all three surfaces:
  PaymentSubmissions reviewer toast tail, staff_notifications bell
  row, and `account_notes` trail. Closes verification for the
  2026-06-05 tier-requalification feature work.

### Extension requests restored for token customers (2026-06-06)

  An earlier security pass had DELETED all anon RLS policies on
  `public.extension_requests`, silently killing the
  Request-Extension feature for every token-link customer (any
  customer reaching the portal via `?token=` without a Phase B
  session). RLS was on with no anon row visibility → submitting
  inserted nothing, and the duplicate-pending check returned `[]`
  for every caller. **Third instance** of a security pass removing
  a live customer path in 30 days (after `2370082` payment-proofs
  upload, and the Batch 4 `payment-proofs` re-drop). Recorded as
  Bug #165 in `docs/FIXED-BUGS.md`.

  Two anon RLS policies re-created via SQL Editor mirroring the
  `payment_submissions` anon pattern from migration
  `20260605072749`:
  - **INSERT**: bound to a real, active, non-expired
    `customer_portal_tokens` row whose `customer_id` matches the
    row being inserted (token portion ≥ 16 chars, fail-closed).
  - **SELECT**: gated on the `x-portal-token` request header
    matching the row's `portal_token` AND the same active-token
    join. Customer can only see their own extension requests.

  Companion frontend bug — the duplicate-pending GET fetch at
  CustomerPortal L1458-1465 was sending the bare anon apikey and no
  portal auth header, so even with policies in place the check
  would have returned `[]`. Fixed in commit `90949f7` (effect now
  awaits `getPortalAuthHeaders(portalToken)` and spreads the
  result alongside `apikey`).

### Proof of payment required on customer-portal submissions (shipped 2026-06-06, commit `92e324b`)

  Trigger: a proofless layaway submission on 2026-06-05 13:56 UTC
  slipped through because the portal upload block was
  failure-tolerant (a fetch error left `proofUrl` null and the
  submission posted anyway). Staff caught it during review and
  rejected.

  Fix layers:
  - **UI gates** in `src/pages/CustomerPortal.tsx` main + edit
    flows and `src/components/portal/CashPortalPaymentDialog.tsx`:
    the submit button is disabled until a file is attached, the
    main flow shows "Please upload your proof of payment
    (screenshot or receipt)." and the cash dialog shows "Please
    attach your proof of payment (screenshot or receipt)." when
    blocked, and any upload failure (non-2xx response OR thrown
    error) now sets a fatal "Proof upload failed — please try
    again." message, resets the submitting state, and aborts.
    `proofUrl` is guaranteed non-empty before the body is posted.
  - **Server 400** in `supabase/functions/submit-payment/index.ts`
    and `submit-cash-payment/index.ts`: reject with
    `{ error: "Proof of payment is required" }` when `proof_url` is
    missing, not a string, or empty/whitespace.

  Staff `record-payment` and its insert-then-attach-proof flow are
  **unchanged** — staff continue to submit without a proof URL and
  upload afterward. Rule recorded in CLAUDE.md PAYMENT SUBMISSION
  FLOW section under "PROOF REQUIRED — customer-portal submissions
  (added 2026-06-06)".

### Loyalty trail in account_notes (shipped 2026-06-06)

  Three writers live, all emit `account_notes` rows tagged
  `created_by_name = 'System (Loyalty)'` so the trail surfaces
  inside `AccountDetail` (layaway) and `CashOrderDetail` (cash)
  alongside payment + schedule history:

  - **Award** — `award-loyalty-points` writes the note immediately
    before its `awarded: true` return, after the member update has
    succeeded. `created_by_user_id: null`. Non-blocking try/catch.
  - **Approve** — written **inside** the
    `approve_redemption_atomic(uuid, uuid, text)` RPC at Step 7b
    (SQL Editor replace; no edge-side copy). Note lives in the
    same atomic transaction as the debit, so it's either fully
    present or fully absent.
  - **Void** — `process-loyalty-redemption` void handler writes
    the note after all void writes succeeded and immediately
    before the success response. Non-blocking try/catch.

  Code: commit `a3a8200` (edge functions) + SQL Editor RPC
  replace for the approve step. First automatic note verified live
  the same day on a cash order — full chain observed from
  approve → DB row → cash order detail render.

  Closes the long-standing "LOYALTY ACCOUNT NOTES TRAIL" item from
  `docs/PENDING.md` (originally flagged 2026-06-04). Rule wired
  into `docs/LOYALTY-LIFECYCLE.md` "Loyalty trail in account notes
  (added 2026-06-06)".

### RPC + view privilege lockdown (2026-06-05 evening, SQL Editor)

  Two-part lockdown applied via SQL Editor; no migration file
  (schema-only ACL changes, intentionally kept out of repo).

  **View privileges — `schedule_with_actuals`.** This view ran with
  owner rights AND held FULL table-privilege grants (SELECT/
  INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER) to **`anon`** —
  a public read window into every customer's payment schedule,
  bypassing all RLS. Anon revoked entirely; `authenticated`
  reduced to `SELECT` only.

  **SECURITY DEFINER function ACL batch.** 17 server-only RPCs
  stripped of `PUBLIC` / `anon` / `authenticated` EXECUTE — every
  caller must come through a service-role edge function or a
  trigger:

    delete_account_atomic, admin_renumber_installment,
    admin_update_schedule_base, delete_schedule_row_atomic,
    consume_lots_fifo, insert_lot_and_extend,
    restore_lots_for_redemption, restore_loyalty_points,
    revoke_loyalty_points, reconcile_failing_accounts,
    enqueue_email, delete_email, read_email_batch, move_to_dlq,
    get_bulk_setup_invite_candidates, _award_birthday_reward,
    get_unpaid_schedule

  16 frontend-called functions retained `authenticated` EXECUTE
  only (PUBLIC / anon stripped). `has_role` and `is_staff` and all
  trigger functions left untouched — they must remain callable
  inside RLS predicates by every role.

  **`ALTER DEFAULT PRIVILEGES`** on the `public` schema now revokes
  EXECUTE from PUBLIC on functions created by the
  database/migration owner — future functions are born locked.

  **Finding worth recording.** `delete_account_atomic` had NEVER
  actually been client-revoked despite the 2026-05-08 SYSTEM-STATUS
  entry that claimed it. Verified by inspecting `pg_proc.proacl`
  before the batch ran. Lesson: ACL changes applied via the SQL
  Editor must be re-verified against `pg_proc` / `information_schema`
  after the fact; a successful SQL execution does not guarantee
  the grant string the operator typed actually landed.

  **Smoke verification.** Dashboard summary, Finance Overview KPIs,
  per-account Check Health (`audit_account`), and System Audit
  (`audit_all_accounts`) all loaded clean on an admin JWT after
  the lockdown.

  **Residuals on the deliberate-change list (NOT done):**
  - `security_invoker = true` flip for `schedule_with_actuals` so
    the view enforces caller-side RLS instead of running with
    owner rights (the current lockdown is privilege-only — the
    view definition is unchanged).
  - Internal `has_role()` checks inside staff RPCs. The
    `authenticated` role currently includes Phase B session
    customers; a staff RPC granted to `authenticated` and gated
    only by RLS would let a customer JWT execute it. Today this
    is masked because the lockdown revoked EXECUTE from all such
    RPCs — but the audit pass still needs to walk every staff RPC
    and either add a `has_role` guard at function entry or move
    the function behind an edge-function gate.

### Security batch 4 — 7 findings fixed (2026-06-05)

  Lovable-driven security scan + manual review. All seven findings
  resolved on the same day. Two pre-deploy catches and one same-day
  regression caught and patched before any customer impact.

  **The 7 fixes:**
  1. **payment-proofs broad authenticated INSERT policy DROPPED.**
     The post-`2370082` "Authenticated users can upload payment
     proofs" policy gave any JWT holder bucket-wide INSERT on
     `payment-proofs` — too broad. Migration
     `20260605093651_707cb301-3735-45b3-a50d-9a9713d5e6ae.sql`
     dropped it.
  2. **dashboard-summary role-gated** (commit `27a3877`). After JWT
     verification via anon-client `getUser()`, allow only when
     `has_role` returns true for one of `admin / staff / finance /
     csr`. Phase B customer JWTs without a staff role row get 403.
  3. **system-health-v2 gated** (commit `27a3877`, then amended in
     commit `49681b4` — see "Pre-deploy catch 2" below).
  4. **daily-reconciliation service-role-only guard** (commit
     `27a3877`, `verify_jwt = false` in config.toml). Cron-only
     endpoint.
  5. **auto-expire-cash-orders service-role-only guard** (commit
     `27a3877`, `verify_jwt = false`). Cron-only endpoint.
  6. **loyalty-inactivity-check service-role-only guard** (commit
     `27a3877`, `verify_jwt = false`). Cron-only endpoint.
  7. **portal_token column-level SELECT REVOKED** from `authenticated`
     and `anon` on `public.extension_requests` and
     `public.payment_submissions` (same migration as #1).
     `service_role` retains full access for edge functions and admin
     queries; customer SELECT policies can no longer leak the raw
     portal token.

  **REGRESSION CAUGHT SAME DAY — and fixed:** Dropping the broad
  authenticated policy in fix #1 removed the ONLY INSERT path that
  Phase B JWT session-auth customers had on the `payment-proofs`
  bucket — re-opening the same gap that commit `65e86a2` had closed
  via the `x-portal-token` header (which is anon-only). Live for a
  short window after the migration. Replaced via SQL Editor with a
  scoped policy **"Session customers can upload own payment proofs"**:
  `authenticated` INSERT permitted on `bucket_id = 'payment-proofs'`
  ONLY when the JWT subject (`auth.uid()`) joins via `auth_user_id`
  to either a `layaway_accounts` row OR a `cash_orders` row whose id
  matches the first segment of the upload `name`. Three portal
  upload sites verified to use the `{id}/` path prefix the policy
  expects:
  - `src/pages/CustomerPortal.tsx` L2100 (layaway submit, `${primaryAccountForName.id}/…`)
  - `src/pages/CustomerPortal.tsx` L2622 (layaway edit, `${sub.account_id}/…`)
  - `src/components/portal/CashPortalPaymentDialog.tsx` L133 (cash submit, `${cashOrder.id}/…`)

  This restores three coexisting INSERT paths: staff `is_staff()`
  (authenticated), token customers via `x-portal-token`
  (anon), session customers via ownership join (authenticated). See
  `docs/SCHEMA-FACTS.md` "payment-proofs bucket INSERT paths" pinned
  note for the invariant.

  **PRE-DEPLOY CATCH 1:** Cron jobid 15 (daily-reconciliation,
  00:20 UTC) still used the embedded anon key for its outbound POST
  — would have 401'd at the next tick once fix #4's service-role
  guard went live. Migrated via SQL Editor `cron.alter_job(15, …)`
  to read the key at fire time from
  `(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name
  = 'email_queue_service_role_key')` BEFORE deploy and verified. The
  second firing of the CRON AUTH RULE (CLAUDE.md TIMEZONE STANDARD
  section) inside one week.

  **PRE-DEPLOY CATCH 2:** system-health-v2's initial strict
  service-role-only guard (commit `27a3877`) would have 403'd its
  two frontend callers — `src/components/admin/UnifiedSystemHealthTab.tsx`
  (L273) and `src/components/admin/SystemHealthCheckPanel.tsx`
  (L127) — the moment it deployed. Amended to a dual gate
  (service-role bearer OR verified JWT + `has_role` admin / staff /
  finance / csr, mirroring dashboard-summary exactly) in commit
  `49681b4` BEFORE deploy.

  **Deploy + verification.** All five edge functions
  (`dashboard-summary`, `system-health-v2`, `daily-reconciliation`,
  `auto-expire-cash-orders`, `loyalty-inactivity-check`) deployed
  2026-06-05 and smoke-verified the same day: Dashboard loads on an
  admin JWT, System Health Check panel runs from
  `UnifiedSystemHealthTab` and `SystemHealthCheckPanel`, staff
  payment-proof upload path intact, Phase B session customer upload
  path intact via the new ownership policy, token customer upload
  path unchanged. First Vault-keyed cron firings happen overnight at
  00:20 / 00:25 / 00:30 UTC — **System Health Check 17 is the morning
  witness** (verifies daily-reconciliation ran within 25 hours).

### Loyalty redemption approve — atomic via approve_redemption_atomic RPC (shipped 2026-06-05)

  `approve_redemption_atomic(uuid, uuid, text) returns jsonb` created
  in SQL Editor 2026-06-05 — SECURITY DEFINER, all seven approve
  writes (loyalty_transactions insert, redemption status flip + tx_id
  stamp, loyalty_members debit with relative arithmetic on a row
  locked FOR UPDATE, loyalty_jpy_amount net-reduce, synthetic
  payment + account/cash-order totals + status, catalog stock
  decrement, audit_logs `redemption_approved` insert) execute inside
  a single transaction. Any raise rolls back the entire set —
  no half-committed state. EXECUTE revoked from PUBLIC / anon /
  authenticated; service-role only.

  `process-loyalty-redemption/index.ts` approve handler now keeps
  the upstream fast-error pre-flight and delegates every write to
  the RPC (commit `6b9d8a7`, +31/−425, deployed via Lovable). The
  named raises map to friendly responses: `redemption_not_pending`
  → 400, `insufficient_points` → 400, `reward_out_of_stock` → 409,
  `not_found` → 404, generic → 500. Closes Bug #164 (four holes:
  double-approve race, lost-update points debit, free-redemption
  hole, stock-race manual-refund) — see docs/FIXED-BUGS.md Bug #164
  for the full pre-fix exposure analysis.

  **BEHAVIOR CHANGE (owner-approved):** Catalog reward stock
  depletion at approve time now ABORTS the approval with 409
  `reward_out_of_stock` and zero writes. The legacy "approved but
  cancel manually" notification + 409 path is removed — customers
  who lose the stock race now get a clean rejection instead of a
  debited account with a side notification asking admin to manually
  refund. The edge-side `audit_logs` insert for
  `redemption_approved` was removed (the RPC owns it now; previously
  it was being logged twice).

  Verified live 2026-06-05: points-only approve, `new_order_discount`
  approve + void on TEST-004, Check Health green, double-click race
  bounces correctly with `redemption_not_pending`.

  Verified live 2026-06-06: approve end-to-end empirically confirmed
  via a staff-role JWT through the `isInternal` server gate (commit
  `a3d941b`) after the Bug #169 `v_currency::account_currency` cast
  fix to `approve_redemption_atomic`. First successful staff-role
  approve in production. See docs/FIXED-BUGS.md Bug #169.

### Loyalty community links (shipped 2026-06-05)

  WhatsApp + LINE community group links surfaced in two places for
  loyalty members.

  URLs (canonical, hardcoded in both surfaces):
  - WhatsApp: https://chat.whatsapp.com/ENdMNvF8N3jB3iG963f6EF
  - LINE:     https://line.me/ti/g/5fb8KyBCCJ

  Surfaces:
  - **Enrollment email** (templateName `loyalty-welcome`,
    `supabase/functions/_shared/transactional-email-templates/loyalty-welcome.tsx`):
    new "Join our community" Section inserted between the "View My
    Loyalty Dashboard" CTA and the closing footnote. Two `<Button>`s
    centered, hex colors only (#25D366 WhatsApp / #06C755 LINE, white
    text), matching existing template typography/spacing rules.
  - **Loyalty portal home screen**
    (`src/components/loyalty/screens/HomeScreen.tsx` → new
    `src/components/loyalty/home/CommunityCard.tsx`): compact card
    appended after MilestoneCard, motion-faded in (delay 0.4), same
    `bg-card rounded-xl p-4 shadow-card border-gold-accent` shell as
    the other home cards, with a Users icon + heading + two anchor
    buttons opening in a new tab (target=_blank, rel=noopener
    noreferrer).

  Update both URLs together when groups rotate — there is no shared
  constant yet.

### Cron auth migrated to Vault — daily-penalty-engine + daily-auto-forfeit (shipped 2026-06-05)

  Both pg_cron jobs `daily-penalty-engine` and `daily-auto-forfeit`
  migrated via SQL Editor from embedded anon-key Authorization
  headers to Vault-backed service keys. Each job now reads the
  service role key at fire time via
  `(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name
  = 'email_queue_service_role_key')` and passes it as
  `Authorization: Bearer <key>`.

  Required because the underlying edge functions added
  service-role-only gates in today's security pass — the previous
  embedded anon key would now 401 at every cron tick. No code change
  in either edge function; the new gate accepts the runtime
  `SUPABASE_SERVICE_ROLE_KEY` and the Vault copy resolves to the
  same value for pg_net's outbound POST.

  Matches the established Vault-backed cron pattern used by
  loyalty-sheet-reconcile, process-email-queue, and the rest of the
  cron fleet — codified in CLAUDE.md (see "Any pg_cron job calling a
  service-role-gated edge function").

### Storage policies — payment-proofs uploads (shipped 2026-06-05)

  Two INSERT policies applied on `storage.objects` via SQL Editor to
  replace the dropped unrestricted anon-upload policy from
  `2370082`:

  - **"Token customers can upload payment proofs"** (role: `anon`).
    Anon INSERT permitted on `bucket_id = 'payment-proofs'` ONLY when
    the request carries `x-portal-token` AND that token has an
    active, non-expired row in `customer_portal_tokens`. Three
    frontend upload sites now send the header (see "Security
    follow-through" block above for file list).
  - **"Authenticated users can upload payment proofs"** (role:
    `authenticated`). Authenticated INSERT permitted on
    `bucket_id = 'payment-proofs'` bucket-wide. Covers Phase B
    JWT-authenticated customers and any internal staff upload path.

  Together these restore the upload path while preserving the
  Bug-#-style 403 gate against unscoped anon writes that the
  `2370082` security pass closed.

### staff_notifications trigger inventory + helper hardening (shipped 2026-06-05)

  Full DB trigger coverage now feeding `staff_notifications`:

  - `payment_submissions`: created + reviewed events
  - `layaway_accounts`: created
  - `cash_orders`: created  *(cash orders are first-class accounts —
    see CLAUDE.md "Account-scoped features … MUST cover BOTH")*
  - `csr_notifications`: customer-notified events
  - `extension_requests`: lifecycle (requested / granted)
  - `penalty_waiver_requests`: lifecycle (requested / approved /
    rejected)
  - `loyalty_members`: enrolled + tier_changed

  Helpers `staff_notify(...)` and `staff_display_name(uuid)` had
  EXECUTE revoked from `PUBLIC`, `anon`, and `authenticated` via SQL
  Editor — trigger-only access. Direct invocation from any
  application code path now fails permission-checked at the boundary,
  matching the principle that staff_notifications is a system-of-
  record written exclusively by DB triggers.

### Payment method registry (shipped 2026-06-05)

  Canonical payment-method values + currency tagging in one place.
  Replaces the 4+ independent hardcoded option lists across the app.

  - src/lib/payment-method-registry.ts: PAYMENT_METHODS (15 entries —
    5 PHP, 8 JPY, 2 currency-neutral), METHOD_ALIASES (legacy spellings
    → canonical), helpers normalizeMethod / methodCurrency /
    methodMismatch / methodLabel.
  - RecordPaymentDialog, MultiInvoicePaymentDialog, AccountDetail edit
    Select now render options from PAYMENT_METHODS. Edits cannot
    reintroduce orphan values; legacy stored values preselect via
    normalizeMethod. AccountDetail's MULTI_INVOICE_PAYMENT_DIALOG retains
    METHODS_WITH_REF — reference-number rules untouched.
  - Currency-mismatch warning (amber box, non-blocking) appears when
    the selected method's currency is PHP/JPY and differs from the
    account currency. Multi-invoice dialog warns when any selected
    invoice currency mismatches.
  - Portal: src/lib/payment-methods.tsx moved 'cash-payment' and
    'cash-on-delivery' from group 'PH' → 'JP' (JPY-only channels);
    'cash-pickup' stays PH. CashPortalPaymentDialog +
    CustomerPortal submit & edit pass payment_method through
    normalizeMethod() so hyphenated portal ids ('cash-payment',
    'cash-on-delivery', 'cash-pickup') store canonically ('cash',
    'cod', 'cash_pickup'). Portal pay form shows a muted single-line
    hint "This method receives {JPY/PHP} — your account is billed in
    {currency}." when the selected method's currency differs from
    the order/account currency.

  No edge function or migration changes. No stored data rewritten.

### Staff Notification Center (shipped 2026-06-05)

  In-app bell-icon notification feed for internal staff. The hardcoded
  red-dot Link bell in AppLayout was replaced with a real popover.

  Data:
  - Tables: staff_notifications (id, type, title, body, account_id,
    customer_id, invoice_number, metadata jsonb, created_at) +
    staff_notification_reads (notification_id, user_id, read_at).
  - RLS: staff SELECT via is_staff(); each user SELECT/INSERT their own
    read rows. Created via SQL Editor — no repo migration.
  - DB triggers populate it for: submission_created, submission_confirmed,
    submission_rejected, account_created, customer_notified,
    extension_requested, extension_granted, waiver_requested,
    waiver_approved, waiver_rejected.
  - cash_orders AFTER INSERT trigger `trg_notify_cash_order_created`
    (type `account_created`) added 2026-06-05 so the bell also surfaces
    new cash orders, not just layaway accounts.

  Loyalty award rows (added from edge-fn side):
  - review-payment-submission inserts staff_notifications rows from the
    loyaltyAwards array immediately before its final layaway success
    return: type='loyalty_award' on award.awarded=true,
    type='loyalty_award_failed' on award.error. Skipped results
    (not_enrolled / below_minimum / already_awarded / etc.) emit
    nothing. account_id passes through; failures are non-blocking.

  UI:
  - src/components/notifications/StaffNotificationBell.tsx rendered in
    AppLayout.tsx header. Popover trigger = same ghost icon Button; red
    pill unread badge (cap "9+"), hidden at 0.
  - react-query polling every 60s: latest 20 notifications + the current
    user's reads for those ids. Unread = no matching read row.
  - Item click inserts a read row and navigates to
    /accounts/{account_id} when set; if account_id is null and
    metadata.cash_order_id is present, routes to
    /cash-orders/{cash_order_id} instead (added 2026-06-05); rows with
    neither only mark read. "Mark all read" upserts read rows for all
    currently-unread ids (duplicate-key tolerant).
  - loyalty_award_failed rows get destructive/red accent + left border.
    loyalty_award_missing rows (daily-reconciliation self-healing
    recoveries) get amber accent.
  - Bell list now scrolls (max-h-[70vh], overflow-y-auto) — all 20
    fetched rows reachable regardless of viewport. Footer carries the
    primary link "View all notifications →" to
    /monitoring?tab=notifications and a secondary smaller "Open
    Monitoring" link (preserves the original behavior). (updated
    2026-06-05)
  - Empty state: "No notifications yet."
  - **Full Notifications section** at /monitoring?tab=notifications
    (component: `src/components/notifications/NotificationsPanel.tsx`).
    Paginated 25/page, newest first; type-filter dropdown built from
    the live distinct-type set; unread-only toggle; per-row icon,
    title, body, relative + exact timestamp; loyalty_award_failed
    accented destructive, loyalty_award_missing amber; row click marks
    read then routes to /accounts/{account_id} → else
    /cash-orders/{metadata.cash_order_id} → else just mark read;
    "Mark all read" applies to the current filter scope. Sidebar
    sub-item "Notifications" added under CSR Monitoring per the
    SIDEBAR ARCHITECTURE rule.

### Security follow-through (verification — 2026-06-05)

Commit `2370082` dropped the unrestricted anon-upload policy on the
`payment-proofs` storage bucket and revoked SELECT on
`customers.portal_pin_hash` from `anon`/`authenticated`.

- **portal_pin_hash client reads:** grep -rn "portal_pin_hash" src
  returns hits ONLY in the auto-generated `src/integrations/supabase/
  types.ts` (column declarations, not reads). No client component
  selects or destructures the column. Nothing to fix.

- **Portal anon proof uploads:** ✅ **RESOLVED 2026-06-05.** Two new
  storage policies applied via SQL Editor: (1) a token-gated anon
  INSERT policy on `storage.objects` for `bucket_id = 'payment-proofs'`
  that validates `x-portal-token` against an active non-expired
  `customer_portal_tokens` row; (2) an authenticated INSERT policy
  for `bucket_id = 'payment-proofs'` covering JWT (Phase B) customers.
  Frontend updated to send `'x-portal-token': portalToken` (conditional
  spread — only when portalToken is truthy) at the three direct-to-
  storage upload sites:
  - `src/pages/CustomerPortal.tsx` L2101–2113 (layaway submit)
  - `src/pages/CustomerPortal.tsx` L2622–2634 (layaway edit)
  - `src/components/portal/CashPortalPaymentDialog.tsx` L134–148 (cash submit)

  Token-auth (legacy `?token=`) customers now POST with the header
  and pass the anon policy. Phase B authenticated customers omit the
  header (`portalToken` is null on the session-auth code path) and
  pass via the authenticated policy. Pattern matches the dedicated-
  client `x-portal-token` header use in `CashOrdersSection.tsx`.

### Sheet sync reconciler architecture (shipped 2026-06-05)

### Sheet sync reconciler architecture (shipped 2026-06-05)

**Status:** ✅ Operational

**What:** Every `loyalty_transactions` row now reaches the Google Sheet
backup via two paths — synchronous fast-path on natural awards (~1
second latency), async recovery via hourly pg_cron reconciler (~1 hour
catch-up for SQL backfills, direct INSERTs, migrations, and any
fast-path failure).

**Components shipped:**
- `loyalty_transactions.synced_to_sheet_at` column + partial index
  `idx_loyalty_transactions_unsynced`
- `award-loyalty-points` fast-path mark (commit `3c063c9`)
- `loyalty-sheet-reconcile` edge function (commits `f9fcd94` →
  `0e845e2` → `62d17ad`)
- pg_cron entry `loyalty-sheet-reconcile` (jobid 21, schedule
  `7 * * * *`, Vault-backed auth)
- CLAUDE.md "SHEET SYNC ARCHITECTURE — NON-NEGOTIABLE" locked rule
  (commit `344f835`)
- Operational guide: `docs/LOYALTY-OPERATIONS.md`

**Verification:** Manual trigger 2026-06-05 05:38 UTC processed Bea
Sartorio (4,000 pts) + Suzette Tupaz (1,000 pts) — both Bug #163
catch-up rows. Final state: 954/954 rows synced, 0 unsynced.

**Origin:** Bug #163 architectural follow-up — see
`docs/FIXED-BUGS.md` Bug #163 entry "Architectural follow-up
(added 2026-06-05) — sheet sync gap CLOSED".

### Shipped 2026-06-01

  - HUB Help Center Phase 1 — /help route, page component, markdown rendering pipeline (react-markdown + remark-gfm), role-aware filtering, sidebar leaf entry, sample Welcome section: SHIPPED 2026-06-01 ✅ (commit `ff6548b`)
  - Permission system: admin short-circuit in can() + PUBLIC_AUTHENTICATED_PATHS escape valve for universally-accessible routes (fixes /help access-denied + prevents recurring "new menu denied for admin" pattern; matches CLAUDE.md rule 3): SHIPPED 2026-06-01 ✅ (commit `b98d6c2`)
  - HUB Help Center Welcome content: renamed "Layaway Tracking System" → "Cha Jewels HUB", removed stray external link: SHIPPED 2026-06-01 ✅ (commit `bf7840e`)

### Trade Program (shipped 2026-05-31)

  Trade Program Phase 1 (is_trade flag + creation + display): SHIPPED 2026-05-31 ✅
  Trade Program Phase 2 (KPI cards + monthly trend chart on Finance Overview): SHIPPED 2026-05-31 ✅

### Birthday Reward (shipped 2026-05-26)

  Tier-scaled birthday bonus points, claimable once per calendar year during the
  customer's birth month. Instant credit, no staff approval.

  Data (customers): birthday (sentinel year 2000 → month+day only), birthday_locked_at
    (set-once lock), birthday_admin_edits_used (correction counter), last_birthday_award_year
    (once-per-year guard). Per-tier amount: loyalty_tiers.birthday_bonus_points
    (Glimmer 500 / Radiant 1000 / Elite 1500 / Crown VIP 2000).

  Set-once + lock: trigger prevent_birthday_change blocks any birthday change after
    birthday_locked_at is set and blocks clearing the lock; the only permitted post-lock
    change is an admin correction (birthday_admin_edits_used = OLD+1, cap 1).

  Customer set (portal): customer-portal edge fn action 'set_birthday' (service-role
    UPDATE + lock + audit_logs); ProfileScreen Month/Day picker → 2000-MM-DD.

  Claim (portal): Home BirthdayRewardCard shows only when birthday_reward.claimable
    (GET payload: birthday set AND birth month = current month [PHT] AND
    last_birthday_award_year != current year). Redeem → customer-portal action
    'redeem_birthday' → _award_birthday_reward(uuid) worker (atomic year-stamp guard,
    race-safe) credits remaining_points + total_points_earned and writes a birthday_bonus
    loyalty_transaction; the action then fires sheet sync (event_type 'birthday_bonus') +
    emitNotification (category 'birthday'). Strict no-double-redeem per year — the guard is
    independent of the birthday date, so correcting the date does NOT re-enable a same-year claim.

  Admin/staff correction: admin_correct_birthday(p_customer_id, p_birthday) SECURITY DEFINER
    RPC, gated has_role admin OR staff, cap 1 (trigger + RPC both enforce). UI in
    loyalty-admin MemberDetailDrawer → Birthday section.

  Grants/cleanup: _award_birthday_reward(uuid) granted to service_role (called by the
    edge fn). The original auth.uid() wrappers set_customer_birthday(date) and
    redeem_birthday_reward() were DROPPED 2026-05-26 — superseded by the edge-fn actions
    for dual-auth (token + session) portal compatibility.

  Admin Audit page: SHIPPED ✅ (2026-05-26)
    - Standalone admin-only page at /admin-activity (sidebar entry
      "Admin Audit", icon ScrollText, adminOnly via menuItem; route
      also gated 'admin' in role-permissions.ts).
    - src/pages/AdminActivityLog.tsx renders the existing
      src/components/admin-audit/ActivityLogTab.tsx component.
    - Reads audit_logs across ALL roles' actions: entity_type /
      action / actor / date range filters + invoice-or-entity-id
      search, newest-first, 50/page Prev-Next, row expands to a
      before→after field diff (updated_at omitted from the diff).
    - Filter dropdown values come from RPC
      get_audit_filter_options() (plpgsql, SECURITY DEFINER,
      admin-gated) returning { entity_types, actions,
      actors:[{user_id, full_name}] }; the actors list doubles as
      the id→name display map.
    - Invoice search resolves to layaway_accounts/cash_orders id
      and filters entity_id (catches account-level rows; payment/
      penalty rows keyed by their own uuid are not caught — a
      per-account audit panel is deferred).
    - Initially shipped 2026-05-26 as a tab inside /admin-audit
      ("System Audit" page); same day extracted to its own page so
      System Audit reverted to its prior penalty-cap / penalty /
      overdue / waiver tab set.

  Phase B email/password authentication: SHIPPED ✅ (2026-05-05)
    - Customer portal supports both token-based and email/password auth
    - Per-customer routing via customers.auth_user_id
    - Token auth permanent — no sunset, no revocation on signup
    - Admin Send Setup Link UI on CustomerDetail page
    - Production-validated 2026-05-06 via CJ-2026-05088 re-migration
    - 71 no-email customers + Cabalza family stay on token auth indefinitely

  Phase B post-launch hardening: SHIPPED ✅ (2026-05-06)
    - Phase 1 portal-link helper integration: 3 admin URL builders
      now route via getPortalLinkForCustomer() —
      src/pages/CustomerDetail.tsx, src/pages/AccountDetail.tsx,
      src/components/customers/CustomerPortalShareMenu.tsx
      (commit 5363f7d). Migrated customers receive bare URL,
      non-migrated continue with token URL.
    - Phase 2 portal-link helper integration: reminder cards
      (Monitoring overdue/grace/due_today/upcoming via
      ReminderCard, commit d2525ce) + P1-P8 penalty messages
      and dialog action buttons (PenaltyFollowUpSection,
      commit 0ea159a) + Monitoring portalTokens query reshape
      with auth_user_id (commit 7ff6937)
    - portalTokens query Map shape extended:
      Map<string, { token, authUserId }>; queryKey renamed to
      'portal-tokens-with-auth' in both PenaltyFollowUpSection
      and Monitoring to invalidate stale browser caches.
      useAutoRefresh entries updated in lockstep with the
      query key rename.
    - Staff-email collision detection: SHIPPED ✅ — new
      check_customer_email_conflict(p_customer_id)
      SECURITY DEFINER RPC + yellow warning banner + Copy URL
      + Messenger alt-channel buttons in CustomerPortalShareMenu
      (commit 8265ce6). Prevents future Brendalyn-style mishaps
      where admin unknowingly sends a setup link to an email
      belonging to a staff account, which would silently link
      the customer to the staff auth user.
    - Email template HSL color fix (Yahoo Mail PH): see
      Known Fixed Bug #82 (commit e0c7719). General rule:
      inline email CSS must use hex or rgb(), never hsl().
    - PortalSetup Loading-screen timeout + bootstrapping flag
      fix: see Known Fixed Bug #83 (commit 633c211).
    - PWA NetworkFirst nav caching: see Known Fixed Bug #84
      (commit 4014f97).
    - Pilot customer migrations: 3 customers migrated to
      email/password — CJ-2026-05088 "Test Customer"
      (unattended verification), Brendalyn CJ-2026-03936
      (manual SQL email fix needed after a deferred SQL
      placeholder bug), Cholita CJ-2026-02000 (clean
      unattended after HSL→hex email fix).
    - Net result: migrated customers (auth_user_id IS NOT NULL)
      now consistently receive bare
      https://portal.chajewelsjp.com/portal URLs across admin
      payment confirmations, reminder cards
      (overdue/grace/due_today/upcoming), and P1-P8 penalty
      messages. Non-migrated customers continue receiving
      ?token=X URLs.

  Phase 4-B2.5 — Extension request session-auth wiring: SHIPPED ✅ (2026-05-07)
    - Commit 3741326. Frontend-only fix in
      src/pages/CustomerPortal.tsx (+12/-4 lines).
    - handleExtensionRequest now uses
      getPortalAuthHeaders(portalToken):
        * token-auth users → empty headers (anon fallback
          unchanged)
        * session-auth users → Bearer JWT (PostgREST sees
          authenticated role, matches existing
          TO authenticated WITH CHECK (true) RLS policy on
          extension_requests)
    - Body now writes customer_id from new AccountDetail prop
      so admin queue can identify session-auth requesters even
      when portal_token is null.
    - Notification email's portalUrl now calls
      getPortalLinkForCustomer({ auth_user_id: null,
      portal_token: portalToken || null }, 'portal') — token URL
      when token present, bare /portal URL when null.
    - Unblocks customer-side extension requests for migrated
      session-auth users without depending on RLS file 6 (which
      contains SELECT-only policies, unrelated to the INSERT
      path). Original "RLS policy work" diagnosis from session
      memory was a misdiagnosis — RLS was already permissive
      enough.

  delete-account → delete_account_atomic atomic RPC: SHIPPED ✅ (2026-05-08)
    - 16-step FK cleanup + audit log wrapped in single transaction
      (atomic). Partial failures roll back; eliminates silent
      audit gaps from prior TypeScript implementation.
    - Defense-in-depth admin role check at both edge function
      and RPC layers (auth.uid() + public.has_role inside
      SECURITY DEFINER body; Bearer JWT + supabase.rpc('has_role')
      at edge function entry).
    - Edge function rewritten as thin wrapper (~85 lines, down
      from 159). Caller contract unchanged; useDeleteAccount hook
      and AccountDetail UI button untouched.
    - Closes prior security gap: any authenticated user could
      previously call delete-account directly without admin role
      check (edge function only validated JWT presence, never
      role).
    - All 5 smoke tests passed in production SQL Editor before
      commit:
        1. Pre-delete inventory baseline (1 account, 3 schedule rows)
        2. RPC returned {"success": true} on first valid call
        3. Cleanup verified: account=0, schedule=0, audit_logs=1
        4. Re-call on deleted UUID returned {"error": "Account not found"}
        5. Atomic rollback — wrong-UUID FK exception rolled back
           all 16 deletes (audit-or-nothing semantics verified)
    - RPC body in
      supabase/migrations/20260508013641_delete_account_atomic.sql

  PHASE B BULK ROLLOUT (added 2026-05-07)
    - Purpose: one-time broadcast to send the
      portal-setup-invite email to every eligible customer
      that has not yet been migrated. After Phase B's per-
      customer admin button validated the flow, this delivers
      Setup Links at scale (586 net-deliverable customers at
      deploy time) without admins clicking each customer
      individually.
    - Edge function:
      supabase/functions/bulk-send-setup-invites/index.ts
    - Companion RPC: get_bulk_setup_invite_candidates
      (supabase/migrations/20260507000001_bulk_setup_invite_candidates.sql)
      SECURITY DEFINER, returns the next batch of eligible
      customers + total_eligible. Two modes: count_only=true
      returns a single row with the total; count_only=false
      returns up to p_limit rows ordered by customer_code.
    - Auth: admin-only. Edge function extracts Bearer JWT,
      calls supabase.auth.getUser, then queries user_roles
      and rejects with 403 if role !== 'admin'. Mirrors the
      manual-forfeit pattern. The RPC also gates on
      public.has_role(auth.uid(), 'admin'); service_role
      callers (auth.uid() IS NULL inside the edge function)
      pass through, but direct PostgREST calls without admin
      role are blocked.
    - Exclusions baked into the RPC (every condition must
      hold for a customer to receive the invite):
        * customers.email IS NOT NULL
        * auth_user_id IS NULL (not yet migrated)
        * setup_link_sent_at IS NULL (no prior invite)
        * LOWER(email) NOT IN auth.users (staff-collision
          exclusion — prevents the Brendalyn-style mishap)
        * email NOT shared by 2+ unmigrated customers
          (Cabalza-pattern exclusion — shared family inbox)
    - Net deliverable at deploy time: 586 customers.
    - Idempotent: each successful send stamps
      customers.setup_link_sent_at = NOW(); subsequent runs
      automatically skip already-sent customers via the
      RPC's setup_link_sent_at IS NULL filter. Failed sends
      do NOT stamp, so they remain eligible for retry on the
      next batch.
    - Architecture: per-candidate
      supabase.functions.invoke('send-transactional-email')
      with templateName 'portal-setup-invite' (matches the
      per-customer admin button payload from
      CustomerPortalShareMenu.tsx exactly). No in-function
      throttle — process-email-queue (cron every 5 seconds)
      paces actual delivery. Suppression list and unsubscribe
      tokens are enforced by send-transactional-email so the
      bulk function piggybacks on existing safety nets.
    - Test mode: pass test_customer_codes (string[]) in the
      request body to scope the candidate set to specific
      customer_codes for targeted dry runs or pilot batches.
      Test codes are an ADDITIONAL filter; staff-collision /
      shared-email customers in the test list are still
      excluded (the safety floor is non-negotiable).
    - Dry-run mode: { dry_run: true } returns the candidate
      preview without sending or stamping.
    - Cloud Shell driver: while-loop calling the endpoint
      until response.remaining_eligible === 0. Recommended
      batch_size 50 (default; clamped to 1..100). Each
      response also includes per-failure errors[] for audit.
    - Workflow note: this is the function's first commit, so
      per Bug #77 the path-trigger may not fire on initial
      deploy (commits.*.added is not detected). The same
      commit also touches .github/workflows + CLAUDE.md so
      the workflow run does fire — but if for any reason the
      Deploy bulk-send-setup-invites step skips, run a manual
      Cloud Shell deploy:
        npx supabase functions deploy bulk-send-setup-invites \\
          --project-ref pfoicalpzdcmyxzvwyhz

  Cash Basis Plan Phase 1 (DB): COMPLETE ✅
    - cash_orders table created with 3 indexes
    - cash_payments table created with 2 indexes
    - payment_submissions extended with cash_order_id
    - cash_order_status enum created (pending/completed/cancelled)
    - RLS policies on both tables (admin full, staff/finance read+insert)
    - updated_at trigger on cash_orders

  Cash Basis Plan — Non-Negotiable Rules:
    - Cash orders: one-time full payment, no schedule, no DP
    - Penalty engine: skips WHERE cash_order_id IS NOT NULL
    - Auto-forfeit: does NOT apply to cash orders
    - All flows (submissions, proof, void, loyalty) use same infrastructure
    - Invoice numbers entered manually same as layaway

  Cash Basis Plan: COMPLETE ✅ (2026-04-25)
    - Database: cash_orders + cash_payments tables live
    - 6 edge functions deployed (create/submit/void/
      review/dashboard/customer-portal)
    - Full UI: Cash tab, NewCashOrder, CashOrderDetail,
      customer portal integration, submissions handling
    - 2 email templates (cash-payment-submitted,
      cash-payment-confirmed)
    - KPIs: Dashboard + Finance + Executive all show
      cash metrics
    - Cancellation tracking (cancelled_at, reason, user)
    - Payment submissions go through review flow

  Cash Basis Plan — Known Gaps:
    - Cash payment rejection/clarification emails
      silently fail (no cash-specific templates built yet)
    - Executive dashboard 6-month history chart for
      cash vs layaway deferred (needs
      cash_revenue_by_month_6m RPC)

  Cash order payment submission flow: LIVE ✅ (2026-04-27)
    - submit-cash-payment: duplicate guard (409),
      rate limit (3/24h, excludes cancelled+rejected)
    - account_id nullable on payment_submissions
    - anon storage policy for payment-proofs bucket
    - service_role SELECT/UPDATE policies on customers table
    - Payment methods: CHA_PAYMENT_METHODS shared to
      src/lib/payment-methods.tsx
    - Pending Submissions hidden when cash order completed
    - Cancel submission: customer can cancel and resubmit

  Cash order item_description: REMOVED from form ✅ (2026-04-27)
    - Column remains nullable in DB for invoice use

  Loyalty Program Phase 1 (DB): COMPLETE ✅ (2026-04-25)
    - 5 tables created: loyalty_tiers, loyalty_members,
      loyalty_transactions, loyalty_redemptions,
      loyalty_promos, loyalty_beta_members
    - 3 enums: loyalty_transaction_type,
      loyalty_redemption_type, loyalty_redemption_status
    - 4 tiers seeded: Glimmer/Radiant/Elite/Crown VIP
    - loyalty_jpy_amount column on BOTH layaway_accounts
      and cash_orders (for both earning paths)
    - 18 RLS policies (admin/staff/finance scoped)
    - Feature flag system_settings.loyalty_enabled = false
    - Beta gate ready for testing

  Loyalty Program — Non-Negotiable Rules (locked v2):
    - Points: floor(jpy_equiv / 10,000) × 100 × tier_mult
    - Tiers: Glimmer(0)/Radiant(1M)/Elite(4M)/Crown VIP(8M)
    - Inactivity: 6 months → tier downgrade + points zeroed
    - Pre-expiry email: 14 days before 6-month mark
    - Redemption: 3 types only — new_order_discount/
      shipping_fee/service_fee
    - NO cash payout, NO partial payment to existing balance
    - Invoice number required on every redemption
    - Enrollment: opt-in via portal Join button
    - Cash order trigger: points awarded on completion
    - Layaway trigger: points awarded on DP confirmation
    - Google Sheet: backup mirror, sync on every points update
    - GAS emails: must be disabled — Supabase is sole sender

  Loyalty Program Phase 2 (Edge Functions): COMPLETE ✅ (2026-04-25)
    - 5 new functions: award-loyalty-points,
      sync-loyalty-to-sheet (stub), join-loyalty-program,
      process-loyalty-redemption, loyalty-inactivity-check
    - 3 updated: create-layaway-account, create-cash-order,
      review-payment-submission (DP + cash completion
      triggers wired)
    - pg_cron job 'loyalty-inactivity-check' scheduled
      daily at 08:05 PHT (job_id 13)
    - Sheet sync deferred — stub function in place,
      Google Cloud service account setup pending

  Loyalty Program Phase 3 (UI): COMPLETE ✅ (2026-04-25)
    - LoyaltyPortal page at /loyalty route
    - MemberCard, PointsSnapshot, VipProgressSection,
      RecentActivity, RedemptionForm, TierCelebrationModal
    - Beta gate: useLoyaltyAccess hook + LoyaltyComingSoon
      + LoyaltyJoinPrompt
    - 💎 My Loyalty card in CustomerPortal.tsx
    - customer-portal edge function returns loyalty data

  Loyalty Program Phase 4 (Emails): COMPLETE ✅
    - 8 email templates: welcome, earned, bonus,
      tier-upgrade, tier-downgrade, pre-expire,
      expire-deduct, redeem
    - All wired into edge functions with correct
      template names + props
    - buildLoyaltyPortalUrl helper for server-side
      portal URL generation

  Loyalty Program Phase 5 (Admin): COMPLETE ✅
    - Loyalty tab in Customer Detail (full history)
    - Pending Redemptions queue at /loyalty/redemptions
    - Sidebar badge with pending count
    - Loyalty Promos tab in Promotions menu
    - Settings tab: feature flag toggle + beta whitelist
      + system stats
    - Beta whitelist functional (add/remove)

  Loyalty Program — Deployed to Production:
    - All edge functions deployed via auto-deploy
    - Frontend live on Firebase
    - Feature flag OFF — beta mode active
    - notify_loyalty_launch table created for
      "notify me" email collection
    - account_notes.cash_order_id column added
      (already part of cash plan)

  Loyalty Program — Known Backlog:
    - Cash payment rejection/clarification emails
      silently fail (deferred from cash plan)
    (Sheet sync now LIVE — see 2026-05-15 → 2026-05-16
     GSheet loyalty backup workstream. Adjust Points now
     SHIPPED & VALIDATED — see entry below.)

  Adjust Points feature: SHIPPED & VALIDATED ✅ (2026-05-17)
    - admin/finance can manually add or deduct loyalty
      points via UI dialog (AdjustPointsDialog.tsx +
      CustomerLoyaltyTab.tsx, gated by
      can('loyalty_adjust_points'))
    - adjust-loyalty-points edge function: signed
      points_delta, reason ≥10 chars, admin OR finance
      has_role auth, server-side overdraw guard fires
      BEFORE ledger/counter/audit writes (true
      defense-in-depth)
    - Writes loyalty_transactions (type='adjusted'),
      updates loyalty_members counters, audit_logs entry,
      in-portal notification (emit-notification master +
      recipient pattern), sheet sync (adjusted event)
    - 5/5 smoke tests + server-side guard code-review
      pass 2026-05-17 (permission seeded; +100 / -50 to
      Efrhyll Largo CJ-2026-05448 confirmed; overdraw
      client + server reject with no DB change; staff
      403 UI gate)
    - Shipped commit 7f8ea84

  Loyalty Transactions tab with Member/Transactions sub-tabs: SHIPPED ✅ (2026-05-17)
    - 8th tab on LoyaltyAdmin page (between Audit Log and Promotions),
      read-only feed of loyalty_transactions rows mirroring the Google
      Sheet backup structure
    - Two sub-tabs: Member (enrolled/tier_changed/status_changed/admin_edited)
      and Transactions (earned/bonus/redeemed/expired/adjusted/refunded/
      revoked/birthday_bonus); independent filter/page state per sub-tab
    - Table: date, type (color-coded badge), member (clickable to Members
      tab), points (signed/colored), spend, tier, invoice (deep-link),
      truncated notes with tooltip
    - Filters: date range (All / 7 / 30 / 90 days) + type dropdown
      (adapts to active sub-tab) + member search (case-insensitive
      client-side over customer_code + full_name); CSV export
    - Drawer: full transaction detail with conditional field rendering,
      "Open member profile" link, source deep-links to account/cash order,
      regex-parsed "Tier change" highlight card for tier_changed rows
    - 475 historical 'enrolled' rows backfilled from loyalty_members.enrolled_at
    - Future enrollments emit 'enrolled' rows via join-loyalty-program
    - Future tier upgrades emit 'tier_changed' rows via award-loyalty-points
    - Commits: d636a4f (initial tab) + f5f6d98 (sub-tabs + event wiring)
    - Edge functions deployed 2026-05-17 10:57 UTC
    - status_changed / admin_edited / birthday_bonus enum values reserved
      for future event emission wiring (separate workstreams)

  accept-underpayment auto-carry: REMOVED ✅
  carry-over edge function: DEPLOYED ✅
  review-payment-submission auto-carry: REMOVED ✅
  recalculate-penalties: DISABLED (returns 410) ✅
  Underpayment decision modal: BUILT ✅
  Overpayment/Keep decision modal: BUILT ✅
  penalty-engine due_date filter: FIXED ✅
  penalty-engine grace period: FIXED ✅
  penalty-engine self-healing Step 5b: ADDED ✅
  auto-forfeit-settlement error checking: ADDED ✅
  auto-forfeit-settlement immediate audit logs: ADDED ✅
  fix-account-totals: REWRITTEN ✅
  Account Health button: ADDED ✅
  System Audit button: ADDED ✅
  SystemAudit.tsx page: REMOVED ✅
  AccountDetail verify panel: REMOVED ✅
  Waterfall bug (penalty split): FIXED ✅
    (commits 9069ffd + 7993a94 + b7bc1c8)
  Session timeout (2hr idle + 5min warning): ADDED ✅
    (commit bfe4634)
  Admin audit log DB trigger: ADDED ✅
    (layaway_accounts + payments tables)
  delete-account audit wipe: FIXED ✅
    (commit bf368a6)
  delete-account reconciliation_log cleanup: ADDED ✅
    (2026-04-28) — reconciliation_log was created
    via SQL Editor 2026-04-20 with ON DELETE NO ACTION;
    delete-account cleanup list now includes it as
    step 9 (originally step 8 in commit bdac341,
    renumbered to 9 when extension_requests was
    inserted at step 7). Manual deploy required —
    delete-account is not in the auto-deploy workflow.
    See bug #50.
  delete-account extension_requests cleanup: ADDED ✅
    (2026-04-28) — extension_requests FK declared in
    repo migration 20260418010000 with no ON DELETE
    clause (defaults to NO ACTION). Added as step 7
    immediately after csr_notifications, in the same
    session as the reconciliation_log fix. After
    these two additions the cleanup list now covers
    all 6 NO ACTION/RESTRICT FKs to layaway_accounts.
    Manual deploy required. See bug #51.
  record-payment canonical formula: FIXED ✅
    (commit 6dd13e4)
  Platform rebrand → Cha Jewels Hub: DONE ✅
    (commit f0c3751)
  Customer portal splash screen: ADDED ✅
    (commit 1df6ee1)
  Admin login redesign (Kihei photo): DONE ✅
  Sidebar retheme (warm charcoal + gold): DONE ✅
  daily-reconciliation pg_cron: ADDED ✅
    (job 7, schedule 5 0 * * *)
  Email templates (13 total): ADDED ✅
    (commit 366b3bc)
  Email notifications wired to 7 edge functions: DONE ✅
    (commit 85f5666)
  System Audit: 683/683 passed ✅
  Admin Audit restructured: DONE ✅
    - Reconciliation tab: REMOVED
    - System Health tab: REMOVED
    - Moved into Monitoring & Audit page as 4th tab
    - Admin Audit removed from sidebar
    - TEST-% filter added to all audit tabs
    - Canonical formula alignment: VERIFIED
    - 3 minor display fixes applied (commit 355b0b0)
  Monitoring page renamed: "Monitoring & Audit" ✅
    - CSR Alerts, Smart Reminders, Extensions: unchanged
    - New Audit tab with 4 sub-tabs added

  Cash order payment submission flow: LIVE ✅ (2026-04-27)
    - submit-cash-payment: duplicate guard (409),
      rate limit (3/24h, excludes cancelled+rejected)
    - account_id nullable on payment_submissions
    - anon storage policy for payment-proofs bucket
    - service_role SELECT/UPDATE policies on
      customers table
    - Payment methods: CHA_PAYMENT_METHODS shared
      to src/lib/payment-methods.tsx
    - Pending Submissions hidden when cash order
      completed
    - Cancel submission: customer can cancel and
      resubmit

  Cash order item_description: REMOVED from form ✅ (2026-04-27)
    - Column remains nullable in DB for invoice use

  Loyalty award system: LIVE ✅ (2026-04-27,
  Layer-2 removed 2026-05-16)
    - Single canonical path: review-payment-submission
      → award-loyalty-points edge function
    - Layer-2 DB trigger safety net REMOVED
      2026-05-16 (migration
      20260516000000_drop_layer2_loyalty_triggers.sql) —
      produced ghost audit rows without updating
      counters/lots. See LOYALTY AWARD SYSTEM +
      LOYALTY SYSTEM RULES.
    - Skips if loyalty_jpy < ¥10,000 or null
    - Skips if loyalty_jpy_amount <= 0 or null (server-enforced
      amount gate per Bug #113, currency-agnostic since 2026-05-17)
    - Skips if customer not enrolled (no auto-enroll)
    - Skips if loyalty_enabled flag is false/null

  Loyalty staff visibility: LIVE ✅ (2026-04-29)
    - view_loyalty_redemptions permission key seeded in
      role_permissions (admin/finance/staff = true,
      csr = false). Applied via SQL Editor.
    - PAGE_PERMISSION_MAP gates /loyalty/redemptions
      via the new key — closes the prior page-access
      bug where the route was denied for everyone (see
      Known Fixed Bug #63).
    - AppSidebar permPath added so the sidebar entry
      now respects canSeeNav.
    - NewCashOrder + NewAccount: staff role can see the
      "Product Amount (JPY) — Loyalty Only" input.
    - AccountDetail: Loyalty Points Preview card added
      (parity with CashOrderDetail). Footnote reads
      "awarded once downpayment is confirmed" per the
      locked layaway DP-trigger rule.
    - RedemptionApprovalModal: Approve button gated to
      admin || finance. Staff sees a read-only modal
      with Close only.
    - process-loyalty-redemption: server-side approve
      gate tightened to admin || finance, closing the
      UI/server drift surfaced in Known Fixed Bug #64.
      create and cancel gates left unchanged.

  PWA install on customer portal: ROLLED BACK 🚧 (2026-04-29)
    - PR-1 (cae1bc8, bug #61) and PR-2 (bef1949, bug #62)
      shipped a hide-banner hotfix and a data:-URL dynamic
      manifest. Phase 0 (commit referenced as Known Fixed
      Bug #65) reverted both because the data:-URL manifest
      failed Chrome's install-eligibility heuristic — Start
      URL parsed empty in DevTools and customers never saw
      a working install prompt anyway.
    - Current state: customers cannot install the portal as
      a PWA. Static /manifest.webmanifest from vite-plugin-pwa
      and the service worker remain in place untouched. iOS
      Safari "Add to Home Screen" still works natively (uses
      the current URL with token, not start_url).
    - Forward fix: PWA TOKEN-TO-SESSION REDEMPTION Phase A
      (see PENDING ITEMS) — token-to-cookie/session swap
      so the installed shortcut resolves to the right
      customer without needing to bake the token into
      start_url.
      NOTE (2026-05-17): superseded — canonical PWA status now
      lives in SYSTEM STATUS → "PWA Install". Phase A abandoned
      2026-05-04; Phase B (email/password) is the sanctioned path.
    - Customers who installed the broken admin-context PWA
      before Phase 0 still have a dead shortcut on their
      device. Phase 6 dead-shortcut UX handler (in PENDING)
      will cover that.

  Loyalty Admin Portal: LIVE ✅
    Phase 1 — Foundation (LIVE 2026-04-29)
      - Route /loyalty/admin with 4 tabs:
        Dashboard / Members / Redemptions /
        Beta Whitelist
      - Sidebar entry "Loyalty" replaces
        "Loyalty Redemptions" (top-level,
        between Promotions and Settings)
      - Old /loyalty/redemptions redirects to
        /loyalty/admin?tab=redemptions
      - URL-driven tab state with deep-linking
        support (?tab=members&search=<code>)
      - Pending redemptions count badge on
        sidebar entry
      - Dashboard: total members, per-tier
        counts, points outstanding/redeemed,
        lifetime spend, recent enrollments
        table, tier distribution donut chart,
        pending redemptions card
      - Members: search/filter/sort/pagination,
        drawer view (read-only, links to
        Customer Detail for Adjust Points)
      - Redemptions: full queue with approve/
        reject flows (admin/finance gated
        server + UI)
      - Beta Whitelist: customer search +
        add/remove flow
      - CustomerLoyaltyTab: removed inline beta
        UI, added portal links (View in Members,
        Manage Beta Status)
      - ~793 lines of duplicate code removed
    Phase 2 — Configuration (LIVE 2026-04-29)
      - Tiers tab: 4 tier cards. Edit dialog is
        a two-step flow (form → impact preview)
        that recomputes every member's tier
        under the proposed threshold and
        surfaces promoted_in / demoted_out
        counts before save.
      - Tier name is read-only — locked because
        loyalty_promos.applicable_tiers
        references tier names and renaming
        would silently break promo applicability.
      - Editable per tier: min_spend_jpy,
        points_multiplier, color_hex,
        free_shipping_min_items (nullable),
        mystery_gift.
      - Settings tab: master loyalty_enabled
        toggle (admin only) with confirmation
        modal; hardcoded constants display
        (base rate, activity threshold, expiry
        rule); 8 email notification toggles;
        Google Sheets sync config (sheet ID,
        service account, frequency) with
        disabled "Sync Now" button.
      - Email toggles ship UI only — Phase 2.5
        wires the gates at each send site.
        Toggling stores the preference in
        system_settings; sends still fire
        unconditionally.
      - Audit Log tab: paginated audit_logs
        query filtered to loyalty entity_types,
        with entity_type / action / performer /
        date-range filters and a row-click
        drawer showing old/new JSON diff.
      - Audit instrumentation added to all
        Phase 1 mutations: beta add/remove,
        feature flag toggle, redemption
        approve/cancel.
      - LOYALTY_SETTINGS_AUDIT_ID sentinel
        00000000-0000-0000-0000-0000000000a1
        used for system-level audit entries
        because audit_logs.entity_id is
        UUID NOT NULL and system_settings has
        no per-row UUID.
      - LoyaltySettingsTab.tsx deleted (191
        lines); the Settings menu Loyalty tab
        was removed. Single source of truth
        for the feature flag now lives in the
        admin portal Settings tab.
      - BetaWhitelistTab feature-flag toggle
        removed; now shows a read-only status
        indicator + "Manage in Settings tab →"
        link.
      - 11 system_settings keys seeded for
        Phase 2 (8 email toggles, 3 sheet sync
        config keys).
    Phase 2.5 — Email gate plumbing (LIVE 2026-04-29)
      - New _shared/loyalty-email-gate.ts
        helper exporting createLoyaltyEmailGate
        factory + LOYALTY_EMAIL_KEYS tuple +
        LoyaltyEmailKey type.
      - 8 send sites gated across 4 edge
        functions:
          award-loyalty-points (3):
            loyalty-earned, loyalty-bonus,
            loyalty-tier-upgrade
          process-loyalty-redemption (1):
            loyalty-redeem
          join-loyalty-program (1):
            loyalty-welcome
          loyalty-inactivity-check (3):
            loyalty-pre-expire,
            loyalty-expire-deduct,
            loyalty-tier-downgrade
      - sendEmail helper in
        loyalty-inactivity-check now takes
        gate + gateKey as its first two
        params (Option A — explicit). Skip
        log lives inside the helper so all
        3 call sites are gated through one
        code change.
      - Per-invocation Map cache: each
        handler creates its own gate via
        createLoyaltyEmailGate(supabase) so
        the same key is never queried twice
        in a single invocation.
      - Fail-safe to true: missing key, RLS
        denial, network error, JSON parse
        failure all return true so the gate
        never silently suppresses a send
        because of an infrastructure problem.
      - Standardized skip log format:
          [email-gate] {template} skipped
          — toggle '{key}' is OFF
        Greppable in Supabase function logs.
      - All 4 functions are in the
        auto-deploy workflow so the gates
        ship on push to main. Toggling a
        key off in /loyalty/admin?tab=settings
        now actually suppresses the
        corresponding sends.

    ### Loyalty email gates

    All loyalty_email_* keys in system_settings default to TRUE when the row
    is missing. Explicit FALSE row required to disable. Shipping a new
    transactional email gate does not require a manual system_settings INSERT
    for activation — but inserting an explicit row provides admin UI visibility
    and an auditable enable/disable history.

    Phase 3 — Content Management (LIVE 2026-04-29)
      - Promotions tab: full CRUD with stats
        per promo (uses, unique customers,
        total bonus points), 3-bucket
        grouping (scheduled / upcoming /
        past). Stats aggregated client-side
        from loyalty_transactions where
        transaction_type='bonus' and
        promo_id IS NOT NULL.
      - Rewards Catalog tab: 5 collapsible
        category groups (Redeem with Points
        / Tier Exclusive / Shipping Rewards
        / Member-Only Offers / VIP Vault).
        Full CRUD with Vault toggle that
        locks category='VIP Vault' and
        is_vault=true in sync. Stock display
        with "Out of stock" / low (≤10% of
        limit) / "X / Y left" / "Unlimited"
        tones.
      - Banners tab: featured + promo banner
        management with live preview pane
        mirroring customer-facing component
        shape. link_target supports
        tab:foo (in-portal nav: home /
        rewards / points / notifications /
        profile / tiers) and http(s)://
        (external open). Schedule status
        chips (Live / Scheduled / Expired /
        Always on / Paused).
      - Admin portal tab count: 7 → 10.
        TabsList layout switched to
        flex+overflow on <xl, grid-cols-10
        on xl+. Order:
          Dashboard / Members / Redemptions /
          Beta / Tiers / Settings / Audit Log /
          Promotions / Rewards / Banners.
      - Customer portal now reads from DB:
          RewardsScreen → useLoyaltyRewardsCatalog
          VipRewardsVault → vault subset
            (passed as prop)
          FeaturedBanner → useLoyaltyBannersByType
            ('featured'), top priority becomes
            hero card
          PromoBanners → useLoyaltyBannersByType
            ('promo'), all active sorted by
            display_priority
        New shared dispatchBannerLink helper
        in src/components/loyalty/home/bannerLink.ts
        parses link_target prefix and routes
        to setTab or window.open.
        rowToReward adapter in RewardsScreen
        maps LoyaltyRewardRow → existing
        FallbackReward shape so canRedeem /
        canAccessReward / badge logic stays
        unchanged.
      - 17 rewards + 4 banners (1 featured,
        3 promo) seeded so customer portal
        works from first deploy without
        admin intervention.
      - LoyaltyPromosTab.tsx (443 lines) and
        LoyaltyPromoFormModal.tsx (369 lines)
        deleted. Single source of truth for
        promo admin is now /loyalty/admin?tab=promotions.
        Promotions menu page (/promotions)
        kept its other 3 tabs (Promos /
        Categories / Announcements) but
        dropped the Loyalty Promos tab.
      - Audit instrumentation: 3 new
        entity_types (loyalty_promo /
        loyalty_reward / loyalty_banner)
        written on every create / update /
        delete via the admin hooks.
    Phase 3.2 — Catalog Redemption Wiring (LIVE 2026-05-01)
      - Schema:
          loyalty_redemptions.reward_id uuid
            REFERENCES loyalty_rewards(id)
            ON DELETE SET NULL
          idx_loyalty_redemptions_reward_id
          loyalty_redemption_type enum
            extended with 'catalog_reward'
            (4th value alongside the 3
            legacy types).
      - process-loyalty-redemption changes
        (commit f632b5c):
          create action accepts reward_id;
          when reward_id is set,
          redemption_type defaults to
          'catalog_reward' and
          invoice_number is optional.
          Validates the reward exists,
          is_active, current_stock > 0
          (or NULL = unlimited), and
          points_redeemed === points_cost.
          Inserts the redemption row with
          a placeholder invoice_number
          'REDEEM-PENDING' (NOT NULL
          constraint preserved) then
          immediately UPDATEs to
          REDEEM-${redemption.id} so each
          catalog redemption has a 1:1
          stable forensic identifier.
          approve action does an atomic
          UPDATE … SET current_stock =
          current_stock - 1 WHERE id = $1
          AND current_stock > 0 (race-free
          decrement). If the WHERE clause
          fails to match (a parallel
          approval drained the last unit
          first) the function returns 409
          with stock_race: true and the
          redemption stays pending so
          staff can cancel it explicitly.
          On success, writes an
          audit_logs entry with
          entity_type='loyalty_reward',
          action='stock_decremented'.
          cancel action carries a TODO
          for Phase 3.2.1 — re-incrementing
          stock when an already-approved
          catalog redemption is voided.
      - Customer portal RewardsScreen real
        flow (commit ace3c6a):
          handleRedeem replaced (was a
          stub) with a real call to
          process-loyalty-redemption
          action='create'. Pattern-matched
          error toasts: 409 → "sold out",
          config-mismatch → "config
          changed, refresh the catalog",
          insufficient-points →
          "Insufficient points".
          Modal carries an optional
          invoice_number input and a
          three-state Confirm button (Out
          of Stock / Insufficient Points /
          Confirm Redemption with spinner).
          Stock badges: "Out of stock"
          (red) when current_stock = 0,
          "Only X left" (amber) when
          current_stock between 1 and 5.
          Success copy is now "Redemption
          Submitted!" + "pending admin
          approval" — no more "Redemption
          Successful" claim before the
          approval step.
          inStock(reward) helper centralizes
          the unlimited / 0 / >0 check.
          rowToReward adapter propagates
          current_stock onto the
          FallbackReward shape via a new
          optional currentStock?: number |
          null field on the type.
      - Anon RLS policies (applied via
        SQL Editor):
          loyalty_rewards anon SELECT
            WHERE is_active = true
          loyalty_banners anon SELECT
            WHERE is_active = true
          Customer portal uses token-
          based auth (anonymous to
          Supabase) so the prior
          authenticated-only policies
          blocked customers from reading
          either table once the portal
          was switched to DB-driven
          rewards/banners in Phase 3.
    Phase 3.2.1 — Cancel/Void Approved Redemption (LIVE 2026-05-08)
      - Admin can reverse a confirmed
        redemption via "Void Redemption"
        button in RedemptionApprovalModal.
        Closes the gap where confirmed
        redemptions had no recovery path —
        previously required manual SQL.
      - Atomic backend operation in
        process-loyalty-redemption new
        action='void' branch:
          1. Refund points — INSERT new
             loyalty_transactions row with
             transaction_type='refunded'
             (new enum value, see
             TODAY'S DATA FIXES 2026-05-08)
             and positive points_amount
             matching the original debit.
             notes field carries the
             original transaction_id for
             forensic linkage.
          2. UPDATE loyalty_redemptions —
             status='cancelled',
             cancelled_at, cancelled_by,
             cancellation_reason. Race-
             safe via WHERE id=X AND
             status='confirmed'; concurrent
             void attempts get 409 after
             rolling back the refund tx.
          3. UPDATE loyalty_members —
             remaining_points += N,
             total_points_redeemed -= N
             (clamped at 0 for sanity).
          4. Re-increment
             loyalty_rewards.current_stock
             for catalog rewards. Skip
             silently for unlimited
             (current_stock NULL); warn-
             and-continue if reward row
             missing.
          5. audit_logs entry
             (action='redemption_voided',
             stock_re_incremented flag,
             refund_transaction_id).
          6. Phase 4.2 cancellation
             notification emit (reuses
             existing
             buildRedemptionCancelledNotification
             + emitNotification).
      - Frontend: extended
        RedemptionApprovalModal with
        state-aware rendering:
          status='confirmed' AND admin →
          green Confirmed banner + "Void
          Redemption" destructive button
          + Close.
          showVoidInput=true → reason
          textarea (rows=3, maxLength=500)
          + Back + Confirm Void
          (aria-busy={voiding},
          variant=destructive).
          status='cancelled' → gray
          banner with cancelled_at +
          cancellation_reason + Close.
          status='confirmed' AND
          NOT admin → green banner +
          Close only (read-only).
      - Status enum reused (no schema
        change). New 'refunded' value
        added to loyalty_transaction_type
        enum (ALTER TYPE applied via SQL
        Editor). Action whitelist updated
        to include 'void' alongside
        create/approve/cancel — closes a
        latent regression from C2 commit
        203b654 (the void branch was
        unreachable until this fix; see
        Bug #90).
      - resolvePortalAuth wiring also
        added to the same edge function
        in this session — closes Phase B
        Step 3f-2 gap where this function
        was missed in the original
        7-function rewire on 2026-05-05.
        See Bug #89.
      - Smoke test PASSED end-to-end on
        2026-05-08:
          customer redeem (200-pt
          Birthday Bonus) → admin
          approve → admin void.
        Verified all 5 expected DB
        changes:
          loyalty_redemptions.status =
            'cancelled' + cancelled_at +
            cancellation_reason populated
          loyalty_members.remaining_points
            restored to original
          loyalty_transactions: new row
            with type='refunded',
            positive points_amount
          audit_logs: action=
            'redemption_voided' row
          Customer's NotificationsScreen:
            cancellation card visible
      - Known limitation — email
        asymmetry. Approve flow sends
        both transactional email (via
        send-transactional-email) AND
        in-portal notification. Void flow
        sends only the in-portal
        notification. Customer experience
        is asymmetric until the "Void
        email notification" PENDING item
        ships (see PENDING ITEMS LOYALTY
        ADMIN PORTAL phased-build
        tracker — small standalone fix,
        ~2 hrs, does not depend on
        Phase 6).

    Phase 3.1 — Bonus Multiplier Wiring (LIVE 2026-05-01)
      - Promos can apply a multiplier
        override in addition to flat
        bonus_points. Both fields can be
        set on the same promo (no mutex);
        either or both can be neutral
        (1.00 / 0).
      - Schema (commit referenced under
        TODAY'S DATA FIXES 2026-05-01):
          ALTER TABLE loyalty_promos
            ADD COLUMN bonus_multiplier
              numeric(5,2) NOT NULL
              DEFAULT 1.00
              CHECK (bonus_multiplier >= 1.00);
        Existing rows backfilled to 1.00
        (neutral). DB-level CHECK blocks
        negative or fractional-discount
        promos.
      - Strategy B (multiply): tier
        multiplier and promo multiplier
        stack multiplicatively. Crown VIP
        (3x) member during a 3x promo
        earns 9x base. The tier ladder
        keeps its meaning during promos
        — Glimmer (1x) × 3x promo = 3x,
        still less than Crown VIP × 3x.
      - Edge function calculation
        (commit 069d7ac in
        supabase/functions/award-loyalty-points):
          baseUnits  = floor(jpy/10000)
          earnedTx   = baseUnits × 100
                       × tier_multiplier
          delta      = earnedTx
                       × (promo_mult - 1)
          flatBonus  = activePromo
                       .bonus_points
          bonusTx    = delta + flatBonus
          memberTotal = earnedTx + bonusTx
        Bonus tx skipped when bonusTx = 0
        (no-op promo, e.g. mult=1.00 +
        bonus=0). Bonus tx notes string
        documents which fields contributed:
        "Multiplier promo (delta: X) +
        flat bonus (Y)" / "Multiplier
        promo (delta: X)" / "Flat bonus
        (Y)". Promo linkage preserved
        via promo_id column.
      - max_per_customer cap counts bonus
        tx rows per (member, promo) —
        unchanged. Each promo fire still
        writes one bonus tx, so cap
        behavior is identical for
        flat-only, multiplier-only, and
        combined promos.
      - Email payload (loyalty-bonus
        template) sends bonusTxPoints
        (delta + flat) so customers see
        the promo's full impact rather
        than just the flat portion.
      - Admin UI:
          PromoEditDialog (commit 9a9d7f5):
            side-by-side bonus_points +
            bonus_multiplier inputs.
            Multiplier accepts 1.00–99.99
            with step 0.01. Helper text
            under each input ("Flat bonus
            points added on top. Leave at
            0 to skip flat bonus." /
            "Multiplier (1.0 = no boost).
            Stacks with tier multiplier.").
            Validation rejects < 1.00 and
            > 99.99 with explanatory
            messages. max_per_customer
            moved to its own row.
          PromotionsTab (commit 35ea1a9):
            new BonusField cell renders
            a solid-primary "{N}x Bonus"
            badge when multiplier > 1
            and a "+N pts" text when
            bonus_points > 0; both
            inline when both apply.
            Tooltip on the badge
            ("Multiplier stacks on top
            of the member's tier
            multiplier.") explains tier
            stacking. fmtMultiplier
            strips trailing zeros so
            3.00 → "3x", 2.50 → "2.5x",
            1.27 → "1.27x".
      - useLoyaltyPromosAdmin types
        updated: bonus_multiplier:number
        on LoyaltyPromoRow,
        bonus_multiplier?:number on
        CreatePromoInput. Insert payload
        sets `?? 1` fallback; SELECT
        projection includes the new
        column. UPDATE path passes
        through partial input.updates
        unchanged.
    Phase 3.5 — Image Upload to Storage (LIVE 2026-05-03)
      - Replaced the paste-image-URL flow
        with a real Supabase Storage upload
        UI across all 3 loyalty admin
        dialogs: PromoEditDialog,
        RewardEditDialog, BannerEditDialog.
      - New storage bucket: loyalty-images
          public = true (anon read for
            customer portal — same pattern
            as the promotions bucket and
            the Phase 3.2 anon RLS on
            loyalty_rewards / banners)
          file_size_limit = 5_242_880
            (5 MB) enforced at storage
            layer
          allowed_mime_types =
            {image/jpeg, image/png,
             image/webp}
        Bucket-level constraints back up
        the client-side validation.
      - 4 RLS policies on storage.objects
        scoped to bucket_id =
        'loyalty-images':
          SELECT  → anon, authenticated
          INSERT  → admin OR finance
          UPDATE  → admin OR finance
          DELETE  → admin OR finance
        Tighter than the promotions
        bucket precedent (admin+staff) —
        loyalty content stays in the
        admin/finance domain.
      - New shared component
        (commit 27b1f2b):
        src/components/loyalty-admin/ImageUploadField.tsx
          Click-to-browse + drag-and-drop
          drop zone (empty state) or
          80×80 thumbnail with Replace +
          Remove buttons (filled state).
          Loading spinner overlays both
          states during upload. Inline
          error text + sonner toast on
          rejection.
          Client validation: mime in
          {jpeg,png,webp} and size ≤ 5 MB
          before any upload attempt.
          Filename pattern:
            ${entity}-${crypto.randomUUID()}-${Date.now()}.${ext}
          Stored flat in the bucket root.
          Extension derived from filename
          with mime-type fallback when
          missing.
          Returns the public URL via
          supabase.storage.getPublicUrl
          and writes it to image_url via
          the onChange callback.
          Fire-and-forget delete on
          Replace and on Remove. Scoped
          via regex against
          /storage/v1/object/public/loyalty-images/
          so legacy paste URLs (and any
          external URLs) are never
          touched — only files we own
          get cleaned up.
          Drag handlers preventDefault
          + stopPropagation on the
          three drag events so dropping
          a file outside the zone does
          not navigate the page.
      - Wired into 3 dialogs (commits
        5194de7 / 39aea4d / 7b8eafd):
          PromoEditDialog,
          RewardEditDialog,
          BannerEditDialog.
        Boundary conversions preserve
        the existing
        FormState.image_url:string
        contract:
          value:    form.image_url || null
          onChange: (url) => image_url:
                    url ?? ''
        formToInput's empty-to-null logic
        on each dialog continues to map
        empty strings back to null on
        save, so the image_url database
        column shape is unchanged.
        BannerEditDialog's existing
        live preview pane reads
        form.image_url directly and
        continues to work unmodified —
        the boundary conversion keeps
        that string populated whenever
        a URL is set.
        Layout adjustment in
        BannerEditDialog: image_url and
        emoji were paired in a 2-col
        grid; the new ImageUploadField
        is much taller than a single
        Input, so the pair was split
        into two stacked full-width
        rows. Promo and Reward dialogs
        kept their original full-width
        Image row.
        Label text on all 3 dialogs
        renamed from "Image URL
        (optional)" to "Image (optional)"
        — no longer a URL paste.
      - Phase 3 series complete — full
        content management end-to-end.
    Phase 4 — Communications/Notifications (LIVE 2026-05-04)
      - Manual admin broadcast notifications
        to loyalty members. Auto-triggered
        notifications (points / order /
        milestone / etc.) deferred to Phase
        4.2.
      - 6 admin-pickable categories: info /
        promo / tier / system / reward /
        birthday. Customer-side icon mapping
        retains all 12 prior categories so
        future Phase 4.2 auto-trigger types
        render with the right icon when they
        land.
      - 3 audience modes: 'all' (every
        enrolled loyalty_members row),
        'tier' (JOIN audience_tiers names →
        loyalty_tiers.id → members.current_tier_id),
        'specific' (audience_member_ids
        array passthrough).
      - Schedule for future send. Hourly
        cron (loyalty-notification-queue,
        jobid=19, '0 * * * *' UTC) picks up
        rows where status='scheduled' AND
        scheduled_for <= now(), atomically
        locks status → 'sending' to prevent
        double-send across overlapping
        ticks, then runs the same fan-out
        as the synchronous path.
      - Optional per-notification email
        side-fire gated by the per-row
        send_email toggle AND the global
        system_settings.loyalty_email_broadcast
        setting (default true). Email loop
        runs in EdgeRuntime.waitUntil
        background so the response returns
        promptly even on 464-member
        broadcasts. Per-recipient portal
        URL built from a single batched
        customer_portal_tokens lookup.
      - Read state per recipient with
        mark-as-read (single) and
        mark-all-read endpoints. Customer
        portal NotificationsScreen does
        optimistic flips on click with
        rollback on error.

      Schema:
      - loyalty_notifications (master, 17 cols)
          id, title, body, category, audience_type,
          audience_tiers, audience_member_ids,
          link_target, status, scheduled_for,
          sent_at, expires_at, send_email,
          email_sent, created_by_user_id,
          created_at, updated_at.
        Status flow: draft → scheduled →
          sending → sent (or cancelled /
          failed). CHECK constraint widened
          from 4 to 6 values.
        audience_member_ids[] is ephemeral —
          NULLed post-send so the recipients
          table becomes the truth.
        email_sent boolean tracks whether
          the email side-fire actually ran
          (set true at the end of the
          background email loop; useful for
          audit + retry diagnostics).
      - loyalty_notification_recipients
        (per-member delivery + read state,
        6 cols)
          id, notification_id, member_id,
          is_read, read_at, created_at.
        UNIQUE (notification_id, member_id)
          prevents double fan-out on retry.
        4 indexes including 2 partials:
          idx_loyalty_notification_recipients_member_created
            for portal listing
          idx_loyalty_notification_recipients_member_unread
            (WHERE is_read=false) for unread
            count
          idx_loyalty_notifications_status_scheduled
            (WHERE status='scheduled') for
            queue processor
          idx_loyalty_notifications_status_created
            for admin list

      Edge functions (4 new + 1 extended):
      - send-loyalty-notification
        (synchronous fan-out, admin/finance
         JWT auth, validates body, persists
         master row, resolves audience,
         bulk-inserts recipients, fires
         email side-fire in background,
         writes audit_logs)
      - mark-loyalty-notification-read
        (token-auth via resolvePortalAuth,
         mode='single' OR mode='all',
         service_role bypasses RLS for the
         updates, idempotent on already-read
         rows)
      - process-loyalty-notification-queue
        (service_role JWT only, hourly cron
         picks up overdue scheduled rows,
         atomic check-and-update lock,
         per-iteration try/catch so one bad
         row doesn't abort the batch,
         terminal 'failed' status on error
         with audit_logs entry)
      - customer-portal extended to return
        notifications array (max 100, sent +
        not-expired, ordered created_at
        DESC) + unread_count

      Email template:
      - loyalty-broadcast template at
        supabase/functions/_shared/transactional-email-templates/
          loyalty-broadcast.tsx
        with memberFirstName,
        notificationTitle, notificationBody,
        ctaUrl. Mirrors the loyalty-welcome
        layout (gold header bar, brand text,
        h1, greeting, body, optional CTA
        button, footer). Registered in
        registry.ts.
      - Loyalty email gate
        (LOYALTY_EMAIL_KEYS) extended with
        the 9th key 'loyalty_email_broadcast'.

      Hooks (src/hooks/loyalty-admin/useLoyaltyNotifications.ts):
      - useLoyaltyNotifications(filters)
        admin list with stats joined
        client-side. refetchOnWindowFocus
        per Q3.
      - useLoyaltyNotificationStats(id)
        per-notification stats — total /
        read_count / read_rate / email_sent /
        email_pending. Three parallel count
        queries.
      - useSendNotification,
        useUpdateNotification,
        useCancelNotification — mutations
        wired to the edge function (send /
        update) or direct RLS-permitted
        UPDATE (cancel) with audit_logs
        entry.
      - useLoyaltyMembersForAudience for the
        Specific audience picker, 5-min
        staleTime.
      - useTierList returns the 4 hardcoded
        tier names; TIERS const + Tier type
        also exported.

      UI:
      - NotificationsTab admin component as
        the 11th tab in LoyaltyAdmin
        (xl:grid-cols-11). Card grid with
        status / category badges, audience
        labels, stats panel for sent rows
        (recipients / read / read rate %),
        timestamps (Created / Scheduled /
        Sent / Expires), and per-status
        action buttons (Edit on draft /
        scheduled, Edit + Cancel on
        scheduled, View on sent / cancelled /
        failed). Empty state, loading
        skeletons, and AlertDialog confirm
        on cancel.
      - NotificationComposeDialog with
        title / body char counters, category
        select, audience radio + conditional
        sub-pickers (tier checkboxes or
        member search), link target
        (none / portal tab / external URL),
        schedule radio (now / future
        datetime), email toggle with global
        gate state, expiry collapsible.
        Edit mode pre-fills the form;
        editLocked banner blocks interaction
        when status is sent / sending /
        cancelled / failed. AlertDialog
        confirm before send/schedule
        showing audience + send time + email
        status.
      - NotificationsScreen.tsx (customer
        portal) replaced staticFallback with
        real DB-driven array. PHT-aware
        date grouping (Today / Yesterday /
        "Mon DD"). Optimistic mark-as-read
        with rollback. Link target dispatch
        — tab:foo → onSetTab; https:// →
        window.open. Bottom-nav
        unreadCount wired to data.unread_count.

      System settings:
      - loyalty_email_broadcast (default
        true) seeded in C1 SQL. Admin can
        flip from the Settings tab to
        globally suppress notification
        emails without disabling the
        per-row toggle UI.

      Cron:
      - jobid=19 in pg_cron, scheduled
        '0 * * * *' (top of every hour
        UTC). Calls
        process-loyalty-notification-queue
        with the service_role JWT
        Authorization header (vault-fetched
        in the cron command body, so the
        JWT isn't hardcoded in the
        schedule).
    Phase 4 polish (LIVE 2026-05-04)
      - Sent / cancelled / failed
        notifications are immutable history.
        New "Duplicate" action button on
        those terminal-state cards (gold
        primary, alongside View) opens
        NotificationComposeDialog
        pre-filled with the source row's
        content but treated as a fresh
        send — original history preserved.
      - NotificationComposeDialog accepts a
        new optional prop:
          mode?: 'create' | 'edit' | 'duplicate'
        defaulting to 'edit' when
        notification is set, 'create'
        otherwise. Backwards-compatible
        with prior call sites.
      - Duplicate-mode pre-fill carries
        title / body / category /
        audience_type / audience_tiers /
        send_email. Clears scheduled_for,
        expires_at, and audience_member_ids
        so admin re-picks anything
        time-sensitive. (audience_member_ids
        is NULLed post-send per the Q9
        ephemeral rule — there's nothing
        to preserve anyway.)
      - When source had audience_type
        ='specific', a toast.info on
        dialog open prompts:
        "Audience type carried over —
        re-pick the specific members
        before sending." Forces the admin
        to re-confirm members; the picker
        opens with an empty selection.
      - editLocked banner is skipped in
        duplicate mode — duplicate is a
        fresh insert, so the source's
        terminal status doesn't lock the
        form. isEditMode (true only in
        'edit') gates the notification_id
        passing to the mutation, so
        duplicate uses useSendNotification
        like create.
      - Per-status action matrix on
        NotificationsTab cards:
          draft     → Edit
          scheduled → Edit + Cancel
          sending   → View only
          sent      → View + Duplicate
          cancelled → View + Duplicate
          failed    → View + Duplicate
      - Modal stacking bug fixed in the
        same session: the original
        compose-and-confirm flow used a
        nested AlertDialog inside the
        Dialog, which stacked two
        bg-black/80 overlays (near-opaque
        backdrop) and trapped Confirm
        button clicks at the upper
        portal. Refactored to a single
        Dialog with a two-view toggle
        (showConfirm boolean state) —
        same DialogContent renders form
        OR confirmation summary panel
        based on the flag. Footer
        buttons swap with the view
        (Cancel + Send/Schedule on form;
        Back + Confirm on summary).
        Error path keeps the confirm
        view open so admin can retry
        without re-filling the form.
    Phase 4.2 — Auto-trigger Notifications (LIVE 2026-05-07)
      - Instrumented 3 existing edge
        functions to emit in-portal
        notifications on loyalty events.
        No new edge functions — sidesteps
        the workflow path-filter .added
        bug.
      - Direct DB INSERT pattern (no edge
        fn HTTP roundtrip). Sub-millisecond
        and atomic with the parent
        operation.
      - send_email=false on all
        auto-triggers. The existing
        transactional email gates
        (loyalty_email_earned, _bonus,
        _tier_upgrade, _redeem,
        _pre_expire, _expire_deduct,
        _tier_downgrade) already cover the
        email channel for these events;
        notifications are the in-portal
        complement. Doubling up would
        double-email customers.
      - try/catch wrap on every emit via
        the shared helper — parent
        operation never fails on
        notification error.

      CHECK constraint widened from 6 → 11
      categories:
        Phase 4 admin-pickable: info /
          promo / tier / system / reward /
          birthday
        Phase 4.2 auto-trigger: points /
          redemption / order / expiry /
          milestone (milestone schema-only,
          emit logic deferred to 4.2.1).

      Shared helpers (NEW):
        _shared/loyalty-notification-templates.ts
          - 8 pure template builders:
            buildWelcomeNotification,
            buildPointsEarnedNotification,
            buildTierUpgradeNotification,
            buildTierDowngradeNotification,
            buildRedemptionApprovedNotification,
            buildRedemptionCancelledNotification,
            buildPreExpiryNotification,
            buildExpiryFiredNotification.
          - Each returns { title, body }
            with title ≤ 100 chars, body ≤
            500 chars enforced via the local
            truncate('…') helper, matching
            the loyalty_notifications CHECK
            constraints.
          - Defensive: rewardName capped at
            80 chars; cancellation reason
            capped at 300; fmt() returns
            '0' for NaN/Infinity.
          - TIER_MULTIPLIERS map embedded
            (Glimmer 1, Radiant 2, Elite 2,
            Crown VIP 3) — kept in sync
            with loyalty_tiers seed.
        _shared/emit-notification.ts
          - emitNotification(supabase,
            member_id, args) — fire-and-
            forget helper.
          - Two INSERTs per call:
            loyalty_notifications (master,
            status='sent', sent_at=now,
            audience_type='specific',
            audience_member_ids=null,
            send_email=false,
            email_sent=false,
            created_by_user_id=null) +
            loyalty_notification_recipients
            (single row, is_read=false).
          - Defensive validation: empty
            member_id → warn+return;
            invalid category → warn+return.
          - All failure paths log with the
            '[loyalty-notify]' prefix
            (greppable in Supabase function
            logs). NEVER throws.
          - Orphaned-master semantics on
            partial failure: customer-portal's
            INNER JOIN on recipients hides
            orphans from customers; admin
            tab shows 0 recipients as the
            failure signal.

      award-loyalty-points emits
      (commit 33240b3):
        - Welcome (first-ever award; prev
          total_points_earned === 0) —
          category 'order', link tab:home.
          isFirstAward derived from the
          local `member` object's pre-update
          state (line 240 UPDATE doesn't
          mutate the local).
        - Points earned (every successful
          award) — category 'points', link
          tab:points. Body shows totalAdded
          (earned + bonus) and the invoice
          number.
        - Tier upgrade (when tierUpgraded ===
          true at line 222) — category
          'tier', link tab:home.
        Customer fetch hoisted out of the
        email try/catch so notifications
        reuse `customer` for firstName
        without a second round-trip; fetch
        wrapped in its own micro try/catch
        so failure leaves customer=null and
        firstName falls back to "there".
        All three emits sequentially
        awaited before function return so
        Edge Runtime termination doesn't
        drop inserts.

      process-loyalty-redemption emits
      (commit 6d27b1c):
        - Redemption approved (normal path,
          before success return) — category
          'redemption', link tab:points.
        - Redemption approved (stock-race-
          loss path, before the 409 return).
          Points are already debited at
          this point so the customer needs
          to see the redemption in their
          portal even though admin will
          manually cancel/refund afterward.
        - Redemption cancelled (with admin
          cancellation_reason in body) —
          category 'redemption', link
          tab:points.
        Reward name resolution via shared
        resolveRewardName helper:
          - Catalog rewards (reward_id set)
            fetch loyalty_rewards.name.
          - Non-catalog (3 legacy enum
            types) map to humanized labels
            via REDEMPTION_TYPE_LABELS
            ('New order discount' /
            'Shipping fee' / 'Service fee').
          - Final fallback "Your reward".
        Cancel branch SELECT widened from
        ('id, status') to include
        ('member_id, reward_id,
        redemption_type, points_redeemed')
        — needed by both resolveRewardName
        and emitNotification.

      loyalty-inactivity-check emits
      (commit 1ac5fd7):
        - Pre-expiry warning — category
          'expiry', link tab:points.
          Inside the same if (needsWarn)
          gate as the pre-expire email,
          AFTER the pre_expiry_warned_at
          UPDATE succeeds, so the
          notification respects the
          WARNING_REPEAT_COOLDOWN_DAYS
          cooldown and a failed update
          can't leave the customer
          notified-but-not-tracked.
        - Expiry fired — category 'expiry',
          link tab:points. Body shows the
          pointsLost. Always emitted when
          daysSinceLast >= INACTIVITY_DAYS.
        - Tier downgrade — category 'tier',
          link tab:home. Twin emit when
          expiry causes a downgrade
          (tierChanged === true). Plus
          standalone emission in the
          gap-too-big branch. The two
          paths are mutually exclusive
          because expiry uses `continue`
          to skip the standalone
          downgrade branch.

      Scope correction from spec:
        Originally 4 functions; reduced to
        3. review-payment-submission
        delegates to award-loyalty-points
        on the DP-confirm path (line 761);
        instrumenting award covers
        DP-confirm, cash-order-complete,
        and any future trigger of award.
        Single source of truth.
    Phase 3.1.1 — Customer portal "Nx Bonus" badge (LIVE 2026-05-08)
      - Gold-gradient chip beside the
        existing tier multiplier chip on
        MemberCard's Home-tab header.
        Surfaces the currently-active
        multiplier promo to customers in
        real time so they can see they're
        in a 2x/3x/etc earning window
        without admin having to broadcast.
      - Resolution mirrors
        award-loyalty-points selection
        EXACTLY so the badge represents
        what the customer would actually
        earn:
          1. Date window — is_active=true
             AND today between start_date
             and end_date.
          2. Tier match — applicable_tiers
             null/empty OR includes the
             member's current tier name.
          3. Cap remaining — bonus tx
             count for (member_id,
             promo_id) <
             max_per_customer.
          4. NEW Phase 3.1.1 filter —
             bonus_multiplier > 1.00.
             Flat bonus_points-only
             promos don't surface the
             chip because there's nothing
             to multiply; they still
             fire as bonuses, just no
             "Nx" messaging.
        On any cap-query failure: fail-
        closed (don't show a badge we
        can't validate). Outer try/catch
        ensures unexpected errors keep
        activePromo=null and never block
        the rest of the portal payload.
        All failure paths log with
        '[customer-portal]' prefix
        (greppable in Supabase function
        logs alongside the Phase 4 C5
        notifications-query logging).
      - customer-portal payload extended
        (commit ced71e4):
          active_promo: {
            bonus_multiplier: number,
            name: string,
            end_date: string  // YYYY-MM-DD
          } | null
        Fields chosen for what the badge
        actually displays. id +
        applicable_tiers omitted —
        deferred to a future 3.1.2
        if/when the badge needs to
        deep-link to a details modal or
        show "Crown VIP only" qualifier
        text.
      - Frontend wiring (commits f7e403d
        + eb786d8):
          loyaltyData.ts store:
            New exported
            LoyaltyActivePromoData type +
            activePromo:
            LoyaltyActivePromoData | null
            field on the snapshot.
            setLoyaltyData() signature
            extended with an optional 4th
            arg (defaults to null —
            backwards-compatible).
            Identity-equality short-
            circuit extended so listeners
            re-render only when the
            promo state actually changes
            (e.g., the next refetch
            returns null after the promo
            ends).
          LoyaltyPortal.tsx:
            PortalData.active_promo?
            optional field. The existing
            setLoyaltyData call now
            passes data.active_promo ??
            null as the 4th arg. No new
            effect — runs on the same
            cadence as the existing
            tiers/transactions plumbing,
            including refetchOnWindowFocus
            from Phase 4.
      - MemberCard.tsx UI (commit
        282c4c4):
          Tier chip wrapped in a flex
          container with gap-2; the
          conditional promo chip sits
          beside it. When activePromo is
          null, the wrapper collapses to
          a single chip — no layout
          shift, no empty placeholder.
          Promo chip styling: bright
          saturated gold gradient
          (linear-gradient(135deg,
          hsla(45,90%,55%,0.95) →
          hsla(45,100%,65%,0.95))) +
          0 0 12px hsla(45,90%,55%,0.4)
          glow boxShadow for the
          limited-time feel. Dark
          hsl(36,80%,15%) icon + text
          for max contrast against the
          bright gradient. Sparkles
          icon (lucide-react) —
          deliberately distinct from
          TrendingUp on the tier chip
          so the two chips read as
          separate facts rather than
          duplicates of each other.
          Browser-native title tooltip
          shows promo name + friendly
          end date (e.g. "Spring 3x
          Weekend — ends May 12,
          2026"). Long-press surfaces
          it on iOS Safari.
          fmtMultiplier helper inlined
          (parseFloat(toFixed(2)).toString)
          to strip trailing zeros: 3.00
          → "3", 2.50 → "2.5", 1.27 →
          "1.27". Same logic as the
          admin-portal helper in
          PromotionsTab.tsx; duplicated
          locally to avoid coupling the
          customer portal to admin-
          portal helpers — promote to
          a shared util when a third
          caller appears.
          fmtEndDate helper anchors
          the YYYY-MM-DD parse at local
          noon (`+ "T12:00:00"`) so the
          timezone difference between
          UTC and the customer's locale
          never shifts the displayed
          day backwards. Same defense
          pattern as the PHT helpers in
          date-utils.ts.
      - No click action — informational
        only. A future Phase 3.1.2
        could add a tap-to-details
        modal and surface tier-specific
        qualifier text if customer
        feedback warrants it.
      - No SQL changes. Phase 3.1
        already shipped the
        bonus_multiplier column with
        the >= 1.00 CHECK; the
        Phase 3.1.1 schema follow-up
        (CHECK widening for
        multiplier-only promos) is a
        separate, narrowly-scoped
        constraint adjustment recorded
        under TODAY'S DATA FIXES
        (2026-05-08).
    Phase 3.5.1 — Orphan Image Cleanup (LIVE 2026-05-07)
      - cleanup-loyalty-images edge
        function runs weekly to clean
        orphaned images in the
        loyalty-images bucket. Detects
        images NOT referenced by any
        loyalty_promos / loyalty_rewards /
        loyalty_banners image_url field.
      - Schedule: Sunday 03:00 UTC
        (11:00 AM PHT) — jobid 20.
      - Service role auth (verified —
        rejects non-service-role callers
        with 403). Calls authorized via
        email_queue_service_role_key from
        vault per Lovable Option 1 —
        same key the 3 sibling crons
        (16/17/19) were repointed to in
        the same session.
      - Dry-run by default via
        system_settings.cleanup_loyalty_images_dry_run
        (default true). Manual override
        per-invocation via
        ?dry_run=true|false query param.
        Plan to flip to false after the
        first 1-2 weekly runs are
        reviewed.
      - Hard cap = 50 deletes per run.
        If exceeded, function halts
        without deleting and writes a
        'cleanup_halted' audit row.
        Manual investigation required
        before flipping the dry-run flag
        off in any case where the cap is
        approached.
      - Audit log per run with sentinel
        entity_id
        00000000-0000-0000-0000-0000000000a2
        (Phase 2 pattern; a1 is
        loyalty_settings, a2
        distinguishes loyalty_images_cleanup),
        entity_type 'loyalty_images_cleanup',
        action 'cleanup_dry_run' /
        'cleanup_run' / 'cleanup_halted'.
        new_value_json carries
        files_scanned / orphans_detected /
        files_deleted / dry_run /
        safety_cap_hit / cap / elapsed_ms.
      - Filename matching via the
        loyaltyImagesPath helper (lifted
        in C2 to
        _shared/loyalty-images-path.ts +
        src/lib/loyalty-images-path.ts —
        same dual-file convention as
        portal-link.ts and portal-auth.ts;
        cross-reference comment in each
        twin flags drift). URLs that
        don't match the bucket pattern
        (legacy paste-only externals)
        correctly drop out — they're not
        in the bucket either, so they
        can't be orphans.
      - Smoke test passed end-to-end:
        200 OK in ~205 ms, 0 orphans
        detected (empty bucket at smoke
        time), audit row written.

  ### 2026-04-30 — Session shipped

  Six commits to main, zero rollbacks. Audit pool 683 audited /
  684 in scope / 1 excluded (INV #18857) / 0 failing.

  - e28cf60 — Dashboard restructure to account-counts-only +
    Finance gap-fill cards (Cash Revenue Today + Total Overdue).
    get_aging_buckets(p_scope) RPC deployed. AgingBuckets
    variant=count + scope toggle. Bug #67 logged.

  - 76c9d3a — audit_skipped state for newly-created accounts.
    audit_account() and audit_all_accounts() RPCs updated to
    skip accounts where total_paid=0 AND no allocations.
    Frontend AccountDetail Check Health modal handles new
    response shape. Bug #68 logged.

  - c26ec78 — partially_paid semantics doc fix + audit_account
    Check 12 services double-count fix + currency toggle status
    logged. CLAUDE.md PAYMENT ALLOCATION RULES section updated
    to reflect actual runtime (full-owed semantic, not
    shortfall). Bugs #71 and #72 logged. reconcile_failing_accounts()
    Cartesian product bug fixed in same session via SQL Editor
    (bug #69). TEST-004 audit drift healed via manual SQL
    UPDATE (bug #70).

  - fff86ce — INVARIANT 2 migration to schedule_with_actuals
    across 3 surfaces:
    - get_forecast_6m() RPC migrated
    - dashboard-summary edge function 5 cache-read sites migrated
    - get_forecast_drilldown(p_month) RPC created (server-side
      join pattern matching get_aging_buckets() — avoids URL-length
      risk)
    - Finance.tsx forecast drilldown migrated to use new RPC
    Bug #73 logged. INV #18531 ₱1,000 cumulative cache
    overstatement eliminated (cache 65,186 → canonical 64,186).

  ### 2026-05-01 — PWA Phase A Step 2 deployed (infrastructure)

  Backend infrastructure for portal session redemption deployed.
  Both new edge function and shared helper are DORMANT — no
  existing code path calls them yet. Step 3 will wire them in.

  - New edge function: redeem-portal-token
    POST { token } → { session_id, customer_id, expires_at }
    Validates token via customer_portal_tokens.is_active
    Creates row in customer_portal_sessions
    Captures user-agent and IP for audit
    Auto-deploys via GitHub Actions

  - New shared helper: supabase/functions/_shared/portal-auth.ts
    Exports resolvePortalAuth(supabase, { token?, portal_token?, session_id? })
    Returns { customer_id, source_token_id, session_id?, via: 'session' | 'token' }
    Accepts both 'token' and 'portal_token' field names
    (handles historical inconsistency across the 7 portal
    edge functions)
    Updates last_used_at on session validation (fire-and-forget)
    Throws structured error messages on auth failure

  Step 1 (SQL Editor, today) created customer_portal_sessions
  table with FK CASCADE to customers and customer_portal_tokens.
  Step 3 (next session) will wire 7 portal edge functions to use
  resolvePortalAuth, update 3 frontend pages to redeem on first
  mount, add /launch route, change manifest start_url, and
  recreate InstallAppBanner gated to TEST-% accounts.

  No customer-facing impact from Step 2 alone. Token-based auth
  flow unchanged.

  ### 2026-05-01 — PWA Phase A Step 3a-1 deployed (3 of 7 functions)

  First batch of portal edge function wiring. Three simplest
  functions now accept session_id alongside legacy token via
  the resolvePortalAuth helper.

  Functions wired in this commit:
    - join-loyalty-program
    - submit-payment
    - edit-payment-submission

  Workflow gap closed: edit-payment-submission added to
  auto-deploy path filter and deploy step.

  Length pre-check removed: submit-payment line ~37
  (token.length < 16 would have rejected session_ids).
  Same pre-check also removed from join-loyalty-program
  for the same reason (spec said only submit-payment but
  join-loyalty-program had the identical guard at line 29
  that would have blocked session_id-only calls).

  edit-payment-submission presence check loosened: the
  guard `if (!portal_token || !submission_id)` would have
  rejected session-only callers. Replaced with
  `if (!submission_id)` since resolvePortalAuth handles
  the auth-side missing-credentials case.

  Backwards compatible — existing token-based callers see no
  change. No customer impact (frontend hasn't changed).

  Known follow-ups for Step 3b:
    - join-loyalty-program welcome email URL embeds
      portal_token at line ~125. When a session-only call
      reaches this function (after Step 3b ships), the URL
      becomes ?token=undefined. Step 3b should either look
      up the customer's active token for the email URL or
      switch the email link shape to a session-aware URL.
    - submit-payment writes portal_token into the
      payment_submissions row at line ~189. Session-only
      submissions would store NULL. Acceptable today
      (customer_id is also captured) but worth tracking.

  Steps 3a-2 and 3a-3 will wire the remaining 4 functions:
    - 3a-2: verify-portal-pin (PIN logic), customer-statement
      (workflow gap check)
    - 3a-3: customer-portal (dual-mode), submit-cash-payment
      (dual-auth)

  Step 3b (later) will flip frontend to redeem token → session
  on mount and add /launch route + manifest start_url change.

  ### 2026-05-01 — PWA Phase A helper bugfix (76)

  resolvePortalAuth session validation path rewritten from
  PostgREST embed to two sequential queries. Bug surfaced
  during Step 3a-1 verification when session_id auth
  returned 401/403 despite healthy session. Root cause:
  schema cache could not resolve the FK relationship for
  the embed.

  Fix preserves all session validation logic. Adds error
  logging on both queries to expose future debugging info.

  Step 3a-1 verification can now resume. Fresh redeem of
  test token will produce a session that authenticates
  successfully through the helper.

  ### 2026-05-01 — Workflow _shared/ propagation fix (#77)

  GitHub Actions workflow updated so 7 edge functions that
  import from supabase/functions/_shared/ helpers now
  auto-redeploy when those helpers change. Closes the
  latent bug class that surfaced during Phase A Step 3a-1
  (bug #76 helper fix required manual Cloud Shell deploys
  of 3 portal functions).

  Functions now propagating _shared/ changes:
    - send-transactional-email (pre-existing)
    - preview-transactional-email (pre-existing)
    - submit-payment (NEW)
    - join-loyalty-program (NEW)
    - edit-payment-submission (NEW)
    - award-loyalty-points (NEW)
    - loyalty-inactivity-check (NEW)
    - process-loyalty-redemption (NEW)
    - manual-forfeit (NEW)

  Phase A Step 3a-2 and 3a-3 will add the same OR clause
  to verify-portal-pin, customer-statement, customer-portal,
  and submit-cash-payment as those functions are wired to
  resolvePortalAuth.

  ### 2026-05-01 — PWA Phase A Step 3a-2 deployed

  Fourth portal edge function wired to resolvePortalAuth.

  Function wired in this commit:
    - verify-portal-pin (PIN logic preserved bit-for-bit)

  Workflow gap closed: verify-portal-pin deploy step now
  includes _shared/ OR clause for auto-propagation of
  helper changes (matches Bug #77 pattern).

  Phase A scope correction: customer-statement was originally
  listed in the 7-function Phase A audit but is NOT a portal-
  token consumer. It uses statement_tokens table (different
  FK target — layaway_accounts vs customers — and different
  auth lifecycle: account-scoped print/share vs customer-
  scoped portal session). resolvePortalAuth cannot
  authenticate statement_tokens values. Phase A scope is now
  6 functions, not 7. customer-statement stays on token-only
  auth indefinitely or until separately deprecated (planned
  follow-up workstream — feature confirmed unused 2026-05-01).
  UPDATE 2026-05-25: customer-statement DELETED entirely (commit 7f38d37; see FIXED-BUGS #153). The Phase A scope discussion above is historical — this function no longer exists.

  Phase A status:
    - Step 1 (table): COMPLETE
    - Step 2 (helper + redeem): COMPLETE
    - Step 3a-1 (3 functions): COMPLETE
    - Step 3a-2 (1 function): THIS COMMIT
    - Step 3a-3 (2 remaining: customer-portal, submit-cash-payment):
      PENDING
    - Step 3b (frontend redemption + /launch + manifest +
      banner): PENDING

  After this commit: 4 of 6 portal functions accept session_id
  alongside token. 2 remain to wire in Step 3a-3.

  ### 2026-05-01 — PWA Phase A Step 3a-3a deployed

  Fifth portal edge function wired to resolvePortalAuth
  (Path A only).

  Function wired in this commit:
    - submit-cash-payment Path A (customer-facing portal
      token auth)

  Path B (admin Bearer JWT auth, lines 72-102) deliberately
  preserved bit-for-bit. Path B handles admin cash payment
  recording via RecordCashPaymentDialog and is structurally
  separate from Path A.

  Workflow gap closed: submit-cash-payment deploy step now
  includes _shared/ OR clause for auto-propagation of helper
  changes (matches Bug #77 pattern). 11 deploy steps now
  propagate _shared/ changes (2 pre-existing + 7 from #77
  + 1 from 3a-2 + 1 from this commit).

  Phase A status:
    - Step 1 (table): COMPLETE
    - Step 2 (helper + redeem): COMPLETE
    - Step 3a-1 (3 functions): COMPLETE
    - Step 3a-2 (verify-portal-pin): COMPLETE
    - Step 3a-3a (submit-cash-payment Path A): THIS COMMIT
    - Step 3a-3b (customer-portal dual-mode): PENDING
    - Step 3b (frontend redemption + /launch + manifest
      + InstallAppBanner): PENDING

  After this commit: 5 of 6 portal functions accept
  session_id alongside token. customer-portal is the last
  remaining function (wires next in Step 3a-3b).

  ### 2026-05-01 — PWA Phase A Step 3a-3b deployed (Backend complete)

  Sixth and final portal edge function wired to
  resolvePortalAuth. Phase A backend is now fully wired.

  Function wired in this commit:
    - customer-portal (dual-mode: GET + POST, two separate
      auth sites, both wired independently)

  Length pre-checks removed at 2 sites:
    - POST handler line 74 (was: token.length < 16)
    - GET handler line 157 (was: token.length < 16)

  Workflow gap closed: customer-portal deploy step now
  includes _shared/ OR clause for auto-propagation of helper
  changes. 12 deploy steps now propagate _shared/ changes
  (2 pre-existing + 7 from #77 + 1 from 3a-2 + 1 from 3a-3a
  + this commit).

  Phase A backend status: COMPLETE
    - Step 1 (table): ✓
    - Step 2 (helper + redeem): ✓
    - Step 3a-1 (3 functions): ✓
    - Step 3a-2 (verify-portal-pin): ✓
    - Step 3a-3a (submit-cash-payment Path A): ✓
    - Step 3a-3b (customer-portal dual-mode): ✓ THIS COMMIT
    - Step 3b (frontend redemption + /launch + manifest
      + InstallAppBanner): PENDING

  All 6 portal functions now accept session_id alongside
  legacy token. Backwards compatible — existing token-based
  callers see no behavior change.

  Step 3b (frontend) is the customer-visible flip:
    - 3 frontend pages add token-redemption logic
      (CustomerPortal, LoyaltyPortal, and any third)
    - New /launch route with 3-case logic
      (session/admin/neither)
    - vite.config.ts manifest start_url change to /launch
    - New InstallAppBanner gated to TEST-% accounts only

  Step 3b ships in next session given its production-visible
  nature. Backend is stable and verified — frontend can flip
  with a single revert if needed.

  ### 2026-05-03 — Phase A frontend reverted (#79)

  Frontend commits 703a516 (3b-1), dc31be1 (3b-2),
  85a8d23 (3b-2-fix) reverted. Phase A backend intact.

  Production state:
    - HEAD: 235bf30 (revert of 3b-1)
    - Customer auth: token-only (backend supports both
      modes; frontend uses token only)
    - InstallAppBanner: not deployed
    - /launch route: not deployed
    - PWAInstallContext: not deployed

  Phase A status update:
    - Step 1 through 3a-3b (backend): COMPLETE, live
    - Step 3b-1 (frontend redemption): REVERTED — broke
      PIN UI transition (#79)
    - Step 3b-2 (/launch + banner): REVERTED (revert chain)
    - Step 3b-2 fix (#78): REVERTED (revert chain)
    - Step 3b-3 (manifest): NOT SHIPPED

  Pending: root cause analysis of #79 before any retry.
  Phase A may proceed backend-only if frontend retry is
  deferred.

  ### 2026-05-04 — Customers mobile crash fixed (#80)

  Customers page now paginates at 50 per page. Three pages
  migrated to useAccountsLight() (no embed).
  AIRiskPanel/AccountList/Finance unchanged but benefit
  from tightened embed (full_name + messenger_link only).
  Mobile Chrome on iOS loads Customers menu correctly.

  Files modified:
    - src/hooks/use-supabase-data.ts (tightened useAccounts
      embed + added useAccountsLight)
    - src/pages/Customers.tsx (pagination + light hook)
    - src/pages/Dashboard.tsx (light hook)
    - src/pages/NewAccount.tsx (light hook)
    - src/components/dashboard/OverdueAlerts.tsx (dead
      import cleanup)

  Phase A status (unchanged):
    - Backend (commits through 17fa7a6): live
    - Frontend (3b-1 through 3b-2-fix): reverted, pending
      investigation of #79

  ### 2026-05-04 — Phase A frontend Path A paused

  Bug #79 deeper investigation completed. Stale helper
  hypothesis ruled out by DB evidence. Remaining suspect
  is frontend state machine in CustomerPortal — requires
  runtime browser observation to pinpoint.

  debug/repro-79 branch preserved locally at 703a516 with
  reproduction steps documented. Resume when local
  debugging time is available.

  Phase A status:
    - Backend (commits through 17fa7a6): LIVE
    - Frontend (3b-1 through 3b-2-fix): REVERTED, on hold
    - Reproduction setup: ready for future investigation

  No customer impact. Token-only auth working as intended.

  ### 2026-05-15 → 2026-05-16 — GSheet loyalty backup workstream + production go-live

  Full loyalty sheet sync infrastructure shipped over two days, capped by
  the production loyalty_enabled flip:

    Sheet:    1xTdtkNZ0IXWT51V1ytnpdSJnuO-nvzpY-iaDvp3xk7k
              ("Cha Jewels Loyalty Backup")
    Service:  cha-jewels-invoice@cha-jewels-hub.iam.gserviceaccount.com
              (shared with invoice generator)

    Caller fixes (commit 34235f8):
      - award-loyalty-points: replaced broken payload, added 3 emissions
        (earned + bonus if promo + tier_changed if upgrade), loyalty_enabled
        fail-closed gate enforced server-side at step 1b
      - process-loyalty-redemption: redeemed payload enriched, added
        revoked emission to void action branch
      - loyalty-inactivity-check: tier_change → tier_changed rename +
        payload enrichment + expired emission enriched
      - join-loyalty-program: enrolled payload enriched with customer_code

    sync-loyalty-to-sheet rewrite (commit 808dda6):
      - Stub replaced with live implementation
      - Routing by event_type to Members (11 cols) or Transactions (13 cols) tab
      - PHT timestamps via Intl.DateTimeFormat
      - Activity Status derivation from last_purchase_at (null or <90 days = Active)
      - Append endpoint (spreadsheets.values.append)
      - Graceful skip when loyalty_sheet_id is empty

    Realtime sync frequency option added to useLoyaltySettings + SettingsTab.

    Historical backfill: 475 enrolled members + 372 historical
    loyalty_transactions appended via CSV import. Cutoff timestamp
    2026-05-16 12:13:57+00 filters out post-toggle events to avoid duplicates.

    loyalty_enabled flipped TRUE at 2026-05-16 12:13:57 UTC — production go-live.
    Live earn flow validated end-to-end with Jan Jovic (CJ-2026-00880,
    member_uuid 87a0c878-0def-4dbc-a28f-47d039e226db): 1800→2000 pts,
    cumulative 186,666→209,179 ¥, transaction
    2ff4c0a5-835b-4919-819d-ad8154f8c26b synced to sheet in real-time.

  ### 2026-05-16 — Loyalty migration catch-up (6 customers)

  Old-system loyalty earnings for 6 customers were not captured in the
  2026-05-16 historical backfill (per-customer aggregate gaps). Resolved
  with consolidated per-customer earned rows matching the backfill data
  shape (Option A — one row per customer, NULL account_id/cash_order_id):

    Customer                                 Code              Pts    Spend ¥
    stokesmaria85 (Ellen P Stokes)           CJ-2026-03560    2,400   153,332
    mmheartie11 (Marikarr Heartie Merca)     CJ-2026-00248    1,200    63,440
    anjcherie28 (Anj Pelijates)              CJ-2026-01608    1,000   103,980
    mickey1504 (Shiely Sy Demalata)          CJ-2026-02472      100    13,320
    maeserrana (Mae Serrana)                 CJ-2026-00736    2,100   211,960
    maricaralonzo110485 (Maricar May Alonzo) CJ-2026-02464    1,400   149,940
    TOTAL                                                     8,200   695,972

  Writes: 6 loyalty_transactions INSERTs + 6 loyalty_members UPDATEs
  (cumulative_spend_jpy, total_points_earned, remaining_points,
  last_purchase_at). Sheet appended with 6 earned rows in Transactions tab
  and 6 admin_edited rows in Members tab. All catch-up rows filterable via
  notes ILIKE 'Migration catch-up from old loyalty system%'.

  Session discoveries that led to SCHEMA FACTS section addition:
  loyalty_transactions actual column names differ from common assumptions
  (transaction_type not event_type, points_amount not points_change,
  spend_amount_jpy not amount_spent_jpy, no multiplier column,
  created_by_user_id uuid not created_by text); customers.email stored
  mixed-case so LOWER() comparison required; Supabase SQL Editor CSV
  export alphabetizes columns. See SCHEMA FACTS & OPERATIONAL LEARNINGS
  for the documented rules.

  ### 2026-05-17 — Phase 3 (Bug #6 Stage 2 + Bug #39 mitigation): SHIPPED

  - Stage 2 BEFORE DELETE hard blocker on layaway_schedule
  - delete_schedule_row_atomic SECURITY DEFINER RPC (Bug #39 mitigation)
  - delete-installment edge function updated to use atomic RPC
  - delete_account_atomic RPC updated with GUC bypass
  - Empirical proof of Bug #39 + mitigation via TEST-004 smoke tests
  - New locked rule: GUC bypass before write via supabase-js MUST
    use SECURITY DEFINER RPC, never the 2-HTTP-call pattern

  ### 2026-05-18 — Phase 4 (Bug #101 PATH 3 verification reconciliation): CLOSED

  - Investigation-first SOP applied: before re-verifying, checked production
    state of fixture CJ-2026-FORFEIT-PATH3-NEW
  - Account-side state confirmed intact (status=final_settlement, no
    forfeited_at, 3 schedule rows still overdue/not cancelled,
    final_settlement_record from 2026-05-15 present)
  - Loyalty-side data found removed: no loyalty_members row for the customer,
    zero loyalty_point_lots, zero loyalty_transactions, admin UI shows
    "Not enrolled"
  - Migration history check: only migration in 20260515-20260518 window
    (20260516010044) drops loyalty auto-award DB triggers, no deletion
    logic — wipe was not migration-driven
  - 2026-05-15 empirical verification stands as proof of record for Bug #101
    PATH 3 (no-revoke on final_settlement transition)
  - Removed stale DEFERRED entry that claimed fresh fixture was needed
    (predated 2026-05-15 verification)
  - Added forensic note to FORFEITURE STANDARD PATH 3 entry documenting
    current fixture state for future reference
  - No code, SQL, or edge function changes

  ### 2026-05-18 — Phase 5 (Bug #99 PATHS 1+2+4+5 empirical verification): CLOSED

  - Investigation-first SOP applied: schema verification + dry-run query
    + historical evidence inspection + source code review before any
    fixture work
  - All 4 auto-forfeit-settlement revoke hook points verified via
    3-layer evidence stack:
      - Phase 5a (PATH 1, final-month penalty cap): code wiring at
        auto-forfeit-settlement/index.ts line 359; 4 audit_log entries
        across 3 unique accounts including CJ-2026-FORFEIT-P1
      - Phase 5b (PATH 2, 3-month overdue): code wiring at line 463;
        ~55 audit entries across real production accounts (strongest
        empirical trigger evidence — 15xxx, 16xxx, 17xxx, both PHP
        and JPY)
      - Phase 5c (Extension expiry, final_forfeited): code wiring at
        line 224; 4 audit entries on test fixtures (CJ-2026-FORFEIT-P1,
        CJ-2026-FORFEIT-P3, CJ-2026-PATH1-TEST, CJ-2026-RESTORE-TEST)
      - Phase 5d (Extension cap, final_forfeited): code wiring at
        line 284; 1 audit entry on CJ-2026-FORFEIT-P2 (weakest
        empirical, sufficient via code+function-proof layers)
  - Revoke function proven via manual-forfeit (TEST-008_ELITE
    2026-05-14 01:53:12 revoke transaction preserved) and void-payment
    paths
  - 90-day payment guard placement confirmed (lines 364-378, between
    PATH 1 at lines 300-362 and PATH 2 at lines 411+ — protects PATH 2
    and PATH 3 only; PATH 1 fires regardless of recent payments per
    spec, no guard)
  - fireLoyaltyRevoke helper analyzed (lines 57-95): currency-aware
    (PHP=total_paid/php_jpy_rate; JPY=total_paid direct), zero-spend
    skip at line 75, fire-and-forget error handling at line 91,
    outer try/catch at lines 64+92 — revoke failures do not block
    forfeit
  - End-to-end production observation (audit + paired revoke
    transaction within 5min) unavailable across all 4 hooks; cause
    analyzed and documented (pre-wiring forfeitures + test fixture
    data wipes + no post-wiring non-fixture JPY auto-forfeits)
  - Documentation drift fixed: BUG #99 EMPIRICAL VERIFICATION block
    updated from "pending" (with stale 5-hook listing including
    PATH 3) to "CLOSED 2026-05-18" with 3-layer evidence stack and
    4-hook scope (Bug #101 PATH 3 exclusion documented)
  - No code, SQL, or edge function changes

  ### 2026-05-18 — Phase 6 (P12 send-reminders grace_period wiring): CLOSED as stale documentation

  - Investigation-first SOP applied: read send-reminders/index.ts, payment-reminder.tsx template, registry.ts, and reminder_logs schema; ran 14-day empirical SQL on reminder_logs before any judgement
  - send-reminders/index.ts already calls send-transactional-email for grace-period branch (lines 188-237):
      - isGracePeriod = daysOverdue >= 1 && daysOverdue <= 7 && !hasPenalties
      - templateName: "payment-reminder" with templateData.type: "grace_period"
      - graceEndDate computed as due_date + 7 days
      - idempotencyKey: `grace-period-${scheduleId}-${today}`
  - payment-reminder.tsx fully handles type='grace_period' (lines 16, 35, 41-43, 49-50, 57-58, 93-99, 116) including dedicated subject "⏳ Grace Period Reminder — INV #X" at line 151
  - 'payment-grace-period' registry entry is a preview-UI alias; production behavior identical to 'payment-reminder' when called with type='grace_period'
  - 14-day empirical reminder_logs query (2026-05-05 → 2026-05-18) confirmed 1,620 emails sent across all stages, zero delivery_status='failed' rows. Customers in grace period are receiving correctly-themed emails in production.
  - CLAUDE.md "### OTHER" section line 7767-7769 was stale; removed
  - No code, SQL, or edge function changes
  - Documented quirks (no fix needed):
      - reminder_logs.template_type records classifyAlert stage (penalty/overdue/etc.), not email variant; grace-period emails logged under template_type='overdue' or template_type='penalty' (day-7 edge). Customer-facing impact zero; reporting impact only.
      - Day-7 morning edge case before penalty engine runs: stage='penalty' but isGracePeriod=true; correct grace-period email sent, but log records template_type='penalty'. Cosmetic log/email mismatch only.

  ### 2026-05-18 — Phase 7 (Issue C / Bug #110 send-reminders rate limit): FIXED

  - Investigation-first SOP applied with empirical validation at each step:
      - reminder_logs schema verified + 14-day activity query (1,620 emails,
        zero failures, but zero due_today entries since 2026-05-15)
      - email_send_log schema + indexes verified (idx_email_send_log_idempotency_active
        UNIQUE partial index confirmed Bug #109 dispatcher pattern infrastructure)
      - email_send_log raw dump for 2026-05-18 revealed exact 12-second gap
        between grace-period (00:00:52) and due_3_days (00:01:04)
      - send-transactional-email full source review (397 lines): idempotency
        check at lines 301-323, INSERT at line 329 — verified neither would
        block due_today payloads
      - process-email-queue full source review (361 lines): no template-name
        filtering, confirmed Bug #109 sent-row INSERT pattern (no idempotency_key
        on sent rows)
      - Direct curl reproduction with type='due_today' payload: returned
        {success: true, queued: true} — definitively ruled out
        template/render/INSERT failure in send-transactional-email
      - Affected accounts data inspection: no malformed inputs, all 5
        due_today accounts on 2026-05-18 had normal data (PHP currency,
        pending status, zero unpaid penalties, no non-printable chars)
      - Edge function logs for send-reminders at 2026-05-18 00:03:00 UTC
        revealed RateLimitError from Deno fetch runtime at index.ts:197:32
        with retryAfterMs=93
  - Root cause: Supabase Edge Function per-invocation outbound fetch rate
    limit. send-reminders accumulates 30+ fetches in quick succession
    (19 penalty + 11 grace-period on 2026-05-18); rate limit kicks in
    just as due_today processing begins (positional 31-35). The catch
    block at lines 277-280 caught RateLimitError but did not retry,
    causing all 5 due_today fetches to fail silently per cron run.
    By the time iteration reached due_3_days, the rate limit window had
    reopened (catch + 500ms sleep adds ~600ms per failed fetch,
    totaling >3 seconds of recovery).
  - Fix: added fetchWithRetryOnRateLimit helper to send-reminders/index.ts
    (3 retries with retryAfterMs+50ms backoff). Replaced direct fetch
    calls at lines 197 (grace branch) and 239 (regular branch). No other
    changes. Deployed manually via Lovable (auto-deploy broken).
  - Verification plan: monitor 2026-05-19 00:00 UTC cron run; expect
    reminder_logs email-channel entries for due_today template_type,
    email_send_log entries with idempotency_key matching
    reminder-%-due_today-%. Report results next session.
  - Customer mitigation: skip (per Cynthia 2026-05-18). ~17 customers
    across 2026-05-16/17/18 missed only the on-the-day due_today reminder;
    they received other-stage reminders before and after. Fix prevents
    recurrence.
  - Stale documentation cleanup: Phase 6 close-out (commit e33a439) had
    filed Issue C as pending investigation with severity HIGH if (b) /
    LOW if (a) — confirmed (b) and fixed in same day. Update the
    PENDING INVESTIGATIONS entry to reflect closure (or leave it as a
    historical note — Phase 7 changelog supersedes).
  - Numbering note: the Phase 7 brief refers to this as "Bug #110";
    #110 was already assigned (2026-05-17 review-payment-submission
    await fix), so the Known Fixed Bugs entry is recorded as #114 (next
    free flush-left number) per the no-duplicate-numbering rule.
  - No SQL changes. Edge function code change only.

  ### 2026-05-18 — Phase 8 (P10 milestone notification emission): CLOSED as already implemented

  - Investigation-first SOP applied: schema verification + 30-day email_send_log query + source code review of 4 loyalty edge functions
  - Empirical evidence (email_send_log, 30-day window):
      - loyalty-tier-upgrade: 7 emails sent, all paired pending+sent rows
      - Distribution: 2026-05-17 (1), 2026-05-14 (1), 2026-05-12 (3), 2026-05-10 (2)
      - Zero delivery failures
  - Source code wiring confirmed:
      - award-loyalty-points/index.ts fires loyalty-tier-upgrade on tier crossing
      - loyalty-inactivity-check/index.ts fires loyalty-tier-downgrade on inactivity
      - restore-loyalty-points/index.ts fires loyalty-tier-restored on lifecycle restore
      - revoke-loyalty-points/index.ts fires loyalty-tier-revoked on lifecycle revoke
  - Implementation history reconciled — feature was completed via:
      - Bug #98 (2026-05-12): ratchet-up multiplier on tier-crossing purchase
      - Bug #99 (2026-05-13): full loyalty lifecycle integration including tier_changed event taxonomy
      - Bug #103 (2026-05-15): loyalty-tier-restored template
  - Anomaly investigation: 2026-05-12 showed 3 tier-upgrade emails to chajewelsjapan@gmail.com (test fixture). Decoded as legitimate test fixture activity — pre-Bug #103 restore path used loyalty-tier-upgrade template (the very issue Bug #103 fixed). All 7 emails map to real state transitions; zero duplicate-email bugs found.
  - LOYALTY EVENT TAXONOMY (line 3266 of CLAUDE.md) explicitly documents: "award-loyalty-points → emits earned + bonus (if promo) + tier_changed (if upgrade)" — consistent with empirical observation.
  - No CLAUDE.md text edits required — there is no specific stale roadmap line in CLAUDE.md (unlike Phase 6 which had a stale "OTHER" section). The P10 entry existed only in session-level severity ranking.
  - No code, SQL, or edge function changes

  ### 2026-05-18 — Phase 9 (P6 / Bug #8 cash order 500): DISPROVEN as no longer applicable

  - Investigation-first SOP applied: CLAUDE.md context check + schema verification + source review (award-loyalty-points/index.ts) + 30-day empirical analysis of completed cash orders
  - KEY FINDING: The original P6 framing ("safety-net mitigation in place") was INVALIDATED by the 2026-05-16 migration. The Layer-2 DB triggers (trg_loyalty_on_cash_order_complete, trg_loyalty_on_layaway_complete) and award_loyalty_points_on_complete() function were DROPPED via migration 20260516000000_drop_layer2_loyalty_triggers.sql because they created ghost audit rows without updating loyalty_members counters or creating point lots. Awards now depend SOLELY on the canonical path: review-payment-submission → await fetch → award-loyalty-points (LOYALTY AWARD SYSTEM section, CLAUDE.md line 3179).
  - Empirical 30-day completed cash order analysis (22 orders, 2026-04-28 → 2026-05-18):
      - 3 EARNED: 19023 Jackie Descartin (PHP, 2026-05-17), 19048 Jan Jovic (JPY, 2026-05-16), Test-007 fixture (JPY, 2026-05-12)
      - 14 LEGITIMATE_SKIP: cash_orders.loyalty_jpy_amount IS NULL or 0 (services/shipping-only orders)
      - 2 LEGITIMATE_SKIP: customer not enrolled in loyalty
      - 1 LEGITIMATE_SKIP: loyalty_jpy_amount below ¥10,000 minimum threshold (RoNa 19052 at ¥4,060)
      - 2 historical anomalies reconciled by business owner context:
          - Shiely Sy Demalata (PHP, 19022, 2026-05-15): pre-Bug #113 fix casualty; already manually awarded
          - Liza Aono (JPY, 18969, 2026-05-08): pre-migration customer; her loyalty state was carried over via the OLD system into cumulative_spend_jpy, total_points_earned, remaining_points per migration design (summary-only, by design — see LOYALTY DATA & MIGRATION). Not a gap, no further action needed. (Per-order earnings for pre-migration customers are intentionally NOT in loyalty_transactions per the documented migration scope.)
  - Real bug count in 30-day window: ZERO
  - Bug #113 fix (committed 2026-05-17) IS deployed in production. Confirmed empirically: Jackie Descartin (PHP, 2026-05-17 07:16 UTC) earned loyalty points correctly via the canonical path with the post-Bug #113 code. Someone manually deployed award-loyalty-points via Lovable between Bug #113 commit and Jackie's completion timestamp.
  - Original Bug #8 specific incident (cash order #10000 HTTP 500): not observable in 30-day window; appears dormant or resolved
  - Source code confirmation: award-loyalty-points/index.ts lines 116-118 contains the post-Bug #113 amount-gate: `if (!(loyaltyJpy > 0)) return json({ skipped: true, reason: "no_loyalty_amount" });`. Currency gate is gone.
  - No code, SQL, or edge function changes. No customer backfill needed (all 2 historical misses accounted for via separate mechanisms).
  - 3 of 4 HIGH-severity customer-facing pendings (P12, P10, P6) now closed as stale or no-longer-applicable. The 43-phase roadmap is significantly overdue for reconciliation against current production state (Bugs #98/#99/#103/#113 closed most "actionable" items already).

  ### 2026-05-18 evening — Redemption end-to-end build (Phases B/C/D/E)

  Chronological commit log (all pushed to main):
  - 13:01 UTC — Phase B initial (2b0fb64): synthetic payment INSERT
    on redemption approval, dual-branch (cash + layaway) +
    reconcile-account call (later found to be a no-op).
  - 13:17 UTC — Phase C (af6bcba): type-aware redemption form with
    order picker.
  - 13:54 UTC — Phase C Patch 1 (ce70934): customer-portal token-key
    fix + type-aware UX corrections.
  - 14:07 UTC — Phase C Patch 2 (64a0b25): customer-portal switched
    to GET with token URL param.
  - 15:03 UTC — Phase B Patch 1 (2afca0f): payments.submitted_by_type
    CHECK compliance ('staff' not 'admin') + hard-fail 500 on
    synthetic INSERT failure.
  - 15:43 UTC — Phase B Patch 2 (8130ace): inline waterfall
    allocation + per-row schedule sync + account totals UPDATE;
    replaces the no-op reconcile-account call. Canonical pattern
    for "reconcile-account does not fix" (see C1 note).
  - 15:58 UTC — Phase C Patch 3 (3d073c8): mobile dialog scroll fix
    (sticky header/footer, max-h-[90dvh] flex column).
  - Phase D (this commit): RedemptionApprovalModal type-aware
    verification labels + apply verb + type badge in header.
  - Orphan cleanup 2026-05-18: redemptions bfd0da07 + af636465
    cancelled; synthetic payment a27a1565 voided (pre-Patch-1/2
    casualties from the CHECK reject + no-op reconcile).

  ### Phase 13 — Member events admin Member tab fix (2026-05-19, SQL Editor only, no commits)

  **Problem:** Admin Member tab (Loyalty → Transactions → Member) was
  missing tier_changed events and had blank Tier column on all enrolled
  rows.

  **Root causes identified via empirical investigation:**

  1. tier_changed historical gap: `f5f6d98 feat(loyalty): wire
     member-event transaction types (enrolled, tier_changed)` committed
     2026-05-17 10:53:55 UTC. Marlene Corpuz's real tier upgrade
     (Glimmer → Radiant) occurred 2026-05-17 09:54:01 UTC — 59 minutes
     BEFORE the DB INSERT code was committed. Google Sheet captured it
     (via `34235f8 sheet-sync taxonomy` wired 2026-05-16) but
     `loyalty_transactions` did not. Same class as Bug #103 (_shared/
     file changes need downstream redeploy) but for code that hadn't
     existed yet.

  2. enrolled rows tier_at_time NULL: The 475-row enrolled backfill
     (executed via SQL Editor 2026-05-17 from
     `loyalty_members.enrolled_at`) followed the SUMMARY-ONLY migration
     design — only essential fields populated (`member_id`,
     `transaction_type='enrolled'`, `points_amount=0`, `notes`,
     `created_at`). `tier_at_time`, `spend_amount_jpy`,
     `invoice_number` left NULL by design.

  **Operations executed via SQL Editor 2026-05-19:**

  1. INSERT 1 row — Marlene Corpuz tier_changed (id
     `e2eaad32-4126-4daa-bfe9-50d62bb31027`)
     - member_id: b7a5193d-dc18-4853-9f75-09a7db803670
     - transaction_type: 'tier_changed'
     - tier_at_time: 'Radiant'
     - created_at: 2026-05-17 09:54:01.857797+00 (exact upgrade
       timestamp from reconstruction)
     - notes: includes "[BACKFILL 2026-05-19: event predated f5f6d98
       DB INSERT deploy by 59 min; source email_send_log +
       earned-history reconstruction]"
     - Idempotency: WHERE NOT EXISTS guard on member_id + type +
       1-minute window
     - Sheet sync: NOT triggered (Marlene already in sheet via
       2026-05-17 sync — no duplicate)

  2. UPDATE 475 rows — enrolled tier_at_time NULL → 'Glimmer'
     - Scope: transaction_type='enrolled' AND tier_at_time IS NULL
       AND notes LIKE '%backfilled%'
     - Rationale: Every loyalty member starts at Glimmer
       (display_order=1, min_spend_jpy=0). Factually correct, not a
       guess.
     - Verification: post-UPDATE counts all 475 rows show
       tier_at_time='Glimmer'

  **UI verification:** Admin Loyalty → Transactions → Member tab now
  shows "15 member events" (was 14). Marlene Corpuz tier_changed row
  appears at top with Radiant tier badge. All 14 enrolled rows show
  Glimmer in Tier column.

  **Test Customer (CJ-2026-05088) tier_changed history INTENTIONALLY
  SKIPPED:** 6 tier-upgrade events for Test Customer exist in
  email_send_log (testing fixture with repeat upgrade/downgrade
  cycles). Backfilling would add noise without business value.
  Documented as Option B/C remaining if ever needed (idempotency
  guards on future inserts will prevent duplicates).

  **Going-forward verification still needed:** f5f6d98 code is
  deployed (per 2026-05-17 10:57 UTC manual deploy via Lovable).
  However, no natural tier upgrade has occurred since the deploy to
  empirically prove the DB INSERT fires correctly. Next customer who
  crosses 1M/4M/8M JPY cumulative spend will be the first proof. If a
  tier_changed row does NOT appear in loyalty_transactions for that
  upgrade, deeper investigation required.

  **Migration design preserved (locked, NON-NEGOTIABLE):** The
  SUMMARY-ONLY migration rule remains intact. Per-order
  purchase/redemption history NOT restored. This backfill only
  populated derived defaults (tier_at_time='Glimmer' for enrollment
  events) without claiming to know historical per-purchase context.


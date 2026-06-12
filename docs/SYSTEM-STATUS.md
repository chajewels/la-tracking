# System Status — last updated 2026-06-12

## App Version
1.2.0 (commit 02a040c)

## 2026-06-12 — v1.2.0
- Product Inquiry Tracker shipped under CSR Monitoring → Inquiries
- Two tabs: Inquiry List (filterable, paginated, add/edit) + Demand Map
- Demand Map: Top 20 most inquired items (gold bar chart), Demand
  Intelligence Quadrant (scatter: volume vs conversion rate), Top 20
  most frequent inquirers (purple bar chart)
- 805 rows migrated from Google Sheet on launch (803 initial + 2
  multi-category source rows recovered via INSERT on 2026-06-12)
- order_placed backfilled from source CSV on 2026-06-12:
  No 367 / Yes 85 / Joy Mine 3 / blank 350
- 18 date corrections applied 2026-06-12 (17 future-date typos
  + 1 unparseable source date)
- All dropdowns configurable via inquiry_dropdown_options table with
  inline + Add in form
- Tables: product_inquiries, inquiry_dropdown_options
- Permission keys: view_inquiries + manage_inquiries (all 4 roles)
- Blank filter added to Action Needed (null + empty) and Order Placed
  (null) for unset rows
- 2026-06-12: Demand Map gained Order Placed filter (applies to all
  charts) and Repeat Inquirers table (same customer, same item, 2+
  inquiries)
- Sales Commission module (/commissions) live — sales_log/commission_agents/commission_splits, GAS algorithm replicated client-side (winner-take-all, one role per agent, amount tiebreaker), sheet retired to backup.
- Services + Trade-Ins sidebar converted to parent with sub-items
  (Service Jobs / Trade-Ins) — v1.1.1 fix carried forward

## Active Features (shipped)
- CA Bot AI command interface (`✨` button in AppLayout)
  - CREATE_CUSTOMER: DB insert, toast confirmation
  - CREATE_LAYAWAY_ACCOUNT: navigates to /accounts/new with pre-fill
  - CREATE_CASH_ORDER: navigates to /cash-orders/new with pre-fill
  - RECORD_PAYMENT single: opens RecordPaymentDialog with invoice + method pre-filled
  - RECORD_PAYMENT split: opens MultiInvoicePaymentDialog with current month per account
  - ASK_POLICY: answers from knowledge base + live DB tools
  - New customer detection: warns + opens New Customer dialog pre-filled
  - Multilingual: Tagalog and English
- AI Customer Insights dialog (Customer Detail → AI Insights button)
  - Excludes 2026-03-22 migration-batch penalty records (816 artifacts)
- Services Tracking module (/services) — service_jobs table, 178 records migrated
- Trade-In Tracker (/services?tab=trade-ins) — trade_ins table, 8 records migrated
- Policy Hub (/policy-hub) — 8-tab iframe page
- Security: portal PIN migrated to PBKDF2-SHA256, customer_pins table
- Session timeout (AuthContext, commit 1adfa15)
- Admin Audit Log (/admin-activity)
- Loyalty staff visibility
- Phase B email/password auth (100% complete)
- tier_changed emission (commit 0272587)
- approve_redemption_atomic PL/pgSQL RPC (verified fixed 2026-06-08)

## Edge Functions Deployed
- ai-command-parser (Gemini 2.5 Flash primary, GPT-5-mini fallback)
- ai-customer-insights
- All other edge functions current as of main

## AI Model
- Primary: google/gemini-2.5-flash (via Lovable gateway)
- Fallback: openai/gpt-5-mini
- Knowledge base: static system prompt + live DB tools
  (query_customers, query_accounts, query_payments,
   count_accounts, query_loyalty, query_loyalty_tiers,
   query_system_settings)

## Open Bugs
- (none currently tracked)

## Resolved (do not re-list)
- P1 void atomicity: VERIFIED FIXED 2026-06-09 (void_redemption_atomic RPC, edge function refactor)
- P1 approve atomicity: VERIFIED FIXED 2026-06-08
- P5 session timeout: shipped 2026-05-26
- P6 admin audit log: shipped 2026-05-26
- P3 loyalty staff visibility: closed
- Currency toggle Path A/B: Dashboard removed 2026-05-23
- customer-statement deletion: complete 2026-05-25
- Phase B email/password auth: 100% complete
- Bug #103 auto-deploy: closed 2026-05-25
- tier_changed emission: shipped 2026-05-25
- PWA Phase A: abandoned 2026-05-04

### Cash Order Edit Expiry — gate aligned to RLS UPDATE policy (2026-06-09)

  The Edit Expiry button in CashOrderDetail rendered under
  `(isAdmin || isFinance)`, but the underlying RLS UPDATE policy
  `staff_admin_update_cash_orders` allows admin OR staff. Two
  pre-existing mismatches:

    - Finance users saw the button but hit RLS errors on submit
    - Staff users had UPDATE permission but no UI button

  Gate changed to `(isAdmin || isStaff)` so UI matches RLS. CSR and
  customer roles remain blocked from editing (unchanged).

  No RLS policies, edge functions, or cron jobs touched. Auto-expiry
  cron `auto-expire-cash-orders` (jobid=17, 30 0 * * *) still runs.
  Cash orders still expire if unpaid past `expires_at`, and admin/
  staff can extend the deadline from the Edit Expiry button on the
  cash order detail page.

  Data fix: cash_order id 4a39facc-d9a6-499e-818e-e6bbf03c384a
  (invoice #19114, customer Pedersen Dee, ¥9,800 of ¥79,048 paid)
  was reset from status='expired' to status='pending' with
  expired_at cleared. Test orders #3456 and #1234 left as 'expired'
  per merchant decision.

### Loyalty redemption void — atomic via void_redemption_atomic RPC (2026-06-09)

  The void branch of process-loyalty-redemption was ~700 lines of
  inline TypeScript doing ~15 sequential DB writes across loyalty +
  order tables (refund tx, redemption flip, member balance, loyalty_jpy
  restore, synthetic payment void, allocation revert, schedule revert,
  account totals revert, stock re-increment, audit log, account_notes).
  Outer try/catch swallowed all errors into console.warn — meaning any
  step after refund tx could fail and leave the customer in a partial
  state: refund tx exists + redemption cancelled but member balance not
  updated, or member credited + customer's order still shows discount
  applied, or partial allocation revert leaving orphaned rows on a
  voided payment.

  Migrated to public.void_redemption_atomic(uuid, uuid, text, text)
  PL/pgSQL RPC modeled on approve_redemption_atomic's pattern. Single
  transaction with FOR UPDATE locks on loyalty_redemptions, loyalty_
  members, loyalty_rewards; relative arithmetic on member balance;
  faithful port of schedule status reversal rules (paid/overdue/
  partially_paid/pending cascade based on remaining due + due_date);
  faithful port of account status reversal (completed → overdue if
  any layaway_schedule.status='overdue' else active); faithful port
  of cash_orders.status revert (completed → pending when remaining > 0).

  account_notes insert moved INSIDE the atomic boundary and uses
  symmetric format with approve: "Loyalty: redemption voided — N pts
  refunded (type) — ¥M removed from balance" (or ₱M for PHP).

  Edge function void branch collapsed from ~700 to ~180 lines:
  auth + input validation, single supabase.rpc call, error code
  mapping (redemption_not_found → 404, redemption_not_confirmed →
  400, redemption_void_race → 409, member_not_found → 404, schedule_
  row_not_found → 500, other → 500), all side effects preserved
  (staff_notifications, email gate 'loyalty_email_redemption_voided',
  Phase 4.2 in-app notification, sync-loyalty-to-sheet 'revoked'
  event). Response shape unchanged: { voided, redemption_id,
  points_refunded, stock_re_incremented }.

  Lot tables (loyalty_point_lots, loyalty_lot_consumption) intentionally
  NOT touched. Earlier verification (2026-06-09) showed loyalty_lot_
  consumption has zero rows in production — consume_lots_fifo is never
  called from approve_redemption_atomic. void_redemption_atomic stays
  symmetric: neither touches lots. If consume_lots_fifo activates in
  approve later, void RPC needs amendment to call restore_lots_for_
  redemption simultaneously.

### approve-waiver — migrated to role_permissions matrix (2026-06-10)

`approve-waiver` edge function previously used hardcoded `has_role(admin) OR has_role(finance)` gate, ignoring the `role_permissions` Settings matrix. Migrated to use `_shared/check-permission.ts` helper with permission key `manage_waivers`. UI buttons in `Waivers.tsx` now also gated via `can('manage_waivers')`.

**Phase 1 of broader role-permissions audit.** 74 edge functions total; 30 currently use hardcoded `has_role` gates; 4 already use `checkPermission` (create-team-member, delete-customer, fix-account-status, review-payment-submission); the rest are system/cron/customer-side and intentionally not matrix-gated.

**Phase 2 scope (high-impact staff-facing, scheduled separately):** record-payment, record-multi-payment, void-payment, void-cash-payment, restore-payment, restore-cash-payment, edit-payment-amount, create-cash-order, create-layaway-account, restructure-account, plus fixing the multi-role-user bug in `_shared/check-permission.ts` (uses `.maybeSingle()` on `user_roles` which fails for users with >1 role row).

**Phase 3 scope (admin-only and lower-traffic, scheduled separately):** delete-account, delete-installment, add-installment, extend-schedule, carry-over, add-service, adjust-loyalty-points, award-loyalty-points, restore-loyalty-points, revoke-loyalty-points, bulk-import, set-portal-pin, accept-underpayment, dashboard-summary, system-health-v2, finance-reconciliation, generate-invoice.

**Audit-surfaced data integrity issues (separate cleanup):**
- Matrix is missing keys referenced in code: `view_cash_orders`, `create_cash_order` (used in `PAGE_PERMISSION_MAP`), `view_geo_breakdown` (used in `Dashboard.tsx` via `can()`).
- Naming mismatch: `PAGE_PERMISSION_MAP` references `payment_submissions` but matrix uses `view_submissions`.
- `/waivers` route is not in `PAGE_PERMISSION_MAP` — page reachable via URL even when matrix denies. Phase 2 item.

### Penalty waiver unwaive flow — migrated to atomic RPC (2026-06-10)

`Waivers.tsx` UI `handleUnwaive` previously did 3 separate client-side supabase writes to `penalty_fees`, `layaway_schedule`, and `layaway_accounts` but never reset `penalty_waiver_requests.status`. Result: orphan waiver_request rows stuck at `approved` while the corresponding penalty was unpaid/paid. UI displayed inconsistent state, and admins couldn't re-test approve flows post-unwaive (waiver never re-entered pending queue).

Migrated to atomic PL/pgSQL RPC `public.unwaive_penalty_atomic` called via new edge function `unwaive-waiver` (auth gate via `checkPermission(manage_waivers)`). Three historical orphans backfilled (Roselia #18603, Monika #17933, Maria #17110) — see Bug #193 in FIXED-BUGS.md.

**Pattern:** Mirrors `approve_redemption_atomic` (2026-06-08) and `void_redemption_atomic` (2026-06-09). All three atomic-reverse RPCs follow the same shape: `SECURITY DEFINER` + `search_path = public` + jsonb return with `error_code` mapping.

**Known related asymmetry — Bug #194 (scheduled next session):** `penalty-engine` cron at `supabase/functions/penalty-engine/index.ts` L362 also programmatically converts waived penalties back to unpaid without resetting `penalty_waiver_requests`. Separate semantic context (system-driven re-evaluation, not user reversal), so fix design may differ.

### `_shared/check-permission.ts` — migrated to multi-role iteration (2026-06-10)

The shared permission helper used by 4 edge functions previously assumed each user has exactly one role row in `user_roles`. Refactored to fetch all role rows, mirror the UI's `usePermissions().can()` iteration pattern, and support composite roles (admin + finance, staff + admin, etc.).

Dependent edge functions requiring redeploy after this change: `approve-waiver`, `unwaive-waiver`, `manual-forfeit`, `reactivate-account`. Supabase bundles `_shared/` files at deploy time, so the helper update doesn't propagate to running functions until each is redeployed.

**Pattern:** This completes item 2 of the locked 4-item Phase 2 of the role_permissions matrix audit (after Bug #192 / Bug #193). Remaining items: orphan/naming cleanup in PermissionMatrixTab (item 3), and Phase 2 migrations of 10 hardcoded staff-facing edge functions (item 4).

### Permission matrix / route gating cleanup — Bug #197 closed, Bug #198 deferred (2026-06-10)

Item 3 of locked Phase 2 scope closed. PermissionMatrixTab UI now exposes 3 previously-orphaned DB keys (`view_cash_orders`, `create_cash_order`, `view_geo_breakdown`), and `/waivers` route is now gated through PAGE_PERMISSION_MAP + NAV_PATHS (previously URL-accessible without permission check). DB prerequisite UPDATE applied pre-commit to set `staff/view_waivers=true` so Brenda retains the approve-waiver workflow access shipped in Bug #192.

Audit during Bug #197 closure revealed 11 additional DB-only permission keys absent from the matrix UI — documented as Bug #198 for deferred follow-up. Not blocking Phase 2 item 4 (10-edge-function hardcoded gate migration).

### Phase 2 Item 4 scope discovery — 28 functions, not 10 (2026-06-10)

Original Phase 2 plan estimated ~10 staff-facing edge functions still using hardcoded `has_role()` checks for role_permissions matrix migration. Cloud Shell enumeration during Bug #197 closure revealed **28 functions** still using the pattern. Four already migrated to `checkPermission()` via earlier Phase 2 work: `approve-waiver` (Bug #192), `unwaive-waiver` (Bug #193), `manual-forfeit`, `reactivate-account`.

**Effective Item 4 scope:** 28 functions broken into 6 batches by domain. Each batch ≈ one session of investigation → SQL verify role_permissions row exists for target key → Lovable code prompt → Lovable deploy prompt → smoke test → docs entry per function.

| Batch | Domain | Functions | Likely permission keys |
|---|---|---|---|
| A | Account lifecycle | create-layaway-account, create-cash-order, delete-account, restructure-account, carry-over | create_account, create_cash_order, delete_account, edit_account, edit_schedule |
| B | Payment writes | record-payment, record-multi-payment, void-payment, restore-payment, accept-underpayment | record_payment, void_payment, restore_payment |
| C | Cash + schedule | submit-cash-payment, void-cash-payment, restore-cash-payment, add-installment, delete-installment, extend-schedule, edit-payment-amount | record_payment, edit_schedule |
| D | Loyalty admin | adjust-loyalty-points, award-loyalty-points, revoke-loyalty-points, restore-loyalty-points | loyalty_adjust_points (Bug #198 dependency — key missing from matrix UI) |
| E | Admin/Finance + dashboard | bulk-import, finance-reconciliation, generate-invoice, add-service, dashboard-summary | bulk_payment_import, view_finance, view_dashboard |
| F | Special cases | system-health-v2 (parseJwtClaims target NOT checkPermission), set-portal-pin (customer-facing semantics — investigation first) | — |

**Cross-cutting concerns flagged for Batch D and E:**
- Batch D depends on Bug #198 fix (`loyalty_adjust_points` not in matrix UI yet) OR migration without UI exposure until #198 closes
- `dashboard-summary` may not need a permission gate at all — read-only summary endpoint; investigate intent before migrating
- Batch C cash payment keys may share `record_payment` permission with native payments OR have separate cash-specific keys — DB verification required

**Status:** Items 1-3 of Phase 2 closed (Bug #192, #193, #196, #197). Item 4 = 5-6 future sessions, starts with Batch A in a fresh session.

### Phase 2 Item 4 Batch A complete — 5 account lifecycle functions on checkPermission (2026-06-10)

Batch A of the Item 4 batched migration plan complete. The role_permissions matrix UI in admin Settings is now the actual source of truth for account creation (layaway + cash orders), deletion, restructure, and carry-over operations. Admin toggling a permission in the matrix has real effect on these flows — no more hardcoded `has_role` checks ignoring the matrix.

**Functions migrated:** create-layaway-account, create-cash-order, delete-account, restructure-account, carry-over.

**DB pre-fix applied:** `edit_account` default tightened to admin-only (was admin+staff via legacy seed). Admin can grant other roles via matrix toggle.

**Known UI follow-up:** Bug #200 — EditAccountDialog UI gate at AccountDetail.tsx L1040 misgated, broader UI gate audit recommended.

**Remaining Item 4 scope:** Batch B (payment writes — 5 functions), Batch C (cash + schedule — 7 functions), Batch D (loyalty — 4 functions), Batch E (admin/finance + dashboard — 5 functions), Batch F (system-health-v2 + set-portal-pin — 2 special cases). 23 functions remain across 5 future sessions.

### Phase 2 Item 4 Batch B complete — 5 payment write functions on checkPermission (2026-06-11)

Batch B of the Item 4 batched migration plan complete. The role_permissions matrix UI in admin Settings is now the actual source of truth for payment record, void, restore, and underpayment acknowledgment operations. Admin toggling permissions in the matrix has real effect on these flows.

**Functions migrated:** record-payment, record-multi-payment, void-payment, restore-payment, accept-underpayment.

**Behavioral changes (user-approved, matches matrix intent):**
- Staff GAINS auto-confirm capability when recording payments (was admin+finance only)
- Staff + finance GAIN ability to accept underpayments (was admin-only)
- Void / restore payment behavior preserved (admin+finance)

**No DB pre-fix UPDATEs required** — matrix seeds already matched user policy intent per the "matrix is source of truth" directive.

**Remaining Item 4 scope:** Batch C (cash + schedule — 7 functions), Batch D (loyalty — 4 functions), Batch E (admin/finance + dashboard — 5 functions), Batch F (system-health-v2 + set-portal-pin — 2 special cases). 18 functions remain across 4 future sessions.

### Phase 2 Item 4 Batch C complete — 6 cash + schedule functions on checkPermission + 2 new cash keys (2026-06-11)

Batch C of the Item 4 batched migration plan complete. Cash payment operations now have dedicated permission keys independent from regular payment keys, allowing admin to grant cash void/restore access without affecting regular void/restore access (or vice versa). Schedule edit functions and payment amount edit now matrix-driven.

**Functions migrated:** void-cash-payment, restore-cash-payment, add-installment, delete-installment, extend-schedule, edit-payment-amount.

**New permission keys introduced (admin-only seed):** `void_cash_payment`, `restore_cash_payment`. Surfaced in PermissionMatrixTab UI under new "Cash Payments" section.

**Behavioral changes:** All migrations preserve current access (admin-only or admin+finance) per DB seeds matching prior code behavior. Future policy adjustments via matrix toggles.

**Scope carve-out:** submit-cash-payment deferred to Batch F. Its dual-path routing (customer self-submission vs staff submission) uses has_role for path discrimination, not permission gating. Requires careful refactor outside standard Batch C scope.

**Remaining Item 4 scope:** Batch D (loyalty — 4 functions), Batch E (admin/finance + dashboard — 5 functions), Batch F (system-health-v2 + set-portal-pin + submit-cash-payment — 3 special cases). 12 functions remain across 3 future sessions.

### Phase 2 Item 4 Batch D complete — 4 loyalty admin functions on checkPermission + new permission key + matrix UI (2026-06-11)

Batch D of the Item 4 batched migration plan complete. Manual loyalty point operations (adjust/award/revoke/restore) now matrix-driven. Service_role inter-function calls preserved unchanged — automated loyalty flows triggered by payment voids, account forfeitures, and reactivations continue to operate without permission gates (correct behavior).

**Functions migrated:** adjust-loyalty-points, award-loyalty-points, revoke-loyalty-points, restore-loyalty-points (user JWT paths only).

**New permission key introduced (admin-only seed):** `loyalty_revoke_points`. Surfaced in PermissionMatrixTab UI alongside existing `loyalty_adjust_points` under new "Loyalty Admin" section in Loyalty module.

**Bug #198 partial close:** 2 of 11 missing matrix UI keys now surfaced (loyalty_adjust_points + loyalty_revoke_points). 9 keys remain (approve_cash_order, edit_cash_order, manage_trade_ins, view_trade_ins, recalculate_balance, run_reconciliation, view_ai_risk, view_live_collection, view_operations_panel, view_system_health). Bug #198 remains open for follow-up.

**Behavioral changes:** None for existing users — all migrations preserve current access (admin-only or admin+finance) per DB seeds matching prior code behavior. Future policy adjustments via matrix toggles.

**Remaining Item 4 scope:** Batch E (admin/finance + dashboard — 5 functions), Batch F (system-health-v2 + set-portal-pin + submit-cash-payment — 3 special cases). 8 functions remain across 2 future sessions.

### Phase 2 Item 4 Batch E complete — 5 edge functions on checkPermission + 2 new matrix UI keys + DB seed cleanups (2026-06-11)

Batch E of the Item 4 batched migration plan complete. Read-heavy and finance-tier admin functions now matrix-driven. Service_role inter-function calls preserved unchanged in bulk-import (automated bulk import flows) and finance-reconciliation (Vault cron reconciliation).

**Functions migrated:** bulk-import (user JWT path), finance-reconciliation (user JWT path), generate-invoice, add-service, dashboard-summary.

**Matrix UI key reuse (no UI changes needed):** `bulk_payment_import` (existed at Finance → Vault & Bulk Import), `add_service` (existed at Services module, label "Manage Services"), `view_dashboard` (existed at Dashboard module).

**New matrix UI keys introduced:** `run_reconciliation` (admin+finance) and `generate_invoice` (admin+staff+finance) appended to Finance module under new "Reconciliation & Invoicing" section.

**Bug #198 advancement:** `run_reconciliation` was on the missing-keys list (DB had partial seed, matrix UI didn't surface it) — now surfaced. 8 of original 9 remain (approve_cash_order, edit_cash_order, manage_trade_ins, view_trade_ins, recalculate_balance, view_ai_risk, view_live_collection, view_operations_panel, view_system_health).

**Behavioral changes:** None for existing users — all migrations preserve current access per DB seeds matching prior code behavior. DB seed cleanups (UPDATE add_service staff=false, UPDATE bulk_payment_import finance=false) tightened DB to match stated intent and code behavior; no roles GAINED or LOST access since the partial seeds didn't correspond to active code gates.

**Remaining Item 4 scope:** Batch F (system-health-v2 + set-portal-pin + submit-cash-payment — 3 special cases). 3 functions remain across 1 future session.

### Phase 2 Item 4 Batch F complete — Phase 2 Item 4 NOW COMPLETE (28 of 28 functions migrated) (2026-06-11)

Batch F closes Phase 2 Item 4 — the matrix-driven access control migration. All staff-facing edge functions now use `checkPermission` for access control with matrix UI as the source of truth. Service_role inter-function calls preserved unchanged via `parseJwtClaims` across all dual-auth functions.

**Functions migrated in Batch F:**
- system-health-v2 — Bug #168 fix (string equality → parseJwtClaims) + has_role → `system_health` (existing key, DB seed updated to preserve any-of-4-staff)
- set-portal-pin — has_role → NEW `set_customer_pin` (admin+staff)
- submit-cash-payment — has_role dispatch → NEW `submit_cash_payment_staff` (admin+staff+finance; matrix-driven path discrimination, not access gating)

**Bug #168 fully closed:** Zero remaining string-equality auth checks against `SUPABASE_SERVICE_ROLE_KEY` across the entire `supabase/functions/` codebase.

**Phase 2 Item 4 cumulative — 28 of 28 functions migrated across 6 batches:**
- Batch A (commit 42cc3a6): 5 account lifecycle functions
- Batch B (commit 8d06b8d): 5 payment write functions
- Batch C (commit 573afd5): 6 cash + schedule functions
- Batch D (commit 3714cb8): 4 loyalty admin functions
- Batch E: 5 admin/finance + dashboard functions
- Batch F: 3 special-case functions (this batch)

**Permission keys introduced across Phase 2 Item 4:**
- Batch C: void_cash_payment, restore_cash_payment
- Batch D: loyalty_revoke_points (loyalty_adjust_points existed)
- Batch E: run_reconciliation, generate_invoice (existing keys bulk_payment_import, add_service, view_dashboard reused)
- Batch F: set_customer_pin, submit_cash_payment_staff (existing key system_health reused)

**Bug #198 advancement:** Total of 3 missing matrix UI keys surfaced across Item 4 work (loyalty_adjust_points, loyalty_revoke_points, run_reconciliation). 8 remain (approve_cash_order, edit_cash_order, manage_trade_ins, view_trade_ins, recalculate_balance, view_ai_risk, view_live_collection, view_operations_panel, view_system_health). Bug #198 remains open for follow-up sweep.

**Behavioral changes:** None for existing users — all migrations preserved current access per DB seeds matching prior code behavior. The matrix-driven design now functions end-to-end: admins toggle permissions in Settings UI, DB row_permissions table reflects intent, edge functions check against DB via checkPermission, access matches what UI shows.

**Remaining Phase 2 work outside Item 4 scope (future sessions):**
- Bug #198 final cleanup: 8 missing matrix UI keys
- Bug #200 follow-up: UI gate audit (EditAccountDialog L1040 misgating fix + comprehensive can() audit)
- riskFactor dead-code cleanup in dashboard-summary (L450, 455, 560, 562, 565)

## Operational Cleanups Log

### 2026-06-11 — Phantom Payment Cleanups (4 accounts, single-staff origin)

**Context:** During Bug #206 reclassification work, identified 4 duplicate payment entries from staff user `69095b5d-3a96-4b67-adad-7cbf9d6c2aff` (Brendalyn Bumagat) created 2026-06-11. All were manual Record Payment entries created BEFORE the matching customer submission was reviewed — resulting in duplicate payment rows once the customer submission was confirmed by the same or another staff member.

**Accounts cleaned:**

| Invoice | Phantom Amount | Type | Cleanup notes |
|---------|---------------|------|---------------|
| 18271 | ¥7,200 | Installment | Simple cleanup — no competing legit payment; DELETE allocations + DELETE payment + reset schedule row |
| 18437 | ¥5,597 | Installment | Required CORRECTIVE step: legit payment's allocation landed on Month 5 via waterfall post-phantom-delete; manually moved to Month 4 via UPDATE payment_allocations.schedule_id |
| 18644 | ¥20,320 | Multi-month installment | Phantom had 5 allocations spanning Months 2/3/4 + 3 penalty_fees rows; standard cleanup left penalty_fees.status='paid' but legit ¥20,320 submission self-healed it on confirm via waterfall re-allocation |
| 19090 | ¥3,000 | Downpayment | Simple cleanup — DPs don't allocate to layaway_schedule rows; DELETE payment only (no allocations to clean) |

**Cleanup approach evolution (lessons captured during the session):**
1. Initial pattern (18271): DELETE payment_allocations → DELETE payment → UPDATE layaway_schedule SET status='pending', paid_amount=0
2. Refined (18437): Added "move legit allocation" step when the legit payment was placed on the wrong schedule row by waterfall after phantom delete
3. Further refined (18644): Discovered `penalty_fees.status` does not auto-reset on allocation delete; if a legit submission is queued, status='paid' self-heals via re-allocation; otherwise manual UPDATE required
4. Simplest (19090): DPs are account-level not schedule-level — only delete the phantom payment, no allocation/schedule reset

**Operational concern:** 4 phantoms from one staff user in a single day indicates workflow misunderstanding (using Record Payment instead of Confirm Submission when a customer submission is queued). The matrix policy itself (staff.confirm_payment=true post-#206-revert) is correct; what needs adjusting is process awareness. Coaching message planned for 2026-06-12.

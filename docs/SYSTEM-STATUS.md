# System Status — last updated 2026-06-09

## App Version
1.2.0 (commit 02a040c)

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

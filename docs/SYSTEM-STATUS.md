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

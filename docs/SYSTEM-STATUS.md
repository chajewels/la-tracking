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
- P1: Loyalty redemption VOID lacks atomic rollback
  (process-loyalty-redemption, inline TS writes, no RPC wrapper)

## Resolved (do not re-list)
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

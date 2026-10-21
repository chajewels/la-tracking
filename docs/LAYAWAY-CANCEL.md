# Layaway Cancel (staff) — owner rules and mechanics

Added 2026-10-21. Plan: project doc `claude/cancel-layaway-plan-2026-10-21.md`
(owner "confirmed"). Trigger case: INV 19848 (CJ-2026-03704) earned 3,600 points
on its downpayment; the order was treated as cancelled outside the Hub, and no
Hub action could cancel a paid layaway, so the points were never reversed.

## Cancel is not forfeit (owner definition, 2026-10-21)

- **Forfeit** — the customer could not settle her dues (non-payment). Manual
  forfeit, the auto-forfeit sweep, extension, final forfeiture.
- **Cancel** — the customer VOLUNTARILY asked to cancel the plan.

Staff pick the one that matches what happened. They are different records and
different customer emails.

## Owner decisions

- Who may cancel a layaway: the Forfeit permission (`forfeit_account`). No new key.
- A payment submission still waiting (status `submitted`, on the account or via
  `payment_submission_allocations`) REFUSES the cancel until confirmed or rejected.
- Sales reports: a paid-then-cancelled layaway COUNTS LIKE FORFEITED
  (`get_monthly_sales`, `get_trade_kpis`, `get_trade_monthly_trends`). The marker
  is `layaway_accounts.cancelled_at`, set ONLY by the staff cancel; plans the
  deposit-expiry job sets to `cancelled` (unpaid web reservations) keep it NULL
  and stay out of sales.
- The customer gets an email (English only). Wording approved 2026-10-21; it
  never shows the staff reason and makes no promise about money paid.

## Locked rules it keeps

- Earned points revoked (`revoke_loyalty_points`, trigger `cancel`, spend from
  `loyalty_order_spend_basis`); REDEEMED points are NOT returned.
- A layaway NEVER auto-issues store credit; money received stays on the account
  (admin may issue credit manually).
- A paid order is never deleted; cancel requires a written reason.
- `last_purchase_at` untouched (a paid order later cancelled still counts).
- Cancel is TERMINAL: reactivate stays forfeited-only; the cancel never sets
  `expired_at`, so the web "Revive" path stays off. ONE exception (owner
  2026-10-21): a cancel made by the Page365 void sync
  (`page365_apply_invoice_stage`, source `page365_sync` or staff via the
  "Re-read Page365" button) is restored when the Page365 invoice is renewed —
  status, the schedule rows that cancel closed, the sales_log row and the
  revoked points come back; due dates are the originals. A manual Hub cancel is
  never restored. docs/PAGE365-IMPORT.md "Void sync".

## Mechanics

- ONE writer: `cancel_layaway_atomic` (migration 20261227100000, service_role
  only, preview mode writes nothing). One transaction: refusals; revoke; status
  `cancelled` + `cancellation_reason` / `cancelled_at` / `cancelled_by_user_id`;
  unpaid schedule rows `cancelled`; web stock back once (`stock_released_at`);
  `sales_log` row `Cancelled` + `eligible = false` (commission off); account note;
  audit row `cancel`. Page365 held stock is released by
  `trg_page365_stock_follow_layaway` (`cancelled` is a dead status there).
- Edge function `cancel-layaway` (`requirePermission('forfeit_account')`):
  calls the RPC; after commit, non-blocking: bell `account_cancelled` (+
  `loyalty_revoked`), portal notice "Points revoked", customer email
  (`_shared/layaway-cancel-email.ts`: web → storefront
  `email-templates/layaway-cancelled.tsx`; Hub → `layaway-cancelled` template).
- Cash orders: the existing cancel (`cancel_cash_order_atomic`,
  `terminate_web_order_atomic`) now also takes the `sales_log` row out of
  commission.

## Release record (2026-10-21)

- Released by PR #569 (`main@f7dc2a7`). Lovable declined to apply the migration
  (its migration tool writes drizzle/, package.json and bun.lock, which are
  frozen), so it was applied by Claude Code through the Lovable database
  connection with the owner's approval in chat, after a 0/0/0 drift check. All
  six after-md5s and the new function matched; `authenticated` cannot execute
  `cancel_layaway_atomic`.
- The eight edge functions were deployed by Lovable (deploy-only message, all
  source assertions passed).
- `20261227100100_record_live_cancel_layaway_bodies.sql` records the six
  patched bodies as live runs them; with it, live and repo agree on all 433
  functions (drift audit 0/0/0).
- INV 19848 (the trigger case) was manually FORFEITED by staff on 2026-10-21
  before the release; that forfeit already reversed its 3,600 points. It stays
  forfeited (a forfeited account cannot be cancelled).

## Guards (a cancelled account cannot be revived or charged)

- `allocate_payment_atomic` refuses a `cancelled` layaway (`final_forfeited` is
  NOT refused — same-day settlement rule 2026-10-20).
- `review-payment-submission` refuses to confirm a layaway submission on a
  cancelled plan (409 `account_cancelled`); `submit-payment` refuses new ones.
- `add-penalty`, `add-service` refuse a cancelled account (409).
- `void-payment`, `edit-payment-amount` and the `fix-account-status` tool keep
  the status of a `cancelled`, `forfeited` or `final_forfeited` account (owner
  2026-10-21): only cancel-layaway, reactivate-account and the forfeit paths
  move those statuses. Totals still update.

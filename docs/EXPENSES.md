# Finance → Expenses

Owner decisions 2026-10-25. Plan of record: Project doc `claude/expenses-plan-2026-10-25.md`.

## Why

Before this, the Hub recorded money coming in but no money going out. There was no
expenses table, and `fc_gross_profit()` still returns a flat 15% of sales because no real
cost exists anywhere. Payroll (Timesheet) and commission (Commissions) are calculated but
never recorded as paid.

## Phases

| # | Phase | Status |
|---|---|---|
| 1 | Expenses ledger (this doc) | built — migration `20261230100000_expenses_ledger.sql` |
| 2 | Payroll + commission "Mark as paid" (pages stay in CSR Operations) | built — migration `20261231100000_expenses_payroll_commission.sql` |
| 2b | General ledger core: chart of accounts, derived journals for every Hub money event, fiscal year (May–Apr), month close | built — migration `20270101100000_general_ledger_core.sql` (plan `claude/expenses-phase2b-ledger-plan-2026-10-25.md`) |
| 3 | Recurring bills + prepaid amortisation | built — migration `20270102100000_expenses_recurring_prepaid.sql` (+ prepaid column/events in the 2b file; plan `claude/expenses-phase3-recurring-plan-2026-10-25.md`) |
| 4 | Email bills → drafts (sales@ read directly; personal Gmail forwards to sales@) | built — migration `20270103100000_expenses_email_bills.sql` + edge function `expenses-email-bills` (separate Lovable deploy prompt; needs gmail.readonly in Google Admin; plan `claude/expenses-phase4-email-bills-plan-2026-10-26.md`) |
| 5 | Real cost of goods / inventory on every ledger; replaces the 15% | built — migration `20270104100000_expenses_cost_of_goods.sql` (plan `claude/expenses-phase5-cogs-plan-2026-10-26.md`) |
| 6 | Provider fees, clearing, FX revaluation | built — migration `20270105100000_expenses_clearing_fx.sql` (plan `claude/expenses-phase6-clearing-fx-plan-2026-10-26.md`) |
| 7 | Statements (P&L, balance sheet, cash flow) + 税理士 pack (CSV + PDF) | not started |
| 8 | Controls (period lock, bank reconciliation, completeness check) + full testing → owner-approved live apply → merge | not started |

All phases live on branch `feat/expenses` (PRs into it). Nothing merges to develop/main and no migration is applied to any database until the owner says so at the end (owner rule 2026-10-25). Staging is reserved for payment testing.

## Owner decisions (locked)

- One set of books: Cha Jewels Japan only. Each expense keeps its own currency (JPY or PHP).
- CSRs and Live Admins are contractors (no government contributions).
- Admin enters and approves (adjustable in Settings → Matrix).
- Categories: 8 groups, 28 subcategories — the owner's list, seeded by the migration. Removed by
  the owner: government contributions, director's compensation, contractors/agencies,
  cash-pickup fees, GCash fees, PH permits, and a separate non-expense outflows group.

## Phase 1 — how it works

### Data
- `expense_categories` — `group_key` (people, cost_of_goods, marketing, payment_fees, shipping,
  tech, office, professional), `name`, `sort_order`, `active`, `system_key` (reserved for
  automatic bookings: payroll, commission, bonus, trade_in, square_fees, paidy_fees,
  stripe_fees, photoroom).
- `expense_vendors` — name unique case-insensitively, optional default category.
- `expenses` — date, category, vendor, description, currency, amount, `fx_php_per_jpy`,
  `amount_jpy`, payment method, `receipt_path`, status, source, `source_ref`, notes, who/when
  for create, approve and void.

### Rules
- **Money:** `amount_jpy` = amount (JPY) or `round(amount / php_jpy_rate)` (PHP) — the ONE
  PESO RATE (CLAUDE.md currency standard). `fx_rates` is retired and never read. Set by the
  trigger `expenses_before_write` on insert and on every write that keeps a draft a draft or
  approves it; frozen after approval (draft → void keeps the figures, so a peso draft can be
  voided even with no rate set). `approve_expense` refuses a peso row with `rate_not_set`
  when the rate is missing. A ₱0.01 entry rounds to ¥0 — allowed.
- **Status:** every row is inserted as `draft` (the trigger refuses anything else). `draft` →
  `approved` (locked; counts in totals) or `void` (reason ≥ 3 chars; counts nowhere). A
  draft can also be voided. Nothing is ever deleted — the row trigger refuses DELETE and any
  change to an approved row other than voiding it; id / created_by / created_at never
  change; a statement trigger refuses TRUNCATE; INSERT/UPDATE/DELETE/TRUNCATE are revoked
  from PUBLIC, anon and authenticated (anon has no SELECT either).
- **No double booking:** `(source, source_ref)` is unique when `source_ref` is set. Later
  phases use it (e.g. `payroll` / `2026-10`, an email message id). Staff payroll and Sales
  commission (system_key `payroll` / `commission`) cannot be entered by hand
  (`category_booked_automatically`) — Phase 2 books them, and a manual row would count the
  same money twice. The dialog hides them. Bonuses and fees stay manual.
- **Writes:** the tables have no write policies. They are written only by:
  - `upsert_expense(p jsonb)` — create or edit a draft; vendor by `vendor_id` or
    `new_vendor_name` (reused case-insensitively, else created; two people creating the
    same name at once both get the one vendor). Needs `manage_expenses`. Edits are
    last-write-wins (no version check) — acceptable while only admin edits.
  - `attach_expense_receipt(p_id, p_path)` — path must be `<expense_id>/…`, draft only.
    Needs `manage_expenses`.
  - `approve_expense(p_id)` — draft only. Needs `approve_expenses`.
  - `void_expense(p_id, p_reason)` — draft or approved. Needs `approve_expenses`.
  Every change writes one `audit_logs` row (entity_type `expense`, or `expense_vendor` for a
  new vendor).
- **Read:** `get_expense_book(p_month)` returns categories, active vendors, the peso rate, the
  caller's rights and every expense in that month. Table SELECT policies allow
  `manage_expenses` OR `approve_expenses`.
- **Receipts:** private bucket `expense-receipts` (10 MB; JPG, PNG, WebP, HEIC/HEIF, PDF).
  Storage policies: read = manage or approve; upload = manage AND the first folder is an
  existing DRAFT expense id AND a file name follows (no `..`); no update, no delete. A
  replaced receipt's old file stays in the bucket. The Hub opens a receipt with a
  10-minute signed URL. HEIC files with an empty browser type are recognised by extension.
- **Client save order:** upsert → (form now carries the new id, so a retry edits the same
  draft) → upload → attach. If the upload or attach fails the draft is kept and the staff
  member is told to edit it to retry the receipt. Raw database error codes are never shown.
- **Approve** asks for confirmation (the row locks and the rate is fixed).

### Permissions
`manage_expenses`, `approve_expenses` — admin true; staff, finance, csr, live_agent false
(explicit rows). Shown in Settings → Matrix → Finance → "Expenses". The /finance page itself
still needs `view_finance`.

### Screens
- Sidebar: Finance → **Expenses** (after Vault), visible with manage or approve.
- `src/components/finance/ExpensesTab.tsx` (+ rules in `expenses.ts`, tests in
  `src/test/expenses.test.ts`): month picker (Japan time), approved total, drafts total
  (not counted), eight group tiles (click to filter), status / group / search filters,
  list with Edit (draft), Approve (draft), Void (with reason), receipt open; Add/Edit dialog
  with vendor list or new vendor, grouped category list, ¥/₱ amount with the yen preview,
  receipt upload, notes.
- Before the migration is applied the tab shows "Waiting for the database update".

### Verified before release (2026-10-25)
- Migration applied twice on a local PostgreSQL 16 with stand-ins for auth, roles,
  `has_permission` (verbatim), `system_settings`, `audit_logs` and storage: 17 test groups
  passed (permissions incl. a per-user override, conversion ₱10,000 → ¥23,810, rate re-read
  at approval and frozen after, approved/void locks and DELETE/TRUNCATE refusal even for a
  privileged writer, insert-as-draft only, `source_ref` uniqueness, manual payroll/commission
  refused, `rate_not_set`, peso draft voidable without a rate, month book, storage read and
  upload-path rules, anon refused).
- Independent code review (no blockers); its 7 should-fix items and 5 of its nits were fixed
  before the PR.
- `npx tsc -p tsconfig.app.json --noEmit` exit 0, no output; full Vitest suite passed; build
  passed; full lint unchanged from develop (no new problems).

## Phase 2 — Mark as paid (payroll, commission)

Owner decisions 2026-10-25: Timesheet and Commissions stay in CSR Operations; one expense per
month per source with the per-person breakdown inside; booked as Approved at once (money has
left); paid-on date defaults to today (JST) and is editable; if the pay figures change after
booking, the booked amount stays and the screen warns — re-booking = void in Expenses, then
Mark as paid again.

### How it works
- Both figures are computed in the browser (`timesheetEngine.computeMonth`,
  `commissionEngine.computeAllMonths`). The RPCs RECORD the lines the button sends.
- `book_payroll_month(p_month, p_paid_on, p_lines)` — lines `{user_id, name, template, total_hours,
  net}` (every active profile, zero pay included). One expense: category `payroll`, source
  `payroll`, source_ref `YYYY-MM`, PHP, description "Staff payroll — October 2026 (7 people)",
  `details = {month, kind, csr_net, liveadmin_net, lines}` (lines rebuilt from known keys only).
  Also upserts `timesheet_monthly_history` on its primary key `month_key`; the snapshot refreshes
  on each (re-)booking and is not touched by a void. Needs `approve_expenses`.
- `book_commission_month(...)` — lines `{name, role_won, earn, bonus, total, top_sales}` with total > 0
  (Top Sales bonus is inside the payout); category `commission`; no history write.
- Paid-on date: not in the future (Asia/Tokyo day) and not before the first day of the month being
  paid — enforced on the server and in the dialog. Lines: ≤ 500, names ≤ 120, role labels ≤ 60,
  numbers must be plain decimals (a bad value is `invalid_lines`, never a raw database error).
- Both go through `expenses_book_auto_month` (internal, not callable by clients): advisory lock per
  source+month → refuse `already_booked` when a non-void booking exists → INSERT draft → UPDATE to
  approved → two `audit_logs` rows (`book_*_month` create, `approve_expense`). The Phase 1 rules stay
  intact: INSERT must be a draft; manual entry into these categories stays refused; the trigger
  converts PHP at the one peso rate on the approve write.
- `expenses_source_ref_uq` now excludes void rows, so a voided month can be booked again.
- `get_booked_months(p_source)` — every booking of a source, all statuses, for the button states.
  Needs manage or approve.
- Refusals: `invalid_month` (not first-of-month, future, or before 2020), `invalid_paid_on`,
  `invalid_lines`, `already_booked`, `rate_not_set`, `permission_denied`.

### Screens
- `src/components/finance/MarkPaidPanel.tsx` (+ rules `mark-paid.ts`, hook `useBookedMonths.ts`, tests
  `src/test/mark-paid.test.ts`): under **Timesheet → Cost Master** GRAND TOTAL and under
  **Commissions → Monthly → Payout Breakdown**. Shown only with `approve_expenses`. Not booked →
  total + ≈ ¥ + **Mark as paid** → dialog (paid-on date, the rows, total) → confirm. Booked → "Paid
  on 1 Oct 2026 · ₱… (≈ ¥…)" + **View in Expenses** — opens the month the expense is DATED
  (the paid-on month, where the Expenses tab lists it; September payroll paid 1 Oct → October);
  amber warning when the screen's total differs from the booked amount. Voided → button again
  with "The previous booking for this month was voided." The button is disabled only by the month
  (future, nothing to pay), with the reason shown as text; the paid-on date is checked in the
  dialog. Before the migration: "Mark as paid will appear here once the expenses update is
  applied." A read error shows "Could not load the booking state".
- **Finance → Expenses**: Source filter (All / By hand / Payroll / Commission), a source badge on
  non-manual rows, a "Details (n)" expand showing the breakdown, and `?month=YYYY-MM` opens that
  month.

### Verified
- Local PostgreSQL 16: Phase 1 + Phase 2 migrations applied twice; Phase 1 suite (17 groups) and
  Phase 2 suite (5 groups: permissions incl. manage-only read, validation, booking + sum +
  conversion + description + details + two audit rows + history upsert, double booking refused,
  void then re-book, commission booking, approved-row lock incl. details, history unique).
- tsc exit 0; Vitest expenses (20) + mark-paid (9) pass.

## Phase 2b — Finance → Ledger (general ledger core)

Owner decisions 2026-10-25 (21:15 JST): books are Cha Jewels Japan only, in yen at the ONE PESO RATE —
one Sales account, no JP/PH split, no tax flag (D2). A plan or cash order is a sale on the day of its
FIRST non-void payment (D1). Payment spellings map per the seed below (D3). Loyalty points used as
payment are a sales discount (4160, D4); store credit the owner grants by hand is a sales discount
(4170, D5). A change landing in a closed month is posted on the first day of the next open month with
the original date kept (D6). Fiscal year April–March (owner 2026-10-26 from the accountant's 試算表, which runs 自4月1日; supersedes the May–April reading of F1); approvals owner/admin only (F3); the start
date and opening balances wait for the accountant's figures (F6).

### How it works
- **Derived, not hooked.** No payment / plan / order / store-credit code was changed. `gl_current_events(p_until)`
  builds every money event the ledger should hold (from `ledger_start_date`), each with its lines as jsonb;
  `gl_post_pending()` diffs that against the live `auto` journals: a live journal whose event vanished or
  changed (fingerprint = accounts, sides, amounts and currencies of the lines — never memos or descriptions —
  plus the event date, except close events whose date may fall back to `updated_at`) gets a REVERSAL (dated
  today, carrying the ORIGINAL yen),
  and every event without a live journal gets a new one. One live auto journal per `(source_type, source_id)`
  (partial unique index). This covers direct table UPDATEs (RLS lets staff void/edit `payments`), RPCs and
  edge functions alike, and is the completeness check and the backfill engine.
- **Events:** `layaway_sale` (Dr 1200 full price / Cr 4100, shipping → 4300), `payment` (Dr mapped account /
  Cr 4400 penalty allocations / Cr 1200 rest; `loyalty_redemption` → Dr 4160; `store_credit` → Dr 2300),
  `layaway_close` (forfeited / final_forfeited / cancelled, dated at forfeited_at / cancelled_at — plans sold
  before the ledger start still post their close: Dr 4150 / Cr 1200 remaining; Dr 4100 / Cr 4500 money kept =
  total − remaining − store credit issued from the plan), `cash_order_sale` / `cash_payment` /
  `cash_order_close` (same on 1210; shipping + COD fee → 4300), `store_credit_issue` (Dr 4150 for
  cancellation sources, 4170 otherwise / Cr 2300; voided lots never post), `store_credit_use` (redeemed →
  Dr 2300 / Cr 1200 | 1210 | 4100 when no Hub order; expired → Cr 4900), `expense` (approved only: Dr
  category `gl_account_code` / Cr `paid_from`, fallback by method, cash → 1010/1020 by currency, else 1190),
  `square_refund` (COMPLETED, production), `paidy_refund`, `web_refund` (refund_status = refund_issued and
  no provider refund row). Test rows (`is_test`) never post.
- **Money:** every line stores native amount + currency + `fx_php_per_jpy` + yen; a PHP journal whose lines
  round apart is balanced by putting the ≤ n-yen difference on its LARGEST credit line (never below zero).
  Each event posts in its own sub-transaction: one that cannot balance is counted as `failed` with its error
  in `gl_posting_runs.note` and the rest of the run goes through. Totals and the trial balance are yen.
- **Periods:** `close_period` first runs the posting engine for pending events and refuses with
  `posting_failed` if any event failed. `gl_periods` by calendar month; `fiscal_year` = the year the April–March year ENDS (June 2026 →
  FY2027). `close_period` closes in order (earlier months first, only ended months, never before the start);
  `reopen_period` reopens only the latest closed month, with a reason. `gl_posting_date()` moves an event in
  a closed month to the first day after the last closed month; `source_date` keeps the real date.
- **Spellings:** `gl_payment_method_map` (lower, trimmed). Seeded: rakuten / rakuten bank → 1102; sumitomo /
  sumitomo bank → 1101; jp_bank → 1103 Japan Post Bank; paypay → 1122; bdo → 1111; bpi → 1112; metrobank →
  1113; gcash → 1121; cash / cash payment → 1010 (JPY) or 1020 (PHP); cash_pickup → 1020; genkin_kaketome →
  1010; cod / cash on delivery → 1140 COD receivable; square / credit_card → 1130; paidy → 1131; stripe /
  konbini → 1132; loyalty_redemption → 4160; store_credit → 2300; transfer (website orders) / bank transfer /
  bank_transfer / other / card / auto_debit → 1190 (suspense). Unknown spellings also post to 1190 and are listed in the Ledger
  status strip; `set_payment_method_map` saves a mapping and reposts at once.
- **Expenses gain `paid_from`** (which 1xxx account paid it): the Add/Edit dialog's "Paid from" (required
  unless paid in cash, only once the ledger RPCs exist), saved with `set_expense_paid_from` after the upsert.
  Approved rows may change ONLY `paid_from` (the Phase 1 trigger is re-stated with that single allowance,
  approve_expenses needed); the ledger reposts the expense on the next run. Approved non-cash expenses
  without it are listed in the Ledger status strip.
- **Writes:** tables have no write policies; INSERT/UPDATE/DELETE/TRUNCATE revoked; row triggers refuse any
  UPDATE/DELETE on lines and any journal UPDATE other than posted → reversed; a deferred constraint trigger
  refuses an unbalanced journal at commit. RPCs: `gl_post_now`, `post_manual_journal` (kinds manual /
  opening; opening must be dated on the start date; balanced in yen; open month; ≤ 50 lines), `reverse_journal`
  (manual / opening only — auto journals follow their source), `set_payment_method_map` (post_journal);
  `close_period`, `reopen_period`, `set_ledger_start` (first of a month; frozen once journals exist)
  (close_period); `upsert_gl_account` (admin_settings; system accounts cannot be deactivated). Reads
  (`view_ledger`): `get_ledger_status`, `get_ledger` (range, account, source, kind, search, paged ≤ 500),
  `get_trial_balance` (opening / debits / credits / closing per account), `get_chart_of_accounts`,
  `get_paid_from_accounts` (also manage / approve_expenses). Every write adds an `audit_logs` row.
- **Schedule:** pg_cron `gl-post-pending` at 15:40 UTC = 00:40 JST (after penalty-engine 00:05 and
  auto-forfeit 00:10); skipped where pg_cron is absent (local harness). Refusals: `ledger_start_not_set`,
  `rate_not_set`, `invalid_date`, `period_closed`, `period_not_ended`, `earlier_period_open`, `already_closed`,
  `later_period_closed`, `unbalanced`, `invalid_lines`, `opening_must_be_start_date`,
  `auto_journal_follows_source`, `ledger_has_journals`, `invalid_account`, `permission_denied`.

### Permissions
`view_ledger`, `post_journal`, `close_period` — admin true; staff, finance, csr, live_agent false. Shown in
Settings → Matrix → Finance → "Ledger".

### Screens
- Sidebar: Finance → **Ledger** (after Expenses), with `view_ledger`. `src/components/finance/LedgerTab.tsx`
  (+ rules `ledger.ts`, tests `src/test/ledger.test.ts`): status strip (posting summary, last run, start date,
  rate; **Start the ledger** until the date is set; **Post now**; **Manual journal**; amber lists for unmapped
  spellings with an inline map-and-repost row and for approved expenses without "Paid from"); sub-tabs
  **Journals** (month / quarter / fiscal-year range, kind / source / account filters, search, expandable
  lines with native and yen amounts, "moved" badge, Open source link, Reverse for manual journals),
  **Trial balance** (range picker, revenue / cost of sales / gross / expenses / operating profit tiles,
  grouped rows with opening / debits / credits / closing / accountant's-view balance, CSV download),
  **Accounts** (chart with balances, add / deactivate for admin, spelling → account mappings), **Months**
  (fiscal-year grid April–March with Close / Reopen-with-reason).
- Before the migration the tab shows "Waiting for the database update".
- Finance Overview profit is unchanged (the flat 15% waits for Phase 5 cost of goods).

### Verified (2026-10-25)
- The harness lives in `supabase/tests/expenses/` (`run.sh`; not a Supabase test, never touches a Lovable
  database). Independent review (one blocker — double-posted store-credit redemption — and nine should-fixes)
  applied before the PR.
- Local PostgreSQL 16 with stand-ins for the live money tables: Phase 1 + 2 + 2b migrations applied twice;
  Phase 1 (17) and Phase 2 (5) suites still pass with 2b on top; the 2b suite (11 groups): start-date gate,
  permissions (finance / staff denied, RLS hides the chart), first posting of 7 events and an idempotent
  second run, account and conversion checks (Rakuten → 1102, PHP at 0.42 with the rate stored, shipping →
  4300, penalty allocation → 4400, COD → 1140, test / pre-start / zero-payment plans excluded), trial balance
  ties and July opening = June closing, voided payment → reversal with the original yen, edited amount →
  reversal + repost, a sale vanishing when its only payment is voided, unknown spelling → 1190 → mapped and
  reposted, loyalty redemption → 4160, forfeiture lines and balance, reactivation reverses, cancellation
  credit → 4150, voided lot never posts, redeemed → 1200, only the completed production Square refund,
  expense draft not posted / approved posted / Paid from suspense → set on an approved row → reposted,
  auto journals refuse hand reversal, close order / current month / twice, FY2027 for June 2026, manual
  journal refusals (closed month, unbalanced, bad account, opening date) and a PHP manual journal, manual
  reversal, reopen order, start date frozen, closed-month event moved to 1 July with source_date kept,
  immutability (UPDATE / DELETE / TRUNCATE / unbalanced direct insert refused for a privileged writer),
  whole ledger balanced and totals = lines.
- `npx tsc -p tsconfig.app.json --noEmit` exit 0; Vitest ledger (14) + expenses (20) + mark-paid (9) and the
  full suite (113 files) pass; build passes; full lint unchanged (881 / 150).

## Phase 3 — Recurring bills + prepaid amortisation

Owner decisions 2026-10-25 23:09 JST (D1–D6 as recommended): frequencies monthly / quarterly / yearly; the
draft appears on the due day; per-bill "spread over N months" switch (prepaid), off by default; Approve = paid
stays (accounts payable waits for Phase 8); only the current due cycle is generated — never a backlog; no
staff bell — the Expenses tab's "Bills to confirm" strip is the reminder.

### How it works
- **Templates** `expense_recurring_bills` (name, category, vendor, description = the draft's text, currency,
  expected amount, payment method, paid_from, frequency, due_day 1–28, starts_on, ends_on, spread_months
  2–36, active, notes, next_due_on, last_generated_on). RLS read = manage or approve; writes only through
  `upsert_recurring_bill(p)` / `set_recurring_bill_active(id, bool)` (manage_expenses, audited). Never deleted
  (trigger). First due = the due day in the start month if not yet passed, else the next month
  (`recurring_first_due`); `recurring_next_due` adds 1 / 3 / 12 months.
- **Generation** `expenses_generate_recurring(p_as_of, p_uid)` (internal; pg_cron `expenses-recurring` at
  15:20 UTC = 00:20 JST, before the ledger run at 00:40): for every active bill with `next_due_on ≤ as-of`,
  ONE DRAFT expense for the LATEST due cycle on or before as-of that is still within ends_on
  (`source = 'recurring'`, `source_ref = '<bill id>:<due date>'`, description / amount / method / paid_from /
  prepaid_months copied, `details = {kind, bill_id, bill_name, due_on, expected_amount, frequency}`), then the
  bill points at the next cycle after as-of (no backlog). A draft is only created when that cycle is still the
  CURRENT one — a bill whose last cycle before ends_on is already a cycle or more in the past is ended without a
  stale draft. A bill past ends_on is deactivated; shortening ends_on below the next due date deactivates it at
  save time. Editing a bill's schedule (start, due day, frequency) re-anchors to the month AFTER the last
  generated cycle, so an already-covered month is never drafted twice. One bad bill is counted as `failed`
  (with the error in the result) and the others still generate. The Phase 1
  partial unique index keeps one non-void draft per cycle, so a voided draft can be regenerated.
  `generate_recurring_now()` (manage) runs the same from the tab; `generate_recurring_now(bill, date)` makes
  a one-off draft for a chosen due date (within the bill's life, not more than 31 days ahead) without moving
  the schedule — refuses `already_generated` when that cycle has a non-void expense.
- **Confirming**: the Expenses tab shows "Bills to confirm (n)" above the list when recurring drafts exist in
  the month, with Edit (real amount, receipt) and Approve (existing dialog). Source filter gains "Recurring
  bills"; the row shows the bill name and the spread. "Recurring bills" button (manage; approve-only users
  can look) opens the templates dialog: list with next due / last draft / Active switch, Add / Edit form
  (first-due preview), "Generate due bills now", "One-off draft…".
- **Prepaid**: `expenses.prepaid_months` (2–36; column lives in the 2b migration file since both are
  unapplied). Set from a bill's spread, or by hand on a draft (`set_expense_prepaid`, manage_expenses only;
  "Spread over months" in the Add/Edit dialog, saved after the upsert like Paid from). Refused
  (`amount_too_small_to_spread`) when the yen amount is below 2 × N, and a bill's spread is dropped on a draft
  (details.spread_dropped) for the same reason — so no month ever releases ¥0. Locked once approved (the 2b
  trigger lists it with the locked columns). Ledger: an approved prepaid expense posts Dr **1400 Prepaid
  expenses** / Cr paid_from (E6) — every expense journal now carries the yen frozen at approval
  (`amount_jpy`), so a later rate change cannot leave 1400 unbalanced; the new event `expense_amortisation`
  posts, at each month end from the expense month for N months (only month ends ≤ today), Dr category account
  / Cr 1400 for floor(amount_jpy / N) yen with the last month taking the remainder (PHP native shares
  round(amount / N, 2) likewise; JPY native = yen), so the N releases sum exactly to the posted prepaid amount. Source id = `md5(expense id || ':' || YYYY-MM)`
  cast to uuid. Voiding the expense reverses the payment and every release (events vanish).
- Refusals: `invalid_name / category / vendor / description / currency / amount / payment_method / account /
  frequency / due_day / date / spread / notes`, `category_booked_automatically`, `already_generated`,
  `not_found`, `not_draft`, `rate_not_set`, `permission_denied`.

### Verified (2026-10-25)
- Local PostgreSQL 16: all four migrations applied (Phase 3 twice); Phase 1 (17), Phase 2 (5) and ledger (11)
  suites still pass; new `supabase/tests/expenses/test_recurring.sql` (8 groups): permissions and RLS,
  template validation incl. first-due math and audit rows, generation (nothing due / latest cycle only /
  idempotent / schedule advanced / details and paid_from copied / next cycle), void + one-off regeneration +
  `already_generated` + before-start refused + generate-all, quarterly / yearly math, ends_on deactivation,
  yearly draft carries the 12-month spread, prepaid ledger (1400 on approval, one release per elapsed month
  end, 12000 / 10 each, balanced, idempotent, void reverses all), PHP prepaid split sums exactly in both
  currencies, never deleted.
- Independent review applied before the PR: frozen yen on expense journals (rate change could leave 1400
  unbalanced), zero-yen releases refused up front, schedule-edit re-anchoring, stale final cycle not drafted,
  ends_on shortening, set_expense_prepaid manage-only, per-bill failure isolation, prepaid_months in the
  approved-row lock list, 44 px targets, one-off date left empty, older open drafts surfaced on the tab.
- tsc exit 0; Vitest recurring (6) + full suite (114 files) pass; build passes; lint unchanged (881 / 150).

## Phase 4 — Emailed bills → draft expenses

Owner decisions 2026-10-26 (D1–D6 as recommended): the Hub reads **sales@chajewelsjp.com** itself (read-only,
service account + domain-wide delegation; the personal Gmail forwards bills there with a filter); every 30
minutes; a confident bill becomes a DRAFT expense (never approved automatically), an unsure one waits in
"Needs review", newsletters are skipped; a bill matching a recurring draft within ±7 days / ±1% is attached to
it instead of making a second draft; unknown categories land in a holding category that blocks approval
until the owner picks a real one; attachments go on the draft as the receipt; off by default
(`expenses_email_enabled`) until Google Admin grants the scope.

### How it works
- **Edge function `expenses-email-bills`** (JWT verified; caller needs manage_expenses, or the service role
  from pg_cron `expenses-email-bills` at `7,37 * * * *`): reads `expenses_email_context()` (enabled, mailbox,
  categories, lookback), stops with `skipped: disabled` when off, gets a Gmail token for the mailbox
  (`getServiceAccountAccessToken({ scopes: [gmail.readonly], subject: mailbox })` — `_shared/google-auth.ts`
  now takes scopes + subject), lists `newer_than:Nd -in:spam -in:trash -in:chats` (≤ 100, unknown ids only,
  ≤ 25 per run), then per message: full fetch, text (plain preferred, HTML stripped) + up to 5 receipt-like
  attachments ≤ 10 MB, vendor hint from the sender (`VENDOR_HINTS`), Lovable AI (`google/gemini-3.8-flash`,
  JSON only: is_bill, vendor, amount, currency JPY|PHP|OTHER, bill_date, description, category from the allowed
  list, confidence, reason), then `decide()`: **drafted** when is_bill ∧ confidence ≥ 0.6 ∧ amount ∧ currency
  JPY|PHP; **needs_review** when unsure, another currency, no amount, or the sender/subject looks like a bill
  the model rejected; **skipped** otherwise. A drafted bill first tries `expenses_email_match_recurring` →
  `expenses_email_attach_to_draft` (status **matched**, receipt copied onto the recurring draft, real amount
  noted in details), else attachments are stored under `expense-receipts/<new expense id>/…` and
  `expenses_create_email_draft(p)` inserts the draft (`source = 'email'`, `source_ref = gmail message id`,
  details = the extraction). Needs-review attachments are stored under `email/<message id>/…` so "Make
  expense" can copy them later. Every message is recorded in `expense_email_messages` (status, confidence,
  extraction, attachments, expense link) — the function never modifies, labels or deletes mail. Every run
  is one `expense_email_runs` row (counts, note with the first errors).
- **Rules are pure** (`supabase/functions/_shared/email-bills-rules.ts`, pinned by `src/test/email-bills.test.ts`):
  header parsing, base64url, part walking, HTML stripping, hints, prompt, response parsing, decision, amount
  rounding (whole yen), category lookup, date fallback (bill date ≤ today, else received date).
- **Database** (`20270103100000_expenses_email_bills.sql`): settings `expenses_email_enabled` ("false") and
  `expenses_email_mailbox`; holding category `system_key = 'uncategorised'` ("Needs a category (from email)",
  office group, 6900) whose drafts cannot be approved (trigger `expenses_refuse_uncategorised_approval`,
  `category_required`); `expense_email_messages` + `expense_email_runs` (RLS read manage|approve; writes only
  via RPC); service-role RPCs `expenses_email_record`, `expenses_create_email_draft`,
  `expenses_email_match_recurring`, `expenses_email_attach_to_draft`, `expenses_email_run`,
  `expenses_email_context` (refuse a signed-in caller); owner RPCs `get_email_bills(days)`,
  `email_bill_make_expense(message id, form)` (manage; same validation as a manual draft, returns the stored
  attachments so the client copies the first onto the new draft), `email_bill_dismiss`,
  `set_email_bills_enabled` (admin_settings, audited). Housekeeping deletes skipped rows older than 90 days.
- **Screens**: Expenses tab → "Emails" button opens the Emailed bills dialog (status card: mailbox, last
  check, on/off switch for admin, "Check mail now" for manage; messages of the last 30 days grouped Needs
  review / Could not be read / Draft created / Attached / Skipped / Dismissed, with Make expense + Dismiss).
  "Make expense" opens the normal Add dialog prefilled ("Expense from email"); saving calls
  `email_bill_make_expense` and copies the attachment. A "From email (n)" strip above the list shows email
  drafts in the month; a draft still in the holding category shows "needs a category" and its Approve is
  disabled until the category is changed. Source filter gains "Emailed bills".
- Refusals: `permission_denied`, `disabled`, `gmail_auth_failed` (scope not granted), `gmail_list_failed`,
  `already_generated`, `not_found`, `category_required`, plus the Phase 1 field codes.

### Verified (2026-10-26)
- Local PostgreSQL 16: all five migrations applied twice through one `run.sh` (restructured: the ledger suite
  and the recurring + email suites each run on a clean book); Phase 1 (17), Phase 2 (5), ledger (11),
  recurring (8) pass; new `test_email_bills.sql` (7 groups): grants / RLS, permissions, service-role recording
  (never downgrades a drafted row), draft creation with fallback category + approval blocked until
  recategorised, recurring match + attach (±7 d / ±1 %) and no match outside, owner actions (make expense
  from a needs-review message, already_generated, dismiss, enable switch audited), staff scope, housekeeping.
- Independent review applied before the PR: "Make expense" now reads the client's `new_vendor_name` key (the
  vendor was silently dropped); the holding category is hidden from the manual picker and the main list's
  Approve is disabled for drafts still in it, with `category_required` mapped to a sentence; the recurring
  match requires the vendor to agree whenever one was read (category alone only when no vendor; vendors under
  3 letters ignored) and never re-attaches to a draft that already carries an email; one run at a time
  (`run_active`, 10-minute stale guard); a second run that finds the draft already made records it as drafted
  with the existing expense; Gmail listing pages through the window; `..` collapsed in file names; the
  dialog reads the function's error body so `gmail_auth_failed` shows its own sentence.
- Edge function: `deno lint` + `deno check` clean (existing google-auth callers still type-check).
- tsc exit 0; Vitest email-bills (11) + full suite (115 files / 1,866) pass; build passes; lint unchanged
  (881 / 150).

### Hand-over before switching on (owner, after the live apply)
1. Google Admin → Security → API controls → Domain-wide delegation → the Hub's existing client → add scope
   `https://www.googleapis.com/auth/gmail.readonly`.
2. In the personal Gmail, a filter forwarding bills to sales@chajewelsjp.com (forwarding address verified).
3. Lovable prompt (separate from the SQL) to deploy `expenses-email-bills`; `LOVABLE_API_KEY` is already set.
4. Finance → Expenses → Emails → switch On, then "Check mail now".

## Phase 5 — Real cost of goods / inventory

Owner decisions 2026-10-26 (D1–D6 as recommended): a sale's cost is finance-set, else the product's cost basis
snapshot, else MISSING — never an estimate; inventory purchases go to the 1300 asset and reach cost when the
piece sells; trade-ins enter 1310 at the trade amount (revenue grossed back to the full price) and leave it at
resale; backfill by per-sale entry + CSV import by invoice number; the Executive Dashboard's 15 % tiles are
replaced with ledger figures; only manage_expenses sets costs, hidden from staff everywhere. Same day the owner
confirmed the fiscal year is **April–March** (the accountant's 試算表 runs 自4月1日) — `fiscal_year_start_month`
is now "4" in the 2b migration file.

### What existed (2026-10-26)
One cost field in the whole Hub (`website_product_variants.cost_basis`, admin-only) with 0 of 456 variants
filled; 81 of 1,623 layaways and 54 of 210 cash orders have product lines at all; the 15 % lived in
`fc_gross_profit` / `fc_plan_performance` / `fc_coverage_ratio` (0.85) behind the Executive Dashboard; trade-ins
had no link to stock or resale and the new plan's price is already net of the trade credit.

### How it works
- **`sale_costs`** (sale_type layaway | cash_order, sale_id, cost_jpy whole yen, note, set_by/at): the finance-set
  cost of one sale. RLS read view_ledger; writes only via `set_sale_cost(type, id, cost | NULL to clear, note)`
  and `import_sale_costs([{invoice_number, cost_jpy, note}])` (≤ 2,000 rows; matches layaway then cash-order
  invoice numbers; reports set / replaced / not_found / ambiguous / invalid) — both manage_expenses, audited
  (`sale_cost` set / change / clear).
- **Item snapshot** `sale_item_costs` (item_table, item_id, sale_type, sale_id, variant_id, quantity, cost_jpy):
  a FINANCE-ONLY table (RLS view_ledger; the item tables themselves never carry a cost because customers and
  CSR can read them). Filled by an AFTER INSERT trigger from the variant's cost basis (SECURITY DEFINER, so a
  client insert still snapshots), by a catch-up trigger when a variant first gets a cost, and by a backfill in
  the migration; the unit cost never changes afterwards (quantity follows the line). Effective sale cost
  (`gl_sale_costs()`, internal) = a resold trade-in's trade amount (source `trade_in`, see below), else the
  sale_costs row, else Σ unit cost × qty when every line has a snapshot, else NULL (missing).
- **Ledger** — `gl_current_events` is now `gl_base_events` (the 2b body, renamed once by the Phase 5 file)
  UNION `gl_cogs_events`: `cogs_sale` Dr 5100 / Cr 1300 at the sale date (first non-void payment), per sale
  with a cost; `cogs_return` Dr 1300 / Cr 5100 when a forfeited / cancelled plan (or cancelled / expired order)
  puts the piece back, dated like the close; `trade_in_received` Dr 1310 / Cr 4100 trade_amount on date_trade;
  `trade_in_resold` Dr 5500 / Cr 1310 when `resale_status` = Sold (new `trade_ins.resold_at`: a flip to Sold
  always stamps now — a client cannot move it; an INSERT may carry a historical date; cleared when back in
  stock; existing Sold rows backfilled with date_trade). New `trade_ins.resold_invoice_number` (Services →
  Trade-ins, "Resold on Invoice #", shown when Sold): the sale on that invoice takes its cost from the trade-in,
  so `cogs_sale` skips it (no 5100 + 5500 double count) and the tab shows it as covered. Trade-ins whose new or
  resold invoice is a test plan are excluded. `cogs_return` shares the close-date fingerprint exemption with the
  close events (added to the 2b file), so a legacy forfeited plan whose `updated_at` moves does not churn.
  Source ids are `md5('<kind>:<sale type>:<id>')::uuid`. A changed cost re-posts through the normal
  reversal + repost; a sale without a cost posts nothing. Documented asymmetry: a trade-in received before
  the ledger start and resold after it credits 1310 with no prior debit — correct only when the opening
  balance carries it in 1310.
- **Category remap**: "Inventory purchases" → 1300, "Trade-in buybacks" → 1310. Goldsmith / appraisal /
  packaging / carrier stay period costs (5200 / 5250 / 5300 / 5400).
- **Accounts added for the accountant's books** (opening balance later): 1104 Kameari Shinkin, 1195 Suspense
  payments (仮払金), 2700 Short-term loans, 2750 Long-term loans, 2800 Withholding and deposits (預り金),
  2900 Suspense receipts (仮受金), 6950 Interest paid.
- **Screens** — Finance → Ledger gains a **Cost of goods** tab: month picker; Sales booked / Revenue / Cost of
  goods known ("real cost on N of M sales") / Cost missing (+ older missing since the ledger start); every sale
  with invoice link, pieces, revenue, cost source badge, Set / Change cost (yen + note; "Clear cost" on a manual
  one) and **Import costs (CSV)**; an **Inventory** card (ledger 1300 / 1310, website stock at cost marked
  PARTIAL — supplier / preloved stock without a product line is not on the website — and the informational
  website − ledger gap) with "Post stock-count adjustment…": the owner types the COUNTED stock value at cost,
  the adjustment is counted − ledger 1300 (manual journal 5900 ↔ 1300, reason required, post_journal) — never
  derived from the partial website figure; plus a nudge listing how many variants have stock but no cost basis. The Trial balance tiles say
  "real cost on N of M sales" under Cost of sales. Executive Dashboard: "Gross Profit (ledger)" and "Inventory
  at Cost" tiles (`fc_real_profit`, view_ledger; "Set the ledger start in Finance → Ledger" until then), cash-flow
  coverage computed from the ledger inventory (— when it is zero), the two 15 % plan-table columns removed.
  Website → Products shows "no cost" under stock for admins when a variant has stock without a cost basis.
- **RPCs**: `get_sales_costs(month)`, `set_sale_cost`, `import_sale_costs`, `get_inventory_valuation`,
  `fc_real_profit(from, to)`. The old `fc_gross_profit` / `fc_coverage_ratio` / `fc_plan_performance` still exist
  but no 15 % figure is shown anywhere.
- Refusals: `invalid_sale`, `not_found`, `invalid_amount` (whole yen), `invalid_note`, `invalid_rows`,
  `permission_denied`, plus the 2b manual-journal codes for the adjustment.

### Day one
Every sale shows "cost missing" and gross profit equals revenue until costs are entered (per sale, by CSV, or
from the product cost basis for new stock). Opening inventory comes from the accountant's final figures
(¥44,432,668 at 30 Sep 2026 on the provisional 試算表 — not posted; see
`claude/accountant-trial-balance-2026-09.md`).

### Verified (2026-10-26)
- Local PostgreSQL 16: six migrations applied twice through one `run.sh`; Phase 1 (17), Phase 2 (5), ledger (11),
  recurring (8), email (7) still pass; new `test_cogs.sql` (8 groups): item snapshot (finance-only table, no cost
  column on the item tables, immutable, later cost-basis change ignored, catch-up when a variant gets a cost,
  costless line → missing), category remap + accountant accounts,
  permissions (staff / finance / anon; table writes revoked), set / clear / validation / import (symbols
  stripped, not found, invalid, replaced, empty refused), cogs_sale postings (dated at the sale, balanced, no
  cost → nothing, idempotent, change → reversal + repost, late cost), cogs_return on forfeiture (and no churn when updated_at
  moves), purchase → 1300, trade-in received / resold with the resale invoice link (no cogs_sale) / un-sold,
  valuation and real-profit figures.
- Independent review applied before the PR: the cost snapshot moved off the customer/CSR-readable item tables
  into finance-only `sale_item_costs` (the column would have been readable through the REST API); the backfill
  of existing lines actually runs (the old BEFORE trigger made it a no-op) and a variant that gets its cost
  later costs its existing lines; `cogs_return` joined the close-date fingerprint exemption (no churn on legacy
  forfeited plans); the stock-count adjustment now comes from a counted value, not the partial website figure;
  resold trade-ins are linked to the resale invoice so the cost is never counted twice; trade-ins on test plans
  excluded; `resold_at` cannot be moved by a client.
- tsc exit 0; Vitest cogs (7) + ledger (14, April–March) + full suite (116 files / 1,873) pass; build passes;
  lint unchanged (881 / 150).

## Phase 6 — Provider fees, clearing, own-account transfers, peso revaluation

Owner decisions 2026-10-26 (D1–D6 as recommended): Square fees booked from each payment; finance records
Square / Paidy / Stripe payouts and courier COD remittances on a Clearing screen (courier charges → 5400);
"Record transfer" for money moved between the company's own accounts (fee → 6300, bank-rate difference →
FX gain / loss); month-end revaluation of every peso balance at the rate in effect, with a rate history
that logs every change; settlements and transfers need post_journal.

### What existed (2026-10-26)
Clearing accounts (1130 Square, 1131 Paidy, 1132 Stripe, 1140 COD) were debited at capture and never
cleared; nothing touched 6300 / 4950 / 6800 except hand-entered expenses. Square's processing fee lived only
inside the webhook payload (11 captured live payments, ¥8,570); Paidy had no fee data; Stripe is not built;
the courier's COD charge stayed outside the Hub. ₱22.2M of peso payments this FY; the one rate (0.42) unchanged
since 27 Mar 2026 with no history; no revaluation; no record of SMBC → BDO remittances.

### How it works
- **Rate history** `php_jpy_rate_history` (effective_from, rate): a trigger on `system_settings` logs and
  audits every change of `php_jpy_rate` (Settings page unchanged); `set_php_jpy_rate(rate, date)` (admin_settings)
  sets today's rate or dates a past one (history only; a dated rate must be earlier than the latest row —
  `date_after_latest`); `gl_rate_at(date)` = latest row on or before the day, before the first row the first row,
  with no history the live setting; `get_rate_history()`. The migration seeds one row dated at the setting's
  last update — the owner should date the real history (e.g. 0.42 since 27 Mar 2026) before the ledger start.
- **Posting passes** the revaluation derives from POSTED peso lines, so `gl_post_now` and the nightly cron now
  run `gl_post_settled` — up to three passes until a pass changes nothing (a dry run decides whether another
  pass is needed, so no empty run rows).
- **Square fees** — event `square_fee` per captured production payment with `processing_fee` in its payload:
  Dr 6300 / Cr 1130, dated at capture; test rows, sandbox and test orders excluded. The clearing balance now
  equals Square's net.
- **Settlements** `provider_settlements` (provider square | paidy | stripe | cod_carrier, received_on, period,
  amount_received_jpy, fees_jpy, adjustments_jpy, bank_account, reference, note; voided never deleted). RPCs
  `record_provider_settlement(p)` / `void_provider_settlement(id, reason)` (post_journal, audited). Events:
  `settlement_payout` Dr bank / Cr clearing; `settlement_fee` Dr 6300 (courier: 5400 Carrier cost) / Cr
  clearing; `settlement_adjustment` ± → 4900 / 6900. A fee-only statement needs no bank account; money received
  needs one (bank / cash, never a clearing or receivable account). Closed month refused.
- **Transfers** `fund_transfers` (from / to account with amounts in each leg's currency, fee, fee account 6300).
  RPCs `record_fund_transfer(p)` / `void_fund_transfer`. Event `fund_transfer`: Dr to / Cr from (each in yen at
  the rate in effect ON THE TRANSFER DATE, so the journal is stable), Dr fee, and — only when the legs are in
  different currencies — the yen difference to **6800** (received less) or **4950** (received more). Same-currency
  legs must satisfy sent = received + fee, fee in that currency (no FX line, no fake gain); endpoints are bank /
  cash accounts only (1xxx below 1130 — never a clearing or receivable account).
- **Peso revaluation** — event `fx_revaluation` per asset / liability account carrying peso lines (PH banks,
  GCash, PH cash, the peso part of 1200 / 1210 / 2300 …; never revenue or expenses), per month end from the
  ledger start: increment = (round(native ₱ ÷ rate at month end) − carrying yen) − previous month's cumulative;
  Dr account / Cr 4950 or Dr 6800 / Cr account. Derived from posted PESO lines only (revaluation lines are yen),
  as the books stood at that month end — a reversal dated today does not change a past month, exactly like
  the trial balance. A dated rate change re-derives from that month (reversal + repost); an unchanged rate
  posts nothing. `get_fx_revaluation(month)` shows per account: ₱ balance, books ¥, at month-end rate ¥,
  this month's increment.
- **Fee categories** Square / Paidy / Stripe fees are automatic now: trigger `expenses_refuse_auto_fee_categories`
  refuses an expense in them (`category_booked_automatically`), the manual picker hides them
  (`AUTO_BOOKED_SYSTEM_KEYS`), and the email reader no longer offers them (re-stated `expenses_email_context`).
  "Bank transfer and remittance fees" stays manual for fees not tied to a recorded transfer.
- **Screen** Finance → Ledger → **Clearing & FX**: provider table (captured / fees / refunds / paid out /
  still owed / status with the oldest open capture), Record settlement…, settlements list (Void with reason);
  Transfers card with Record transfer… and the list (FX gain / loss per row); Peso revaluation card by month
  (preview for the current month) with the rate history. `get_clearing_summary(months)`.
- Refusals: `invalid_provider`, `invalid_date`, `invalid_amount`, `invalid_account`, `invalid_currency`,
  `amounts_differ`, `period_closed`, `reason_required`, `already_voided`, `not_found`, `invalid_rate`.
- Out of scope (named): Stripe konbini itself; automatic payout webhooks; bank-statement reconciliation (Phase 8).

### Verified (2026-10-26)
- Local PostgreSQL 16: seven migrations applied twice through one `run.sh`; earlier suites (17 / 5 / 11 / 8 /
  7 / 8) still pass; new `test_clearing.sql` (7 groups): rate history (seed, same-rate no-op, change logged +
  audited), permissions (staff / finance / anon, table writes revoked), Square fee from the payload with
  test / sandbox exclusion, settlements clearing 1130 and 1140 to zero, courier charge → 5400, Paidy fee → 6300,
  negative adjustment → 6900, validation, void → reversal, clearing summary figures, transfers (peso leg at
  the Hub rate, fee, FX difference, same-currency rule, void + re-record), revaluation (no journal at an
  unchanged rate; dated rate → increments on 1111 and 1200 only, never 4100; balances as the books stood;
  idempotent; correcting the rate reverses), manual fee expense refused.
- Independent review applied before the PR: same-currency transfers can no longer book a fake FX gain (sent must
  equal received + fee; no FX line when the currencies match); transfers use the rate on the transfer date
  (stable journals — later rate moves flow through revaluation); the rate fallback before the first history row
  is the first row, never the newest; a dated rate after the latest row is refused; clearing accounts are not
  transfer endpoints; `gl_post_settled` removes the one-run lag of the revaluation; the Square-fee header no
  longer promises a refund mirror (the payload sum carries fee adjustments when refreshed); tests tightened.
- tsc exit 0; Vitest clearing (5) + full suite (117 files / 1,878) pass; build passes; lint unchanged (881 / 150).

### Note for later builds
`vite build` runs the `@lovable.dev/mcp-js` plugin, which rewrites
`supabase/functions/mcp/index.ts` (and replaces the project ref with "project-ref-unset").
Restore that file with `git checkout -- supabase/functions/mcp/index.ts` after a local build;
never commit the rewrite.

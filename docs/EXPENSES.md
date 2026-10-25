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
| 2 | Payroll + commission booking: monthly "Mark as paid"; both pages move under Finance | not started |
| 3 | Recurring bills (rent, subscriptions, tax accountant): monthly drafts to confirm | not started |
| 4 | Email auto-fill from sales@chajewelsjp.com (and chajewelsjapan@gmail.com via a forwarding filter) | not started — edge function, separate Lovable deploy prompt; needs gmail.readonly added to the service account in Google Admin |
| 5 | Real cost of goods on every ledger (cash, layaway, website, Page365 import, trade-ins, service-job vendor cost); replaces the 15% | not started |
| 6 | Provider fees auto-booking + monthly profit report | not started |

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

### Note for later builds
`vite build` runs the `@lovable.dev/mcp-js` plugin, which rewrites
`supabase/functions/mcp/index.ts` (and replaces the project ref with "project-ref-unset").
Restore that file with `git checkout -- supabase/functions/mcp/index.ts` after a local build;
never commit the rewrite.

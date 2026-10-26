# Finance → Expenses + accounting layer — go-live runbook

Written in Phase 8 (2026-10-26) and rehearsed on the local PostgreSQL harness (`supabase/tests/expenses/run.sh`,
10 suites incl. `test_e2e.sql`, the month walked end to end). **Nothing in this file has been executed against
live or staging.** The owner's explicit "go" is the only trigger; staging stays reserved for payment testing.
Each Lovable message below is sent on its own, after the previous one is verified (project SOP; `docs/MIGRATIONS.md`,
`docs/LOVABLE-VERIFICATION.md`).

## 0. What goes live, in order

| # | Migration (supabase/migrations) | Creates / changes | One-line check after apply |
|---|---|---|---|
| — | `20261230100000_expenses_ledger.sql` | Phase 1 — **already live** (inert: expenses tables, categories, vendors, RPCs) | `select count(*) from expense_categories` > 0 |
| 1 | `20261231100000_expenses_payroll_commission.sql` | Mark-as-paid bookings for payroll / commission | `select to_regprocedure('public.book_payroll_month(date, date, jsonb)')` not null |
| 2 | `20270101100000_general_ledger_core.sql` | gl_accounts (seed), gl_periods, gl_journals / lines, posting engine, cron `gl-post-pending` 15:40 UTC, settings `fiscal_year_start_month` "4", `ledger_start_date` null | `select count(*) from gl_accounts` = 60; `select jobname from cron.job where jobname = 'gl-post-pending'` |
| 3 | `20270102100000_expenses_recurring_prepaid.sql` | recurring templates, prepaid, cron `expenses-recurring` 15:20 UTC | cron row present |
| 4 | `20270103100000_expenses_email_bills.sql` | email bill tables, `expenses_email_enabled` false, cron `expenses-email-bills` :07/:37 | `select value from system_settings where key = 'expenses_email_enabled'` = false |
| 5 | `20270104100000_expenses_cost_of_goods.sql` | sale_costs, sale_item_costs (+ trigger, backfill), trade-in columns, 7 accounts (→ 67), cogs events | `select count(*) from gl_accounts` = 67; `select count(*) from sale_item_costs` ≈ item rows |
| 6 | `20270105100000_expenses_clearing_fx.sql` | rate history (+ trigger, seeded from the live rate), settlements, transfers, revaluation, `gl_post_settled`, cron re-pointed | `select * from php_jpy_rate_history` = 1 row (today, 0.42) |
| 7 | `20270106100000_expenses_statements.sql` | `name_ja` seeded, statement flags, `get_statements`, ageing, journal export | `select count(*) from gl_accounts where name_ja is null` = 0 |
| 8 | `20270107100000_expenses_controls.sql` | period lock trigger, readiness, `gl_check_runs`, bank rec tables, cron `gl-completeness-check` 16:10 UTC | `select count(*) from cron.job where jobname in ('gl-post-pending','expenses-recurring','expenses-email-bills','gl-completeness-check')` = 4 |

Every file is re-runnable (applied twice in the harness). Order matters (each builds on the previous). Edge function:
`expenses-email-bills` (Phase 4) only — deployed by its own Lovable message, and it does nothing until
`expenses_email_enabled` is true and Google Admin has granted `gmail.readonly` to the service account.

## 1. Pre-flight (read-only, run against live before the first message)

```sql
-- a. payment spellings the map does not know (they would post to 1190 until mapped)
select lower(btrim(payment_method)) m, count(*) from (
  select payment_method from payments where voided_at is null and date_paid >= '2026-04-01'
  union all select payment_method from cash_payments where voided_at is null and date_paid >= '2026-04-01') p
group by 1 order by 2 desc;
-- b. approved expenses with no Paid from (they post against 1190 until set)
select count(*) from expenses where status = 'approved' and paid_from is null;
-- c. the live rate and its first-known date (the history is seeded "today"; date it afterwards)
select value from system_settings where key = 'php_jpy_rate';
-- d. the accountant's figures: have the FINAL opening balances arrived? (provisional 試算表 to 30 Sep 2026 is in
--    claude/accountant-trial-balance-2026-09.md; opening inventory ¥44,432,668 there is provisional)
-- e. volume the first "Post now" will handle
select count(*) from payments where voided_at is null and date_paid >= '2026-04-01';
select count(*) from cash_payments where voided_at is null and date_paid >= '2026-04-01';
```
Write the answers into the Project doc before sending anything; the first "Post now" in §3 is checked against (e).

## 2. Lovable messages (one per message, verify each before the next)

Every SQL message carries the project's standard preamble: pull `origin/feat/expenses` (or `origin/main` once
merged), confirm the file's sha matches the repo, apply through the SQL runner, then run the one-line check
from §0 and report its literal output — never "applied successfully" alone. A migration that errors stops the
sequence; nothing is re-run until the cause is known.

1. Migrations 1–2 (payroll/commission + ledger core). Check: 60 accounts, `ledger_start_date` is `null`, cron row.
   Nothing posts yet — the ledger is inert until the start date is set.
2. Migrations 3–4 (recurring + email). Check: both crons, `expenses_email_enabled` = false.
3. Migrations 5–6 (cost of goods + clearing/FX). Check: 67 accounts, `sale_item_costs` row count, one rate-history row.
4. Migrations 7–8 (statements + controls). Check: `name_ja` all set, four crons, `gl_check_runs` empty.
5. Edge function `expenses-email-bills` deploy (separate message, Phase 4 text in docs/EXPENSES.md). Check: the
   function exists and answers 401 to an unsigned call. It stays OFF.
6. Front end: the Hub's main deploy (Lovable publishes `main`). Until the migrations are applied the Ledger tab
   shows "Waiting for the database update" and nothing else changes for staff.

## 3. After apply — the owner's first hour in the Hub (Finance → Ledger)

1. **Settings → peso rate**: unchanged (0.42). Then Ledger → Clearing & FX → rate history: *date* the first row
   with `set_php_jpy_rate(0.42, '2026-03-27')` (the Hub rate has been 0.42 since 27 Mar 2026) so month-end
   revaluation before today uses it.
2. **Accounts**: map every spelling from pre-flight (a) that is not in the seed (`bank transfer`, `other`, …).
3. **Expenses**: set Paid from on the approved rows from pre-flight (b).
4. **Start the ledger** (Months → Start) on the first day of the first month the accountant's figures cover
   (expected 2026-04-01 — the fiscal year start — if the FINAL 試算表 arrives for 31 Mar 2026; otherwise the
   first of the month the figures are dated). This freezes once journals exist.
5. **Opening journal**: Journals → New manual journal, kind *Opening*, dated at the ledger start, one line per
   account from the FINAL figures (bank balances in their own currency; inventory 1300; receivables 1200/1210
   must agree with the Hub's open plans — the 税理士 reconciles the Δ4.2M first; loans 2700/2750; 仮受金 2900,
   仮払金 1195; capital 3000; retained 3100). Debits = credits in yen or the dialog refuses.
6. **Post now**. Compare `posted` with pre-flight (e) (payments + sales + expenses + fees). Read the run note if
   `failed` > 0. The status strip must show no unmapped spellings and no expenses without Paid from.
7. **Checks → Run check now**: 0 errors expected; warnings are the open months and unreconciled accounts.
8. **Cost of goods**: enter costs (CSV import) so gross profit stops equalling revenue; "cost missing" tiles
   count down.
9. **Bank rec**: import April's statement for SMBC first (column map saved on the first import), match, set the
   fee lines aside, sign off; repeat per account per month up to last month. Cash: count and type.
10. **Months**: close April → … → last month, reading the readiness list each time (errors block; warnings are
    written on the month).
11. **Statements** and the **税理士 pack** for the closed months: Print → Save as PDF; Journals CSV; hand over with
    the two open questions (tax class of 4400 / 4500; treatment of 3900 owner drawings).
12. Email bills: only after Google Admin grants `gmail.readonly` — set `expenses_email_enabled` true and watch
    the first run on Finance → Expenses → Bills to confirm.

## 4. Inspection checklist (desktop + phone, after the Hub deploy)

- Finance → Ledger (admin): strip shows "Ledger starts …", the rate, "Never checked · Checks" link; nine tabs fit
  (wrap on phone), no horizontal scroll; every button at least 44 px tall.
- Months: Start button before the start; after it, each month shows lock state, "N of M accounts reconciled",
  a 税理士 pack link, Close opens the readiness dialog (errors in red stop the button; warnings allow "Close with
  open items"); reopen needs a reason.
- Checks: "Run check now" produces a run row; issues show a one-line action and an Open link that lands on the
  right tab; the staff bell shows "Ledger check: N issues" with no amounts and opens Checks.
- Bank rec: account picker lists bank / e-money / cash only; Import statement reads a Shift-JIS SMBC export
  (Japanese text legible in the preview), column map remembered next time, duplicate file refused with a plain
  message; "Not in the Hub" rows offer Match buttons when a candidate exists and Set aside with a reason;
  Reconciled is disabled until the blockers list is empty; cash accounts show only the count field and the
  over/short hint.
- Expenses: approving a draft dated in a closed month shows "That month is closed in the ledger …"; voiding one
  still works; a recurring draft generated for a closed month appears on the first open day with the note.
- Staff (no view_ledger): no Ledger tab, bell row visible but opens Finance → Overview, no amounts anywhere.
- Statements / 税理士 pack unchanged from Phase 7 (print preview breaks one statement per page).

## 5. Rollback

The ledger is derived: setting `ledger_start_date` back to `null` (`set_ledger_start` refuses once journals exist —
use the SQL Editor only in an emergency and commit the change) stops every posting; journals already written
stay (immutable) and the tab shows them. No phase changes a payment, plan, order or product row — the only
writes outside the finance tables are the finance-only `sale_item_costs` snapshot and the `expenses` period-lock
trigger. Crons can be unscheduled by name. Nothing in the storefront or the customer portal reads any of this.

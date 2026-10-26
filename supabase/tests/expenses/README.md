# Expenses / Ledger SQL harness

Stand-ins for the live objects the Expenses migrations depend on (`stubs.sql`: auth, roles,
`has_permission` verbatim, `system_settings`, `audit_logs`, storage; `stubs_ledger.sql`: the money
tables the ledger reads, baseline columns only, plus website_product_variants, the two item tables and trade_ins for Phase 5; square_payments carries payload columns for Phase 6; layaway_schedule and customers for Phase 7; staff_notifications for Phase 8) plus ten suites:

- `test_expenses.sql` — Phase 1 (17 groups)
- `test_phase2.sql` — Mark as paid (5 groups; loads the Phase 2 migration itself via `-v migration2=`)
- `test_recurring.sql` — Phase 3 recurring bills + prepaid (8 groups; sets its own ledger start)
- `test_email_bills.sql` — Phase 4 emailed bills (7 groups; service-role recording, drafts, recurring match,
  owner actions, housekeeping — runs after the recurring suite)
- `test_cogs.sql` — Phase 5 cost of goods (8 groups; item snapshot, set / import, cogs_sale / cogs_return, purchases to
  inventory, trade-ins, valuation, real profit — own clean book)
- `test_clearing.sql` — Phase 6 clearing & FX (7 groups; rate history, Square fee from payload, settlements, transfers,
  peso revaluation across a dated rate change, fee categories automatic — own clean book)
- `test_statements.sql` — Phase 7 statements (10 groups; 勘定科目 names, permissions, a fixture book, income statement with the
  domestic / export split, balance sheet, cash-flow tie-out, ageing + forecast + currency checks, comparisons and flags, journal
  export — own clean book)
- `test_controls.sql` — Phase 8 controls (9 groups; permissions, period lock on expenses, close readiness + close with warnings, a changed
  source as unposted / orphan, the nightly check and its bell, bank import / matching / ignore / sign-off / reopen / void, cash count — own clean book)
- `test_e2e.sql` — Phase 8 end-to-end rehearsal (5 groups; one month as the owner will run it: day one, business, reconciliation, close +
  statements, a correction after the close — own clean book)
- `test_ledger.sql` — Phase 2b general ledger (11 groups: start-date gate, permissions, every event set,
  reversal / repost on source change, fingerprint stability, forfeiture + reactivation, store credit,
  expenses with Paid from, refunds, periods and manual journals, closed-month move, immutability)

Run `supabase/tests/expenses/run.sh` against a scratch PostgreSQL 16 (`PGURL` env; default local
socket). It creates and drops its own database, and gives the ledger suite and the recurring + email suites a
clean book each (the Phase 1/2 suites leave approved expenses behind that the ledger counts would otherwise include). These are NOT Supabase tests and never touch a
Lovable database; verified 2026-10-26 on PostgreSQL 16.

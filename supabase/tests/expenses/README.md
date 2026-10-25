# Expenses / Ledger SQL harness

Stand-ins for the live objects the Expenses migrations depend on (`stubs.sql`: auth, roles,
`has_permission` verbatim, `system_settings`, `audit_logs`, storage; `stubs_ledger.sql`: the money
tables the ledger reads, baseline columns only) plus three suites:

- `test_expenses.sql` — Phase 1 (17 groups)
- `test_phase2.sql` — Mark as paid (5 groups; loads the Phase 2 migration itself via `-v migration2=`)
- `test_ledger.sql` — Phase 2b general ledger (11 groups: start-date gate, permissions, every event set,
  reversal / repost on source change, fingerprint stability, forfeiture + reactivation, store credit,
  expenses with Paid from, refunds, periods and manual journals, closed-month move, immutability)

Run `supabase/tests/expenses/run.sh` against a scratch PostgreSQL 16 (`PGURL` env; default local
socket). It creates and drops its own database. These are NOT Supabase tests and never touch a
Lovable database; verified 2026-10-25 on PostgreSQL 16.15.

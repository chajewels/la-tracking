# Payslips SQL harness

Stand-ins (`stubs.sql`) for the live objects the Payslips migration depends on: auth, roles, `has_role` and
`timesheet_can_view_all` (verbatim from the baseline), `profiles`, `timesheet_profiles`, `system_settings`,
`audit_logs` and storage. `test_payslips.sql` holds 14 groups (shape, permission, anon, staff details,
finalize, Live Admin, payment, other staff, CSR upload, void + re-issue, row locks, direct writes, audit).

Run `PGURL=postgres://... supabase/tests/payslips/run.sh` against a scratch PostgreSQL 16. It creates and
drops its own database and applies the migration twice. These are NOT Supabase tests and never touch a
Lovable database. Last run 2026-10-26 on PostgreSQL 16: all groups passed.

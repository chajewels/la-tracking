# Payslips SQL harness

Stand-ins (`stubs.sql`) for the live objects the Payslips migration depends on: auth, roles, `has_role` and
`timesheet_can_view_all` (verbatim from the baseline), `profiles`, `timesheet_profiles`, `system_settings`,
`audit_logs` and storage. `test_payslips.sql` holds 14 groups (shape, permission, anon, staff details,
finalize, Live Admin, payment, other staff, CSR upload, void + re-issue, row locks, direct writes, audit).

Run `PGURL=postgres://... supabase/tests/payslips/run.sh` against a scratch PostgreSQL 16. It creates and
drops its own database and applies the migration twice. These are NOT Supabase tests and never touch a
Lovable database. Last run 2026-10-26 on PostgreSQL 16: all groups passed.

**Phase 2** (migration 20270204100000; added 2026-10-27): `stubs.sql` + `stubs_timesheet.sql`
(timesheet_entries as on the baseline, and profiles' updated_at trigger), 20270201 + 20270202, `seed_before.sql`
(payslips issued the old way), then 20270204 applied twice, then `test_bond_payhistory.sql`. That file has 15 groups
(Q1–Q8): shape and existing rows unchanged; the patched freeze trigger; the pay settings RPC and its read audience;
employee ID and hire date; the April floor, inactive staff and pay_settings_mismatch; cash advances and their proof
storage rules; the cash bond; corrections from April; audit. Last run 2026-10-27 on PostgreSQL 16.14: all groups passed.

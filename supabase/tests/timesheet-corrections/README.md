# Timesheet corrections SQL harness

Stand-ins (`stubs.sql`) for the live objects the corrections migration depends on: auth, roles, `has_role` and
`timesheet_can_view_all` (verbatim from the baseline), `profiles`, `timesheet_profiles`, `timesheet_entries` (baseline
columns, unique key, updated_at trigger and its five RLS policies) and `audit_logs`. `test_corrections.sql` covers:
shape, the gate, anon, comment / date / punch / order rules, first correction creating the entry, history + audit,
permanent history, direct insert, the day lock (staff refused, uncorrected days free, admin, can_view_all, service),
and who reads which corrections.

Run `PGURL=postgres://... supabase/tests/timesheet-corrections/run.sh` against a scratch PostgreSQL 16. It creates
and drops its own database and applies the migration twice. NOT a Supabase test; never touches a Lovable database.

-- Payslips: "PROOF NOT ON FILE" allowed for pay months BEFORE OCTOBER 2026 (owner 2026-10-28 00:45-01:08).
--
--   * Brenda's April-September 2026 pay was part of the total payroll sent to her to distribute, so it has
--     no separate proof. One-time catch-up: from October 2026 every payslip needs a proof again.
--   * Only the CHECK changes (was: before June 2026). The flag is still set only by the one-time
--     owner-approved data step; no client RPC sets it. Existing rows are not touched.

SET lock_timeout = '15s';

BEGIN;

ALTER TABLE public.payslips DROP CONSTRAINT IF EXISTS payslips_proof_not_on_file;
ALTER TABLE public.payslips ADD CONSTRAINT payslips_proof_not_on_file
  CHECK (NOT proof_not_on_file OR pay_month < DATE '2026-10-01');

COMMENT ON COLUMN public.payslips.proof_not_on_file IS
  'Paid outside the Hub - proof not on file (owner 2026-10-28). Only on a pay month before October 2026; then proof_path is null.';

COMMIT;

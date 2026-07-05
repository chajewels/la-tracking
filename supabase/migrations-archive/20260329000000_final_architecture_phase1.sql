-- ═══════════════════════════════════════════════════════
-- PHASE 1 — DATABASE FOUNDATION
-- Cha Jewels Layaway System Architecture Fix
-- Run in Supabase SQL editor BEFORE deploying code changes
-- ═══════════════════════════════════════════════════════

-- STEP 1.1 — Add columns to layaway_schedule
ALTER TABLE layaway_schedule
  ADD COLUMN IF NOT EXISTS carried_amount NUMERIC(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS carried_from_schedule_id UUID REFERENCES layaway_schedule(id),
  ADD COLUMN IF NOT EXISTS carried_by_payment_id UUID REFERENCES payments(id);

-- STEP 1.2 — Ensure payment_id exists on payment_allocations
-- (column already exists in most deployments; ADD COLUMN IF NOT EXISTS is safe)
ALTER TABLE payment_allocations
  ADD COLUMN IF NOT EXISTS payment_id UUID REFERENCES payments(id) ON DELETE RESTRICT;

-- STEP 1.3 — schedule_audit_log table
CREATE TABLE IF NOT EXISTS schedule_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL,
  schedule_id UUID NOT NULL,
  admin_user_id UUID NOT NULL,
  action TEXT NOT NULL,
  field_changed TEXT,
  old_value TEXT,
  new_value TEXT,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- STEP 1.4 — Enforce NUMERIC(12,2) on all money columns
-- NOTE: actual column in payment_allocations is "allocated_amount" not "amount"
ALTER TABLE layaway_schedule
  ALTER COLUMN base_installment_amount TYPE NUMERIC(12,2),
  ALTER COLUMN penalty_amount TYPE NUMERIC(12,2),
  ALTER COLUMN carried_amount TYPE NUMERIC(12,2),
  ALTER COLUMN paid_amount TYPE NUMERIC(12,2),
  ALTER COLUMN total_due_amount TYPE NUMERIC(12,2);

ALTER TABLE payment_allocations
  ALTER COLUMN allocated_amount TYPE NUMERIC(12,2);

ALTER TABLE payments
  ALTER COLUMN amount_paid TYPE NUMERIC(12,2);

ALTER TABLE layaway_accounts
  ALTER COLUMN total_paid TYPE NUMERIC(12,2),
  ALTER COLUMN remaining_balance TYPE NUMERIC(12,2),
  ALTER COLUMN total_amount TYPE NUMERIC(12,2);

-- STEP 1.5 — Add check constraints
ALTER TABLE layaway_schedule
  ADD CONSTRAINT IF NOT EXISTS carried_amount_non_negative
    CHECK (carried_amount >= 0),
  ADD CONSTRAINT IF NOT EXISTS base_amount_positive
    CHECK (base_installment_amount > 0),
  ADD CONSTRAINT IF NOT EXISTS penalty_non_negative
    CHECK (penalty_amount >= 0);

ALTER TABLE payment_allocations
  ADD CONSTRAINT IF NOT EXISTS allocation_positive
    CHECK (allocated_amount > 0);

ALTER TABLE payments
  ADD CONSTRAINT IF NOT EXISTS payment_positive
    CHECK (amount_paid > 0);

-- STEP 1.6 — Allocation ceiling trigger
-- Prevents total allocations on a schedule row from exceeding its ceiling
-- Ceiling = base + penalty + carried
CREATE OR REPLACE FUNCTION check_allocation_ceiling()
RETURNS TRIGGER AS $$
DECLARE
  total_allocated NUMERIC(12,2);
  row_ceiling NUMERIC(12,2);
BEGIN
  SELECT COALESCE(SUM(allocated_amount), 0) INTO total_allocated
  FROM payment_allocations
  WHERE schedule_id = NEW.schedule_id;

  SELECT base_installment_amount
    + COALESCE(penalty_amount, 0)
    + COALESCE(carried_amount, 0)
  INTO row_ceiling
  FROM layaway_schedule
  WHERE id = NEW.schedule_id;

  IF total_allocated > row_ceiling + 0.01 THEN
    RAISE EXCEPTION
      'Allocation of % exceeds row ceiling of % for schedule %',
      total_allocated, row_ceiling, NEW.schedule_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS enforce_allocation_ceiling ON payment_allocations;
CREATE TRIGGER enforce_allocation_ceiling
  AFTER INSERT OR UPDATE ON payment_allocations
  FOR EACH ROW EXECUTE FUNCTION check_allocation_ceiling();

-- STEP 1.7 — base_installment_amount immutable trigger
-- Prevents ANY update from changing base_installment_amount or installment_number
CREATE OR REPLACE FUNCTION prevent_base_amount_change()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.base_installment_amount IS DISTINCT FROM OLD.base_installment_amount THEN
    RAISE EXCEPTION
      'base_installment_amount is immutable after creation. Attempted change from % to % on schedule %',
      OLD.base_installment_amount, NEW.base_installment_amount, OLD.id;
  END IF;
  IF NEW.installment_number IS DISTINCT FROM OLD.installment_number THEN
    RAISE EXCEPTION
      'installment_number is immutable after creation on schedule %', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS enforce_immutable_base ON layaway_schedule;
CREATE TRIGGER enforce_immutable_base
  BEFORE UPDATE ON layaway_schedule
  FOR EACH ROW EXECUTE FUNCTION prevent_base_amount_change();

-- STEP 1.8 — FK: payment_allocations.schedule_id ON DELETE RESTRICT
ALTER TABLE payment_allocations
  DROP CONSTRAINT IF EXISTS payment_allocations_schedule_id_fkey;
ALTER TABLE payment_allocations
  ADD CONSTRAINT payment_allocations_schedule_id_fkey
    FOREIGN KEY (schedule_id)
    REFERENCES layaway_schedule(id)
    ON DELETE RESTRICT;

-- STEP 1.9 — schedule_with_actuals view
-- Single authoritative read path for all schedule display and calculations.
-- Fields:
--   allocated       = SUM(payment_allocations.allocated_amount) — actual cash received per row
--   actual_remaining = base + penalty + carried - allocated — what is still owed on this row
--   computed_status  = derived from DB status and allocations (more accurate than db_status alone)
--   db_status        = the stored status column (used for writes/filtering only)
CREATE OR REPLACE VIEW schedule_with_actuals AS
SELECT
  ls.id,
  ls.account_id,
  ls.installment_number,
  ls.due_date,
  ls.base_installment_amount,
  ls.penalty_amount,
  ls.carried_amount,
  ls.carried_from_schedule_id,
  ls.carried_by_payment_id,
  ls.currency,
  ls.status AS db_status,
  ls.generated_at,
  ls.updated_at,
  COALESCE(pa.allocated, 0) AS allocated,
  GREATEST(
    0,
    ls.base_installment_amount
    + COALESCE(ls.penalty_amount, 0)
    + COALESCE(ls.carried_amount, 0)
    - COALESCE(pa.allocated, 0)
  ) AS actual_remaining,
  CASE
    WHEN ls.status = 'paid' THEN 'paid'
    WHEN COALESCE(pa.allocated, 0) >=
         ls.base_installment_amount
         + COALESCE(ls.penalty_amount, 0)
         + COALESCE(ls.carried_amount, 0) - 0.005 THEN 'paid'
    WHEN COALESCE(pa.allocated, 0) > 0 THEN 'partially_paid'
    ELSE ls.status
  END AS computed_status
FROM layaway_schedule ls
LEFT JOIN (
  SELECT schedule_id, COALESCE(SUM(allocated_amount), 0) AS allocated
  FROM payment_allocations
  GROUP BY schedule_id
) pa ON pa.schedule_id = ls.id;

-- STEP 1.10 — RLS note
-- All financial writes go through edge functions using SERVICE_ROLE_KEY (bypasses RLS).
-- Client-side reads from schedule_with_actuals and layaway_schedule are governed by
-- existing RLS policies on layaway_schedule (schedule_with_actuals inherits them).
-- No additional RLS policy changes needed for the view.

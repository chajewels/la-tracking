-- Add payment sender identification columns to payments table
-- submitted_by_type: 'customer' (portal submission) or 'staff' (direct admin entry)
-- submitted_by_name: display name of the person who submitted the payment

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS submitted_by_type TEXT
    CHECK (submitted_by_type IN ('customer', 'staff')),
  ADD COLUMN IF NOT EXISTS submitted_by_name TEXT;

-- Backfill existing payments as 'staff' (safe default — all pre-feature payments were staff-entered)
UPDATE payments
SET submitted_by_type = 'staff'
WHERE submitted_by_type IS NULL;

-- Confirm payment_submissions.proof_url exists (add if missing)
ALTER TABLE payment_submissions
  ADD COLUMN IF NOT EXISTS proof_url TEXT;

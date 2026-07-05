-- Add customer_edited_at to payment_submissions
-- Tracks when a customer last edited their pending submission (for admin awareness)
ALTER TABLE payment_submissions
  ADD COLUMN IF NOT EXISTS customer_edited_at timestamptz;


-- Add submission_type to payment_submissions
ALTER TABLE public.payment_submissions
ADD COLUMN IF NOT EXISTS submission_type text NOT NULL DEFAULT 'single';

-- Create payment_submission_allocations table
CREATE TABLE IF NOT EXISTS public.payment_submission_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES public.payment_submissions(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.layaway_accounts(id),
  invoice_number text NOT NULL,
  allocated_amount numeric(15,2) NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.payment_submission_allocations ENABLE ROW LEVEL SECURITY;

-- RLS policies
CREATE POLICY "Anon can insert allocations with submission"
ON public.payment_submission_allocations
FOR INSERT TO anon
WITH CHECK (true);

CREATE POLICY "Anon can view own allocations"
ON public.payment_submission_allocations
FOR SELECT TO anon
USING (true);

CREATE POLICY "Staff can view allocations"
ON public.payment_submission_allocations
FOR SELECT TO authenticated
USING (public.is_staff(auth.uid()));

CREATE POLICY "Staff can update allocations"
ON public.payment_submission_allocations
FOR UPDATE TO authenticated
USING (public.is_staff(auth.uid()));

-- Index for lookups
CREATE INDEX IF NOT EXISTS idx_submission_allocations_submission_id
ON public.payment_submission_allocations(submission_id);

CREATE INDEX IF NOT EXISTS idx_submission_allocations_account_id
ON public.payment_submission_allocations(account_id);

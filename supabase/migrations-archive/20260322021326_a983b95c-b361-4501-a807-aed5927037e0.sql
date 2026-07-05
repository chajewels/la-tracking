
-- Add 'final_settlement' to account_status enum
ALTER TYPE public.account_status ADD VALUE IF NOT EXISTS 'final_settlement';

-- Create final_settlement_records table for tracking
CREATE TABLE public.final_settlement_records (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES public.layaway_accounts(id),
  last_paid_month_date DATE,
  penalty_occurrence_count INTEGER NOT NULL DEFAULT 0,
  penalty_total_from_last_paid NUMERIC(15,2) NOT NULL DEFAULT 0,
  remaining_principal NUMERIC(15,2) NOT NULL DEFAULT 0,
  final_settlement_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
  calculation_json JSONB,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(account_id)
);

-- Enable RLS
ALTER TABLE public.final_settlement_records ENABLE ROW LEVEL SECURITY;

-- Staff can view
CREATE POLICY "Staff can view final settlements"
  ON public.final_settlement_records FOR SELECT
  TO authenticated
  USING (public.is_staff(auth.uid()));

-- Staff can insert
CREATE POLICY "Staff can insert final settlements"
  ON public.final_settlement_records FOR INSERT
  TO authenticated
  WITH CHECK (public.is_staff(auth.uid()));

-- Staff can update
CREATE POLICY "Staff can update final settlements"
  ON public.final_settlement_records FOR UPDATE
  TO authenticated
  USING (public.is_staff(auth.uid()));

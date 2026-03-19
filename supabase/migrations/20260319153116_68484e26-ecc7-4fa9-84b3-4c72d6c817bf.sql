-- Add void columns to payments table
ALTER TABLE public.payments ADD COLUMN voided_at timestamptz DEFAULT NULL;
ALTER TABLE public.payments ADD COLUMN voided_by_user_id uuid DEFAULT NULL;
ALTER TABLE public.payments ADD COLUMN void_reason text DEFAULT NULL;

-- Allow staff to update payments (for editing date/notes/method and voiding)
CREATE POLICY "Staff can update payments"
  ON public.payments
  FOR UPDATE
  TO authenticated
  USING (is_staff(auth.uid()));
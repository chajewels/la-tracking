
-- Payment methods configured by staff
CREATE TABLE public.payment_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  method_name text NOT NULL,
  bank_name text,
  account_name text,
  account_number text,
  instructions text,
  qr_image_url text,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.payment_methods ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view active payment methods"
  ON public.payment_methods FOR SELECT TO anon, authenticated
  USING (is_active = true);

CREATE POLICY "Admin can manage payment methods"
  ON public.payment_methods FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- Payment submissions from customers
CREATE TYPE public.submission_status AS ENUM ('submitted', 'under_review', 'confirmed', 'rejected', 'needs_clarification');

CREATE TABLE public.payment_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  account_id uuid NOT NULL REFERENCES public.layaway_accounts(id),
  submitted_amount numeric(15,2) NOT NULL,
  payment_date date NOT NULL,
  payment_method text NOT NULL,
  reference_number text,
  sender_name text,
  notes text,
  proof_url text,
  status public.submission_status NOT NULL DEFAULT 'submitted',
  reviewer_user_id uuid,
  reviewer_notes text,
  confirmed_payment_id uuid REFERENCES public.payments(id),
  portal_token text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.payment_submissions ENABLE ROW LEVEL SECURITY;

-- Staff can view all submissions
CREATE POLICY "Staff can view submissions"
  ON public.payment_submissions FOR SELECT TO authenticated
  USING (is_staff(auth.uid()));

-- Staff can update submissions (review)
CREATE POLICY "Staff can update submissions"
  ON public.payment_submissions FOR UPDATE TO authenticated
  USING (is_staff(auth.uid()));

-- Anon can insert submissions (customer portal)
CREATE POLICY "Anon can insert submissions"
  ON public.payment_submissions FOR INSERT TO anon
  WITH CHECK (true);

-- Anon can view own submissions by portal_token
CREATE POLICY "Anon can view own submissions"
  ON public.payment_submissions FOR SELECT TO anon
  USING (true);

-- Storage bucket for payment proofs
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('payment-proofs', 'payment-proofs', true, 10485760);

-- Storage RLS policies
CREATE POLICY "Anyone can upload payment proofs"
  ON storage.objects FOR INSERT TO anon, authenticated
  WITH CHECK (bucket_id = 'payment-proofs');

CREATE POLICY "Anyone can view payment proofs"
  ON storage.objects FOR SELECT TO anon, authenticated
  USING (bucket_id = 'payment-proofs');

-- Seed default payment methods
INSERT INTO public.payment_methods (method_name, bank_name, account_name, account_number, instructions, sort_order) VALUES
  ('BDO', 'Banco de Oro', 'Cha Jewels Co., Ltd.', NULL, 'Please transfer to the account above and take a screenshot of the confirmation.', 1),
  ('BPI', 'Bank of the Philippine Islands', 'Cha Jewels Co., Ltd.', NULL, 'Please transfer to the account above and take a screenshot of the confirmation.', 2),
  ('GCash', NULL, 'Cha Jewels', NULL, 'Send payment via GCash and take a screenshot of the confirmation.', 3),
  ('PayPay', NULL, 'Cha Jewels', NULL, 'Send payment via PayPay and screenshot the confirmation.', 4),
  ('Metrobank', 'Metropolitan Bank', 'Cha Jewels Co., Ltd.', NULL, 'Please transfer to the account above and take a screenshot of the confirmation.', 5),
  ('Rakuten', 'Rakuten Bank', 'Cha Jewels', NULL, 'Transfer via Rakuten Bank and screenshot the confirmation.', 6),
  ('Cash Payment', NULL, NULL, NULL, 'Pay in cash at an authorized Cha Jewels location.', 7);

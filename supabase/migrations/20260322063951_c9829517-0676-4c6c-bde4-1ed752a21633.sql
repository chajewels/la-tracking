
CREATE TABLE public.customer_portal_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  token text NOT NULL DEFAULT encode(extensions.gen_random_bytes(32), 'hex'),
  is_active boolean NOT NULL DEFAULT true,
  expires_at timestamptz DEFAULT (now() + interval '180 days'),
  created_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_portal_tokens_token_key UNIQUE (token)
);

ALTER TABLE public.customer_portal_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can create portal tokens" ON public.customer_portal_tokens
  FOR INSERT TO authenticated WITH CHECK (is_staff(auth.uid()));

CREATE POLICY "Staff can view portal tokens" ON public.customer_portal_tokens
  FOR SELECT TO authenticated USING (is_staff(auth.uid()));

CREATE POLICY "Staff can update portal tokens" ON public.customer_portal_tokens
  FOR UPDATE TO authenticated USING (is_staff(auth.uid()));

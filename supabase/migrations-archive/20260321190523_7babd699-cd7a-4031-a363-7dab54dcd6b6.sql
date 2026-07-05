
CREATE TABLE public.penalty_cap_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.layaway_accounts(id) ON DELETE CASCADE,
  currency text NOT NULL,
  penalty_cap_amount numeric NOT NULL,
  penalty_cap_scope text NOT NULL DEFAULT 'Due months 1-5 only',
  is_active boolean NOT NULL DEFAULT true,
  applied_by_user_id uuid,
  applied_at timestamptz NOT NULL DEFAULT now(),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id)
);

ALTER TABLE public.penalty_cap_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view overrides" ON public.penalty_cap_overrides
  FOR SELECT TO authenticated USING (is_staff(auth.uid()));

CREATE POLICY "Admin can insert overrides" ON public.penalty_cap_overrides
  FOR INSERT TO authenticated WITH CHECK (has_role(auth.uid(), 'admin'));

CREATE POLICY "Admin can update overrides" ON public.penalty_cap_overrides
  FOR UPDATE TO authenticated USING (has_role(auth.uid(), 'admin'));

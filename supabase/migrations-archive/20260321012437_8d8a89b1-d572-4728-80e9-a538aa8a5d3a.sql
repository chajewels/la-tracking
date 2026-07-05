
-- Create account_services table for additional services per invoice
CREATE TABLE public.account_services (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES public.layaway_accounts(id) ON DELETE CASCADE,
  service_type TEXT NOT NULL, -- e.g. 'resize', 'certificate', 'polish', 'change_color', 'other'
  description TEXT, -- open description field
  amount NUMERIC NOT NULL DEFAULT 0, -- open amount field
  currency TEXT NOT NULL DEFAULT 'PHP',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  created_by_user_id UUID,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.account_services ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Staff can view services" ON public.account_services
  FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));

CREATE POLICY "Staff can create services" ON public.account_services
  FOR INSERT TO authenticated WITH CHECK (public.is_staff(auth.uid()));

CREATE POLICY "Staff can update services" ON public.account_services
  FOR UPDATE TO authenticated USING (public.is_staff(auth.uid()));

CREATE POLICY "Admins can delete services" ON public.account_services
  FOR DELETE TO authenticated USING (public.has_role(auth.uid(), 'admin'));

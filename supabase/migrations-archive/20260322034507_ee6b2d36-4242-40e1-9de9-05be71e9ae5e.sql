
CREATE TABLE public.csr_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.layaway_accounts(id) ON DELETE CASCADE,
  schedule_id uuid NOT NULL REFERENCES public.layaway_schedule(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  invoice_number text NOT NULL,
  due_date date NOT NULL,
  reminder_stage text NOT NULL CHECK (reminder_stage IN ('7_DAYS', '3_DAYS', 'DUE_TODAY')),
  notified boolean NOT NULL DEFAULT true,
  notified_by_user_id uuid NOT NULL,
  notified_by_name text NOT NULL,
  notified_at timestamp with time zone NOT NULL DEFAULT now(),
  contact_method text DEFAULT 'messenger',
  remarks text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (schedule_id, reminder_stage)
);

ALTER TABLE public.csr_notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view notifications" ON public.csr_notifications
  FOR SELECT TO authenticated USING (is_staff(auth.uid()));

CREATE POLICY "Staff can create notifications" ON public.csr_notifications
  FOR INSERT TO authenticated WITH CHECK (is_staff(auth.uid()));

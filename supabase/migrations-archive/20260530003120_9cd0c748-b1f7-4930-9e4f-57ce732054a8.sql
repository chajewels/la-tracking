
-- 1) account_notes: staff-only SELECT/INSERT
DROP POLICY IF EXISTS "Authenticated users can read notes" ON public.account_notes;
DROP POLICY IF EXISTS "Authenticated users can insert notes" ON public.account_notes;
CREATE POLICY "Staff can read account notes" ON public.account_notes
  FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
CREATE POLICY "Staff can insert account notes" ON public.account_notes
  FOR INSERT TO authenticated WITH CHECK (public.is_staff(auth.uid()));

-- 2) Backup / audit tables: enable RLS, admin/finance only
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'loyalty_members_backup_pre_migration',
    'loyalty_transactions_backup_pre_migration',
    'loyalty_point_lots_backup_pre_migration',
    'loyalty_award_19015_audit_20260520',
    'loyalty_expiry_restore_audit_20260520',
    'loyalty_last_purchase_backfill_audit_20260520',
    'keep_fix_audit',
    'schedule_audit_log',
    'payment_history_backup',
    'layaway_signatures',
    'financial_alerts'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "Admins can read %1$s" ON public.%1$I', t);
    EXECUTE format($p$CREATE POLICY "Admins can read %1$s" ON public.%1$I FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::app_role) OR public.has_role(auth.uid(), 'finance'::app_role))$p$, t);
  END LOOP;
END $$;

-- 3) extension_requests: drop anon SELECT (portal token leak)
DROP POLICY IF EXISTS anon_select ON public.extension_requests;

-- 4) payment_submissions: drop anon broad cash-order SELECT (portal token leak)
DROP POLICY IF EXISTS "Anon can view cash order submissions" ON public.payment_submissions;

-- 5) payment_proofs: restrict SELECT to owning customer or staff
DROP POLICY IF EXISTS "Authenticated users can read proofs" ON public.payment_proofs;
CREATE POLICY "Staff or owning customer can read proofs" ON public.payment_proofs
  FOR SELECT TO authenticated USING (
    public.is_staff(auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.layaway_accounts la
      JOIN public.customers c ON c.id = la.customer_id
      WHERE la.id = payment_proofs.account_id AND c.auth_user_id = auth.uid()
    )
  );

-- 6) Storage: scope payment-proofs bucket
DROP POLICY IF EXISTS "Full access to payment proofs" ON storage.objects;
CREATE POLICY "Staff can manage payment proofs" ON storage.objects
  FOR ALL TO authenticated
  USING (bucket_id = 'payment-proofs' AND public.is_staff(auth.uid()))
  WITH CHECK (bucket_id = 'payment-proofs' AND public.is_staff(auth.uid()));
CREATE POLICY "Customers can read own payment proofs" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'payment-proofs' AND NOT public.is_staff(auth.uid()));
-- (anon INSERT policy already exists for portal uploads)

-- 7) promo_views: validate INSERT to authenticated customer; drop anon insert
DROP POLICY IF EXISTS "Customers can insert own views" ON public.promo_views;
CREATE POLICY "Authenticated customers can insert own promo views"
  ON public.promo_views FOR INSERT TO authenticated
  WITH CHECK (
    public.is_staff(auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.customers c
      WHERE c.id = promo_views.customer_id AND c.auth_user_id = auth.uid()
    )
  );

-- 8) system_settings: drop overly permissive any-authenticated write policies
DROP POLICY IF EXISTS authenticated_insert_system_settings ON public.system_settings;
DROP POLICY IF EXISTS authenticated_update_system_settings ON public.system_settings;
CREATE POLICY "Admins can insert settings" ON public.system_settings
  FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

-- Customer-scoped SELECT RLS policies — second batch (6 of 9).
-- NOT YET APPLIED TO PRODUCTION as of 2026-05-04.
-- Will be applied at Phase B merge time.

CREATE POLICY "Customers can view own payments"
  ON public.payments FOR SELECT TO authenticated
  USING (
    account_id IN (
      SELECT id FROM public.layaway_accounts
      WHERE customer_id IN (
        SELECT id FROM public.customers WHERE auth_user_id = auth.uid()
      )
    )
  );

CREATE POLICY "Customers can view own payment submissions"
  ON public.payment_submissions FOR SELECT TO authenticated
  USING (
    customer_id IN (
      SELECT id FROM public.customers WHERE auth_user_id = auth.uid()
    )
  );

CREATE POLICY "Customers can view own loyalty member"
  ON public.loyalty_members FOR SELECT TO authenticated
  USING (
    customer_id IN (
      SELECT id FROM public.customers WHERE auth_user_id = auth.uid()
    )
  );

CREATE POLICY "Customers can view own loyalty transactions"
  ON public.loyalty_transactions FOR SELECT TO authenticated
  USING (
    member_id IN (
      SELECT id FROM public.loyalty_members
      WHERE customer_id IN (
        SELECT id FROM public.customers WHERE auth_user_id = auth.uid()
      )
    )
  );

CREATE POLICY "Customers can view own loyalty redemptions"
  ON public.loyalty_redemptions FOR SELECT TO authenticated
  USING (
    member_id IN (
      SELECT id FROM public.loyalty_members
      WHERE customer_id IN (
        SELECT id FROM public.customers WHERE auth_user_id = auth.uid()
      )
    )
  );

CREATE POLICY "Customers can view own loyalty notification recipients"
  ON public.loyalty_notification_recipients FOR SELECT TO authenticated
  USING (
    member_id IN (
      SELECT id FROM public.loyalty_members
      WHERE customer_id IN (
        SELECT id FROM public.customers WHERE auth_user_id = auth.uid()
      )
    )
  );

-- Customer-scoped SELECT RLS policies — first batch (3 of 9).
-- All policies grant authenticated customers read-only access to
-- their own data. Writes continue through edge functions.
-- APPLIED TO PRODUCTION: 2026-05-04 via SQL Editor (ahead of plan).

CREATE POLICY "Customers can view own customer record"
  ON public.customers FOR SELECT TO authenticated
  USING (auth_user_id = auth.uid());

CREATE POLICY "Customers can view own layaway accounts"
  ON public.layaway_accounts FOR SELECT TO authenticated
  USING (
    customer_id IN (
      SELECT id FROM public.customers WHERE auth_user_id = auth.uid()
    )
  );

CREATE POLICY "Customers can view own cash orders"
  ON public.cash_orders FOR SELECT TO authenticated
  USING (
    customer_id IN (
      SELECT id FROM public.customers WHERE auth_user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Customers can read own payment proofs" ON storage.objects;

CREATE POLICY "Customers can read own payment proofs"
ON storage.objects
FOR SELECT
USING (
  bucket_id = 'payment-proofs'
  AND (
    public.is_staff(auth.uid())
    OR EXISTS (
      SELECT 1
      FROM public.layaway_accounts la
      JOIN public.customers c ON c.id = la.customer_id
      WHERE c.auth_user_id = auth.uid()
        AND la.id::text = split_part(objects.name, '/', 1)
    )
    OR EXISTS (
      SELECT 1
      FROM public.cash_orders co
      JOIN public.customers c ON c.id = co.customer_id
      WHERE c.auth_user_id = auth.uid()
        AND co.id::text = split_part(objects.name, '/', 1)
    )
  )
);
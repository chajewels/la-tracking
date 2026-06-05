-- Tighten storage SELECT policy on payment-proofs bucket: require ownership
DROP POLICY IF EXISTS "Customers can read own payment proofs" ON storage.objects;

CREATE POLICY "Customers can read own payment proofs"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'payment-proofs'
  AND (
    is_staff(auth.uid())
    OR EXISTS (
      SELECT 1
      FROM public.layaway_accounts la
      JOIN public.customers c ON c.id = la.customer_id
      WHERE c.auth_user_id = auth.uid()
        AND la.id::text = split_part(storage.objects.name, '/', 1)
    )
  )
);

-- Tighten payment_proofs INSERT: require staff OR owning customer
DROP POLICY IF EXISTS "Authenticated users can insert proofs" ON public.payment_proofs;

CREATE POLICY "Authenticated users can insert proofs"
ON public.payment_proofs
FOR INSERT
TO authenticated
WITH CHECK (
  is_staff(auth.uid())
  OR EXISTS (
    SELECT 1
    FROM public.layaway_accounts la
    JOIN public.customers c ON c.id = la.customer_id
    WHERE la.id = payment_proofs.account_id
      AND c.auth_user_id = auth.uid()
  )
);
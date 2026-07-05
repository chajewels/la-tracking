-- Fix MISSING_RLS_PROTECTION on extension_requests
-- Drop overly-permissive policies and scope access properly

DROP POLICY IF EXISTS "authenticated_all" ON public.extension_requests;
DROP POLICY IF EXISTS "anon_insert" ON public.extension_requests;

-- Staff (admin/staff/finance/csr) have full access to review extensions
CREATE POLICY "Staff full access to extension_requests"
ON public.extension_requests
FOR ALL
TO authenticated
USING (public.is_staff(auth.uid()))
WITH CHECK (public.is_staff(auth.uid()));

-- Customers can view their own extension requests
CREATE POLICY "Customers can view own extension_requests"
ON public.extension_requests
FOR SELECT
TO authenticated
USING (
  customer_id IN (
    SELECT id FROM public.customers WHERE auth_user_id = auth.uid()
  )
);

-- Customers can submit extension requests for their own accounts
CREATE POLICY "Customers can insert own extension_requests"
ON public.extension_requests
FOR INSERT
TO authenticated
WITH CHECK (
  customer_id IN (
    SELECT id FROM public.customers WHERE auth_user_id = auth.uid()
  )
);


-- 1) Storage: payment-proofs anon upload — drop unrestricted anon INSERT policy.
DROP POLICY IF EXISTS "Anon can upload payment proofs" ON storage.objects;

-- 2) payment_submissions: anon INSERT must require a real, active portal token.
DROP POLICY IF EXISTS "Anon can insert submissions with token" ON public.payment_submissions;
CREATE POLICY "Anon can insert submissions with token"
  ON public.payment_submissions
  FOR INSERT
  TO anon
  WITH CHECK (
    portal_token IS NOT NULL
    AND length(portal_token) >= 16
    AND EXISTS (
      SELECT 1 FROM public.customer_portal_tokens t
      WHERE t.token = payment_submissions.portal_token
        AND t.is_active = true
        AND (t.expires_at IS NULL OR t.expires_at > now())
        AND t.customer_id = payment_submissions.customer_id
    )
  );

-- 3) Same anon SELECT policy: also bind to real token row.
DROP POLICY IF EXISTS "Anon can view own submissions by token" ON public.payment_submissions;
CREATE POLICY "Anon can view own submissions by token"
  ON public.payment_submissions
  FOR SELECT
  TO anon
  USING (
    portal_token IS NOT NULL
    AND length(portal_token) >= 16
    AND portal_token = ((current_setting('request.headers'::text, true))::json ->> 'x-portal-token'::text)
    AND EXISTS (
      SELECT 1 FROM public.customer_portal_tokens t
      WHERE t.token = payment_submissions.portal_token
        AND t.is_active = true
    )
  );

-- 4) Authenticated customers: allow SELECT of own submissions.
CREATE POLICY "Customers can view own payment_submissions"
  ON public.payment_submissions
  FOR SELECT
  TO authenticated
  USING (
    customer_id IN (
      SELECT id FROM public.customers WHERE auth_user_id = auth.uid()
    )
  );

-- 5) customers.portal_pin_hash: remove from anon/authenticated SELECT
--    (offline-cracking risk). Service role and edge functions still see it.
REVOKE SELECT (portal_pin_hash) ON public.customers FROM authenticated, anon;

-- 6) payment_proofs: extend SELECT policy to cover cash_order-linked proofs.
DROP POLICY IF EXISTS "Staff or owning customer can read proofs" ON public.payment_proofs;
CREATE POLICY "Staff or owning customer can read proofs"
  ON public.payment_proofs
  FOR SELECT
  USING (
    is_staff(auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.layaway_accounts la
      JOIN public.customers c ON c.id = la.customer_id
      WHERE la.id = payment_proofs.account_id
        AND c.auth_user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.cash_orders co
      JOIN public.customers c ON c.id = co.customer_id
      WHERE co.id = payment_proofs.account_id
        AND c.auth_user_id = auth.uid()
    )
  );

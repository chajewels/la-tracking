
-- Fix 1: Tighten payment_submissions anon SELECT policy.
-- Old policy allowed any anon to read all rows where portal_token >= 16 chars.
-- New policy requires the caller to supply their portal_token via the
-- x-portal-token request header, and matches it against the row's token.
DROP POLICY IF EXISTS "Anon can view own submissions by token" ON public.payment_submissions;
CREATE POLICY "Anon can view own submissions by token"
  ON public.payment_submissions
  FOR SELECT
  TO anon
  USING (
    portal_token IS NOT NULL
    AND length(portal_token) >= 16
    AND portal_token = (current_setting('request.headers', true)::json ->> 'x-portal-token')
  );

-- Fix 2: Tighten payment_submissions anon UPDATE (cancel) policy.
DROP POLICY IF EXISTS "Anon can cancel cash order submissions" ON public.payment_submissions;
CREATE POLICY "Anon can cancel cash order submissions"
  ON public.payment_submissions
  FOR UPDATE
  TO anon
  USING (
    cash_order_id IS NOT NULL
    AND status = 'submitted'::submission_status
    AND portal_token IS NOT NULL
    AND portal_token = (current_setting('request.headers', true)::json ->> 'x-portal-token')
  )
  WITH CHECK (
    status = 'cancelled'::submission_status
    AND portal_token IS NOT NULL
    AND portal_token = (current_setting('request.headers', true)::json ->> 'x-portal-token')
  );

-- Fix 3: Tighten payment_submissions authenticated INSERT policy.
-- Old policy had WITH CHECK true. New policy requires either staff role or
-- caller-owned customer_id (Phase B portal JWT path).
DROP POLICY IF EXISTS "Authenticated users can insert submissions" ON public.payment_submissions;
CREATE POLICY "Authenticated users can insert submissions"
  ON public.payment_submissions
  FOR INSERT
  TO authenticated
  WITH CHECK (
    is_staff(auth.uid())
    OR customer_id IN (SELECT id FROM public.customers WHERE auth_user_id = auth.uid())
  );

-- Fix 4: Add customer SELECT policy on layaway_schedule so Realtime
-- broadcasts only return rows belonging to the caller's accounts.
CREATE POLICY "Customers can view own schedules"
  ON public.layaway_schedule
  FOR SELECT
  TO authenticated
  USING (
    account_id IN (
      SELECT la.id FROM public.layaway_accounts la
      JOIN public.customers c ON c.id = la.customer_id
      WHERE c.auth_user_id = auth.uid()
    )
  );

-- Fix 5: Restrict notify_loyalty_launch anonymous inserts.
-- Replace the unrestricted WITH CHECK true with a basic email format
-- validation so spammers cannot insert arbitrary garbage.
DROP POLICY IF EXISTS anon_insert_notify ON public.notify_loyalty_launch;
CREATE POLICY anon_insert_notify
  ON public.notify_loyalty_launch
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (
    email IS NOT NULL
    AND length(email) BETWEEN 5 AND 254
    AND email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'
  );

-- Fix 6: Set immutable search_path on the only SQL function missing it.
ALTER FUNCTION public.get_tracking_for_invoices(text[]) SET search_path = public;

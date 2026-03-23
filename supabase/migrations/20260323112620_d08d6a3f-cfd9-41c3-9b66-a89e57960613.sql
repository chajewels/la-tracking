
-- Drop overly permissive policies
DROP POLICY IF EXISTS "Anon can insert allocations with submission" ON public.payment_submission_allocations;
DROP POLICY IF EXISTS "Anon can view own allocations" ON public.payment_submission_allocations;

-- Anon insert: only via edge function (service role), so no anon insert needed
-- The submit-payment edge function uses service role key, so anon doesn't need direct insert

-- Staff can insert allocations (for edge function with service role this is already bypassed)
CREATE POLICY "Staff can insert allocations"
ON public.payment_submission_allocations
FOR INSERT TO authenticated
WITH CHECK (public.is_staff(auth.uid()));

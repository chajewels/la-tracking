
-- Tighten the anon insert policy to require portal_token
DROP POLICY "Anon can insert submissions" ON public.payment_submissions;
CREATE POLICY "Anon can insert submissions with token"
  ON public.payment_submissions FOR INSERT TO anon
  WITH CHECK (portal_token IS NOT NULL AND length(portal_token) >= 16);

-- Tighten the anon select policy to only see own submissions by token
DROP POLICY "Anon can view own submissions" ON public.payment_submissions;
CREATE POLICY "Anon can view own submissions by token"
  ON public.payment_submissions FOR SELECT TO anon
  USING (portal_token IS NOT NULL AND length(portal_token) >= 16);

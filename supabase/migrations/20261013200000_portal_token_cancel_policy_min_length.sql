-- Backlog #7 (2026-09-23 audit follow-up): every anon portal-token policy on
-- payment_submissions requires length(portal_token) >= 16 except
-- "Anon can cancel cash order submissions". This adds the same minimum to that
-- policy's USING and WITH CHECK. Nothing else changes: same name, same roles
-- (anon, authenticated), same command (UPDATE), same header match and the same
-- active/unexpired token lookup, copied from the LIVE definition
-- (pg_policies, 2026-09-28 21:5x JST).
--
-- Risk: none for real customers — portal tokens are long random strings; the
-- minimum only refuses a short/guessable token value, as the INSERT and SELECT
-- policies already do. Idempotent: safe to re-run.

BEGIN;

DROP POLICY IF EXISTS "Anon can cancel cash order submissions" ON public.payment_submissions;

CREATE POLICY "Anon can cancel cash order submissions"
  ON public.payment_submissions
  AS PERMISSIVE
  FOR UPDATE
  TO anon, authenticated
  USING (
    cash_order_id IS NOT NULL
    AND status = 'submitted'::submission_status
    AND portal_token IS NOT NULL
    AND length(portal_token) >= 16
    AND portal_token = ((current_setting('request.headers'::text, true))::json ->> 'x-portal-token'::text)
    AND EXISTS (
      SELECT 1 FROM public.customer_portal_tokens t
       WHERE t.token = payment_submissions.portal_token
         AND t.is_active = true
         AND (t.expires_at IS NULL OR t.expires_at > now())
    )
  )
  WITH CHECK (
    status = 'cancelled'::submission_status
    AND portal_token IS NOT NULL
    AND length(portal_token) >= 16
    AND portal_token = ((current_setting('request.headers'::text, true))::json ->> 'x-portal-token'::text)
    AND EXISTS (
      SELECT 1 FROM public.customer_portal_tokens t
       WHERE t.token = payment_submissions.portal_token
         AND t.is_active = true
         AND (t.expires_at IS NULL OR t.expires_at > now())
    )
  );

COMMIT;

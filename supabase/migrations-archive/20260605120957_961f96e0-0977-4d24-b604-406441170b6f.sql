-- Fix 1: Bind anon payment-proof storage uploads to the token's customer_id via path prefix
DROP POLICY IF EXISTS "Token customers can upload payment proofs" ON storage.objects;

CREATE POLICY "Token customers can upload payment proofs"
ON storage.objects
FOR INSERT
TO anon, authenticated
WITH CHECK (
  bucket_id = 'payment-proofs'
  AND EXISTS (
    SELECT 1
    FROM customer_portal_tokens t
    WHERE t.token = ((current_setting('request.headers', true))::json ->> 'x-portal-token')
      AND t.is_active = true
      AND (t.expires_at IS NULL OR t.expires_at > now())
      AND (
        EXISTS (
          SELECT 1 FROM layaway_accounts la
          WHERE la.customer_id = t.customer_id
            AND la.id::text = split_part(storage.objects.name, '/', 1)
        )
        OR EXISTS (
          SELECT 1 FROM cash_orders co
          WHERE co.customer_id = t.customer_id
            AND co.id::text = split_part(storage.objects.name, '/', 1)
        )
      )
  )
);

-- Fix 2: Require active + non-expired token for anon cancellation of cash order submissions
DROP POLICY IF EXISTS "Anon can cancel cash order submissions" ON public.payment_submissions;

CREATE POLICY "Anon can cancel cash order submissions"
ON public.payment_submissions
FOR UPDATE
TO anon, authenticated
USING (
  cash_order_id IS NOT NULL
  AND status = 'submitted'::submission_status
  AND portal_token IS NOT NULL
  AND portal_token = ((current_setting('request.headers', true))::json ->> 'x-portal-token')
  AND EXISTS (
    SELECT 1 FROM customer_portal_tokens t
    WHERE t.token = payment_submissions.portal_token
      AND t.is_active = true
      AND (t.expires_at IS NULL OR t.expires_at > now())
  )
)
WITH CHECK (
  status = 'cancelled'::submission_status
  AND portal_token IS NOT NULL
  AND portal_token = ((current_setting('request.headers', true))::json ->> 'x-portal-token')
  AND EXISTS (
    SELECT 1 FROM customer_portal_tokens t
    WHERE t.token = payment_submissions.portal_token
      AND t.is_active = true
      AND (t.expires_at IS NULL OR t.expires_at > now())
  )
);
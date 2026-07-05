
-- 1. Remove the overly-broad authenticated INSERT policy on storage.objects.
--    Uploads now require either staff role (Staff can manage payment proofs)
--    or a valid portal token (Token customers can upload payment proofs).
DROP POLICY IF EXISTS "Authenticated users can upload payment proofs" ON storage.objects;

-- 2. Revoke column-level SELECT on portal_token from authenticated role so
--    customer SELECT policies cannot leak the raw token. service_role keeps
--    full access for edge functions and admin operations.
REVOKE SELECT (portal_token) ON public.extension_requests FROM authenticated, anon;
REVOKE SELECT (portal_token) ON public.payment_submissions FROM authenticated, anon;

-- Record-only (2026-09-24). Applied live 2026-09-23 by the owner in the SQL Editor; this file
-- records it. Replaying is a no-op.
--
-- public.find_customer_matches — the shared duplicate-customer check (owner rules 2026-09-23,
-- recorded in docs/SCHEMA-FACTS.md "Duplicate-customer prevention"). A customer is a duplicate
-- when ANY of full name, Facebook name, mobile (last 10 digits, >= 10 digits only) or email
-- matches an existing non-test customer. Callers: NewCustomerDialog, EditCustomerDialog,
-- ImportCustomersDialog, AICommandModal (Hub, staff session) and setup-customer-account +
-- website POST /auth/customer (service role). A signed-in non-staff caller gets 42501.
--
-- LIVE (captured by the owner in the SQL Editor):
--   md5         : e7f259b57c2a8d2f161c7189a19f4a3e
--   length      : 2852 bytes
--   captured_at : 2026-09-23 22:33:26.842044+00
--
-- The md5 and length are of pg_get_functiondef(), re-verifiable at any time:
--
--   SELECT md5(pg_get_functiondef(p.oid)), length(pg_get_functiondef(p.oid))
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname = 'find_customer_matches';
--
-- THIS FILE, applied to a scratch Postgres 17.6 (Supabase image) and measured with the same
-- query, gives md5 e7f259b57c2a8d2f161c7189a19f4a3e, length 2852 bytes — equal to live.
-- The body below is the owner's SQL verbatim, not the pg_get_functiondef rendering, so the
-- comparison is on the function the file creates, not on the file's bytes.

CREATE OR REPLACE FUNCTION public.find_customer_matches(
  p_full_name           text DEFAULT NULL,
  p_facebook_name       text DEFAULT NULL,
  p_mobile              text DEFAULT NULL,
  p_email               text DEFAULT NULL,
  p_exclude_customer_id uuid DEFAULT NULL
)
RETURNS TABLE(customer_id uuid, customer_code text, full_name text, facebook_name text,
              mobile_number text, email text, location text, has_login boolean, matched_on text[])
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE
  v_name   text := nullif(lower(regexp_replace(btrim(coalesce(p_full_name, '')), '\s+', ' ', 'g')), '');
  v_fb     text := nullif(lower(regexp_replace(btrim(coalesce(p_facebook_name, '')), '\s+', ' ', 'g')), '');
  v_digits text := regexp_replace(coalesce(p_mobile, ''), '\D', '', 'g');
  v_mobile text := CASE WHEN length(v_digits) >= 10 THEN right(v_digits, 10) END;
  v_email  text := nullif(lower(btrim(coalesce(p_email, ''))), '');
BEGIN
  -- Staff only. Customers hold authenticated sessions too, so the role check
  -- lives inside the function (same idiom as loyalty_integrity_report).
  IF auth.uid() IS NOT NULL AND NOT (
       public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'finance')
    OR public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'csr')) THEN
    RAISE EXCEPTION 'staff role required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT x.id, x.customer_code, x.full_name, x.facebook_name, x.mobile_number,
         x.email, x.location, x.auth_user_id IS NOT NULL, x.hits
    FROM (
      SELECT c.id, c.customer_code, c.full_name, c.facebook_name, c.mobile_number,
             c.email, c.location, c.auth_user_id, c.created_at,
             array_remove(ARRAY[
               CASE WHEN v_name IS NOT NULL
                     AND lower(regexp_replace(btrim(coalesce(c.full_name, '')), '\s+', ' ', 'g')) = v_name
                    THEN 'full_name' END,
               CASE WHEN v_fb IS NOT NULL
                     AND lower(regexp_replace(btrim(coalesce(c.facebook_name, '')), '\s+', ' ', 'g')) = v_fb
                    THEN 'facebook_name' END,
               CASE WHEN v_mobile IS NOT NULL
                     AND length(regexp_replace(coalesce(c.mobile_number, ''), '\D', '', 'g')) >= 10
                     AND right(regexp_replace(c.mobile_number, '\D', '', 'g'), 10) = v_mobile
                    THEN 'mobile' END,
               CASE WHEN v_email IS NOT NULL
                     AND lower(btrim(coalesce(c.email, ''))) = v_email
                    THEN 'email' END
             ], NULL) AS hits
        FROM public.customers c
       WHERE NOT c.is_test
         AND (p_exclude_customer_id IS NULL OR c.id <> p_exclude_customer_id)
    ) x
   WHERE cardinality(x.hits) > 0
   ORDER BY x.created_at;
END $function$;

REVOKE ALL ON FUNCTION public.find_customer_matches(text, text, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.find_customer_matches(text, text, text, text, uuid) TO authenticated, service_role;

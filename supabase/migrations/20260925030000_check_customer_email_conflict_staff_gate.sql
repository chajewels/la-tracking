-- Applied live via the SQL Editor 2026-09-25 by the owner; verified 588 NULL / 26 orphan_auth.
--
-- Record-only: this is the body live already runs. Replaying it is a no-op.
-- The gate was admin/finance only, so every staff and CSR open of the customer
-- page's portal share menu failed, and the failure was only console.warn'd --
-- no conflict warning ever reached the screen. The repo baseline shows EXECUTE
-- revoked from `authenticated`; live has always had authenticated=X, and the
-- grants below re-assert what live carries.

DO $guard$
BEGIN
  IF to_regprocedure('public.check_customer_email_conflict(uuid)') IS NULL THEN
    RAISE EXCEPTION 'STOP — check_customer_email_conflict(uuid) not on live, nothing changed';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.check_customer_email_conflict(p_customer_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_email text;
  v_auth  uuid;
BEGIN
  -- Staff only (same idiom as find_customer_matches). NULL uid = SQL Editor / service role.
  IF auth.uid() IS NOT NULL AND NOT (
       public.has_role(auth.uid(), 'admin'::app_role) OR public.has_role(auth.uid(), 'finance'::app_role)
    OR public.has_role(auth.uid(), 'staff'::app_role) OR public.has_role(auth.uid(), 'csr'::app_role)) THEN
    RAISE EXCEPTION 'staff role required' USING ERRCODE = '42501';
  END IF;

  SELECT nullif(lower(btrim(email)), ''), auth_user_id
    INTO v_email, v_auth
    FROM customers WHERE id = p_customer_id;

  IF v_email IS NULL THEN
    RETURN NULL;
  END IF;

  -- 1. Email held by a staff login
  IF EXISTS (
    SELECT 1 FROM auth.users u JOIN user_roles r ON r.user_id = u.id
     WHERE lower(u.email) = v_email
       AND (v_auth IS NULL OR u.id <> v_auth)
       AND r.role::text <> 'customer') THEN
    RETURN 'staff_conflict';
  END IF;

  -- 2. Email held by a login already linked to a DIFFERENT customer record
  IF EXISTS (
    SELECT 1 FROM auth.users u JOIN customers c2 ON c2.auth_user_id = u.id
     WHERE lower(u.email) = v_email
       AND (v_auth IS NULL OR u.id <> v_auth)
       AND c2.id <> p_customer_id) THEN
    RETURN 'customer_conflict';
  END IF;

  -- 3. Email held by a login with no role and no customer link
  IF EXISTS (
    SELECT 1 FROM auth.users u
     WHERE lower(u.email) = v_email
       AND (v_auth IS NULL OR u.id <> v_auth)
       AND NOT EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id)
       AND NOT EXISTS (SELECT 1 FROM customers c3 WHERE c3.auth_user_id = u.id)) THEN
    RETURN 'orphan_auth';
  END IF;

  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.check_customer_email_conflict(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_customer_email_conflict(uuid) TO authenticated, service_role;

DO $proof$
DECLARE
  v_oid oid := 'public.check_customer_email_conflict(uuid)'::regprocedure;
  v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_oid;
  IF has_function_privilege('anon', v_oid, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_oid, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE')
     OR position('''csr''::app_role' in v_src) = 0
     OR position('ILIKE' in v_src) > 0
     OR position('customer_conflict' in v_src) = 0 THEN
    RAISE EXCEPTION 'STOP — proof failed: grants or body not as expected';
  END IF;
END
$proof$;

-- Phase B Bulk Rollout: get_bulk_setup_invite_candidates RPC
--
-- SECURITY DEFINER admin-only RPC that returns the next batch of customers
-- eligible to receive a portal-setup-invite email, with all exclusions
-- baked in. Used by supabase/functions/bulk-send-setup-invites edge function.
--
-- Eligibility (all must be true):
--   - email IS NOT NULL
--   - auth_user_id IS NULL (not yet migrated)
--   - setup_link_sent_at IS NULL (no prior invite sent)
--   - email NOT IN auth.users (staff-collision exclusion, case-insensitive)
--   - email NOT shared by 2+ unmigrated customers (Cabalza-pattern exclusion)
--   - (optional) customer_code = ANY(p_test_codes) for targeted dry runs
--
-- Admin guard: relies on auth.uid() + public.has_role. Service-role callers
-- (edge function context, where auth.uid() is null) are allowed through —
-- the edge function does its own JWT + admin check before calling.
-- Direct PostgREST calls without admin role are blocked.
--
-- Modes:
--   p_count_only=false → returns up to p_limit rows ordered by customer_code,
--                        every row carries total_eligible (count BEFORE batch).
--   p_count_only=true  → returns one row with NULL identity columns and the
--                        current total_eligible.

CREATE OR REPLACE FUNCTION public.get_bulk_setup_invite_candidates(
  p_test_codes text[] DEFAULT NULL,
  p_limit int DEFAULT 50,
  p_count_only boolean DEFAULT false
)
RETURNS TABLE (
  id uuid,
  customer_code text,
  full_name text,
  email text,
  total_eligible bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total bigint;
BEGIN
  -- Admin guard: allow service_role (auth.uid() IS NULL inside edge function)
  -- AND allow authenticated admins. Block authenticated non-admin direct calls.
  IF auth.uid() IS NOT NULL AND NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'admin only: get_bulk_setup_invite_candidates is restricted';
  END IF;

  -- Count eligible candidates first (used both for count_only and as the
  -- total_eligible on every batch row).
  WITH staff_emails AS (
    SELECT LOWER(email) AS email FROM auth.users WHERE email IS NOT NULL
  ),
  shared_emails AS (
    SELECT LOWER(c.email) AS email
    FROM public.customers c
    WHERE c.email IS NOT NULL AND c.auth_user_id IS NULL
    GROUP BY LOWER(c.email)
    HAVING COUNT(*) > 1
  )
  SELECT COUNT(*)::bigint INTO v_total
  FROM public.customers c
  WHERE c.email IS NOT NULL
    AND c.auth_user_id IS NULL
    AND c.setup_link_sent_at IS NULL
    AND LOWER(c.email) NOT IN (SELECT email FROM staff_emails)
    AND LOWER(c.email) NOT IN (SELECT email FROM shared_emails)
    AND (p_test_codes IS NULL OR c.customer_code = ANY(p_test_codes));

  IF p_count_only THEN
    RETURN QUERY
    SELECT
      NULL::uuid AS id,
      NULL::text AS customer_code,
      NULL::text AS full_name,
      NULL::text AS email,
      v_total AS total_eligible;
    RETURN;
  END IF;

  RETURN QUERY
  WITH staff_emails AS (
    SELECT LOWER(email) AS email FROM auth.users WHERE email IS NOT NULL
  ),
  shared_emails AS (
    SELECT LOWER(c.email) AS email
    FROM public.customers c
    WHERE c.email IS NOT NULL AND c.auth_user_id IS NULL
    GROUP BY LOWER(c.email)
    HAVING COUNT(*) > 1
  ),
  eligible AS (
    SELECT c.id, c.customer_code, c.full_name, c.email
    FROM public.customers c
    WHERE c.email IS NOT NULL
      AND c.auth_user_id IS NULL
      AND c.setup_link_sent_at IS NULL
      AND LOWER(c.email) NOT IN (SELECT email FROM staff_emails)
      AND LOWER(c.email) NOT IN (SELECT email FROM shared_emails)
      AND (p_test_codes IS NULL OR c.customer_code = ANY(p_test_codes))
  )
  SELECT
    e.id,
    e.customer_code,
    e.full_name,
    e.email,
    v_total AS total_eligible
  FROM eligible e
  ORDER BY e.customer_code ASC
  LIMIT p_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.get_bulk_setup_invite_candidates(text[], int, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_bulk_setup_invite_candidates(text[], int, boolean) TO authenticated;

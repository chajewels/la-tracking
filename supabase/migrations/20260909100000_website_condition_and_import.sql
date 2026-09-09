-- Website catalog: product condition + spreadsheet import batches.
--
-- 1. website_products.condition — 'New' | 'Preloved'. Drives the Preloved tag
--    on the public site. Defaults to 'New' so every existing row is valid.
-- 2. website_import_batches — one row per spreadsheet upload, for traceability.
--
-- Apply in the Supabase SQL Editor, then regenerate src/integrations/supabase/types.ts.

-- ------------------------------------------------------------- condition
ALTER TABLE public.website_products
  ADD COLUMN IF NOT EXISTS condition text NOT NULL DEFAULT 'New';

DO $$ BEGIN
  ALTER TABLE public.website_products
    ADD CONSTRAINT website_products_condition_check
    CHECK (condition IN ('New','Preloved'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN public.website_products.condition IS
  'New | Preloved. Preloved shows a Preloved tag on chajewelsjp.com. Set from the Hub product form or the spreadsheet importer (hub_condition).';

-- --------------------------------------------------- website_import_batches
CREATE TABLE IF NOT EXISTS public.website_import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name text,
  uploaded_by uuid,
  row_count int,
  created int,
  updated int,
  skipped int,
  errors jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.website_import_batches IS
  'One row per Website Catalog spreadsheet upload. Written by the Hub importer after a run completes.';

GRANT SELECT, INSERT ON public.website_import_batches TO authenticated;
GRANT ALL ON public.website_import_batches TO service_role;
ALTER TABLE public.website_import_batches ENABLE ROW LEVEL SECURITY;

-- SQL mirror of the documented PERMISSION RESOLUTION ORDER (CLAUDE.md):
--   1. user_permission_overrides for this user  -> use granted
--   2. role_permissions for the user's role     -> fallback
--   3. admin role                               -> always true
-- Until now that order existed only in TypeScript (_shared/check-permission.ts,
-- PermissionsContext). RLS needs it in SQL, so it lives here once rather than
-- being re-inlined per policy. SECURITY DEFINER + pinned search_path, matching
-- the existing is_staff() / has_role() helpers.
CREATE OR REPLACE FUNCTION public.has_permission(_user_id uuid, _permission_key text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN _user_id IS NULL THEN false
    WHEN public.has_role(_user_id, 'admin'::public.app_role) THEN true
    ELSE COALESCE(
      (SELECT o.granted
         FROM public.user_permission_overrides o
        WHERE o.user_id = _user_id
          AND o.permission_key = _permission_key
        LIMIT 1),
      (SELECT bool_or(rp.is_allowed)
         FROM public.role_permissions rp
         JOIN public.user_roles ur ON ur.role = rp.role
        WHERE ur.user_id = _user_id
          AND rp.permission_key = _permission_key),
      false)
  END
$$;
REVOKE EXECUTE ON FUNCTION public.has_permission(uuid, text) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_permission(uuid, text) TO authenticated, service_role;

DROP POLICY IF EXISTS "Catalog managers can view import batches" ON public.website_import_batches;
CREATE POLICY "Catalog managers can view import batches"
  ON public.website_import_batches FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'manage_website_catalog'));

DROP POLICY IF EXISTS "Catalog managers can record import batches" ON public.website_import_batches;
CREATE POLICY "Catalog managers can record import batches"
  ON public.website_import_batches FOR INSERT TO authenticated
  WITH CHECK (public.has_permission(auth.uid(), 'manage_website_catalog'));

CREATE INDEX IF NOT EXISTS idx_website_import_batches_created
  ON public.website_import_batches (created_at DESC);
